package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/compatibility"
	"webrtc-gateway/internal/mediamtx"
	"webrtc-gateway/internal/networkbind"
	"webrtc-gateway/internal/project"
	"webrtc-gateway/internal/settings"
	"webrtc-gateway/internal/srtrelay"
	"webrtc-gateway/internal/telemetry"
	"webrtc-gateway/internal/webui"
)

type mediaStatusReader interface {
	Snapshot(context.Context) (mediamtx.StatusSnapshot, error)
	GetGlobal(context.Context) (mediamtx.GlobalConfig, error)
}

type mediaReachabilityReader interface {
	Reachable(context.Context) error
}

type channelService interface {
	List(context.Context) ([]channel.Channel, error)
	Get(context.Context, string) (channel.Channel, error)
	Create(context.Context, channel.Draft) (channel.Channel, error)
	UpdateExpected(context.Context, string, channel.Draft, int) (channel.Channel, error)
	UpdateAutomaticPreview(context.Context, string, bool, *int) (channel.Channel, error)
	Delete(context.Context, string) error
}

type settingsService interface {
	Get(context.Context) (settings.Settings, error)
	UpdateExpected(context.Context, settings.Settings, int) (settings.Settings, error)
}

type projectService interface {
	List(context.Context) ([]project.Summary, error)
	Get(context.Context, string) (project.Project, error)
	Save(context.Context, string) (project.Project, error)
	Import(context.Context, project.Manifest) (project.Project, error)
	Rename(context.Context, string, string, int) (project.Project, error)
	Overwrite(context.Context, string, string, int) (project.Project, error)
	Delete(context.Context, string, int) error
	Load(context.Context, string, int) (project.LoadResult, error)
}

type compatibilityReader interface {
	Snapshot(string) compatibility.State
}

type relayStatusReader interface {
	Snapshot(string) srtrelay.Status
}

type resourceReader interface {
	Snapshot() telemetry.Snapshot
}

type Options struct {
	Logger          *slog.Logger
	MediaMTX        mediaStatusReader
	Channels        channelService
	Settings        settingsService
	Projects        projectService
	Compatibility   compatibilityReader
	Relays          relayStatusReader
	Resources       resourceReader
	MediaMTXWHEPURL string
	Version         string
	StartedAt       time.Time
	Management      ManagementBinding
	Restart         func()
	Interfaces      func() ([]networkbind.InterfaceAddress, error)
}

type ManagementBinding struct {
	ActiveAddress string
	Selection     string
	Port          int
	Locked        bool
}

type server struct {
	logger      *slog.Logger
	mediaMTX    mediaStatusReader
	channels    channelService
	settings    settingsService
	projects    projectService
	compat      compatibilityReader
	relays      relayStatusReader
	resources   resourceReader
	version     string
	startedAt   time.Time
	whepProxy   *httputil.ReverseProxy
	staticFiles fs.FS
	management  ManagementBinding
	restart     func()
	interfaces  func() ([]networkbind.InterfaceAddress, error)

	interfaceCacheMu        sync.Mutex
	interfaceCache          []networkbind.InterfaceAddress
	interfaceCacheErr       error
	interfaceCacheExpiresAt time.Time
}

const interfaceCacheTTL = 500 * time.Millisecond

type statusResponse struct {
	Gateway   gatewayStatus       `json:"gateway"`
	Media     mediaStatus         `json:"media"`
	Settings  settings.Settings   `json:"settings"`
	Network   networkStatus       `json:"network"`
	Resources *telemetry.Snapshot `json:"resources,omitempty"`
	Channels  []channelResponse   `json:"channels"`
}

type runtimeStatusResponse struct {
	Gateway   gatewayStatus            `json:"gateway"`
	Media     mediaStatus              `json:"media"`
	Settings  runtimeSettingsResponse  `json:"settings"`
	Network   networkStatus            `json:"network"`
	Resources *telemetry.Snapshot      `json:"resources,omitempty"`
	Channels  []runtimeChannelResponse `json:"channels"`
}

type runtimeSettingsResponse struct {
	Revision   int                 `json:"revision"`
	ApplyState settings.ApplyState `json:"applyState"`
	ApplyError string              `json:"applyError,omitempty"`
}

type networkStatus struct {
	Interfaces []networkbind.InterfaceAddress `json:"interfaces"`
	Management bindingStatus                  `json:"management"`
	Media      bindingStatus                  `json:"media"`
}

type bindingStatus struct {
	ActiveAddress   string                `json:"activeAddress,omitempty"`
	ActiveSelection string                `json:"activeSelection,omitempty"`
	ActiveListeners *activeMediaListeners `json:"activeListeners,omitempty"`
	DesiredAddress  string                `json:"desiredAddress"`
	ResolvedAddress string                `json:"resolvedAddress,omitempty"`
	ResolutionError string                `json:"resolutionError,omitempty"`
	Port            int                   `json:"port,omitempty"`
	DesiredPort     int                   `json:"desiredPort,omitempty"`
	RestartRequired bool                  `json:"restartRequired"`
	Locked          bool                  `json:"locked,omitempty"`
}

type activeMediaListeners struct {
	SRT       string `json:"srt"`
	WebRTCUDP string `json:"webRTCUDP"`
	WebRTCTCP string `json:"webRTCTCP"`
	RTMP      string `json:"rtmp"`
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
	ID                   string                       `json:"id"`
	Revision             int                          `json:"revision"`
	Number               int                          `json:"number"`
	Name                 string                       `json:"name"`
	Path                 string                       `json:"path"`
	Enabled              bool                         `json:"enabled"`
	AutomaticPreview     bool                         `json:"automaticPreview"`
	Input                inputResponse                `json:"input"`
	MaxReaders           int                          `json:"maxReaders"`
	UseAbsoluteTimestamp bool                         `json:"useAbsoluteTimestamp"`
	ApplyState           channel.ApplyState           `json:"applyState"`
	ApplyError           string                       `json:"applyError,omitempty"`
	CreatedAt            time.Time                    `json:"createdAt"`
	UpdatedAt            time.Time                    `json:"updatedAt"`
	WHEPPath             string                       `json:"whepPath"`
	ViewerPath           string                       `json:"viewerPath"`
	EmbedPath            string                       `json:"embedPath"`
	Available            bool                         `json:"available"`
	AvailableTime        *string                      `json:"availableTime,omitempty"`
	Online               bool                         `json:"online"`
	OnlineTime           *string                      `json:"onlineTime,omitempty"`
	InboundBytes         uint64                       `json:"inboundBytes"`
	OutputInboundBytes   uint64                       `json:"outputInboundBytes"`
	OutputAvailableTime  *string                      `json:"outputAvailableTime,omitempty"`
	OutboundBytes        uint64                       `json:"outboundBytes"`
	InboundFramesInError uint64                       `json:"inboundFramesInError"`
	Source               *mediamtx.PathSource         `json:"source,omitempty"`
	Readers              []mediamtx.PathReader        `json:"readers"`
	Tracks               []mediamtx.Track             `json:"tracks"`
	InputVideo           *compatibility.VideoMetadata `json:"inputVideo"`
	OutputReady          bool                         `json:"outputReady"`
	OutputTracks         []mediamtx.Track             `json:"outputTracks"`
	Compatibility        compatibility.State          `json:"compatibility"`
	Relay                *srtrelay.Status             `json:"relay,omitempty"`
	Issues               []channelIssueResponse       `json:"issues"`
}

