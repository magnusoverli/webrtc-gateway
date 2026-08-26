export type InputMode = "srt-push" | "srt-pull" | "rtp-unicast" | "rtp-multicast";

export const DEFAULT_SRT_LATENCY_MS = 20;

export type Track = {
  codec: string;
  codecProps?: Record<string, string | number | boolean | null>;
};

export type ChannelIssue = {
  code: string;
  source: string;
  severity: "warning" | "error";
  summary: string;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
};

export type TrackKind = "video" | "audio" | "unknown";

export type ChannelTone = "live" | "starting" | "fault" | "idle";

export type ChannelStreamRates = {
  inputBitrateBps: number | null;
  outputBitrateBps: number | null;
  deliveryBitrateBps: number | null;
};

export type InputVideoMetadata = {
  width: number;
  height: number;
  frameRate?: string;
};

export type ChannelRateSample = {
  sampledAt: number;
  inputGeneration: string;
  outputGeneration: string;
  inputBytes?: number;
  outputBytes?: number;
  deliveryBytes?: number;
};

export type Channel = {
  id: string;
  revision: number;
  number: number;
  name: string;
  path: string;
  enabled: boolean;
  automaticPreview: boolean;
  input: {
    mode: InputMode;
    rtp?: {
      address: string;
      port: number;
      interface?: string;
      sourceIp?: string;
      sdp: string;
    };
    srt?: {
      host?: string;
      port?: number;
      streamId?: string;
      hasPassphrase: boolean;
      latencyMs?: number;
      sdp?: string;
    };
  };
  maxReaders: number;
  useAbsoluteTimestamp: boolean;
  applyState: "pending" | "applied" | "error" | "deleting";
  applyError?: string;
  createdAt: string;
  updatedAt: string;
  whepPath: string;
  viewerPath: string;
  embedPath: string;
  available: boolean;
  availableTime?: string;
  online: boolean;
  onlineTime?: string;
  inputGeneration: string;
  inboundBytes: number;
  outputInboundBytes: number;
  outputAvailableTime?: string;
  outputGeneration: string;
  outboundBytes: number;
  inboundFramesInError: number;
  source?: { type: string; id: string };
  readers: Array<{ type: string; id: string }>;
  readerCount: number;
  tracks: Track[];
  inputVideo?: InputVideoMetadata | null;
  outputReady: boolean;
  outputTracks: Track[];
  issues: ChannelIssue[];
  relay?: {
    state: "running" | "starting" | "retrying" | "stopping" | "stopped";
    restarts: number;
    lastError?: string;
    nextRetryAt?: string;
    listenerAddress?: string;
    listenerActive: boolean;
  };
  compatibility: {
    state: "offline" | "probing" | "starting" | "ready" | "error";
    mode?: "direct" | "transcoded";
    required: boolean;
    reasons: string[];
    lastError?: string;
    worker: { running: boolean; queued?: boolean; restarts: number; error?: string };
  };
};

export type ChannelRuntime = Pick<
  Channel,
  | "id"
  | "revision"
  | "applyState"
  | "applyError"
  | "available"
  | "availableTime"
  | "online"
  | "onlineTime"
  | "inputGeneration"
  | "inboundBytes"
  | "outputInboundBytes"
  | "outputAvailableTime"
  | "outputGeneration"
  | "outboundBytes"
  | "inboundFramesInError"
  | "readerCount"
  | "tracks"
  | "inputVideo"
  | "outputReady"
  | "outputTracks"
  | "compatibility"
  | "relay"
  | "issues"
>;

export type BrowserLocation = {
  protocol: string;
  hostname: string;
  origin: string;
};

export type BindingInterface = {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  loopback: boolean;
};

export type InterfaceBinding = {
  name: string;
  family: "IPv4" | "IPv6";
};

export type BindingApplyState = "pending" | "applied" | "error";

