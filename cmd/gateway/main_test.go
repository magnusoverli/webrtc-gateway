package main

import (
	"testing"

	"webrtc-gateway/internal/networkbind"
)

func TestManagementListenerUsesSavedBindingWithPortFromEnvironment(t *testing.T) {
	address, active, port, locked, err := managementListener(":8080", "127.0.0.1")
	if err != nil {
		t.Fatalf("managementListener() error = %v", err)
	}
	if address != "127.0.0.1:8080" || active != "127.0.0.1" || port != 8080 || locked {
		t.Fatalf("managementListener() = %q, %q, %d, %t", address, active, port, locked)
	}
}

func TestManagementListenerUsesSavedPort(t *testing.T) {
	address, active, port, locked, err := managementListenerDesired(":8080", "127.0.0.1", 9090, networkbind.Interfaces)
	if err != nil {
		t.Fatalf("managementListenerDesired() error = %v", err)
	}
	if address != "127.0.0.1:9090" || active != "127.0.0.1" || port != 9090 || locked {
		t.Fatalf("managementListenerDesired() = %q, %q, %d, %t", address, active, port, locked)
	}
}

func TestManagementListenerFollowsSavedInterface(t *testing.T) {
	address, active, port, locked, err := managementListenerWithInterfaces(
		":8080",
		"interface:ipv4:eth0",
		func() ([]networkbind.InterfaceAddress, error) {
			return []networkbind.InterfaceAddress{{Name: "eth0", Address: "192.0.2.25", Family: networkbind.IPv4}}, nil
		},
	)
	if err != nil {
		t.Fatalf("managementListenerWithInterfaces() error = %v", err)
	}
	if address != "192.0.2.25:8080" || active != "192.0.2.25" || port != 8080 || locked {
		t.Fatalf("management listener = %q, %q, %d, %t", address, active, port, locked)
	}
}

func TestManagementBindingDetectsInterfaceAddressChange(t *testing.T) {
	resolved, changed, err := managementBindingChanged(
		"interface:ipv4:eth0",
		"192.0.2.20",
		func() ([]networkbind.InterfaceAddress, error) {
			return []networkbind.InterfaceAddress{{Name: "eth0", Address: "192.0.2.25", Family: networkbind.IPv4}}, nil
		},
	)
	if err != nil || !changed || resolved != "192.0.2.25" {
		t.Fatalf("managementBindingChanged() = %q, %t, %v", resolved, changed, err)
	}
}

func TestManagementListenerHonorsExplicitEnvironmentHost(t *testing.T) {
	address, active, _, locked, err := managementListener("192.0.2.10:8080", "127.0.0.1")
	if err != nil {
		t.Fatalf("managementListener() error = %v", err)
	}
	if address != "192.0.2.10:8080" || active != "192.0.2.10" || !locked {
		t.Fatalf("managementListener() = %q, %q, locked %t", address, active, locked)
	}
}