type channelIssueResponse struct {
	Code        string    `json:"code"`
	Source      string    `json:"source"`
	Severity    string    `json:"severity"`
	Summary     string    `json:"summary"`
	Message     string    `json:"message"`
	FirstSeenAt time.Time `json:"firstSeenAt"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
	Occurrences int       `json:"occurrences"`
}

type runtimeChannelResponse struct {
	ID                   string                       `json:"id"`
	Revision             int                          `json:"revision"`
	ApplyState           channel.ApplyState           `json:"applyState"`
	ApplyError           string                       `json:"applyError,omitempty"`
	Available            bool                         `json:"available"`
	AvailableTime        *string                      `json:"availableTime,omitempty"`
	Online               bool                         `json:"online"`
	OnlineTime           *string                      `json:"onlineTime,omitempty"`
	InputGeneration      string                       `json:"inputGeneration"`
	InboundBytes         uint64                       `json:"inboundBytes"`
	OutputInboundBytes   uint64                       `json:"outputInboundBytes"`
	OutputAvailableTime  *string                      `json:"outputAvailableTime,omitempty"`
	OutputGeneration     string                       `json:"outputGeneration"`
	OutboundBytes        uint64                       `json:"outboundBytes"`
	InboundFramesInError uint64                       `json:"inboundFramesInError"`
	ReaderCount          int                          `json:"readerCount"`
	Tracks               []mediamtx.Track             `json:"tracks"`
	InputVideo           *compatibility.VideoMetadata `json:"inputVideo"`
	OutputReady          bool                         `json:"outputReady"`
	OutputTracks         []mediamtx.Track             `json:"outputTracks"`
	Compatibility        compatibility.State          `json:"compatibility"`
	Relay                *srtrelay.Status             `json:"relay,omitempty"`
	Issues               []channelIssueResponse       `json:"issues"`
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
	ManagementPort           int      `json:"managementPort"`
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

type projectNameRequest struct {
	Name string `json:"name"`
}

type channelPatchRequest struct {
	AutomaticPreview *bool `json:"automaticPreview"`
}

type diagnosticsResponse struct {
	Gateway   diagnosticsGateway   `json:"gateway"`
	Media     diagnosticsMedia     `json:"media"`
	Settings  diagnosticsSettings  `json:"settings"`
	Resources *telemetry.Snapshot  `json:"resources,omitempty"`
	Channels  []diagnosticsChannel `json:"channels"`
}

type diagnosticsGateway struct {
	Version   string    `json:"version"`
	StartedAt time.Time `json:"startedAt"`
}

type diagnosticsMedia struct {
	Reachable       bool                  `json:"reachable"`
	Version         string                `json:"version,omitempty"`
	Started         string                `json:"started,omitempty"`
	Error           string                `json:"error,omitempty"`
	ActiveListeners *activeMediaListeners `json:"activeListeners,omitempty"`
}

type diagnosticsSettings struct {
	Revision   int                 `json:"revision"`
	ApplyState settings.ApplyState `json:"applyState"`
	UpdatedAt  time.Time           `json:"updatedAt"`
}

type diagnosticsChannel struct {
	ID            string                   `json:"id"`
	Number        int                      `json:"number"`
	Name          string                   `json:"name"`
	Path          string                   `json:"path"`
	Enabled       bool                     `json:"enabled"`
	Revision      int                      `json:"revision"`
	ApplyState    channel.ApplyState       `json:"applyState"`
	CreatedAt     time.Time                `json:"createdAt"`
	UpdatedAt     time.Time                `json:"updatedAt"`
	Runtime       diagnosticsRuntime       `json:"runtime"`
	OutputReady   bool                     `json:"outputReady"`
	Relay         *srtrelay.Status         `json:"relay,omitempty"`
	Compatibility diagnosticsCompatibility `json:"compatibility"`
	Issues        []channelIssueResponse   `json:"issues"`
}

type diagnosticsRuntime struct {
	Available           bool                  `json:"available"`
	AvailableTime       *string               `json:"availableTime,omitempty"`
	Online              bool                  `json:"online"`
	OnlineTime          *string               `json:"onlineTime,omitempty"`
	OutputAvailableTime *string               `json:"outputAvailableTime,omitempty"`
	Source              *mediamtx.PathSource  `json:"source,omitempty"`
	Readers             []mediamtx.PathReader `json:"readers"`
}

type diagnosticsCompatibility struct {
	State     string                         `json:"state"`
	Mode      string                         `json:"mode,omitempty"`
	Required  bool                           `json:"required"`
	Reasons   []string                       `json:"reasons"`
	LastError string                         `json:"lastError,omitempty"`
	Worker    diagnosticsCompatibilityWorker `json:"worker"`
}

type diagnosticsCompatibilityWorker struct {
	Running  bool   `json:"running"`
	Queued   bool   `json:"queued,omitempty"`
	Restarts int    `json:"restarts"`
	Error    string `json:"error,omitempty"`
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

	interfaces := options.Interfaces
	if interfaces == nil {
		interfaces = networkbind.Interfaces
	}
	s := &server{
		logger:      options.Logger,
		mediaMTX:    options.MediaMTX,
		channels:    options.Channels,
		settings:    options.Settings,
		compat:      options.Compatibility,
		relays:      options.Relays,
		projects:    options.Projects,
		resources:   options.Resources,
		version:     options.Version,
		startedAt:   options.StartedAt,
		staticFiles: staticFiles,
		management:  options.Management,
		restart:     options.Restart,
		interfaces:  interfaces,
	}
	s.whepProxy = newWHEPProxy(whepTarget, options.Logger)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /api/v1/status", s.status)
	mux.HandleFunc("GET /api/v1/status/runtime", s.runtimeStatus)
	mux.HandleFunc("GET /api/v1/diagnostics", s.diagnostics)
	mux.HandleFunc("GET /api/v1/settings", s.getSettings)
	mux.HandleFunc("PUT /api/v1/settings", s.updateSettings)
	mux.HandleFunc("GET /api/v1/projects", s.listProjects)
	mux.HandleFunc("POST /api/v1/projects", s.saveProject)
	mux.HandleFunc("POST /api/v1/projects/import", s.importProject)
	mux.HandleFunc("/api/v1/projects/", s.projectAction)
	mux.HandleFunc("POST /api/v1/restart", s.restartGateway)
	mux.HandleFunc("GET /api/v1/channels", s.listChannels)
	mux.HandleFunc("GET /api/v1/channels/runtime", s.listRuntimeChannels)
	mux.HandleFunc("GET /api/v1/channels/{id}/runtime", s.getRuntimeChannel)
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
	var err error
	if reachability, ok := s.mediaMTX.(mediaReachabilityReader); ok {
		err = reachability.Reachable(ctx)
	} else {
		_, err = s.mediaMTX.GetGlobal(ctx)
	}
	if err != nil {
		status = http.StatusServiceUnavailable
		response["status"] = "degraded"
		response["mediaMTX"] = "unavailable"
	}
	writeJSON(w, status, response)
}

func (s *server) status(w http.ResponseWriter, r *http.Request) {
	response, message, err := s.statusSnapshot(r.Context())
	if err != nil {
		s.logger.Error(message, "error", err)
		writeError(w, http.StatusInternalServerError, message)
		return
	}
	if !response.Media.Reachable {
		markResponseDegraded(w)
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *server) runtimeStatus(w http.ResponseWriter, r *http.Request) {
	response, message, err := s.statusSnapshot(r.Context())
	if err != nil {
		s.logger.Error(message, "error", err)
		writeError(w, http.StatusInternalServerError, message)
		return
	}
	if !response.Media.Reachable {
		markResponseDegraded(w)
	}
	writeJSON(w, http.StatusOK, runtimeStatusResponse{
		Gateway: response.Gateway,
		Media:   response.Media,
		Settings: runtimeSettingsResponse{
			Revision: response.Settings.Revision, ApplyState: response.Settings.ApplyState, ApplyError: response.Settings.ApplyError,
		},
		Network: response.Network, Resources: response.Resources, Channels: runtimeChannels(response.Channels),
	})
}

func (s *server) statusSnapshot(ctx context.Context) (statusResponse, string, error) {
	configured, err := s.channels.List(ctx)
	if err != nil {
		return statusResponse{}, "channel configuration is unavailable", err
	}
	globalSettings, err := s.settings.Get(ctx)
	if err != nil {
		return statusResponse{}, "global settings are unavailable", err
	}

	response := statusResponse{
		Gateway:  gatewayStatus{Version: s.version, StartedAt: s.startedAt},
		Media:    mediaStatus{Reachable: false},
		Settings: globalSettings,
	}
	if s.resources != nil {
		resources := s.resources.Snapshot()
		response.Resources = &resources
	}
	interfaceAddresses, interfaceErr := s.cachedInterfaces()
	if interfaceErr == nil {
		response.Network.Interfaces = interfaceAddresses
	}
	response.Network.Management = bindingStatus{
		ActiveAddress: s.management.ActiveAddress, ActiveSelection: s.management.Selection,
		DesiredAddress: globalSettings.ManagementBindAddress,
		Port:           s.management.Port, DesiredPort: globalSettings.ManagementPort, Locked: s.management.Locked,
	}
	if s.management.Locked {
		response.Network.Management.ResolvedAddress = s.management.ActiveAddress
	} else if resolved, resolveErr := resolveBinding(globalSettings.ManagementBindAddress, interfaceAddresses, interfaceErr, false); resolveErr != nil {
		response.Network.Management.ResolutionError = resolveErr.Error()
		response.Network.Management.RestartRequired = true
	} else {
		response.Network.Management.ResolvedAddress = resolved
		response.Network.Management.RestartRequired = s.management.ActiveAddress != resolved || s.management.Port != globalSettings.ManagementPort ||
			s.management.Selection != globalSettings.ManagementBindAddress
	}
	response.Gateway.RestartRequired = response.Network.Management.RestartRequired
	response.Network.Media = bindingStatus{DesiredAddress: globalSettings.MediaBindAddress}
	if _, resolved, _, resolveErr := resolveMedia(globalSettings, interfaceAddresses, interfaceErr); resolveErr != nil {
		response.Network.Media.ResolutionError = resolveErr.Error()
	} else {
		response.Network.Media.ResolvedAddress = resolved
	}
	if mediaGlobal, globalErr := s.mediaMTX.GetGlobal(ctx); globalErr == nil {
		response.Network.Media.ActiveAddress = networkbind.LegacyMediaBinding(
			mediaGlobal.SRTAddress, mediaGlobal.WebRTCLocalUDPAddress, mediaGlobal.WebRTCLocalTCPAddress,
		)
		response.Network.Media.ActiveListeners = listenersFromGlobal(mediaGlobal)
	}
	mediaSnapshot, mediaErr := s.mediaMTX.Snapshot(ctx)
	var mediaRuntime mediamtx.Status
	if mediaErr != nil {
		response.Media.Error = "MediaMTX is unavailable"
	} else {
		mediaRuntime = mediaSnapshot.Status()
		response.Media = mediaStatus{
			Reachable: true,
			Version:   mediaRuntime.Info.Version,
			Started:   mediaRuntime.Info.Started,
		}
	}
	response.Channels = s.mergeChannels(configured, mediaRuntime.Channels)
	return response, "", nil
}

func (s *server) diagnostics(w http.ResponseWriter, r *http.Request) {
	configured, err := s.channels.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "channel diagnostics are unavailable")
		return
	}
	globalSettings, err := s.settings.Get(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "settings diagnostics are unavailable")
		return
	}
	response := diagnosticsResponse{
		Gateway: diagnosticsGateway{Version: s.version, StartedAt: s.startedAt},
		Settings: diagnosticsSettings{
			Revision: globalSettings.Revision, ApplyState: globalSettings.ApplyState, UpdatedAt: globalSettings.UpdatedAt,
		},
		Channels: make([]diagnosticsChannel, 0, len(configured)),
	}
	if s.resources != nil {
		resources := s.resources.Snapshot()
		response.Resources = &resources
	}
	if global, globalErr := s.mediaMTX.GetGlobal(r.Context()); globalErr == nil {
		response.Media.ActiveListeners = listenersFromGlobal(global)
	} else {
		response.Media.Error = "MediaMTX listener configuration is unavailable"
	}
	mediaSnapshot, runtimeErr := s.mediaMTX.Snapshot(r.Context())
	var runtime mediamtx.Status
	if runtimeErr != nil {
		response.Media.Error = "MediaMTX is unavailable"
	} else {
		runtime = mediaSnapshot.Status()
		response.Media.Reachable = true
		response.Media.Version = runtime.Info.Version
		response.Media.Started = runtime.Info.Started
	}
	byPath := make(map[string]mediamtx.Channel, len(runtime.Channels))
	for _, item := range runtime.Channels {
		byPath[item.Name] = item
	}
	for _, item := range configured {
		raw := byPath[item.Path]
		state := compatibility.State{State: compatibility.StateOffline, Mode: compatibility.ModeDirect, Reasons: []string{}, OutputPath: item.Path}
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
		readers := append([]mediamtx.PathReader(nil), raw.Readers...)
		if readers == nil {
			readers = []mediamtx.PathReader{}
		}
		reasons := append([]string(nil), state.Reasons...)
		if reasons == nil {
			reasons = []string{}
		}
		response.Channels = append(response.Channels, diagnosticsChannel{
			ID: item.ID, Number: item.Number, Name: item.Name, Path: item.Path, Enabled: item.Enabled,
			Revision: item.Revision, ApplyState: item.ApplyState, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
			Runtime: diagnosticsRuntime{
				Available: raw.Available, AvailableTime: raw.AvailableTime, Online: raw.Online,
				OnlineTime: raw.OnlineTime, OutputAvailableTime: output.AvailableTime,
				Source: raw.Source, Readers: readers,
			},
			OutputReady: view.OutputReady, Relay: view.Relay, Issues: view.Issues,
			Compatibility: diagnosticsCompatibility{
				State: state.State, Mode: state.Mode, Required: state.Required, Reasons: reasons, LastError: state.LastError,
				Worker: diagnosticsCompatibilityWorker{
					Running: state.Worker.Running, Queued: state.Worker.Queued,
					Restarts: state.Worker.Restarts, Error: state.Worker.Error,
				},
			},
		})
	}
	writeJSON(w, http.StatusOK, response)
}

func listenersFromGlobal(global mediamtx.GlobalConfig) *activeMediaListeners {
	return &activeMediaListeners{
		SRT: global.SRTAddress, WebRTCUDP: global.WebRTCLocalUDPAddress,
		WebRTCTCP: global.WebRTCLocalTCPAddress, RTMP: global.RTMPAddress,
	}
}

func (s *server) cachedInterfaces() ([]networkbind.InterfaceAddress, error) {
	s.interfaceCacheMu.Lock()
	defer s.interfaceCacheMu.Unlock()
	if time.Now().Before(s.interfaceCacheExpiresAt) {
		return slices.Clone(s.interfaceCache), s.interfaceCacheErr
	}
	interfaces, err := s.interfaces()
	s.interfaceCache = slices.Clone(interfaces)
	s.interfaceCacheErr = err
	s.interfaceCacheExpiresAt = time.Now().Add(interfaceCacheTTL)
	return slices.Clone(s.interfaceCache), err
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
	w.Header().Set("ETag", revisionETag(value.Revision))
	writeJSON(w, http.StatusOK, value)
}

func (s *server) updateSettings(w http.ResponseWriter, r *http.Request) {
	expectedRevision, ok := requireIfMatch(w, r)
	if !ok {
		return
	}
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
	interfaceAddresses, interfaceErr := s.interfaces()
	resolvedManagement := s.management.ActiveAddress
	if !s.management.Locked {
		resolvedManagement, err = resolveBinding(value.ManagementBindAddress, interfaceAddresses, interfaceErr, false)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	effective, resolvedMedia, _, err := resolveMedia(value, interfaceAddresses, interfaceErr)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	mediaTCPBind := mediaTCPBinding(effective, resolvedMedia)
	webRTCTCPPort := addressPort(effective.WebRTCLocalTCPAddress)
	desiredManagementPort := value.ManagementPort
	if s.management.Locked {
		desiredManagementPort = s.management.Port
	}
	if webRTCTCPPort > 0 &&
		((webRTCTCPPort == s.management.Port && bindingsOverlap(s.management.ActiveAddress, mediaTCPBind)) ||
			(webRTCTCPPort == desiredManagementPort && bindingsOverlap(resolvedManagement, mediaTCPBind))) {
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
	value, err = s.settings.UpdateExpected(r.Context(), value, expectedRevision)
	if err != nil && value.UpdatedAt.IsZero() {
		if errors.Is(err, settings.ErrInvalid) {
			writeError(w, http.StatusBadRequest, strings.TrimPrefix(err.Error(), settings.ErrInvalid.Error()+": "))
		} else if errors.Is(err, channel.ErrInvalid) {
			writeError(w, http.StatusBadRequest, strings.TrimPrefix(err.Error(), channel.ErrInvalid.Error()+": "))
		} else if errors.Is(err, settings.ErrRevisionConflict) {
			writeAPIError(w, http.StatusPreconditionFailed, "revision_conflict", "settings changed since they were read")
		} else {
			writeError(w, http.StatusInternalServerError, "internal server error")
		}
		return
	}
	if err != nil {
		s.logger.Warn("global settings saved but not applied", "error", err)
	}
	w.Header().Set("ETag", revisionETag(value.Revision))
	writeJSON(w, http.StatusOK, value)
}

func (s *server) listProjects(w http.ResponseWriter, r *http.Request) {
	if s.projects == nil {
		writeError(w, http.StatusServiceUnavailable, "project storage is unavailable")
		return
	}
	items, err := s.projects.List(r.Context())
	if err != nil {
		s.logger.Error("list projects", "error", err)
		writeError(w, http.StatusInternalServerError, "projects are unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": items})
}

func (s *server) saveProject(w http.ResponseWriter, r *http.Request) {
	if s.projects == nil {
		writeError(w, http.StatusServiceUnavailable, "project storage is unavailable")
		return
	}
	var request projectNameRequest
	if err := decodeStrictJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	item, err := s.projects.Save(r.Context(), request.Name)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	w.Header().Set("Location", "/api/v1/projects/"+url.PathEscape(item.ID))
	w.Header().Set("ETag", revisionETag(item.Revision))
	writeJSON(w, http.StatusCreated, item.Summary())
}

func (s *server) importProject(w http.ResponseWriter, r *http.Request) {
	if s.projects == nil {
		writeError(w, http.StatusServiceUnavailable, "project storage is unavailable")
		return
	}
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
	decoder.DisallowUnknownFields()
	var manifest project.Manifest
	if err := decoder.Decode(&manifest); err != nil {
		writeError(w, http.StatusBadRequest, "invalid project file: "+err.Error())
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "project file must contain one JSON object")
		return
	}
	item, err := s.projects.Import(r.Context(), manifest)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	w.Header().Set("Location", "/api/v1/projects/"+url.PathEscape(item.ID))
	w.Header().Set("ETag", revisionETag(item.Revision))
	writeJSON(w, http.StatusCreated, item.Summary())
}

func (s *server) projectAction(w http.ResponseWriter, r *http.Request) {
	if s.projects == nil {
		writeError(w, http.StatusServiceUnavailable, "project storage is unavailable")
		return
	}
	remainder := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/projects/"), "/")
	parts := strings.Split(remainder, "/")
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	id := parts[0]
	if len(parts) == 1 {
		switch r.Method {
		case http.MethodPatch:
			s.renameProject(id, w, r)
		case http.MethodPut:
			s.overwriteProject(id, w, r)
		case http.MethodDelete:
			s.deleteProject(id, w, r)
		default:
			w.Header().Set("Allow", "PATCH, PUT, DELETE")
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return
	}
	if len(parts) == 2 && parts[1] == "load" && r.Method == http.MethodPost {
		s.loadProject(id, w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "export" && r.Method == http.MethodGet {
		s.exportProject(id, w, r)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *server) renameProject(id string, w http.ResponseWriter, r *http.Request) {
	expectedRevision, ok := requireIfMatch(w, r)
	if !ok {
		return
	}
	var request projectNameRequest
	if err := decodeStrictJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	item, err := s.projects.Rename(r.Context(), id, request.Name, expectedRevision)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	w.Header().Set("ETag", revisionETag(item.Revision))
	writeJSON(w, http.StatusOK, item.Summary())
}

func (s *server) overwriteProject(id string, w http.ResponseWriter, r *http.Request) {
	expectedRevision, ok := requireIfMatch(w, r)
	if !ok {
		return
	}
	var request projectNameRequest
	if err := decodeStrictJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	item, err := s.projects.Overwrite(r.Context(), id, request.Name, expectedRevision)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	w.Header().Set("ETag", revisionETag(item.Revision))
	writeJSON(w, http.StatusOK, item.Summary())
}

func (s *server) deleteProject(id string, w http.ResponseWriter, r *http.Request) {
	expectedRevision, ok := requireIfMatch(w, r)
	if !ok {
		return
	}
	if err := s.projects.Delete(r.Context(), id, expectedRevision); err != nil {
		writeProjectError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) loadProject(id string, w http.ResponseWriter, r *http.Request) {
	expectedRevision, ok := requireIfMatch(w, r)
	if !ok {
		return
	}
	result, err := s.projects.Load(r.Context(), id, expectedRevision)
	if err != nil {
		var loadErr *project.LoadError
		if errors.As(err, &loadErr) {
			status := http.StatusConflict
			writeJSON(w, status, map[string]any{
				"error": map[string]any{
					"code": "project_load_failed", "message": loadErr.Error(),
					"rollbackSucceeded": loadErr.RollbackErr == nil,
				},
			})
			return
		}
		writeProjectError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *server) exportProject(id string, w http.ResponseWriter, r *http.Request) {
	item, err := s.projects.Get(r.Context(), id)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	filename := strings.Map(func(value rune) rune {
		if value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || value == '-' || value == '_' {
			return value
		}
		return '-'
	}, item.Name)
	if filename == "" {
		filename = "gateway-project"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.json"`, filename))
	w.Header().Set("ETag", revisionETag(item.Revision))
	writeJSON(w, http.StatusOK, item.Manifest(time.Now()))
}

