import { describe, expect, it } from "vitest";
import {
  channelStateLabel,
  iframeEmbedCode,
  managementOrigin,
  mediaHost,
  resolveBinding,
  srtListenerURL,
  srtPublishURL,
  type Channel,
} from "./channel";

const baseChannel: Channel = {
  id: "channel-id",
  name: "Studio & Main",
  path: "studio-main",
  enabled: true,
  automaticPreview: true,
  input: { mode: "srt-push", srt: { port: 10000, hasPassphrase: false } },
  maxReaders: 0,
  useAbsoluteTimestamp: false,
  applyState: "applied",
  whepPath: "/api/v1/channels/channel-id/whep",
  viewerPath: "/view/channel-id",
  embedPath: "/embed/channel-id",
  available: false,
  online: false,
  inboundBytes: 0,
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

describe("binding lifecycle", () => {
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
    expect(channelStateLabel({ ...baseChannel, compatibility: { ...baseChannel.compatibility, state: "error" } })).toBe("Output error");
    expect(channelStateLabel({ ...baseChannel, enabled: false })).toBe("Disabled");
  });
});

describe("iframeEmbedCode", () => {
  it("builds a safe, useful lazy-loading player snippet", () => {
    expect(iframeEmbedCode("http://desk.local/embed/channel-id?a=1&b=2", 'Studio "A"')).toBe(
      '<iframe src="http://desk.local/embed/channel-id?a=1&amp;b=2" allow="autoplay; fullscreen" loading="lazy" title="Studio &quot;A&quot;" style="border: 0; width: 100%; aspect-ratio: 16 / 9;" allowfullscreen></iframe>',
    );
  });
});
