// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, ChannelStreamRates } from "./channel";
import { ChannelOverview, type OverviewFilter, type OverviewLayout } from "./ChannelOverview";

afterEach(cleanup);

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
    renderOverview({ channels: [channel("live", "Live", "live"), channel("fault", "Fault", "fault"), channel("idle", "Idle", "idle")] });

    expect(screen.getByRole("button", { name: "Open details for Live" }).closest("article")?.className).toContain("tone-live");
    expect(screen.getByRole("button", { name: "Open details for Fault" }).closest("article")?.className).toContain("tone-fault");
    expect(screen.getByRole("button", { name: "Open details for Idle" }).closest("article")?.className).toContain("tone-idle");
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

function channel(id: string, name: string, tone: "live" | "fault" | "idle"): Channel {
  const live = tone === "live";
  const fault = tone === "fault";
  return {
    id,
    number: 1,
    name,
    path: id,
    enabled: true,
    automaticPreview: false,
    input: { mode: "srt-push", srt: { port: 10000, hasPassphrase: false } },
    maxReaders: 10,
    useAbsoluteTimestamp: true,
    applyState: fault ? "error" : "applied",
    applyError: fault ? "failed" : undefined,
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
