import type { Channel, ChannelIssue } from "./channel";
import type { WHEPPlayerState } from "./useWHEPPlayer";
import type { PreviewStats } from "./webrtc";

const inputIssues: Record<string, { title: string; detail: string; next: string }> = {
  "srt.unsupported_payload": {
    title: "Input format rejected",
    detail: "The SRT payload was not recognized as MPEG-TS, Matroska, or RTP/MP2T.",
    next: "Check the sender's container format. Use MPEG-TS or Matroska, or configure SDP for elementary RTP.",
  },
  "srt.elementary_rtp_requires_sdp": {
    title: "Input needs an SDP description",
    detail: "Elementary RTP was detected without the SDP needed to identify its media.",
    next: "Add the sender's matching SDP in the channel SRT settings, or send MPEG-TS instead.",
  },
  "srt.undeclared_rtp_payload": {
    title: "Input payload does not match SDP",
    detail: "An RTP payload type is not declared in the channel SDP.",
    next: "Match the SDP payload types to the sender's video and audio configuration.",
  },
  "srt.invalid_elementary_rtp": {
    title: "Invalid input RTP packet",
    detail: "The gateway rejected a malformed elementary RTP packet.",
    next: "Check sender framing: each SRT message must contain one complete RTP or RTCP packet.",
  },
  "srt.invalid_rtp_mp2t": {
    title: "Invalid RTP/MP2T input",
    detail: "RTP/MP2T framing or its payload type was rejected.",
    next: "Check the sender's MPEG-TS over RTP framing and payload type 33.",
  },
  "srt.media_bridge_failed": {
    title: "Media bridge failed",
    detail: "The gateway could not bridge the received media into its media plane.",
    next: "Check media-plane availability and the sender's media format in channel diagnostics.",
  },
};

type HealthItem = {
  key: string;
  stage: string;
  label: string;
  title: string;
  detail: string;
  next: string;
  issue?: ChannelIssue;
  facts?: string[];
};

