package channel

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"
)

type InputMode string

const (
	InputRTPUnicast   InputMode = "rtp-unicast"
	InputRTPMulticast InputMode = "rtp-multicast"
	InputSRTPush      InputMode = "srt-push"
	InputSRTPull      InputMode = "srt-pull"

	DefaultSRTLatencyMS = 60
	MinimumSRTLatencyMS = 20
	MaximumSRTLatencyMS = 8000
)

type ApplyState string

const (
	ApplyPending ApplyState = "pending"
	ApplyApplied ApplyState = "applied"
	ApplyError   ApplyState = "error"
)

type RTPInput struct {
	Address   string `json:"address"`
	Port      int    `json:"port"`
	Interface string `json:"interface,omitempty"`
	SourceIP  string `json:"sourceIp,omitempty"`
	SDP       string `json:"sdp"`
}

type SRTInput struct {
	Host       string `json:"host,omitempty"`
	Port       int    `json:"port,omitempty"`
	StreamID   string `json:"streamId,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
	LatencyMS  int    `json:"latencyMs,omitempty"`
	SDP        string `json:"sdp,omitempty"`
}

type Input struct {
	Mode InputMode `json:"mode"`
	RTP  *RTPInput `json:"rtp,omitempty"`
	SRT  *SRTInput `json:"srt,omitempty"`
}

type Channel struct {
	ID                   string     `json:"id"`
	Name                 string     `json:"name"`
	Path                 string     `json:"path"`
	Enabled              bool       `json:"enabled"`
	AutomaticPreview     bool       `json:"automaticPreview"`
	Input                Input      `json:"input"`
	MaxReaders           int        `json:"maxReaders"`
	UseAbsoluteTimestamp bool       `json:"useAbsoluteTimestamp"`
	ApplyState           ApplyState `json:"applyState"`
	ApplyError           string     `json:"applyError,omitempty"`
	CreatedAt            time.Time  `json:"createdAt"`
	UpdatedAt            time.Time  `json:"updatedAt"`
}

type Draft struct {
	Name                 string
	Enabled              bool
	AutomaticPreview     bool
	Input                Input
	MaxReaders           int
	UseAbsoluteTimestamp bool
}

var pathCleaner = regexp.MustCompile(`[^a-z0-9]+`)
var ErrInvalid = errors.New("invalid channel")

func New(draft Draft, now time.Time) (Channel, error) {
	draft, err := ValidateDraft(draft)
	if err != nil {
		return Channel{}, err
	}

	id, err := newID()
	if err != nil {
		return Channel{}, fmt.Errorf("generate channel ID: %w", err)
	}

	return Channel{
		ID:                   id,
		Name:                 draft.Name,
		Path:                 pathFor(draft.Name, id),
		Enabled:              draft.Enabled,
		AutomaticPreview:     draft.AutomaticPreview,
		Input:                draft.Input,
		MaxReaders:           draft.MaxReaders,
		UseAbsoluteTimestamp: draft.UseAbsoluteTimestamp,
		ApplyState:           ApplyPending,
		CreatedAt:            now.UTC(),
		UpdatedAt:            now.UTC(),
	}, nil
}

func (c Channel) WithDraft(draft Draft, now time.Time) (Channel, error) {
	draft, err := ValidateDraft(draft)
	if err != nil {
		return Channel{}, err
	}

	c.Name = draft.Name
	c.Enabled = draft.Enabled
	c.AutomaticPreview = draft.AutomaticPreview
	c.Input = draft.Input
	c.MaxReaders = draft.MaxReaders
	c.UseAbsoluteTimestamp = draft.UseAbsoluteTimestamp
	c.ApplyState = ApplyPending
	c.ApplyError = ""
	c.UpdatedAt = now.UTC()
	return c, nil
}

func ValidateDraft(draft Draft) (Draft, error) {
	draft.Name = strings.TrimSpace(draft.Name)
	if draft.Name == "" || len(draft.Name) > 80 {
		return Draft{}, invalid("name must contain between 1 and 80 characters")
	}
	if draft.MaxReaders < 0 {
		return Draft{}, invalid("maxReaders must be zero or greater")
	}

	switch draft.Input.Mode {
	case InputRTPUnicast, InputRTPMulticast:
		if draft.Input.RTP == nil || draft.Input.SRT != nil {
			return Draft{}, invalid("RTP input settings are required only for an RTP mode")
		}
		rtp := *draft.Input.RTP
		rtp.Address = strings.TrimSpace(rtp.Address)
		rtp.Interface = strings.TrimSpace(rtp.Interface)
		rtp.SourceIP = strings.TrimSpace(rtp.SourceIP)
		rtp.SDP = strings.TrimSpace(rtp.SDP)
		if rtp.Port < 1 || rtp.Port > 65535 {
			return Draft{}, invalid("RTP port must be between 1 and 65535")
		}
		address := net.ParseIP(rtp.Address)
		if address == nil {
			return Draft{}, invalid("RTP address must be an IP address")
		}
		if draft.Input.Mode == InputRTPMulticast && !address.IsMulticast() {
			return Draft{}, invalid("RTP multicast address must be multicast")
		}
		if draft.Input.Mode == InputRTPUnicast && address.IsMulticast() {
			return Draft{}, invalid("RTP unicast address cannot be multicast")
		}
		if rtp.SourceIP != "" && net.ParseIP(rtp.SourceIP) == nil {
			return Draft{}, invalid("RTP sourceIp must be an IP address")
		}
		if !strings.Contains(rtp.SDP, "v=") || !strings.Contains(rtp.SDP, "m=") {
			return Draft{}, invalid("RTP SDP must contain session and media descriptions")
		}
		draft.Input.RTP = &rtp

	case InputSRTPush, InputSRTPull:
		if draft.Input.SRT == nil || draft.Input.RTP != nil {
			return Draft{}, invalid("SRT input settings are required only for an SRT mode")
		}
		srt := *draft.Input.SRT
		srt.Host = strings.TrimSpace(srt.Host)
		srt.StreamID = strings.TrimSpace(srt.StreamID)
		srt.SDP = strings.TrimSpace(srt.SDP)
		if srt.Passphrase != "" && (len(srt.Passphrase) < 10 || len(srt.Passphrase) > 79) {
			return Draft{}, invalid("SRT passphrase must contain between 10 and 79 bytes")
		}
		if srt.LatencyMS == 0 {
			srt.LatencyMS = DefaultSRTLatencyMS
		}
		if srt.LatencyMS < MinimumSRTLatencyMS || srt.LatencyMS > MaximumSRTLatencyMS {
			return Draft{}, invalid("SRT latencyMs must be between 20 and 8000")
		}
		if len(srt.SDP) > 64*1024 {
			return Draft{}, invalid("SRT RTP SDP must not exceed 64 KiB")
		}
		if srt.SDP != "" && (!strings.Contains(srt.SDP, "v=") || !strings.Contains(srt.SDP, "m=")) {
			return Draft{}, invalid("SRT RTP SDP must contain session and media descriptions")
		}
		if draft.Input.Mode == InputSRTPush {
			if srt.Port < 1024 || srt.Port > 65535 {
				return Draft{}, invalid("SRT push listener port must be between 1024 and 65535")
			}
			if strings.ContainsAny(srt.Passphrase, "&?#") {
				return Draft{}, invalid("SRT push passphrase cannot contain &, ?, or #")
			}
		} else {
			if srt.Host == "" {
				return Draft{}, invalid("SRT pull host is required")
			}
			if srt.Port < 1 || srt.Port > 65535 {
				return Draft{}, invalid("SRT pull port must be between 1 and 65535")
			}
		}
		draft.Input.SRT = &srt

	default:
		return Draft{}, fmt.Errorf("%w: unsupported input mode %q", ErrInvalid, draft.Input.Mode)
	}

	return draft, nil
}

func invalid(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalid, message)
}

func newID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

func pathFor(name, id string) string {
	slug := strings.Trim(pathCleaner.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if slug == "" {
		slug = "channel"
	}
	if len(slug) > 40 {
		slug = strings.Trim(slug[:40], "-")
	}
	return slug + "-" + strings.ReplaceAll(id, "-", "")[:8]
}
