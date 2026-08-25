package settings

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"webrtc-gateway/internal/networkbind"
)

type ApplyState string

const (
	ApplyPending ApplyState = "pending"
	ApplyApplied ApplyState = "applied"
	ApplyError   ApplyState = "error"
)

var ErrInvalid = errors.New("invalid settings")
var ErrRevisionConflict = errors.New("settings revision conflict")

type Settings struct {
	Revision                 int        `json:"revision"`
	ManagementBindAddress    string     `json:"managementBindAddress"`
	MediaBindAddress         string     `json:"mediaBindAddress"`
	LogLevel                 string     `json:"logLevel"`
	ReadTimeout              string     `json:"readTimeout"`
	WriteTimeout             string     `json:"writeTimeout"`
	WriteQueueSize           int        `json:"writeQueueSize"`
	UDPMaxPayloadSize        int        `json:"udpMaxPayloadSize"`
	UDPReadBufferSize        uint64     `json:"udpReadBufferSize"`
	SRTAddress               string     `json:"srtAddress"`
	WebRTCLocalUDPAddress    string     `json:"webRTCLocalUDPAddress"`
	WebRTCLocalTCPAddress    string     `json:"webRTCLocalTCPAddress"`
	WebRTCIPsFromInterfaces  bool       `json:"webRTCIPsFromInterfaces"`
	WebRTCAdditionalHosts    []string   `json:"webRTCAdditionalHosts"`
	WebRTCHandshakeTimeout   string     `json:"webRTCHandshakeTimeout"`
	WebRTCTrackGatherTimeout string     `json:"webRTCTrackGatherTimeout"`
	RTPPortMin               int        `json:"rtpPortMin"`
	RTPPortMax               int        `json:"rtpPortMax"`
	StatisticsIntervalMS     int        `json:"statisticsIntervalMs"`
	DefaultMaxReaders        int        `json:"defaultMaxReaders"`
	ApplyState               ApplyState `json:"applyState"`
	ApplyError               string     `json:"applyError,omitempty"`
	UpdatedAt                time.Time  `json:"updatedAt"`
}

func Defaults(now time.Time) Settings {
	return Settings{
		Revision:                 1,
		ManagementBindAddress:    networkbind.All,
		MediaBindAddress:         networkbind.All,
		LogLevel:                 "info",
		ReadTimeout:              "5s",
		WriteTimeout:             "5s",
		WriteQueueSize:           512,
		UDPMaxPayloadSize:        1452,
		UDPReadBufferSize:        4194304,
		SRTAddress:               ":8890",
		WebRTCLocalUDPAddress:    ":8189",
		WebRTCLocalTCPAddress:    ":8189",
		WebRTCIPsFromInterfaces:  true,
		WebRTCAdditionalHosts:    []string{},
		WebRTCHandshakeTimeout:   "10s",
		WebRTCTrackGatherTimeout: "2s",
		RTPPortMin:               22000,
		RTPPortMax:               22999,
		StatisticsIntervalMS:     2000,
		DefaultMaxReaders:        16,
		ApplyState:               ApplyPending,
		UpdatedAt:                now.UTC(),
	}
}

