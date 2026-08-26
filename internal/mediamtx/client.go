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
	statusCacheKey  = "\x00status"
)

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client

	cacheMu      sync.Mutex
	cache        map[string]cacheEntry
	inflight     map[string]*cacheCall
	epoch        uint64
	runtimeEpoch uint64
}

type cacheEntry struct {
	value     any
	err       error
	expiresAt time.Time
}

type cacheCall struct {
	done         chan struct{}
	value        any
	err          error
	expiresAt    time.Time
	epoch        uint64
	runtimeEpoch uint64
}

type cachedResult[T any] struct {
	value     T
	expiresAt time.Time
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
	RTMPAddress                 string   `json:"rtmpAddress,omitempty"`
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

// StatusSnapshot provides isolated reads from one immutable MediaMTX status
// generation. Values returned by its methods do not share mutable data with
// the cached snapshot.
type StatusSnapshot interface {
	Status() Status
	Channel(name string) (Channel, bool)
}

type statusSnapshot struct {
	status Status
	byPath map[string]int
}

func (s *statusSnapshot) Status() Status {
	return cloneStatus(s.status)
}

func (s *statusSnapshot) Channel(name string) (Channel, bool) {
	index, ok := s.byPath[name]
	if !ok {
		return Channel{}, false
	}
	return cloneChannel(s.status.Channels[index]), true
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
	snapshot, err := c.Snapshot(ctx)
	if err != nil {
		return Status{}, err
	}
	return snapshot.Status(), nil
}

func (c *Client) StatusFresh(ctx context.Context) (Status, error) {
	c.invalidateRuntime()
	return c.Status(ctx)
}

func (c *Client) Snapshot(ctx context.Context) (StatusSnapshot, error) {
	return c.getStatusSnapshot(ctx)
}

// Channel returns the current MediaMTX channel for a path without cloning the
// complete status. The returned value is isolated from the cached snapshot.
func (c *Client) Channel(ctx context.Context, name string) (Channel, bool, error) {
	snapshot, err := c.Snapshot(ctx)
	if err != nil {
		return Channel{}, false, err
	}
	channel, ok := snapshot.Channel(name)
	return channel, ok, nil
}

func (c *Client) getStatusSnapshot(ctx context.Context) (*statusSnapshot, error) {
	now := time.Now()
	c.cacheMu.Lock()
	if cached, ok := c.cache[statusCacheKey]; ok && now.Before(cached.expiresAt) {
		snapshot := cached.value.(*statusSnapshot)
		c.cacheMu.Unlock()
		return snapshot, nil
	}
	if call := c.inflight[statusCacheKey]; call != nil && call.epoch == c.epoch && call.runtimeEpoch == c.runtimeEpoch {
		c.cacheMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-call.done:
			if call.err != nil {
				return nil, call.err
			}
			return call.value.(*statusSnapshot), nil
		}
	}
	epoch := c.epoch
	runtimeEpoch := c.runtimeEpoch
	call := &cacheCall{done: make(chan struct{}), epoch: epoch, runtimeEpoch: runtimeEpoch}
	c.inflight[statusCacheKey] = call
	c.cacheMu.Unlock()

	snapshot, expiresAt, err := c.buildStatusSnapshot(ctx)
	c.cacheMu.Lock()
	call.value = snapshot
	call.err = err
	call.expiresAt = expiresAt
	if c.inflight[statusCacheKey] == call {
		delete(c.inflight, statusCacheKey)
	}
	if err == nil && c.epoch == epoch && c.runtimeEpoch == runtimeEpoch {
		c.cache[statusCacheKey] = cacheEntry{value: snapshot, expiresAt: expiresAt}
	}
	close(call.done)
	c.cacheMu.Unlock()
	return snapshot, err
}

