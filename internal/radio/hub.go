package radio

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"twowayradio/internal/config"
)

// RoIPRelayFunc is a callback for relaying audio packets to external RoIP UDP gateways.
type RoIPRelayFunc func(channelID int, data []byte)

// Hub manages all radio channels, connected clients, floor arbitration, and audio dispatching.
type Hub struct {
	mu                   sync.RWMutex
	config               *config.Config
	channels             map[int]*Channel
	clients              map[*Client]bool
	clientsByID          map[string]*Client
	chatHistory          map[int][]ChatMessagePayload
	activeVideoByChannel map[int]*VideoSignalingPayload
	startTime            time.Time
	roipRelay            RoIPRelayFunc
	recorder             *AudioRecorder
	totalAudioBytes      uint64
	totalTransmissions   uint64
	totalPreemptions     uint64
}

// NewHub initializes a new radio hub with configured channels.
func NewHub(cfg *config.Config) *Hub {
	h := &Hub{
		config:               cfg,
		channels:             make(map[int]*Channel),
		clients:              make(map[*Client]bool),
		clientsByID:          make(map[string]*Client),
		chatHistory:          make(map[int][]ChatMessagePayload),
		activeVideoByChannel: make(map[int]*VideoSignalingPayload),
		startTime:            time.Now(),
		recorder:             NewAudioRecorder("./data/recordings"),
	}

	for _, chDef := range cfg.DefaultChannels {
		def := chDef
		h.channels[def.ID] = NewChannel(def, cfg.TOTDuration, h.handleTOTExpired)
	}

	return h
}

// RegisterClient adds a new client and places them in Channel 1.
func (h *Hub) RegisterClient(client *Client) {
	h.mu.Lock()
	h.clients[client] = true
	h.clientsByID[client.ID] = client
	ch, exists := h.channels[client.CurrentChannelID]
	if !exists {
		// Fallback to first available channel
		for _, first := range h.channels {
			ch = first
			client.CurrentChannelID = first.Definition.ID
			break
		}
	}
	h.mu.Unlock()

	if ch != nil {
		ch.AddSubscriber(client)
		h.broadcastUserList(ch)
	}

	log.Printf("[Hub] Registered client %s (%s) on Channel %d", client.Callsign, client.ID, client.CurrentChannelID)

	// Send client welcome info with assigned client ID and callsign
	client.SendJSON(SignalMessage{
		Type: "client_welcome",
		Payload: map[string]interface{}{
			"id":         client.ID,
			"callsign":   client.Callsign,
			"channel_id": client.CurrentChannelID,
		},
		Timestamp: time.Now().UnixMilli(),
	})

	// Send initial channel list and state
	client.SendJSON(SignalMessage{
		Type:      MsgTypeChannelList,
		Payload:   h.GetChannelList(),
		Timestamp: time.Now().UnixMilli(),
	})

	// Send initial chat history for the channel
	h.mu.RLock()
	hist := h.chatHistory[client.CurrentChannelID]
	activeVideo := h.activeVideoByChannel[client.CurrentChannelID]
	h.mu.RUnlock()
	if len(hist) > 0 {
		client.SendJSON(SignalMessage{
			Type: MsgTypeChatHistory,
			Payload: ChatHistoryPayload{
				ChannelID: client.CurrentChannelID,
				Messages:  hist,
			},
			Timestamp: time.Now().UnixMilli(),
		})
	}
	if activeVideo != nil {
		client.SendJSON(SignalMessage{
			Type:      MsgTypeVideoCallStart,
			Payload:   activeVideo,
			Timestamp: time.Now().UnixMilli(),
		})
	}
}

