# WebRTC Gateway

WebRTC Gateway routes independently configured RTP and SRT inputs to WebRTC. MediaMTX provides the media data plane; a single-port Gateway application provides the UI, API, status, and WHEP signaling proxy.

Live SRT sources are classified automatically. Inputs that are already suitable for WebRTC stay on the direct MediaMTX path without an FFmpeg process. Incompatible video or audio is normalized through an isolated compatibility worker while the public WHEP URL remains unchanged.

Development status and architecture decisions are tracked in [PLAN.md](PLAN.md).

## Requirements

- Linux host
- Docker Engine with Docker Compose
- An available TCP port `8080`
- An available loopback TCP port `18080` for the private container health check
- Available UDP ports `8189`, `8890`, and the configured RTP and SRT channel ports
- Available TCP port `8189` for the default WebRTC ICE fallback

The Compose stack uses host networking intentionally. This keeps the UDP path direct and supports RTP multicast and explicit network-interface selection.

## Start

```sh
docker compose up --build
```

Open `http://HOST_IP:8080`. The UI, management API, status endpoints, and WHEP signaling are all served on this port.

### Offline Deployment

Every push to `main` runs the `CI and offline image` GitHub Actions workflow. After its checks pass, the workflow updates the public `main-latest` prerelease. Its bundle can be downloaded without a GitHub account. The per-commit Actions artifact remains available as an authenticated backup.

Download, verify, and extract the bundle on a connected machine:

```sh
curl --fail --location --remote-name \
  https://github.com/magnusoverli/webrtc-gateway/releases/download/main-latest/webrtc-gateway-offline-linux-amd64.tar
curl --fail --location --remote-name \
  https://github.com/magnusoverli/webrtc-gateway/releases/download/main-latest/webrtc-gateway-offline-linux-amd64.tar.sha256
sha256sum --check webrtc-gateway-offline-linux-amd64.tar.sha256
mkdir webrtc-gateway-offline
tar --extract --file webrtc-gateway-offline-linux-amd64.tar \
  --directory webrtc-gateway-offline
```

The bundle contains the Gateway image, the pinned MediaMTX image, the Compose configuration, the exact source commit, checksums, and deployment instructions. Copy the extracted directory to the offline Linux AMD64 server, enter it, and run:

```sh
sha256sum --check SHA256SUMS
docker load --input images-linux-amd64.tar.gz
docker compose up -d --no-build --pull never
```

The `--no-build --pull never` options guarantee that deployment uses only the transferred images. Loading a newer bundle updates the local `webrtc-gateway:main` tag; running the same Compose command recreates the Gateway container while preserving its named state volume. The exact build is recorded in `GATEWAY_COMMIT`.

### Operator Workflow

1. Create a channel and select its input mode. **SRT push** is the simplest option for encoders that accept a destination IP and port.
2. Use each overview card or list row’s On/Off switch to enable or disable channel ingest on the Gateway. On means enabled even while waiting for input; switching Off stops Gateway processing, not the upstream encoder. Open a channel for its detail workspace, with encoder connection details, listener state, stable output links, and an optional muted WebRTC preview.
3. Use the copy controls for the encoder URL, destination IP and port, passphrase, direct stream-ID URL, viewer URL, iframe snippet, or WHEP endpoint. Values that do not apply to the channel input show `-`.
4. Send the stable multiview URL to LAN users or copy the channel's embed URL or iframe snippet into another LAN application. Embed URLs use the channel number and do not change when that channel is renamed or switches between direct and compatibility output.

### Projects

Open **Projects** to save the complete applied Gateway configuration as a named snapshot. Saving a project does not change listeners, channels, sources, or viewers. A project contains all UI-managed global settings and channels, including stable channel IDs, numbers, paths, and SRT passphrases. Projects can be renamed, updated from the current configuration, deleted, exported, and imported. Importing stores a project without loading it.

Loading a project replaces the running desired configuration and can interrupt inputs and viewers. Gateway validates the complete snapshot first, removes the previous runtime resources, and applies the project's global settings and channels. If cleanup or application fails, Gateway automatically restores and reapplies the previous configuration and reports whether rollback succeeded. Relevant service logs are available through `docker compose logs gateway` and `docker compose logs mediamtx`.

