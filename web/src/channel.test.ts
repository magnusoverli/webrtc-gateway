import { describe, expect, it } from "vitest";
import {
  absolutePath,
  channelTone,
  channelStateLabel,
  channelHasFault,
  hasInputStream,
  hasOutputStream,
  iframeEmbedCode,
  interfaceBindingSelector,
  managementOrigin,
  mediaHost,
  parseInterfaceBinding,
  resolveBinding,
  resolveInterfaceBinding,
  sampleChannelRates,
  srtListenerURL,
  srtPublishURL,
  trackKind,
  type Channel,
} from "./channel";

const baseChannel: Channel = {
  id: "channel-id",
  number: 1,
  name: "Studio & Main",
  path: "studio-main",
  enabled: true,
  automaticPreview: true,
  input: { mode: "srt-push", srt: { port: 10000, hasPassphrase: false } },
  maxReaders: 0,
  useAbsoluteTimestamp: false,
  applyState: "applied",
  whepPath: "/api/v1/channels/channel-id/whep",
  viewerPath: "/view",
  embedPath: "/embed/1",
  available: false,
  online: false,
  inboundBytes: 0,
  outputInboundBytes: 0,
  outboundBytes: 0,
  inboundFramesInError: 0,
  readers: [],
  tracks: [],
  outputReady: false,
  outputTracks: [],
  compatibility: {
    state: "offline",
    mode: "direct",
    required: false,
    reasons: [],
    worker: { running: false, restarts: 0 },
  },
};

describe("connection URLs", () => {
  const location = { protocol: "http:", hostname: "desk.local", origin: "http://desk.local:8080" };

  it("uses concrete bindings and brackets IPv6 hosts", () => {
    expect(mediaHost("2001:db8::20", location.hostname)).toBe("2001:db8::20");
    expect(srtListenerURL(10000, "2001:db8::20", location.hostname)).toBe("srt://[2001:db8::20]:10000?latency=60");
    expect(srtListenerURL(10000, "192.0.2.20", location.hostname, 80)).toBe("srt://192.0.2.20:10000?latency=80");
    expect(srtPublishURL("studio-main", "[::]:8890", "2001:db8::20", location.hostname)).toBe(
      "srt://[2001:db8::20]:8890?streamid=publish:studio-main&pkt_size=1316",
    );
    expect(managementOrigin("2001:db8::10", 8080, location)).toBe("http://[2001:db8::10]:8080");
  });

  it("falls back to the browser location for wildcard bindings", () => {
    expect(mediaHost("*", location.hostname)).toBe("desk.local");
    expect(managementOrigin("*", 9000, location)).toBe(location.origin);
  });
});

