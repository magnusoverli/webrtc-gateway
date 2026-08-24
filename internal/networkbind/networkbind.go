package networkbind

import (
	"fmt"
	"net"
	"slices"
	"strings"
)

const (
	All             = "*"
	Custom          = "custom"
	interfacePrefix = "interface:"
	IPv4            = "IPv4"
	IPv6            = "IPv6"
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
	if strings.HasPrefix(value, interfacePrefix) {
		name, family, ok := InterfaceSelector(value)
		if !ok {
			return "", fmt.Errorf("must be All interfaces, an IP address, or an interface IPv4/IPv6 selection")
		}
		return FormatInterfaceSelector(name, family), nil
	}
	ip := net.ParseIP(strings.Trim(value, "[]"))
	if ip == nil || ip.IsUnspecified() {
		return "", fmt.Errorf("must be All interfaces, an IP address, or an interface IPv4/IPv6 selection")
	}
	return ip.String(), nil
}

func Host(value string) string {
	if value == All || value == Custom || IsInterfaceSelector(value) {
		return ""
	}
	return value
}

func FormatInterfaceSelector(name, family string) string {
	family = strings.ToLower(family)
	return interfacePrefix + family + ":" + name
}

func InterfaceSelector(value string) (name, family string, ok bool) {
	if !strings.HasPrefix(value, interfacePrefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(value, interfacePrefix)
	familyToken, name, found := strings.Cut(rest, ":")
	if !found || name == "" || strings.TrimSpace(name) != name || strings.ContainsAny(name, " \t\r\n") {
		return "", "", false
	}
	switch strings.ToLower(familyToken) {
	case "ipv4":
		return name, IPv4, true
	case "ipv6":
		return name, IPv6, true
	default:
		return "", "", false
	}
}

func IsInterfaceSelector(value string) bool {
	_, _, ok := InterfaceSelector(value)
	return ok
}

func Resolve(value string, interfaces []InterfaceAddress, allowCustom bool) (string, error) {
	normalized, err := Normalize(value, allowCustom)
	if err != nil {
		return "", err
	}
	name, family, followsInterface := InterfaceSelector(normalized)
	if !followsInterface {
		return normalized, nil
	}
	resolved := ""
	for _, item := range interfaces {
		if item.Name == name && item.Family == family {
			if resolved != "" && resolved != item.Address {
				return "", fmt.Errorf("interface %s has multiple usable %s addresses; select a fixed address", name, family)
			}
			resolved = item.Address
		}
	}
	if resolved != "" {
		return resolved, nil
	}
	return "", fmt.Errorf("interface %s has no usable %s address", name, family)
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
			key := item.Name + "\x00" + text
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			family := IPv6
			if ip.To4() != nil {
				family = IPv4
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
