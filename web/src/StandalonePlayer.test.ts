import { describe, expect, it } from "vitest";
import { channelPlaybackReady, resolveStandaloneRoute, selectViewerChannelID } from "./StandalonePlayer";

describe("standalone routes", () => {
  it("opens the shared viewer with or without an initial channel", () => {
    expect(resolveStandaloneRoute("/view")).toEqual({ kind: "viewer", initialChannelID: "" });
    expect(resolveStandaloneRoute("/view/")).toEqual({ kind: "viewer", initialChannelID: "" });
    expect(resolveStandaloneRoute("/view", "?channel=channel%20id")).toEqual({ kind: "viewer", initialChannelID: "channel id" });
    expect(resolveStandaloneRoute("/view/channel%20id")).toEqual({ kind: "viewer", initialChannelID: "channel id" });
  });

  it("keeps embeds channel-specific and rejects malformed routes", () => {
    expect(resolveStandaloneRoute("/embed/channel-id/")).toEqual({ kind: "embed", channelID: "channel-id" });
    expect(resolveStandaloneRoute("/embed")).toBeNull();
    expect(resolveStandaloneRoute("/view/channel/extra")).toBeNull();
    expect(resolveStandaloneRoute("/view/%E0%A4%A")).toBeNull();
  });
});

describe("viewer channel selection", () => {
  const channels = [{ id: "offline" }, { id: "disabled" }, { id: "live" }];

  it("selects the first configured channel without filtering its state", () => {
    expect(selectViewerChannelID(channels, "")).toBe("offline");
  });

  it("retains selection across polling and ordering changes", () => {
    expect(selectViewerChannelID([...channels].reverse(), "disabled")).toBe("disabled");
  });

  it("does not silently replace a requested or deleted channel", () => {
    expect(selectViewerChannelID(channels, "deleted")).toBe("deleted");
    expect(selectViewerChannelID([], "deleted")).toBe("deleted");
  });
});

describe("viewer playback readiness", () => {
  it("does not play disabled or deleting channels with stale output state", () => {
    expect(channelPlaybackReady({ enabled: true, applyState: "applied", outputReady: true })).toBe(true);
    expect(channelPlaybackReady({ enabled: false, applyState: "applied", outputReady: true })).toBe(false);
    expect(channelPlaybackReady({ enabled: true, applyState: "deleting", outputReady: true })).toBe(false);
    expect(channelPlaybackReady(null)).toBe(false);
  });
});
