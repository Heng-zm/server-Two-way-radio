package radio

import (
	"testing"
)

func TestParseAudioHeaderQuick(t *testing.T) {
	chID := uint8(3)
	flags := uint8(FlagAudioFirst)
	seq := uint32(987654)
	payload := []byte("16kHzPCMTestingDataSamples")

	encoded := EncodeAudioPacket(chID, flags, seq, payload)

	parsedCh, parsedFlags, parsedSeq, parsedPayload, err := ParseAudioHeaderQuick(encoded)
	if err != nil {
		t.Fatalf("ParseAudioHeaderQuick returned error: %v", err)
	}

	if parsedCh != chID {
		t.Fatalf("expected channel %d, got %d", chID, parsedCh)
	}
	if parsedFlags != flags {
		t.Fatalf("expected flags %d, got %d", flags, parsedFlags)
	}
	if parsedSeq != seq {
		t.Fatalf("expected seq %d, got %d", seq, parsedSeq)
	}
	if string(parsedPayload) != string(payload) {
		t.Fatalf("payload mismatch")
	}
}

func BenchmarkParseAudioHeaderQuick(b *testing.B) {
	payload := make([]byte, 1280*2) // 80ms 16kHz PCM
	encoded := EncodeAudioPacket(1, FlagAudioFirst, 100, payload)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		_, _, _, _, _ = ParseAudioHeaderQuick(encoded)
	}
}

func BenchmarkAudioBufferPool(b *testing.B) {
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		buf := GetAudioBuffer(2560)
		PutAudioBuffer(buf)
	}
}
