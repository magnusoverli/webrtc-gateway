package project

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/networkbind"
	"webrtc-gateway/internal/settings"
)

const (
	ManifestKind  = "webrtc-gateway/project"
	SchemaVersion = 1
)

var (
	ErrNotFound         = errors.New("project not found")
	ErrInvalid          = errors.New("invalid project")
	ErrRevisionConflict = errors.New("project revision conflict")
	ErrNameConflict     = errors.New("project name already exists")
	ErrLiveNotSettled   = errors.New("live configuration is not fully applied")
	projectPathPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,79}$`)
)

type Settings struct {
	ManagementBindAddress    string   `json:"managementBindAddress"`
	ManagementPort           int      `json:"managementPort"`
	MediaBindAddress         string   `json:"mediaBindAddress"`
	LogLevel                 string   `json:"logLevel"`
	ReadTimeout              string   `json:"readTimeout"`
	WriteTimeout             string   `json:"writeTimeout"`
	WriteQueueSize           int      `json:"writeQueueSize"`
	UDPMaxPayloadSize        int      `json:"udpMaxPayloadSize"`
	UDPReadBufferSize        uint64   `json:"udpReadBufferSize"`
	SRTAddress               string   `json:"srtAddress"`
	WebRTCLocalUDPAddress    string   `json:"webRTCLocalUDPAddress"`
	WebRTCLocalTCPAddress    string   `json:"webRTCLocalTCPAddress"`
	WebRTCIPsFromInterfaces  bool     `json:"webRTCIPsFromInterfaces"`
	WebRTCAdditionalHosts    []string `json:"webRTCAdditionalHosts"`
	WebRTCHandshakeTimeout   string   `json:"webRTCHandshakeTimeout"`
	WebRTCTrackGatherTimeout string   `json:"webRTCTrackGatherTimeout"`
	RTPPortMin               int      `json:"rtpPortMin"`
	RTPPortMax               int      `json:"rtpPortMax"`
	StatisticsIntervalMS     int      `json:"statisticsIntervalMs"`
	DefaultMaxReaders        int      `json:"defaultMaxReaders"`
}

type Channel struct {
	ID                   string        `json:"id"`
	Number               int           `json:"number"`
	Name                 string        `json:"name"`
	Path                 string        `json:"path"`
	Enabled              bool          `json:"enabled"`
	AutomaticPreview     bool          `json:"automaticPreview"`
	Input                channel.Input `json:"input"`
	MaxReaders           int           `json:"maxReaders"`
	UseAbsoluteTimestamp bool          `json:"useAbsoluteTimestamp"`
}

type Configuration struct {
	Settings Settings  `json:"settings"`
	Channels []Channel `json:"channels"`
}

type Manifest struct {
	Kind          string        `json:"kind"`
	SchemaVersion int           `json:"schemaVersion"`
	Name          string        `json:"name"`
	ExportedAt    time.Time     `json:"exportedAt"`
	Configuration Configuration `json:"configuration"`
}

type Project struct {
	ID            string
	Revision      int
	Name          string
	Configuration Configuration
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type Summary struct {
	ID           string    `json:"id"`
	Revision     int       `json:"revision"`
	Name         string    `json:"name"`
	ChannelCount int       `json:"channelCount"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type LoadResult struct {
	ProjectID                 string `json:"projectId"`
	ProjectRevision           int    `json:"projectRevision"`
	ChannelCount              int    `json:"channelCount"`
	ManagementRestartRequired bool   `json:"managementRestartRequired"`
}

type LoadError struct {
	Cause       error
	RollbackErr error
}

type Environment struct {
	ManagementLocked        bool
	ActiveManagementAddress string
	ActiveManagementPort    int
	Interfaces              []networkbind.InterfaceAddress
}

func (e *LoadError) Error() string {
	if e.RollbackErr != nil {
		return fmt.Sprintf("project load failed: %v; rollback failed: %v", e.Cause, e.RollbackErr)
	}
	return fmt.Sprintf("project load failed and the previous configuration was restored: %v", e.Cause)
}

func (e *LoadError) Unwrap() error { return e.Cause }

func (p Project) Summary() Summary {
	return Summary{
		ID: p.ID, Revision: p.Revision, Name: p.Name, ChannelCount: len(p.Configuration.Channels),
		CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
	}
}

func (p Project) Manifest(now time.Time) Manifest {
	return Manifest{
		Kind: ManifestKind, SchemaVersion: SchemaVersion, Name: p.Name,
		ExportedAt: now.UTC(), Configuration: p.Configuration,
	}
}

