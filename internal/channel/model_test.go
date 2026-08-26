package channel

import (
	"strings"
	"testing"
	"time"
)

func TestNewChannelBuildsStablePath(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	item, err := New(Draft{
		Name:    "  Studio Camera 1  ",
		Enabled: true,
		Input: Input{
			Mode: InputSRTPush,
			SRT:  &SRTInput{Port: 10000, Passphrase: "0123456789"},
		},
	}, now)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if item.Name != "Studio Camera 1" {
		t.Fatalf("Name = %q", item.Name)
	}
	if !strings.HasPrefix(item.Path, "studio-camera-1-") {
		t.Fatalf("Path = %q", item.Path)
	}
	if item.ApplyState != ApplyPending || !item.CreatedAt.Equal(now) {
		t.Fatalf("unexpected initial state: %#v", item)
	}
	if item.Input.SRT.LatencyMS != 20 {
		t.Fatalf("SRT latency = %d, want low-latency LAN default 20", item.Input.SRT.LatencyMS)
	}

	updated, err := item.WithDraft(Draft{
		Name:    "Renamed",
		Enabled: true,
		Input:   item.Input,
	}, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("WithDraft() error = %v", err)
	}
	if updated.Path != item.Path {
		t.Fatalf("path changed from %q to %q", item.Path, updated.Path)
	}
}

func TestValidateDraftRejectsInvalidProtocolSettings(t *testing.T) {
	tests := []struct {
		name  string
		draft Draft
	}{
		{
			name: "unicast multicast address",
			draft: Draft{Name: "test", Input: Input{Mode: InputRTPUnicast, RTP: &RTPInput{
				Address: "239.1.1.1", Port: 5000, SDP: "v=0\nm=video 5000 RTP/AVP 96",
			}}},
		},
		{
			name: "multicast unicast address",
			draft: Draft{Name: "test", Input: Input{Mode: InputRTPMulticast, RTP: &RTPInput{
				Address: "192.168.1.10", Port: 5000, SDP: "v=0\nm=video 5000 RTP/AVP 96",
			}}},
		},
		{
			name: "missing SDP",
			draft: Draft{Name: "test", Input: Input{Mode: InputRTPUnicast, RTP: &RTPInput{
				Address: "0.0.0.0", Port: 5000,
			}}},
		},
		{
			name:  "short SRT passphrase",
			draft: Draft{Name: "test", Input: Input{Mode: InputSRTPush, SRT: &SRTInput{Port: 10000, Passphrase: "short"}}},
		},
		{
			name:  "missing SRT push listener port",
			draft: Draft{Name: "test", Input: Input{Mode: InputSRTPush, SRT: &SRTInput{}}},
		},
		{
			name:  "missing SRT pull host",
			draft: Draft{Name: "test", Input: Input{Mode: InputSRTPull, SRT: &SRTInput{Port: 8890}}},
		},
		{
			name:  "invalid SRT elementary RTP SDP",
			draft: Draft{Name: "test", Input: Input{Mode: InputSRTPush, SRT: &SRTInput{Port: 10000, SDP: "not an SDP"}}},
		},
		{
			name:  "unsafe low SRT latency",
			draft: Draft{Name: "test", Input: Input{Mode: InputSRTPush, SRT: &SRTInput{Port: 10000, LatencyMS: MinimumSRTLatencyMS - 1}}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ValidateDraft(test.draft); err == nil {
				t.Fatal("ValidateDraft() error = nil")
			}
		})
	}
}