func writeProjectError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, project.ErrNotFound):
		writeError(w, http.StatusNotFound, "project not found")
	case errors.Is(err, project.ErrRevisionConflict):
		writeAPIError(w, http.StatusPreconditionFailed, "revision_conflict", "project changed since it was read")
	case errors.Is(err, project.ErrNameConflict):
		writeAPIError(w, http.StatusConflict, "name_conflict", "a project with this name already exists")
	case errors.Is(err, project.ErrInvalid), errors.Is(err, project.ErrLiveNotSettled):
		writeError(w, http.StatusBadRequest, strings.TrimPrefix(strings.TrimPrefix(err.Error(), project.ErrInvalid.Error()+": "), project.ErrLiveNotSettled.Error()+": "))
	default:
		writeError(w, http.StatusInternalServerError, "internal server error")
	}
}

func addressPort(address string) int {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return 0
	}
	value, _ := strconv.Atoi(port)
	return value
}

func mediaTCPBinding(value settings.Settings, resolvedMedia string) string {
	if resolvedMedia == networkbind.Custom {
		var err error
		resolvedMedia, err = networkbind.FromListenerAddress(value.WebRTCLocalTCPAddress)
		if err != nil {
			return ""
		}
	}
	return resolvedMedia
}

func bindingsOverlap(left, right string) bool {
	return left != "" && right != "" && (left == networkbind.All || right == networkbind.All || left == right)
}