describe("stream telemetry", () => {
  it("requires active paths with detected tracks", () => {
    const input = { ...baseChannel, available: true, online: true, tracks: [{ codec: "H264" }] };
    expect(hasInputStream(input)).toBe(true);
    expect(hasInputStream({ ...input, tracks: [] })).toBe(false);
    expect(hasInputStream({ ...input, online: false })).toBe(false);

    const output = { ...input, outputReady: true, outputTracks: [{ codec: "H264" }] };
    expect(hasOutputStream(output)).toBe(true);
    expect(hasOutputStream({ ...output, outputTracks: [] })).toBe(false);
    expect(hasOutputStream({ ...output, outputReady: false })).toBe(false);
  });

  it("calculates distinct input, output, and delivery rates", () => {
    const online = {
      ...baseChannel,
      available: true,
      online: true,
      outputReady: true,
      availableTime: "input-generation",
      outputAvailableTime: "output-generation",
    };
    const first = sampleChannelRates([
      { ...online, inboundBytes: 1000, outputInboundBytes: 700, outboundBytes: 1400 },
    ], new Map(), 1000);
    const second = sampleChannelRates([
      { ...online, inboundBytes: 2000, outputInboundBytes: 1400, outboundBytes: 3400 },
    ], first.samples, 2000);

    expect(first.rates[online.id]).toEqual({ inputBitrateBps: null, outputBitrateBps: null, deliveryBitrateBps: null });
    expect(second.rates[online.id]).toEqual({ inputBitrateBps: 8000, outputBitrateBps: 5600, deliveryBitrateBps: 16000 });
  });

  it("resets rates when a stream generation changes", () => {
    const online = { ...baseChannel, available: true, online: true, outputReady: true, availableTime: "one", outputAvailableTime: "out-one" };
    const first = sampleChannelRates([{ ...online, inboundBytes: 1000, outputInboundBytes: 1000 }], new Map(), 1000);
    const second = sampleChannelRates([{ ...online, availableTime: "two", outputAvailableTime: "out-two", inboundBytes: 2000, outputInboundBytes: 2000 }], first.samples, 2000);
    expect(second.rates[online.id]?.inputBitrateBps).toBeNull();
    expect(second.rates[online.id]?.outputBitrateBps).toBeNull();
  });

  it("resets rates when counters decrease", () => {
    const online = { ...baseChannel, available: true, online: true, outputReady: true };
    const first = sampleChannelRates([{ ...online, inboundBytes: 2000, outputInboundBytes: 2000, outboundBytes: 2000 }], new Map(), 1000);
    const second = sampleChannelRates([{ ...online, inboundBytes: 1000, outputInboundBytes: 1000, outboundBytes: 1000 }], first.samples, 2000);
    expect(second.rates[online.id]).toEqual({ inputBitrateBps: null, outputBitrateBps: null, deliveryBitrateBps: null });
  });

  it("classifies video and audio tracks", () => {
    expect(trackKind({ codec: "H264" })).toBe("video");
    expect(trackKind({ codec: "MPEG-4 Audio" })).toBe("audio");
    expect(trackKind({ codec: "MPEG-4 Audio LATM" })).toBe("audio");
    expect(trackKind({ codec: "Speex" })).toBe("audio");
    expect(trackKind({ codec: "G726" })).toBe("audio");
    expect(trackKind({ codec: "custom", codecProps: { width: 1920 } })).toBe("video");
    expect(trackKind({ codec: "custom" })).toBe("unknown");
  });
});

describe("binding lifecycle", () => {
  const interfaces = [
    { name: "eth0", address: "192.0.2.20", family: "IPv4" as const, loopback: false },
    { name: "eth0", address: "2001:db8::20", family: "IPv6" as const, loopback: false },
  ];

  it("formats, parses, and resolves interface-following selectors", () => {
    expect(interfaceBindingSelector(interfaces[0])).toBe("interface:ipv4:eth0");
    expect(parseInterfaceBinding("interface:ipv6:eth0")).toEqual({ name: "eth0", family: "IPv6" });
    expect(resolveInterfaceBinding("interface:ipv4:eth0", interfaces)).toBe("192.0.2.20");
    expect(resolveInterfaceBinding("interface:ipv6:eth0", interfaces)).toBe("2001:db8::20");
    expect(resolveInterfaceBinding("interface:ipv4:missing", interfaces)).toBe("");
    expect(resolveInterfaceBinding("interface:ipv4:eth0", [...interfaces, { ...interfaces[0], address: "192.0.2.21" }])).toBe("");
    expect(resolveInterfaceBinding("192.0.2.30", interfaces)).toBe("192.0.2.30");
  });

  it("uses a confirmed active binding without a pending destination", () => {
    expect(resolveBinding("192.0.2.10", "192.0.2.10", false, "applied")).toEqual({
      address: "192.0.2.10",
      state: "active",
    });
  });

  it("keeps current management endpoints while a restart is pending", () => {
    expect(resolveBinding("192.0.2.10", "192.0.2.20", true, "applied")).toEqual({
      address: "192.0.2.10",
      state: "pending-restart",
      desiredAddress: "192.0.2.20",
    });
  });

  it("does not present a failed desired media binding as confirmed active", () => {
    expect(resolveBinding(undefined, "192.0.2.30", false, "error")).toEqual({
      address: "192.0.2.30",
      state: "unconfirmed",
    });
  });

  it("marks a desired-only media binding as unconfirmed while apply is pending", () => {
    expect(resolveBinding(undefined, "192.0.2.40", false, "pending")).toEqual({
      address: "192.0.2.40",
      state: "unconfirmed",
    });
  });
});

