package main

import "testing"

func TestManagementListenerUsesSavedBindingWithPortFromEnvironment(t *testing.T) {
	address, active, port, locked, err := managementListener(":8080", "127.0.0.1")
	if err != nil {
		t.Fatalf("managementListener() error = %v", err)
	}
	if address != "127.0.0.1:8080" || active != "127.0.0.1" || port != 8080 || locked {
		t.Fatalf("managementListener() = %q, %q, %d, %t", address, active, port, locked)
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