func resolveBinding(
	selector string,
	interfaces []networkbind.InterfaceAddress,
	interfaceErr error,
	allowCustom bool,
) (string, error) {
	if interfaceErr != nil && networkbind.IsInterfaceSelector(selector) {
		return "", interfaceErr
	}
	return networkbind.Resolve(selector, interfaces, allowCustom)
}

func resolveMedia(
	value settings.Settings,
	interfaces []networkbind.InterfaceAddress,
	interfaceErr error,
) (settings.Settings, string, []string, error) {
	if interfaceErr != nil && networkbind.IsInterfaceSelector(value.MediaBindAddress) {
		return settings.Settings{}, "", nil, interfaceErr
	}
	return settings.ResolveMedia(value, interfaces)
}

func (s *server) listChannels(w http.ResponseWriter, r *http.Request) {
	items, err := s.channels.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "channel configuration is unavailable")
		return
	}
	snapshot, err := s.mediaMTX.Snapshot(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "media status is unavailable")
		return
	}
	runtime := snapshot.Status()
	responses := s.mergeChannels(items, runtime.Channels)
	writeJSON(w, http.StatusOK, map[string]any{"channels": responses})
}

func (s *server) listRuntimeChannels(w http.ResponseWriter, r *http.Request) {
	items, err := s.channels.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "channel configuration is unavailable")
		return
	}
	snapshot, err := s.mediaMTX.Snapshot(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "media status is unavailable")
		return
	}
	runtime := snapshot.Status()
	writeJSON(w, http.StatusOK, map[string]any{"channels": runtimeChannels(s.mergeChannels(items, runtime.Channels))})
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
		case http.MethodPatch:
			s.patchChannel(id, w, r)
		case http.MethodDelete:
			s.deleteChannel(id, w, r)
		default:
			w.Header().Set("Allow", "GET, PUT, PATCH, DELETE")
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
	sessionDelete, route, suffix := whepSessionDelete(r.Method, parts)
	item, err := s.channels.Get(r.Context(), id)
	if err != nil {
		if sessionDelete && errors.Is(err, channel.ErrNotFound) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeServiceError(w, err)
		return
	}
	if sessionDelete {
		mediaPath := item.Path
		if route == "c" {
			mediaPath = compatibility.CompatibilityPath(item.ID)
		}
		s.proxyWHEP(item.ID, mediaPath, route, suffix, w, r)
		return
	}
	if r.Method == http.MethodDelete {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method == http.MethodPost {
		if item.ApplyState == channel.ApplyDeleting {
			writeError(w, http.StatusConflict, channel.ErrDeleting.Error())
			return
		}
		if !item.Enabled || item.ApplyState != channel.ApplyApplied {
			writeError(w, http.StatusConflict, "channel is not operational")
			return
		}
		if len(parts) != 2 {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		mediaPath, route, err := s.operationalWHEPTarget(r.Context(), item)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		s.proxyWHEP(item.ID, mediaPath, route, "", w, r)
		return
	}
	if !item.Enabled {
		writeError(w, http.StatusConflict, "channel is disabled")
		return
	}
	mediaPath := item.Path
	route = ""
	suffix = ""
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
			snapshot, err := s.mediaMTX.Snapshot(r.Context())
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "media status is unavailable")
				return
			}
			raw, _ := snapshot.Channel(item.Path)
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