describe("channelStateLabel", () => {
  it("reports stable operator workflow states", () => {
    expect(channelStateLabel(baseChannel)).toBe("Listener ready - waiting for encoder");
    expect(channelStateLabel({ ...baseChannel, input: { mode: "srt-pull" } })).toBe("Waiting for input");
    expect(channelStateLabel({ ...baseChannel, available: true, online: true, compatibility: { ...baseChannel.compatibility, state: "probing" } })).toBe("Encoder connected - inspecting");
    expect(channelStateLabel({ ...baseChannel, available: true, online: true, compatibility: { ...baseChannel.compatibility, state: "starting", worker: { running: false, queued: true, restarts: 0 } } })).toBe("Encoder connected - queued");
    expect(channelStateLabel({ ...baseChannel, available: true, online: true, compatibility: { ...baseChannel.compatibility, state: "starting" } })).toBe("Encoder connected - preparing");
    expect(channelStateLabel({ ...baseChannel, outputReady: true })).toBe("Output ready - direct");
    expect(channelStateLabel({ ...baseChannel, outputReady: true, compatibility: { ...baseChannel.compatibility, mode: "transcoded" } })).toBe("Output ready - normalized");
    expect(channelStateLabel({ ...baseChannel, applyState: "error" })).toBe("Configuration error");
    expect(channelStateLabel({ ...baseChannel, applyState: "deleting" })).toBe("Deletion pending");
    expect(channelStateLabel({ ...baseChannel, relay: { state: "retrying", restarts: 2, lastError: "bind failed" } })).toBe("Listener error");
    expect(channelHasFault({ ...baseChannel, relay: { state: "retrying", restarts: 2 } })).toBe(true);
    expect(channelHasFault({ ...baseChannel, enabled: false, relay: { state: "stopped", restarts: 0 } })).toBe(false);
    expect(channelHasFault({ ...baseChannel, applyState: "deleting", relay: { state: "stopped", restarts: 0 } })).toBe(false);
    expect(channelStateLabel({ ...baseChannel, compatibility: { ...baseChannel.compatibility, state: "error" } })).toBe("Output error");
    expect(channelStateLabel({ ...baseChannel, enabled: false })).toBe("Disabled");
  });
});

describe("channelTone", () => {
  it("keeps disabled and deleting channels idle despite stale state", () => {
    expect(channelTone({ ...baseChannel, enabled: false, applyState: "error", outputReady: true })).toBe("idle");
    expect(channelTone({ ...baseChannel, applyState: "deleting", outputReady: true, compatibility: { ...baseChannel.compatibility, state: "error" } })).toBe("idle");
  });

  it("gives faults precedence over ready output", () => {
    expect(channelTone({ ...baseChannel, applyState: "error", outputReady: true })).toBe("fault");
  });

  it("classifies ready and waiting channels", () => {
    expect(channelTone({ ...baseChannel, outputReady: true })).toBe("live");
    expect(channelTone(baseChannel)).toBe("idle");
  });
});

describe("iframeEmbedCode", () => {
  it("builds a safe, useful lazy-loading player snippet", () => {
    expect(iframeEmbedCode("http://desk.local/embed/7?a=1&b=2", 'Studio "A"')).toBe(
      '<iframe src="http://desk.local/embed/7?a=1&amp;b=2" allow="autoplay" loading="lazy" title="Studio &quot;A&quot;" style="display: block; width: 100%; aspect-ratio: 16 / 9; border: 0; background: transparent;"></iframe>',
    );
  });

  it("builds an absolute numbered embed URL", () => {
    expect(absolutePath("http://192.168.15.5:8080", "/embed/7")).toBe("http://192.168.15.5:8080/embed/7");
  });
});
