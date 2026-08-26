# WebRTC Gateway Development Plan

## Goal

Build a Linux application deployable with Docker Compose that accepts independently configured RTP or SRT inputs and exposes WebRTC outputs. The default media path must be robust, low latency, and free of decoding or encoding. A single-port web application provides configuration, simultaneous channel multiview, status, statistics, stable viewer/embed routes, and an automatic muted preview that can be disabled per channel.

## Accepted Decisions

- MediaMTX is the media data plane.
- The normal route is RTP/SRT -> MediaMTX -> WHEP/WebRTC, with no transcoder process.
- Live SRT inputs are classified automatically. Raw MPEG-TS and RTP/MP2T are detected without operator input; elementary RTP uses supplied SDP. Browser-compatible tracks remain on the direct path; incompatible tracks use an isolated compatibility worker.
- Inputs are configured once and then listen, connect, and recover automatically.
- RTP unicast and multicast are supported. RTP configuration requires SDP.
- SRT push and pull modes are supported.
- SRT push senders that can provide only a destination IP and port are supported through a unique per-channel listener and stream-copy remux relay; sender-side stream IDs are not required.
- The deployment target is Linux using Docker host networking.
- The deployment is LAN-only. Internet TLS, STUN, and TURN are out of scope.
- The web UI, application API, WHEP signaling proxy, and live statistics use one HTTP port.
- Management and media listeners can bind to all interfaces, a fixed IP, or the current IPv4/IPv6 address of a persisted host interface selection.
- RTP, SRT, and WebRTC media continue to use their own UDP ports.
- Preview creates a real WebRTC reader and starts muted. Each eligible visible overview grid card can open one preview, list mode opens none, and channel detail can open its own preview.
- Always-on statistics come from MediaMTX. Browser `getStats()` augments them while preview is active.
- Gateway-container and whole-host CPU/RAM are sampled in the background from cgroup v2 and `/proc`; MediaMTX process resources remain explicitly excluded because its container is isolated.
- Dashboard status uses bounded serial HTTP polling with failure backoff and a hidden-page pause. Preview sessions close after 30 seconds hidden.
- Technical controls/readouts use accessible compact help, essential guidance stays inline, and diagnostics is opened on demand instead of occupying permanent navigation or panels.
- Full channel and settings replacements use revisions with `If-Match`; the automatic-preview preference uses a narrow `PATCH`.

## Architecture

```text
RTP / SRT with stream ID
    |
    v
MediaMTX channel path ----------------------> WHEP / WebRTC
    |                                             |
    | automatic compatibility when required     v
    +--> FFmpeg --> MediaMTX compatibility path  Browser / client

Web UI --> Gateway API --> MediaMTX Control API / metrics
                       --> persisted configuration
                       --> optional FFmpeg supervisor

SRT without stream ID --> per-channel SRT listener --> framing adapter --> MediaMTX MPEG-TS publisher or RTP source
```

### Components

- **MediaMTX:** ingest, protocol conversion, path isolation, WHEP, WebRTC, runtime API, and metrics.
- **Gateway:** Go API, MediaMTX reconciliation, per-channel SRT relay supervision, statistics aggregation, WHEP reverse proxy, static frontend, and optional FFmpeg process supervision.
- **Web UI:** React and TypeScript single-page application served by Gateway.
- **Persistence:** SQLite in a Docker volume. It is the desired-state source of truth.
- **FFmpeg:** supervised per incompatible SRT channel; no process runs for direct channels.
- **Resource sampler:** non-blocking one-second Gateway-cgroup and whole-host CPU/RAM snapshots exposed through the existing status API.

### Network Layout

- Gateway web/API/WHEP signaling: `:8080/tcp` by default.
- MediaMTX SRT ingest: `:8890/udp` by default; used directly by stream-ID-capable senders and internally by per-channel relays.
- SRT ingest without stream IDs: one unique UDP listener port per channel.
- WebRTC media: `:8189/udp` by default, with optional TCP fallback.
- RTP: independent channel ports selected from a configured range.
- MediaMTX API, metrics, WHEP HTTP, and internal RTSP bind to loopback and are not exposed to the LAN.
- Gateway health uses a separate private loopback listener on `127.0.0.1:18080` so management can bind only to a LAN interface without failing container health checks.

The management binding is loaded when Gateway starts, and its UI exposes active, desired, and resolved state until a required restart. A followed management interface triggers a graceful Gateway restart when its address changes. The media binding applies live to direct SRT, per-channel SRT, RTP unicast, and WebRTC ICE listeners; followed media interfaces are re-resolved during reconciliation and constrain interface-derived ICE candidates. RTP multicast retains channel-specific group/interface semantics, and SRT pull remains outbound.

