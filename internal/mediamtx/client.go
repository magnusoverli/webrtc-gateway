package mediamtx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"time"
)

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client
}

type Info struct {
	Started string `json:"started"`
	Version string `json:"version"`
}

type PathConfig struct {
	Name                 string `json:"name,omitempty"`
	Source               string `json:"source"`
	RTPSDP               string `json:"rtpSDP,omitempty"`
	MaxReaders           int    `json:"maxReaders"`
	UseAbsoluteTimestamp bool   `json:"useAbsoluteTimestamp"`
	SRTPublishPassphrase string `json:"srtPublishPassphrase,omitempty"`
}

type GlobalConfig struct {
	LogLevel                 string   `json:"logLevel"`
	ReadTimeout              string   `json:"readTimeout"`
	WriteTimeout             string   `json:"writeTimeout"`
	WriteQueueSize           int      `json:"writeQueueSize"`
	UDPMaxPayloadSize        int      `json:"udpMaxPayloadSize"`
	UDPReadBufferSize        uint64   `json:"udpReadBufferSize"`
	SRTAddress               string   `json:"srtAddress"`
	WebRTCLocalUDPAddress    string   `json:"webrtcLocalUDPAddress"`
	WebRTCLocalTCPAddress    string   `json:"webrtcLocalTCPAddress"`
	WebRTCIPsFromInterfaces  bool     `json:"webrtcIPsFromInterfaces"`
	WebRTCAdditionalHosts    []string `json:"webrtcAdditionalHosts"`
	WebRTCHandshakeTimeout   string   `json:"webrtcHandshakeTimeout"`
	WebRTCTrackGatherTimeout string   `json:"webrtcTrackGatherTimeout"`
}

type PathConfigList struct {
	Items []PathConfig `json:"items"`
}

type PathSource struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type PathReader struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type Track struct {
	Codec      string         `json:"codec"`
	CodecProps map[string]any `json:"codecProps,omitempty"`
}

type Path struct {
	Name                 string       `json:"name"`
	ConfName             string       `json:"confName"`
	Available            bool         `json:"available"`
	AvailableTime        *string      `json:"availableTime"`
	Online               bool         `json:"online"`
	OnlineTime           *string      `json:"onlineTime"`
	InboundBytes         uint64       `json:"inboundBytes"`
	OutboundBytes        uint64       `json:"outboundBytes"`
	InboundFramesInError uint64       `json:"inboundFramesInError"`
	Source               *PathSource  `json:"source"`
	Readers              []PathReader `json:"readers"`
	Tracks               []Track      `json:"tracks2"`
}

type PathList struct {
	Items []Path `json:"items"`
}

type Channel struct {
	Name                 string       `json:"name"`
	ConfiguredSource     string       `json:"configuredSource"`
	Available            bool         `json:"available"`
	AvailableTime        *string      `json:"availableTime,omitempty"`
	Online               bool         `json:"online"`
	OnlineTime           *string      `json:"onlineTime,omitempty"`
	InboundBytes         uint64       `json:"inboundBytes"`
	OutboundBytes        uint64       `json:"outboundBytes"`
	InboundFramesInError uint64       `json:"inboundFramesInError"`
	Source               *PathSource  `json:"source,omitempty"`
	Readers              []PathReader `json:"readers"`
	Tracks               []Track      `json:"tracks"`
}

type Status struct {
	Info     Info      `json:"info"`
	Channels []Channel `json:"channels"`
}

func NewClient(rawURL string, timeout time.Duration) (*Client, error) {
	baseURL, err := url.Parse(rawURL)
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		return nil, fmt.Errorf("parse MediaMTX API URL %q", rawURL)
	}

	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}, nil
}

