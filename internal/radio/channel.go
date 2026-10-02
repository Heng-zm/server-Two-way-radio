package radio

import (
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"twowayradio/internal/config"
)

// Channel represents a virtual radio channel with half-duplex floor control.
type Channel struct {
	mu          sync.RWMutex
	Definition  config.ChannelDef
	Subscribers map[*Client]bool

	// Floor control state
	activeSpeaker *Client
	isBusy        bool
	totDuration   time.Duration
	totTimer      *time.Timer
	onTOTExpire   func(ch *Channel, speaker *Client)
}

// NewChannel creates a new Channel instance.
func NewChannel(def config.ChannelDef, tot time.Duration, onTOT func(ch *Channel, speaker *Client)) *Channel {
	return &Channel{
		Definition:  def,
		Subscribers: make(map[*Client]bool),
		totDuration: tot,
		onTOTExpire: onTOT,
	}
}

// AddSubscriber adds a client to this channel.
func (c *Channel) AddSubscriber(client *Client) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Subscribers[client] = true
}

// RemoveSubscriber removes a client from this channel.
// If the client was the active speaker, floor is released.
func (c *Channel) RemoveSubscriber(client *Client) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.Subscribers, client)

	if c.activeSpeaker == client {
		c.cancelTOT()
		c.activeSpeaker = nil
		c.isBusy = false
		return true // floor was released due to disconnect
	}
	return false
}

// SubscriberCount returns current number of listening clients.
func (c *Channel) SubscriberCount() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.Subscribers)
}

// getPriority returns numeric rank for floor arbitration (higher rank preempts lower rank).
func getPriority(client *Client) int {
	if client == nil {
		return 0
	}
	role := strings.ToLower(strings.TrimSpace(client.Role))
	switch role {
	case "commander", "chief", "admin":
		return 3
	case "dispatcher", "supervisor", "operator":
		return 2
	default:
		return 1
	}
}

// RequestFloor attempts to acquire the floor for client.
// Returns:
// - granted: true if floor is granted
// - reason: "channel_busy" or ""
// - speaker: callsign of speaker
// - preempted: previous active speaker if preempted by higher priority role, else nil
func (c *Channel) RequestFloor(client *Client) (bool, string, string, *Client) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.isBusy && c.activeSpeaker != nil {
		if c.activeSpeaker == client {
			return true, "", "", nil // already holding floor
		}

		// Priority preemption: Dispatcher/Commander interrupts lower priority speaker
		if getPriority(client) > getPriority(c.activeSpeaker) {
			preempted := c.activeSpeaker
			c.cancelTOT()
			c.activeSpeaker = client
			if c.totDuration > 0 {
				c.totTimer = time.AfterFunc(c.totDuration, func() {
					c.handleTOT()
				})
			}
			return true, "preempted", preempted.Callsign, preempted
		}

		return false, "channel_busy", c.activeSpeaker.Callsign, nil
	}

	// Grant floor
	c.isBusy = true
	c.activeSpeaker = client

	// Start TOT (Time-Out Timer)
	c.cancelTOT()
	if c.totDuration > 0 {
		c.totTimer = time.AfterFunc(c.totDuration, func() {
			c.handleTOT()
		})
	}

	return true, "", "", nil
}

// ReleaseFloor releases the floor if held by the given client.
// Returns true if the floor was released, false if client wasn't speaker.
func (c *Channel) ReleaseFloor(client *Client) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.activeSpeaker == client {
		c.cancelTOT()
		c.activeSpeaker = nil
		c.isBusy = false
		return true
	}
	return false
}

// ForceReleaseFloor forcibly clears the floor (e.g. by operator or TOT).
func (c *Channel) ForceReleaseFloor() *Client {
	c.mu.Lock()
	defer c.mu.Unlock()

	prev := c.activeSpeaker
	c.cancelTOT()
	c.activeSpeaker = nil
	c.isBusy = false
	return prev
}

// IsFloorHolder returns true if the specified client currently holds the floor.
func (c *Channel) IsFloorHolder(client *Client) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.isBusy && c.activeSpeaker == client
}

// GetState returns snapshot of the channel's status.
func (c *Channel) GetState() (bool, string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.isBusy && c.activeSpeaker != nil {
		return true, c.activeSpeaker.Callsign
	}
	return false, ""
}

// ChannelUserInfo provides rich presence data including location for a tuned client.
type ChannelUserInfo struct {
	ID       string           `json:"user_id"`
	Callsign string           `json:"callsign"`
	Role     string           `json:"role,omitempty"`
	Location *LocationPayload `json:"location,omitempty"`
}

// GetUserCallsigns returns a list of calls of all tuned clients.
func (c *Channel) GetUserCallsigns() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	users := make([]string, 0, len(c.Subscribers))
	for sub := range c.Subscribers {
		users = append(users, sub.Callsign)
	}
	return users
}

// GetSubscribersInfo returns detailed information for tuned clients.
func (c *Channel) GetSubscribersInfo() []ChannelUserInfo {
	c.mu.RLock()
	defer c.mu.RUnlock()
	users := make([]ChannelUserInfo, 0, len(c.Subscribers))
	for sub := range c.Subscribers {
		users = append(users, ChannelUserInfo{
			ID:       sub.ID,
			Callsign: sub.Callsign,
			Role:     sub.Role,
			Location: sub.Location,
		})
	}
	return users
}

// BroadcastSignal sends a signal envelope to all subscribers.
// Encodes JSON once and dispatches pre-marshaled bytes to minimize CPU usage.
func (c *Channel) BroadcastSignal(msg interface{}) {
	var data []byte
	var err error
	if b, ok := msg.([]byte); ok {
		data = b
	} else {
		data, err = json.Marshal(msg)
		if err != nil {
			return
		}
	}

	c.mu.RLock()
	defer c.mu.RUnlock()

	for client := range c.Subscribers {
		client.SendRawJSON(data)
	}
}

// BroadcastAudio distributes binary audio to all subscribers except sender.
// Zero-allocation direct dispatch without heap slices.
func (c *Channel) BroadcastAudio(sender *Client, audioData []byte) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	for client := range c.Subscribers {
		if client != sender {
			client.SendBinary(audioData)
		}
	}
}

func (c *Channel) cancelTOT() {
	if c.totTimer != nil {
		c.totTimer.Stop()
		c.totTimer = nil
	}
}

func (c *Channel) handleTOT() {
	c.mu.Lock()
	speaker := c.activeSpeaker
	c.activeSpeaker = nil
	c.isBusy = false
	c.totTimer = nil
	c.mu.Unlock()

	if speaker != nil {
		log.Printf("[TOT] Time-Out-Timer expired on Channel %d (%s) for %s", c.Definition.ID, c.Definition.Name, speaker.Callsign)
		if c.onTOTExpire != nil {
			c.onTOTExpire(c, speaker)
		}
	}
}
