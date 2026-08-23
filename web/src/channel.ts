export type InputMode = "srt-push" | "srt-pull" | "rtp-unicast" | "rtp-multicast";

export type Track = {
  codec: string;
  codecProps?: Record<string, string | number | boolean>;
};

export type Channel = {
  id: string;
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
  applyState: "pending" | "applied" | "error";
  applyError?: string;
  whepPath: string;
  viewerPath: string;
  embedPath: string;
  available: boolean;
  online: boolean;
  inboundBytes: number;
  outboundBytes: number;
  inboundFramesInError: number;
  readers: Array<{ type: string; id: string }>;
  tracks: Track[];
  outputReady: boolean;
  outputTracks: Track[];
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

export function channelStateLabel(item: Channel) {
  if (!item.enabled) return "Disabled";
  if (item.applyState === "error") return "Configuration error";
  if (item.compatibility.state === "error") return "Output error";
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

export function srtListenerURL(port: number | undefined, mediaBindAddress: string | undefined, fallbackHostname: string, latencyMs = 60) {
  if (!port) return "";
  return `srt://${urlHost(mediaHost(mediaBindAddress, fallbackHostname))}:${port}?latency=${latencyMs}`;
}

export function srtPublishURL(path: string, listenAddress: string, mediaBindAddress: string | undefined, fallbackHostname: string) {
  const port = listenerPort(listenAddress);
  if (!path || !port) return "";
  return `srt://${urlHost(mediaHost(mediaBindAddress, fallbackHostname))}:${port}?streamid=publish:${path}&pkt_size=1316`;
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
  return `<iframe src="${escapeAttribute(embedURL)}" allow="autoplay; fullscreen" loading="lazy" title="${escapeAttribute(channelName)}" style="border: 0; width: 100%; aspect-ratio: 16 / 9;" allowfullscreen></iframe>`;
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