// UnregisterClient removes a client and cleans up their state.
func (h *Hub) UnregisterClient(client *Client) {
	h.mu.Lock()
	delete(h.clients, client)
	delete(h.clientsByID, client.ID)
	ch, exists := h.channels[client.CurrentChannelID]
	h.mu.Unlock()

	if exists && ch != nil {
		floorReleased := ch.RemoveSubscriber(client)
		h.broadcastUserList(ch)

		// Broadcast video call end if client disconnected
		h.mu.RLock()
		activeVideo := h.activeVideoByChannel[ch.Definition.ID]
		h.mu.RUnlock()
		if activeVideo != nil && activeVideo.SenderID == client.ID {
			h.mu.Lock()
			delete(h.activeVideoByChannel, ch.Definition.ID)
			h.mu.Unlock()
			ch.BroadcastSignal(SignalMessage{
				Type: MsgTypeVideoCallEnd,
				Payload: VideoSignalingPayload{
					ChannelID: ch.Definition.ID,
					SenderID:  client.ID,
					Callsign:  client.Callsign,
				},
				Timestamp: time.Now().UnixMilli(),
			})
		}

		if floorReleased {
			log.Printf("[Hub] Floor released on Channel %d because %s disconnected", ch.Definition.ID, client.Callsign)
			ch.BroadcastSignal(SignalMessage{
				Type: MsgTypeFloorStatus,
				Payload: FloorStatusPayload{
					ChannelID: ch.Definition.ID,
					Status:    FloorStatusIdle,
				},
				Timestamp: time.Now().UnixMilli(),
			})
			ch.BroadcastSignal(SignalMessage{
				Type: MsgTypeUserStopped,
				Payload: TransmissionEventPayload{
					ChannelID: ch.Definition.ID,
					UserID:    client.ID,
					Callsign:  client.Callsign,
				},
				Timestamp: time.Now().UnixMilli(),
			})
			h.BroadcastAll(SignalMessage{
				Type: MsgTypeChannelActivity,
				Payload: map[string]interface{}{
					"channel_id": ch.Definition.ID,
					"is_busy":    false,
				},
				Timestamp: time.Now().UnixMilli(),
			})
		}
	}

	log.Printf("[Hub] Unregistered client %s (%s)", client.Callsign, client.ID)
}