export type ResolvedBinding = {
  address: string;
  state: "active" | "pending-restart" | "unconfirmed";
  desiredAddress?: string;
};

export function resolveBinding(
  activeAddress: string | undefined,
  desiredAddress: string,
  restartRequired: boolean,
  applyState: BindingApplyState,
): ResolvedBinding {
  if (activeAddress !== undefined) {
    return {
      address: activeAddress,
      state: restartRequired ? "pending-restart" : "active",
      ...(restartRequired ? { desiredAddress } : {}),
    };
  }
  return {
    address: desiredAddress,
    state: applyState === "applied" ? "active" : "unconfirmed",
  };
}

export function interfaceBindingSelector(item: Pick<BindingInterface, "name" | "family">) {
  return `interface:${item.family.toLowerCase()}:${item.name}`;
}

export function parseInterfaceBinding(value: string): InterfaceBinding | null {
  const match = value.match(/^interface:(ipv4|ipv6):(.+)$/);
  if (!match || !match[2] || /\s/.test(match[2])) return null;
  return { name: match[2], family: match[1] === "ipv4" ? "IPv4" : "IPv6" };
}

export function resolveInterfaceBinding(value: string, interfaces: BindingInterface[]) {
  const selected = parseInterfaceBinding(value);
  if (!selected) return value;
  const matches = interfaces.filter((item) => item.name === selected.name && item.family === selected.family);
  return matches.length === 1 ? matches[0].address : "";
}

export function channelStateLabel(item: Channel) {
  if (item.applyState === "deleting") return "Deletion pending";
  if (!item.enabled) return "Disabled";
  if (item.applyState === "error") return "Configuration error";
  if (item.applyState === "pending") return "Applying configuration";
  if (primaryChannelIssue(item)) return primaryChannelIssue(item)?.summary ?? "Channel error";
  if (item.compatibility.state === "error") return "Output error";
  if (item.relay?.state === "retrying" || item.relay?.state === "stopped") return "Listener error";
  if (item.relay?.state === "starting") return "Listener restarting";
  if (item.outputReady) return "Output ready";
  if (item.available && item.online) {
    if (item.compatibility.state === "starting") {
      return item.compatibility.worker.queued
        ? "Encoder connected - queued"
        : "Encoder connected - preparing";
    }
    return "Encoder connected - inspecting";
  }
  if (item.applyState === "applied" && item.input.mode === "srt-push") {
    return "Listener ready - waiting for encoder";
  }
  return "Waiting for input";
}

export function channelHasFault(item: Channel) {
  return item.applyState === "error" || item.compatibility.state === "error" ||
    item.issues.some((issue) => issue.severity === "error") ||
    item.enabled && item.applyState !== "deleting" &&
    (item.relay?.state === "retrying" || item.relay?.state === "stopped");
}

export function primaryChannelIssue(item: Pick<Channel, "issues">) {
  return item.issues.find((issue) => issue.severity === "error") ?? item.issues[0];
}

export function channelTone(item: Channel): ChannelTone {
  if (!item.enabled || item.applyState === "deleting") return "idle";
  if (channelHasFault(item)) return "fault";
  if (item.applyState === "pending" || item.relay?.state === "starting") return "starting";
  if (item.outputReady) return "live";
  if (item.compatibility.state === "probing" || item.compatibility.state === "starting" ||
    item.available && item.online) return "starting";
  return "idle";
}

export function hasInputStream(item: Channel) {
  return item.available && item.online && item.tracks.length > 0;
}

export function hasOutputStream(item: Channel) {
  return item.outputReady && item.outputTracks.length > 0;
}

export function channelPlaybackReady(channel: Pick<Channel, "enabled" | "applyState" | "outputReady"> | null) {
  return Boolean(channel?.enabled && channel.applyState === "applied" && channel.outputReady);
}

