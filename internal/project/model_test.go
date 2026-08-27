package project

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/networkbind"
	"webrtc-gateway/internal/settings"
)

func TestManifestRoundTripPreservesSecretsAndIdentity(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	configuration := validConfiguration(now)
	configuration.Channels[0].Input.SRT.Passphrase = "secret-passphrase"
	manifest, err := ValidateManifest(Manifest{
		Kind: ManifestKind, SchemaVersion: SchemaVersion, Name: " Studio ", Configuration: configuration,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	item := manifest.Configuration.Channels[0]
	if manifest.Name != "Studio" || item.ID != "12345678-1234-4234-8234-123456789abc" || item.Number != 1 || item.Path != "studio-12345678" {
		t.Fatalf("identity was not preserved: %+v", item)
	}
	if item.Input.SRT.Passphrase != "secret-passphrase" {
		t.Fatal("SRT passphrase was not preserved")
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"webRTCAdditionalHosts":null`) || !strings.Contains(string(encoded), `"webRTCAdditionalHosts":[]`) {
		t.Fatalf("empty WebRTC hosts must remain an array: %s", encoded)
	}
}

func TestValidateConfigurationRejectsCrossChannelPortConflict(t *testing.T) {
	now := time.Now()
	value := validConfiguration(now)
	second := value.Channels[0]
	second.ID = "22345678-1234-4234-8234-123456789abc"
	second.Number = 2
	second.Name = "Second"
	second.Path = "second-22345678"
	value.Channels = append(value.Channels, second)
	_, err := ValidateConfiguration(value, now)
	if err == nil || !strings.Contains(err.Error(), "assigned to both") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateManifestRejectsUnknownVersion(t *testing.T) {
	value := Manifest{Kind: ManifestKind, SchemaVersion: 2, Name: "Studio", Configuration: validConfiguration(time.Now())}
	if _, err := ValidateManifest(value, time.Now()); err == nil || !strings.Contains(err.Error(), "unsupported schemaVersion") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateEnvironmentRejectsUnavailableManagementInterface(t *testing.T) {
	value := validConfiguration(time.Now())
	value.Settings.ManagementBindAddress = "interface:ipv4:missing0"
	err := ValidateEnvironment(value, Environment{
		ActiveManagementAddress: networkbind.All, ActiveManagementPort: 8080,
		Interfaces: []networkbind.InterfaceAddress{{Name: "eth0", Address: "192.0.2.10", Family: networkbind.IPv4}},
	})
	if err == nil || !strings.Contains(err.Error(), "missing0") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateEnvironmentRejectsDesiredManagementWebRTCCollision(t *testing.T) {
	value := validConfiguration(time.Now())
	value.Settings.ManagementPort = 8189
	err := ValidateEnvironment(value, Environment{ActiveManagementAddress: networkbind.All, ActiveManagementPort: 8080})
	if err == nil || !strings.Contains(err.Error(), "desired management listener port") {
		t.Fatalf("error = %v", err)
	}
}

func validConfiguration(now time.Time) Configuration {
	global := settings.Defaults(now)
	return Configuration{
		Settings: SettingsFrom(global),
		Channels: []Channel{{
			ID: "12345678-1234-4234-8234-123456789abc", Number: 1, Name: "Studio", Path: "studio-12345678",
			Enabled: true, AutomaticPreview: true, MaxReaders: 16, UseAbsoluteTimestamp: true,
			Input: channel.Input{Mode: channel.InputSRTPush, SRT: &channel.SRTInput{Port: 10000, LatencyMS: 20}},
		}},
	}
}
