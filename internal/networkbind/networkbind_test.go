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
	if normalized, err := Normalize("interface:IPV4:wlan0", false); err != nil || normalized != "interface:ipv4:wlan0" {
		t.Fatalf("Normalize(interface) = %q, %v", normalized, err)
	}
	if got := LegacyMediaBinding("192.0.2.10:8890", "192.0.2.10:8189", ""); got != "192.0.2.10" {
		t.Fatalf("LegacyMediaBinding() = %q", got)
	}
	if got := LegacyMediaBinding(":8890", "192.0.2.10:8189"); got != Custom {
		t.Fatalf("mixed LegacyMediaBinding() = %q", got)
	}
}

func TestResolveInterfaceSelector(t *testing.T) {
	interfaces := []InterfaceAddress{
		{Name: "eth0", Address: "192.0.2.20", Family: IPv4},
		{Name: "eth0", Address: "2001:db8::20", Family: IPv6},
		{Name: "eth1", Address: "192.0.2.30", Family: IPv4},
	}
	resolved, err := Resolve("interface:ipv4:eth0", interfaces, false)
	if err != nil || resolved != "192.0.2.20" {
		t.Fatalf("Resolve(IPv4) = %q, %v", resolved, err)
	}
	resolved, err = Resolve("interface:ipv6:eth0", interfaces, false)
	if err != nil || resolved != "2001:db8::20" {
		t.Fatalf("Resolve(IPv6) = %q, %v", resolved, err)
	}
	if _, err := Resolve("interface:ipv6:eth1", interfaces, false); err == nil {
		t.Fatal("Resolve(missing family) error = nil")
	}
	if _, err := Resolve("interface:ipv4:eth0", append(interfaces,
		InterfaceAddress{Name: "eth0", Address: "192.0.2.21", Family: IPv4}), false); err == nil {
		t.Fatal("Resolve(ambiguous family) error = nil")
	}
	if Host("interface:ipv4:eth0") != "" {
		t.Fatal("Host(interface selector) must not expose the selector as a socket address")
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