// HandleSignal processes client signaling messages.
func (h *Hub) HandleSignal(client *Client, msg *SignalMessage) {
	switch msg.Type {
	case MsgTypeIdentify:
		var p IdentifyPayload
		data, _ := json.Marshal(msg.Payload)
		if err := json.Unmarshal(data, &p); err == nil && p.Callsign != "" {
			old := client.Callsign
			client.Callsign = p.Callsign
			if p.Role != "" {
				client.Role = p.Role
			}
			log.Printf("[Hub] Client %s changed callsign to %s", old, client.Callsign)

			h.mu.RLock()
			ch := h.channels[client.CurrentChannelID]
			h.mu.RUnlock()
			if ch != nil {
				h.broadcastUserList(ch)
			}
		}

	case MsgTypeJoinChannel:
		var p JoinChannelPayload
		data, _ := json.Marshal(msg.Payload)
		if err := json.Unmarshal(data, &p); err == nil {
			h.SwitchChannel(client, p.ChannelID, p.Password)
		}

	case MsgTypeCreateChannel:
		var p CreateChannelPayload
		data, _ := json.Marshal(msg.Payload)
		if err := json.Unmarshal(data, &p); err == nil && p.Name != "" {
			h.mu.Lock()
			newID := len(h.channels) + 1
			for h.channels[newID] != nil {
				newID++
			}
			newChDef := config.ChannelDef{
				ID:        newID,
				Name:      p.Name,
				Frequency: 446.0 + float64(newID)*0.0125,
				CTCSS:     100.0,
				Color:     "#ffffff",
				IsPrivate: p.IsPrivate,
				Password:  p.Password,
			}
			h.channels[newID] = NewChannel(newChDef, h.config.TOTDuration, h.handleTOTExpired)
			h.mu.Unlock()

			// Broadcast updated channel list to everyone
			h.BroadcastAll(SignalMessage{
				Type:      MsgTypeChannelList,
				Payload:   h.GetChannelList(),
				Timestamp: time.Now().UnixMilli(),
			})

			// Automatically move creator to new channel
			h.SwitchChannel(client, newID, p.Password)
		}

	case MsgTypePTTDown:
		h.handlePTTDown(client)

	case MsgTypePTTUp:
		h.handlePTTUp(client)

	case MsgTypeAlertTone:
		var p AlertTonePayload
		data, _ := json.Marshal(msg.Payload)
		_ = json.Unmarshal(data, &p)
		h.handleAlertTone(client, p.ToneType)

	case MsgTypeAllCall:
		var p AllCallPayload
		data, _ := json.Marshal(msg.Payload)
		if err := json.Unmarshal(data, &p); err == nil {
			p.SenderID = client.ID
			p.Callsign = client.Callsign
			p.Role = client.Role
			p.Timestamp = time.Now().UnixMilli()
			log.Printf("[Hub] ALL-CALL announcement from %s (%s): %s", client.Callsign, client.Role, p.Text)
			h.BroadcastAll(SignalMessage{
				Type:      MsgTypeAllCall,
				Payload:   p,
				Timestamp: p.Timestamp,
			})
		}

	case MsgTypeLocation:
		var p LocationPayload
		data, _ := json.Marshal(msg.Payload)
		if err := json.Unmarshal(data, &p); err == nil {
			p.UserID = client.ID
			p.Callsign = client.Callsign
			client.Location = &p
			log.Printf("[Hub] GPS Location update from %s: Lat %.4f, Lon %.4f (%s)", client.Callsign, p.Latitude, p.Longitude, p.City)
			h.mu.RLock()
			ch := h.channels[client.CurrentChannelID]
			h.mu.RUnlock()
			if ch != nil {
				ch.BroadcastSignal(SignalMessage{
					Type:      MsgTypeLocation,
					Payload:   p,
					Timestamp: time.Now().UnixMilli(),
				})
			}
		}

	case MsgTypePing:
		client.SendPriorityJSON(SignalMessage{
			Type:      MsgTypePong,
			Payload:   msg.Payload,
			Timestamp: time.Now().UnixMilli(),
		})

	case MsgTypeChatMessage:
		var p ChatMessagePayload
		data, _ := json.Marshal(msg.Payload)
		if err := json.Unmarshal(data, &p); err == nil {
			text := strings.TrimSpace(p.Text)
			if len(text) > 500 {
				text = text[:500]
			}
			if text != "" || p.FileUrl != "" {
				p.ID = fmt.Sprintf("msg-%d-%d", time.Now().UnixMilli(), rand.Intn(10000))
				p.ChannelID = client.CurrentChannelID
				p.SenderID = client.ID
				p.Callsign = client.Callsign
				p.Text = text
				p.Timestamp = time.Now().UnixMilli()

				h.mu.Lock()
				ch := h.channels[client.CurrentChannelID]
				hist := h.chatHistory[client.CurrentChannelID]
				hist = append(hist, p)
				if len(hist) > 30 {
					hist = hist[len(hist)-30:]
				}
				h.chatHistory[client.CurrentChannelID] = hist
				h.mu.Unlock()

				log.Printf("[Hub] Chat on CH %d from %s: %s (file: %v)", client.CurrentChannelID, client.Callsign, text, p.FileName)

				if ch != nil {
					ch.BroadcastSignal(SignalMessage{
						Type:      MsgTypeChatMessage,
						Payload:   p,
						Timestamp: p.Timestamp,
					})
				}
			}
		}

	case MsgTypeVideoCallStart:
		var p VideoSignalingPayload
		data, _ := json.Marshal(msg.Payload)
		_ = json.Unmarshal(data, &p)
		p.SenderID = client.ID
		p.Callsign = client.Callsign
		p.ChannelID = client.CurrentChannelID

		h.mu.Lock()
		h.activeVideoByChannel[client.CurrentChannelID] = &p
		ch := h.channels[client.CurrentChannelID]
		h.mu.Unlock()
		if ch != nil {
			log.Printf("[Hub] Video call started on CH %d by %s (isScreen: %v)", ch.Definition.ID, client.Callsign, p.IsScreen)
			ch.BroadcastSignal(SignalMessage{
				Type:      MsgTypeVideoCallStart,
				Payload:   p,
				Timestamp: time.Now().UnixMilli(),
			})
		}

	case MsgTypeVideoCallEnd:
		h.mu.Lock()
		activeVideo := h.activeVideoByChannel[client.CurrentChannelID]
		if activeVideo != nil && activeVideo.SenderID == client.ID {
			delete(h.activeVideoByChannel, client.CurrentChannelID)
		}
		ch := h.channels[client.CurrentChannelID]
		h.mu.Unlock()
		
		if ch != nil && activeVideo != nil && activeVideo.SenderID == client.ID {
			log.Printf("[Hub] Video call ended on CH %d by %s", ch.Definition.ID, client.Callsign)
			ch.BroadcastSignal(SignalMessage{
				Type: MsgTypeVideoCallEnd,
				Payload: VideoSignalingPayload{
					ChannelID: ch.Definition.ID,
					SenderID:  client.ID,
					Callsign:  client.Callsign,
				},
				Timestamp: time.Now().UnixMilli(),
			})
		}

	case MsgTypeVideoJoin:
		var p VideoSignalingPayload
		data, _ := json.Marshal(msg.Payload)
		_ = json.Unmarshal(data, &p)
		p.SenderID = client.ID
		p.Callsign = client.Callsign
		p.ChannelID = client.CurrentChannelID

		h.mu.RLock()
		ch := h.channels[client.CurrentChannelID]
		h.mu.RUnlock()
		if ch != nil {
			ch.BroadcastSignal(SignalMessage{
				Type:      MsgTypeVideoJoin,
				Payload:   p,
				Timestamp: time.Now().UnixMilli(),
			})
		}

	case MsgTypeVideoOffer, MsgTypeVideoAnswer, MsgTypeVideoICE:
		var p VideoSignalingPayload
		data, _ := json.Marshal(msg.Payload)
		if err := json.Unmarshal(data, &p); err == nil {
			p.SenderID = client.ID
			p.Callsign = client.Callsign
			p.ChannelID = client.CurrentChannelID

			if p.TargetID != "" {
				h.mu.RLock()
				targetClient := h.clientsByID[p.TargetID]
				h.mu.RUnlock()
				if targetClient != nil {
					targetClient.SendPriorityJSON(SignalMessage{
						Type:      msg.Type,
						Payload:   p,
						Timestamp: time.Now().UnixMilli(),
					})
				}
			} else {
				h.mu.RLock()
				ch := h.channels[client.CurrentChannelID]
				h.mu.RUnlock()
				if ch != nil {
					ch.BroadcastSignal(SignalMessage{
						Type:      msg.Type,
						Payload:   p,
						Timestamp: time.Now().UnixMilli(),
					})
				}
			}
		}
	}
}

