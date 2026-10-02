package radio

import (
	"os"
	"sync/atomic"
	"testing"
	"time"

	"twowayradio/internal/config"
)

func TestChannelFloorControl(t *testing.T) {
	def := config.ChannelDef{
		ID:        1,
		Name:      "TEST CH 1",
		Frequency: 446.00625,
	}

	ch := NewChannel(def, 5*time.Second, nil)

	clientA := &Client{ID: "clientA", Callsign: "ALPHA"}
	clientB := &Client{ID: "clientB", Callsign: "BRAVO"}

	ch.AddSubscriber(clientA)
	ch.AddSubscriber(clientB)

	if count := ch.SubscriberCount(); count != 2 {
		t.Fatalf("expected 2 subscribers, got %d", count)
	}

	// 1. Client A requests floor -> Should be granted
	granted, reason, _, _ := ch.RequestFloor(clientA)
	if !granted {
		t.Fatalf("expected floor granted to clientA, got denied: %s", reason)
	}
	if !ch.IsFloorHolder(clientA) {
		t.Fatalf("expected clientA to be floor holder")
	}

	// 2. Client B requests floor -> Should be denied (channel busy)
	granted, reason, speaker, _ := ch.RequestFloor(clientB)
	if granted {
		t.Fatalf("expected floor denied to clientB while clientA is talking")
	}
	if reason != "channel_busy" || speaker != "ALPHA" {
		t.Fatalf("expected reason 'channel_busy' with speaker 'ALPHA', got '%s', '%s'", reason, speaker)
	}

	// 3. Client A releases floor -> Channel becomes idle
	released := ch.ReleaseFloor(clientA)
	if !released {
		t.Fatalf("expected floor release to succeed")
	}

	busy, _ := ch.GetState()
	if busy {
		t.Fatalf("expected channel to be idle after release")
	}

	// 4. Now Client B requests floor -> Should be granted
	granted, _, _, _ = ch.RequestFloor(clientB)
	if !granted {
		t.Fatalf("expected floor granted to clientB after clientA released")
	}
	if !ch.IsFloorHolder(clientB) {
		t.Fatalf("expected clientB to be floor holder")
	}
}

func TestChannelTOTTimeout(t *testing.T) {
	var totFired int32

	def := config.ChannelDef{
		ID:        2,
		Name:      "TEST TOT",
		Frequency: 446.01875,
	}

	ch := NewChannel(def, 50*time.Millisecond, func(c *Channel, speaker *Client) {
		atomic.StoreInt32(&totFired, 1)
	})

	clientA := &Client{ID: "clientA", Callsign: "HOT-MIC"}
	ch.AddSubscriber(clientA)

	granted, _, _, _ := ch.RequestFloor(clientA)
	if !granted {
		t.Fatalf("failed to grant floor")
	}

	// Wait for TOT to expire
	time.Sleep(100 * time.Millisecond)

	if atomic.LoadInt32(&totFired) != 1 {
		t.Fatalf("expected TOT callback to be triggered")
	}

	busy, _ := ch.GetState()
	if busy {
		t.Fatalf("expected channel to be idle after TOT timeout")
	}
}

func TestAudioPacketEncoding(t *testing.T) {
	chID := uint8(5)
	flags := uint8(FlagAudioFirst | FlagAudioLast)
	seq := uint32(123456)
	payload := []byte("OpusFakeAudioDataBytes1234567890")

	encoded := EncodeAudioPacket(chID, flags, seq, payload)
	if len(encoded) != AudioHeaderSize+len(payload) {
		t.Fatalf("unexpected packet length: %d", len(encoded))
	}

	hdr, extractedPayload, err := ParseAudioHeader(encoded)
	if err != nil {
		t.Fatalf("failed to parse audio header: %v", err)
	}

	if hdr.ChannelID != chID {
		t.Fatalf("expected channel %d, got %d", chID, hdr.ChannelID)
	}
	if hdr.Flags != flags {
		t.Fatalf("expected flags %d, got %d", flags, hdr.Flags)
	}
	if hdr.SeqNum != seq {
		t.Fatalf("expected seq %d, got %d", seq, hdr.SeqNum)
	}
	if string(extractedPayload) != string(payload) {
		t.Fatalf("payload mismatch")
	}
}

func TestHubRoIPRelay(t *testing.T) {
	cfg := config.DefaultConfig()
	hub := NewHub(cfg)

	var relayCalled int32
	var receivedChID int
	hub.SetRoIPRelay(func(channelID int, data []byte) {
		atomic.StoreInt32(&relayCalled, 1)
		receivedChID = channelID
	})

	// Create dummy client
	clientA := &Client{
		ID:               "clientA",
		Callsign:         "ALPHA",
		CurrentChannelID: 1,
		send:             make(chan []byte, 10),
		highPri:          make(chan []byte, 10),
	}
	hub.RegisterClient(clientA)

	// Acquire floor
	ch := hub.channels[1]
	granted, _, _, _ := ch.RequestFloor(clientA)
	if !granted {
		t.Fatalf("failed to grant floor")
	}

	// Transmit audio
	testPayload := []byte("testing-roip-relay-audio")
	packet := EncodeAudioPacket(1, FlagAudioFirst, 1, testPayload)
	hub.HandleBinaryAudio(clientA, packet)

	if atomic.LoadInt32(&relayCalled) != 1 {
		t.Fatalf("expected roipRelay callback to be invoked")
	}
	if receivedChID != 1 {
		t.Fatalf("expected roip relay for channel 1, got %d", receivedChID)
	}

	// Drain any initialization signals (welcome, channel list)
	for len(clientA.send) > 0 {
		<-clientA.send
	}

	// Test RoIP inbound audio injection
	hub.HandleRoIPAudio(1, packet)
	select {
	case received := <-clientA.send:
		if len(received) != len(packet) {
			t.Fatalf("client did not receive full inbound RoIP packet: got %d bytes, expected %d", len(received), len(packet))
		}
	default:
		t.Fatalf("expected clientA to receive inbound RoIP audio packet")
	}
}

