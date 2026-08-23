package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/compatibility"
	"webrtc-gateway/internal/mediamtx"
	"webrtc-gateway/internal/networkbind"
	"webrtc-gateway/internal/settings"
	"webrtc-gateway/internal/srtrelay"
	"webrtc-gateway/internal/webui"
)

type mediaStatusReader interface {
	Status(context.Context) (mediamtx.Status, error)
}

type channelService interface {
	List(context.Context) ([]channel.Channel, error)
	Get(context.Context, string) (channel.Channel, error)
	Create(context.Context, channel.Draft) (channel.Channel, error)
	Update(context.Context, string, channel.Draft) (channel.Channel, error)
	Delete(context.Context, string) error
}

type settingsService interface {
	Get(context.Context) (settings.Settings, error)
	Update(context.Context, settings.Settings) (settings.Settings, error)
}

type compatibilityReader interface {
	Snapshot(string) compatibility.State
}

type relayStatusReader interface {
	Snapshot(string) srtrelay.Status
}

type Options struct {
	Logger          *slog.Logger
	MediaMTX        mediaStatusReader
	Channels        channelService
	Settings        settingsService
	Compatibility   compatibilityReader
	Relays          relayStatusReader
	MediaMTXWHEPURL string
	Version         string
	StartedAt       time.Time
	Management      ManagementBinding
	Restart         func()
}

type ManagementBinding struct {
	ActiveAddress string
	Port          int
	Locked        bool
}

type server struct {
	logger      *slog.Logger
	mediaMTX    mediaStatusReader
	channels    channelService
	settings    settingsService
	compat      compatibilityReader
	relays      relayStatusReader
	version     string
	startedAt   time.Time
	whepTarget  *url.URL
	staticFiles fs.FS
	management  ManagementBinding
	restart     func()
}

type statusResponse struct {
	Gateway  gatewayStatus     `json:"gateway"`
	Media    mediaStatus       `json:"media"`
	Settings settings.Settings `json:"settings"`
	Network  networkStatus     `json:"network"`
	Channels []channelResponse `json:"channels"`
}

type networkStatus struct {
	Interfaces []networkbind.InterfaceAddress `json:"interfaces"`
	Management bindingStatus                  `json:"management"`
	Media      bindingStatus                  `json:"media"`
}

type bindingStatus struct {
	ActiveAddress   string `json:"activeAddress,omitempty"`
	DesiredAddress  string `json:"desiredAddress"`
	Port            int    `json:"port,omitempty"`
	RestartRequired bool   `json:"restartRequired"`
	Locked          bool   `json:"locked,omitempty"`
}

type gatewayStatus struct {
	Version         string    `json:"version"`
	StartedAt       time.Time `json:"startedAt"`
	RestartRequired bool      `json:"restartRequired"`
}

type mediaStatus struct {
	Reachable bool   `json:"reachable"`
	Version   string `json:"version,omitempty"`
	Started   string `json:"started,omitempty"`
	Error     string `json:"error,omitempty"`
}

type channelRequest struct {
	Name                 string       `json:"name"`
	Enabled              bool         `json:"enabled"`
	AutomaticPreview     *bool        `json:"automaticPreview,omitempty"`
	Input                inputRequest `json:"input"`
	MaxReaders           int          `json:"maxReaders"`
	UseAbsoluteTimestamp *bool        `json:"useAbsoluteTimestamp,omitempty"`
}

type inputRequest struct {
	Mode channel.InputMode `json:"mode"`
	RTP  *channel.RTPInput `json:"rtp,omitempty"`
	SRT  *srtInputRequest  `json:"srt,omitempty"`
}

type srtInputRequest struct {
	Host            string  `json:"host,omitempty"`
	Port            int     `json:"port,omitempty"`
	StreamID        string  `json:"streamId,omitempty"`
	Passphrase      *string `json:"passphrase,omitempty"`
	ClearPassphrase bool    `json:"clearPassphrase,omitempty"`
	LatencyMS       int     `json:"latencyMs,omitempty"`
	SDP             string  `json:"sdp,omitempty"`
}

