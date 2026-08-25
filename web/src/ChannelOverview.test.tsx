// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, ChannelStreamRates } from "./channel";
import { ChannelOverview, type OverviewFilter, type OverviewLayout } from "./ChannelOverview";

const overviewPlayerHarness = vi.hoisted(() => ({ calls: vi.fn(), cardRenders: vi.fn() }));

vi.mock("./presentation", async () => {
  const presentation = await vi.importActual<typeof import("./presentation")>("./presentation");
  return {
    ...presentation,
    inputModeLabel: (mode: Parameters<typeof presentation.inputModeLabel>[0]) => {
      overviewPlayerHarness.cardRenders(mode);
      return presentation.inputModeLabel(mode);
    },
  };
});

vi.mock("./useWHEPPlayer", () => ({
  useWHEPPlayer: (options: unknown) => {
    overviewPlayerHarness.calls(options);
    return { videoRef: { current: null }, state: "off", error: "", stats: null, hasVideo: false, hasAudio: false };
  },
}));

afterEach(() => {
  cleanup();
  overviewPlayerHarness.calls.mockClear();
  overviewPlayerHarness.cardRenders.mockClear();
});

describe("ChannelOverview", () => {
  it("reports controlled query and filter changes and preserves channel order", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onFilterChange = vi.fn();
    const channels = [channel("third", "Zulu", "idle"), channel("first", "Alpha", "live"), channel("second", "Alpine", "fault")];
    const view = renderOverview({ channels, query: "Al", onQueryChange, onFilterChange });

    expect(cardNames()).toEqual(["Alpha", "Alpine"]);
    await user.type(screen.getByRole("searchbox", { name: "Search channels" }), "p");
    expect(onQueryChange).toHaveBeenLastCalledWith("Alp");
    await user.click(screen.getByRole("button", { name: "Fault" }));
    expect(onFilterChange).toHaveBeenCalledWith("fault");

    view.rerender(overview({ channels, query: "Al", filter: "fault", onQueryChange, onFilterChange }));
    expect(cardNames()).toEqual(["Alpine"]);
  });

  it("uses channel tone for filtering and card presentation", () => {
    renderOverview({ channels: [channel("live", "Live", "live"), channel("starting", "Starting", "starting"), channel("fault", "Fault", "fault"), channel("idle", "Idle", "idle")] });

    expect(screen.getByRole("button", { name: "Open details for Live" }).closest("article")?.className).toContain("tone-live");
    expect(screen.getByRole("button", { name: "Open details for Starting" }).closest("article")?.className).toContain("tone-starting");
    expect(screen.getByRole("button", { name: "Open details for Starting" }).closest("article")?.querySelector(".signal")?.className).toContain("starting");
    expect(screen.getByRole("button", { name: "Open details for Fault" }).closest("article")?.className).toContain("tone-fault");
    expect(screen.getByRole("button", { name: "Open details for Idle" }).closest("article")?.className).toContain("tone-idle");
    expect(screen.getByLabelText("Applying configuration").textContent).toBe("Applying");
    expect(screen.getByLabelText("Configuration error").textContent).toBe("Config error");
    expect(screen.getByLabelText("Listener ready - waiting for encoder").textContent).toBe("Listener ready");
  });

  it("indicates the active output route for grid channels", () => {
    const direct = channel("direct", "Direct", "live");
    const transcoded = channel("transcoded", "Transcoded", "live");
    transcoded.compatibility = { ...transcoded.compatibility, mode: "transcoded", worker: { ...transcoded.compatibility.worker, running: true } };
    const starting = channel("starting", "Starting", "starting");
    starting.compatibility = { ...starting.compatibility, mode: "transcoded", state: "starting" };
    const inactive = channel("inactive", "Inactive", "idle");
    renderOverview({ channels: [direct, transcoded, starting, inactive] });

    expect(screen.getByLabelText("Passthrough active for Direct").className).toContain("active");
    expect(screen.getByLabelText("Transcoding active for Transcoded").className).toContain("active");
    expect(screen.getByLabelText("Transcoding inactive for Starting").className).toBe("overview-route");
    expect(screen.queryByLabelText("Passthrough inactive for Inactive")).toBeNull();
  });

  it("renders loading, initial error retry, no-channel, and filtered-empty copy", async () => {
    const user = userEvent.setup();
    const loading = renderOverview({ loading: true });
    expect(screen.getByRole("status").textContent).toBe("Loading channels...");

    const onRetry = vi.fn();
    loading.rerender(overview({ loading: true, error: "offline", onRetry }));
    expect(screen.getByRole("heading", { name: "Unable to load channels" })).toBeDefined();
    expect(screen.getByText("Gateway status is not responding. Check the connection and try again.")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();

    loading.rerender(overview());
    expect(screen.getByRole("heading", { name: "No channels configured" })).toBeDefined();
    expect(screen.getByText("Create an RTP or SRT channel to begin routing media.")).toBeDefined();

    loading.rerender(overview({ channels: [channel("one", "Studio", "idle")], query: "news" }));
    expect(screen.getByText('No channels match "news".')).toBeDefined();
    loading.rerender(overview({ channels: [channel("one", "Studio", "idle")], filter: "live" }));
    expect(screen.getByText("No channels match the live filter.")).toBeDefined();
  });

  it("keeps the whole-card detail action in grid and list layouts", async () => {
    const user = userEvent.setup();
    const onLayoutChange = vi.fn();
    const channels = [channel("one", "Studio", "live")];
    const view = renderOverview({ channels, layout: "grid", onLayoutChange });

    expect(screen.getByRole("button", { name: "Open details for Studio" })).toBeDefined();
    expect(screen.queryByText("Open")).toBeNull();
    expect(document.querySelector(".overview-grid")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(onLayoutChange).toHaveBeenCalledWith("list");

    view.rerender(overview({ channels, layout: "list", onLayoutChange }));
    expect(screen.getByRole("button", { name: "Open details for Studio" })).toBeDefined();
    expect(document.querySelector(".overview-list")).not.toBeNull();
  });

  it("opens natively by mouse, Enter, and Space while configure remains isolated", async () => {
    const user = userEvent.setup();
    const item = channel("one", "Studio", "live");
    const onSelect = vi.fn();
    const onEdit = vi.fn();
    renderOverview({ channels: [item], onSelect, onEdit });
    const open = screen.getByRole("button", { name: "Open details for Studio" });

    await user.click(open);
    open.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenLastCalledWith("one");

    await user.click(screen.getByRole("button", { name: "Configure Studio" }));
    expect(onEdit).toHaveBeenCalledWith(item);
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("toggles preview without opening the channel", async () => {
    const user = userEvent.setup();
    const item = channel("one", "Studio", "live");
    const onSelect = vi.fn();
    const onAutomaticPreviewChange = vi.fn();
    renderOverview({ channels: [item], onSelect, onAutomaticPreviewChange });

    const toggle = screen.getByRole("button", { name: "Enable preview for Studio" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);

    expect(onAutomaticPreviewChange).toHaveBeenCalledWith(item, true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("disables overview playback and hides preview controls in list layout", () => {
    const item = { ...channel("one", "Studio", "live"), automaticPreview: true };
    const view = renderOverview({ channels: [item], layout: "grid" });

    expect(overviewPlayerHarness.calls).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    expect(screen.getByRole("button", { name: "Disable preview for Studio" })).toBeDefined();

    overviewPlayerHarness.calls.mockClear();
    view.rerender(overview({ channels: [item], layout: "list" }));
    expect(overviewPlayerHarness.calls).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(screen.queryByRole("button", { name: "Disable preview for Studio" })).toBeNull();
    expect(screen.queryByLabelText(/Studio preview:/)).toBeNull();

    overviewPlayerHarness.calls.mockClear();
    view.rerender(overview({ channels: [item], layout: "grid" }));
    expect(overviewPlayerHarness.calls).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    expect(screen.getByRole("button", { name: "Disable preview for Studio" })).toBeDefined();
  });

  it("shows preview state in the grid tile", () => {
    const item = channel("one", "Studio", "idle");
    const view = renderOverview({ channels: [item] });
    expect(screen.getByLabelText("Studio preview: Preview off").textContent).toContain("Preview off");
    expect((screen.getByLabelText("Studio muted preview") as HTMLVideoElement).controls).toBe(false);

    view.rerender(overview({ channels: [{ ...item, automaticPreview: true }] }));
    expect(screen.getByLabelText("Studio preview: Waiting for input").textContent).toContain("Waiting for input");
  });

  it("labels control groups and exposes selected controls", () => {
    renderOverview({ channels: [channel("one", "Studio", "live")], filter: "live", layout: "list" });

    const filters = screen.getByRole("group", { name: "Filter channels" });
    expect(within(filters).getByRole("button", { name: "Live" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(filters).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    const layouts = screen.getByRole("group", { name: "Channel layout" });
    expect(within(layouts).getByRole("button", { name: "List view" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(layouts).getByRole("button", { name: "Grid view" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps an established preview enabled while stale and disables every card mutation", () => {
    const item = { ...channel("one", "Studio", "live"), automaticPreview: true };
    renderOverview({ channels: [item], error: "disconnected", mutationsDisabled: true });

    expect(overviewPlayerHarness.calls).toHaveBeenCalledWith(expect.objectContaining({ whepPath: item.whepPath, enabled: true }));
    expect(screen.getByRole("button", { name: "Add channel" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Configure Studio" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Disable preview for Studio" }).hasAttribute("disabled")).toBe(true);
    expect(document.querySelectorAll(".overview-card [aria-live]")).toHaveLength(0);
  });

  it("does not rerender unchanged cards or players when polling returns equivalent objects", () => {
    const first = { ...channel("one", "Studio", "live"), automaticPreview: true };
    const second = { ...channel("two", "Control", "live"), automaticPreview: true };
    const rates = {
      one: { inputBitrateBps: 1_000_000, outputBitrateBps: 900_000, deliveryBitrateBps: 900_000 },
      two: { inputBitrateBps: 2_000_000, outputBitrateBps: 1_800_000, deliveryBitrateBps: 1_800_000 },
    };
    const view = renderOverview({ channels: [first, second], rates });
    expect(overviewPlayerHarness.calls).toHaveBeenCalledTimes(2);

    overviewPlayerHarness.calls.mockClear();
    overviewPlayerHarness.cardRenders.mockClear();
    view.rerender(overview({
      channels: [{ ...first, readers: [...first.readers] }, { ...second, readers: [...second.readers] }],
      rates: { one: { ...rates.one }, two: { ...rates.two } },
    }));

    expect(overviewPlayerHarness.cardRenders).not.toHaveBeenCalled();
    expect(overviewPlayerHarness.calls).not.toHaveBeenCalled();
  });

  it("updates changed card metrics without rerendering or reconfiguring its player", () => {
    const first = { ...channel("one", "Studio", "live"), automaticPreview: true };
    const second = { ...channel("two", "Control", "live"), automaticPreview: true };
    const rates = {
      one: { inputBitrateBps: 1_000_000, outputBitrateBps: 900_000, deliveryBitrateBps: 900_000 },
      two: { inputBitrateBps: 2_000_000, outputBitrateBps: 1_800_000, deliveryBitrateBps: 1_800_000 },
    };
    const view = renderOverview({ channels: [first, second], rates });
    overviewPlayerHarness.calls.mockClear();
    overviewPlayerHarness.cardRenders.mockClear();

    view.rerender(overview({
      channels: [{ ...first }, { ...second }],
      rates: { ...rates, one: { ...rates.one, inputBitrateBps: 1_500_000 } },
    }));

    const studio = screen.getByRole("button", { name: "Open details for Studio" }).closest("article")!;
    const control = screen.getByRole("button", { name: "Open details for Control" }).closest("article")!;
    expect(within(studio).getByText("1.50 Mbps")).toBeDefined();
    expect(within(control).getByText("2.00 Mbps")).toBeDefined();
    expect(overviewPlayerHarness.cardRenders).toHaveBeenCalledTimes(1);
    expect(overviewPlayerHarness.calls).not.toHaveBeenCalled();
  });

  it("uses the latest channel and callback across a skipped card render", async () => {
    const user = userEvent.setup();
    const original = channel("one", "Studio", "live");
    const latest = { ...original, revision: 2, updatedAt: "2026-08-25T09:00:00Z" };
    const originalEdit = vi.fn();
    const latestEdit = vi.fn();
    const view = renderOverview({ channels: [original], onEdit: originalEdit });
    overviewPlayerHarness.calls.mockClear();
    overviewPlayerHarness.cardRenders.mockClear();

    view.rerender(overview({ channels: [latest], onEdit: latestEdit }));
    expect(overviewPlayerHarness.cardRenders).not.toHaveBeenCalled();
    expect(overviewPlayerHarness.calls).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Configure Studio" }));

    expect(originalEdit).not.toHaveBeenCalled();
    expect(latestEdit).toHaveBeenCalledWith(latest);
  });
});

type Overrides = Partial<{
  channels: Channel[];
  loading: boolean;
  error: string;
  rates: Record<string, ChannelStreamRates>;
  query: string;
  filter: OverviewFilter;
  layout: OverviewLayout;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: OverviewFilter) => void;
  onLayoutChange: (layout: OverviewLayout) => void;
  onSelect: (id: string) => void;
  onEdit: (item: Channel) => void;
  previewSavingIDs: ReadonlySet<string>;
  onAutomaticPreviewChange: (item: Channel, enabled: boolean) => void;
  onCreate: () => void;
  onRetry: () => void;
  mutationsDisabled: boolean;
}>;

function renderOverview(overrides: Overrides = {}) {
  return render(overview(overrides));
}

function overview(overrides: Overrides = {}) {
  return (
    <ChannelOverview
      channels={[]}
      loading={false}
      error=""
      rates={{}}
      query=""
      filter="all"
      layout="grid"
      onQueryChange={() => undefined}
      onFilterChange={() => undefined}
      onLayoutChange={() => undefined}
      onSelect={() => undefined}
      onEdit={() => undefined}
      previewSavingIDs={new Set()}
      onAutomaticPreviewChange={() => undefined}
      onCreate={() => undefined}
      onRetry={() => undefined}
      {...overrides}
    />
  );
}

function cardNames() {
  return screen.getAllByRole("article").map((item) => item.querySelector(".overview-card-title strong")?.textContent);
}

function channel(id: string, name: string, tone: "live" | "starting" | "fault" | "idle"): Channel {
  const live = tone === "live";
  const starting = tone === "starting";
  const fault = tone === "fault";
  return {
    id,
    revision: 1,
    number: 1,
    name,
    path: id,
    enabled: true,
    automaticPreview: false,
    input: { mode: "srt-push", srt: { port: 10000, hasPassphrase: false } },
    maxReaders: 10,
    useAbsoluteTimestamp: true,
    applyState: fault ? "error" : starting ? "pending" : "applied",
    applyError: fault ? "failed" : undefined,
    createdAt: "2026-08-25T08:00:00Z",
    updatedAt: "2026-08-25T08:00:00Z",
    whepPath: `/api/v1/channels/${id}/whep`,
    viewerPath: "/view",
    embedPath: `/embed/${id}`,
    available: live,
    online: live,
    inboundBytes: 0,
    outputInboundBytes: 0,
    outboundBytes: 0,
    inboundFramesInError: 0,
    readers: live ? [{ type: "whep", id: "reader" }] : [],
    tracks: [],
    outputReady: live,
    outputTracks: [],
    compatibility: {
      state: live ? "ready" : "offline",
      mode: "direct",
      required: false,
      reasons: [],
      worker: { running: false, restarts: 0 },
    },
  };
}