func SettingsFrom(value settings.Settings) Settings {
	return Settings{
		ManagementBindAddress: value.ManagementBindAddress, ManagementPort: value.ManagementPort, MediaBindAddress: value.MediaBindAddress,
		LogLevel: value.LogLevel, ReadTimeout: value.ReadTimeout, WriteTimeout: value.WriteTimeout,
		WriteQueueSize: value.WriteQueueSize, UDPMaxPayloadSize: value.UDPMaxPayloadSize,
		UDPReadBufferSize: value.UDPReadBufferSize, SRTAddress: value.SRTAddress,
		WebRTCLocalUDPAddress: value.WebRTCLocalUDPAddress, WebRTCLocalTCPAddress: value.WebRTCLocalTCPAddress,
		WebRTCIPsFromInterfaces: value.WebRTCIPsFromInterfaces,
		WebRTCAdditionalHosts:   append([]string{}, value.WebRTCAdditionalHosts...),
		WebRTCHandshakeTimeout:  value.WebRTCHandshakeTimeout, WebRTCTrackGatherTimeout: value.WebRTCTrackGatherTimeout,
		RTPPortMin: value.RTPPortMin, RTPPortMax: value.RTPPortMax,
		StatisticsIntervalMS: value.StatisticsIntervalMS, DefaultMaxReaders: value.DefaultMaxReaders,
	}
}

func (value Settings) Live(now time.Time) settings.Settings {
	return settings.Settings{
		ManagementBindAddress: value.ManagementBindAddress, ManagementPort: value.ManagementPort, MediaBindAddress: value.MediaBindAddress,
		LogLevel: value.LogLevel, ReadTimeout: value.ReadTimeout, WriteTimeout: value.WriteTimeout,
		WriteQueueSize: value.WriteQueueSize, UDPMaxPayloadSize: value.UDPMaxPayloadSize,
		UDPReadBufferSize: value.UDPReadBufferSize, SRTAddress: value.SRTAddress,
		WebRTCLocalUDPAddress: value.WebRTCLocalUDPAddress, WebRTCLocalTCPAddress: value.WebRTCLocalTCPAddress,
		WebRTCIPsFromInterfaces: value.WebRTCIPsFromInterfaces,
		WebRTCAdditionalHosts:   append([]string{}, value.WebRTCAdditionalHosts...),
		WebRTCHandshakeTimeout:  value.WebRTCHandshakeTimeout, WebRTCTrackGatherTimeout: value.WebRTCTrackGatherTimeout,
		RTPPortMin: value.RTPPortMin, RTPPortMax: value.RTPPortMax,
		StatisticsIntervalMS: value.StatisticsIntervalMS, DefaultMaxReaders: value.DefaultMaxReaders,
		ApplyState: settings.ApplyPending, UpdatedAt: now.UTC(),
	}
}

func ChannelFrom(value channel.Channel) Channel {
	return Channel{
		ID: value.ID, Number: value.Number, Name: value.Name, Path: value.Path, Enabled: value.Enabled,
		AutomaticPreview: value.AutomaticPreview, Input: value.Input, MaxReaders: value.MaxReaders,
		UseAbsoluteTimestamp: value.UseAbsoluteTimestamp,
	}
}

func (value Channel) Live(revision int, now time.Time) channel.Channel {
	return channel.Channel{
		ID: value.ID, Revision: revision, Number: value.Number, Name: value.Name, Path: value.Path,
		Enabled: value.Enabled, AutomaticPreview: value.AutomaticPreview, Input: value.Input,
		MaxReaders: value.MaxReaders, UseAbsoluteTimestamp: value.UseAbsoluteTimestamp,
		ApplyState: channel.ApplyPending, CreatedAt: now.UTC(), UpdatedAt: now.UTC(),
	}
}

func ValidateManifest(value Manifest, now time.Time) (Manifest, error) {
	if value.Kind != ManifestKind {
		return Manifest{}, invalid("kind must be %q", ManifestKind)
	}
	if value.SchemaVersion != SchemaVersion {
		return Manifest{}, invalid("unsupported schemaVersion %d", value.SchemaVersion)
	}
	name, err := ValidateName(value.Name)
	if err != nil {
		return Manifest{}, err
	}
	configuration, err := ValidateConfiguration(value.Configuration, now)
	if err != nil {
		return Manifest{}, err
	}
	value.Name = name
	value.Configuration = configuration
	return value, nil
}

func ValidateName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 80 {
		return "", invalid("name must contain between 1 and 80 characters")
	}
	return value, nil
}

