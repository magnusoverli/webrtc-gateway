export type StatsSample = {
  timestamp: number;
  bytesReceived: number;
};

export type PreviewStats = {
  bitrateBps: number;
  codec: string;
  framesPerSecond: number;
  width: number;
  height: number;
  packetsLost: number;
  jitterMs: number;
  framesDecoded: number;
  framesDropped: number;
  icePath: string;
};

type RawStats = RTCStats & Record<string, unknown>;

export function waitForICEGathering(peer: RTCPeerConnection, timeoutMs = 5000) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(finish, timeoutMs);
    function finish() {
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }
    function onStateChange() {
      if (peer.iceGatheringState === "complete") finish();
    }
    peer.addEventListener("icegatheringstatechange", onStateChange);
  });
}

export function summarizeRTCStats(report: RTCStatsReport, previous?: StatsSample): { stats: PreviewStats; sample: StatsSample } {
  const entries = new Map<string, RawStats>();
  report.forEach((entry) => entries.set(entry.id, entry as RawStats));

  const inbound = [...entries.values()].filter((entry) => entry.type === "inbound-rtp" && entry.isRemote !== true);
  const video = inbound.find((entry) => entry.kind === "video" || entry.mediaType === "video");
  const primary = video ?? inbound[0];
  const bytesReceived = inbound.reduce((total, entry) => total + numberValue(entry.bytesReceived), 0);
  const timestamp = Math.max(0, ...inbound.map((entry) => numberValue(entry.timestamp)), performance.now());
  const elapsedMs = previous ? timestamp - previous.timestamp : 0;
  const bitrateBps = previous && elapsedMs > 0
    ? Math.max(0, ((bytesReceived - previous.bytesReceived) * 8000) / elapsedMs)
    : 0;

  const codec = primary?.codecId ? entries.get(String(primary.codecId)) : undefined;
  const transport = [...entries.values()].find((entry) => entry.type === "transport" && entry.selectedCandidatePairId);
  const selectedPairID = String(transport?.selectedCandidatePairId ?? "");
  const pair = selectedPairID
    ? entries.get(selectedPairID)
    : [...entries.values()].find((entry) => entry.type === "candidate-pair" && entry.nominated === true && entry.state === "succeeded");
  const local = pair?.localCandidateId ? entries.get(String(pair.localCandidateId)) : undefined;
  const remote = pair?.remoteCandidateId ? entries.get(String(pair.remoteCandidateId)) : undefined;
  const icePath = local && remote
    ? `${String(local.candidateType ?? "local")} to ${String(remote.candidateType ?? "remote")}`
    : "gathering";

  return {
    stats: {
      bitrateBps,
      codec: String(codec?.mimeType ?? "").replace(/^\w+\//, "") || "unknown",
      framesPerSecond: numberValue(video?.framesPerSecond),
      width: numberValue(video?.frameWidth),
      height: numberValue(video?.frameHeight),
      packetsLost: inbound.reduce((total, entry) => total + numberValue(entry.packetsLost), 0),
      jitterMs: Math.max(0, ...inbound.map((entry) => numberValue(entry.jitter) * 1000)),
      framesDecoded: numberValue(video?.framesDecoded),
      framesDropped: numberValue(video?.framesDropped),
      icePath,
    },
    sample: { timestamp, bytesReceived },
  };
}

export function codecWarnings(tracks: Array<{ codec: string; codecProps?: Record<string, string | number | boolean> }>) {
  const supported = new Set(["av1", "vp9", "vp8", "h264", "opus", "g722", "g711", "pcma", "pcmu"]);
  const warnings = new Set<string>();
  for (const track of tracks) {
    const codec = track.codec.toLowerCase().replace(/[\s_-]/g, "");
    if (codec === "h265" || codec === "hevc") {
      warnings.add("H265 WebRTC playback depends on browser and operating-system support.");
    } else if (codec === "aac" || codec === "mpeg4audio") {
      warnings.add("AAC is not broadly supported over WebRTC; compatibility mode will be required.");
    } else if (codec === "h264") {
      const profile = String(track.codecProps?.profile ?? "").toLowerCase();
      if (profile && !profile.includes("baseline")) {
        warnings.add(`H264 ${String(track.codecProps?.profile)} may contain B-frames; direct WebRTC requires H264 without B-frames.`);
      }
    } else if (!supported.has(codec)) {
      warnings.add(`${track.codec} browser playback has not been verified.`);
    }
  }
  return [...warnings];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