// SwitchChannel moves client to a different radio frequency/channel.
func (h *Hub) SwitchChannel(client *Client, newChannelID int, password string) {
	h.mu.RLock()
	targetCh, exists := h.channels[newChannelID]
	oldCh := h.channels[client.CurrentChannelID]
	h.mu.RUnlock()

	if !exists {
		client.SendJSON(SignalMessage{
			Type:      MsgTypeError,
			Payload:   "channel does not exist",
			Timestamp: time.Now().UnixMilli(),
		})
		return
	}

	if client.CurrentChannelID == newChannelID {
		return
	}

	if targetCh.Definition.IsPrivate {
		// Use constant-time comparison to prevent timing attacks on private channel passwords
		if subtle.ConstantTimeCompare([]byte(targetCh.Definition.Password), []byte(password)) != 1 {
			client.SendJSON(SignalMessage{
				Type:      MsgTypeError,
				Payload:   "incorrect password for private channel",
				Timestamp: time.Now().UnixMilli(),
			})
			return
		}
	}

	// If client is currently transmitting on the old channel, release floor
	if oldCh != nil {
		floorReleased := oldCh.RemoveSubscriber(client)
		h.broadcastUserList(oldCh)

		if floorReleased {
			oldCh.BroadcastSignal(SignalMessage{
				Type: MsgTypeFloorStatus,
				Payload: FloorStatusPayload{
					ChannelID: oldCh.Definition.ID,
					Status:    FloorStatusIdle,
				},
				Timestamp: time.Now().UnixMilli(),
			})
			oldCh.BroadcastSignal(SignalMessage{
				Type: MsgTypeUserStopped,
				Payload: TransmissionEventPayload{
					ChannelID: oldCh.Definition.ID,
					UserID:    client.ID,
					Callsign:  client.Callsign,
				},
				Timestamp: time.Now().UnixMilli(),
			})
			h.BroadcastAll(SignalMessage{
				Type: MsgTypeChannelActivity,
				Payload: map[string]interface{}{
					"channel_id": oldCh.Definition.ID,
					"is_busy":    false,
				},
				Timestamp: time.Now().UnixMilli(),
			})
		}
		
		// Also end video if they were broadcasting
		h.mu.RLock()
		activeVideo := h.activeVideoByChannel[oldCh.Definition.ID]
		h.mu.RUnlock()
		if activeVideo != nil && activeVideo.SenderID == client.ID {
			h.mu.Lock()
			delete(h.activeVideoByChannel, oldCh.Definition.ID)
			h.mu.Unlock()
			oldCh.BroadcastSignal(SignalMessage{
				Type: MsgTypeVideoCallEnd,
				Payload: VideoSignalingPayload{
					ChannelID: oldCh.Definition.ID,
					SenderID:  client.ID,
					Callsign:  client.Callsign,
				},
				Timestamp: time.Now().UnixMilli(),
			})
		}
	}

	client.CurrentChannelID = newChannelID
	targetCh.AddSubscriber(client)
	h.broadcastUserList(targetCh)

	log.Printf("[Hub] Client %s switched to Channel %d (%s)", client.Callsign, targetCh.Definition.ID, targetCh.Definition.Name)

	// Send updated channel state to the client
	isBusy, speaker := targetCh.GetState()
	status := FloorStatusIdle
	if isBusy {
		status = "busy"
	}
	client.SendJSON(SignalMessage{
		Type: MsgTypeFloorStatus,
		Payload: FloorStatusPayload{
			ChannelID:      targetCh.Definition.ID,
			Status:         status,
			CurrentSpeaker: speaker,
		},
		Timestamp: time.Now().UnixMilli(),
	})

	// Send channel chat history
	h.mu.RLock()
	hist := h.chatHistory[targetCh.Definition.ID]
	activeVideoTarget := h.activeVideoByChannel[targetCh.Definition.ID]
	h.mu.RUnlock()
	client.SendJSON(SignalMessage{
		Type: MsgTypeChatHistory,
		Payload: ChatHistoryPayload{
			ChannelID: targetCh.Definition.ID,
			Messages:  hist,
		},
		Timestamp: time.Now().UnixMilli(),
	})
	
	if activeVideoTarget != nil {
		client.SendJSON(SignalMessage{
			Type:      MsgTypeVideoCallStart,
			Payload:   activeVideoTarget,
			Timestamp: time.Now().UnixMilli(),
		})
	}
}