type channelResponse struct {
	ID                   string                `json:"id"`
	Name                 string                `json:"name"`
	Path                 string                `json:"path"`
	Enabled              bool                  `json:"enabled"`
	AutomaticPreview     bool                  `json:"automaticPreview"`
	Input                inputResponse         `json:"input"`
	MaxReaders           int                   `json:"maxReaders"`
	UseAbsoluteTimestamp bool                  `json:"useAbsoluteTimestamp"`
	ApplyState           channel.ApplyState    `json:"applyState"`
	ApplyError           string                `json:"applyError,omitempty"`
	CreatedAt            time.Time             `json:"createdAt"`
	UpdatedAt            time.Time             `json:"updatedAt"`
	WHEPPath             string                `json:"whepPath"`
	ViewerPath           string                `json:"viewerPath"`
	EmbedPath            string                `json:"embedPath"`
	Available            bool                  `json:"available"`
	AvailableTime        *string               `json:"availableTime,omitempty"`
	Online               bool                  `json:"online"`
	OnlineTime           *string               `json:"onlineTime,omitempty"`
	InboundBytes         uint64                `json:"inboundBytes"`
	OutboundBytes        uint64                `json:"outboundBytes"`
	InboundFramesInError uint64                `json:"inboundFramesInError"`
	Source               *mediamtx.PathSource  `json:"source,omitempty"`
	Readers              []mediamtx.PathReader `json:"readers"`
	Tracks               []mediamtx.Track      `json:"tracks"`
	OutputReady          bool                  `json:"outputReady"`
	OutputTracks         []mediamtx.Track      `json:"outputTracks"`
	Compatibility        compatibility.State   `json:"compatibility"`
	Relay                *srtrelay.Status      `json:"relay,omitempty"`
}

type inputResponse struct {
	Mode channel.InputMode `json:"mode"`
	RTP  *channel.RTPInput `json:"rtp,omitempty"`
	SRT  *srtInputResponse `json:"srt,omitempty"`
}

type srtInputResponse struct {
	Host          string `json:"host,omitempty"`
	Port          int    `json:"port,omitempty"`
	StreamID      string `json:"streamId,omitempty"`
	HasPassphrase bool   `json:"hasPassphrase"`
	LatencyMS     int    `json:"latencyMs,omitempty"`
	SDP           string `json:"sdp,omitempty"`
}

type settingsRequest struct {
	ManagementBindAddress    string   `json:"managementBindAddress"`
	MediaBindAddress         string   `json:"mediaBindAddress"`
	LogLevel                 string   `json:"logLevel"`
	ReadTimeout              string   `json:"readTimeout"`
	WriteTimeout             string   `json:"writeTimeout"`
	WriteQueueSize           int      `json:"writeQueueSize"`
	UDPMaxPayloadSize        int      `json:"udpMaxPayloadSize"`
	UDPReadBufferSize        uint64   `json:"udpReadBufferSize"`
	SRTAddress               string   `json:"srtAddress"`
	WebRTCLocalUDPAddress    string   `json:"webRTCLocalUDPAddress"`
	WebRTCLocalTCPAddress    string   `json:"webRTCLocalTCPAddress"`
	WebRTCIPsFromInterfaces  bool     `json:"webRTCIPsFromInterfaces"`
	WebRTCAdditionalHosts    []string `json:"webRTCAdditionalHosts"`
	WebRTCHandshakeTimeout   string   `json:"webRTCHandshakeTimeout"`
	WebRTCTrackGatherTimeout string   `json:"webRTCTrackGatherTimeout"`
	RTPPortMin               int      `json:"rtpPortMin"`
	RTPPortMax               int      `json:"rtpPortMax"`
	StatisticsIntervalMS     int      `json:"statisticsIntervalMs"`
	DefaultMaxReaders        int      `json:"defaultMaxReaders"`
}

