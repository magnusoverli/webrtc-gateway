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
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"
)

const (
	runtimeCacheTTL = 350 * time.Millisecond
	staticCacheTTL  = 2 * time.Second
)

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client

	cacheMu  sync.Mutex
	cache    map[string]cacheEntry
	inflight map[string]*cacheCall
	epoch    uint64
}

type cacheEntry struct {
	value     any
	err       error
	expiresAt time.Time
}

type cacheCall struct {
	done  chan struct{}
	value any
	err   error
	epoch uint64
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
	LogLevel                    string   `json:"logLevel"`
	ReadTimeout                 string   `json:"readTimeout"`
	WriteTimeout                string   `json:"writeTimeout"`
	WriteQueueSize              int      `json:"writeQueueSize"`
	UDPMaxPayloadSize           int      `json:"udpMaxPayloadSize"`
	UDPReadBufferSize           uint64   `json:"udpReadBufferSize"`
	SRTAddress                  string   `json:"srtAddress"`
	WebRTCLocalUDPAddress       string   `json:"webrtcLocalUDPAddress"`
	WebRTCLocalTCPAddress       string   `json:"webrtcLocalTCPAddress"`
	WebRTCIPsFromInterfaces     bool     `json:"webrtcIPsFromInterfaces"`
	WebRTCIPsFromInterfacesList []string `json:"webrtcIPsFromInterfacesList"`
	WebRTCAdditionalHosts       []string `json:"webrtcAdditionalHosts"`
	WebRTCHandshakeTimeout      string   `json:"webrtcHandshakeTimeout"`
	WebRTCTrackGatherTimeout    string   `json:"webrtcTrackGatherTimeout"`
}

type PathConfigList struct {
	ItemCount int          `json:"itemCount"`
	PageCount int          `json:"pageCount"`
	Items     []PathConfig `json:"items"`
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
	ItemCount int    `json:"itemCount"`
	PageCount int    `json:"pageCount"`
	Items     []Path `json:"items"`
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
		cache:    make(map[string]cacheEntry),
		inflight: make(map[string]*cacheCall),
	}, nil
}

func (c *Client) Status(ctx context.Context) (Status, error) {
	info, err := c.Info(ctx)
	if err != nil {
		return Status{}, err
	}

	configs, err := getAllPages(ctx, c, "/v3/config/paths/list", staticCacheTTL, clonePageResponse[PathConfig])
	if err != nil {
		return Status{}, err
	}

	runtimePaths, err := getAllPages(ctx, c, "/v3/paths/list", runtimeCacheTTL, clonePathPage)
	if err != nil {
		return Status{}, err
	}

	channels := make(map[string]Channel, len(configs)+len(runtimePaths))
	for _, item := range configs {
		channels[item.Name] = Channel{
			Name:             item.Name,
			ConfiguredSource: item.Source,
			Readers:          []PathReader{},
			Tracks:           []Track{},
		}
	}

	for _, item := range runtimePaths {
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
	return getCached(ctx, c, "/v3/info", staticCacheTTL, func(info Info) Info { return info })
}

func (c *Client) GetGlobal(ctx context.Context) (GlobalConfig, error) {
	return getCached(ctx, c, "/v3/config/global/get", staticCacheTTL, cloneGlobalConfig)
}

func (c *Client) Reachable(ctx context.Context) error {
	requestURL := c.endpointURL("/v3/info")
	_, err := c.fetch(ctx, "/v3/info", requestURL)
	return err
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

func getCached[T any](ctx context.Context, c *Client, endpoint string, ttl time.Duration, clone func(T) T) (T, error) {
	requestURL := c.endpointURL(endpoint)
	return getURLCached(ctx, c, endpoint, requestURL, ttl, clone)
}

func getPage[T any](ctx context.Context, c *Client, endpoint string, pageNumber int, ttl time.Duration, clone func(pageResponse[T]) pageResponse[T]) (pageResponse[T], error) {
	requestURL := c.endpointURL(endpoint)
	query := requestURL.Query()
	query.Set("page", strconv.Itoa(pageNumber))
	requestURL.RawQuery = query.Encode()
	return getURLCached(ctx, c, endpoint, requestURL, ttl, clone)
}

func (c *Client) endpointURL(endpoint string) url.URL {
	requestURL := *c.baseURL
	requestURL.Path = path.Join(c.baseURL.Path, endpoint)
	return requestURL
}

func getURLCached[T any](ctx context.Context, c *Client, endpoint string, requestURL url.URL, ttl time.Duration, clone func(T) T) (T, error) {
	var zero T
	key := requestURL.String()
	now := time.Now()
	c.cacheMu.Lock()
	if cached, ok := c.cache[key]; ok && now.Before(cached.expiresAt) {
		if cached.err != nil {
			c.cacheMu.Unlock()
			return zero, cached.err
		}
		value := cached.value.(T)
		c.cacheMu.Unlock()
		return clone(value), nil
	}
	if call := c.inflight[key]; call != nil && call.epoch == c.epoch {
		c.cacheMu.Unlock()
		select {
		case <-ctx.Done():
			return zero, ctx.Err()
		case <-call.done:
			if call.err != nil {
				return zero, call.err
			}
			return clone(call.value.(T)), nil
		}
	}
	epoch := c.epoch
	call := &cacheCall{done: make(chan struct{}), epoch: epoch}
	c.inflight[key] = call
	c.cacheMu.Unlock()

	data, err := c.fetch(ctx, endpoint, requestURL)
	fetched := err == nil
	var value T
	if fetched {
		err = decodeResponse(endpoint, data, &value)
	}
	c.cacheMu.Lock()
	call.value = value
	call.err = err
	if c.inflight[key] == call {
		delete(c.inflight, key)
	}
	if fetched && c.epoch == epoch {
		c.cache[key] = cacheEntry{value: value, err: err, expiresAt: time.Now().Add(ttl)}
	}
	close(call.done)
	c.cacheMu.Unlock()
	if err != nil {
		return zero, err
	}
	return clone(value), nil
}

func (c *Client) fetch(ctx context.Context, endpoint string, requestURL url.URL) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create MediaMTX request: %w", err)
	}

	res, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request MediaMTX %s: %w", endpoint, err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("request MediaMTX %s: status %s", endpoint, res.Status)
	}
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("read MediaMTX %s: %w", endpoint, err)
	}
	return data, nil
}

