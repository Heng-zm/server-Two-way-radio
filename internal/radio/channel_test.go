package radio

import (
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
	granted, reason, _ := ch.RequestFloor(clientA)
	if !granted {
		t.Fatalf("expected floor granted to clientA, got denied: %s", reason)
	}
	if !ch.IsFloorHolder(clientA) {
		t.Fatalf("expected clientA to be floor holder")
	}

	// 2. Client B requests floor -> Should be denied (channel busy)
	granted, reason, speaker := ch.RequestFloor(clientB)
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
	granted, _, _ = ch.RequestFloor(clientB)
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

	granted, _, _ := ch.RequestFloor(clientA)
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
