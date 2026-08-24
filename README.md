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

Every push to `main` runs the `CI and offline image` GitHub Actions workflow. After its checks pass, the workflow uploads an artifact named `webrtc-gateway-offline-linux-amd64-COMMIT_SHA`. Download it from the workflow run's **Artifacts** section on a connected machine, extract it, and copy the complete directory to the offline server.

The bundle contains the Gateway image, the pinned MediaMTX image, the Compose configuration, the exact source commit, checksums, and deployment instructions. On the offline Linux AMD64 server, run these commands from the extracted directory:

```sh
sha256sum --check SHA256SUMS
docker load --input images-linux-amd64.tar.gz
docker compose up -d --no-build --pull never
```

The `--no-build --pull never` options guarantee that deployment uses only the transferred images. Loading a newer bundle updates the local `webrtc-gateway:main` tag; running the same Compose command recreates the Gateway container while preserving its named state volume.

### Operator Workflow

1. Create a channel and select its input mode. **SRT push** is the simplest option for encoders that accept a destination IP and port.
2. Select the channel. Its fixed workspace shows encoder connection details, listener state, stable output links, and a muted WebRTC preview without requiring a separate configuration view.
3. Use the copy controls for the encoder URL, destination IP and port, passphrase, direct stream-ID URL, viewer URL, iframe snippet, or WHEP endpoint. Values that do not apply to the selected input show `-`.
4. Send the viewer URL to LAN users or place the iframe snippet in another LAN application. These UUID-based routes do not change when a channel is renamed or switches between direct and compatibility output.

The standalone player routes are:

```text
http://HOST_IP:8080/view/CHANNEL_ID
http://HOST_IP:8080/embed/CHANNEL_ID
```

Viewer, embed, and dashboard playback start muted to satisfy desktop browser autoplay rules. Automatic dashboard preview and source timestamp preservation are enabled by default and stored per channel; either can be disabled for a source that requires different behavior. Timestamp preservation is propagated to compatibility output paths but does not add custom clock correction or synchronization logic. Only the selected dashboard channel creates a preview reader. Standalone player routes always attempt playback when output is ready.

SRT passphrases remain masked in normal channel and status responses. The selected channel can explicitly retrieve and copy its current passphrase through a non-cacheable API request. The deployment is intended for a trusted internal LAN and does not add authentication to management, player, passphrase, or restart endpoints.

Compatibility normalization is bounded by startup configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_COMPATIBILITY_ENCODER_THREADS` | Smaller of 6 or the logical CPU count | Decoder and H264 encoder threads per video worker |
| `GATEWAY_COMPATIBILITY_CAPACITY` | 75% of logical CPUs, rounded down | Total worker capacity units; the remaining CPU headroom is reserved for ingest, routing, WebRTC, and the host |
| `GATEWAY_MEMORY_LIMIT` | `8g` | Gateway container memory safety limit |
| `GATEWAY_PIDS_LIMIT` | `2048` | Gateway container process/thread safety limit |
| `GATEWAY_LISTEN_ADDR` | `:8080` | Public management port; a non-wildcard host overrides and locks the UI-selected management interface |
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

An explicit host in `GATEWAY_LISTEN_ADDR`, such as `127.0.0.1:8080`, overrides and locks the management selector. The default `:8080` leaves the port under startup configuration while allowing the persisted interface selection to supply its host. MediaMTX control services and Gateway health remain on loopback regardless of either public selection.

When an unlocked management-interface change is pending, the UI shows **Restart Gateway**. This sends a graceful restart request after acknowledging it to the browser, then Docker's `restart: unless-stopped` policy starts Gateway on the desired interface. MediaMTX continues running and direct media paths remain available during the Gateway restart. No restart control is shown when `GATEWAY_LISTEN_ADDR` locks the management host because persisted interface changes cannot override that environment setting.

## SRT Smoke Feed

Create an enabled **SRT push** channel in the UI and assign it an unused sender destination port, such as `10000`. The channel detail view shows the sender destination. Senders need only the Gateway IP and this port; no SRT stream ID is required.

With FFmpeg installed on the host, publish a browser-compatible H264 test pattern to the per-channel listener:

```sh
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline \
  -bf 0 -g 30 -f mpegts \
  "srt://HOST_IP:10000?latency=60"