func decodeResponse(endpoint string, data []byte, target any) error {
	if err := json.Unmarshal(data, target); err != nil {
		return fmt.Errorf("decode MediaMTX %s: %w", endpoint, err)
	}
	return nil
}

type pageResponse[T any] struct {
	ItemCount int `json:"itemCount"`
	PageCount int `json:"pageCount"`
	Items     []T `json:"items"`
}

func getAllPages[T any](ctx context.Context, c *Client, endpoint string, ttl time.Duration, clone func(pageResponse[T]) pageResponse[T]) ([]T, error) {
	items := []T(nil)
	pageCount := 1
	for pageNumber := 0; pageNumber < pageCount; pageNumber++ {
		response, err := getPage(ctx, c, endpoint, pageNumber, ttl, clone)
		if err != nil {
			return nil, err
		}
		if pageNumber == 0 {
			if response.ItemCount > 0 {
				items = make([]T, 0, response.ItemCount)
			}
			if response.PageCount > 0 {
				pageCount = response.PageCount
			}
		}
		items = append(items, response.Items...)
	}
	return items, nil
}

func clonePageResponse[T any](response pageResponse[T]) pageResponse[T] {
	response.Items = slices.Clone(response.Items)
	return response
}

func clonePathPage(response pageResponse[Path]) pageResponse[Path] {
	response.Items = slices.Clone(response.Items)
	for i := range response.Items {
		response.Items[i] = clonePath(response.Items[i])
	}
	return response
}

func cloneGlobalConfig(config GlobalConfig) GlobalConfig {
	config.WebRTCIPsFromInterfacesList = slices.Clone(config.WebRTCIPsFromInterfacesList)
	config.WebRTCAdditionalHosts = slices.Clone(config.WebRTCAdditionalHosts)
	return config
}

func clonePath(item Path) Path {
	if item.AvailableTime != nil {
		value := *item.AvailableTime
		item.AvailableTime = &value
	}
	if item.OnlineTime != nil {
		value := *item.OnlineTime
		item.OnlineTime = &value
	}
	if item.Source != nil {
		value := *item.Source
		item.Source = &value
	}
	item.Readers = slices.Clone(item.Readers)
	item.Tracks = slices.Clone(item.Tracks)
	for i := range item.Tracks {
		item.Tracks[i].CodecProps = cloneJSONMap(item.Tracks[i].CodecProps)
	}
	return item
}

func cloneJSONMap(source map[string]any) map[string]any {
	if source == nil {
		return nil
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = cloneJSONValue(value)
	}
	return cloned
}

func cloneJSONValue(value any) any {
	switch value := value.(type) {
	case map[string]any:
		return cloneJSONMap(value)
	case []any:
		cloned := make([]any, len(value))
		for i := range value {
			cloned[i] = cloneJSONValue(value[i])
		}
		return cloned
	default:
		return value
	}
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
		c.invalidate()
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

func (c *Client) invalidate() {
	c.cacheMu.Lock()
	c.epoch++
	clear(c.cache)
	c.cacheMu.Unlock()
}
