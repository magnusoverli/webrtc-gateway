package networkbind

import "testing"

func TestNormalizeAndLegacyMediaBinding(t *testing.T) {
	for _, value := range []string{"", "*", "0.0.0.0", "::"} {
		if normalized, err := Normalize(value, false); err != nil || normalized != All {
			t.Fatalf("Normalize(%q) = %q, %v", value, normalized, err)
		}
	}
	if normalized, err := Normalize("[2001:db8::1]", false); err != nil || normalized != "2001:db8::1" {
		t.Fatalf("Normalize(IPv6) = %q, %v", normalized, err)
	}
	if got := LegacyMediaBinding("192.0.2.10:8890", "192.0.2.10:8189", ""); got != "192.0.2.10" {
		t.Fatalf("LegacyMediaBinding() = %q", got)
	}
	if got := LegacyMediaBinding(":8890", "192.0.2.10:8189"); got != Custom {
		t.Fatalf("mixed LegacyMediaBinding() = %q", got)
	}
}

func TestInterfacesReturnsUsableAddresses(t *testing.T) {
	addresses, err := Interfaces()
	if err != nil {
		t.Fatalf("Interfaces() error = %v", err)
	}
	for _, item := range addresses {
		if item.Name == "" || item.Address == "" || (item.Family != "IPv4" && item.Family != "IPv6") {
			t.Fatalf("invalid interface address: %#v", item)
		}
	}
}