func (h *Hub) handlePTTDown(client *Client) {
	h.mu.RLock()
	ch, exists := h.channels[client.CurrentChannelID]
	h.mu.RUnlock()

	if !exists || ch == nil {
		client.SendJSON(SignalMessage{
			Type:      MsgTypeError,
			Payload:   "channel not found",
			Timestamp: time.Now().UnixMilli(),
		})
		return
	}

	granted, reason, speaker, preempted := ch.RequestFloor(client)
	if granted {
		atomic.AddUint64(&h.totalTransmissions, 1)

		// Handle tactical priority preemption (e.g. Commander/Dispatcher interrupts field unit)
		if preempted != nil {
			atomic.AddUint64(&h.totalPreemptions, 1)
			log.Printf("[Hub] Floor PREEMPTED on Channel %d: %s (%s) interrupted %s (%s)",
				ch.Definition.ID, client.Callsign, client.Role, preempted.Callsign, preempted.Role)

			// Finalize recording for the preempted speaker
			if h.recorder != nil {
				if rec := h.recorder.OnTransmissionEnd(ch.Definition.ID); rec != nil {
					ch.BroadcastSignal(SignalMessage{
						Type:      MsgTypeTransmissionRecorded,
						Payload:   rec,
						Timestamp: time.Now().UnixMilli(),
					})
				}
			}

			// Immediately notify preempted speaker with zero-delay priority
			preempted.SendPriorityJSON(SignalMessage{
				Type: MsgTypeFloorStatus,
				Payload: FloorStatusPayload{
					ChannelID:      ch.Definition.ID,
					Status:         FloorStatusDenied,
					Reason:         "preempted_by_dispatcher",
					CurrentSpeaker: client.Callsign,
					SpeakerID:      client.ID,
				},
				Timestamp: time.Now().UnixMilli(),
			})
		}

		log.Printf("[Hub] Floor GRANTED on Channel %d to %s (%s)", ch.Definition.ID, client.Callsign, client.Role)

		// Start server-side audio recording buffer
		if h.recorder != nil {
			h.recorder.OnTransmissionStart(ch.Definition.ID, client)
		}

		// Confirm to speaker immediately with zero-lag priority
		client.SendPriorityJSON(SignalMessage{
			Type: MsgTypeFloorStatus,
			Payload: FloorStatusPayload{
				ChannelID:      ch.Definition.ID,
				Status:         FloorStatusGranted,
				CurrentSpeaker: client.Callsign,
				SpeakerID:      client.ID,
			},
			Timestamp: time.Now().UnixMilli(),
		})

		// Notify channel subscribers that this user keyed up
		ch.BroadcastSignal(SignalMessage{
			Type: MsgTypeUserTalking,
			Payload: TransmissionEventPayload{
				ChannelID: ch.Definition.ID,
				UserID:    client.ID,
				Callsign:  client.Callsign,
			},
			Timestamp: time.Now().UnixMilli(),
		})

		// Broadcast channel busy state to all clients
		h.BroadcastAll(SignalMessage{
			Type: MsgTypeChannelActivity,
			Payload: map[string]interface{}{
				"channel_id": ch.Definition.ID,
				"is_busy":    true,
				"speaker":    client.Callsign,
			},
			Timestamp: time.Now().UnixMilli(),
		})
	} else {
		log.Printf("[Hub] Floor DENIED on Channel %d to %s (Busy with %s)", ch.Definition.ID, client.Callsign, speaker)
		client.SendPriorityJSON(SignalMessage{
			Type: MsgTypeFloorStatus,
			Payload: FloorStatusPayload{
				ChannelID:      ch.Definition.ID,
				Status:         FloorStatusDenied,
				Reason:         reason,
				CurrentSpeaker: speaker,
			},
			Timestamp: time.Now().UnixMilli(),
		})
	}
}