func New(options Options) (http.Handler, error) {
	if options.Logger == nil {
		return nil, fmt.Errorf("logger is required")
	}
	if options.MediaMTX == nil {
		return nil, fmt.Errorf("MediaMTX client is required")
	}
	if options.Channels == nil {
		return nil, fmt.Errorf("channel service is required")
	}
	if options.Settings == nil {
		return nil, fmt.Errorf("settings service is required")
	}

	whepTarget, err := url.Parse(options.MediaMTXWHEPURL)
	if err != nil || whepTarget.Scheme == "" || whepTarget.Host == "" {
		return nil, fmt.Errorf("MediaMTX WHEP URL must be absolute")
	}

	staticFiles, err := webui.Files()
	if err != nil {
		return nil, fmt.Errorf("load web assets: %w", err)
	}

	s := &server{
		logger:      options.Logger,
		mediaMTX:    options.MediaMTX,
		channels:    options.Channels,
		settings:    options.Settings,
		compat:      options.Compatibility,
		relays:      options.Relays,
		version:     options.Version,
		startedAt:   options.StartedAt,
		whepTarget:  whepTarget,
		staticFiles: staticFiles,
		management:  options.Management,
		restart:     options.Restart,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /api/v1/status", s.status)
	mux.HandleFunc("GET /api/v1/settings", s.getSettings)
	mux.HandleFunc("PUT /api/v1/settings", s.updateSettings)
	mux.HandleFunc("POST /api/v1/restart", s.restartGateway)
	mux.HandleFunc("GET /api/v1/channels", s.listChannels)
	mux.HandleFunc("POST /api/v1/channels", s.createChannel)
	mux.HandleFunc("/api/v1/channels/", s.channelAction)
	mux.Handle("/", s.spaHandler())

	return s.requestLog(mux), nil
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	status := http.StatusOK
	response := map[string]any{"status": "ok", "mediaMTX": "ok"}
	if _, err := s.mediaMTX.Status(ctx); err != nil {
		status = http.StatusServiceUnavailable
		response["status"] = "degraded"
		response["mediaMTX"] = "unavailable"
	}
	writeJSON(w, status, response)
}

func (s *server) status(w http.ResponseWriter, r *http.Request) {
	configured, err := s.channels.List(r.Context())
	if err != nil {
		s.logger.Error("channel list unavailable", "error", err)
		writeError(w, http.StatusInternalServerError, "channel configuration is unavailable")
		return
	}
	globalSettings, err := s.settings.Get(r.Context())
	if err != nil {
		s.logger.Error("global settings unavailable", "error", err)
		writeError(w, http.StatusInternalServerError, "global settings are unavailable")
		return
	}

	response := statusResponse{
		Gateway:  gatewayStatus{Version: s.version, StartedAt: s.startedAt},
		Media:    mediaStatus{Reachable: false},
		Settings: globalSettings,
	}
	response.Network.Interfaces, _ = networkbind.Interfaces()
	response.Network.Management = bindingStatus{
		ActiveAddress: s.management.ActiveAddress, DesiredAddress: globalSettings.ManagementBindAddress,
		Port: s.management.Port, Locked: s.management.Locked,
		RestartRequired: !s.management.Locked && s.management.ActiveAddress != globalSettings.ManagementBindAddress,
	}
	response.Gateway.RestartRequired = response.Network.Management.RestartRequired
	response.Network.Media = bindingStatus{DesiredAddress: globalSettings.MediaBindAddress}
	if globalSettings.ApplyState == settings.ApplyApplied {
		response.Network.Media.ActiveAddress = globalSettings.MediaBindAddress
	}
	mediaRuntime, mediaErr := s.mediaMTX.Status(r.Context())
	if mediaErr != nil {
		response.Media.Error = "MediaMTX is unavailable"
	} else {
		response.Media = mediaStatus{
			Reachable: true,
			Version:   mediaRuntime.Info.Version,
			Started:   mediaRuntime.Info.Started,
		}
	}
	response.Channels = s.mergeChannels(configured, mediaRuntime.Channels)
	writeJSON(w, http.StatusOK, response)
}

func (s *server) restartGateway(w http.ResponseWriter, _ *http.Request) {
	if s.restart == nil {
		writeError(w, http.StatusServiceUnavailable, "Gateway restart is unavailable")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "restarting"})
	go s.restart()
}

