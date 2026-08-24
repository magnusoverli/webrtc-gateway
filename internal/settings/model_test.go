package settings

import (
	"errors"
	"testing"
	"time"
)

func TestValidateDefaults(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	value := Defaults(now.Add(-time.Hour))
	if value.ReadTimeout != "5s" || value.WriteTimeout != "5s" || value.WriteQueueSize != 512 || value.DefaultMaxReaders != 16 {
		t.Fatalf("wired-LAN defaults = %#v", value)
	}
	value.WebRTCAdditionalHosts = []string{"192.168.1.10", "192.168.1.10", "gateway.local", "[2001:db8::1]"}
	validated, err := Validate(value, now)
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if len(validated.WebRTCAdditionalHosts) != 3 || validated.WebRTCAdditionalHosts[2] != "2001:db8::1" {
		t.Fatalf("additional hosts = %#v", validated.WebRTCAdditionalHosts)
	}
	if validated.ApplyState != ApplyPending || !validated.UpdatedAt.Equal(now) {
		t.Fatalf("unexpected validated state: %#v", validated)
	}
}

func TestValidateAppliesUnifiedMediaBinding(t *testing.T) {
	value := Defaults(time.Now())
	value.ManagementBindAddress = "127.0.0.1"
	value.MediaBindAddress = "2001:db8::10"
	validated, err := Validate(value, time.Now())
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if validated.SRTAddress != "[2001:db8::10]:8890" || validated.WebRTCLocalUDPAddress != "[2001:db8::10]:8189" || validated.WebRTCLocalTCPAddress != "[2001:db8::10]:8189" {
		t.Fatalf("listener addresses were not unified: %#v", validated)
	}
}

func TestValidatePreservesInterfaceSelectorAndListenerPorts(t *testing.T) {
	value := Defaults(time.Now())
	value.ManagementBindAddress = "interface:ipv4:eth0"
	value.MediaBindAddress = "interface:ipv4:eth0"
	validated, err := Validate(value, time.Now())
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if validated.ManagementBindAddress != value.ManagementBindAddress || validated.MediaBindAddress != value.MediaBindAddress {
		t.Fatalf("selectors changed: %#v", validated)
	}
	if validated.SRTAddress != ":8890" || validated.WebRTCLocalUDPAddress != ":8189" || validated.WebRTCLocalTCPAddress != ":8189" {
		t.Fatalf("listener ports were not preserved: %#v", validated)
	}
}

func TestValidatePreservesLegacyCustomMediaAddresses(t *testing.T) {
	value := Defaults(time.Now())
	value.MediaBindAddress = "custom"
	value.SRTAddress = "192.0.2.10:8890"
	value.WebRTCLocalUDPAddress = "192.0.2.11:8189"
	validated, err := Validate(value, time.Now())
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if validated.SRTAddress != value.SRTAddress || validated.WebRTCLocalUDPAddress != value.WebRTCLocalUDPAddress {
		t.Fatalf("custom listener addresses changed: %#v", validated)
	}
}

func TestValidateRejectsUnsafeSettings(t *testing.T) {
	tests := []struct {
		name   string
		change func(*Settings)
	}{
		{"non-power-of-two queue", func(value *Settings) { value.WriteQueueSize = 1000 }},
		{"invalid timeout", func(value *Settings) { value.ReadTimeout = "soon" }},
		{"overlapping ports", func(value *Settings) { value.RTPPortMin, value.RTPPortMax = 8000, 9000 }},
		{"bad listener", func(value *Settings) { value.SRTAddress = "localhost" }},
		{"bad management bind", func(value *Settings) { value.ManagementBindAddress = "localhost" }},
		{"bad media bind", func(value *Settings) { value.MediaBindAddress = "localhost" }},
		{"fast statistics", func(value *Settings) { value.StatisticsIntervalMS = 100 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			value := Defaults(time.Now())
			test.change(&value)
			if _, err := Validate(value, time.Now()); !errors.Is(err, ErrInvalid) {
				t.Fatalf("Validate() error = %v, want ErrInvalid", err)
			}
		})
	}
}