func Validate(value Settings, now time.Time) (Settings, error) {
	managementBind, err := networkbind.Normalize(value.ManagementBindAddress, false)
	if err != nil {
		return Settings{}, invalid("managementBindAddress " + err.Error())
	}
	mediaBind, err := networkbind.Normalize(value.MediaBindAddress, true)
	if err != nil {
		return Settings{}, invalid("mediaBindAddress " + err.Error())
	}
	value.ManagementBindAddress = managementBind
	value.MediaBindAddress = mediaBind

	value.LogLevel = strings.ToLower(strings.TrimSpace(value.LogLevel))
	switch value.LogLevel {
	case "error", "warn", "info", "debug":
	default:
		return Settings{}, invalid("logLevel must be error, warn, info, or debug")
	}
	if err := positiveDuration("readTimeout", value.ReadTimeout); err != nil {
		return Settings{}, err
	}
	if err := positiveDuration("writeTimeout", value.WriteTimeout); err != nil {
		return Settings{}, err
	}
	if err := positiveDuration("webRTCHandshakeTimeout", value.WebRTCHandshakeTimeout); err != nil {
		return Settings{}, err
	}
	if err := positiveDuration("webRTCTrackGatherTimeout", value.WebRTCTrackGatherTimeout); err != nil {
		return Settings{}, err
	}
	if value.WriteQueueSize < 1 || value.WriteQueueSize&(value.WriteQueueSize-1) != 0 {
		return Settings{}, invalid("writeQueueSize must be a positive power of two")
	}
	if value.UDPMaxPayloadSize < 576 || value.UDPMaxPayloadSize > 65507 {
		return Settings{}, invalid("udpMaxPayloadSize must be between 576 and 65507")
	}
	if value.UDPReadBufferSize > 1<<30 {
		return Settings{}, invalid("udpReadBufferSize cannot exceed 1 GiB")
	}

	srtPort, err := listenerPort("srtAddress", value.SRTAddress, false)
	if err != nil {
		return Settings{}, err
	}
	webrtcUDPPort, err := listenerPort("webRTCLocalUDPAddress", value.WebRTCLocalUDPAddress, false)
	if err != nil {
		return Settings{}, err
	}
	webrtcTCPPort, err := listenerPort("webRTCLocalTCPAddress", value.WebRTCLocalTCPAddress, true)
	if err != nil {
		return Settings{}, err
	}
	if srtPort == webrtcUDPPort {
		return Settings{}, invalid("SRT and WebRTC UDP listeners must use different ports")
	}
	if mediaBind != networkbind.Custom {
		host := networkbind.Host(mediaBind)
		value.SRTAddress = net.JoinHostPort(host, strconv.Itoa(srtPort))
		value.WebRTCLocalUDPAddress = net.JoinHostPort(host, strconv.Itoa(webrtcUDPPort))
		if webrtcTCPPort > 0 {
			value.WebRTCLocalTCPAddress = net.JoinHostPort(host, strconv.Itoa(webrtcTCPPort))
		}
	}

	seenHosts := make(map[string]struct{}, len(value.WebRTCAdditionalHosts))
	hosts := make([]string, 0, len(value.WebRTCAdditionalHosts))
	for _, host := range value.WebRTCAdditionalHosts {
		host = strings.TrimSpace(host)
		if host == "" {
			continue
		}
		if strings.ContainsAny(host, " /\t\r\n") {
			return Settings{}, invalid("webRTCAdditionalHosts entries must be hostnames or IP addresses")
		}
		if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
			host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
		}
		if net.ParseIP(host) == nil {
			parsed, err := url.Parse("//" + host)
			if err != nil || parsed.Hostname() != host || parsed.Port() != "" {
				return Settings{}, invalid("webRTCAdditionalHosts contains an invalid host")
			}
		}
		if _, exists := seenHosts[host]; exists {
			continue
		}
		seenHosts[host] = struct{}{}
		hosts = append(hosts, host)
	}
	value.WebRTCAdditionalHosts = hosts

	if value.RTPPortMin < 1 || value.RTPPortMax > 65535 || value.RTPPortMin > value.RTPPortMax {
		return Settings{}, invalid("RTP port range must be ordered and between 1 and 65535")
	}
	if portInRange(srtPort, value.RTPPortMin, value.RTPPortMax) || portInRange(webrtcUDPPort, value.RTPPortMin, value.RTPPortMax) {
		return Settings{}, invalid("RTP port range cannot include the SRT or WebRTC UDP listener port")
	}
	if value.StatisticsIntervalMS < 500 || value.StatisticsIntervalMS > 10000 {
		return Settings{}, invalid("statisticsIntervalMs must be between 500 and 10000")
	}
	if value.DefaultMaxReaders < 0 {
		return Settings{}, invalid("defaultMaxReaders must be zero or greater")
	}

	value.ApplyState = ApplyPending
	value.ApplyError = ""
	value.UpdatedAt = now.UTC()
	return value, nil
}

func positiveDuration(name, value string) error {
	duration, err := time.ParseDuration(strings.TrimSpace(value))
	if err != nil || duration <= 0 {
		return invalid(name + " must be a positive duration such as 10s")
	}
	return nil
}

func listenerPort(name, value string, allowEmpty bool) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" && allowEmpty {
		return 0, nil
	}
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return 0, invalid(name + " must be an address such as :8890 or 192.168.1.10:8890")
	}
	if host != "" && net.ParseIP(host) == nil {
		return 0, invalid(name + " host must be an IP address")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return 0, invalid(name + " port must be between 1 and 65535")
	}
	return port, nil
}

func portInRange(port, minimum, maximum int) bool {
	return port >= minimum && port <= maximum
}

func invalid(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalid, message)
}