func (s *server) getSettings(w http.ResponseWriter, r *http.Request) {
	value, err := s.settings.Get(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "global settings are unavailable")
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (s *server) updateSettings(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	var request settingsRequest
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "request body must contain one JSON object")
		return
	}

	value := request.settings()
	validated, err := settings.Validate(value, time.Now())
	if err != nil {
		writeError(w, http.StatusBadRequest, strings.TrimPrefix(err.Error(), settings.ErrInvalid.Error()+": "))
		return
	}
	value = validated
	if s.management.Port > 0 && addressPort(value.WebRTCLocalTCPAddress) == s.management.Port && managementMediaOverlap(value) {
		writeError(w, http.StatusBadRequest, "WebRTC TCP fallback cannot use the management listener port on the same interface")
		return
	}
	channels, err := s.channels.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read channels: "+err.Error())
		return
	}
	for _, item := range channels {
		if item.Input.RTP != nil && (item.Input.RTP.Port < value.RTPPortMin || item.Input.RTP.Port > value.RTPPortMax) {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("RTP port range must include port %d used by %s", item.Input.RTP.Port, item.Name))
			return
		}
		if item.Input.Mode == channel.InputSRTPush && item.Input.SRT != nil {
			port := item.Input.SRT.Port
			if port >= value.RTPPortMin && port <= value.RTPPortMax {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("RTP port range cannot include SRT listener port %d used by %s", port, item.Name))
				return
			}
			if port == addressPort(value.SRTAddress) || port == addressPort(value.WebRTCLocalUDPAddress) {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("global UDP listeners cannot use SRT listener port %d assigned to %s", port, item.Name))
				return
			}
		}
	}
	value, err = s.settings.Update(r.Context(), value)
	if err != nil && value.UpdatedAt.IsZero() {
		if errors.Is(err, settings.ErrInvalid) {
			writeError(w, http.StatusBadRequest, strings.TrimPrefix(err.Error(), settings.ErrInvalid.Error()+": "))
		} else if errors.Is(err, channel.ErrInvalid) {
			writeError(w, http.StatusBadRequest, strings.TrimPrefix(err.Error(), channel.ErrInvalid.Error()+": "))
		} else {
			writeError(w, http.StatusInternalServerError, "internal server error")
		}
		return
	}
	if err != nil {
		s.logger.Warn("global settings saved but not applied", "error", err)
	}
	writeJSON(w, http.StatusOK, value)
}

func addressPort(address string) int {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return 0
	}
	value, _ := strconv.Atoi(port)
	return value
}

func managementMediaOverlap(value settings.Settings) bool {
	management := value.ManagementBindAddress
	media := value.MediaBindAddress
	if media == networkbind.Custom {
		var err error
		media, err = networkbind.FromListenerAddress(value.WebRTCLocalTCPAddress)
		if err != nil {
			return false
		}
	}
	return management == networkbind.All || media == networkbind.All || management == media
}

func (s *server) listChannels(w http.ResponseWriter, r *http.Request) {
	items, err := s.channels.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "channel configuration is unavailable")
		return
	}
	responses := make([]channelResponse, 0, len(items))
	for _, item := range items {
		responses = append(responses, s.channelView(item, mediamtx.Channel{}))
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": responses})
}

