export type StatsSample = {
  timestamp: number;
  bytesReceived: number;
  videoBytesReceived: number;
  audioBytesReceived: number;
};

export type ReceiverStats = {
  bitrateBps: number | null;
  codec: string;
  packetsLost: number;
  jitterMs: number;
};

export type VideoReceiverStats = ReceiverStats & {
  framesPerSecond: number;
  width: number;
  height: number;
  framesDecoded: number;
  framesDropped: number;
};

export type PreviewStats = {
  bitrateBps: number | null;
  video?: VideoReceiverStats;
  audio?: ReceiverStats;
  icePath: string;
};

type RawStats = RTCStats & Record<string, unknown>;

export type ICEGatheringResult = "complete" | "timeout" | "aborted";

export type ICEGatheringOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export function waitForICEGathering(
  peer: RTCPeerConnection,
  timeoutOrOptions: number | ICEGatheringOptions = 5000,
  legacySignal?: AbortSignal,
): Promise<ICEGatheringResult> {
  const timeoutMs = typeof timeoutOrOptions === "number" ? timeoutOrOptions : timeoutOrOptions.timeoutMs ?? 5000;
  const signal = typeof timeoutOrOptions === "number" ? legacySignal : timeoutOrOptions.signal;
  if (signal?.aborted) return Promise.resolve("aborted");
  if (peer.iceGatheringState === "complete") return Promise.resolve("complete");

  return new Promise<ICEGatheringResult>((resolve) => {
    let settled = false;
    const finish = (result: ICEGatheringResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") finish("complete");
    };
    const onAbort = () => finish("aborted");
    const timer = window.setTimeout(() => finish("timeout"), Math.max(0, timeoutMs));
    peer.addEventListener("icegatheringstatechange", onStateChange);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function summarizeRTCStats(report: RTCStatsReport, previous?: StatsSample): { stats: PreviewStats; sample: StatsSample } {
  const entries = new Map<string, RawStats>();
  report.forEach((entry) => entries.set(entry.id, entry as RawStats));

  const inbound = [...entries.values()].filter((entry) => entry.type === "inbound-rtp" && entry.isRemote !== true);
  const videoEntries = inbound.filter((entry) => entry.kind === "video" || entry.mediaType === "video");
  const audioEntries = inbound.filter((entry) => entry.kind === "audio" || entry.mediaType === "audio");
  const video = videoEntries[0];
  const audio = audioEntries[0];
  const bytesReceived = inbound.reduce((total, entry) => total + numberValue(entry.bytesReceived), 0);
  const videoBytesReceived = videoEntries.reduce((total, entry) => total + numberValue(entry.bytesReceived), 0);
  const audioBytesReceived = audioEntries.reduce((total, entry) => total + numberValue(entry.bytesReceived), 0);
  const reportedTimestamp = Math.max(0, ...inbound.map((entry) => numberValue(entry.timestamp)));
  const timestamp = reportedTimestamp || performance.now();
  const elapsedMs = previous ? timestamp - previous.timestamp : 0;
  const bitrateBps = receiverBitrate(previous?.bytesReceived, bytesReceived, elapsedMs);

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
      video: video ? {
        ...receiverStats(videoEntries, entries, previous?.videoBytesReceived, videoBytesReceived, elapsedMs),
        framesPerSecond: numberValue(video.framesPerSecond),
        width: numberValue(video.frameWidth),
        height: numberValue(video.frameHeight),
        framesDecoded: numberValue(video.framesDecoded),
        framesDropped: numberValue(video.framesDropped),
      } : undefined,
      audio: audio
        ? receiverStats(audioEntries, entries, previous?.audioBytesReceived, audioBytesReceived, elapsedMs)
        : undefined,
      icePath,
    },
    sample: { timestamp, bytesReceived, videoBytesReceived, audioBytesReceived },
  };
}

function receiverStats(
  inbound: RawStats[],
  entries: Map<string, RawStats>,
  previousBytes: number | undefined,
  bytesReceived: number,
  elapsedMs: number,
): ReceiverStats {
  const primary = inbound[0];
  const codec = primary?.codecId ? entries.get(String(primary.codecId)) : undefined;
  return {
    bitrateBps: receiverBitrate(previousBytes, bytesReceived, elapsedMs),
    codec: String(codec?.mimeType ?? "").replace(/^\w+\//, "") || "unknown",
    packetsLost: inbound.reduce((total, entry) => total + numberValue(entry.packetsLost), 0),
    jitterMs: Math.max(0, ...inbound.map((entry) => numberValue(entry.jitter) * 1000)),
  };
}

function receiverBitrate(previous: number | undefined, current: number, elapsedMs: number) {
  return previous !== undefined && current >= previous && elapsedMs > 0
    ? ((current - previous) * 8000) / elapsedMs
    : null;
}

export function codecWarnings(tracks: Array<{ codec: string; codecProps?: Record<string, string | number | boolean | null> }>) {
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
