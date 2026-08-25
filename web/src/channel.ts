export type InputMode = "srt-push" | "srt-pull" | "rtp-unicast" | "rtp-multicast";

export type Track = {
  codec: string;
  codecProps?: Record<string, string | number | boolean | null>;
};

export type TrackKind = "video" | "audio" | "unknown";

export type ChannelTone = "live" | "fault" | "idle";

export type ChannelStreamRates = {
  inputBitrateBps: number | null;
  outputBitrateBps: number | null;
  deliveryBitrateBps: number | null;
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
  inboundBytes: number;
  outputInboundBytes: number;
  outputAvailableTime?: string;
  outboundBytes: number;
  inboundFramesInError: number;
  source?: { type: string; id: string };
  readers: Array<{ type: string; id: string }>;
  tracks: Track[];
  outputReady: boolean;
  outputTracks: Track[];
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
  if (item.compatibility.state === "error") return "Output error";
  if (item.relay?.state === "retrying" || item.relay?.state === "stopped") return "Listener error";
  if (item.relay?.state === "starting") return "Listener restarting";
  if (item.outputReady) {
    return item.compatibility.mode === "transcoded"
      ? "Output ready - normalized"
      : "Output ready - direct";
  }
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
    item.enabled && item.applyState !== "deleting" &&
    (item.relay?.state === "retrying" || item.relay?.state === "stopped");
}

export function channelTone(item: Channel): ChannelTone {
  if (!item.enabled || item.applyState === "deleting") return "idle";
  if (channelHasFault(item)) return "fault";
  if (item.outputReady) return "live";
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

export function sampleChannelRates(
  channels: Channel[],
  previous: ReadonlyMap<string, ChannelRateSample>,
  sampledAt: number,
) {
  const samples = new Map<string, ChannelRateSample>();
  const rates: Record<string, ChannelStreamRates> = {};

  for (const item of channels) {
    const inputGeneration = `${item.availableTime ?? item.onlineTime ?? ""}:${item.source?.id ?? ""}`;
    const outputGeneration = `${item.outputAvailableTime ?? ""}:${item.compatibility.mode ?? ""}`;
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

export function srtListenerURL(listenerAddress: string | undefined, fallbackHostname: string, latencyMs = 60) {
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