func (s *server) createChannel(w http.ResponseWriter, r *http.Request) {
	request, err := decodeChannelRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	draft := request.toDraft(nil)
	item, err := s.channels.Create(r.Context(), draft)
	if err != nil && item.ID == "" {
		writeServiceError(w, err)
		return
	}
	if err != nil {
		s.logger.Warn("channel saved but not applied", "channel", item.ID, "error", err)
	}
	writeJSON(w, http.StatusCreated, s.channelView(item, mediamtx.Channel{}))
}

func (s *server) channelAction(w http.ResponseWriter, r *http.Request) {
	remainder := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/channels/"), "/")
	parts := strings.Split(remainder, "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	id := parts[0]

	if len(parts) == 1 {
		switch r.Method {
		case http.MethodGet:
			s.getChannel(id, w, r)
		case http.MethodPut:
			s.updateChannel(id, w, r)
		case http.MethodDelete:
			s.deleteChannel(id, w, r)
		default:
			w.Header().Set("Allow", "GET, PUT, DELETE")
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return
	}
	if len(parts) == 2 && parts[1] == "srt-passphrase" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.getSRTPassphrase(id, w, r)
		return
	}

	if parts[1] != "whep" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	item, err := s.channels.Get(r.Context(), id)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if item.ApplyState == channel.ApplyDeleting {
		if r.Method == http.MethodPost {
			writeError(w, http.StatusConflict, channel.ErrDeleting.Error())
			return
		}
	} else if !item.Enabled {
		writeError(w, http.StatusConflict, "channel is disabled")
		return
	}
	mediaPath := item.Path
	route := ""
	suffix := ""
	if len(parts) > 2 && (parts[2] == "d" || parts[2] == "c") {
		route = parts[2]
		if route == "c" {
			mediaPath = compatibility.CompatibilityPath(item.ID)
		}
		if len(parts) > 3 {
			suffix = "/" + strings.Join(parts[3:], "/")
		}
	} else if len(parts) > 2 {
		// Session URLs issued before automatic routing was enabled target the direct path.
		suffix = "/" + strings.Join(parts[2:], "/")
	} else if s.compat != nil {
		state := s.compat.Snapshot(item.ID)
		if r.Method != http.MethodOptions && state.InputFingerprint != "" {
			runtime, err := s.mediaMTX.Status(r.Context())
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "media status is unavailable")
				return
			}
			var raw mediamtx.Channel
			for _, candidate := range runtime.Channels {
				if candidate.Name == item.Path {
					raw = candidate
					break
				}
			}
			state = stateForRuntime(state, raw, item.Path)
		}
		if r.Method != http.MethodOptions && (state.State != compatibility.StateReady || state.OutputPath == "") {
			message := "WebRTC output is being prepared"
			if state.LastError != "" {
				message = state.LastError
			}
			writeError(w, http.StatusServiceUnavailable, message)
			return
		}
		if state.OutputPath != "" {
			mediaPath = state.OutputPath
		}
		if state.Mode == compatibility.ModeTranscoded {
			route = "c"
		} else {
			route = "d"
		}
	}
	s.proxyWHEP(item.ID, mediaPath, route, suffix, w, r)
}

func (s *server) getChannel(id string, w http.ResponseWriter, r *http.Request) {
	item, err := s.channels.Get(r.Context(), id)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	runtime, err := s.mediaMTX.Status(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "media status is unavailable")
		return
	}
	view := s.mergeChannels([]channel.Channel{item}, runtime.Channels)
	writeJSON(w, http.StatusOK, view[0])
}

func (s *server) getSRTPassphrase(id string, w http.ResponseWriter, r *http.Request) {
	item, err := s.channels.Get(r.Context(), id)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if item.Input.SRT == nil {
		writeError(w, http.StatusConflict, "channel is not configured for SRT")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": item.Input.SRT.Passphrase != "",
		"passphrase": item.Input.SRT.Passphrase,
	})
}