// Free-form status errors are not uniformly redacted. Render only trusted explanations
// and typed facts, never process stderr, connection URLs, or SDP.
export function ChannelHealth({ channel, stale, mediaReachable, preview, onDiagnostics }: {
  channel: Channel;
  stale: boolean;
  mediaReachable: boolean;
  preview: { state: WHEPPlayerState; stats: PreviewStats | null };
  onDiagnostics: () => void;
}) {
  const items: HealthItem[] = [];
  const running = channel.enabled && channel.applyState === "applied";
  const relay = channel.relay;
  const compatibility = channel.compatibility;
  const retrying = running && relay?.state === "retrying";

  if (channel.applyState === "error") items.push({
    key: "configuration", stage: "Configuration", label: "Active", title: "Configuration not applied",
    detail: "The saved channel configuration could not be applied. Playback is not ready.",
    next: "Review channel settings and gateway binding status, then save the corrected configuration.",
  });
  if (running) {
    for (const [index, issue] of channel.issues.entries()) {
      const known = Object.hasOwn(inputIssues, issue.code) ? inputIssues[issue.code] : undefined;
      items.push({
        key: `issue:${index}`, stage: issue.source === "ingest" ? "Source input" : issue.source === "gateway" ? "Gateway bridge" : "Channel",
        label: issue.severity === "warning" ? "Reported warning" : "Unresolved",
        ...(known ?? {
          title: "Channel issue reported", detail: "The gateway reports an issue without a recognized operator explanation.",
          next: "Review the selected channel diagnostics. No cause is inferred from this report.",
        }),
        issue,
      });
    }
    if (relay && ["retrying", "stopped", "starting", "stopping"].includes(relay.state)) items.push({
      key: "relay", stage: channel.input.mode === "srt-pull" ? "SRT pull relay" : "SRT listener",
      label: retrying ? "Retrying" : relay.state === "starting" ? "Starting" : "Unavailable",
      title: retrying ? "Input relay is retrying" : relay.state === "starting" ? "Input relay is starting" : "Input relay is unavailable",
      detail: channel.input.mode === "srt-pull"
        ? "The gateway's SRT caller is not yet receiving through a running relay."
        : "The channel's SRT listener is not currently accepting an input connection.",
      next: retrying || relay.state === "starting"
        ? "Gateway retries automatically. If this persists, check the source, SRT settings, network path, and media binding."
        : "Check channel configuration and gateway diagnostics for relay availability.",
      facts: [
        `Relay restarts: ${safeCount(relay.restarts)}`,
        ...(relay.nextRetryAt && formatTime(relay.nextRetryAt) ? [`Next retry: ${formatTime(relay.nextRetryAt)}`] : []),
        ...(relay.lastError ? ["A relay failure was reported; free-form error text is not displayed."] : []),
      ],
    });
    if (compatibility.state === "error" || compatibility.state !== "ready" && compatibility.worker.error) items.push({
      key: "compatibility", stage: "Compatibility output", label: "Active", title: "Browser-compatible output unavailable",
      detail: compatibility.worker.queued ? "Conversion is waiting for worker capacity after a failure."
        : compatibility.worker.running ? "A conversion worker is running, but output recovery is not yet confirmed."
        : "Media inspection or conversion failed before browser-compatible output became ready.",
      next: "Check channel diagnostics and worker capacity. Confirm that the source sends supported, valid media.",
      facts: [`Worker restarts: ${safeCount(compatibility.worker.restarts)}`],
    });
    if (channel.inboundFramesInError > 0) items.push({
      key: "parse", stage: "Source input", label: "Recorded", title: "Input parse errors recorded",
      detail: `${safeCount(channel.inboundFramesInError)} media frames could not be parsed in this input generation. This cumulative count does not prove errors are continuing or explain stutter by itself.`,
      next: "Watch Input errors in Source media across updates. If the count increases, check the source media and input transport.",
    });
  }

  const needsAttention = items.some((item) => item.label !== "Starting");
  const summary = stale ? "Status stale" : !mediaReachable ? "Gateway media unavailable"
    : channel.applyState === "deleting" ? "Deletion pending" : !channel.enabled ? "Disabled"
    : retrying ? "Retrying" : needsAttention ? "Needs attention"
    : channel.applyState === "pending" ? "Applying configuration"
    : channel.outputReady ? "Output ready"
    : channel.available && channel.online ? "Preparing output" : "Offline / waiting for input";
  const explanation = stale ? "Showing the last successful gateway snapshot, not confirmed live state. Automatic status polling will retry."
    : !mediaReachable ? "The shared media plane is unreachable. Source health cannot be determined from this snapshot."
    : channel.applyState === "deleting" ? "Channel cleanup is pending. Playback is not available."
    : !channel.enabled ? "This channel is disabled. Input and output are not expected to be active."
    : channel.applyState === "pending" ? "Saved configuration is waiting to be applied."
    : items.length ? "Reported channel evidence is listed below; browser observations are scoped separately."
    : channel.outputReady ? "No channel issues reported in this snapshot. Output readiness does not guarantee smooth playback in every browser."
    : channel.available && channel.online ? compatibility.worker.queued
      ? "Input is connected; compatibility conversion is waiting for worker capacity."
      : "Input is connected; the gateway is inspecting or preparing browser-compatible media."
    : channel.input.mode === "srt-pull" ? "No accepted media from the SRT pull source yet. Check the remote listener, caller settings, and network reachability."
    : channel.input.mode === "srt-push" ? "Waiting for an SRT sender. Check the encoder's destination and SRT settings."
    : "Waiting for RTP input. Check the sender, destination, interface, and channel SDP.";

  const browserEnabled = running && channel.outputReady && channel.automaticPreview;
  const loss = preview.stats ? safeCount(preview.stats.video?.packetsLost) + safeCount(preview.stats.audio?.packetsLost) : 0;
  const dropped = safeCount(preview.stats?.video?.framesDropped);
  const browserProblem = browserEnabled && preview.state === "error";
  const browserRecorded = browserEnabled && preview.state === "playing" && (loss > 0 || dropped > 0);

  const renderItem = (item: HealthItem) => <li key={item.key} className="health-item">
    <div className="health-item-heading"><span className="health-stage">{item.stage}</span><span className="health-label">{stale || !mediaReachable ? "Last snapshot" : item.label}</span></div>
    <h3>{item.title}</h3>
    <p>{item.detail}</p>
    <p className="health-next"><strong>Next:</strong> {item.next}</p>
    {(item.issue || item.facts) && <details className="health-technical">
      <summary>Technical details</summary>
      {item.issue && <>
        <p>Code: {Object.hasOwn(inputIssues, item.issue.code) ? item.issue.code : "Unrecognized"}</p>
        {formatTime(item.issue.firstSeenAt) && <p>First seen: {formatTime(item.issue.firstSeenAt)}</p>}
        {formatTime(item.issue.lastSeenAt) && <p>Last seen: {formatTime(item.issue.lastSeenAt)}</p>}
        {safeCount(item.issue.occurrences) > 0 && <p>Occurrences: {safeCount(item.issue.occurrences)}</p>}
        <p>{Object.hasOwn(inputIssues, item.issue.code)
          ? "This report remains unresolved until the gateway clears it after accepting a replacement input. It is not a continuous error rate."
          : "This report is present in the gateway snapshot. No recovery history or continuous error rate is available."}</p>
      </>}
      {item.facts?.map((fact) => <p key={fact}>{fact}</p>)}
    </details>}
  </li>;

  return <section className="panel channel-health" aria-labelledby="channel-health-heading">
    <div className="health-heading">
      <h2 id="channel-health-heading">Channel health</h2>
      <span className={`health-status${stale || !mediaReachable || needsAttention && channel.enabled ? " attention" : ""}`}>{summary}</span>
      <button className="button secondary" type="button" onClick={onDiagnostics} aria-haspopup="dialog">View diagnostics</button>
    </div>
    <p className="health-explanation">{explanation}</p>
    {items.length > 0 && <ul className="health-items">{items.slice(0, 3).map(renderItem)}</ul>}
    {items.length > 3 && <details className="health-more" key={channel.id}>
      <summary>{items.length - 3} more {items.length === 4 ? "issue" : "issues"}</summary>
      <ul className="health-items">{items.slice(3).map(renderItem)}</ul>
    </details>}
    <div className="health-browser">
      <span className="health-stage">This browser only</span>
      <p>{!channel.automaticPreview ? "Preview disabled; no receiver health is being measured."
        : !browserEnabled ? "Preview is waiting for channel output."
        : browserProblem ? "Preview connection failed; retrying automatically. Check this browser's network path and the configured WebRTC ports. This does not establish a source fault."
        : browserRecorded ? `Recorded in this receiver session: ${[loss > 0 ? `${loss} packets lost` : "", dropped > 0 ? `${dropped} video frames dropped` : ""].filter(Boolean).join(", ")}. These are cumulative browser observations, not evidence of an input fault. Compare another viewer and check the browser network and decoding load.`
        : preview.state === "playing" ? "Preview connected. Receiver statistics describe this browser, not all viewers."
        : "Preview connection pending. No browser playback health is confirmed yet."}</p>
    </div>
  </section>;
}

function safeCount(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function formatTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString() : null;
}
