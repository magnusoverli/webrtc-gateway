// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
        audioTrack: null,
      };
    },
  };
});

import { ChannelViewer, initializeStandaloneRoute, MultiviewGrid, StandalonePlayer } from "./StandalonePlayer";
import { multiviewOrderKey, readMultiviewOrder } from "./uiPreferences";

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
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

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
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

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

      afterEach(() => {
        Reflect.deleteProperty(document, "elementFromPoint");
      });

      it.each(["mouse", "touch"])("reorders with a captured %s pointer at six pixels, without restarting sessions or opening a dialog", (pointerType) => {
        const channels = fixtureChannels(3);
        render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        const { hit, capture } = mockPointer(handle, screen.getByRole("heading", { name: "Channel 3" }));
        fireEvent.pointerDown(handle, { pointerId: 7, pointerType, button: 0, clientX: 10, clientY: 10 });
        expect(capture).toHaveBeenCalledWith(7);
        fireEvent.pointerMove(handle, { pointerId: 8, clientX: 30, clientY: 10 });
        fireEvent.pointerMove(handle, { pointerId: 7, clientX: 15, clientY: 10 });
        expect(hit).not.toHaveBeenCalled();
        expect(document.querySelector(".is-dragging")).toBeNull();
        fireEvent.pointerMove(handle, { pointerId: 7, clientX: 16, clientY: 10 });
        expect(hit).toHaveBeenCalledWith(16, 10);
        expect(handle.closest("article")?.classList.contains("is-dragging")).toBe(true);
        expect(document.querySelector("article.is-drop-target")?.getAttribute("data-move-target")).toBe(channels[2].id);
        fireEvent.pointerUp(handle, { pointerId: 8 });
        expect(visibleChannelIDs()).toEqual(channels.map((channel) => channel.id));
        fireEvent.pointerUp(handle, { pointerId: 7 });
        fireEvent.click(handle, { detail: 1 });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(visibleChannelIDs()).toEqual([channels[1].id, channels[2].id, channels[0].id]);
        expect(readMultiviewOrder()).toEqual(visibleChannelIDs());
        expect(document.querySelector("article.is-dragging, article.is-drop-target")).toBeNull();
        expect(playerHarness.started).toHaveLength(3);
        expect(playerHarness.stopped).toEqual([]);
      });

      it("opens the move dialog for a handle click below the drag threshold", () => {
        render(<MultiviewGrid channels={fixtureChannels(2)} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        const { hit } = mockPointer(handle, screen.getByRole("heading", { name: "Channel 2" }));
        fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0 });
        fireEvent.pointerMove(handle, { clientX: 3, clientY: 4 });
        fireEvent.pointerUp(handle);
        fireEvent.click(handle, { detail: 1 });
        expect(hit).not.toHaveBeenCalled();
        expect(screen.getByRole("dialog", { name: "Move Channel 1" })).toBeDefined();
      });

      it.each(["pointercancel", "lostpointercapture", "Escape"])("cancels a drag with %s and ignores subsequent pointer up", (action) => {
        const channels = fixtureChannels(3);
        render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        mockPointer(handle, screen.getByRole("heading", { name: "Channel 3" }));
        const write = vi.spyOn(Storage.prototype, "setItem");
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 10 });
        expect(document.querySelector(".is-dragging")).not.toBeNull();
        if (action === "Escape") fireEvent.keyDown(handle, { key: "Escape" });
        else fireEvent(handle, new PointerEvent(action, { bubbles: true }));
        fireEvent.pointerUp(handle);
        expect(document.querySelector("article.is-dragging, article.is-drop-target")).toBeNull();
        expect(visibleChannelIDs()).toEqual(channels.map((channel) => channel.id));
        expect(write).not.toHaveBeenCalled();
        expect(playerHarness.stopped).toEqual([]);
      });

      it.each(["source", "target"])("cancels an active drag if its %s disappears", (removed) => {
        const channels = fixtureChannels(3);
        const view = render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        const browser = document.querySelector(".multiview-browser")!;
        mockPointer(handle, screen.getByRole("heading", { name: "Channel 3" }));
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 10 });
        const remaining = channels.filter((_, index) => index !== (removed === "source" ? 0 : 2));
        view.rerender(<MultiviewGrid channels={remaining} loaded />);
        const write = vi.spyOn(Storage.prototype, "setItem");
        fireEvent.pointerMove(browser, { clientX: 20 });
        fireEvent.pointerUp(browser);
        expect(document.querySelector("article.is-dragging, article.is-drop-target")).toBeNull();
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
        mockPointer(handle, target);
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 10 });
        fireEvent.pointerUp(handle);
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
        mockPointer(handle, screen.getByRole("heading", { name: "Channel 4" }));
        fireEvent.pointerDown(handle, { button: 0 });
        fireEvent.pointerMove(handle, { clientX: 10 });
        view.rerender(<MultiviewGrid channels={channels.slice(1)} loaded />);
        fireEvent.pointerUp(handle);
        expect(visibleChannelIDs()).toEqual([channels[2].id, channels[3].id, channels[1].id]);
        expect(readMultiviewOrder()).toEqual(visibleChannelIDs());
        expect(playerHarness.started).toHaveLength(4);
        expect(playerHarness.stopped).toEqual([channels[0].whepPath]);
      });

      it.each([{ button: 2 }, { button: 0, isPrimary: false }])("ignores non-primary pointer starts %j", (init) => {
        const channels = fixtureChannels(2);
        render(<MultiviewGrid channels={channels} loaded />);
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        const { capture, hit } = mockPointer(handle, screen.getByRole("heading", { name: "Channel 2" }));
        const write = vi.spyOn(Storage.prototype, "setItem");
        fireEvent.pointerDown(handle, init);
        fireEvent.pointerMove(handle, { clientX: 10 });
        fireEvent.pointerUp(handle);
        expect(capture).not.toHaveBeenCalled();
        expect(hit).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(visibleChannelIDs()).toEqual(channels.map((channel) => channel.id));
      });

      it("does not drop onto targets outside the grid or empty hit-test results", () => {
        const channels = fixtureChannels(2);
        render(<MultiviewGrid channels={channels} loaded />);
        const outside = document.createElement("div");
        outside.dataset.moveTarget = channels[1].id;
        const handle = screen.getByRole("button", { name: "Move Channel 1" });
        const { hit } = mockPointer(handle, outside);
        const write = vi.spyOn(Storage.prototype, "setItem");
        for (const target of [outside, null]) {
          hit.mockReturnValue(target);
          fireEvent.pointerDown(handle, { button: 0 });
          fireEvent.pointerMove(handle, { clientX: 10 });
          fireEvent.pointerUp(handle);
        }
        expect(visibleChannelIDs()).toEqual(channels.map((channel) => channel.id));
        expect(write).not.toHaveBeenCalled();
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
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

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
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByLabelText("Embedded channel video")).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

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
  return Array.from(document.querySelectorAll("article[data-move-target]"), (tile) => tile.getAttribute("data-move-target"));
}

function mockPointer(handle: HTMLElement, target: Element) {
  const capture = vi.fn();
  const hit = vi.fn<(...coordinates: number[]) => Element | null>().mockReturnValue(target);
  Object.defineProperty(handle, "setPointerCapture", { configurable: true, value: capture });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  return { capture, hit };
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
    online: outputReady,
    inputGeneration: outputReady ? "input:" : ":",
    inboundBytes: 0,
    outputInboundBytes: 0,
    outputGeneration: outputReady ? "output:direct" : ":direct",
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