The Gateway reverse-proxies WHEP `OPTIONS`, `POST`, `PATCH`, and `DELETE` requests. Consumers use one stable application URL regardless of whether a channel is direct or transcoded.

## Configuration Model

### Global Settings

- Log level and statistics interval.
- Read/write timeouts, UDP receive buffer, and output queue size.
- Management and media bind interfaces, media listener ports, and RTP port range.
- Advertised LAN host and WebRTC UDP/TCP settings.
- Default maximum viewers.
- Automatic compatibility-transcoding defaults.

### Channel Settings

- Stable ID, display name, enabled state, and generated media path.
- Input mode: RTP unicast, RTP multicast, SRT push, or SRT pull.
- RTP address, port, source filter, interface, and SDP.
- SRT push mode, per-channel listener port, passphrase, optional elementary-RTP SDP, and connection settings. Stream-ID-capable MPEG-TS senders may publish directly to the global MediaMTX listener.
- SRT pull endpoint, stream ID, passphrase, optional elementary-RTP SDP, and connection settings.
- Maximum viewers and timestamp behavior.
- Persisted automatic dashboard-preview preference, enabled by default.
- Automatic compatibility state and future encoder overrides.

Settings and complete channel updates use optimistic revision checks. A stale `If-Match` precondition is rejected rather than overwriting a newer saved generation; preview-only changes do not require a full replacement payload.

Dynamic elementary RTP cannot be completely auto-discovered because payload types require codec mappings. RTP channel inputs require SDP, while SRT uses an optional raw SDP editor: no SDP selects automatic raw MPEG-TS or RTP/MP2T detection, and supplied SDP selects elementary RTP.

## WebRTC Compatibility

MediaMTX can route AV1, VP9, VP8, H265, H264, Opus, G722, and G711 to WebRTC, but browser support varies. H265, AAC audio, unsupported codecs, and H264 containing B-frames require special handling.

The Gateway classifies each live SRT source after MediaMTX exposes complete track metadata. Complete, self-consistent Baseline or Constrained Baseline H264 stream metadata can establish progressive browser-compatible input immediately because these profiles exclude B-frames; other profiles and ambiguous metadata fall back to frame sampling for B-frames, pixel format, and interlace structure. Compatible inputs remain direct with no FFmpeg process. Incompatible video is converted to low-latency progressive H264 without B-frames while preserving source cadence and forcing one-second keyframes; conventional interlace uses `bwdif` send-field output and alternating HEVC field pictures are woven before deinterlacing. Incompatible audio is converted to Opus, and already-compatible tracks are copied when only another track requires conversion. Stable source-generation fingerprints prevent late metadata enrichment from restarting classification or workers. CPU-only workers use bounded decoder/encoder threads and resolution-based VBV ceilings. Send-field output consumes twice the normal resolution-based capacity, and weighted admission queues excess workers instead of allowing unbounded process contention.

## Statistics

### Always Available

- Channel state, uptime, source protocol, and remote endpoint.
- Input/output byte totals and calculated bitrate.
- Packet/frame errors, loss, drops, retransmissions, and discarded output frames where available.
- SRT RTT, receive delay, late packets, and buffer state.
- WebRTC viewer count and aggregate output counters.
- Codec, profile, dimensions, sample rate, and channel count where MediaMTX exposes them.
- Compatibility worker state and restart/error information.

### Preview Only

- Per-track bitrate, codec, resolution, and frames per second.
- Frames decoded/dropped, packets received/lost, and jitter.
- ICE connection and selected candidate information where available.

Preview traffic is included in aggregate viewer and output statistics. MediaMTX does not expose continuous input FPS or per-track bitrate for every codec; the initial release will not add an always-on probe solely to synthesize these values.

## UI

- Responsive channel list with online, degraded, incompatible, disabled, and apply-error states.
- Create, duplicate, rename, configure, enable, disable, and delete channel actions.
- Channel overview with grid/list layouts and a separate channel detail workspace for input, output, listener, preview, media-track, and health information.
- Persisted automatic-preview control, on by default. Eligible visible grid cards and channel detail use muted autoplay; list mode does not preview. Sessions are cleaned up when disabled, when their surface closes, or after 30 seconds hidden.
- Bounded serial HTTP status snapshots with failure backoff and hidden-page pause.
- On-demand system and channel diagnostics with a sanitized copyable report and no permanent navigation item.
- Global settings view and clear desired/applied state.
- Copyable SRT publishing instructions, a stable multiview route, gap-filling numbered embed routes, iframe snippets, and stable UUID WHEP URLs.
- Masked secrets in routine responses with explicit non-cacheable retrieval on the trusted management LAN.
- Conditional graceful Gateway restart control when an unlocked management binding has a pending change.

## Milestones

### M0: Media Spike And Repository Foundation