func whepSessionDelete(method string, parts []string) (bool, string, string) {
	if method != http.MethodDelete {
		return false, "", ""
	}
	if len(parts) == 3 && parts[2] != "" {
		return true, "", "/" + parts[2]
	}
	if len(parts) == 4 && (parts[2] == "d" || parts[2] == "c") && parts[3] != "" {
		return true, parts[2], "/" + parts[3]
	}
	return false, "", ""
}

func (s *server) operationalWHEPTarget(ctx context.Context, item channel.Channel) (string, string, error) {
	snapshot, err := s.mediaMTX.Snapshot(ctx)
	if err != nil {
		return "", "", errors.New("media status is unavailable")
	}
	raw, _ := snapshot.Channel(item.Path)
	state := compatibility.State{State: compatibility.StateOffline, Mode: compatibility.ModeDirect, Reasons: []string{}, OutputPath: item.Path}
	if raw.Available && raw.Online {
		state.State = compatibility.StateReady
	}
	if s.compat != nil {
		state = stateForRuntime(s.compat.Snapshot(item.ID), raw, item.Path)
	}
	output := raw
	if state.OutputPath != "" && state.OutputPath != item.Path {
		output, _ = snapshot.Channel(state.OutputPath)
	}
	if !channelRuntimeView(item, raw, output, state).OutputReady {
		if state.LastError != "" {
			return "", "", errors.New(state.LastError)
		}
		return "", "", errors.New("WebRTC output is not ready")
	}
	mediaPath := item.Path
	route := ""
	if s.compat != nil {
		route = "d"
	}
	if state.OutputPath != "" {
		mediaPath = state.OutputPath
	}
	if state.Mode == compatibility.ModeTranscoded {
		route = "c"
	}
	return mediaPath, route, nil
}