export function readChannelSnapshot(value: unknown): Channel | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Channel>;
  if (typeof item.id !== "string" || typeof item.revision !== "number" || item.revision < 1 ||
    typeof item.number !== "number" || typeof item.name !== "string" || typeof item.path !== "string" ||
    typeof item.enabled !== "boolean" || typeof item.automaticPreview !== "boolean" ||
    typeof item.createdAt !== "string" || typeof item.updatedAt !== "string" ||
    typeof item.whepPath !== "string" || typeof item.viewerPath !== "string" || typeof item.embedPath !== "string" ||
    typeof item.outputReady !== "boolean" || typeof item.applyState !== "string" ||
    !item.input || typeof item.input.mode !== "string" || !isCompatibility(item.compatibility) || !isIssues(item.issues) ||
    !Array.isArray(item.readers) || !Array.isArray(item.tracks) || !Array.isArray(item.outputTracks) || !isInputVideo(item.inputVideo)) return null;
  const sourceID = item.source && typeof item.source.id === "string" ? item.source.id : "";
  return {
    ...item,
    readerCount: item.readers.length,
    inputGeneration: `${item.availableTime ?? item.onlineTime ?? ""}:${sourceID}`,
    outputGeneration: `${item.outputAvailableTime ?? ""}:${item.compatibility.mode ?? ""}`,
  } as Channel;
}

export function readChannelSnapshots(value: unknown): Channel[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { channels?: unknown }).channels)) return null;
  const channels: Channel[] = [];
  for (const candidate of (value as { channels: unknown[] }).channels) {
    const channel = readChannelSnapshot(candidate);
    if (!channel) return null;
    channels.push(channel);
  }
  return channels;
}

export function readChannelRuntime(value: unknown): ChannelRuntime | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ChannelRuntime>;
  if (typeof item.id !== "string" || typeof item.revision !== "number" || item.revision < 1 ||
    typeof item.applyState !== "string" || typeof item.available !== "boolean" || typeof item.online !== "boolean" ||
    typeof item.inputGeneration !== "string" || typeof item.outputGeneration !== "string" ||
    typeof item.inboundBytes !== "number" || typeof item.outputInboundBytes !== "number" ||
    typeof item.outboundBytes !== "number" || typeof item.inboundFramesInError !== "number" ||
    typeof item.readerCount !== "number" || !Number.isInteger(item.readerCount) || item.readerCount < 0 ||
    !Array.isArray(item.tracks) || typeof item.outputReady !== "boolean" || !Array.isArray(item.outputTracks) ||
    !isCompatibility(item.compatibility) || !isIssues(item.issues) || !isInputVideo(item.inputVideo)) return null;
  if (item.applyError !== undefined && typeof item.applyError !== "string") return null;
  if (item.availableTime !== undefined && typeof item.availableTime !== "string") return null;
  if (item.onlineTime !== undefined && typeof item.onlineTime !== "string") return null;
  if (item.outputAvailableTime !== undefined && typeof item.outputAvailableTime !== "string") return null;
  return item as ChannelRuntime;
}

export function readChannelRuntimes(value: unknown): ChannelRuntime[] | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { channels?: unknown }).channels)) return null;
  const channels: ChannelRuntime[] = [];
  for (const candidate of (value as { channels: unknown[] }).channels) {
    const channel = readChannelRuntime(candidate);
    if (!channel) return null;
    channels.push(channel);
  }
  return channels;
}

export function mergeChannelRuntime(channel: Channel, runtime: ChannelRuntime): Channel | null {
  if (channel.id !== runtime.id || channel.revision !== runtime.revision) return null;
  return {
    ...channel,
    applyState: runtime.applyState,
    applyError: runtime.applyError,
    available: runtime.available,
    availableTime: runtime.availableTime,
    online: runtime.online,
    onlineTime: runtime.onlineTime,
    inputGeneration: runtime.inputGeneration,
    inboundBytes: runtime.inboundBytes,
    outputInboundBytes: runtime.outputInboundBytes,
    outputAvailableTime: runtime.outputAvailableTime,
    outputGeneration: runtime.outputGeneration,
    outboundBytes: runtime.outboundBytes,
    inboundFramesInError: runtime.inboundFramesInError,
    readerCount: runtime.readerCount,
    tracks: runtime.tracks,
    inputVideo: runtime.inputVideo,
    outputReady: runtime.outputReady,
    outputTracks: runtime.outputTracks,
    compatibility: runtime.compatibility,
    relay: runtime.relay,
    issues: runtime.issues,
  };
}

