package radio

import (
	"encoding/binary"
	"errors"
	"sync"
)

// Signaling Message Types
const (
	MsgTypeIdentify     = "identify"       // Client -> Server: set callsign
	MsgTypeJoinChannel  = "join_channel"   // Client -> Server: switch channel
	MsgTypeCreateChannel = "create_channel" // Client -> Server: create channel
	MsgTypePTTDown      = "ptt_down"       // Client -> Server: request floor (key up mic)
	MsgTypePTTUp        = "ptt_up"         // Client -> Server: release floor (unkey mic)
	MsgTypeAlertTone    = "alert_tone"     // Client -> Server: broadcast alert tone (emergency / 1750Hz)
	MsgTypeFloorStatus  = "floor_status"   // Server -> Client: floor granted, denied, or busy
	MsgTypeUserTalking  = "user_talking"   // Server -> Client: User X is transmitting
	MsgTypeUserStopped  = "user_stopped"   // Server -> Client: User X stopped transmitting
	MsgTypeChannelList  = "channel_list"   // Server -> Client: info on all channels
	MsgTypeUserList     = "user_list"      // Server -> Client: list of users in channel
	MsgTypeLocation     = "location_update" // Client <-> Server: GPS/Location beacon
	MsgTypeError           = "error"          // Server -> Client: error message
	MsgTypePing            = "ping"
	MsgTypePong            = "pong"
	MsgTypeChannelActivity = "channel_activity" // Server -> All Clients: Channel busy/idle state update

	// Chat Messaging
	MsgTypeChatMessage = "chat_message" // Client <-> Server: text message
	MsgTypeChatHistory = "chat_history" // Server -> Client: recent channel messages

	// WebRTC Video Call
	MsgTypeVideoCallStart = "video_call_start" // Client <-> Server: video call started
	MsgTypeVideoCallEnd   = "video_call_end"   // Client <-> Server: video call ended
	MsgTypeVideoJoin      = "video_join"       // Client -> Server: join channel video
	MsgTypeVideoOffer     = "video_offer"      // WebRTC SDP Offer
	MsgTypeVideoAnswer    = "video_answer"     // WebRTC SDP Answer
	MsgTypeVideoICE       = "video_ice"        // WebRTC ICE Candidate
)

// Floor Status States
const (
	FloorStatusGranted = "granted"
	FloorStatusDenied  = "denied"
	FloorStatusIdle    = "idle"
	FloorStatusTOT     = "timeout"
)

// Generic signaling envelope
type SignalMessage struct {
	Type      string      `json:"type"`
	Payload   interface{} `json:"payload,omitempty"`
	Timestamp int64       `json:"timestamp,omitempty"`
}

// Client -> Server: Identify
type IdentifyPayload struct {
	Callsign string `json:"callsign"`
	Role     string `json:"role,omitempty"` // e.g. "Operator", "Field Unit"
}