func (s *server) getChannel(id string, w http.ResponseWriter, r *http.Request) {
	item, err := s.channels.Get(r.Context(), id)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	view, err := s.focusedRuntimeChannel(r.Context(), item)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "media status is unavailable")
		return
	}
	w.Header().Set("ETag", revisionETag(item.Revision))
	writeJSON(w, http.StatusOK, view)
}

func (s *server) getRuntimeChannel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	item, err := s.channels.Get(r.Context(), id)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	view, err := s.focusedRuntimeChannel(r.Context(), item)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "media status is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, runtimeChannel(view))
}

func (s *server) focusedRuntimeChannel(ctx context.Context, item channel.Channel) (channelResponse, error) {
	snapshot, err := s.mediaMTX.Snapshot(ctx)
	if err != nil {
		return channelResponse{}, err
	}
	raw, _ := snapshot.Channel(item.Path)
	state := s.channelRuntimeState(item, raw)
	output := raw
	if state.OutputPath != "" && state.OutputPath != item.Path {
		output, _ = snapshot.Channel(state.OutputPath)
	}
	view := channelRuntimeView(item, raw, output, state)
	s.attachRelayStatus(item, &view)
	return view, nil
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
	w.Header().Set("ETag", revisionETag(item.Revision))
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": item.Input.SRT.Passphrase != "",
		"passphrase": item.Input.SRT.Passphrase,
		"revision":   item.Revision,
	})
}

func (s *server) updateChannel(id string, w http.ResponseWriter, r *http.Request) {
	expectedRevision, ok := requireIfMatch(w, r)
	if !ok {
		return
	}
	request, err := decodeChannelRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	draft := request.toDraft(nil)
	draft.PreserveAutomaticPreview = request.AutomaticPreview == nil
	draft.PreserveUseAbsoluteTimestamp = request.UseAbsoluteTimestamp == nil
	item, err := s.channels.UpdateExpected(r.Context(), id, draft, expectedRevision)
	if err != nil && item.ID == "" {
		writeServiceError(w, err)
		return
	}
	if err != nil {
		s.logger.Warn("channel saved but not applied", "channel", item.ID, "error", err)
	}
	w.Header().Set("ETag", revisionETag(item.Revision))
	writeJSON(w, http.StatusOK, s.channelView(item, mediamtx.Channel{}))
}

func (s *server) patchChannel(id string, w http.ResponseWriter, r *http.Request) {
	var request channelPatchRequest
	if err := decodeStrictJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if request.AutomaticPreview == nil {
		writeError(w, http.StatusBadRequest, "automaticPreview is required")
		return
	}
	expectedRevision, ok := optionalIfMatch(w, r)
	if !ok {
		return
	}
	item, err := s.channels.UpdateAutomaticPreview(r.Context(), id, *request.AutomaticPreview, expectedRevision)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	w.Header().Set("ETag", revisionETag(item.Revision))
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

type whepRouting struct {
	channelID string
	mediaPath string
	route     string
	suffix    string
}

type whepRoutingContextKey struct{}

func newWHEPProxy(target *url.URL, logger *slog.Logger) *httputil.ReverseProxy {
	targetCopy := *target
	proxy := httputil.NewSingleHostReverseProxy(&targetCopy)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		routing := req.Context().Value(whepRoutingContextKey{}).(whepRouting)
		req.URL.Path = strings.TrimSuffix(targetCopy.Path, "/") + "/" + url.PathEscape(routing.mediaPath) + "/whep" + routing.suffix
		req.Host = targetCopy.Host
	}
	proxy.ModifyResponse = func(res *http.Response) error {
		routing := res.Request.Context().Value(whepRoutingContextKey{}).(whepRouting)
		if res.Request.Method == http.MethodDelete && (res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone) {
			res.StatusCode = http.StatusNoContent
			res.Status = "204 " + http.StatusText(http.StatusNoContent)
			res.Body.Close()
			res.Body = http.NoBody
			res.ContentLength = 0
			res.Header.Del("Content-Type")
			res.Header.Del("Content-Length")
			return nil
		}
		location := res.Header.Get("Location")
		if location == "" {
			return nil
		}
		parsed, err := url.Parse(location)
		if err != nil {
			return nil
		}
		mediaPrefix := strings.TrimSuffix(targetCopy.Path, "/") + "/" + url.PathEscape(routing.mediaPath) + "/whep"
		if strings.HasPrefix(parsed.Path, mediaPrefix) {
			parsed.Scheme = ""
			parsed.Host = ""
			publicPrefix := "/api/v1/channels/" + url.PathEscape(routing.channelID) + "/whep"
			if routing.route != "" {
				publicPrefix += "/" + routing.route
			}
			parsed.Path = publicPrefix + strings.TrimPrefix(parsed.Path, mediaPrefix)
			res.Header.Set("Location", parsed.String())
		}
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, req *http.Request, err error) {
		routing := req.Context().Value(whepRoutingContextKey{}).(whepRouting)
		logger.Warn("WHEP proxy failed", "channel", routing.channelID, "error", err)
		writeError(w, http.StatusBadGateway, "WebRTC signaling is unavailable")
	}
	return proxy
}