export function mergeChannelRuntimes(channels: Channel[], runtimes: ChannelRuntime[]): Channel[] | null {
  if (channels.length !== runtimes.length) return null;
  const byID = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  if (byID.size !== runtimes.length) return null;
  const merged: Channel[] = [];
  for (const channel of channels) {
    const runtime = byID.get(channel.id);
    if (!runtime) return null;
    const next = mergeChannelRuntime(channel, runtime);
    if (!next) return null;
    merged.push(next);
  }
  return merged;
}

export function sampleChannelRates(
  channels: Channel[],
  previous: ReadonlyMap<string, ChannelRateSample>,
  sampledAt: number,
) {
  const samples = new Map<string, ChannelRateSample>();
  const rates: Record<string, ChannelStreamRates> = {};

  for (const item of channels) {
    const inputGeneration = item.inputGeneration;
    const outputGeneration = item.outputGeneration;
    const sample: ChannelRateSample = { sampledAt, inputGeneration, outputGeneration };
    if (item.available && item.online) sample.inputBytes = item.inboundBytes;
    if (item.outputReady) {
      sample.outputBytes = item.outputInboundBytes;
      sample.deliveryBytes = item.outboundBytes;
    }

    const prior = previous.get(item.id);
    const elapsedMs = prior ? sampledAt - prior.sampledAt : 0;
    rates[item.id] = {
      inputBitrateBps: inputGeneration === prior?.inputGeneration
        ? counterBitrate(prior.inputBytes, sample.inputBytes, elapsedMs)
        : null,
      outputBitrateBps: outputGeneration === prior?.outputGeneration
        ? counterBitrate(prior.outputBytes, sample.outputBytes, elapsedMs)
        : null,
      deliveryBitrateBps: outputGeneration === prior?.outputGeneration
        ? counterBitrate(prior.deliveryBytes, sample.deliveryBytes, elapsedMs)
        : null,
    };
    samples.set(item.id, sample);
  }

  return { rates, samples };
}

function isCompatibility(value: unknown): value is Channel["compatibility"] {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Channel["compatibility"]>;
  return typeof item.state === "string" && Array.isArray(item.reasons) &&
    Boolean(item.worker && typeof item.worker.running === "boolean" && typeof item.worker.restarts === "number");
}

function isInputVideo(value: unknown): value is InputVideoMetadata | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  const item = value as Partial<InputVideoMetadata>;
  return typeof item.width === "number" && Number.isInteger(item.width) && item.width > 0 &&
    typeof item.height === "number" && Number.isInteger(item.height) && item.height > 0 &&
    (item.frameRate === undefined || typeof item.frameRate === "string");
}

function isIssues(value: unknown): value is ChannelIssue[] {
  if (!Array.isArray(value)) return false;
  return value.every((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const issue = candidate as Partial<ChannelIssue>;
    return typeof issue.code === "string" && typeof issue.source === "string" &&
      (issue.severity === "warning" || issue.severity === "error") &&
      typeof issue.summary === "string" && typeof issue.message === "string" &&
      typeof issue.firstSeenAt === "string" && typeof issue.lastSeenAt === "string" &&
      typeof issue.occurrences === "number" && Number.isInteger(issue.occurrences) && issue.occurrences > 0;
  });
}