// Client <-> Server: GPS/Location
type LocationPayload struct {
	UserID    string  `json:"user_id,omitempty"`
	Callsign  string  `json:"callsign,omitempty"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Accuracy  float64 `json:"accuracy,omitempty"`
	City      string  `json:"city,omitempty"`
}

	// Client -> Server: JoinChannel
type JoinChannelPayload struct {
	ChannelID int    `json:"channel_id"`
	Password  string `json:"password,omitempty"`
}

// Client -> Server: CreateChannel
type CreateChannelPayload struct {
	Name      string `json:"name"`
	IsPrivate bool   `json:"is_private"`
	Password  string `json:"password,omitempty"`
}

// Client -> Server: AlertTone
type AlertTonePayload struct {
	ToneType string `json:"tone_type"` // e.g. "emergency", "1750hz", "call"
}

// Server -> Client: FloorStatus
type FloorStatusPayload struct {
	ChannelID      int    `json:"channel_id"`
	Status         string `json:"status"` // "granted", "denied", "idle", "timeout"
	Reason         string `json:"reason,omitempty"`
	CurrentSpeaker string `json:"current_speaker,omitempty"`
	SpeakerID      string `json:"speaker_id,omitempty"`
}

// Server -> Client: UserTalking / UserStopped
type TransmissionEventPayload struct {
	ChannelID int    `json:"channel_id"`
	UserID    string `json:"user_id"`
	Callsign  string `json:"callsign"`
}

// Server -> Client: Channel Info
type ChannelInfo struct {
	ID             int      `json:"id"`
	Name           string   `json:"name"`
	Frequency      float64  `json:"frequency"`
	CTCSS          float64  `json:"ctcss"`
	Color          string   `json:"color"`
	Latitude       float64  `json:"latitude,omitempty"`
	Longitude      float64  `json:"longitude,omitempty"`
	CoverageKm     float64  `json:"coverage_km,omitempty"`
	Region         string   `json:"region,omitempty"`
	UserCount      int      `json:"user_count"`
	IsBusy         bool     `json:"is_busy"`
	IsPrivate      bool     `json:"is_private"`
	CurrentSpeaker string   `json:"current_speaker,omitempty"`
	Users          []string `json:"users,omitempty"`
}

// Client <-> Server: Chat Message
type ChatMessagePayload struct {
	ID        string `json:"id"`
	ChannelID int    `json:"channel_id"`
	SenderID  string `json:"sender_id"`
	Callsign  string `json:"callsign"`
	Text      string `json:"text"`
	FileUrl   string `json:"file_url,omitempty"`
	FileName  string `json:"file_name,omitempty"`
	FileType  string `json:"file_type,omitempty"`
	Timestamp int64  `json:"timestamp"`
}

// Server -> Client: Chat History
type ChatHistoryPayload struct {
	ChannelID int                  `json:"channel_id"`
	Messages  []ChatMessagePayload `json:"messages"`
}

// Client <-> Server: Video Call Signaling
type VideoSignalingPayload struct {
	ChannelID int         `json:"channel_id"`
	SenderID  string      `json:"sender_id,omitempty"`
	TargetID  string      `json:"target_id,omitempty"`
	Callsign  string      `json:"callsign,omitempty"`
	IsScreen  bool        `json:"is_screen,omitempty"`
	SDP       string      `json:"sdp,omitempty"`
	Candidate interface{} `json:"candidate,omitempty"`
}

// Binary Audio Packet Header (8 bytes):
// [0..1] Magic Bytes: 0x52, 0x41 ('R', 'A')
// [2]    Channel ID (uint8)
// [3]    Flags: bit 0: is_first_packet, bit 1: is_last_packet
// [4..7] Sequence number (uint32, big-endian)
// [8..N] Raw Audio Payload (16kHz PCM or Opus)

const (
	AudioMagic0     = 0x52 // 'R'
	AudioMagic1     = 0x41 // 'A'
	AudioHeaderSize = 8

	FlagAudioFirst = 0x01
	FlagAudioLast  = 0x02
)

var ErrInvalidAudioPacket = errors.New("invalid radio audio packet header")

type AudioPacketHeader struct {
	ChannelID uint8
	Flags     uint8
	SeqNum    uint32
}

// Buffer pool for binary packets to minimize garbage collection allocations
var audioBufferPool = sync.Pool{
	New: func() interface{} {
		b := make([]byte, 4096)
		return &b
	},
}

// GetAudioBuffer gets a pooled buffer
func GetAudioBuffer(minSize int) *[]byte {
	if minSize > 4096 {
		b := make([]byte, minSize)
		return &b
	}
	return audioBufferPool.Get().(*[]byte)
}

// PutAudioBuffer returns buffer to pool
func PutAudioBuffer(b *[]byte) {
	if b != nil && cap(*b) >= 4096 && cap(*b) <= 8192 {
		audioBufferPool.Put(b)
	}
}

// ParseAudioHeader extracts header and payload with zero unnecessary allocations
func ParseAudioHeader(data []byte) (*AudioPacketHeader, []byte, error) {
	if len(data) < AudioHeaderSize {
		return nil, nil, ErrInvalidAudioPacket
	}
	if data[0] != AudioMagic0 || data[1] != AudioMagic1 {
		return nil, nil, ErrInvalidAudioPacket
	}
	return &AudioPacketHeader{
		ChannelID: data[2],
		Flags:     data[3],
		SeqNum:    binary.BigEndian.Uint32(data[4:8]),
	}, data[AudioHeaderSize:], nil
}

// ParseAudioHeaderQuick extracts fields directly onto stack without heap allocation
func ParseAudioHeaderQuick(data []byte) (channelID uint8, flags uint8, seqNum uint32, payload []byte, err error) {
	if len(data) < AudioHeaderSize {
		return 0, 0, 0, nil, ErrInvalidAudioPacket
	}
	if data[0] != AudioMagic0 || data[1] != AudioMagic1 {
		return 0, 0, 0, nil, ErrInvalidAudioPacket
	}
	return data[2], data[3], binary.BigEndian.Uint32(data[4:8]), data[AudioHeaderSize:], nil
}

func EncodeAudioPacket(channelID uint8, flags uint8, seqNum uint32, payload []byte) []byte {
	buf := make([]byte, AudioHeaderSize+len(payload))
	buf[0] = AudioMagic0
	buf[1] = AudioMagic1
	buf[2] = channelID
	buf[3] = flags
	binary.BigEndian.PutUint32(buf[4:8], seqNum)
	copy(buf[AudioHeaderSize:], payload)
	return buf
}