func (s *server) proxyWHEP(channelID, mediaPath, route, suffix string, w http.ResponseWriter, r *http.Request) {
	routing := whepRouting{channelID: channelID, mediaPath: mediaPath, route: route, suffix: suffix}
	request := r.WithContext(context.WithValue(r.Context(), whepRoutingContextKey{}, routing))
	s.whepProxy.ServeHTTP(w, request)
}

func (s *server) spaHandler() http.Handler {
	fileServer := http.FileServer(http.FS(s.staticFiles))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested := strings.TrimPrefix(r.URL.Path, "/")
		// Preserve FileServer's canonical redirect for the real index path.
		if requested == "index.html" && staticFileExists(s.staticFiles, requested) {
			fileServer.ServeHTTP(w, r)
			return
		}
		fallback := true
		if requested != "" && staticFileExists(s.staticFiles, requested) {
			fallback = false
		} else {
			requested = "index.html"
		}

		w.Header().Set("Vary", "Accept-Encoding")
		encoding, ok := selectContentEncoding(strings.Join(r.Header.Values("Accept-Encoding"), ","), func(encoding string) bool {
			return encoding == "identity" || staticFileExists(s.staticFiles, requested+"."+encodingExtension(encoding))
		})
		if !ok {
			http.Error(w, "no acceptable content encoding", http.StatusNotAcceptable)
			return
		}

		served := requested
		if encoding != "identity" {
			served += "." + encodingExtension(encoding)
			w.Header().Set("Content-Encoding", encoding)
			if info, err := fs.Stat(s.staticFiles, served); err == nil {
				w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
			}
		}
		if contentType := mime.TypeByExtension(path.Ext(requested)); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		if strings.HasPrefix(requested, "assets/") && !fallback {
			w.Header().Set("Cache-Control", "public,max-age=31536000,immutable")
		} else if requested == "index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		}

		request := r.Clone(r.Context())
		request.URL.Path = "/" + served
		if encoding == "identity" && requested == "index.html" && (fallback || r.URL.Path == "/") {
			request.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, request)
	})
}

func staticFileExists(files fs.FS, name string) bool {
	info, err := fs.Stat(files, name)
	return err == nil && !info.IsDir()
}

func encodingExtension(encoding string) string {
	if encoding == "gzip" {
		return "gz"
	}
	return encoding
}

func selectContentEncoding(header string, available func(string) bool) (string, bool) {
	if strings.TrimSpace(header) == "" {
		return "identity", true
	}

	qualities := make(map[string]float64)
	for _, value := range strings.Split(header, ",") {
		parts := strings.Split(value, ";")
		name := strings.ToLower(strings.TrimSpace(parts[0]))
		if name == "" {
			continue
		}
		quality := 1.0
		for _, parameter := range parts[1:] {
			key, raw, found := strings.Cut(parameter, "=")
			if !found || !strings.EqualFold(strings.TrimSpace(key), "q") {
				continue
			}
			parsed, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
			if err != nil || parsed < 0 || parsed > 1 {
				quality = 0
			} else {
				quality = parsed
			}
		}
		if current, found := qualities[name]; !found || quality > current {
			qualities[name] = quality
		}
	}

	quality := func(encoding string) float64 {
		if value, found := qualities[encoding]; found {
			return value
		}
		wildcard, hasWildcard := qualities["*"]
		if encoding == "identity" {
			if hasWildcard && wildcard == 0 {
				return 0
			}
			return 1
		}
		if hasWildcard {
			return wildcard
		}
		return 0
	}

	selected := ""
	selectedQuality := 0.0
	for _, encoding := range []string{"br", "gzip", "identity"} {
		candidateQuality := quality(encoding)
		if available(encoding) && candidateQuality > selectedQuality {
			selected = encoding
			selectedQuality = candidateQuality
		}
	}
	return selected, selected != ""
}

func (s *server) requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		requestPath := r.URL.Path
		if requestPath == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		if routinePoll(r.Method, requestPath) {
			response := &requestLogResponseWriter{ResponseWriter: w}
			next.ServeHTTP(response, r)
			if response.statusCode() < http.StatusBadRequest && !response.degraded {
				return
			}
		} else {
			next.ServeHTTP(w, r)
		}
		s.logger.Info("HTTP request", "method", r.Method, "path", requestPath, "duration", time.Since(started))
	})
}

type requestLogResponseWriter struct {
	http.ResponseWriter
	status   int
	degraded bool
}

func markResponseDegraded(w http.ResponseWriter) {
	if marker, ok := w.(interface{ markDegraded() }); ok {
		marker.markDegraded()
	}
}

func (w *requestLogResponseWriter) markDegraded() {
	w.degraded = true
}

func (w *requestLogResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *requestLogResponseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(data)
}

func (w *requestLogResponseWriter) statusCode() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

func routinePoll(method, path string) bool {
	if method != http.MethodGet {
		return false
	}
	switch path {
	case "/api/v1/status", "/api/v1/status/runtime", "/api/v1/channels", "/api/v1/channels/runtime":
		return true
	}
	remainder := strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/channels/"), "/runtime")
	return remainder != path && remainder != "" && !strings.Contains(remainder, "/") && path == "/api/v1/channels/"+remainder+"/runtime"
}

func decodeChannelRequest(r *http.Request) (channelRequest, error) {
	var request channelRequest
	if err := decodeStrictJSON(r, &request); err != nil {
		return channelRequest{}, err
	}
	if request.Input.SRT != nil && request.Input.SRT.Passphrase != nil && request.Input.SRT.ClearPassphrase {
		return channelRequest{}, errors.New("passphrase and clearPassphrase cannot both be set")
	}
	return request, nil
}

