import { describe, expect, it } from "vitest";
import { channelPlaybackReady } from "./channel";
import { resolveStandaloneRoute } from "./StandalonePlayer";

describe("standalone routes", () => {
  it("opens one multiview route for current and legacy viewer URLs", () => {
    expect(resolveStandaloneRoute("/view")).toEqual({ kind: "viewer" });
    expect(resolveStandaloneRoute("/view/")).toEqual({ kind: "viewer" });
    expect(resolveStandaloneRoute("/view/channel%20id")).toEqual({ kind: "viewer" });
  });

  it("keeps embeds channel-specific and rejects malformed routes", () => {
    expect(resolveStandaloneRoute("/embed/7")).toEqual({ kind: "embed", channelID: "7" });
    expect(resolveStandaloneRoute("/embed/channel-id/")).toEqual({ kind: "embed", channelID: "channel-id" });
    expect(resolveStandaloneRoute("/embed")).toBeNull();
    expect(resolveStandaloneRoute("/view/channel/extra")).toBeNull();
    expect(resolveStandaloneRoute("/view/%E0%A4%A")).toBeNull();
  });
});

describe("viewer playback readiness", () => {
  it("does not play disabled or deleting channels with stale output state", () => {
    expect(channelPlaybackReady({ enabled: true, applyState: "applied", outputReady: true })).toBe(true);
    expect(channelPlaybackReady({ enabled: false, applyState: "applied", outputReady: true })).toBe(false);
    expect(channelPlaybackReady({ enabled: true, applyState: "pending", outputReady: true })).toBe(false);
    expect(channelPlaybackReady({ enabled: true, applyState: "error", outputReady: true })).toBe(false);
    expect(channelPlaybackReady({ enabled: true, applyState: "deleting", outputReady: true })).toBe(false);
    expect(channelPlaybackReady(null)).toBe(false);
  });
});