func (h *Hub) handlePTTUp(client *Client) {
	h.mu.RLock()
	ch, exists := h.channels[client.CurrentChannelID]
	h.mu.RUnlock()

	if !exists || ch == nil {
		return
	}

	if ch.ReleaseFloor(client) {
		log.Printf("[Hub] Floor RELEASED on Channel %d by %s", ch.Definition.ID, client.Callsign)

		// Finalize recording and save standard 16kHz WAV file
		if h.recorder != nil {
			if rec := h.recorder.OnTransmissionEnd(ch.Definition.ID); rec != nil {
				log.Printf("[Hub] Saved WAV recording: %s (%.1fs)", rec.FileURL, rec.DurationSeconds)
				ch.BroadcastSignal(SignalMessage{
					Type:      MsgTypeTransmissionRecorded,
					Payload:   rec,
					Timestamp: time.Now().UnixMilli(),
				})

				// Append to channel chat history as voice message
				h.mu.Lock()
				hist := h.chatHistory[ch.Definition.ID]
				hist = append(hist, ChatMessagePayload{
					ID:        rec.ID,
					ChannelID: ch.Definition.ID,
					SenderID:  client.ID,
					Callsign:  client.Callsign,
					Text:      fmt.Sprintf("🎙️ Voice Transmission (%.1fs)", rec.DurationSeconds),
					FileUrl:   rec.FileURL,
					FileName:  filepath.Base(rec.FileURL),
					FileType:  "audio/wav",
					Timestamp: rec.Timestamp,
				})
				if len(hist) > 30 {
					hist = hist[len(hist)-30:]
				}
				h.chatHistory[ch.Definition.ID] = hist
				h.mu.Unlock()
			}
		}

		// Broadcast floor is now idle
		ch.BroadcastSignal(SignalMessage{
			Type: MsgTypeFloorStatus,
			Payload: FloorStatusPayload{
				ChannelID: ch.Definition.ID,
				Status:    FloorStatusIdle,
			},
			Timestamp: time.Now().UnixMilli(),
		})

		// Broadcast user unkeyed
		ch.BroadcastSignal(SignalMessage{
			Type: MsgTypeUserStopped,
			Payload: TransmissionEventPayload{
				ChannelID: ch.Definition.ID,
				UserID:    client.ID,
				Callsign:  client.Callsign,
			},
			Timestamp: time.Now().UnixMilli(),
		})

		// Broadcast channel idle state to all clients
		h.BroadcastAll(SignalMessage{
			Type: MsgTypeChannelActivity,
			Payload: map[string]interface{}{
				"channel_id": ch.Definition.ID,
				"is_busy":    false,
			},
			Timestamp: time.Now().UnixMilli(),
		})
	}
}

func (h *Hub) handleAlertTone(client *Client, toneType string) {
	h.mu.RLock()
	ch := h.channels[client.CurrentChannelID]
	h.mu.RUnlock()

	if ch != nil {
		log.Printf("[Hub] Alert tone '%s' broadcast on Channel %d by %s", toneType, ch.Definition.ID, client.Callsign)
		ch.BroadcastSignal(SignalMessage{
			Type: MsgTypeAlertTone,
			Payload: map[string]interface{}{
				"channel_id": ch.Definition.ID,
				"tone_type":  toneType,
				"callsign":   client.Callsign,
			},
			Timestamp: time.Now().UnixMilli(),
		})
	}
}