func ValidateConfiguration(value Configuration, now time.Time) (Configuration, error) {
	validatedSettings, err := settings.Validate(value.Settings.Live(now), now)
	if err != nil {
		return Configuration{}, invalid("settings: %v", err)
	}
	value.Settings = SettingsFrom(validatedSettings)

	ids := make(map[string]bool, len(value.Channels))
	numbers := make(map[int]bool, len(value.Channels))
	paths := make(map[string]bool, len(value.Channels))
	ports := make(map[int]string, len(value.Channels))
	for index := range value.Channels {
		item := &value.Channels[index]
		if !canonicalID(item.ID) {
			return Configuration{}, invalid("channel %d has an invalid ID", index+1)
		}
		if item.Number < 1 {
			return Configuration{}, invalid("channel %s has a non-positive number", item.Name)
		}
		if !projectPathPattern.MatchString(item.Path) {
			return Configuration{}, invalid("channel %s has an invalid path", item.Name)
		}
		if ids[item.ID] || numbers[item.Number] || paths[item.Path] {
			return Configuration{}, invalid("channel identities must be unique")
		}
		ids[item.ID], numbers[item.Number], paths[item.Path] = true, true, true
		draft, draftErr := channel.ValidateDraft(channel.Draft{
			Name: item.Name, Enabled: item.Enabled, AutomaticPreview: item.AutomaticPreview,
			Input: item.Input, MaxReaders: item.MaxReaders, UseAbsoluteTimestamp: item.UseAbsoluteTimestamp,
		})
		if draftErr != nil {
			return Configuration{}, invalid("channel %s: %v", item.Name, draftErr)
		}
		item.Name, item.Input = draft.Name, draft.Input
		port := 0
		if item.Input.RTP != nil {
			port = item.Input.RTP.Port
			if port < value.Settings.RTPPortMin || port > value.Settings.RTPPortMax {
				return Configuration{}, invalid("RTP port %d used by %s is outside the configured range", port, item.Name)
			}
		} else if item.Input.Mode == channel.InputSRTPush && item.Input.SRT != nil {
			port = item.Input.SRT.Port
			if port >= value.Settings.RTPPortMin && port <= value.Settings.RTPPortMax {
				return Configuration{}, invalid("SRT listener port %d used by %s is inside the RTP range", port, item.Name)
			}
			if port == listenerPort(value.Settings.SRTAddress) || port == listenerPort(value.Settings.WebRTCLocalUDPAddress) {
				return Configuration{}, invalid("SRT listener port %d used by %s conflicts with a global listener", port, item.Name)
			}
		}
		if existing := ports[port]; port > 0 && existing != "" {
			return Configuration{}, invalid("UDP port %d is assigned to both %s and %s", port, existing, item.Name)
		}
		if port > 0 {
			ports[port] = item.Name
		}
	}
	return value, nil
}

func ValidateEnvironment(value Configuration, environment Environment) error {
	settingsValue := value.Settings.Live(time.Now())
	desiredManagement := environment.ActiveManagementAddress
	desiredPort := environment.ActiveManagementPort
	if !environment.ManagementLocked {
		var err error
		desiredManagement, err = networkbind.Resolve(settingsValue.ManagementBindAddress, environment.Interfaces, false)
		if err != nil {
			return fmt.Errorf("management binding: %w", err)
		}
		desiredPort = settingsValue.ManagementPort
	}
	effective, resolvedMedia, _, err := settings.ResolveMedia(settingsValue, environment.Interfaces)
	if err != nil {
		return fmt.Errorf("media binding: %w", err)
	}
	webRTCPort := listenerPort(effective.WebRTCLocalTCPAddress)
	mediaBinding := resolvedMedia
	if mediaBinding == networkbind.Custom && webRTCPort > 0 {
		mediaBinding, err = networkbind.FromListenerAddress(effective.WebRTCLocalTCPAddress)
		if err != nil {
			return fmt.Errorf("WebRTC TCP binding: %w", err)
		}
	}
	if webRTCPort > 0 && webRTCPort == environment.ActiveManagementPort && bindingsOverlap(environment.ActiveManagementAddress, mediaBinding) {
		return fmt.Errorf("WebRTC TCP fallback cannot use the active management listener port on the same interface")
	}
	if webRTCPort > 0 && webRTCPort == desiredPort && bindingsOverlap(desiredManagement, mediaBinding) {
		return fmt.Errorf("WebRTC TCP fallback cannot use the desired management listener port on the same interface")
	}
	return nil
}

func canonicalID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}

func listenerPort(address string) int {
	_, portText, err := net.SplitHostPort(address)
	if err != nil {
		return 0
	}
	var port int
	if _, err := fmt.Sscanf(portText, "%d", &port); err == nil {
		return port
	}
	return 0
}

func bindingsOverlap(left, right string) bool {
	return left != "" && right != "" && (left == networkbind.All || right == networkbind.All || left == right)
}

func invalid(format string, values ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, values...))
}