export function trackKind(track: Track): TrackKind {
  const codec = track.codec.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (numberProperty(track, "width") > 0 || numberProperty(track, "height") > 0 || videoCodecs.has(codec)) return "video";
  if (numberProperty(track, "sampleRate") > 0 || numberProperty(track, "channelCount") > 0 || audioCodecs.has(codec)) return "audio";
  return "unknown";
}

function counterBitrate(previous: number | undefined, current: number | undefined, elapsedMs: number) {
  if (previous === undefined || current === undefined || current < previous || elapsedMs < 250) return null;
  return ((current - previous) * 8000) / elapsedMs;
}

function numberProperty(track: Track, key: string) {
  const value = track.codecProps?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const videoCodecs = new Set(["h264", "h265", "hevc", "vp8", "vp9", "av1", "mpeg1video", "mpeg2video", "mpeg12video", "mpeg4video", "mjpeg", "jpeg"]);
const audioCodecs = new Set(["opus", "aac", "mpeg4audio", "mpeg4audiolatm", "mp2", "mp3", "mpeg1audio", "mpeg2audio", "mpeg12audio", "ac3", "eac3", "vorbis", "flac", "lpcm", "speex", "g726", "g722", "g711", "pcma", "pcmu"]);

export function listenerPort(address: string) {
  return address.match(/:(\d+)$/)?.[1] ?? "";
}

export function mediaHost(mediaBindAddress: string | undefined, fallbackHostname: string) {
  const selected = mediaBindAddress && mediaBindAddress !== "*" && mediaBindAddress !== "custom"
    ? mediaBindAddress
    : fallbackHostname;
  return selected.replace(/^\[|\]$/g, "");
}

export function urlHost(host: string) {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]` : bare;
}

export function activeListenerHost(listenerAddress: string | undefined, fallbackHostname: string) {
  const listener = parseListenerSocket(listenerAddress);
  if (!listener) return "";
  return isWildcardHost(listener.host) ? fallbackHostname : listener.host;
}

export function srtListenerURL(listenerAddress: string | undefined, fallbackHostname: string, latencyMs = DEFAULT_SRT_LATENCY_MS) {
  const listener = parseListenerSocket(listenerAddress);
  if (!listener) return "";
  const host = isWildcardHost(listener.host) ? fallbackHostname : listener.host;
  return `srt://${urlHost(host)}:${listener.port}?latency=${latencyMs}`;
}

export function srtPublishURL(path: string, listenerAddress: string | undefined, fallbackHostname: string) {
  const listener = parseListenerSocket(listenerAddress);
  if (!path || !listener) return "";
  const host = isWildcardHost(listener.host) ? fallbackHostname : listener.host;
  return `srt://${urlHost(host)}:${listener.port}?streamid=publish:${path}&pkt_size=1316`;
}

export function managementOrigin(managementBindAddress: string, port: number | undefined, location: BrowserLocation) {
  if (!managementBindAddress || managementBindAddress === "*" || managementBindAddress === "custom") {
    return location.origin;
  }
  const portSuffix = port ? `:${port}` : "";
  return `${location.protocol}//${urlHost(managementBindAddress)}${portSuffix}`;
}

export function absolutePath(origin: string, path: string) {
  return new URL(path, `${origin}/`).toString();
}

export function iframeEmbedCode(embedURL: string, channelName: string) {
  return `<iframe src="${escapeAttribute(embedURL)}" allow="autoplay" loading="lazy" title="${escapeAttribute(channelName)}" style="display: block; width: 100%; aspect-ratio: 16 / 9; border: 0; background: transparent;"></iframe>`;
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseListenerSocket(address: string | undefined) {
  if (!address) return null;
  const bracketed = address.match(/^\[([^\]]+)]:(\d+)$/);
  const unbracketed = address.match(/^([^:]*):(\d+)$/);
  const match = bracketed ?? unbracketed;
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

function isWildcardHost(host: string) {
  return host === "" || host === "*" || host === "0.0.0.0" || host === "::";
}