func (h *Hub) handleTOTExpired(ch *Channel, speaker *Client) {
	// Finalize recording if active
	if h.recorder != nil {
		if rec := h.recorder.OnTransmissionEnd(ch.Definition.ID); rec != nil {
			ch.BroadcastSignal(SignalMessage{
				Type:      MsgTypeTransmissionRecorded,
				Payload:   rec,
				Timestamp: time.Now().UnixMilli(),
			})
		}
	}

	// Notify speaker that timeout occurred
	speaker.SendJSON(SignalMessage{
		Type: MsgTypeFloorStatus,
		Payload: FloorStatusPayload{
			ChannelID: ch.Definition.ID,
			Status:    FloorStatusTOT,
			Reason:    "time_out_timer_exceeded",
		},
		Timestamp: time.Now().UnixMilli(),
	})

	// Broadcast idle to channel
	ch.BroadcastSignal(SignalMessage{
		Type: MsgTypeFloorStatus,
		Payload: FloorStatusPayload{
			ChannelID: ch.Definition.ID,
			Status:    FloorStatusIdle,
		},
		Timestamp: time.Now().UnixMilli(),
	})

	// Broadcast user stopped
	ch.BroadcastSignal(SignalMessage{
		Type: MsgTypeUserStopped,
		Payload: TransmissionEventPayload{
			ChannelID: ch.Definition.ID,
			UserID:    speaker.ID,
			Callsign:  speaker.Callsign,
		},
		Timestamp: time.Now().UnixMilli(),
	})

	// Broadcast channel idle state to all clients
	h.BroadcastAll(SignalMessage{
		Type: MsgTypeChannelActivity,
		Payload: map[string]interface{}{
			"channel_id": ch.Definition.ID,
			"is_busy":    false,
		},
		Timestamp: time.Now().UnixMilli(),
	})
}

// BroadcastAll sends a SignalMessage to all connected clients across all channels.
// Marshals JSON once to save CPU on small servers with multiple connections.
func (h *Hub) BroadcastAll(msg SignalMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.clients {
		client.SendRawJSON(data)
	}
}

// HandleBinaryAudio validates floor permission and dispatches audio to channel listeners.
// Uses stack-allocated header parsing for zero GC allocations.
func (h *Hub) HandleBinaryAudio(client *Client, data []byte) {
	channelID, flags, _, _, err := ParseAudioHeaderQuick(data)
	if err != nil {
		return
	}

	targetChID := int(channelID)
	h.mu.RLock()
	ch, exists := h.channels[targetChID]
	h.mu.RUnlock()

	if !exists || ch == nil {
		return
	}

	// Fast lock-free validation: client must be in this channel and hold the floor
	if client.CurrentChannelID != targetChID || !ch.IsFloorHolder(client) {
		return
	}

	// Update audio throughput metrics
	atomic.AddUint64(&h.totalAudioBytes, uint64(len(data)))

	// Append raw PCM data to active server-side recording buffer
	if h.recorder != nil && len(data) > AudioHeaderSize {
		h.recorder.AppendAudio(targetChID, data[AudioHeaderSize:])
	}

	// Fleet-wide All-Call broadcast for Dispatchers/Commanders if flagged
	if flags&FlagAudioAllCall != 0 {
		h.mu.RLock()
		for _, c := range h.channels {
			c.BroadcastAudio(client, data)
		}
		h.mu.RUnlock()
	} else {
		// Fan out audio to all other listeners on this channel
		ch.BroadcastAudio(client, data)
	}

	// Relay audio to external RoIP gateways if configured
	h.mu.RLock()
	relay := h.roipRelay
	h.mu.RUnlock()
	if relay != nil {
		relay(targetChID, data)
	}
}

// SetRoIPRelay registers a callback to dispatch outgoing radio audio to external RoIP gateways.
func (h *Hub) SetRoIPRelay(relay RoIPRelayFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.roipRelay = relay
}

// HandleRoIPAudio injects audio received from an external RoIP UDP device directly into a channel.
func (h *Hub) HandleRoIPAudio(channelID int, data []byte) {
	h.mu.RLock()
	ch, exists := h.channels[channelID]
	h.mu.RUnlock()

	if !exists || ch == nil {
		return
	}

	// Dispatch to all subscribers in this channel (sender is nil so all clients hear it)
	ch.BroadcastAudio(nil, data)
}

func (h *Hub) broadcastUserList(ch *Channel) {
	users := ch.GetUserCallsigns()
	subscribers := ch.GetSubscribersInfo()
	ch.BroadcastSignal(SignalMessage{
		Type: MsgTypeUserList,
		Payload: map[string]interface{}{
			"channel_id":   ch.Definition.ID,
			"users":        users,
			"user_details": subscribers,
			"count":        len(users),
		},
		Timestamp: time.Now().UnixMilli(),
	})
}