func (s *server) updateChannel(id string, w http.ResponseWriter, r *http.Request) {
	current, err := s.channels.Get(r.Context(), id)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	request, err := decodeChannelRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	item, err := s.channels.Update(r.Context(), id, request.toDraft(&current))
	if err != nil && item.ID == "" {
		writeServiceError(w, err)
		return
	}
	if err != nil {
		s.logger.Warn("channel saved but not applied", "channel", item.ID, "error", err)
	}
	writeJSON(w, http.StatusOK, s.channelView(item, mediamtx.Channel{}))
}

func (s *server) deleteChannel(id string, w http.ResponseWriter, r *http.Request) {
	if err := s.channels.Delete(r.Context(), id); err != nil {
		if errors.Is(err, channel.ErrDeleting) {
			writeJSON(w, http.StatusAccepted, map[string]string{"status": "deleting"})
			return
		}
		writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) proxyWHEP(channelID, mediaPath, route, suffix string, w http.ResponseWriter, r *http.Request) {
	target := *s.whepTarget
	proxy := httputil.NewSingleHostReverseProxy(&target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = strings.TrimSuffix(target.Path, "/") + "/" + url.PathEscape(mediaPath) + "/whep" + suffix
		req.Host = target.Host
	}
	proxy.ModifyResponse = func(res *http.Response) error {
		location := res.Header.Get("Location")
		if location == "" {
			return nil
		}
		parsed, err := url.Parse(location)
		if err != nil {
			return nil
		}
		mediaPrefix := strings.TrimSuffix(target.Path, "/") + "/" + url.PathEscape(mediaPath) + "/whep"
		if strings.HasPrefix(parsed.Path, mediaPrefix) {
			parsed.Scheme = ""
			parsed.Host = ""
			publicPrefix := "/api/v1/channels/" + url.PathEscape(channelID) + "/whep"
			if route != "" {
				publicPrefix += "/" + route
			}
			parsed.Path = publicPrefix + strings.TrimPrefix(parsed.Path, mediaPrefix)
			res.Header.Set("Location", parsed.String())
		}
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		s.logger.Warn("WHEP proxy failed", "channel", channelID, "error", err)
		writeError(w, http.StatusBadGateway, "WebRTC signaling is unavailable")
	}
	proxy.ServeHTTP(w, r)
}

func (s *server) spaHandler() http.Handler {
	fileServer := http.FileServer(http.FS(s.staticFiles))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested := strings.TrimPrefix(r.URL.Path, "/")
		if requested != "" {
			if info, err := fs.Stat(s.staticFiles, requested); err == nil && !info.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}

func (s *server) requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		requestPath := r.URL.Path
		next.ServeHTTP(w, r)
		if requestPath != "/healthz" {
			s.logger.Info("HTTP request", "method", r.Method, "path", requestPath, "duration", time.Since(started))
		}
	})
}

