package settings

import (
	"net"
	"strconv"

	"webrtc-gateway/internal/networkbind"
)

func ResolveMedia(value Settings, interfaces []networkbind.InterfaceAddress) (Settings, string, []string, error) {
	resolved, err := networkbind.Resolve(value.MediaBindAddress, interfaces, true)
	if err != nil {
		return Settings{}, "", nil, err
	}
	effective := value
	effective.MediaBindAddress = resolved
	if resolved != networkbind.Custom {
		srtPort, _ := listenerPort("srtAddress", value.SRTAddress, false)
		udpPort, _ := listenerPort("webRTCLocalUDPAddress", value.WebRTCLocalUDPAddress, false)
		tcpPort, _ := listenerPort("webRTCLocalTCPAddress", value.WebRTCLocalTCPAddress, true)
		host := networkbind.Host(resolved)
		effective.SRTAddress = net.JoinHostPort(host, strconv.Itoa(srtPort))
		effective.WebRTCLocalUDPAddress = net.JoinHostPort(host, strconv.Itoa(udpPort))
		if tcpPort > 0 {
			effective.WebRTCLocalTCPAddress = net.JoinHostPort(host, strconv.Itoa(tcpPort))
		} else {
			effective.WebRTCLocalTCPAddress = ""
		}
	}

	interfaceList := []string{}
	if name, _, ok := networkbind.InterfaceSelector(value.MediaBindAddress); ok {
		interfaceList = []string{name}
	}
	return effective, resolved, interfaceList, nil
}