Project files are versioned JSON and contain plaintext SRT passphrases. Treat them as sensitive credentials, transfer and store them accordingly, and delete copies that are no longer needed. Container-owned deployment values such as the state path, private health listener, internal MediaMTX URLs, compatibility worker capacity, and memory/PID limits are not part of a project.

The management interface and Web UI/API port are included. When loading a project changes either, the dashboard reports the exact pending origin and requires a Gateway restart. The existing restart control acknowledges the request before navigating the browser to the new origin. An explicit host in `GATEWAY_LISTEN_ADDR` remains deployment-locked and cannot be overridden by a project.

The multiview and channel embed routes are:

```text
http://HOST_IP:8080/view
http://HOST_IP:8080/embed/CHANNEL_NUMBER
```

The multiview uses a responsive grid: four columns on wide windows, then three, two, or one as space narrows, targeting at least 280 pixels per tile. The familiar three-row desktop layout remains where it fits. Narrow or short windows scroll the tiles vertically instead of squeezing their video area, while the navigation toolbar stays available. Page membership remains based on the saved four-by-three arrangement (up to 12 default-size channels); resizing the window neither changes pages nor reconnects players. Wider saved tiles temporarily fit the available columns and regain their size when the window widens. Previous/next controls switch pages, closing the outgoing page's players and opening ready channels on the selected page. Offline, disabled, and error channels keep their tiles. The channel set refreshes automatically. Drag a tile by its title bar onto another tile or a page button to reorder it, or click the title bar to choose a position using the keyboard or touch. Resizing the browser during a drag cancels that drag. The size-reset button remains independently clickable. Order and sizes are saved in this browser for the current Gateway origin, not shared between users or included in project snapshots. New channels are appended and deleted channels removed. Legacy `/view/CHANNEL_ID` links open the same multiview. Each channel receives the lowest available positive number, producing compact URLs such as `http://192.168.15.5:8080/embed/1`. Existing channels keep their number, but deleted numbers become available for reuse. The embed route renders only muted video with no header, status overlay, native controls, border, or opaque background. Previously issued UUID embed URLs remain valid aliases for their existing channels.