func (c *Client) buildStatusSnapshot(ctx context.Context) (*statusSnapshot, time.Time, error) {
	info, err := getCachedResult(ctx, c, "/v3/info", staticCacheTTL, func(info Info) Info { return info })
	if err != nil {
		return nil, time.Time{}, err
	}
	configs, err := getAllPagesResult(ctx, c, "/v3/config/paths/list", staticCacheTTL, clonePageResponse[PathConfig])
	if err != nil {
		return nil, time.Time{}, err
	}
	runtimePaths, err := getAllPagesResult(ctx, c, "/v3/paths/list", runtimeCacheTTL, clonePathPage)
	if err != nil {
		return nil, time.Time{}, err
	}

	channels := make(map[string]Channel, len(configs.value)+len(runtimePaths.value))
	for _, item := range configs.value {
		channels[item.Name] = Channel{
			Name:             item.Name,
			ConfiguredSource: item.Source,
			Readers:          []PathReader{},
			Tracks:           []Track{},
		}
	}

	for _, item := range runtimePaths.value {
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

	byPath := make(map[string]int, len(ordered))
	for i := range ordered {
		byPath[ordered[i].Name] = i
	}
	expiresAt := info.expiresAt
	if configs.expiresAt.Before(expiresAt) {
		expiresAt = configs.expiresAt
	}
	if runtimePaths.expiresAt.Before(expiresAt) {
		expiresAt = runtimePaths.expiresAt
	}
	return &statusSnapshot{
		status: Status{Info: info.value, Channels: ordered},
		byPath: byPath,
	}, expiresAt, nil
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
	result, err := getCachedResult(ctx, c, endpoint, ttl, clone)
	return result.value, err
}

func getCachedResult[T any](ctx context.Context, c *Client, endpoint string, ttl time.Duration, clone func(T) T) (cachedResult[T], error) {
	requestURL := c.endpointURL(endpoint)
	return getURLCachedResult(ctx, c, endpoint, requestURL, ttl, clone)
}

func getPage[T any](ctx context.Context, c *Client, endpoint string, pageNumber int, ttl time.Duration, clone func(pageResponse[T]) pageResponse[T]) (pageResponse[T], error) {
	result, err := getPageResult(ctx, c, endpoint, pageNumber, ttl, clone)
	return result.value, err
}

func getPageResult[T any](ctx context.Context, c *Client, endpoint string, pageNumber int, ttl time.Duration, clone func(pageResponse[T]) pageResponse[T]) (cachedResult[pageResponse[T]], error) {
	requestURL := c.endpointURL(endpoint)
	query := requestURL.Query()
	query.Set("page", strconv.Itoa(pageNumber))
	requestURL.RawQuery = query.Encode()
	return getURLCachedResult(ctx, c, endpoint, requestURL, ttl, clone)
}

func (c *Client) endpointURL(endpoint string) url.URL {
	requestURL := *c.baseURL
	requestURL.Path = path.Join(c.baseURL.Path, endpoint)
	return requestURL
}

func getURLCached[T any](ctx context.Context, c *Client, endpoint string, requestURL url.URL, ttl time.Duration, clone func(T) T) (T, error) {
	result, err := getURLCachedResult(ctx, c, endpoint, requestURL, ttl, clone)
	return result.value, err
}

func getURLCachedResult[T any](ctx context.Context, c *Client, endpoint string, requestURL url.URL, ttl time.Duration, clone func(T) T) (cachedResult[T], error) {
	key := requestURL.String()
	now := time.Now()
	c.cacheMu.Lock()
	if cached, ok := c.cache[key]; ok && now.Before(cached.expiresAt) {
		if cached.err != nil {
			c.cacheMu.Unlock()
			return cachedResult[T]{}, cached.err
		}
		value := cached.value.(T)
		c.cacheMu.Unlock()
		return cachedResult[T]{value: clone(value), expiresAt: cached.expiresAt}, nil
	}
	runtimeEpoch := uint64(0)
	if endpoint == "/v3/paths/list" {
		runtimeEpoch = c.runtimeEpoch
	}
	if call := c.inflight[key]; call != nil && call.epoch == c.epoch && call.runtimeEpoch == runtimeEpoch {
		c.cacheMu.Unlock()
		select {
		case <-ctx.Done():
			return cachedResult[T]{}, ctx.Err()
		case <-call.done:
			if call.err != nil {
				return cachedResult[T]{}, call.err
			}
			return cachedResult[T]{value: clone(call.value.(T)), expiresAt: call.expiresAt}, nil
		}
	}
	epoch := c.epoch
	call := &cacheCall{done: make(chan struct{}), epoch: epoch, runtimeEpoch: runtimeEpoch}
	c.inflight[key] = call
	c.cacheMu.Unlock()

	data, err := c.fetch(ctx, endpoint, requestURL)
	fetched := err == nil
	var value T
	if fetched {
		err = decodeResponse(endpoint, data, &value)
	}
	expiresAt := time.Time{}
	if fetched {
		expiresAt = time.Now().Add(ttl)
	}
	c.cacheMu.Lock()
	call.value = value
	call.err = err
	call.expiresAt = expiresAt
	if c.inflight[key] == call {
		delete(c.inflight, key)
	}
	if fetched && c.epoch == epoch && (endpoint != "/v3/paths/list" || c.runtimeEpoch == runtimeEpoch) {
		c.cache[key] = cacheEntry{value: value, err: err, expiresAt: expiresAt}
	}
	close(call.done)
	c.cacheMu.Unlock()
	if err != nil {
		return cachedResult[T]{}, err
	}
	return cachedResult[T]{value: clone(value), expiresAt: expiresAt}, nil
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
	result, err := getAllPagesResult(ctx, c, endpoint, ttl, clone)
	return result.value, err
}

func getAllPagesResult[T any](ctx context.Context, c *Client, endpoint string, ttl time.Duration, clone func(pageResponse[T]) pageResponse[T]) (cachedResult[[]T], error) {
	items := []T(nil)
	pageCount := 1
	var expiresAt time.Time
	for pageNumber := 0; pageNumber < pageCount; pageNumber++ {
		result, err := getPageResult(ctx, c, endpoint, pageNumber, ttl, clone)
		if err != nil {
			return cachedResult[[]T]{}, err
		}
		response := result.value
		if expiresAt.IsZero() || result.expiresAt.Before(expiresAt) {
			expiresAt = result.expiresAt
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
	return cachedResult[[]T]{value: items, expiresAt: expiresAt}, nil
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

func cloneStatus(status Status) Status {
	status.Channels = slices.Clone(status.Channels)
	for i := range status.Channels {
		status.Channels[i] = cloneChannel(status.Channels[i])
	}
	return status
}

func cloneChannel(item Channel) Channel {
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

func (c *Client) invalidateRuntime() {
	runtimePath := c.endpointURL("/v3/paths/list").Path
	c.cacheMu.Lock()
	c.runtimeEpoch++
	delete(c.cache, statusCacheKey)
	for key := range c.cache {
		requestURL, err := url.Parse(key)
		if err == nil && requestURL.Path == runtimePath {
			delete(c.cache, key)
		}
	}
	c.cacheMu.Unlock()
}
