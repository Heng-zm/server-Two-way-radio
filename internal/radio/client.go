package radio

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxMessageSize = 16 * 1024 * 1024 // 16 MB (allows base64 image and file attachments)
	sendBufferSize = 64              // Audio queue depth (bounded to prevent lag accumulation)
	highPriSize    = 64              // Priority channel for control signals and pongs
)

// Client represents a connected radio user over WebSocket.
type Client struct {
	ID               string
	Callsign         string
	Role             string
	CurrentChannelID int
	Location         *LocationPayload

	hub      *Hub
	conn     *websocket.Conn
	highPri  chan []byte // high priority signaling & pongs (zero buffer delay)
	send     chan []byte // outgoing messages & audio packets
	
	mu       sync.Mutex
	isClosed bool
}

// NewClient creates and initializes a Client.
func NewClient(id, callsign string, hub *Hub, conn *websocket.Conn) *Client {
	return &Client{
		ID:               id,
		Callsign:         callsign,
		Role:             "Operator",
		CurrentChannelID: 1, // Default to Channel 1
		hub:              hub,
		conn:             conn,
		highPri:          make(chan []byte, highPriSize),
		send:             make(chan []byte, sendBufferSize),
	}
}

// SendPriorityJSON enqueues high-priority control signals (pong, floor_status, alert).
func (c *Client) SendPriorityJSON(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("[Client %s] JSON marshal error: %v", c.Callsign, err)
		return
	}
	c.enqueuePriority(data)
}

func (c *Client) enqueuePriority(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.isClosed {
		return
	}

	select {
	case c.highPri <- data:
	default:
		// Queue full, evict oldest
		select {
		case <-c.highPri:
		default:
		}
		select {
		case c.highPri <- data:
		default:
		}
	}
}

// SendJSON enqueues a JSON object to be sent. Non-blocking.
func (c *Client) SendJSON(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("[Client %s] JSON marshal error: %v", c.Callsign, err)
		return
	}
	c.enqueue(data)
}

// SendBinary enqueues a binary audio slice to be sent. Non-blocking.
func (c *Client) SendBinary(data []byte) {
	c.enqueue(data)
}

func (c *Client) enqueue(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.isClosed {
		return
	}

	select {
	case c.send <- data:
	default:
		// Evict oldest stale packet to guarantee real-time live sync
		select {
		case <-c.send:
		default:
		}
		select {
		case c.send <- data:
		default:
		}
	}
}

// Close terminates client connection and cleans up.
func (c *Client) Close() {
	c.mu.Lock()
	if c.isClosed {
		c.mu.Unlock()
		return
	}
	c.isClosed = true
	close(c.highPri)
	close(c.send)
	c.mu.Unlock()

	c.conn.Close()
}

// ReadPump handles incoming WebSocket frames from the client.
func (c *Client) ReadPump() {
	defer func() {
		c.hub.UnregisterClient(c)
		c.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(c.hub.config.PongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(c.hub.config.PongWait))
		return nil
	})

	for {
		messageType, payload, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure, websocket.CloseNoStatusReceived, websocket.CloseAbnormalClosure) {
				log.Printf("[Client %s] Read error: %v", c.Callsign, err)
			}
			break
		}

		switch messageType {
		case websocket.TextMessage:
			var sig SignalMessage
			if err := json.Unmarshal(payload, &sig); err != nil {
				log.Printf("[Client %s] Invalid JSON: %v", c.Callsign, err)
				continue
			}
			c.hub.HandleSignal(c, &sig)

		case websocket.BinaryMessage:
			c.hub.HandleBinaryAudio(c, payload)
		}
	}
}

// WritePump handles outgoing WebSocket frames to the client with strict priority for signaling.
func (c *Client) WritePump() {
	ticker := time.NewTicker(c.hub.config.PingInterval)
	defer func() {
		ticker.Stop()
		c.Close()
	}()

	for {
		// Priority 1: Check high-priority signaling (pongs, floor grants) without blocking
		select {
		case message, ok := <-c.highPri:
			if !ok {
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(c.hub.config.WriteWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
			continue
		default:
		}

		// Priority 2: Wait on any channel (highPri takes priority over send & ticker)
		select {
		case message, ok := <-c.highPri:
			if !ok {
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(c.hub.config.WriteWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case message, ok := <-c.send:
			if !ok {
				// Hub closed the channel
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(c.hub.config.WriteWait))

			// Check if message is binary (starts with AudioMagic0, AudioMagic1) or text JSON
			msgType := websocket.TextMessage
			if len(message) >= AudioHeaderSize && message[0] == AudioMagic0 && message[1] == AudioMagic1 {
				msgType = websocket.BinaryMessage
			}

			if err := c.conn.WriteMessage(msgType, message); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(c.hub.config.WriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