func decodeStrictJSON(r *http.Request, target any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid request body: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

func (r channelRequest) toDraft(current *channel.Channel) channel.Draft {
	input := channel.Input{Mode: r.Input.Mode, RTP: r.Input.RTP}
	passphraseIntent := channel.PassphraseUnspecified
	if r.Input.SRT != nil {
		passphraseIntent = channel.PassphraseKeep
		passphrase := ""
		if r.Input.SRT.ClearPassphrase {
			passphraseIntent = channel.PassphraseClear
		} else if r.Input.SRT.Passphrase != nil {
			passphraseIntent = channel.PassphraseSet
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
		PassphraseIntent:     passphraseIntent,
		MaxReaders:           r.MaxReaders,
		UseAbsoluteTimestamp: useAbsoluteTimestamp,
	}
}

func (r settingsRequest) settings() settings.Settings {
	return settings.Settings{
		ManagementBindAddress:    r.ManagementBindAddress,
		ManagementPort:           r.ManagementPort,
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
		state := s.channelRuntimeState(item, raw)
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

func (s *server) channelRuntimeState(item channel.Channel, runtime mediamtx.Channel) compatibility.State {
	state := compatibility.State{
		State: compatibility.StateOffline, Mode: compatibility.ModeDirect,
		Reasons: []string{}, OutputPath: item.Path,
	}
	if runtime.Available && runtime.Online {
		state.State = compatibility.StateReady
	}
	if s.compat != nil {
		state = stateForRuntime(s.compat.Snapshot(item.ID), runtime, item.Path)
	}
	return state
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
	if issue := status.Issue; issue != nil {
		view.Issues = append(view.Issues, channelIssueResponse{
			Code: issue.Code, Source: issue.Source, Severity: "error", Summary: issue.Summary,
			Message: issue.Message, FirstSeenAt: issue.FirstSeenAt, LastSeenAt: issue.LastSeenAt,
			Occurrences: issue.Occurrences,
		})
	}
}

func channelRuntimeView(item channel.Channel, runtime, output mediamtx.Channel, compatibilityState compatibility.State) channelResponse {
	outputReady := item.Enabled && item.ApplyState == channel.ApplyApplied &&
		compatibilityState.State == compatibility.StateReady && output.Available && output.Online
	var outputInboundBytes, outboundBytes uint64
	var outputAvailableTime *string
	var readers []mediamtx.PathReader
	var outputTracks []mediamtx.Track
	if outputReady {
		outputInboundBytes = output.InboundBytes
		outputAvailableTime = output.AvailableTime
		outboundBytes = output.OutboundBytes
		readers = output.Readers
		outputTracks = output.Tracks
	}
	view := channelResponse{
		ID:                   item.ID,
		Revision:             item.Revision,
		Number:               item.Number,
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
		ViewerPath:           "/view",
		EmbedPath:            "/embed/" + strconv.Itoa(item.Number),
		Available:            runtime.Available,
		AvailableTime:        runtime.AvailableTime,
		Online:               runtime.Online,
		OnlineTime:           runtime.OnlineTime,
		InboundBytes:         runtime.InboundBytes,
		OutputInboundBytes:   outputInboundBytes,
		OutputAvailableTime:  outputAvailableTime,
		OutboundBytes:        outboundBytes,
		InboundFramesInError: runtime.InboundFramesInError,
		Source:               runtime.Source,
		Readers:              readers,
		Tracks:               runtime.Tracks,
		InputVideo:           compatibilityState.InputVideo,
		OutputReady:          outputReady,
		OutputTracks:         outputTracks,
		Compatibility:        compatibilityState,
		Issues:               []channelIssueResponse{},
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

func runtimeChannels(channels []channelResponse) []runtimeChannelResponse {
	result := make([]runtimeChannelResponse, 0, len(channels))
	for _, item := range channels {
		result = append(result, runtimeChannel(item))
	}
	return result
}

func runtimeChannel(item channelResponse) runtimeChannelResponse {
	sourceID := ""
	if item.Source != nil {
		sourceID = item.Source.ID
	}
	return runtimeChannelResponse{
		ID:                   item.ID,
		Revision:             item.Revision,
		ApplyState:           item.ApplyState,
		ApplyError:           item.ApplyError,
		Available:            item.Available,
		AvailableTime:        item.AvailableTime,
		Online:               item.Online,
		OnlineTime:           item.OnlineTime,
		InputGeneration:      generationMarker(item.AvailableTime, item.OnlineTime) + ":" + sourceID,
		InboundBytes:         item.InboundBytes,
		OutputInboundBytes:   item.OutputInboundBytes,
		OutputAvailableTime:  item.OutputAvailableTime,
		OutputGeneration:     generationMarker(item.OutputAvailableTime, nil) + ":" + item.Compatibility.Mode,
		OutboundBytes:        item.OutboundBytes,
		InboundFramesInError: item.InboundFramesInError,
		ReaderCount:          len(item.Readers),
		Tracks:               item.Tracks,
		InputVideo:           item.InputVideo,
		OutputReady:          item.OutputReady,
		OutputTracks:         item.OutputTracks,
		Compatibility:        item.Compatibility,
		Relay:                item.Relay,
		Issues:               item.Issues,
	}
}

func generationMarker(primary, fallback *string) string {
	if primary != nil {
		return *primary
	}
	if fallback != nil {
		return *fallback
	}
	return ""
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
	case errors.Is(err, channel.ErrRevisionConflict):
		writeAPIError(w, http.StatusPreconditionFailed, "revision_conflict", "channel changed since it was read")
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

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func revisionETag(revision int) string {
	return `"` + strconv.Itoa(revision) + `"`
}

func requireIfMatch(w http.ResponseWriter, r *http.Request) (int, bool) {
	value := strings.TrimSpace(r.Header.Get("If-Match"))
	if value == "" {
		writeAPIError(w, http.StatusPreconditionRequired, "precondition_required", "If-Match is required")
		return 0, false
	}
	revision, err := parseRevisionETag(value)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_if_match", "If-Match must contain one strong revision ETag")
		return 0, false
	}
	return revision, true
}

func optionalIfMatch(w http.ResponseWriter, r *http.Request) (*int, bool) {
	value := strings.TrimSpace(r.Header.Get("If-Match"))
	if value == "" {
		return nil, true
	}
	revision, err := parseRevisionETag(value)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_if_match", "If-Match must contain one strong revision ETag")
		return nil, false
	}
	return &revision, true
}

func parseRevisionETag(value string) (int, error) {
	if len(value) < 3 || value[0] != '"' || value[len(value)-1] != '"' || strings.Contains(value, ",") {
		return 0, errors.New("invalid revision ETag")
	}
	revision, err := strconv.Atoi(value[1 : len(value)-1])
	if err != nil || revision < 1 {
		return 0, errors.New("invalid revision ETag")
	}
	return revision, nil
}
