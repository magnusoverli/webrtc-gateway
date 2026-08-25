// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "./channel";

const playerHarness = vi.hoisted(() => ({
  calls: vi.fn(),
  started: [] as string[],
  stopped: [] as string[],
}));

vi.mock("./useWHEPPlayer", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useWHEPPlayer: (options: { whepPath: string; enabled: boolean }) => {
      playerHarness.calls(options);
      React.useEffect(() => {
        if (!options.enabled) return;
        playerHarness.started.push(options.whepPath);
        return () => { playerHarness.stopped.push(options.whepPath); };
      }, [options.enabled, options.whepPath]);
      return {
        videoRef: { current: null },
        state: "playing",
        error: "",
        stats: null,
        hasVideo: true,
        hasAudio: false,
      };
    },
  };
});

import { ChannelViewer, initializeStandaloneRoute, MultiviewGrid, StandalonePlayer } from "./StandalonePlayer";

describe("ChannelViewer", () => {
  beforeEach(() => {
    playerHarness.calls.mockClear();
    playerHarness.started.length = 0;
    playerHarness.stopped.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.classList.remove("embed-document");
    vi.unstubAllGlobals();
  });

  it("renders every channel as a simultaneous player tile", async () => {
    const channels = [fixtureChannel("studio-a", 1, "Studio A", true), fixtureChannel("studio-b", 2, "Studio B", false)];
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ channels }) });
    vi.stubGlobal("fetch", fetch);

    render(<ChannelViewer />);

    expect(await screen.findByRole("heading", { name: "Studio A" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Studio B" })).toBeDefined();
    expect(document.querySelectorAll(".multiview-tile")).toHaveLength(2);
    const videos = [...document.querySelectorAll(".multiview-tile video")];
    expect(videos).toHaveLength(2);
    expect(videos.every((video) => video.hasAttribute("controls"))).toBe(true);
    expect(playerHarness.calls).toHaveBeenCalledWith(expect.objectContaining({ whepPath: "/api/v1/channels/studio-a/whep", enabled: true }));
    expect(playerHarness.calls).toHaveBeenCalledWith(expect.objectContaining({ whepPath: "/api/v1/channels/studio-b/whep", enabled: false }));
    expect(fetch).toHaveBeenCalledWith("/api/v1/channels", expect.objectContaining({ cache: "no-store" }));
  });

  it("retains multiview channels and enabled sessions after a transient poll failure", async () => {
    vi.useFakeTimers();
    const channel = fixtureChannel("studio-a", 1, "Studio A", true);
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ channels: [channel] }) })
      .mockRejectedValueOnce(new TypeError("network down"));
    vi.stubGlobal("fetch", fetch);

    render(<ChannelViewer />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("heading", { name: "Studio A" })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(screen.getByRole("heading", { name: "Studio A" })).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("network down");
    expect(playerHarness.stopped).toEqual([]);
    expect(playerHarness.calls).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("preserves keyed sessions through reorder and cleans up removed or unready channels", () => {
    const north = fixtureChannel("north", 1, "North", true);
    const south = fixtureChannel("south", 2, "South", true);
    const view = render(<MultiviewGrid channels={[north, south]} loaded />);
    expect(playerHarness.started).toEqual([north.whepPath, south.whepPath]);

    view.rerender(<MultiviewGrid channels={[south, north]} loaded />);
    expect(playerHarness.started).toEqual([north.whepPath, south.whepPath]);
    expect(playerHarness.stopped).toEqual([]);

    view.rerender(<MultiviewGrid channels={[south]} loaded />);
    expect(playerHarness.stopped).toEqual([north.whepPath]);

    view.rerender(<MultiviewGrid channels={[{ ...south, outputReady: false }]} loaded />);
    expect(playerHarness.stopped).toEqual([north.whepPath, south.whepPath]);
  });

  it("renders embeds as video only without native controls", async () => {
    const channel = fixtureChannel("studio-a", 7, "Studio A", true);
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => channel });
    vi.stubGlobal("fetch", fetch);

    render(<StandalonePlayer channelID="7" />);

    const video = await screen.findByLabelText("Studio A embedded video");
    expect(video.tagName).toBe("VIDEO");
    expect(video.hasAttribute("controls")).toBe(false);
    expect(video.parentElement?.className).toContain("embed-player");
    expect(video.parentElement?.childElementCount).toBe(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/v1/channels/7", expect.objectContaining({ cache: "no-store" }));
  });

  it("retains an enabled embed player when a later response is malformed", async () => {
    vi.useFakeTimers();
    const channel = fixtureChannel("studio-a", 7, "Studio A", true);
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => channel })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ malformed: true }) });
    vi.stubGlobal("fetch", fetch);

    render(<StandalonePlayer channelID="7" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByLabelText("Studio A embedded video")).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(screen.getByLabelText("Studio A embedded video")).toBeDefined();
    expect(playerHarness.stopped).toEqual([]);
    expect(playerHarness.calls).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("initializes document mode from the routed pathname", () => {
    expect(initializeStandaloneRoute("/embed/studio-a")).toEqual({ kind: "embed", channelID: "studio-a" });
    expect(document.documentElement.classList.contains("embed-document")).toBe(true);
    expect(initializeStandaloneRoute("/view")).toEqual({ kind: "viewer" });
    expect(document.documentElement.classList.contains("embed-document")).toBe(false);
  });
});

function fixtureChannel(id: string, number: number, name: string, outputReady: boolean): Channel {
  return {
    id,
    revision: 1,
    number,
    name,
    path: id,
    enabled: true,
    automaticPreview: true,
    input: { mode: "srt-push", srt: { port: 10000, hasPassphrase: false } },
    maxReaders: 16,
    useAbsoluteTimestamp: true,
    applyState: "applied",
    createdAt: "2026-08-25T08:00:00Z",
    updatedAt: "2026-08-25T08:00:00Z",
    whepPath: `/api/v1/channels/${id}/whep`,
    viewerPath: "/view",
    embedPath: `/embed/${number}`,
    available: outputReady,
    online: outputReady,
    inboundBytes: 0,
    outputInboundBytes: 0,
    outboundBytes: 0,
    inboundFramesInError: 0,
    readers: [],
    tracks: [],
    outputReady,
    outputTracks: [],
    compatibility: {
      state: outputReady ? "ready" : "offline",
      mode: "direct",
      required: false,
      reasons: [],
      worker: { running: false, restarts: 0 },
    },
  };
}
