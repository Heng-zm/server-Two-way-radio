package radio

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// VoiceRecording metadata for an archived radio transmission.
type VoiceRecording struct {
	ID              string  `json:"id"`
	ChannelID       int     `json:"channel_id"`
	Callsign        string  `json:"callsign"`
	Role            string  `json:"role,omitempty"`
	Timestamp       int64   `json:"timestamp"`
	DurationSeconds float64 `json:"duration_seconds"`
	FileURL         string  `json:"file_url"`
	SizeBytes       int64   `json:"size_bytes"`
}

// TransmissionBuffer buffers raw PCM samples for an active speaker until transmission ends.
type TransmissionBuffer struct {
	ChannelID int
	SpeakerID string
	Callsign  string
	Role      string
	StartTime time.Time
	Buffer    bytes.Buffer
}

// AudioRecorder manages server-side radio transmission archiving and WAV export.
type AudioRecorder struct {
	mu         sync.RWMutex
	storageDir string
	activeTX   map[int]*TransmissionBuffer // channelID -> active transmission buffer
	recordings []VoiceRecording
	maxHistory int
	enabled    bool
}

// maxBufferBytes limits buffered audio per transmission to 60s (1.92 MB) to prevent RAM exhaustion.
const maxBufferBytes = 16000 * 2 * 60

// NewAudioRecorder creates a new server-side radio audio recorder.
func NewAudioRecorder(storageDir string) *AudioRecorder {
	_ = os.MkdirAll(storageDir, 0755)

	maxHistory := 50
	if envMax := os.Getenv("MAX_RECORDINGS"); envMax != "" {
		if m, err := strconv.Atoi(envMax); err == nil && m > 0 {
			maxHistory = m
		}
	}

	enabled := true
	if os.Getenv("DISABLE_RECORDINGS") == "true" || os.Getenv("DISABLE_RECORDINGS") == "1" {
		enabled = false
	}

	return &AudioRecorder{
		storageDir: storageDir,
		activeTX:   make(map[int]*TransmissionBuffer),
		recordings: make([]VoiceRecording, 0),
		maxHistory: maxHistory,
		enabled:    enabled,
	}
}

// OnTransmissionStart begins buffering audio for an active speaker on a channel.
func (r *AudioRecorder) OnTransmissionStart(channelID int, speaker *Client) {
	if !r.enabled {
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	r.activeTX[channelID] = &TransmissionBuffer{
		ChannelID: channelID,
		SpeakerID: speaker.ID,
		Callsign:  speaker.Callsign,
		Role:      speaker.Role,
		StartTime: time.Now(),
	}
}

// AppendAudio appends raw audio payload (PCM samples without the 8-byte header) to the active transmission.
// Enforces a hard memory ceiling of maxBufferBytes (60s) to keep small servers running smoothly.
func (r *AudioRecorder) AppendAudio(channelID int, payload []byte) {
	if !r.enabled {
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	tx, exists := r.activeTX[channelID]
	if !exists || tx == nil {
		return
	}

	// Strictly limit transmission buffer size to prevent RAM bloat on small servers
	if tx.Buffer.Len()+len(payload) > maxBufferBytes {
		return
	}

	tx.Buffer.Write(payload)
}

// OnTransmissionEnd finishes the transmission, writes a standard 16kHz WAV file, and saves the recording.
// Automatically purges oldest WAV files from disk to prevent storage exhaustion on low-end servers.
func (r *AudioRecorder) OnTransmissionEnd(channelID int) *VoiceRecording {
	if !r.enabled {
		return nil
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	tx, exists := r.activeTX[channelID]
	if !exists || tx == nil {
		return nil
	}
	delete(r.activeTX, channelID)

	pcmData := tx.Buffer.Bytes()
	if len(pcmData) < 3200 { // less than 100ms of audio, ignore noise/clicks
		return nil
	}

	duration := float64(len(pcmData)) / (16000.0 * 2.0) // 16kHz 16-bit mono = 32000 bytes/sec
	now := time.Now()
	recID := fmt.Sprintf("tx_%d_%d", now.UnixNano(), channelID)
	fileName := fmt.Sprintf("CH%02d_%s_%d.wav", channelID, tx.Callsign, now.Unix())
	filePath := filepath.Join(r.storageDir, fileName)

	// Write standard 16kHz 16-bit Mono WAV
	wavBytes := EncodeWAV(16000, 1, 16, pcmData)
	if err := os.WriteFile(filePath, wavBytes, 0644); err != nil {
		return nil
	}

	rec := VoiceRecording{
		ID:              recID,
		ChannelID:       channelID,
		Callsign:        tx.Callsign,
		Role:            tx.Role,
		Timestamp:       now.UnixMilli(),
		DurationSeconds: float64(int(duration*10)) / 10,
		FileURL:         fmt.Sprintf("/recordings/%s", fileName),
		SizeBytes:       int64(len(wavBytes)),
	}

	r.recordings = append(r.recordings, rec)

	// Auto-prune oldest audio recordings from memory AND disk to keep storage bounded
	if len(r.recordings) > r.maxHistory {
		evicted := r.recordings[:len(r.recordings)-r.maxHistory]
		for _, e := range evicted {
			oldFilePath := filepath.Join(r.storageDir, filepath.Base(e.FileURL))
			_ = os.Remove(oldFilePath) // Non-blocking removal of expired WAV file
		}
		r.recordings = r.recordings[len(r.recordings)-r.maxHistory:]
	}

	return &rec
}

// GetRecordings returns recent audio recordings, optionally filtered by channelID (0 for all).
func (r *AudioRecorder) GetRecordings(channelID int) []VoiceRecording {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if channelID <= 0 {
		res := make([]VoiceRecording, len(r.recordings))
		copy(res, r.recordings)
		return res
	}

	var filtered []VoiceRecording
	for _, rec := range r.recordings {
		if rec.ChannelID == channelID {
			filtered = append(filtered, rec)
		}
	}
	return filtered
}

// EncodeWAV writes standard 44-byte RIFF header followed by raw PCM bytes.
func EncodeWAV(sampleRate uint32, channels uint16, bitsPerSample uint16, pcm []byte) []byte {
	var buf bytes.Buffer
	dataSize := uint32(len(pcm))
	chunkSize := 36 + dataSize
	byteRate := sampleRate * uint32(channels) * uint32(bitsPerSample) / 8
	blockAlign := channels * bitsPerSample / 8

	// RIFF chunk descriptor
	buf.WriteString("RIFF")
	_ = binary.Write(&buf, binary.LittleEndian, chunkSize)
	buf.WriteString("WAVE")

	// fmt sub-chunk
	buf.WriteString("fmt ")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(16)) // Subchunk1Size
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1))  // PCM format
	_ = binary.Write(&buf, binary.LittleEndian, channels)
	_ = binary.Write(&buf, binary.LittleEndian, sampleRate)
	_ = binary.Write(&buf, binary.LittleEndian, byteRate)
	_ = binary.Write(&buf, binary.LittleEndian, blockAlign)
	_ = binary.Write(&buf, binary.LittleEndian, bitsPerSample)

	// data sub-chunk
	buf.WriteString("data")
	_ = binary.Write(&buf, binary.LittleEndian, dataSize)
	buf.Write(pcm)

	return buf.Bytes()
}