While dragging, a level, actual-size translucent tile follows the pointer using one captured video frame (or the tile's text status when no frame is available). Its reserved grid position is invisible. A neighbor is displaced only when its unanimated slot overlaps strictly more than half the smaller of the preview and neighbor areas, regardless of handle position. Other tiles animate into the proposed positions without restarting their players. The proposal stays in place through gaps and partial overlaps; dropping with the preview center inside any occupied tile slot (including its invisible reserved slot) saves it. Escape, a cancelled pointer, or dropping with the preview center outside those slots restores the arrangement. Page buttons instead use the pointer position: hover highlights the destination without opening its players before drop. Reduced-motion preferences disable layout animation. The preview never creates an extra WebRTC session or video decoder.

Drag any tile edge to resize it smoothly, or drag a visible corner grip to resize width and height together. Standard mouse/touch resizing is provided by `react-resizable`, from the default 1×1 up to 4×3, including any intermediate size. The tile follows the pointer without snapping; the underlying 4×3 grid reserves every cell it touches, moving neighbours as soon as the tile outgrows its slot. Tiles reflow in saved order and overflow onto subsequent pages; resizing a late tile can move it to the next page. Exact sizes are saved in this browser on release. Escape cancels a resize, and the tile's **1×1** button restores its default size. Keyboard users can focus an edge or corner and use its horizontal or vertical arrow keys for 0.1-cell adjustments, or hold Shift for whole cells. Double-click the video or press Enter on a focused video to expand the existing player; Escape or the exit button shown only in fullscreen returns to the grid without changing its saved size. An in-page fullscreen view is used when native browser fullscreen is unavailable.

Multiview, embed, and channel-detail playback start muted to satisfy desktop browser autoplay rules. Each ready channel in multiview creates an independent WebRTC reader. Automatic channel-detail preview and source timestamp preservation are enabled by default and stored per channel; either can be disabled for a source that requires different behavior. Timestamp preservation applies to the original path when its input protocol supplies usable absolute time. Compatibility output is re-anchored to Gateway time after conversion because FFmpeg creates a new output timeline; this also lets converted playback start without waiting for a periodic RTCP timestamp report. The overview shows input configuration, status, format, bitrates, and viewers in grid or list form without opening any playback sessions. A channel detail can open its own preview. Embed routes always attempt playback when output is ready.

Dashboard, multiview, and focused embed status use bounded serial HTTP polling: one request completes before the next starts, failures back off, and polling pauses while the page is hidden. Each surface starts and force-refreshes through its existing full endpoint, then uses additive compact runtime endpoints (`/api/v1/status/runtime`, `/api/v1/channels/runtime`, and `/api/v1/channels/CHANNEL_ID/runtime`) while channel and settings revisions match. A revision or channel-set mismatch fetches and validates a full snapshot in the same polling task before replacing displayed state. Compact channel responses contain counters, generation markers, tracks, compatibility, relay/apply state, and reader counts, but not channel configuration, SDP, or reader identities. Preview retry and statistics work pauses immediately; established media sessions receive a 30-second grace period before closing if the page remains hidden. Returning to the page refreshes status and reconnects eligible previews.

SRT passphrases remain masked in normal channel and status responses. A channel can explicitly retrieve and copy its current passphrase through a non-cacheable API request. The deployment is intended for a trusted internal LAN and does not add authentication to management, player, passphrase, or restart endpoints.

Multiview tiles have no native player controls and remain muted. Their audio meters overlay L/R bars and a scale on the video, analyzing decoded browser audio independently of video muting: RMS from -60 to 0 dBFS, a one-second sample-peak hold, and a near-full-scale indicator at -0.5 dBFS. These are sampled level meters, not true-peak or LUFS measurements. Meters start automatically; if browser autoplay policy requires a user gesture, an ordinary click, tap, or keypress on the page resumes analysis. Players request Opus stereo reception; the two slots measure the first two decoded channels, not proof of a stereo source. The meter uses discrete splitting without artificial duplication, but Chrome can upmix a mono track before WebAudio analysis, making both slots move identically. Initial remote-track channel counts are not reliable, and upstream or browser downmix can still differ from source audio. Missing audio, suspended analysis, and unavailable metering leave inactive bars with explanatory accessible values rather than a false silence reading or on-video status text. A video-only source cannot produce meter activity, even if WHEP negotiates a placeholder audio track. Analysis pauses when hidden and releases tile resources on page changes.

### Dashboard Help And Diagnostics

The dashboard keeps primary navigation compact and leaves operational warnings or instructions that affect connectivity and restarts visible inline. Technical settings, stream statistics, resource figures, status terms, and icon-only controls use help text or tooltips that work with pointer hover, keyboard focus, and touch. Motion is reduced when the browser requests reduced motion.

Channel detail includes a compact **Channel health** panel using the existing status/runtime polling and preview receiver state, without additional requests or log streaming. It explains structured input rejections, configuration and relay failures, compatibility output problems, and cumulative input parse errors, with next steps and up to three expanded issue cards. Technical details expose available issue timestamps/counts and retry information, not free-form errors, connection URLs, or SDP. Browser connection failures and cumulative receiver loss/drop counters are explicitly browser-only observations, not diagnoses of source stutter. Failed status polls mark the snapshot stale. Input issues remain unresolved until the gateway clears them after accepting replacement input; cleared issues are removed, not retained as a fabricated recovery history.

System and per-channel diagnostics remain on-demand. Opening a diagnostics dialog makes one bounded request to `GET /api/v1/diagnostics`; failures and timeouts can be retried. The displayed and copyable report contains only allowlisted runtime, revision, listener, resource, relay, and compatibility fields. It excludes passphrases, input configuration, and unrecognized response fields. Channel health is a current structured snapshot, not a history of the shared Docker logs.

### Resource Monitoring

The resource display samples CPU and RAM once per second and reports two explicitly scoped rows:

- **Gateway** is the complete Gateway container cgroup, including the Go application, compatibility FFmpeg/FFprobe workers, per-channel SRT relays, and transient health-check processes. CPU is shown as a percentage of the logical CPU capacity available to the container. RAM is the cgroup working set, excluding inactive file cache, compared with its configured limit when finite.
- **Host** is whole-host CPU busy time and Linux used memory calculated from `MemTotal - MemAvailable`. It includes every workload on the server, not only this Compose stack.

MediaMTX runs in a separate PID and cgroup namespace and does not expose process CPU or resident memory through its metrics endpoint. Its CPU/RAM are therefore intentionally excluded rather than estimated. Gateway does not receive the Docker socket, host PID namespace, privileged mode, or a broad host-cgroup mount. The host row still provides overall capacity and pressure context.

Resource sampling requires Linux cgroup v2 for Gateway-container figures. The sampler resolves the Gateway's own cgroup and any ancestor limits visible inside its private cgroup namespace without mounting the host cgroup tree into the container. The configured Gateway limit remains visible; limits on hidden host ancestors are intentionally not exposed. Unsupported or temporarily unreadable sources appear as unavailable or stale without failing channel status, playback, or health checks. A warming state means the current memory gauge is valid while CPU waits for a second counter sample. Each scope carries its own successful sample time and CPU window so retained stale values are not presented as newly sampled.

Compatibility normalization is bounded by startup configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_COMPATIBILITY_ENCODER_THREADS` | Smaller of 6 or the logical CPU count | Decoder and H264 encoder threads per video worker |
| `GATEWAY_COMPATIBILITY_CAPACITY` | 75% of logical CPUs, rounded down | Total worker capacity units; the remaining CPU headroom is reserved for ingest, routing, WebRTC, and the host |
| `GATEWAY_MEMORY_LIMIT` | `8g` | Gateway container memory safety limit |
| `GATEWAY_PIDS_LIMIT` | `2048` | Gateway container process/thread safety limit |
| `GATEWAY_LISTEN_ADDR` | `:8080` | Initial public management address; a non-wildcard host overrides and locks the UI-selected management interface and port |
| `GATEWAY_HEALTH_LISTEN_ADDR` | `127.0.0.1:18080` | Private health listener used by Docker Compose |

These values are applied when the Gateway container starts. If worker capacity is occupied, additional incompatible sources remain in a visible queued state and start automatically when capacity is released. An individual worker larger than the configured capacity is allowed to run alone.

Media ports remain separate:

| Purpose | Default |
| --- | --- |
| Web application and WHEP signaling | `8080/tcp` |
| WebRTC ICE media | `8189/udp` |
| WebRTC ICE fallback | `8189/tcp` by default |
| Direct SRT ingest with stream IDs | `8890/udp` |
| SRT ingest without stream IDs | Per-channel UDP port |
| RTP ingest | Per-channel UDP port |

MediaMTX API, metrics, WHEP HTTP, and internal RTSP bind to host loopback and are not exposed to the LAN.

### Network Bindings

Open **Global settings** to select bindings independently for the management and media planes. Each live address is offered as a **Follow interface** option containing the interface name, current IP address, and address family. Following an interface persists its name and address family instead of freezing its current DHCP address. Existing concrete-IP settings remain available as **Fixed address** selections, and **All interfaces** remains the default. The **Use the same interface** control keeps both selections together when that is appropriate.

Following is offered only when an interface has one usable address in the selected family. When aliases or multiple IPv6 addresses make the choice ambiguous, select the required fixed address instead of allowing Gateway to switch addresses implicitly.

- **Web UI & API interface** controls the Gateway UI, API, status, and WHEP signaling listener on port `8080`. Changing the selection requires a Gateway container restart. When a followed interface receives a different address, Gateway detects it and restarts gracefully so Docker can bring it back on the new address.
- **Media interface** controls direct SRT, per-channel SRT push listeners, RTP unicast, and WebRTC ICE UDP/TCP. Changes apply immediately, restart affected listeners, and can briefly interrupt active channels. A followed interface is resolved during reconciliation, so a DHCP address change automatically reapplies MediaMTX and channel listeners.
- RTP multicast keeps its per-channel multicast group and multicast interface. SRT pull is outbound and is not affected by the listener binding.
- Following a media interface also limits interface-derived WebRTC ICE candidates to that interface, preventing Docker bridge addresses from being advertised. Explicit additional advertised hosts remain separate and are not filtered.

An explicit host in `GATEWAY_LISTEN_ADDR`, such as `127.0.0.1:8080`, overrides and locks the management selector and port. The default `:8080` supplies initial values while allowing persisted management interface and port selections to take effect after restart. MediaMTX control services and Gateway health remain on loopback regardless of either public selection.

When an unlocked management-interface change is pending, the UI shows **Restart Gateway**. This sends a graceful restart request after acknowledging it to the browser, then Docker's `restart: unless-stopped` policy starts Gateway on the desired interface. MediaMTX continues running and direct media paths remain available during the Gateway restart. No restart control is shown when `GATEWAY_LISTEN_ADDR` locks the management host because persisted interface changes cannot override that environment setting.

## SRT Smoke Feed

Create an enabled **SRT push** channel in the UI and assign it an unused sender destination port, such as `10000`. The channel detail view shows the sender destination. Senders need only the Gateway IP and this port; no SRT stream ID is required.

With FFmpeg installed on the host, publish a browser-compatible H264/Opus test pattern to the per-channel listener:

```sh
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline \
  -pix_fmt yuv420p -bf 0 -g 30 \
  -c:a libopus -application lowdelay -frame_duration 10 -b:a 96k -ac 2 \
  -f mpegts "srt://HOST_IP:10000?latency=20000"
```

Gateway starts a supervised `srt-live-transmit` listener with a 20 ms cabled-LAN latency default, a 4 MiB receive buffer, three-second peer-idle detection, and one-second connection timeout. Increase the per-channel latency for lossy or long-distance links. FFmpeg's SRT `latency` URL value is expressed in microseconds, so `20000` matches the Gateway's 20 ms setting. Gateway classifies each SRT message before routing it into MediaMTX. Raw MPEG-TS and RTP/MP2T are remuxed by FFmpeg to normalize transport headers, codec metadata, and PES framing. A one-second startup snapshot is discovered with FFprobe (16 MiB snapshot, three-second probe timeout, 32 MiB total retained input); all retained bytes are replayed in order. Incomplete or oversized discovery fails visibly and retries instead of guessing track codecs. Elementary RTP is forwarded directly over loopback UDP. Internal publishers exist only while a sender is active, and the listener recovers automatically after disconnects and Gateway restarts.

SMPTE 302M (BSSD) audio must be converted before MediaMTX, whose native MPEG-TS reader otherwise drops it. Only discovered 302M PIDs are encoded as 48 kHz stereo Opus, one output per input track; a 2/4/6/8-channel 302M track uses its first two channels as the monitor pair. Video and other audio (including AAC, AC3 surround and existing Opus) remain stream-copy, with source timestamps retained. PID-based required maps preserve mixed-track ordering without codec-selection guesses. Discovery runs once per source connection; reconnect after changing the program map. Direct stream-ID publishing bypasses this conversion and still cannot expose 302M audio.

Senders that support stream IDs can alternatively use the direct MediaMTX SRT URL shown in the channel view. Direct publishing uses the global SRT listener, `8890/udp` by default, and a stream ID in the form `publish:CHANNEL_PATH`. This shortcut terminates in MediaMTX's native MPEG-TS SRT reader and is therefore MPEG-TS-only.

The UI reports the channel online and displays the detected H264 profile and dimensions. Automatic preview creates a muted WHEP reader for an open channel detail and displays receive bitrate, codec, resolution, frame rate, packet loss, jitter, ICE path, and decoded or dropped frames. The player requests the browser's minimum supported jitter-buffer target; browsers can clamp this upward for current network conditions, and browsers without the standardized receiver hint retain their adaptive default. While a visible channel detail is waiting for automatic-preview output, compact runtime status is checked every 500 ms; steady-state polling returns to the configured statistics interval. Disabling automatic preview or leaving the surface closes the peer connection and deletes its WHEP session; a session also closes after the page remains hidden for 30 seconds.

WebRTC media prefers UDP and also exposes a TCP fallback on the same port by default. Configure or disable the **WebRTC TCP fallback port** in **Global settings**, and allow the selected media interface and configured UDP/TCP ports through the host firewall. TCP and UDP can use the same port number.

## Automatic SRT Compatibility

### SRT Payload Framing

Per-channel SRT push and pull inputs accept these transport payloads:

| SRT payload | Configuration | Routing |
| --- | --- | --- |
| Raw MPEG-TS | No SRT SDP | Detected automatically and relayed to the MediaMTX MPEG-TS publisher |
| Matroska / WebM | No SRT SDP | Detected from the EBML header and stream-copied through private Enhanced RTMP |
| RTP/MP2T, payload type 33 | No SRT SDP | Detected automatically; the RTP header is removed and MPEG-TS is relayed to MediaMTX |
| Elementary RTP | SRT SDP required | Each validated RTP packet is forwarded to a MediaMTX RTP source according to its payload type |

The elementary-RTP tunnel expects one complete RTP or RTCP packet per SRT message. Its SDP can describe one video and one audio media section, with one unique payload type per section. Payload types `64-95` are rejected because an RTP marker bit makes them ambiguous with RTCP packet types in this framing; RTCP is otherwise recognized and dropped. Dynamic elementary payloads cannot be inferred reliably, so receiving elementary RTP without an SDP is rejected instead of guessing a codec. Packets whose payload type is absent from the SDP and unknown payload containers are also rejected explicitly. Active input and media-bridge issues remain visible in channel status, the dashboard, viewers, and diagnostics until MediaMTX accepts a valid replacement input.

Matroska uses a four-byte signature check and an explicit low-analysis FFmpeg demux, then stream-copies the first video and audio tracks into MediaMTX through loopback-only Enhanced RTMP. This path does not decode or encode media and avoids the managed MPEG-TS route's internal SRT latency. VP9 Profile 0 metadata is classified directly without waiting for an FFprobe frame sample. Codec support is limited to combinations accepted by FFmpeg's Enhanced FLV muxer and MediaMTX; unsupported combinations surface as channel input issues.

Each new source generation is inspected from the internal MediaMTX RTSP path. Broadly supported progressive 8-bit 4:2:0 H264 without B-frames, VP8, VP9, AV1, Opus, G722, and G711 tracks remain direct. Complete, self-consistent Baseline or Constrained Baseline H264 stream metadata can establish the common progressive browser-compatible case without a frame scan because these profiles exclude B-frames. Other profiles and missing, unknown, contradictory, interlaced, or incompatible-pixel-format metadata fall back to the structural frame sample.

When conversion is required, Gateway starts one supervised FFmpeg process for that channel and publishes a private compatibility path:

- Unsupported or B-frame video is converted to low-latency H264 Baseline with `-bf 0`, source frame cadence is preserved, and keyframes are forced at one-second intervals.
- Interlaced video is converted to progressive H264 with `bwdif` send-field deinterlacing, so a conventional 25-frame/50-field source produces approximately 50 progressive frames per second. Alternating HEVC field pictures are woven before deinterlacing.
- Decoder and encoder parallelism is bounded, and CRF 23 output uses a resolution-based maximum bitrate with a half-second VBV buffer.
- Unsupported audio such as AAC is converted to stereo Opus.
- A compatible video or audio track is copied when only the other track needs conversion.
- Source disconnects, track changes, channel deletion, and Gateway shutdown stop the worker automatically.
- Worker failure does not fall back to a known-incompatible direct path; the stable WHEP endpoint remains unavailable until compatible output is ready.

Default video rate ceilings are `2 Mb/s` through 480p, `6 Mb/s` through 720p, `16 Mb/s` through 1080p, `24 Mb/s` through 1440p, and `40 Mb/s` above 1440p. These are maximum encoder rates rather than constant target rates, so simple content remains smaller. The VBV buffer is half the selected maximum rate. A managed relay signals the compatibility manager after accepting valid media, invalidates stale MediaMTX runtime status, and checks startup every 100 ms for up to three seconds; the one-second periodic check remains as a fallback. H264 inspection first tries stream metadata and otherwise samples two seconds of frames within one shared four-second budget. Incomplete MediaMTX metadata receives an eight-second grace period before fallback inspection.

The channel view reports whether WebRTC is using **Direct passthrough** or **Automatic H264/Opus compatibility**, including the conversion reasons and output tracks. Classification is intentionally limited to containers and codecs that MediaMTX can ingest and FFmpeg can decode. Send-field deinterlacing is charged at twice the normal resolution-based worker capacity because it encodes twice as many output frames.

### Verified SRT Formats

The integration matrix has been verified through a real headless Chromium WHEP session for each successful case:

| Input | WebRTC route |
| --- | --- |
| H264 Baseline or H264 High without B-frames + Opus | Direct H264/Opus |
| H264 with B-frames + Opus | Video converted to H264; audio copied |
| H264 + AAC or AC-3 | Video copied; audio converted to Opus |
| H265 + Opus | Video converted to H264; audio copied |
| H265 + AAC | Converted to H264/Opus |
| MPEG-2 Video + MP2 | Converted to H264/Opus |
| 576i H264 + Opus at 25 frames/50 fields | Deinterlaced to progressive H264/Opus at approximately 50 fps |
| 576i MPEG-2 Video + MP2 at 25 frames/50 fields | Converted and deinterlaced to progressive H264/Opus at approximately 50 fps |
| MPEG-4 Video + Opus or AC-3 | Converted to H264/Opus |
| H264-only and Opus-only | Direct single-track output |
| H265-only, AAC-only, and MP3-only | Converted single-track output |

The same matrix covers raw MPEG-TS, Matroska, RTP/MP2T, and SDP-described elementary RTP through per-channel SRT push and pull, plus direct MPEG-TS stream-ID publishing, SRT passphrase acceptance and rejection, video-only and audio-only inputs, interlaced inputs, and the supplied MOV source. Gateway-managed MPEG-TS is stream-copy remuxed before MediaMTX so codec headers and PES framing are normalized without changing the encoded media. The resilience suite additionally covers encrypted SRT pull, codec changes across reconnects, worker restart, channel isolation, concurrent viewers, and reader cleanup.

The remux stage emits bounded PES payloads and repeated MPEG-TS headers. This allows MediaMTX `1.21.0` to ingest the verified 192 kb/s AC-3 fixture whose source groups three AC-3 frames into one PES packet. Direct stream-ID publishers bypass Gateway and therefore do not receive this normalization.

### Integration Checks

The scripts create temporary channels, use ports `11990`, `11991`, `11992`, `12010`, and `12011` by default, and remove their channels and processes on exit. They require `curl`, `jq`, FFmpeg, SRT tools, Node.js, and Chromium on the host.

Run the common payload matrix, including browser media assertions:

```sh
bash scripts/srt-matrix.sh
```

Run reconnect, SRT pull, forced worker failure, channel isolation, and concurrent-viewer checks:

```sh
bash scripts/srt-resilience.sh
```

For native audio regression coverage, run `node scripts/audio-meter-browser.mjs` from `web` with Playwright and Chrome available. Set `PLAYWRIGHT_MODULE` to an existing Playwright module path or file URL if it is installed outside this project; `CHROME_CHANNEL` optionally selects another Playwright browser channel. The check starts a local Vite server on port 5174, sends independent tones through real Opus/WebRTC and the WHEP player, verifies silent playback and session cleanup, and records Chrome's mono-upmix behavior. It does not connect to or modify a deployed gateway.

On Linux with the image's FFmpeg/FFprobe installed, `REQUIRE_FFMPEG_TESTS=1 go test -race ./...` also exercises selective 302M ingest with generated eight-pair, mixed/multiprogram, surround, and video-only fixtures, packet-hash/timestamp copy checks, and bounded startup replay/cancellation. No live input or gateway configuration is used.

Run the codec, bitrate, resolution, startup-latency, resource, and browser-throughput benchmark:

```sh
RESULTS_FILE=/tmp/srt-performance-results.jsonl bash scripts/srt-performance.sh
```

Use `CASE_FILTER=elementary` with the payload matrix, or `CASE_FILTER=1080p60`, `RESOURCE_SAMPLES=5`, and `WHEP_SAMPLE_MS=10000` with the performance suite, to focus a run or increase its sampling interval. Docker CPU percentages are relative to one logical CPU. Source-generator CPU is reported separately and is not included in Gateway or MediaMTX container usage.

Set `WHEP_PROBE=0` to run the payload matrix without Chromium, or override values such as `SRT_PORT`, `SRT_PULL_PORT`, `RTP_TUNNEL_PORT`, `SOURCE_FILE`, and `READY_TIMEOUT_SECONDS` when the defaults conflict with the host.

### Reference Resource Use

On a 22-logical-CPU host, the CPU-only performance suite produced these approximate medians. Docker CPU percentages are relative to one logical CPU, and the external FFmpeg source generator is excluded:

| Workload | Gateway CPU / memory | MediaMTX CPU / memory |
| --- | --- | --- |
| No active source, one idle SRT push channel | `0.9%` / `18.0 MiB` | `0.1%` / `55.3 MiB` |
| Direct relay, 1080p30 H264/Opus | `3.2%` / `23.5 MiB` | `2.9%` / `55.1 MiB` |
| Direct stream ID, 1080p30 H264/Opus | `0.9%` / `17.6 MiB` | `3.8%` / `55.9 MiB` |
| Normalized 1080p30 H265/AAC | `65.9%` / `180.1 MiB` | `4.9%` / `56.0 MiB` |
| Normalized 1080p60 H265/AAC | `140.9%` / `185.3 MiB` | `7.4%` / `56.0 MiB` |
| Normalized 2160p30 H265/AAC | `214.2%` / `460.2 MiB` | `11.0%` / `57.1 MiB` |

The direct route has no decoder or encoder. Its Gateway cost is the SRT passthrough relay, while viewer fan-out remains in MediaMTX. Stream-ID-capable senders avoid the per-channel relay process and have the lowest Gateway cost. Four simultaneous 1080p30 H265/AAC workers consumed `273-300%` Gateway CPU and about `849 MiB`, delivered 30 fps per viewer without dropped frames, and became ready in about 3.1 seconds. Twenty-one idle per-channel SRT push listeners consumed about `10.7%` CPU, `40-41.5 MiB`, and 122 container PIDs/threads; Gateway emits a warning at 40 listeners, and direct stream-ID publishing is preferred for large channel counts when senders support it. These historical measurements predate the revised latency and admission defaults; actual use depends on resolution, frame rate, bitrate, source complexity, CPU, and viewer count.

## RTP Smoke Feed

Select the required global **Media interface**, then create an enabled **RTP unicast** channel with UDP port `22000` and this SDP:

```sdp
v=0
o=- 0 0 IN IP4 127.0.0.1
s=WebRTC Gateway RTP input
c=IN IP4 0.0.0.0
t=0 0
m=video 22000 RTP/AVP 96
a=rtpmap:96 H264/90000
a=fmtp:96 packetization-mode=1
```

Publish the same browser-compatible test pattern over RTP:

```sh
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline \
  -bf 0 -g 30 -an -payload_type 96 -f rtp \
  "rtp://127.0.0.1:22000?pkt_size=1200"
```

The UI reports the channel online and exposes a stable UUID-based WHEP signaling URL.

## Persistence

Channel configuration and global settings are stored in the `gateway-state` Docker volume. Gateway reconciles this desired state into MediaMTX and restores per-channel SRT listeners at startup and after a MediaMTX restart. MediaMTX API changes are intentionally not treated as persistent state.

Open **Global settings** in the UI to configure management/media interfaces, transport ports, timeouts, UDP buffering, WebRTC host discovery, the RTP channel port range, status polling, and default viewer limits. Changes to media transport settings cause MediaMTX and per-channel inputs to restart their listeners and briefly interrupt active channels. Management interface changes require a Gateway restart. Application-only changes, including the per-channel automatic-preview preference, and Gateway restarts skip the MediaMTX patch when its effective configuration is already current.

Full settings and channel replacements use their current revision with `If-Match`, so a stale editor is rejected instead of overwriting newer state. The automatic-preview and overview On/Off toggles use narrow `PATCH` requests (`{"automaticPreview": boolean}` or `{"enabled": boolean}`) rather than sending a full channel configuration. Overview switches also send `If-Match` and are unavailable while status is stale, an update is in flight, or the channel is applying or deleting.

Fresh deployments use a cabled-LAN profile: five-second media I/O timeouts, a 512-packet writer queue, a 4 MiB UDP receive buffer, 1452-byte UDP payloads, 20 ms per-channel SRT latency, and a default maximum of 16 readers for new channels. A value of zero still explicitly selects unlimited readers. Persisted channel latency settings and existing per-channel viewer limits are not silently overwritten during upgrades.

To remove containers while preserving configuration:

```sh
docker compose down
```

Do not add `--volumes` unless the channel database should also be deleted.

## Upgrade Policy

MediaMTX is pinned in `compose.yaml`, JavaScript packages are pinned by `web/package-lock.json`, and Go modules are pinned by `go.sum`. Change one runtime dependency group at a time. Before deploying a MediaMTX or FFmpeg upgrade, preserve the `gateway-state` volume, rebuild the images, run all local and integration checks below, and review upstream changes to the Control API, path configuration, accepted codecs, and WHEP behavior. Keep the previous MediaMTX tag available so rollback requires only restoring the prior tag and image; the SQLite desired state is owned by Gateway and is not migrated by MediaMTX.

## Host Buffer Check

The initial MediaMTX configuration requests a 4 MiB UDP receive buffer. Check the host limit with:

```sh
sysctl net.core.rmem_max
```

If it is lower than `4194304`, raise it according to the host operating system's persistent sysctl configuration. The application will later report this condition in the UI.

## Local Checks

Use Linux, Go `1.27.1` or newer, and Node.js `26` to match the CI and image-build toolchains.

```sh
go test -race ./...
go vet ./...
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
docker compose config
docker compose build
bash scripts/srt-matrix.sh
bash scripts/srt-resilience.sh
```
