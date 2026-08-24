package settings

import (
	"testing"
	"time"

	"webrtc-gateway/internal/networkbind"
)

func TestResolveMediaFollowsSelectedInterface(t *testing.T) {
	value := Defaults(time.Now())
	value.MediaBindAddress = "interface:ipv4:eth0"
	interfaces := []networkbind.InterfaceAddress{
		{Name: "eth0", Address: "192.0.2.20", Family: networkbind.IPv4},
		{Name: "docker0", Address: "172.17.0.1", Family: networkbind.IPv4},
	}
	effective, resolved, interfaceList, err := ResolveMedia(value, interfaces)
	if err != nil {
		t.Fatalf("ResolveMedia() error = %v", err)
	}
	if resolved != "192.0.2.20" || effective.SRTAddress != "192.0.2.20:8890" || effective.WebRTCLocalUDPAddress != "192.0.2.20:8189" {
		t.Fatalf("effective media settings = %#v, resolved %q", effective, resolved)
	}
	if len(interfaceList) != 1 || interfaceList[0] != "eth0" {
		t.Fatalf("interface list = %#v", interfaceList)
	}
}

func TestResolveMediaPreservesFixedAndWildcardBindings(t *testing.T) {
	for _, binding := range []string{"*", "192.0.2.20"} {
		value := Defaults(time.Now())
		value.MediaBindAddress = binding
		effective, resolved, interfaceList, err := ResolveMedia(value, nil)
		if err != nil {
			t.Fatalf("ResolveMedia(%q) error = %v", binding, err)
		}
		if resolved != binding || len(interfaceList) != 0 {
			t.Fatalf("ResolveMedia(%q) = resolved %q, interfaces %#v", binding, resolved, interfaceList)
		}
		if binding == "*" && effective.SRTAddress != ":8890" {
			t.Fatalf("wildcard SRT address = %q", effective.SRTAddress)
		}
	}
}