func decodeChannelRequest(r *http.Request) (channelRequest, error) {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	var request channelRequest
	if err := decoder.Decode(&request); err != nil {
		return channelRequest{}, fmt.Errorf("invalid request body: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return channelRequest{}, errors.New("request body must contain one JSON object")
	}
	return request, nil
}

func (r channelRequest) toDraft(current *channel.Channel) channel.Draft {
	input := channel.Input{Mode: r.Input.Mode, RTP: r.Input.RTP}
	if r.Input.SRT != nil {
		passphrase := ""
		if current != nil && current.Input.SRT != nil {
			passphrase = current.Input.SRT.Passphrase
		}
		if r.Input.SRT.ClearPassphrase {
			passphrase = ""
		} else if r.Input.SRT.Passphrase != nil {
			passphrase = *r.Input.SRT.Passphrase
		}
		input.SRT = &channel.SRTInput{
			Host:       r.Input.SRT.Host,
			Port:       r.Input.SRT.Port,
			StreamID:   r.Input.SRT.StreamID,
			Passphrase: passphrase,
			LatencyMS:  r.Input.SRT.LatencyMS,
			SDP:        r.Input.SRT.SDP,
		}
	}
	automaticPreview := true
	if current != nil {
		automaticPreview = current.AutomaticPreview
	}
	if r.AutomaticPreview != nil {
		automaticPreview = *r.AutomaticPreview
	}
	useAbsoluteTimestamp := true
	if current != nil {
		useAbsoluteTimestamp = current.UseAbsoluteTimestamp
	}
	if r.UseAbsoluteTimestamp != nil {
		useAbsoluteTimestamp = *r.UseAbsoluteTimestamp
	}
	return channel.Draft{
		Name:                 r.Name,
		Enabled:              r.Enabled,
		AutomaticPreview:     automaticPreview,
		Input:                input,
		MaxReaders:           r.MaxReaders,
		UseAbsoluteTimestamp: useAbsoluteTimestamp,
	}
}

func (r settingsRequest) settings() settings.Settings {
	return settings.Settings{
		ManagementBindAddress:    r.ManagementBindAddress,
		MediaBindAddress:         r.MediaBindAddress,
		LogLevel:                 r.LogLevel,
		ReadTimeout:              r.ReadTimeout,
		WriteTimeout:             r.WriteTimeout,
		WriteQueueSize:           r.WriteQueueSize,
		UDPMaxPayloadSize:        r.UDPMaxPayloadSize,
		UDPReadBufferSize:        r.UDPReadBufferSize,
		SRTAddress:               r.SRTAddress,
		WebRTCLocalUDPAddress:    r.WebRTCLocalUDPAddress,
		WebRTCLocalTCPAddress:    r.WebRTCLocalTCPAddress,
		WebRTCIPsFromInterfaces:  r.WebRTCIPsFromInterfaces,
		WebRTCAdditionalHosts:    r.WebRTCAdditionalHosts,
		WebRTCHandshakeTimeout:   r.WebRTCHandshakeTimeout,
		WebRTCTrackGatherTimeout: r.WebRTCTrackGatherTimeout,
		RTPPortMin:               r.RTPPortMin,
		RTPPortMax:               r.RTPPortMax,
		StatisticsIntervalMS:     r.StatisticsIntervalMS,
		DefaultMaxReaders:        r.DefaultMaxReaders,
	}
}

func (s *server) mergeChannels(configured []channel.Channel, runtime []mediamtx.Channel) []channelResponse {
	byPath := make(map[string]mediamtx.Channel, len(runtime))
	for _, item := range runtime {
		byPath[item.Name] = item
	}
	responses := make([]channelResponse, 0, len(configured))
	for _, item := range configured {
		raw := byPath[item.Path]
		state := compatibility.State{
			State: compatibility.StateOffline, Mode: compatibility.ModeDirect,
			Reasons: []string{}, OutputPath: item.Path,
		}
		if raw.Available && raw.Online {
			state.State = compatibility.StateReady
		}
		if s.compat != nil {
			state = stateForRuntime(s.compat.Snapshot(item.ID), raw, item.Path)
		}
		output := raw
		if state.OutputPath != "" && state.OutputPath != item.Path {
			output = byPath[state.OutputPath]
		}
		view := channelRuntimeView(item, raw, output, state)
		s.attachRelayStatus(item, &view)
		responses = append(responses, view)
	}
	return responses
}

func stateForRuntime(state compatibility.State, runtime mediamtx.Channel, directPath string) compatibility.State {
	if !runtime.Available || !runtime.Online {
		return compatibility.State{
			State: compatibility.StateOffline, Mode: compatibility.ModeDirect,
			Reasons: []string{}, OutputPath: directPath,
		}
	}
	if state.InputFingerprint != "" && state.InputFingerprint != compatibility.Fingerprint(runtime) {
		return compatibility.State{
			State: compatibility.StateProbing, Mode: compatibility.ModeDirect,
			Reasons: []string{}, OutputPath: directPath,
		}
	}
	return state
}

func (s *server) channelView(item channel.Channel, runtime mediamtx.Channel) channelResponse {
	state := compatibility.State{
		State: compatibility.StateOffline, Mode: compatibility.ModeDirect,
		Reasons: []string{}, OutputPath: item.Path,
	}
	if runtime.Available && runtime.Online {
		state.State = compatibility.StateReady
	}
	view := channelRuntimeView(item, runtime, runtime, state)
	s.attachRelayStatus(item, &view)
	return view
}

func (s *server) attachRelayStatus(item channel.Channel, view *channelResponse) {
	if s.relays == nil || (item.Input.Mode != channel.InputSRTPush && item.Input.Mode != channel.InputSRTPull) {
		return
	}
	status := s.relays.Snapshot(item.ID)
	view.Relay = &status
}

func channelRuntimeView(item channel.Channel, runtime, output mediamtx.Channel, compatibilityState compatibility.State) channelResponse {
	view := channelResponse{
		ID:                   item.ID,
		Name:                 item.Name,
		Path:                 item.Path,
		Enabled:              item.Enabled,
		AutomaticPreview:     item.AutomaticPreview,
		Input:                inputView(item.Input),
		MaxReaders:           item.MaxReaders,
		UseAbsoluteTimestamp: item.UseAbsoluteTimestamp,
		ApplyState:           item.ApplyState,
		ApplyError:           item.ApplyError,
		CreatedAt:            item.CreatedAt,
		UpdatedAt:            item.UpdatedAt,
		WHEPPath:             "/api/v1/channels/" + url.PathEscape(item.ID) + "/whep",
		ViewerPath:           "/view/" + url.PathEscape(item.ID),
		EmbedPath:            "/embed/" + url.PathEscape(item.ID),
		Available:            runtime.Available,
		AvailableTime:        runtime.AvailableTime,
		Online:               runtime.Online,
		OnlineTime:           runtime.OnlineTime,
		InboundBytes:         runtime.InboundBytes,
		OutboundBytes:        output.OutboundBytes,
		InboundFramesInError: runtime.InboundFramesInError,
		Source:               runtime.Source,
		Readers:              output.Readers,
		Tracks:               runtime.Tracks,
		OutputReady:          compatibilityState.State == compatibility.StateReady && output.Available && output.Online,
		OutputTracks:         output.Tracks,
		Compatibility:        compatibilityState,
	}
	if view.Readers == nil {
		view.Readers = []mediamtx.PathReader{}
	}
	if view.Tracks == nil {
		view.Tracks = []mediamtx.Track{}
	}
	if view.OutputTracks == nil {
		view.OutputTracks = []mediamtx.Track{}
	}
	if view.Compatibility.Reasons == nil {
		view.Compatibility.Reasons = []string{}
	}
	return view
}

func inputView(input channel.Input) inputResponse {
	view := inputResponse{Mode: input.Mode, RTP: input.RTP}
	if input.SRT != nil {
		view.SRT = &srtInputResponse{
			Host:          input.SRT.Host,
			Port:          input.SRT.Port,
			StreamID:      input.SRT.StreamID,
			HasPassphrase: input.SRT.Passphrase != "",
			LatencyMS:     input.SRT.LatencyMS,
			SDP:           input.SRT.SDP,
		}
	}
	return view
}

func writeServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, channel.ErrNotFound):
		writeError(w, http.StatusNotFound, "channel not found")
	case errors.Is(err, channel.ErrInvalid):
		writeError(w, http.StatusBadRequest, strings.TrimPrefix(err.Error(), channel.ErrInvalid.Error()+": "))
	case errors.Is(err, channel.ErrDeleting):
		writeError(w, http.StatusConflict, channel.ErrDeleting.Error())
	default:
		writeError(w, http.StatusInternalServerError, "internal server error")
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