// GetChannelList returns snapshot info of all channels.
func (h *Hub) GetChannelList() []ChannelInfo {
	h.mu.RLock()
	defer h.mu.RUnlock()

	list := make([]ChannelInfo, 0, len(h.channels))
	for id := 1; id <= len(h.channels); id++ {
		ch, ok := h.channels[id]
		if !ok {
			continue
		}
		isBusy, speaker := ch.GetState()
		list = append(list, ChannelInfo{
			ID:             ch.Definition.ID,
			Name:           ch.Definition.Name,
			Frequency:      ch.Definition.Frequency,
			CTCSS:          ch.Definition.CTCSS,
			Color:          ch.Definition.Color,
			Latitude:       ch.Definition.Latitude,
			Longitude:      ch.Definition.Longitude,
			CoverageKm:     ch.Definition.CoverageKm,
			Region:         ch.Definition.Region,
			UserCount:      ch.SubscriberCount(),
			IsBusy:         isBusy,
			IsPrivate:      ch.Definition.IsPrivate,
			CurrentSpeaker: speaker,
			Users:          ch.GetUserCallsigns(),
		})
	}
	return list
}

// GetRecordings returns recorded audio transmissions from the server-side archive.
func (h *Hub) GetRecordings(channelID int) []VoiceRecording {
	if h.recorder == nil {
		return nil
	}
	return h.recorder.GetRecordings(channelID)
}

// GetMetrics returns detailed runtime statistics, throughput, and performance metrics.
func (h *Hub) GetMetrics() map[string]interface{} {
	h.mu.RLock()
	totalClients := len(h.clients)
	channelsCount := len(h.channels)
	h.mu.RUnlock()

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	uptime := time.Since(h.startTime)

	return map[string]interface{}{
		"server": map[string]interface{}{
			"version":    "2.4.0-enterprise",
			"uptime":     uptime.String(),
			"uptime_sec": int64(uptime.Seconds()),
			"go_version": runtime.Version(),
			"goroutines": runtime.NumGoroutine(),
			"cpu_cores":  runtime.NumCPU(),
		},
		"radio": map[string]interface{}{
			"active_clients":      totalClients,
			"channels_count":      channelsCount,
			"total_transmissions": atomic.LoadUint64(&h.totalTransmissions),
			"total_preemptions":   atomic.LoadUint64(&h.totalPreemptions),
			"total_audio_bytes":   atomic.LoadUint64(&h.totalAudioBytes),
			"total_audio_mb":      fmt.Sprintf("%.2f MB", float64(atomic.LoadUint64(&h.totalAudioBytes))/(1024*1024)),
		},
		"memory": map[string]interface{}{
			"alloc_mb":       fmt.Sprintf("%.2f MB", float64(mem.Alloc)/(1024*1024)),
			"total_alloc_mb": fmt.Sprintf("%.2f MB", float64(mem.TotalAlloc)/(1024*1024)),
			"sys_mb":         fmt.Sprintf("%.2f MB", float64(mem.Sys)/(1024*1024)),
			"num_gc":         mem.NumGC,
		},
	}
}

// GetStatus returns server metrics.
func (h *Hub) GetStatus() map[string]interface{} {
	h.mu.RLock()
	defer h.mu.RUnlock()

	totalUsers := len(h.clients)
	channelsInfo := make([]map[string]interface{}, 0, len(h.channels))
	for _, ch := range h.channels {
		isBusy, speaker := ch.GetState()
		channelsInfo = append(channelsInfo, map[string]interface{}{
			"id":              ch.Definition.ID,
			"name":            ch.Definition.Name,
			"frequency":       ch.Definition.Frequency,
			"subscribers":     ch.SubscriberCount(),
			"is_busy":         isBusy,
			"current_speaker": speaker,
		})
	}

	return map[string]interface{}{
		"uptime_seconds":      int(time.Since(h.startTime).Seconds()),
		"total_clients":       totalUsers,
		"channels":            channelsInfo,
		"total_transmissions": atomic.LoadUint64(&h.totalTransmissions),
		"total_preemptions":   atomic.LoadUint64(&h.totalPreemptions),
		"total_audio_bytes":   atomic.LoadUint64(&h.totalAudioBytes),
	}
}
