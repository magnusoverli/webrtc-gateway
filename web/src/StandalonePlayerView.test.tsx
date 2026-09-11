// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, ChannelRuntime } from "./channel";

const playerHarness = vi.hoisted(() => ({
  calls: vi.fn(),
  started: [] as string[],
  stopped: [] as string[],
}));

vi.mock("./useWHEPPlayer", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useWHEPPlayer: (options: { whepPath: string; enabled: boolean; outputGeneration?: string }) => {
      playerHarness.calls(options);
      React.useEffect(() => {
        if (!options.enabled) return;
        playerHarness.started.push(options.whepPath);
        return () => { playerHarness.stopped.push(options.whepPath); };
      }, [options.enabled, options.whepPath, options.outputGeneration]);
      return {
        videoRef: { current: null },
        state: "playing",
        error: "",
        stats: null,
        hasVideo: true,
        hasAudio: false,
        audioTrack: null,
      };
    },
  };
});

import { ChannelViewer, initializeStandaloneRoute, MultiviewGrid, StandalonePlayer } from "./StandalonePlayer";
import { multiviewOrderKey, readMultiviewOrder, multiviewSizesKey, readMultiviewSizes } from "./uiPreferences";

describe("ChannelViewer", () => {
  beforeEach(() => {
    localStorage.clear();
    playerHarness.calls.mockClear();
    playerHarness.started.length = 0;
    playerHarness.stopped.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.documentElement.classList.remove("embed-document");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    expect(videos.every((video) => !video.hasAttribute("controls") && (video as HTMLVideoElement).muted)).toBe(true);
    expect(screen.getByRole("group", { name: "Studio A audio meters" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Studio B audio meters" })).toBeDefined();
    expect(videos.every((video) => video.parentElement?.querySelector(".audio-meter"))).toBe(true);
    expect(screen.getAllByRole("meter")).toHaveLength(4);
    expect(document.querySelector(".audio-meter-status")).toBeNull();
    expect(playerHarness.calls).toHaveBeenCalledWith(expect.objectContaining({ whepPath: "/api/v1/channels/studio-a/whep", enabled: true }));
    expect(playerHarness.calls).toHaveBeenCalledWith(expect.objectContaining({ whepPath: "/api/v1/channels/studio-b/whep", enabled: false }));
    expect(fetch).toHaveBeenCalledWith("/api/v1/channels", expect.objectContaining({ cache: "no-store" }));
  });

  it("keeps navigation and status in a compact toolbar with on-demand reordering help", async () => {
    const channels = [fixtureChannel("studio", 1, "Studio", true)];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ channels }) }));
    render(<ChannelViewer />);
    await screen.findByRole("heading", { name: "Studio" });
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const overview = screen.getByRole("link", { name: "Overview" });
    expect(breadcrumb.contains(overview)).toBe(true);
    expect(overview.getAttribute("href")).toBe("/");
    expect(overview.getAttribute("target")).toBeNull();
    expect(screen.getByRole("heading", { name: "Multiviewer", level: 1 }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("1 channel · 1 ready").closest(".multiview-toolbar")).not.toBeNull();
    expect(document.querySelector(".viewer-brand, .viewer-footer, .multiview-help")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(screen.getByRole("button", { name: "Help: Reorder channels" }));
    expect(screen.getByRole("tooltip").textContent).toContain("Only the visible page plays.");
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
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(screen.getByRole("heading", { name: "Studio A" })).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("network down");
    expect(playerHarness.stopped).toEqual([]);
    expect(playerHarness.calls).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("falls back to a full multiview snapshot in the same poll on revision mismatch", async () => {
    vi.useFakeTimers();
    const original = fixtureChannel("studio-a", 1, "Studio A", true);
    const latest = { ...original, revision: 2, name: "Studio A Remote" };
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/channels/runtime") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [runtimeFor(latest)] }) });
      }
      if (url === "/api/v1/channels") {
        const fullReads = fetch.mock.calls.filter(([candidate]) => String(candidate) === url).length;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ channels: [fullReads === 1 ? original : latest] }) });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<ChannelViewer />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("heading", { name: "Studio A" })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(screen.getByRole("heading", { name: "Studio A Remote" })).toBeDefined();
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/channels",
      "/api/v1/channels/runtime",
      "/api/v1/channels",
    ]);
    expect(playerHarness.stopped).toEqual([]);
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

  it.each(["multiview", "embed"])("passes new output generations to a ready %s player within 500ms", async (surface) => {
    vi.useFakeTimers();
    const channel = fixtureChannel("studio-a", 7, "Studio A", true);
    const runtime = { ...runtimeFor(channel), outputGeneration: "restarted:direct", outputAvailableTime: "restarted" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
      ok: true, status: 200,
      json: async () => surface === "embed"
        ? (String(input).endsWith("/runtime") ? runtime : channel)
        : { channels: [String(input).endsWith("/runtime") ? runtime : channel] },
    })));
    render(surface === "embed" ? <StandalonePlayer channelID="7" /> : <ChannelViewer />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(playerHarness.started).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(playerHarness.stopped).toEqual([channel.whepPath]);
    expect(playerHarness.started).toHaveLength(2);
    expect(playerHarness.calls).toHaveBeenLastCalledWith(expect.objectContaining({ outputGeneration: "restarted:direct", enabled: true }));
  });

  describe("resizable multiview", () => {
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("multiview-grid") ? new DOMRect(0, 0, 400, 300) : new DOMRect();
      });
    });

    function resizeHandle(edge = "right", name = "Channel 1") {
      const handle = screen.getByRole("button", { name: `Resize ${name} ${edge} edge` });
      return handle;
    }

    it.each(["left", "right", "top", "bottom"])("resizes the %s edge, previews displacement, and persists only on release", (edge) => {
      render(<MultiviewGrid channels={fixtureChannels(4)} loaded />);
      const videos = [...document.querySelectorAll("video")];
      const handle = resizeHandle(edge);
      const point = { clientX: edge === "left" ? -100 : edge === "right" ? 100 : 0, clientY: edge === "top" ? -100 : edge === "bottom" ? 100 : 0 };
      fireEvent.mouseDown(handle, { button: 0 });
      fireEvent.mouseMove(document, point);
      const tile = handle.closest("article")!;
      expect(edge === "left" || edge === "right" ? tile.style.gridColumn : tile.style.gridRow).toBe("1 / span 2");
      expect(readMultiviewSizes()).toEqual({});
      fireEvent.mouseUp(document, point);
      expect(readMultiviewSizes()["channel-1"]).toEqual(edge === "left" || edge === "right" ? { columns: 2, rows: 1 } : { columns: 1, rows: 2 });
      expect([...document.querySelectorAll("video")]).toEqual(videos);
      expect(playerHarness.stopped).toEqual([]);
    });

    it.each(["left", "right", "top", "bottom"])("keeps intermediate %s edge sizes and displaces neighbors before reaching half a cell", (edge) => {
      render(<MultiviewGrid channels={fixtureChannels(4)} loaded />);
      const handle = resizeHandle(edge);
      const horizontal = edge === "left" || edge === "right";
      const point = { clientX: edge === "left" ? -15 : edge === "right" ? 15 : 0, clientY: edge === "top" ? -15 : edge === "bottom" ? 15 : 0 };
      fireEvent.mouseDown(handle, { button: 0 });
      fireEvent.mouseMove(document, point);
      const tile = handle.closest("article")!;
      expect(horizontal ? tile.style.gridColumn : tile.style.gridRow).toBe("1 / span 2");
      expect(parseFloat((horizontal ? tile.style.width : tile.style.height).slice(5))).toBeCloseTo(57.5);
      if (horizontal) expect(screen.getByLabelText("Channel 2 video").closest("article")!.style.gridColumn).toBe("3 / span 1");
      expect(readMultiviewSizes()).toEqual({});
      fireEvent.mouseUp(document, point);
      expect(readMultiviewSizes()["channel-1"]).toEqual(horizontal ? { columns: 1.15, rows: 1 } : { columns: 1, rows: 1.15 });
      fireEvent.doubleClick(tile.querySelector("video")!);
      expect(tile.style.width).toBe("");
      expect(tile.style.height).toBe("");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(parseFloat((horizontal ? tile.style.width : tile.style.height).slice(5))).toBeCloseTo(57.5);
      expect(playerHarness.stopped).toEqual([]);
    });

    it.each(["top-left", "top-right", "bottom-left", "bottom-right"])("uses the library's %s corner to resize both dimensions without remounting video", (corner) => {
      render(<MultiviewGrid channels={fixtureChannels(4)} loaded />);
      const video = screen.getByLabelText("Channel 1 video");
      const handle = screen.getByRole("button", { name: `Resize Channel 1 ${corner} corner` });
      expect(handle.classList.contains("react-resizable-handle")).toBe(true);
      expect(handle.tagName).toBe("SPAN");
      expect(handle.classList.length).toBe(2);
      expect(handle.getAttribute("style")).toBeNull();
      fireEvent.doubleClick(handle);
      expect(video.closest("article")!.classList.contains("is-fullscreen")).toBe(false);
      const point = { clientX: corner.endsWith("left") ? -25 : 25, clientY: corner.startsWith("top") ? -35 : 35 };
      fireEvent.mouseDown(handle, { button: 0 });
      fireEvent.mouseMove(document, point);
      expect(readMultiviewSizes()).toEqual({});
      fireEvent.mouseUp(document, point);
      expect(readMultiviewSizes()["channel-1"]).toEqual({ columns: 1.25, rows: 1.35 });
      expect(screen.getByLabelText("Channel 1 video")).toBe(video);
      expect(playerHarness.stopped).toEqual([]);
    });

    it("supports library touch resizing and releases its listeners after touch cancellation", () => {
      render(<MultiviewGrid channels={fixtureChannels(4)} loaded />);
      const start = { identifier: 42, clientX: 0, clientY: 0 };
      const move = { ...start, clientX: 25, clientY: 35 };
      const handle = screen.getByRole("button", { name: "Resize Channel 1 bottom-right corner" });
      fireEvent.touchStart(handle, { targetTouches: [start], touches: [start] });
      fireEvent.touchMove(document, { touches: [move], changedTouches: [move] });
      fireEvent.touchEnd(document, { changedTouches: [move] });
      expect(readMultiviewSizes()["channel-1"]).toEqual({ columns: 1.25, rows: 1.35 });
      fireEvent.touchStart(handle, { targetTouches: [start], touches: [start] });
      fireEvent.touchMove(document, { touches: [move], changedTouches: [move] });
      fireEvent.touchCancel(document, { changedTouches: [move] });
      fireEvent.touchEnd(document, { changedTouches: [move] });
      expect(readMultiviewSizes()["channel-1"]).toEqual({ columns: 1.25, rows: 1.35 });
      expect(playerHarness.stopped).toEqual([]);
    });

    it("offers fine keyboard adjustments and whole-cell adjustments with Shift", () => {
      render(<MultiviewGrid channels={fixtureChannels(1)} loaded />);
      const handle = resizeHandle();
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(readMultiviewSizes()["channel-1"].columns).toBe(1.1);
      fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
      expect(readMultiviewSizes()["channel-1"].columns).toBe(2.1);
      fireEvent.click(screen.getByRole("button", { name: "Reset Channel 1 size" }));
      expect(handle.closest("article")!.style.width).toBe("");
      expect(readMultiviewSizes()).toEqual({});
    });

    it.each(["Escape", "blur", "touchcancel"])("rolls back resize on %s without saving or restarting retained players", async (action) => {
      render(<MultiviewGrid channels={fixtureChannels(12)} loaded />);
      const handle = resizeHandle();
      fireEvent.mouseDown(handle, { button: 0 });
      fireEvent.mouseMove(document, { clientX: 100 });
      if (action === "Escape") fireEvent.keyDown(handle, { key: "Escape" });
      else fireEvent(action === "blur" ? window : document, new Event(action, { bubbles: true }));
      fireEvent.mouseUp(document, { clientX: 100 });
      expect(readMultiviewSizes()).toEqual({});
      expect(screen.getByText("Page 1 of 1")).toBeDefined();
      expect(resizeHandle().closest("article")!.style.gridColumn).toBe("1 / span 1");
      await waitFor(() => expect(document.body.classList.contains("react-draggable-transparent-selection")).toBe(false));
      expect(playerHarness.stopped).toEqual([]);
      fireEvent.mouseDown(resizeHandle(), { button: 0 });
      fireEvent.mouseMove(document, { clientX: 15 });
      fireEvent.mouseUp(document, { clientX: 15 });
      expect(readMultiviewSizes()["channel-1"].columns).toBe(1.15);
    });

    it("moves overflow to another page and resets to the default twelve slots", () => {
      const channels = fixtureChannels(12);
      const view = render(<MultiviewGrid channels={channels} loaded />);
      const retainedVideo = screen.getByLabelText("Channel 1 video");
      fireEvent.keyDown(resizeHandle(), { key: "ArrowRight" });
      expect(screen.getByText("Page 1 of 2")).toBeDefined();
      expect(document.querySelectorAll(".multiview-grid video")).toHaveLength(11);
      expect(playerHarness.stopped).toEqual([channels[11].whepPath]);
      expect(screen.getByLabelText("Channel 1 video")).toBe(retainedVideo);
      view.unmount();
      render(<MultiviewGrid channels={channels} loaded />);
      expect(screen.getByText("Page 1 of 2")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Reset Channel 1 size" }));
      expect(readMultiviewSizes()).toEqual({});
      expect(screen.getByText("Page 1 of 1")).toBeDefined();
      expect(document.querySelectorAll(".multiview-grid video")).toHaveLength(12);
    });

    it("follows a resized last tile to its new page and can cancel back to the original page", () => {
      render(<MultiviewGrid channels={fixtureChannels(12)} loaded />);
      const handle = resizeHandle("right", "Channel 12");
      fireEvent.mouseDown(handle, { button: 0 });
      fireEvent.mouseMove(document, { clientX: 100 });
      expect(screen.getByText("Page 2 of 2")).toBeDefined();
      fireEvent.keyDown(handle, { key: "Escape" });
      expect(screen.getByText("Page 1 of 1")).toBeDefined();
      expect(playerHarness.stopped).toEqual([]);
    });

    it("uses actual packed pages in the move dialog", () => {
      localStorage.setItem(multiviewSizesKey, JSON.stringify({ "channel-1": { columns: 4, rows: 3 } }));
      render(<MultiviewGrid channels={fixtureChannels(3)} loaded />);
      fireEvent.click(screen.getByRole("button", { name: "Move Channel 1" }));
      expect(screen.getByRole("option", { name: "Page 2, position 1 - Channel 2" })).toBeDefined();
      fireEvent.change(screen.getByLabelText("Destination position"), { target: { value: "channel-3" } });
      fireEvent.click(screen.getByRole("button", { name: "Move channel" }));
      expect(screen.getByText("Page 2 of 2")).toBeDefined();
      expect(screen.getByLabelText("Channel 1 video")).toBeDefined();
    });

    it("expands the same player on double-click and restores its saved size and focus on Escape", () => {
      render(<MultiviewGrid channels={fixtureChannels(2)} loaded />);
      fireEvent.keyDown(resizeHandle(), { key: "ArrowRight" });
      const video = screen.getByLabelText("Channel 1 video");
      const tile = video.closest("article")!;
      expect(screen.queryByRole("button", { name: "Fullscreen Channel 1" })).toBeNull();
      expect(tile.querySelector("header small")).toBeNull();
      video.focus();
      fireEvent.doubleClick(video);
      expect(tile.classList.contains("is-fullscreen")).toBe(true);
      expect(screen.getByLabelText("Channel 2 video").closest("article")!.hasAttribute("inert")).toBe(true);
      expect(screen.getByLabelText("Channel 1 video")).toBe(video);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(tile.classList.contains("is-fullscreen")).toBe(false);
      expect(tile.style.gridColumn).toBe("1 / span 2");
      expect(document.activeElement).toBe(video);
      expect(playerHarness.stopped).toEqual([]);
    });

    it("handles native fullscreen exit and rejected fullscreen requests", async () => {
      render(<MultiviewGrid channels={fixtureChannels(1)} loaded />);
      const tile = screen.getByLabelText("Channel 1 video").closest("article")!;
      const request = vi.fn().mockRejectedValueOnce(new Error("Not allowed"));
      Object.defineProperty(tile, "requestFullscreen", { configurable: true, value: request });
      await act(async () => { fireEvent.keyDown(screen.getByLabelText("Channel 1 video"), { key: "Enter" }); });
      expect(tile.classList.contains("is-fullscreen")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen for Channel 1" }));
      request.mockImplementationOnce(async () => {
        Object.defineProperty(document, "fullscreenElement", { configurable: true, value: tile });
        fireEvent(document, new Event("fullscreenchange"));
      });
      await act(async () => { fireEvent.doubleClick(tile); });
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      fireEvent(document, new Event("fullscreenchange"));
      expect(tile.classList.contains("is-fullscreen")).toBe(false);
      expect(playerHarness.started).toHaveLength(1);
    });
  });

  describe("paged multiview", () => {
    it.each([0, 1, 12, 13, 24, 25])("renders only real channels and current-page sessions for %i channels", (count) => {
      const channels = fixtureChannels(count);
      render(<MultiviewGrid channels={channels} loaded />);
      const pages = Math.max(1, Math.ceil(count / 12));

      for (let page = 0; page < pages; page++) {
        const visible = channels.slice(page * 12, (page + 1) * 12);
        expect(screen.getByText(`Page ${page + 1} of ${pages}`)).toBeDefined();
        expect(visibleChannelIDs()).toEqual(visible.map((channel) => channel.id));
        expect(document.querySelectorAll(".multiview-grid video")).toHaveLength(visible.length);
        expect(playerHarness.started).toEqual(channels.slice(0, (page + 1) * 12).map((channel) => channel.whepPath));
        expect(playerHarness.stopped).toEqual(channels.slice(0, page * 12).map((channel) => channel.whepPath));
        expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(page === 0);
        const next = screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement;
        expect(next.disabled).toBe(page === pages - 1);
        if (page < pages - 1) fireEvent.click(next);
      }
      if (count === 0) {
        expect(screen.getByText("Create a channel in Signal Desk. It will appear here automatically.")).toBeDefined();
        expect(playerHarness.calls).not.toHaveBeenCalled();
      }
      if (count === 1) expect((screen.getByRole("button", { name: "Move Channel 1" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("cleans up next and previous pages, then all remaining sessions on unmount", () => {
      const channels = fixtureChannels(25);
      const first = channels.slice(0, 12).map((channel) => channel.whepPath);
      const second = channels.slice(12, 24).map((channel) => channel.whepPath);
      const view = render(<MultiviewGrid channels={channels} loaded />);

      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(playerHarness.stopped).toEqual(first);
      expect(playerHarness.started).toEqual([...first, ...second]);
      fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
      expect(visibleChannelIDs()).toEqual(channels.slice(0, 12).map((channel) => channel.id));
      expect(playerHarness.stopped).toEqual([...first, ...second]);
      expect(playerHarness.started).toEqual([...first, ...second, ...first]);
      view.unmount();
      expect(playerHarness.stopped).toEqual(playerHarness.started);
    });

    it("does not highlight pagination drop targets when no drag is active", () => {
      render(<MultiviewGrid channels={fixtureChannels(13)} loaded />);
      expect(document.querySelector(".multiview-pagination .is-drop-target")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(document.querySelector(".multiview-pagination .is-drop-target")).toBeNull();
    });

    it("does not overwrite saved order until a definitive snapshot is loaded", () => {
      const channels = fixtureChannels(3);
      const saved = [channels[1].id, "stale", channels[0].id];
      localStorage.setItem(multiviewOrderKey, JSON.stringify(saved));
      const write = vi.spyOn(Storage.prototype, "setItem");
      const view = render(<MultiviewGrid channels={[]} loaded={false} />);
      expect(screen.getByText("Reading live output status.")).toBeDefined();
      expect(readMultiviewOrder()).toEqual(saved);
      expect(write).not.toHaveBeenCalled();

      view.rerender(<MultiviewGrid channels={channels} loaded />);
      expect(visibleChannelIDs()).toEqual([channels[1].id, channels[0].id, channels[2].id]);
      expect(readMultiviewOrder()).toEqual(visibleChannelIDs());
      view.rerender(<MultiviewGrid channels={[]} loaded />);
      expect(readMultiviewOrder()).toEqual([]);
      expect(playerHarness.stopped).toHaveLength(3);
    });

    it("clamps the page after removal without restarting retained tiles or returning to an old page", () => {
      const channels = fixtureChannels(25);
      const view = render(<MultiviewGrid channels={channels} loaded />);
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      playerHarness.started.length = 0;
      playerHarness.stopped.length = 0;

      view.rerender(<MultiviewGrid channels={channels.slice(0, 24)} loaded />);
      expect(screen.getByText("Page 2 of 2")).toBeDefined();
      expect(visibleChannelIDs()).toEqual(channels.slice(12, 24).map((channel) => channel.id));
      expect(playerHarness.stopped).toEqual([channels[24].whepPath]);
      expect(playerHarness.started).toEqual(channels.slice(12, 24).map((channel) => channel.whepPath));
      view.rerender(<MultiviewGrid channels={channels.slice(0, 13)} loaded />);
      expect(visibleChannelIDs()).toEqual([channels[12].id]);
      expect(playerHarness.stopped).toEqual([channels[24].whepPath, ...channels.slice(13, 24).map((channel) => channel.whepPath)]);
      expect(playerHarness.started).toHaveLength(12);
      view.rerender(<MultiviewGrid channels={channels.slice(0, 12)} loaded />);
      expect(screen.getByText("Page 1 of 1")).toBeDefined();
      view.rerender(<MultiviewGrid channels={channels} loaded />);
      expect(screen.getByText("Page 1 of 3")).toBeDefined();
      view.rerender(<MultiviewGrid channels={[]} loaded />);
      expect(screen.getByText("Page 1 of 1")).toBeDefined();
      expect(visibleChannelIDs()).toEqual([]);
    });

    it("inserts a channel on the same page without restarting keyed sessions and restores the saved order", () => {
      const channels = fixtureChannels(3);
      const view = render(<MultiviewGrid channels={channels} loaded />);
      fireEvent.click(screen.getByRole("button", { name: "Move Channel 1" }));
      expect(screen.getByRole("dialog", { name: "Move Channel 1" }).getAttribute("aria-modal")).toBe("true");
      fireEvent.change(screen.getByLabelText("Destination position"), { target: { value: channels[2].id } });
      fireEvent.click(screen.getByRole("button", { name: "Move channel" }));

      const expected = [channels[1].id, channels[2].id, channels[0].id];
      expect(visibleChannelIDs()).toEqual(expected);
      expect(readMultiviewOrder()).toEqual(expected);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("Channel 1 moved to page 1, position 3.");
      expect(playerHarness.started).toEqual(channels.map((channel) => channel.whepPath));
      expect(playerHarness.stopped).toEqual([]);
      view.unmount();
      render(<MultiviewGrid channels={channels} loaded />);
      expect(visibleChannelIDs()).toEqual(expected);
    });

    it("moves across pages through the dialog and cleans up only channels leaving the visible page", () => {
      const channels = fixtureChannels(25);
      render(<MultiviewGrid channels={channels} loaded />);
      fireEvent.click(screen.getByRole("button", { name: "Move Channel 2" }));
      expect(screen.getAllByRole("option")).toHaveLength(25);
      expect(screen.getByRole("option", { name: "Page 3, position 1 - Channel 25" }).getAttribute("value")).toBe(channels[24].id);
      fireEvent.change(screen.getByLabelText("Destination position"), { target: { value: channels[24].id } });
      fireEvent.click(screen.getByRole("button", { name: "Move channel" }));

      expect(screen.getByText("Page 3 of 3")).toBeDefined();
      expect(visibleChannelIDs()).toEqual([channels[1].id]);
      expect(readMultiviewOrder()).toEqual([...channels.filter((channel) => channel.id !== channels[1].id).map((channel) => channel.id), channels[1].id]);
      expect(playerHarness.started).toEqual(channels.slice(0, 12).map((channel) => channel.whepPath));
      expect(playerHarness.stopped).toEqual(channels.slice(0, 12).filter((channel) => channel.id !== channels[1].id).map((channel) => channel.whepPath));
    });

    it("uses current source and target positions when channels disappear while the move dialog is open", () => {
      const channels = fixtureChannels(4);
      const view = render(<MultiviewGrid channels={channels} loaded />);
      fireEvent.click(screen.getByRole("button", { name: "Move Channel 2" }));
      fireEvent.change(screen.getByLabelText("Destination position"), { target: { value: channels[3].id } });
      view.rerender(<MultiviewGrid channels={channels.slice(1)} loaded />);
      expect((screen.getByLabelText("Destination position") as HTMLSelectElement).value).toBe(channels[3].id);
      fireEvent.click(screen.getByRole("button", { name: "Move channel" }));
      expect(visibleChannelIDs()).toEqual([channels[2].id, channels[3].id, channels[1].id]);
      expect(readMultiviewOrder()).toEqual(visibleChannelIDs());
      expect(playerHarness.stopped).toEqual([channels[0].whepPath]);
    });

    it("disables a removed dialog target and closes when the source is removed", () => {
      const channels = fixtureChannels(3);
      const view = render(<MultiviewGrid channels={channels} loaded />);
      fireEvent.click(screen.getByRole("button", { name: "Move Channel 1" }));
      fireEvent.change(screen.getByLabelText("Destination position"), { target: { value: channels[2].id } });
      view.rerender(<MultiviewGrid channels={channels.slice(0, 2)} loaded />);
      const move = screen.getByRole("button", { name: "Move channel" }) as HTMLButtonElement;
      expect(move.disabled).toBe(true);
      fireEvent.click(move);
      expect(readMultiviewOrder()).toEqual(channels.slice(0, 2).map((channel) => channel.id));
      expect(screen.getAllByRole("option")).toHaveLength(2);
      view.rerender(<MultiviewGrid channels={[channels[1]]} loaded />);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(visibleChannelIDs()).toEqual([channels[1].id]);
    });

    it.each(["Cancel", "Close move channel", "Escape"])("cancels the move dialog with %s without changing storage or sessions", (action) => {
      const channels = fixtureChannels(3);
      render(<MultiviewGrid channels={channels} loaded />);
      const write = vi.spyOn(Storage.prototype, "setItem");
      fireEvent.click(screen.getByRole("button", { name: "Move Channel 1" }));
      fireEvent.change(screen.getByLabelText("Destination position"), { target: { value: channels[2].id } });
      if (action === "Escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      else fireEvent.click(screen.getByRole("button", { name: action }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(visibleChannelIDs()).toEqual(channels.map((channel) => channel.id));
      expect(write).not.toHaveBeenCalled();
      expect(playerHarness.stopped).toEqual([]);
    });

    it("keeps ordering usable when browser storage reads and writes are blocked", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
      const channels = fixtureChannels(2);
      render(<MultiviewGrid channels={channels} loaded />);
      fireEvent.click(screen.getByRole("button", { name: "Move Channel 2" }));
      fireEvent.change(screen.getByLabelText("Destination position"), { target: { value: channels[0].id } });
      fireEvent.click(screen.getByRole("button", { name: "Move channel" }));
      expect(visibleChannelIDs()).toEqual([channels[1].id, channels[0].id]);
      expect(playerHarness.stopped).toEqual([]);
    });

    describe("pointer moves", () => {
      beforeEach(() => {
        // jsdom lacks pointer identity, capture, and layout hit testing.
        vi.stubGlobal("PointerEvent", class extends MouseEvent {
          pointerId: number;
          isPrimary: boolean;
          pointerType: string;
          constructor(type: string, init: PointerEventInit = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 1;
            this.isPrimary = init.isPrimary ?? true;
            this.pointerType = init.pointerType ?? "mouse";
          }
        });
      });

      it.each(["mouse", "touch"])("reorders with a captured %s pointer at six pixels, without restarting sessions or opening a dialog", (pointerType) => {
        const channels = fixtureChannels(3);
        render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        const { capture } = mockPointer(handle);
        const videos = [...document.querySelectorAll("video")];
        const write = vi.spyOn(Storage.prototype, "setItem");
        fireEvent.pointerDown(handle, { pointerId: 7, pointerType, button: 0, clientX: 10, clientY: 10 });
        expect(capture).toHaveBeenCalledWith(7);
        fireEvent.pointerMove(handle, { pointerId: 8, clientX: 30, clientY: 10 });
        fireEvent.pointerMove(handle, { pointerId: 7, clientX: 15, clientY: 10 });
        expect(document.querySelector(".is-dragging")).toBeNull();
        fireEvent.pointerMove(handle, { pointerId: 7, clientX: 16, clientY: 10 });
        expect(handle.closest("article")?.classList.contains("is-dragging")).toBe(true);
        fireEvent.pointerMove(handle, { pointerId: 7, clientX: 210, clientY: 10 });
        expect(proposedChannelIDs()).toEqual([channels[1].id, channels[2].id, channels[0].id]);
        expect(document.querySelector("article.is-drop-target")?.getAttribute("data-move-target")).toBe(channels[0].id);
        expect(write).not.toHaveBeenCalled();
        expect(readMultiviewOrder()).toEqual(channels.map((channel) => channel.id));
        expect(document.querySelector(".multiview-drag-overlay")?.getAttribute("aria-hidden")).toBe("true");
        expect(document.querySelector(".multiview-drag-overlay video, .multiview-drag-overlay button")).toBeNull();
        expect([...document.querySelectorAll("video")]).toEqual(videos);
        fireEvent.pointerUp(handle, { pointerId: 8 });
        expect(proposedChannelIDs()).toEqual([channels[1].id, channels[2].id, channels[0].id]);
        fireEvent.pointerUp(handle, { pointerId: 7, clientX: 210, clientY: 10 });
        fireEvent.click(handle, { detail: 1 });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(visibleChannelIDs()).toEqual([channels[1].id, channels[2].id, channels[0].id]);
        expect(readMultiviewOrder()).toEqual(visibleChannelIDs());
        expect(write).toHaveBeenCalledTimes(1);
        expect(document.querySelector(".multiview-drag-overlay")).toBeNull();
        expect(document.activeElement).toBe(handle);
        expect([...document.querySelectorAll("video")]).toEqual(videos);
        expect(document.querySelector("article.is-dragging, article.is-drop-target")).toBeNull();
        expect(playerHarness.started).toHaveLength(3);
        expect(playerHarness.stopped).toEqual([]);
      });

      it("opens the move dialog for a handle click below the drag threshold", () => {
        render(<MultiviewGrid channels={fixtureChannels(2)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.pointerMove(handle, { clientX: 3, clientY: 4 });
        fireEvent.pointerUp(handle);
        fireEvent.click(handle, { detail: 1 });
        expect(screen.getByRole("dialog", { name: "Move Channel 1" })).toBeDefined();
      });

      it("ignores a secondary touch without clearing capture or post-drag click suppression", () => {
        render(<MultiviewGrid channels={fixtureChannels(3)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        fireEvent.pointerDown(handle, { pointerId: 1, button: 0, pointerType: "touch" });
        fireEvent.pointerMove(handle, { pointerId: 1, clientX: 210, clientY: 10 });
        fireEvent.pointerDown(handle, { pointerId: 2, button: 0, isPrimary: false, pointerType: "touch" });
        fireEvent.pointerCancel(handle, { pointerId: 2 });
        expect(document.querySelector(".multiview-drag-overlay")).not.toBeNull();
        fireEvent.pointerUp(handle, { pointerId: 1, clientX: 210, clientY: 10 });
        fireEvent.click(handle, { detail: 1 });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(readMultiviewOrder()).toEqual(["channel-2", "channel-3", "channel-1"]);
      });

      it.each(["handle", "backdrop"])("opens a stationary touch release without a compatibility click, and ignores a duplicate on the %s", async (target) => {
        render(<MultiviewGrid channels={fixtureChannels(2)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        fireEvent.pointerDown(handle, { pointerType: "touch", button: 0, clientX: 85, clientY: 10 });
        fireEvent.pointerUp(handle, { pointerType: "touch", clientX: 85, clientY: 10 });
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        expect(fireEvent.mouseDown(target === "handle" ? handle : document.querySelector(".editor-backdrop")!, { detail: 1 })).toBe(false);
        fireEvent.click(target === "handle" ? handle : document.querySelector(".editor-backdrop")!, { detail: 1 });
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        await act(async () => { fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); });
        expect(document.activeElement).toBe(handle);
        expect(screen.queryByRole("dialog")).toBeNull();
        fireEvent.click(handle, { detail: 0 });
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        expect(playerHarness.stopped).toEqual([]);
      });

      it("does not treat a cancelled or distant touch release as a tap", () => {
        render(<MultiviewGrid channels={fixtureChannels(2)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        fireEvent.pointerDown(handle, { pointerType: "touch", button: 0 });
        fireEvent.pointerUp(handle, { pointerType: "touch", clientX: 110 });
        expect(screen.queryByRole("dialog")).toBeNull();
        fireEvent.pointerDown(handle, { pointerType: "touch", button: 0 });
        fireEvent.pointerCancel(handle);
        fireEvent.pointerUp(handle, { pointerType: "touch" });
        expect(screen.queryByRole("dialog")).toBeNull();
      });

      it.each(["pointercancel", "lostpointercapture", "Escape"])("cancels a drag with %s and ignores subsequent pointer up", (action) => {
        const channels = fixtureChannels(3);
        render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        const write = vi.spyOn(Storage.prototype, "setItem");
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 210, clientY: 10 });
        expect(document.querySelector(".is-dragging")).not.toBeNull();
        expect(proposedChannelIDs()).toEqual([channels[1].id, channels[2].id, channels[0].id]);
        if (action === "Escape") fireEvent.keyDown(handle, { key: "Escape" });
        else fireEvent(handle, new PointerEvent(action, { bubbles: true }));
        fireEvent.pointerUp(handle);
        expect(document.querySelector("article.is-dragging, article.is-drop-target")).toBeNull();
        expect(document.querySelector(".multiview-drag-overlay")).toBeNull();
        expect(visibleChannelIDs()).toEqual(channels.map((channel) => channel.id));
        expect(write).not.toHaveBeenCalled();
        expect(playerHarness.stopped).toEqual([]);
      });

      it.each(["source", "target"])("cancels an active drag if its %s disappears", (removed) => {
        const channels = fixtureChannels(3);
        const view = render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        const browser = document.querySelector(".multiview-browser")!;
        mockPointer(handle);
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 210, clientY: 10 });
        const remaining = channels.filter((_, index) => index !== (removed === "source" ? 0 : 2));
        view.rerender(<MultiviewGrid channels={remaining} loaded />);
        const write = vi.spyOn(Storage.prototype, "setItem");
        fireEvent.pointerMove(browser, { clientX: 20 });
        fireEvent.pointerUp(browser);
        expect(document.querySelector("article.is-dragging, article.is-drop-target")).toBeNull();
        expect(document.querySelector(".multiview-drag-overlay")).toBeNull();
        expect(visibleChannelIDs()).toEqual(remaining.map((channel) => channel.id));
        expect(readMultiviewOrder()).toEqual(visibleChannelIDs());
        expect(write).not.toHaveBeenCalled();
      });

      it.each(["Next page", "Previous page"])("uses the first slot of the %s drop target and suppresses the following click", (direction) => {
        const channels = fixtureChannels(25);
        render(<MultiviewGrid channels={channels} loaded />);
        const backwards = direction === "Previous page";
        if (backwards) fireEvent.click(screen.getByRole("button", { name: "Next page" }));
        const sourceIndex = backwards ? 13 : 1;
        const targetIndex = backwards ? 0 : 12;
        const handle = screen.getByRole("button", { name: `Move Channel ${sourceIndex + 1}` });
        const target = screen.getByRole("button", { name: direction });
        expect(target.getAttribute("data-move-target")).toBe(channels[targetIndex].id);
        mockPointer(handle);
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: backwards ? 10 : 110, clientY: 210 });
        expect(target.classList.contains("is-drop-target")).toBe(true);
        expect(playerHarness.started).toHaveLength(backwards ? 24 : 12);
        expect(visibleChannelIDs()).toEqual(channels.slice(backwards ? 12 : 0, backwards ? 24 : 12).map((channel) => channel.id));
        fireEvent.pointerUp(handle, { clientX: backwards ? 10 : 110, clientY: 210 });
        fireEvent.click(target, { detail: 1 });
        const expected = channels.map((channel) => channel.id);
        expected.splice(sourceIndex, 1);
        expected.splice(targetIndex, 0, channels[sourceIndex].id);
        expect(readMultiviewOrder()).toEqual(expected);
        expect(screen.getByText(`Page ${backwards ? 1 : 2} of 3`)).toBeDefined();
        expect(visibleChannelIDs()).toEqual(expected.slice(targetIndex, targetIndex + 12));
        expect(visibleChannelIDs()[0]).toBe(channels[sourceIndex].id);
        expect(playerHarness.started.filter((path) => path === channels[sourceIndex].whepPath)).toHaveLength(1);
        expect(playerHarness.stopped).not.toContain(channels[sourceIndex].whepPath);
      });

      it("uses current source and target positions when another channel is removed during a drag", () => {
        const channels = fixtureChannels(4);
        const view = render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 2" });
        mockPointer(handle);
        fireEvent.pointerDown(handle, { button: 0, clientX: 110, clientY: 10 });
        fireEvent.pointerMove(handle, { clientX: 310, clientY: 10 });
        view.rerender(<MultiviewGrid channels={channels.slice(1)} loaded />);
        fireEvent.pointerUp(handle, { clientX: 210, clientY: 10 });
        expect(visibleChannelIDs()).toEqual([channels[2].id, channels[3].id, channels[1].id]);
        expect(readMultiviewOrder()).toEqual(visibleChannelIDs());
        expect(playerHarness.started).toHaveLength(4);
        expect(playerHarness.stopped).toEqual([channels[0].whepPath]);
      });

      it.each([{ button: 2 }, { button: 0, isPrimary: false }])("ignores non-primary pointer starts %j", (init) => {
        const channels = fixtureChannels(2);
        render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        const { capture } = mockPointer(handle);
        const write = vi.spyOn(Storage.prototype, "setItem");
        fireEvent.pointerDown(handle, init);
        fireEvent.pointerMove(handle, { clientX: 10 });
        fireEvent.pointerUp(handle);
        expect(capture).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(visibleChannelIDs()).toEqual(channels.map((channel) => channel.id));
      });

      it("rolls back outside the grid and in gaps, including pointerup without a last move", () => {
        const channels = fixtureChannels(2);
        render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        const write = vi.spyOn(Storage.prototype, "setItem");
        for (const clientX of [-60, 50, 210]) {
          fireEvent.pointerDown(handle, { button: 0 });
          fireEvent.pointerMove(handle, { clientX: 110, clientY: 10 });
          expect(proposedChannelIDs()).toEqual([channels[1].id, channels[0].id]);
          fireEvent.pointerUp(handle, { clientX, clientY: 10 });
        }
        expect(visibleChannelIDs()).toEqual(channels.map((channel) => channel.id));
        expect(write).not.toHaveBeenCalled();
      });

      it("uses current logical slots through repeated and reverse hovers and reordered server polls", () => {
        const channels = fixtureChannels(4);
        const view = render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        const write = vi.spyOn(Storage.prototype, "setItem");
        fireEvent.pointerDown(handle, { button: 0 });
        for (const slot of [2, 2, 1, 3, 0, 2, 2]) {
          fireEvent.pointerMove(handle, { clientX: slot * 100 + 10, clientY: 10 });
          const expected = channels.map((channel) => channel.id);
          expected.splice(0, 1);
          expected.splice(slot, 0, channels[0].id);
          expect(proposedChannelIDs()).toEqual(expected);
          view.rerender(<MultiviewGrid channels={[...channels].reverse()} loaded />);
          expect(proposedChannelIDs()).toEqual(expected);
        }
        expect(write).not.toHaveBeenCalled();
        fireEvent.pointerUp(handle, { clientX: 210, clientY: 10 });
        expect(readMultiviewOrder()).toEqual([channels[1].id, channels[2].id, channels[0].id, channels[3].id]);
        expect(playerHarness.started).toHaveLength(4);
        expect(playerHarness.stopped).toEqual([]);
      });

      it.each([
        [54.9, 0, false], [55, 0, false], [55.1, 0, true],
        [100, 49.9, true], [100, 50, false], [100, 50.1, false],
        [77.5, 100 / 3, false], [77.6, 100 / 3, true],
      ])("requires strictly half the full rectangular area (ghost %s,%s: %s)", (left, top, displaced) => {
        render(<MultiviewGrid channels={fixtureChannels(2)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        // Real handle near the top-right, not the tile center.
        fireEvent.pointerDown(handle, { button: 0, clientX: 85, clientY: 10 });
        fireEvent.pointerMove(handle, { clientX: left + 85, clientY: top + 10 });
        expect(proposedChannelIDs()).toEqual(displaced ? ["channel-2", "channel-1"] : ["channel-1", "channel-2"]);
        expect(readMultiviewOrder()).toEqual(["channel-1", "channel-2"]);
      });

      it("uses the full ghost even when the handle is over a neighbor or outside it", () => {
        render(<MultiviewGrid channels={fixtureChannels(2)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        fireEvent.pointerDown(handle, { button: 0, clientX: 85, clientY: 10 });
        // Pointer is inside tile 2, but only 30/90 of the ghost overlaps it.
        fireEvent.pointerMove(handle, { clientX: 125, clientY: 10 });
        expect(proposedChannelIDs()).toEqual(["channel-1", "channel-2"]);
        // Pointer is to its right, but 70/90 of the ghost overlaps it.
        fireEvent.pointerMove(handle, { clientX: 205, clientY: 10 });
        expect(proposedChannelIDs()).toEqual(["channel-2", "channel-1"]);
        fireEvent.pointerUp(handle, { clientX: 205, clientY: 10 });
        expect(readMultiviewOrder()).toEqual(["channel-2", "channel-1"]);
      });

      it.each([false, true])("retains the proposal across gaps, below threshold, and over its placeholder (drop: %s)", (drop) => {
        render(<MultiviewGrid channels={fixtureChannels(3)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        fireEvent.pointerDown(handle, { button: 0, clientX: 85, clientY: 10 });
        fireEvent.pointerMove(handle, { clientX: 285, clientY: 10 });
        const expected = ["channel-2", "channel-3", "channel-1"];
        for (const left of [200, 150, 155, 160, 200, 200]) {
          fireEvent.pointerMove(handle, { clientX: left + 85, clientY: 10 });
          expect(proposedChannelIDs()).toEqual(expected);
        }
        if (!drop) fireEvent.keyDown(handle, { key: "Escape" });
        fireEvent.pointerUp(handle, { clientX: 245, clientY: 10 });
        expect(readMultiviewOrder()).toEqual(drop ? expected : ["channel-1", "channel-2", "channel-3"]);
        expect(playerHarness.stopped).toEqual([]);
      });

      it("keeps the initial source slot valid before any displacement", () => {
        render(<MultiviewGrid channels={fixtureChannels(2)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        fireEvent.pointerDown(handle, { button: 0, clientX: 85, clientY: 10 });
        fireEvent.pointerMove(handle, { clientX: 95, clientY: 10 });
        fireEvent.pointerUp(handle, { clientX: 95, clientY: 10 });
        expect(readMultiviewOrder()).toEqual(["channel-1", "channel-2"]);
        expect(screen.getByRole("status").textContent).toContain("position 1");
      });

      it("handles vertical thresholds, row edges, large jumps, and reversing through provisional slots", () => {
        const channels = fixtureChannels(12);
        render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 4" });
        mockPointer(handle, 4);
        fireEvent.pointerDown(handle, { button: 0, clientX: 385, clientY: 10 });
        for (const top of [59.9, 60]) {
          fireEvent.pointerMove(handle, { clientX: 385, clientY: top + 10 });
          expect(proposedChannelIDs()).toEqual(channels.map(channel => channel.id));
        }
        for (const [slot, top] of [[7, 60.1], [7, 110], [4, 110], [11, 220], [0, 0], [3, 0], [3, 0]]) {
          fireEvent.pointerMove(handle, { clientX: slot % 4 * 100 + 85, clientY: top + 10 });
          const expected = channels.map(channel => channel.id);
          expected.splice(3, 1); expected.splice(slot, 0, channels[3].id);
          expect(proposedChannelIDs()).toEqual(expected);
        }
        fireEvent.pointerUp(handle, { clientX: 385, clientY: 10 });
        expect(readMultiviewOrder()).toEqual(channels.map(channel => channel.id));
        expect(playerHarness.started).toHaveLength(12);
        expect(playerHarness.stopped).toEqual([]);
      });

      it("captures just one frame and cleans up capture, overlay, and animations on unmount", () => {
        const view = render(<MultiviewGrid channels={fixtureChannels(3)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        const video = handle.closest("article")!.querySelector("video")!;
        Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
        const drawImage = vi.fn();
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
        const release = vi.fn();
        Object.defineProperties(handle, { hasPointerCapture: { value: () => true }, releasePointerCapture: { value: release } });
        fireEvent.pointerDown(handle, { button: 0 });
        for (const clientX of [110, 210, 110]) fireEvent.pointerMove(handle, { clientX, clientY: 10 });
        expect(drawImage).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll(".multiview-drag-overlay canvas")).toHaveLength(1);
        view.unmount();
        expect(release).toHaveBeenCalledTimes(1);
        expect(document.querySelector(".multiview-drag-overlay")).toBeNull();
      });

      it.each([false, true])("animates only changed slots and releases drag resources (reduced motion: %s)", (reduced) => {
        const motion = { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() };
        vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(motion));
        const view = render(<MultiviewGrid channels={fixtureChannels(3)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
        const animate = vi.fn(() => {
          const animation = { cancel: vi.fn(), onfinish: null };
          animations.push(animation);
          return animation;
        });
        document.querySelectorAll("article").forEach((tile) => Object.defineProperty(tile, "animate", { value: animate }));
        const removeListener = vi.spyOn(window, "removeEventListener");
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 210, clientY: 10 });
        expect(animate).toHaveBeenCalledTimes(reduced ? 0 : 3);
        if (!reduced) expect(animate).toHaveBeenCalledWith(expect.any(Array), { duration: 460, easing: "cubic-bezier(.22,.68,.2,1)" });
        fireEvent.pointerMove(handle, { clientX: 220, clientY: 10 });
        expect(animate).toHaveBeenCalledTimes(reduced ? 0 : 3);
        expect(document.querySelector<HTMLElement>(".multiview-drag-overlay")?.style.transform).toBe("translate3d(220px, 10px, 0)");
        view.unmount();
        expect(animations.every((animation) => animation.cancel.mock.calls.length === 1 && animation.onfinish === null)).toBe(true);
        expect(removeListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
        expect(motion.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
      });

      it("lets a short drop finish its existing glide across polling and still honors a motion preference change", () => {
        const motion = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
        vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(motion));
        const channels = fixtureChannels(6);
        const view = render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
        const animate = vi.fn(() => {
          const animation = { cancel: vi.fn(), onfinish: null };
          animations.push(animation);
          return animation;
        });
        document.querySelectorAll("article").forEach(tile => Object.defineProperty(tile, "animate", { value: animate }));
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 110, clientY: 10 });
        fireEvent.pointerUp(handle, { clientX: 110, clientY: 10 });
        view.rerender(<MultiviewGrid channels={[...channels].reverse()} loaded />);
        expect(document.querySelector(".multiview-drag-overlay")).toBeNull();
        expect(animate).toHaveBeenCalledTimes(2);
        expect(animations.every(animation => animation.cancel.mock.calls.length === 0)).toBe(true);
        expect(readMultiviewOrder()).toEqual([channels[1].id, channels[0].id, ...channels.slice(2).map(channel => channel.id)]);
        expect(playerHarness.started).toHaveLength(6);
        expect(playerHarness.stopped).toEqual([]);
        motion.matches = true;
        act(() => motion.addEventListener.mock.calls[0][1]());
        expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
      });

      it("animates a different final pointerup slot from the interrupted visual positions", () => {
        render(<MultiviewGrid channels={fixtureChannels(3)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
        const animate = vi.fn(() => {
          const animation = { cancel: vi.fn(), onfinish: null };
          animations.push(animation);
          return animation;
        });
        const tiles = [...document.querySelectorAll("article")];
        tiles.forEach(tile => Object.defineProperty(tile, "animate", { value: animate }));
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 110, clientY: 10 });
        // The second neighbor is still 70px from its provisional destination.
        vi.spyOn(tiles[1], "getBoundingClientRect").mockReturnValueOnce(new DOMRect(70, 0, 90, 90));
        fireEvent.pointerUp(handle, { clientX: 210, clientY: 10 });
        expect(animations.slice(0, 2).every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
        expect(animate).toHaveBeenCalledWith([{ transform: "translate(70px, 0px)" }, { transform: "translate(0, 0)" }], expect.any(Object));
        expect(animations.slice(2).every(animation => animation.cancel.mock.calls.length === 0)).toBe(true);
      });

      it("defers newly polled page members until drag ends without losing the provisional positions", () => {
        const channels = fixtureChannels(4);
        const view = render(<MultiviewGrid channels={channels.slice(0, 3)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 210, clientY: 10 });
        view.rerender(<MultiviewGrid channels={[...channels].reverse()} loaded />);
        expect(proposedChannelIDs()).toEqual([channels[1].id, channels[2].id, channels[0].id]);
        expect(playerHarness.started).toHaveLength(3);
        fireEvent.keyDown(window, { key: "Escape" });
        expect(visibleChannelIDs()).toEqual(channels.map((channel) => channel.id));
        expect(playerHarness.started).toHaveLength(4);
        expect(playerHarness.stopped).toHaveLength(0);
        expect(document.activeElement).toBe(handle);
      });

      it("falls back to text if the current video frame cannot be captured", () => {
        render(<MultiviewGrid channels={fixtureChannels(2)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle);
        const video = handle.closest("article")!.querySelector("video")!;
        Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => { throw new Error("protected"); });
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 110, clientY: 10 });
        expect(document.querySelector(".multiview-drag-overlay")?.textContent).toContain("Video frame unavailable");
        expect(document.querySelector(".multiview-drag-overlay canvas")).toBeNull();
      });
    });
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

  it("uses focused runtime polling and treats deletion as definitive", async () => {
    vi.useFakeTimers();
    const channel = fixtureChannel("studio-a", 7, "Studio A", true);
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/channels/7") {
        return Promise.resolve({ ok: true, status: 200, json: async () => channel });
      }
      if (url === "/api/v1/channels/7/runtime") {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "channel not found" }) });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<StandalonePlayer channelID="7" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByLabelText("Studio A embedded video")).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(screen.getByLabelText("Embedded channel video")).toBeDefined();
    expect(playerHarness.stopped).toEqual([channel.whepPath]);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/channels/7",
      "/api/v1/channels/7/runtime",
    ]);
  });

  it("keeps using focused runtime polling after a full fallback confirms absence", async () => {
    vi.useFakeTimers();
    const original = fixtureChannel("studio-a", 7, "Studio A", true);
    const changed = { ...original, revision: 2 };
    let fullReads = 0;
    let runtimeReads = 0;
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/channels/7") {
        fullReads += 1;
        return Promise.resolve(fullReads === 1
          ? { ok: true, status: 200, json: async () => original }
          : { ok: false, status: 404, json: async () => ({ error: "channel not found" }) });
      }
      if (url === "/api/v1/channels/7/runtime") {
        runtimeReads += 1;
        return Promise.resolve(runtimeReads === 1
          ? { ok: true, status: 200, json: async () => runtimeFor(changed) }
          : { ok: false, status: 404, json: async () => ({ error: "channel not found" }) });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<StandalonePlayer channelID="7" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByLabelText("Embedded channel video")).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/channels/7",
      "/api/v1/channels/7/runtime",
      "/api/v1/channels/7",
      "/api/v1/channels/7/runtime",
    ]);
  });

  it("initializes document mode from the routed pathname", () => {
    expect(initializeStandaloneRoute("/embed/studio-a")).toEqual({ kind: "embed", channelID: "studio-a" });
    expect(document.documentElement.classList.contains("embed-document")).toBe(true);
    expect(initializeStandaloneRoute("/view")).toEqual({ kind: "viewer" });
    expect(document.documentElement.classList.contains("embed-document")).toBe(false);
  });
});

function fixtureChannels(count: number) {
  return Array.from({ length: count }, (_, index) => fixtureChannel(`channel-${index + 1}`, index + 1, `Channel ${index + 1}`, true));
}

function visibleChannelIDs() {
  return proposedChannelIDs();
}

function proposedChannelIDs() {
  return [...document.querySelectorAll<HTMLElement>("article[data-move-target]")]
    .sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((tile) => tile.dataset.moveTarget);
}

function mockPointer(handle: HTMLElement, columns = Infinity) {
  const capture = vi.fn();
  Object.defineProperty(handle, "setPointerCapture", { configurable: true, value: capture });
  for (const tile of document.querySelectorAll<HTMLElement>("article[data-move-target]")) {
    Object.defineProperties(tile, {
      offsetLeft: { configurable: true, get: () => Number(tile.style.order) % columns * 100 },
      offsetTop: { configurable: true, get: () => Math.floor(Number(tile.style.order) / columns) * 110 },
      offsetWidth: { configurable: true, value: 90 },
      offsetHeight: { configurable: true, value: 100 },
    });
    vi.spyOn(tile, "getBoundingClientRect").mockImplementation(() => new DOMRect(tile.offsetLeft, tile.offsetTop, 90, 100));
  }
  document.querySelectorAll(".multiview-pagination button").forEach((button, index) => {
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(index * 100, 200, 90, 30));
  });
  return { capture };
}

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
    availableTime: outputReady ? "input" : undefined,
    online: outputReady,
    inputGeneration: outputReady ? "input:" : ":",
    inboundBytes: 0,
    outputInboundBytes: 0,
    outputGeneration: outputReady ? "output:direct" : ":direct",
    outputAvailableTime: outputReady ? "output" : undefined,
    outboundBytes: 0,
    inboundFramesInError: 0,
    readers: [],
    readerCount: 0,
    tracks: [],
    outputReady,
    outputTracks: [],
    issues: [],
    compatibility: {
      state: outputReady ? "ready" : "offline",
      mode: "direct",
      required: false,
      reasons: [],
      worker: { running: false, restarts: 0 },
    },
  };
}

function runtimeFor(channel: Channel): ChannelRuntime {
  return {
    id: channel.id,
    revision: channel.revision,
    applyState: channel.applyState,
    applyError: channel.applyError,
    available: channel.available,
    availableTime: channel.availableTime,
    online: channel.online,
    onlineTime: channel.onlineTime,
    inputGeneration: channel.inputGeneration,
    inboundBytes: channel.inboundBytes,
    outputInboundBytes: channel.outputInboundBytes,
    outputAvailableTime: channel.outputAvailableTime,
    outputGeneration: channel.outputGeneration,
    outboundBytes: channel.outboundBytes,
    inboundFramesInError: channel.inboundFramesInError,
    readerCount: channel.readerCount,
    tracks: channel.tracks,
    outputReady: channel.outputReady,
    outputTracks: channel.outputTracks,
    compatibility: channel.compatibility,
    relay: channel.relay,
    issues: channel.issues,
  };
}
