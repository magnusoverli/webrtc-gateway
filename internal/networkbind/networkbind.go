package networkbind

import (
	"fmt"
	"net"
	"slices"
	"strings"
)

const (
	All    = "*"
	Custom = "custom"
)

type InterfaceAddress struct {
	Name     string `json:"name"`
	Address  string `json:"address"`
	Family   string `json:"family"`
	Loopback bool   `json:"loopback"`
}

func Normalize(value string, allowCustom bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == All || value == "0.0.0.0" || value == "::" {
		return All, nil
	}
	if allowCustom && value == Custom {
		return Custom, nil
	}
	ip := net.ParseIP(strings.Trim(value, "[]"))
	if ip == nil || ip.IsUnspecified() {
		return "", fmt.Errorf("must be All interfaces or an IP address")
	}
	return ip.String(), nil
}

func Host(value string) string {
	if value == All || value == Custom {
		return ""
	}
	return value
}

func FromListenerAddress(value string) (string, error) {
	host, _, err := net.SplitHostPort(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return Normalize(host, false)
}

func LegacyMediaBinding(addresses ...string) string {
	selected := ""
	for _, address := range addresses {
		if strings.TrimSpace(address) == "" {
			continue
		}
		binding, err := FromListenerAddress(address)
		if err != nil {
			return Custom
		}
		if selected != "" && selected != binding {
			return Custom
		}
		selected = binding
	}
	if selected == "" {
		return All
	}
	return selected
}

func Interfaces() ([]InterfaceAddress, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("list network interfaces: %w", err)
	}
	result := make([]InterfaceAddress, 0)
	seen := make(map[string]struct{})
	for _, item := range interfaces {
		if item.Flags&net.FlagUp == 0 {
			continue
		}
		addresses, err := item.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err != nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() {
				continue
			}
			text := ip.String()
			if _, exists := seen[text]; exists {
				continue
			}
			seen[text] = struct{}{}
			family := "IPv6"
			if ip.To4() != nil {
				family = "IPv4"
			}
			result = append(result, InterfaceAddress{
				Name: item.Name, Address: text, Family: family, Loopback: item.Flags&net.FlagLoopback != 0,
			})
		}
	}
	slices.SortFunc(result, func(left, right InterfaceAddress) int {
		if left.Loopback != right.Loopback {
			if left.Loopback {
				return 1
			}
			return -1
		}
		if compared := strings.Compare(left.Name, right.Name); compared != 0 {
			return compared
		}
		return strings.Compare(left.Address, right.Address)
	})
	return result, nil
}