- [x] Record architecture and accepted decisions.
- [x] Create pinned MediaMTX configuration and Linux host-network Compose stack.
- [x] Create Gateway service and serve the initial single-port application.
- [x] Connect Gateway health/status API to MediaMTX.
- [x] Add repeatable RTP and SRT smoke-test instructions or fixtures.
- [x] Prove one supported stream from ingest through WHEP in a browser.

### M1: Persisted Control Plane

- [x] Add SQLite schema and migrations.
- [x] Add validated global settings endpoints.
- [x] Add channel CRUD for all four accepted input modes.
- [x] Implement desired-state reconciliation through the MediaMTX Control API.
- [x] Track pending, applied, and apply-error states.
- [x] Verify state recovery after Gateway and MediaMTX restarts.
- [x] Add supervised per-channel SRT passthrough listeners for senders without stream-ID support.

### M2: Channel UI And Preview

- [x] Build responsive channel switching and configuration forms.
- [x] Implement the same-origin WHEP reverse proxy.
- [x] Add the per-channel automatic muted WebRTC preview.
- [x] Expose browser peer-connection statistics.
- [x] Show codec compatibility warnings and generated connection instructions.

### M3: Observability And Robustness

- [ ] Aggregate path, SRT, and WebRTC runtime statistics.
- [ ] Calculate rates safely across reconnects and counter resets.
- [x] Poll status snapshots serially over bounded HTTP with failure backoff and hidden-page pause.
- [ ] Validate host socket-buffer limits and report actionable warnings.
- [x] Add bounded retries, health checks, graceful shutdown, and channel isolation tests.

### M4: Automatic Compatibility Transcoding

- [x] Add FFmpeg to the Gateway runtime image.
- [x] Supervise one process per incompatible SRT channel.
- [x] Publish H264/Opus compatibility paths with low-latency defaults.
- [x] Keep stable WHEP URLs when switching direct/compatibility modes.
- [x] Verify worker failure does not affect unrelated or direct channels.

### M5: Release Hardening

- [x] Add browser and Docker Compose integration tests.
- [ ] Test RTP unicast/multicast and SRT push/pull recovery.
- [ ] Document deployment, backup/restore, diagnostics, and upgrades.
- [x] Add image resource guidance and version upgrade policy.
- [x] Add a cabled-LAN low-latency profile with explicit SRT delay, bounded writer/viewer queues, bridge buffer reuse, and CPU headroom.
- [ ] Complete the acceptance checklist below.

## Acceptance Checklist

- [x] `docker compose up` starts a usable system.
- [x] The UI and all management functions are available on one HTTP port.
- [x] All accepted input modes can be configured from the UI.
- [x] Supported streams reach WebRTC without a Gateway transcoder running.
- [x] Preview connects only on eligible visible overview grid cards or channel detail when the persisted automatic-preview preference is enabled; list mode creates no preview readers.
- [x] Multiple channels and viewers operate independently.
- [ ] Editing one channel does not interrupt unrelated channels.
- [x] Configuration survives restarts and reconciles into MediaMTX.
- [x] Input interruption and reconnection are reflected correctly.
- [ ] Live statistics handle reconnects and counter resets.
- [x] Compatibility mode affects only its channel.
- [x] Restarting Gateway does not stop existing direct media paths.
- [x] Dashboard overview/detail navigation, dialogs, and compact help are keyboard accessible and responsive.
- [x] Gateway-container and host CPU/RAM degrade without affecting status or health.
- [x] Technical options and metrics provide keyboard-, pointer-, and touch-accessible help.
- [ ] Chrome and Firefox LAN playback are covered by automated tests.

## Progress Log