func (c *Client) Status(ctx context.Context) (Status, error) {
	info, err := c.Info(ctx)
	if err != nil {
		return Status{}, err
	}

	var configs PathConfigList
	if err := c.get(ctx, "/v3/config/paths/list", &configs); err != nil {
		return Status{}, err
	}

	var runtimePaths PathList
	if err := c.get(ctx, "/v3/paths/list", &runtimePaths); err != nil {
		return Status{}, err
	}

	channels := make(map[string]Channel, len(configs.Items)+len(runtimePaths.Items))
	for _, item := range configs.Items {
		channels[item.Name] = Channel{
			Name:             item.Name,
			ConfiguredSource: item.Source,
			Readers:          []PathReader{},
			Tracks:           []Track{},
		}
	}

	for _, item := range runtimePaths.Items {
		channel := channels[item.Name]
		channel.Name = item.Name
		channel.Available = item.Available
		channel.AvailableTime = item.AvailableTime
		channel.Online = item.Online
		channel.OnlineTime = item.OnlineTime
		channel.InboundBytes = item.InboundBytes
		channel.OutboundBytes = item.OutboundBytes
		channel.InboundFramesInError = item.InboundFramesInError
		channel.Source = item.Source
		channel.Readers = item.Readers
		channel.Tracks = item.Tracks
		channels[item.Name] = channel
	}

	ordered := make([]Channel, 0, len(channels))
	for _, channel := range channels {
		ordered = append(ordered, channel)
	}
	sort.Slice(ordered, func(i, j int) bool {
		return ordered[i].Name < ordered[j].Name
	})

	return Status{Info: info, Channels: ordered}, nil
}

func (c *Client) Info(ctx context.Context) (Info, error) {
	var info Info
	if err := c.get(ctx, "/v3/info", &info); err != nil {
		return Info{}, err
	}
	return info, nil
}

func (c *Client) GetGlobal(ctx context.Context) (GlobalConfig, error) {
	var config GlobalConfig
	if err := c.get(ctx, "/v3/config/global/get", &config); err != nil {
		return GlobalConfig{}, err
	}
	return config, nil
}

func (c *Client) ReplacePath(ctx context.Context, name string, config PathConfig) error {
	return c.mutate(ctx, http.MethodPost, "/v3/config/paths/replace/"+url.PathEscape(name), config, false)
}

func (c *Client) DeletePath(ctx context.Context, name string) error {
	return c.mutate(ctx, http.MethodDelete, "/v3/config/paths/delete/"+url.PathEscape(name), nil, true)
}

func (c *Client) PatchGlobal(ctx context.Context, config GlobalConfig) error {
	return c.mutate(ctx, http.MethodPatch, "/v3/config/global/patch", config, false)
}

func (c *Client) get(ctx context.Context, endpoint string, target any) error {
	requestURL := *c.baseURL
	requestURL.Path = path.Join(c.baseURL.Path, endpoint)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return fmt.Errorf("create MediaMTX request: %w", err)
	}

	res, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request MediaMTX %s: %w", endpoint, err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("request MediaMTX %s: status %s", endpoint, res.Status)
	}
	if err := json.NewDecoder(res.Body).Decode(target); err != nil {
		return fmt.Errorf("decode MediaMTX %s: %w", endpoint, err)
	}
	return nil
}

func (c *Client) mutate(ctx context.Context, method, endpoint string, body any, allowNotFound bool) error {
	requestURL := *c.baseURL
	requestURL.Path = path.Join(c.baseURL.Path, endpoint)

	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode MediaMTX %s: %w", endpoint, err)
		}
		requestBody = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, requestURL.String(), requestBody)
	if err != nil {
		return fmt.Errorf("create MediaMTX request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request MediaMTX %s: %w", endpoint, err)
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusOK || (allowNotFound && res.StatusCode == http.StatusNotFound) {
		return nil
	}
	var response struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&response)
	if response.Error != "" {
		return fmt.Errorf("request MediaMTX %s: %s", endpoint, response.Error)
	}
	return fmt.Errorf("request MediaMTX %s: status %s", endpoint, res.Status)
}