func TestPriorityPreemption(t *testing.T) {
	def := config.ChannelDef{
		ID:        3,
		Name:      "TACTICAL 1",
		Frequency: 446.03125,
	}
	ch := NewChannel(def, 5*time.Second, nil)

	fieldUnit := &Client{ID: "unit1", Callsign: "PATROL-01", Role: "Field Unit"}
	dispatcher := &Client{ID: "disp1", Callsign: "DISPATCH-CENTRAL", Role: "Dispatcher"}
	commander := &Client{ID: "cmd1", Callsign: "COMMANDER-01", Role: "Commander"}
	normalUnit := &Client{ID: "unit2", Callsign: "PATROL-02", Role: "Field Unit"}

	ch.AddSubscriber(fieldUnit)
	ch.AddSubscriber(dispatcher)
	ch.AddSubscriber(commander)
	ch.AddSubscriber(normalUnit)

	// 1. Field unit acquires floor
	granted, _, _, _ := ch.RequestFloor(fieldUnit)
	if !granted {
		t.Fatalf("expected floor granted to fieldUnit")
	}

	// 2. Normal unit attempts to acquire floor -> denied (same priority)
	granted, reason, speaker, preempted := ch.RequestFloor(normalUnit)
	if granted || preempted != nil {
		t.Fatalf("expected floor denied to normalUnit, got granted=%v", granted)
	}
	if reason != "channel_busy" || speaker != "PATROL-01" {
		t.Fatalf("unexpected reason=%s, speaker=%s", reason, speaker)
	}

	// 3. Dispatcher (priority 2) requests floor -> preempts Field Unit (priority 1)
	granted, reason, speaker, preempted = ch.RequestFloor(dispatcher)
	if !granted {
		t.Fatalf("expected dispatcher to preempt fieldUnit")
	}
	if reason != "preempted" || preempted != fieldUnit {
		t.Fatalf("expected reason 'preempted' and preempted client fieldUnit, got reason=%s", reason)
	}
	if !ch.IsFloorHolder(dispatcher) {
		t.Fatalf("expected dispatcher to be new floor holder")
	}

	// 4. Commander (priority 3) requests floor -> preempts Dispatcher (priority 2)
	granted, reason, speaker, preempted = ch.RequestFloor(commander)
	if !granted {
		t.Fatalf("expected commander to preempt dispatcher")
	}
	if reason != "preempted" || preempted != dispatcher {
		t.Fatalf("expected reason 'preempted' and preempted client dispatcher, got reason=%s", reason)
	}
	if !ch.IsFloorHolder(commander) {
		t.Fatalf("expected commander to be new floor holder")
	}

	// 5. Field Unit attempts to preempt Commander -> denied
	granted, reason, speaker, preempted = ch.RequestFloor(fieldUnit)
	if granted || preempted != nil {
		t.Fatalf("field unit must not be able to preempt commander")
	}
	if speaker != "COMMANDER-01" {
		t.Fatalf("expected speaker 'COMMANDER-01', got '%s'", speaker)
	}
}

func TestAudioRecorderWAV(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "radio_recordings_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	recorder := NewAudioRecorder(tempDir)
	speaker := &Client{ID: "unit99", Callsign: "ALPHA-99", Role: "Dispatcher"}

	// Start transmission
	recorder.OnTransmissionStart(1, speaker)

	// Feed 3200 bytes of PCM audio (100ms at 16kHz 16-bit mono)
	pcmChunk := make([]byte, 3200)
	for i := range pcmChunk {
		pcmChunk[i] = byte(i % 256)
	}
	recorder.AppendAudio(1, pcmChunk)

	// End transmission
	rec := recorder.OnTransmissionEnd(1)
	if rec == nil {
		t.Fatalf("expected transmission to be successfully recorded")
	}

	if rec.ChannelID != 1 || rec.Callsign != "ALPHA-99" {
		t.Fatalf("unexpected recording metadata: %+v", rec)
	}
	if rec.DurationSeconds <= 0 {
		t.Fatalf("expected duration > 0, got %f", rec.DurationSeconds)
	}
	if rec.SizeBytes < int64(len(pcmChunk)+44) {
		t.Fatalf("expected WAV size >= 3244 bytes, got %d", rec.SizeBytes)
	}

	// Verify recordings list
	allRecs := recorder.GetRecordings(0)
	if len(allRecs) != 1 {
		t.Fatalf("expected 1 recording in history, got %d", len(allRecs))
	}
	chRecs := recorder.GetRecordings(1)
	if len(chRecs) != 1 {
		t.Fatalf("expected 1 recording for channel 1, got %d", len(chRecs))
	}
	ch2Recs := recorder.GetRecordings(2)
	if len(ch2Recs) != 0 {
		t.Fatalf("expected 0 recordings for channel 2, got %d", len(ch2Recs))
	}
}

func TestHubMetrics(t *testing.T) {
	cfg := config.DefaultConfig()
	hub := NewHub(cfg)

	metrics := hub.GetMetrics()
	if metrics == nil {
		t.Fatalf("expected metrics map, got nil")
	}

	serverStats, ok := metrics["server"].(map[string]interface{})
	if !ok || serverStats["version"] == nil {
		t.Fatalf("expected valid server metrics")
	}

	radioStats, ok := metrics["radio"].(map[string]interface{})
	if !ok || radioStats["channels_count"] == nil {
		t.Fatalf("expected valid radio metrics")
	}
}