```

Gateway starts a supervised `srt-live-transmit` listener with a 60 ms wired-LAN latency default, a 4 MiB receive buffer, three-second peer-idle detection, and one-second connection timeout. It classifies each SRT message before routing it into MediaMTX. Raw MPEG-TS and RTP/MP2T use a packet-preserving SRT stream-copy publisher; elementary RTP is forwarded directly over loopback UDP. Neither route decodes or encodes media. Internal publishers exist only while a sender is active, and the listener recovers automatically after disconnects and Gateway restarts. MediaMTX's native SRT receiver currently retains its upstream 120 ms delay because replacing that format-neutral leg with RTSP would reject valid MPEG-TS codec combinations such as in-band AAC.

Senders that support stream IDs can alternatively use the direct MediaMTX SRT URL shown in the channel view. Direct publishing uses the global SRT listener, `8890/udp` by default, and a stream ID in the form `publish:CHANNEL_PATH`. This shortcut terminates in MediaMTX's native MPEG-TS SRT reader and is therefore MPEG-TS-only.

The UI reports the channel online and displays the detected H264 profile and dimensions. Automatic preview creates a muted WHEP reader for the selected channel and displays receive bitrate, codec, resolution, frame rate, packet loss, jitter, ICE path, and decoded or dropped frames. Disabling automatic preview or changing channels closes the peer connection and deletes its WHEP session.

WebRTC media prefers UDP and also exposes a TCP fallback on the same port by default. Configure or disable the **WebRTC TCP fallback port** in **Global settings**, and allow the selected media interface and configured UDP/TCP ports through the host firewall. TCP and UDP can use the same port number.

## Automatic SRT Compatibility

### SRT Payload Framing

Per-channel SRT push and pull inputs accept these transport payloads:

| SRT payload | Configuration | Routing |
| --- | --- | --- |
| Raw MPEG-TS | No SRT SDP | Detected automatically and relayed to the MediaMTX MPEG-TS publisher |
| RTP/MP2T, payload type 33 | No SRT SDP | Detected automatically; the RTP header is removed and MPEG-TS is relayed to MediaMTX |
| Elementary RTP | SRT SDP required | Each validated RTP packet is forwarded to a MediaMTX RTP source according to its payload type |

The elementary-RTP tunnel expects one complete RTP or RTCP packet per SRT message. Its SDP can describe one video and one audio media section, with one unique payload type per section. Payload types `64-95` are rejected because an RTP marker bit makes them ambiguous with RTCP packet types in this framing; RTCP is otherwise recognized and dropped. Dynamic elementary payloads cannot be inferred reliably, so receiving elementary RTP without an SDP is rejected with an explicit Gateway log message instead of guessing a codec. Packets whose payload type is absent from the SDP and payloads that are neither MPEG-TS nor RTP/MP2T are also rejected explicitly.

Each new source generation is inspected from the internal MediaMTX RTSP path. Broadly supported progressive 8-bit 4:2:0 H264 without B-frames, VP8, VP9, AV1, Opus, G722, and G711 tracks remain direct. All H264 profiles are sampled for B-frames, pixel format, and interlace structure so an interlaced Baseline stream cannot incorrectly bypass normalization.

When conversion is required, Gateway starts one supervised FFmpeg process for that channel and publishes a private compatibility path:

- Unsupported or B-frame video is converted to low-latency H264 Baseline with `-bf 0`, source frame cadence is preserved, and keyframes are forced at one-second intervals.
- Interlaced video is converted to progressive H264 with `bwdif` send-field deinterlacing, so a conventional 25-frame/50-field source produces approximately 50 progressive frames per second. Alternating HEVC field pictures are woven before deinterlacing.
- Decoder and encoder parallelism is bounded, and CRF 23 output uses a resolution-based maximum bitrate with a half-second VBV buffer.
- Unsupported audio such as AAC is converted to stereo Opus.
- A compatible video or audio track is copied when only the other track needs conversion.
- Source disconnects, track changes, channel deletion, and Gateway shutdown stop the worker automatically.
- Worker failure does not fall back to a known-incompatible direct path; the stable WHEP endpoint remains unavailable until compatible output is ready.

Default video rate ceilings are `2 Mb/s` through 480p, `6 Mb/s` through 720p, `16 Mb/s` through 1080p, `24 Mb/s` through 1440p, and `40 Mb/s` above 1440p. These are maximum encoder rates rather than constant target rates, so simple content remains smaller. The VBV buffer is half the selected maximum rate. Compatibility input uses no-buffer/low-delay FFmpeg flags, source discovery checks once per second, active startup checks every 100 ms, and video inspection is bounded to two seconds.

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

The same matrix covers raw MPEG-TS, RTP/MP2T, and SDP-described elementary RTP through per-channel SRT push and pull, plus direct MPEG-TS stream-ID publishing, SRT passphrase acceptance and rejection, video-only and audio-only inputs, interlaced inputs, and the supplied MOV source. The resilience suite additionally covers encrypted SRT pull, codec changes across reconnects, worker restart, channel isolation, concurrent viewers, and reader cleanup.

MediaMTX `1.20.1` rejects the FFmpeg-generated 192 kb/s AC-3 test stream when three 768-byte AC-3 frames are grouped into one MPEG-TS PES packet (`unexpected frame size: got 2304, expected 768`). Gateway reports a compatibility startup timeout and does not expose a broken output. Conventional 384 kb/s AC-3 framing is verified. This is an ingest/framing boundary, not a general promise that every AC-3 stream at either bitrate will behave identically.

### Integration Checks

The scripts create temporary channels, use ports `11990`, `11991`, `11992`, `12010`, and `12011` by default, and remove their channels and processes on exit. They require `curl`, `jq`, FFmpeg, SRT tools, Node.js, and Chromium on the host.

Run the common payload matrix, including browser media assertions and the expected AC-3 rejection:

```sh
bash scripts/srt-matrix.sh
```

Run reconnect, SRT pull, forced worker failure, channel isolation, and concurrent-viewer checks:

```sh
bash scripts/srt-resilience.sh
```

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

Fresh deployments use a wired-LAN profile: five-second media I/O timeouts, a 512-packet writer queue, a 4 MiB UDP receive buffer, 1452-byte UDP payloads, 60 ms per-channel SRT latency, and a default maximum of 16 readers for new channels. A value of zero still explicitly selects unlimited readers. Persisted settings and existing per-channel viewer limits are not silently overwritten during upgrades.

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