| Date | Change |
| --- | --- |
| 2026-08-22 | Architecture decisions recorded and implementation started. |
| 2026-08-22 | Added the pinned MediaMTX host-network stack, Go Gateway, React UI shell, runtime channel status, same-origin WHEP proxy, tests, and deployment documentation. |
| 2026-08-22 | Verified healthy containers, WHEP `OPTIONS` forwarding, and an H264 SRT feed on `demo`; MediaMTX reported the channel online with Baseline H264 track metadata. |
| 2026-08-22 | Added and verified the H264 RTP smoke path on `22000/udp`; both RTP and SRT fixtures now produce channel and track insight through the single-port Gateway API. |
| 2026-08-22 | Added SQLite-backed desired state, validated CRUD for all four input modes, masked SRT secrets, stable UUID WHEP routes, apply-state reporting, and automatic reconciliation after either service restarts. |
| 2026-08-22 | Added responsive create/edit/delete channel forms and verified desktop/mobile rendering, live SRT and RTP ingest, validation failures, and MediaMTX path restoration after restart. |
| 2026-08-22 | Added persisted global settings APIs and responsive UI, MediaMTX global reconciliation, configured RTP range enforcement, and no-op comparison that avoids media interruption on Gateway restart. |
| 2026-08-22 | Added the requirement and design for SRT senders that expose only destination IP and port: each such channel receives a dedicated listener backed by a supervised passthrough relay into MediaMTX. |
| 2026-08-22 | Implemented per-channel SRT listener ports with conflict validation, supervised no-transcode relays, sender-aware online/offline lifecycle, restart recovery, UI connection instructions, and live H264 verification without a stream ID. |
| 2026-08-22 | Added the opt-in WHEP preview, browser peer statistics, codec compatibility guidance, and WHEP session cleanup; verified live H264 playback and reader removal in Chromium using the configurable TCP ICE fallback. |
| 2026-08-22 | Added automatic SRT compatibility classification, bounded H264 B-frame probing, isolated FFmpeg workers, per-track copy/transcode selection, stable WHEP route affinity, worker/output status, and automatic cleanup. Verified H264 Main/AAC conversion to H264 Baseline/Opus and zero-worker passthrough for compatible H264/Opus. |
| 2026-08-22 | Added browser-backed SRT payload and resilience suites. Verified 19 supported payload/transport cases, encrypted SRT pull, codec changes across reconnects, four concurrent viewers, worker recovery and isolation, Gateway/MediaMTX restart recovery, stable direct media across a Gateway restart, and explicit timeout handling for MediaMTX's 192 kb/s AC-3 framing boundary. Documented measured resource use. |
| 2026-08-23 | Added persisted management/media interface selectors, live host interface discovery, restart-aware management state, live SRT/RTP/WebRTC rebinding, loopback-only health, legacy listener migration, and responsive binding controls. |
| 2026-08-24 | Changed interface selections from fixed IP persistence to interface-and-family following, with DHCP reconciliation, automatic management restart, resolved binding status, and MediaMTX ICE interface filtering. |
| 2026-08-23 | Added the fixed operator connection workspace, default-on per-channel muted preview, explicit SRT passphrase reveal, stable viewer/embed routes and iframe output, focused runtime status, and conditional graceful Gateway restart through the Compose restart policy. |
| 2026-08-23 | Added packet-preserving SRT transport adaptation with automatic raw MPEG-TS and RTP/MP2T detection, SDP-described elementary RTP for SRT push and pull, structural H264/interlace probing, send-field deinterlacing, 576i and RTP browser fixtures, and MPEG-TS-only labeling for the direct stream-ID shortcut. |
| 2026-08-23 | Added the cabled-LAN low-latency defaults: explicit 60 ms SRT ingest, 4 MiB bridge receive buffers with reusable packet storage, 512-packet writer queues, finite new-channel viewer admission, faster compatibility startup, and reserved routing CPU headroom. Retained the internal format-neutral SRT publisher after RTSP stream-copy validation rejected valid MPEG-TS AAC inputs. |
| 2026-08-24 | Added a persisted collapsible dashboard rail, cgroup-v2 Gateway and whole-host resource telemetry, a compact resource footer with explicit isolation boundaries, and accessible technical tooltips across settings and live readouts. |
| 2026-08-24 | Replaced channel switching in the shared viewer with simultaneous all-channel multiview and reduced per-channel embeds to transparent, muted, control-free video surfaces. |
| 2026-08-24 | Added persistent, gap-filling channel numbers for compact `/embed/NUMBER` routes and exposed each channel embed URL as a copyable/openable dashboard field. |
| 2026-08-25 | Added overview grid/list navigation, bounded serial polling with hidden-page lifecycle handling, optimistic revision preconditions, preview-only PATCH updates, and on-demand sanitized diagnostics. |
| 2026-08-25 | Bounded compatibility metadata probing and moved FFprobe off the reconciliation loop. Added a stream-copy MPEG-TS remux stage for Gateway-managed SRT so malformed codec metadata and multi-frame AC-3 PES payloads are normalized before MediaMTX. |
| 2026-08-26 | Reduced managed-input startup latency with bounded MPEG-TS analysis, event-driven fresh MediaMTX discovery, guarded H264 metadata classification, and 500 ms automatic-preview startup polling. |
| 2026-08-26 | Re-anchored converted compatibility output to Gateway time while preserving the channel setting on original paths, avoiding the RTSP publisher's five-second wait for a usable periodic sender report. |
| 2026-08-26 | Lowered the cabled-LAN SRT default to 20 ms, added direct H264 Baseline/no-B-frame/Opus sender guidance, and requested minimum browser jitter buffering through the standardized receiver hint with a safe unsupported-browser fallback. |
| 2026-08-26 | Added signature-fast Matroska/WebM over managed SRT through a loopback Enhanced RTMP stream-copy bridge, metadata-only VP9 Profile 0 admission, and structured runtime input issues that persist through listener recovery and clear when valid media starts. |
