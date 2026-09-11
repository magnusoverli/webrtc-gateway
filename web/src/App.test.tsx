// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, ConnectionRow, dashboardChannelID, dashboardURL, InputConnectionPanel, ResourceFooter } from "./App";
import type { Channel, ChannelRuntime, InputMode } from "./channel";

const appPlayerHarness = vi.hoisted(() => ({ calls: vi.fn() }));

vi.mock("./useWHEPPlayer", () => ({
  useWHEPPlayer: (options: unknown) => {
    appPlayerHarness.calls(options);
    return { videoRef: { current: null }, state: "off", error: "", stats: null, hasVideo: false, hasAudio: false };
  },
}));

function channelWithMode(mode: InputMode): Channel {
  return {
    id: "channel-1",
    revision: 1,
    number: 1,
    name: "Studio",
    path: "channel-1",
    enabled: true,
    automaticPreview: false,
    input: mode.startsWith("srt-")
      ? { mode, srt: { host: mode === "srt-pull" ? "2001:db8::10" : undefined, port: mode === "srt-pull" ? 9000 : 10000, streamId: mode === "srt-pull" ? "studio feed" : undefined, hasPassphrase: true, latencyMs: 120 } }
      : { mode, rtp: { address: mode === "rtp-multicast" ? "239.0.0.1" : "0.0.0.0", port: 22000, sourceIp: "192.0.2.20", sdp: "v=0" } },
    maxReaders: 0,
    compatibilityVideoMaxKbps: 5000,
    useAbsoluteTimestamp: false,
    applyState: "applied",
    createdAt: "2026-08-25T08:00:00Z",
    updatedAt: "2026-08-25T08:00:00Z",
    whepPath: "/whep/1",
    viewerPath: "/view/1",
    embedPath: "/embed/1",
    available: false,
    online: false,
    inputGeneration: ":",
    inboundBytes: 0,
    outputInboundBytes: 0,
    outputGeneration: ":direct",
    outboundBytes: 0,
    inboundFramesInError: 0,
    readers: [],
    readerCount: 0,
    tracks: [],
    outputReady: false,
    outputTracks: [],
    issues: [],
    ...(mode === "srt-push" ? { relay: { state: "running" as const, restarts: 0, listenerAddress: "192.0.2.10:10000", listenerActive: true } } : {}),
    compatibility: { state: "offline", required: false, reasons: [], worker: { running: false, restarts: 0 } },
  };
}

function statusWith(channels: Channel[], overrides: { settings?: Record<string, unknown>; gateway?: Record<string, unknown>; media?: Record<string, unknown>; network?: Record<string, unknown> } = {}) {
  return {
    gateway: { version: "test", startedAt: "2026-08-25T08:00:00Z", restartRequired: false, ...overrides.gateway },
    media: { reachable: true, version: "1.0", ...overrides.media },
    settings: {
      revision: 2,
      managementBindAddress: "*",
      managementPort: 8080,
      mediaBindAddress: "*",
      logLevel: "info",
      readTimeout: "5s",
      writeTimeout: "5s",
      writeQueueSize: 512,
      udpMaxPayloadSize: 1472,
      udpReadBufferSize: 0,
      srtAddress: ":8890",
      webRTCLocalUDPAddress: ":8189",
      webRTCLocalTCPAddress: "",
      webRTCIPsFromInterfaces: true,
      webRTCAdditionalHosts: [],
      webRTCHandshakeTimeout: "10s",
      webRTCTrackGatherTimeout: "2s",
      rtpPortMin: 22000,
      rtpPortMax: 22999,
      statisticsIntervalMs: 2_000,
      defaultMaxReaders: 16,
      applyState: "applied",
      updatedAt: "2026-08-25T08:00:00Z",
      ...overrides.settings,
    },
    network: {
      interfaces: [],
      management: { activeAddress: "*", desiredAddress: "*", port: 8080, restartRequired: false },
      media: { activeAddress: "*", desiredAddress: "*", restartRequired: false, activeListeners: { srt: ":8890", webRTCUDP: ":8189", webRTCTCP: "" } },
      ...overrides.network,
    },
    channels,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function runtimeChannel(channel: Channel, overrides: Partial<ChannelRuntime> = {}): ChannelRuntime {
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
    ...overrides,
  };
}

function runtimeStatus(status: ReturnType<typeof statusWith>, channels: ChannelRuntime[], settings: Record<string, unknown> = {}) {
  return {
    gateway: status.gateway,
    media: status.media,
    settings: {
      revision: status.settings.revision,
      applyState: status.settings.applyState,
      ...settings,
    },
    network: status.network,
    channels,
  };
}

describe("dashboard navigation", () => {
  beforeEach(() => {
    appPlayerHarness.calls.mockClear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("exposes the overview as the current primary navigation item", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeDefined();
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Settings" }).hasAttribute("disabled")).toBe(true);
  });

  it.each(["grid", "list"])("PATCHes only enabled by ID in %s, locks duplicates and retains the saved response when polling fails", async (layout) => {
    let item = { ...channelWithMode("srt-pull"), id: "sparse-source-42", number: 42 };
    let finish!: (response: Response) => void;
    let patched = false;
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patched = true;
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return Promise.resolve(patched ? jsonResponse({ error: "poll failed" }, 503) : jsonResponse(statusWith([item])));
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    const toggle = await screen.findByRole("switch", { name: "Disable Studio" });
    if (layout === "list") await userEvent.click(screen.getByRole("button", { name: "List view" }));
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    const [url, init] = fetch.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(url).toBe("/api/v1/channels/sparse-source-42");
    expect(JSON.parse(init!.body as string)).toEqual({ enabled: false });
    expect(init!.headers).toMatchObject({ "If-Match": '"1"' });
    expect(screen.getByRole("switch").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("");
    item = { ...item, enabled: false, revision: 2 };
    await act(async () => finish(jsonResponse(item)));
    await screen.findByText(/Showing last known channel state/);
    expect(screen.getByRole("switch", { name: "Enable Studio" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Studio: disabled.")).toBeDefined();
  });

  it.each([false, true])("restores saved enabled=%s and reports a rejected toggle", async (enabled) => {
    const item = { ...channelWithMode("srt-push"), enabled };
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(
      init?.method === "PATCH" ? jsonResponse({ error: "Channel is busy" }, 409) : jsonResponse(statusWith([item])),
    )));
    render(<App />);
    await userEvent.click(await screen.findByRole("switch"));
    await screen.findByText("Channel is busy");
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-busy")).toBe("false"));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(String(enabled));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps saved configuration and reports an apply failure instead of claiming ingest started", async () => {
    let item = { ...channelWithMode("srt-push"), enabled: false };
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
        item = { ...item, enabled: true, revision: 2, applyState: "error", applyError: "Listener port unavailable" };
        return Promise.resolve(jsonResponse(item));
      }
      return Promise.resolve(jsonResponse(statusWith([item])));
    }));
    render(<App />);
    await userEvent.click(await screen.findByRole("switch", { name: "Enable Studio" }));
    await screen.findByText("Channel setting saved, but configuration was not applied: Listener port unavailable");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Configuration error").textContent).toBe("Config error");
    expect(screen.queryByText("Studio: enabled.")).toBeNull();
  });

  it("blocks switches after a revision conflict until a fresh snapshot arrives", async () => {
    const item = channelWithMode("srt-push");
    let rejected = false;
    let refresh!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        rejected = true;
        return Promise.resolve(jsonResponse({ error: "stale" }, 412));
      }
      if (rejected) return new Promise<Response>((resolve) => { refresh = resolve; });
      return Promise.resolve(jsonResponse(statusWith([item])));
    }));
    render(<App />);
    await userEvent.click(await screen.findByRole("switch"));
    await screen.findByText("The channel changed before the update could be saved. Current status is being refreshed; try again afterward.");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
    await act(async () => refresh(jsonResponse(statusWith([{ ...item, revision: 2, enabled: false }]))));
    await waitFor(() => expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("ignores a pre-mutation poll that resolves after the toggle response", async () => {
    vi.useFakeTimers();
    const item = channelWithMode("srt-push");
    const saved = { ...item, enabled: false, revision: 2 };
    const full = statusWith([item]);
    let resolvePoll!: (response: Response) => void;
    let fullReads = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Promise.resolve(jsonResponse(saved));
      if (String(input).endsWith("/runtime")) return new Promise<Response>((resolve) => { resolvePoll = resolve; });
      if (++fullReads === 1) return Promise.resolve(jsonResponse(full));
      // Leave the post-save refresh unresolved to expose any stale poll overwrite.
      return new Promise<Response>(() => undefined);
    }));
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { fireEvent.click(screen.getByRole("switch")); });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    await act(async () => resolvePoll(jsonResponse(runtimeStatus(full, [runtimeChannel(item)]))));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch").getAttribute("aria-busy")).toBe("false");
  });

  it("shares every channel and the multiview from the overview using the active management address", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const studio = channelWithMode("srt-push");
    const backup = { ...studio, id: "backup", number: 7, name: 'Backup "A" & B', enabled: false, embedPath: "/embed/7", whepPath: "/api/v1/channels/backup/whep" };
    const fetch = vi.fn((_input: RequestInfo | URL) => Promise.resolve(jsonResponse(statusWith([studio, backup], {
      network: { management: { activeAddress: "192.0.2.10", desiredAddress: "192.0.2.20", port: 8080, desiredPort: 9090, restartRequired: true } },
    }))));
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Links & embeds" });
    await user.type(screen.getByRole("searchbox", { name: "Search channels" }), "Studio");
    expect(screen.queryByRole("heading", { name: backup.name })).toBeNull();
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Links & embeds" });
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(true);
    expect(within(dialog).getByText(/current management address/)).toBeDefined();
    const multiview = within(within(dialog).getByRole("region", { name: "Multiviewer" }));
    expect(multiview.getByRole("textbox", { name: "WebRTC viewer URL value" })).toHaveProperty("value", "http://192.0.2.10:8080/view");
    expect(multiview.queryByRole("textbox", { name: "WHEP API endpoint value" })).toBeNull();
    const channel = within(within(dialog).getByRole("region", { name: `Channel 7: ${backup.name}` }));
    expect(channel.getByRole("textbox", { name: "WebRTC viewer URL value" })).toHaveProperty("value", "http://192.0.2.10:8080/embed/7");
    expect(channel.getByRole("link", { name: "Open WebRTC viewer URL" }).getAttribute("href")).toBe("http://192.0.2.10:8080/embed/7");
    expect(channel.getByRole("textbox", { name: "WHEP API endpoint value" })).toHaveProperty("value", "http://192.0.2.10:8080/api/v1/channels/backup/whep");
    const snippet = channel.getByRole("textbox", { name: "Iframe embed code value" }) as HTMLInputElement;
    expect(snippet.value).toContain('src="http://192.0.2.10:8080/embed/7"');
    expect(snippet.value).toContain('title="Backup &quot;A&quot; &amp; B"');
    await user.click(channel.getByRole("button", { name: "Copy Iframe embed code" }));
    expect(writeText).toHaveBeenLastCalledWith(snippet.value);
    const multiviewSnippet = multiview.getByRole("textbox", { name: "Iframe embed code value" }) as HTMLInputElement;
    expect(multiviewSnippet.value).toContain('src="http://192.0.2.10:8080/view"');
    await user.click(multiview.getByRole("button", { name: "Copy Iframe embed code" }));
    expect(writeText).toHaveBeenLastCalledWith(multiviewSnippet.value);
    const inputs = within(dialog).getAllByRole("textbox");
    expect(inputs).toHaveLength(8);
    expect(new Set(inputs.map((input) => input.id)).size).toBe(inputs.length);
    expect(dialog.querySelector("iframe, video")).toBeNull();
    expect(fetch.mock.calls.every(([input]) => !String(input).includes("whep"))).toBe(true);
    expect(appPlayerHarness.calls.mock.calls.every(([options]) => !options.enabled)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("offers multiview links without channels and selects text when clipboard access is unavailable", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(statusWith([])))));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Links & embeds" }));
    const dialog = screen.getByRole("dialog", { name: "Links & embeds" });
    expect(within(dialog).getAllByRole("region")).toHaveLength(1);
    const input = within(dialog).getByRole("textbox", { name: "WebRTC viewer URL value" }) as HTMLInputElement;
    await user.click(within(dialog).getByRole("button", { name: "Copy WebRTC viewer URL" }));
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await user.click(within(dialog).getByRole("button", { name: "Close links and embeds" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("synchronizes detail state with browser history", () => {
    window.history.replaceState(null, "", "/?channel=studio");
    render(<App />);
    expect(document.querySelector(".detail-breadcrumb")).not.toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");

    window.history.replaceState(null, "", "/");
    fireEvent.popState(window);
    expect(document.querySelector(".detail-breadcrumb")).not.toBeNull();
    expect(screen.getByText("Overview", { selector: ".crumb-current" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("button", { name: "Previous channel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next channel" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Channels", level: 1 }));
  });

  it("does not intercept bare horizontal arrow keys", async () => {
    const item = { ...channelWithMode("srt-push"), name: "Studio A" };
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(statusWith([item]))));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Studio A" })).toBeDefined();

    expect(fireEvent.keyDown(window, { key: "ArrowRight" })).toBe(true);
    expect(screen.getByRole("heading", { name: "Studio A" })).toBeDefined();
    expect(window.location.search).toBe(`?channel=${item.id}`);
  });

  it("shows retained input rejection details in the channel workspace", async () => {
    const item = channelWithMode("srt-push");
    item.issues = [{
      code: "srt.unsupported_payload", source: "ingest", severity: "error", summary: "Input rejected",
      message: "Matroska header is invalid", firstSeenAt: "2026-08-26T10:46:42Z",
      lastSeenAt: "2026-08-26T10:46:42Z", occurrences: 1,
    }];
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(statusWith([item]))));
    render(<App />);

    expect(await screen.findByText("Input format rejected")).toBeDefined();
    expect(screen.queryByText("Matroska header is invalid")).toBeNull();
    expect(screen.getByText("Input rejected", { selector: ".state-pill" })).toBeDefined();
  });

  it("refreshes health from existing runtime polls without retaining cleared issues or leaking across navigation", async () => {
    vi.useFakeTimers();
    const item = channelWithMode("srt-pull");
    item.relay = { state: "retrying", restarts: 2, lastError: "srt://user:secret@host?passphrase=hidden", listenerActive: false };
    const other = { ...channelWithMode("srt-push"), id: "other", number: 2, name: "Other" };
    const full = statusWith([item, other]);
    const recovered = runtimeChannel(item, {
      available: true, online: true, outputReady: true,
      relay: { state: "running", restarts: 2, listenerActive: false },
      compatibility: { state: "ready", required: false, reasons: [], worker: { running: false, restarts: 0 } },
    });
    let fail = false;
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/status") return Promise.resolve(jsonResponse(full));
      if (String(input) === "/api/v1/status/runtime") return fail
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(jsonResponse(runtimeStatus(full, [recovered, runtimeChannel(other)])));
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("region", { name: "Channel health" }).textContent).toContain("Input relay is retrying");
    expect(document.body.textContent).not.toContain("passphrase=hidden");
    fireEvent.click(screen.getByRole("button", { name: "Next channel" }));
    expect(screen.getByRole("region", { name: "Channel health" }).textContent).not.toContain("Input relay is retrying");
    fireEvent.click(screen.getByRole("button", { name: "Previous channel" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const health = within(screen.getByRole("region", { name: "Channel health" }));
    expect(health.getByText("Output ready")).toBeDefined();
    expect(health.queryByText("Input relay is retrying")).toBeNull();
    expect(health.queryByText(/Recovered/)).toBeNull();
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(health.getByText("Status stale")).toBeDefined();
    expect(health.queryByText("Output ready")).toBeNull();
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/status", "/api/v1/status/runtime", "/api/v1/status/runtime",
    ]);
  });

  it("shows nominal input frame rate when track properties omit it", async () => {
    const item = {
      ...channelWithMode("srt-push"),
      available: true,
      online: true,
      tracks: [{ codec: "H264" }, { codec: "MPEG-1/2 Audio", codecProps: { sampleRate: 44100, channelCount: 1 } }],
      inputVideo: { width: 1920, height: 1080, frameRate: "60000/1001" },
      outputReady: true,
      outputTracks: [{ codec: "H264" }, { codec: "Opus", codecProps: { sampleRate: 48000, channelCount: 2 } }],
    };
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(statusWith([item]))));
    render(<App />);

    expect(await screen.findAllByText("59.9 fps", { selector: ".media-fact strong" })).toHaveLength(2);
    expect(screen.getByText("44.1 kHz", { selector: ".media-fact strong" })).toBeDefined();
    expect(screen.getByText("1 · mono", { selector: ".media-fact strong" })).toBeDefined();
    expect(screen.getByText("48 kHz", { selector: ".media-fact strong" })).toBeDefined();
    expect(screen.getByText("2 · stereo", { selector: ".media-fact strong" })).toBeDefined();
  });

  it("uses compact runtime polling after the full snapshot", async () => {
    vi.useFakeTimers();
    const item = {
      ...channelWithMode("srt-push"),
      available: true,
      online: true,
      outputReady: true,
      inputGeneration: "input-one:source-one",
      outputGeneration: "output-one:direct",
      readers: [{ type: "webRTCSession", id: "reader-one" }],
      readerCount: 1,
      tracks: [{ codec: "H264" }],
      outputTracks: [{ codec: "H264" }],
      compatibility: { ...channelWithMode("srt-push").compatibility, state: "ready" as const },
    };
    const full = statusWith([item]);
    const compact = runtimeStatus(full, [runtimeChannel(item, {
      inboundBytes: 2_000,
      outputInboundBytes: 1_500,
      outboundBytes: 3_000,
      readerCount: 4,
    })]);
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/status") return Promise.resolve(jsonResponse(full));
      if (String(input) === "/api/v1/status/runtime") return Promise.resolve(jsonResponse(compact));
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("1", { selector: ".metric-strip .metric strong" })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(screen.getByText("4", { selector: ".metric-strip .metric strong" })).toBeDefined();
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(["/api/v1/status", "/api/v1/status/runtime"]);
  });

  it("adopts the latest polling interval without restarting with a duplicate full fetch", async () => {
    vi.useFakeTimers();
    const item = channelWithMode("srt-push");
    const full = statusWith([item], { settings: { statisticsIntervalMs: 500 } });
    const compact = runtimeStatus(full, [runtimeChannel(item)]);
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/status") return Promise.resolve(jsonResponse(full));
      if (String(input) === "/api/v1/status/runtime") return Promise.resolve(jsonResponse(compact));
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(["/api/v1/status"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(["/api/v1/status", "/api/v1/status/runtime"]);
  });

  it.each([false, true])("polls detail runtime every 500ms for recovery, outputReady=%s", async (outputReady) => {
    vi.useFakeTimers();
    const item = { ...channelWithMode("srt-push"), automaticPreview: true, outputReady };
    const full = statusWith([item]);
    const compact = runtimeStatus(full, [runtimeChannel(item)]);
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/status") return Promise.resolve(jsonResponse(full));
      if (String(input) === "/api/v1/status/runtime") return Promise.resolve(jsonResponse(compact));
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/status",
      "/api/v1/status/runtime",
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/status",
      "/api/v1/status/runtime",
      "/api/v1/status/runtime",
    ]);
  });

  it("returns to the configured interval after leaving automatic preview startup", async () => {
    vi.useFakeTimers();
    const item = { ...channelWithMode("srt-push"), automaticPreview: true, outputReady: false };
    const full = statusWith([item]);
    const compact = runtimeStatus(full, [runtimeChannel(item)]);
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/status") return Promise.resolve(jsonResponse(full));
      if (String(input) === "/api/v1/status/runtime") return Promise.resolve(jsonResponse(compact));
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>(".crumb-back")!);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/status",
      "/api/v1/status/runtime",
      "/api/v1/status/runtime",
    ]);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(fetch).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["automatic preview is disabled", { automaticPreview: false, outputReady: false }],
    ["the channel is disabled", { automaticPreview: true, enabled: false, outputReady: false }],
    ["the channel failed to apply", { automaticPreview: true, applyState: "error" as const, outputReady: false }],
  ])("keeps the configured interval when %s", async (_condition, overrides) => {
    vi.useFakeTimers();
    const item = { ...channelWithMode("srt-push"), ...overrides };
    const full = statusWith([item]);
    const compact = runtimeStatus(full, [runtimeChannel(item)]);
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/status") return Promise.resolve(jsonResponse(full));
      if (String(input) === "/api/v1/status/runtime") return Promise.resolve(jsonResponse(compact));
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(["/api/v1/status"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(["/api/v1/status", "/api/v1/status/runtime"]);
  });

  it("does not let a compact poll started before a mutation overwrite its result", async () => {
    vi.useFakeTimers();
    const item = { ...channelWithMode("srt-push"), revision: 7, automaticPreview: false };
    const full = statusWith([item]);
    let resolveRuntime!: (response: Response) => void;
    const pendingRuntime = new Promise<Response>((resolve) => { resolveRuntime = resolve; });
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/status") return Promise.resolve(jsonResponse(full));
      if (url === "/api/v1/status/runtime") return pendingRuntime;
      if (init?.method === "PATCH") return Promise.resolve(jsonResponse({
        automaticPreview: true,
        revision: 8,
        updatedAt: "2026-08-25T09:00:00Z",
      }));
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(fetch.mock.calls.some(([input]) => String(input) === "/api/v1/status/runtime")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enable preview" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Disable preview" }).getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      resolveRuntime(jsonResponse(runtimeStatus(full, [runtimeChannel(item)])));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Disable preview" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("fetches a full status in the same poll on revision mismatch and preserves an open form", async () => {
    vi.useFakeTimers();
    const opened = { ...channelWithMode("srt-push"), revision: 3 };
    const latest = { ...opened, revision: 4, name: "Remote Studio", updatedAt: "2026-08-25T09:00:00Z" };
    const first = statusWith([opened]);
    const remote = statusWith([latest], { settings: { revision: 3 } });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/status/runtime") {
        return Promise.resolve(jsonResponse(runtimeStatus(first, [runtimeChannel(opened)], { revision: 3 })));
      }
      if (url === "/api/v1/status") {
        const fullReads = fetch.mock.calls.filter(([candidate]) => String(candidate) === "/api/v1/status").length;
        return Promise.resolve(jsonResponse(fullReads === 1 ? first : remote));
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${opened.id}`);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved local name" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Unsaved local name");
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/status",
      "/api/v1/status/runtime",
      "/api/v1/status",
    ]);
  });

  it("focuses page headings after card navigation and return", async () => {
    const user = userEvent.setup();
    const item = channelWithMode("srt-push");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(statusWith([item]))));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open details for Studio" }));
    const detailHeading = screen.getByRole("heading", { name: "Studio", level: 1 });
    expect(document.activeElement).toBe(detailHeading);
    await user.click(document.querySelector<HTMLButtonElement>(".crumb-back")!);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Channels", level: 1 }));
  });

  it("focuses inline delete confirmation and restores Delete on cancel", async () => {
    const user = userEvent.setup();
    const item = channelWithMode("srt-push");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(statusWith([item]))));
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);

    const deleteButton = await screen.findByRole("button", { name: "Delete" });
    await user.click(deleteButton);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
  });

  it("opens system and channel diagnostics and restores focus", async () => {
    const user = userEvent.setup();
    const item = channelWithMode("srt-push");
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/diagnostics") return Promise.resolve(jsonResponse({
        gateway: { version: "test", startedAt: "2026-08-25T08:00:00Z" },
        media: { reachable: true },
        settings: { revision: 2, applyState: "applied", updatedAt: "2026-08-25T08:00:00Z" },
        channels: [],
      }));
      return Promise.resolve(jsonResponse(statusWith([item])));
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);

    const systemTrigger = await screen.findByRole("button", { name: /Open system diagnostics/ });
    expect(systemTrigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(systemTrigger.textContent).toBe("Diagnostics");
    await user.click(systemTrigger);
    expect(await screen.findByRole("dialog")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Close diagnostics" }));
    expect(document.activeElement).toBe(systemTrigger);

    await user.click(screen.getByRole("button", { name: "Open details for Studio" }));
    const channelTrigger = screen.getByRole("button", { name: /Open diagnostics for Studio/ });
    expect(channelTrigger.getAttribute("aria-haspopup")).toBe("dialog");
    await user.click(channelTrigger);
    expect(await screen.findByRole("heading", { name: "Channel diagnostics: Studio" })).toBeDefined();
  });

  it("notifies globally when MediaMTX is unavailable without showing header health", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(statusWith([channelWithMode("srt-push")], {
      media: { reachable: false, error: "MediaMTX is unavailable" },
    }))));
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain("MediaMTX is unavailable");
    expect(screen.queryByText("Media plane unavailable")).toBeNull();
    expect(screen.getByRole("button", { name: "Open system diagnostics" }).textContent).toBe("Diagnostics");
  });

  it("sends the opening revision on PUT, retains conflicts, and reloads the latest channel", async () => {
    const user = userEvent.setup();
    const opened = { ...channelWithMode("srt-push"), revision: 3 };
    const latest = { ...opened, revision: 4, name: "Latest Studio", updatedAt: "2026-08-25T09:00:00Z" };
    let statusReads = 0;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/v1/status") {
        statusReads += 1;
        return Promise.resolve(jsonResponse(statusWith([statusReads === 1 ? opened : latest])));
      }
      if (url === "/api/v1/status/runtime") {
        const item = statusReads === 1 ? opened : latest;
        return Promise.resolve(jsonResponse(runtimeStatus(statusWith([item]), [runtimeChannel(item)])));
      }
      if (url === `/api/v1/channels/${opened.id}` && method === "PUT") {
        return Promise.resolve(jsonResponse({ error: { code: "revision_conflict", message: "channel changed since it was read" } }, 412));
      }
      if (url === `/api/v1/channels/${opened.id}`) return Promise.resolve(jsonResponse(latest));
      throw new Error(`Unexpected request ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${opened.id}`);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Configure" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "My unsaved edit");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/opened at revision 3/)).toBeDefined();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("My unsaved edit");
    const putCall = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(new Headers(putCall?.[1]?.headers).get("If-Match")).toBe('"3"');
    expect(JSON.parse(String(putCall?.[1]?.body))).not.toHaveProperty("revision");

    await user.click(screen.getByRole("button", { name: "Reload latest" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Latest Studio"));
  });

  it("defaults new channels to 5 Mbps and saves a custom per-channel video limit", async () => {
    const item = { ...channelWithMode("srt-push"), compatibilityVideoMaxKbps: 7000 };
    let saved = item;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/v1/channels/${item.id}` && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        saved = { ...item, revision: 2, compatibilityVideoMaxKbps: body.compatibilityVideoMaxKbps };
        return Promise.resolve(jsonResponse(saved));
      }
      if (url === "/api/v1/status") return Promise.resolve(jsonResponse(statusWith([saved])));
      if (url === "/api/v1/status/runtime") return Promise.resolve(jsonResponse(runtimeStatus(statusWith([saved]), [runtimeChannel(saved)])));
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Add channel" }));
    expect((screen.getByRole("spinbutton", { name: /Compatibility video limit/ }) as HTMLInputElement).value).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open details for Studio" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    const limit = screen.getByRole("spinbutton", { name: /Compatibility video limit/ });
    expect((limit as HTMLInputElement).value).toBe("7");
    fireEvent.change(limit, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Compatibility video limit must be between 0.1 and 40 Mbps.")).toBeDefined();
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    fireEvent.change(limit, { target: { value: "3.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saved.compatibilityVideoMaxKbps).toBe(3500));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit channel" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect((screen.getByRole("spinbutton", { name: /Compatibility video limit/ }) as HTMLInputElement).value).toBe("3.5");
    const call = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ compatibilityVideoMaxKbps: 3500 });
  });

  it("keeps settings revision metadata out of strict PUT bodies and reloads after conflict", async () => {
    const user = userEvent.setup();
    const item = channelWithMode("srt-push");
    const openedStatus = statusWith([item], { settings: { revision: 6, logLevel: "info" } });
    const latestSettings = { ...openedStatus.settings, revision: 7, logLevel: "debug", updatedAt: "2026-08-25T10:00:00Z" };
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/status") return Promise.resolve(jsonResponse(openedStatus));
      if (url === "/api/v1/settings" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ error: { code: "revision_conflict", message: "settings changed since they were read" } }, 412));
      }
      if (url === "/api/v1/settings") return Promise.resolve(jsonResponse(latestSettings));
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const logLevel = screen.getByRole("combobox", { name: /Media server log level/ });
    await user.selectOptions(logLevel, "warn");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/opened at revision 6/)).toBeDefined();
    expect((screen.getByRole("combobox", { name: /Media server log level/ }) as HTMLSelectElement).value).toBe("warn");
    const putCall = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(new Headers(putCall?.[1]?.headers).get("If-Match")).toBe('"6"');
    expect(JSON.parse(String(putCall?.[1]?.body))).not.toHaveProperty("revision");

    await user.click(screen.getByRole("button", { name: "Reload latest" }));
    await waitFor(() => expect((screen.getByRole("combobox", { name: /Media server log level/ }) as HTMLSelectElement).value).toBe("debug"));
  });

  it("keeps long interface choices in an accessible wrapping picker", async () => {
    const user = userEvent.setup();
    const interfaceName = "broadcast-engineering-contribution-network-adapter";
    const address = "2001:db8:1234:5678:90ab:cdef:1234:5678";
    const status = statusWith([], {
      network: {
        interfaces: [{ name: interfaceName, address, family: "IPv6", loopback: false }],
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(status)));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const managementPicker = screen.getByRole("button", { name: /^Web UI & API interface:/ });
    expect(managementPicker.getAttribute("aria-haspopup")).toBe("listbox");
    expect(managementPicker.getAttribute("aria-expanded")).toBe("false");

    await user.click(managementPicker);
    const listbox = screen.getByRole("listbox", { name: /Web UI & API interface/ });
    const selected = within(listbox).getByRole("option", { name: "All interfaces" });
    await waitFor(() => expect(document.activeElement).toBe(selected));
    const followGroup = within(listbox).getByRole("group", { name: "Follow interface" });
    const fullLabel = `${interfaceName} - ${address} (IPv6)`;
    const followOption = within(followGroup).getByRole("option", { name: fullLabel });
    expect(followOption.textContent).toBe(fullLabel);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: /Web UI & API interface/ })).toBeNull();
    expect(document.activeElement).toBe(managementPicker);

    await user.click(managementPicker);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "All interfaces" })));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(screen.getByRole("group", { name: "Follow interface" })).getByRole("option", { name: fullLabel }));
    await user.keyboard("{Enter}");
    expect(managementPicker.textContent).toContain(fullLabel);
    expect(managementPicker.getAttribute("title")).toBe(fullLabel);
    expect(screen.getByRole("button", { name: /^Media interface:/ }).textContent).toContain(fullLabel);

    await user.click(managementPicker);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: fullLabel, selected: true })));
    await user.tab();
    await waitFor(() => expect(screen.queryByRole("listbox", { name: /Web UI & API interface/ })).toBeNull());
    expect(document.activeElement?.getAttribute("role")).not.toBe("option");
  });

  it("does not let an older channel poll overwrite a completed reload", async () => {
    vi.useFakeTimers();
    const opened = { ...channelWithMode("srt-push"), revision: 3 };
    const latest = { ...opened, revision: 4, name: "Reloaded Studio", updatedAt: "2026-08-25T09:00:00Z" };
    const openedStatus = statusWith([opened]);
    const latestStatus = statusWith([latest]);
    let resolveRuntime!: (response: Response) => void;
    const pendingRuntime = new Promise<Response>((resolve) => { resolveRuntime = resolve; });
    let statusReads = 0;
    let channelWrites = 0;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/status") {
        statusReads += 1;
        return Promise.resolve(jsonResponse(statusReads === 1 ? openedStatus : latestStatus));
      }
      if (url === "/api/v1/status/runtime") return pendingRuntime;
      if (url === `/api/v1/channels/${opened.id}` && init?.method === "PUT") {
        channelWrites += 1;
        return Promise.resolve(channelWrites === 1
          ? jsonResponse({ error: { code: "revision_conflict", message: "channel changed since it was read" } }, 412)
          : jsonResponse({ error: "test stopped after revision assertion" }, 400));
      }
      if (url === `/api/v1/channels/${opened.id}`) return Promise.resolve(jsonResponse(latest));
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${opened.id}`);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(fetch.mock.calls.some(([input]) => String(input) === "/api/v1/status/runtime")).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/opened at revision 3/)).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Reloaded Studio");
    await act(async () => {
      resolveRuntime(jsonResponse(runtimeStatus(openedStatus, [runtimeChannel(opened)])));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Reloaded Studio");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const putCalls = fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(new Headers(putCalls[1]?.[1]?.headers).get("If-Match")).toBe('"4"');
  });

  it("opens a newer polled channel revision instead of a delayed reload response", async () => {
    vi.useFakeTimers();
    const opened = { ...channelWithMode("srt-push"), revision: 3 };
    const reloaded = { ...opened, revision: 4, name: "Reload Response", updatedAt: "2026-08-25T09:00:00Z" };
    const newest = { ...opened, revision: 5, name: "Polled Studio", updatedAt: "2026-08-25T10:00:00Z" };
    const statuses = [statusWith([opened]), statusWith([reloaded]), statusWith([newest])];
    let resolveReload!: (response: Response) => void;
    const pendingReload = new Promise<Response>((resolve) => { resolveReload = resolve; });
    let statusReads = 0;
    let channelWrites = 0;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/status") return Promise.resolve(jsonResponse(statuses[Math.min(statusReads++, statuses.length - 1)]));
      if (url === "/api/v1/status/runtime") {
        return Promise.resolve(jsonResponse(runtimeStatus(statuses[2], [runtimeChannel(newest)])));
      }
      if (url === `/api/v1/channels/${opened.id}` && init?.method === "PUT") {
        channelWrites += 1;
        return Promise.resolve(channelWrites === 1
          ? jsonResponse({ error: { code: "revision_conflict", message: "channel changed since it was read" } }, 412)
          : jsonResponse({ error: "test stopped after revision assertion" }, 400));
      }
      if (url === `/api/v1/channels/${opened.id}`) return pendingReload;
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${opened.id}`);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/opened at revision 3/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetch.mock.calls.map(([input]) => String(input))).toContain("/api/v1/status/runtime");
    await act(async () => {
      resolveReload(jsonResponse(reloaded));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Polled Studio");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const putCalls = fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(new Headers(putCalls[1]?.[1]?.headers).get("If-Match")).toBe('"5"');
  });

  it("does not let an older settings poll overwrite a completed reload", async () => {
    vi.useFakeTimers();
    const item = channelWithMode("srt-push");
    const openedStatus = statusWith([item], { settings: { revision: 6, logLevel: "info" } });
    const latestSettings = { ...openedStatus.settings, revision: 7, logLevel: "debug", updatedAt: "2026-08-25T10:00:00Z" };
    const latestStatus = statusWith([item], { settings: latestSettings });
    let resolveRuntime!: (response: Response) => void;
    const pendingRuntime = new Promise<Response>((resolve) => { resolveRuntime = resolve; });
    let statusReads = 0;
    let settingsWrites = 0;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/status") {
        statusReads += 1;
        return Promise.resolve(jsonResponse(statusReads === 1 ? openedStatus : latestStatus));
      }
      if (url === "/api/v1/status/runtime") return pendingRuntime;
      if (url === "/api/v1/settings" && init?.method === "PUT") {
        settingsWrites += 1;
        return Promise.resolve(settingsWrites === 1
          ? jsonResponse({ error: { code: "revision_conflict", message: "settings changed since they were read" } }, 412)
          : jsonResponse({ error: "test stopped after revision assertion" }, 400));
      }
      if (url === "/api/v1/settings") return Promise.resolve(jsonResponse(latestSettings));
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(fetch.mock.calls.some(([input]) => String(input) === "/api/v1/status/runtime")).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: /Media server log level/ }), { target: { value: "warn" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/opened at revision 6/)).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByRole("combobox", { name: /Media server log level/ }) as HTMLSelectElement).value).toBe("debug");
    await act(async () => {
      resolveRuntime(jsonResponse(runtimeStatus(openedStatus, [runtimeChannel(item)])));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByRole("combobox", { name: /Media server log level/ }) as HTMLSelectElement).value).toBe("debug");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const putCalls = fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(new Headers(putCalls[1]?.[1]?.headers).get("If-Match")).toBe('"7"');
  });

  it("opens newer polled settings instead of a delayed reload response", async () => {
    vi.useFakeTimers();
    const item = channelWithMode("srt-push");
    const openedStatus = statusWith([item], { settings: { revision: 6, logLevel: "info" } });
    const reloadedSettings = { ...openedStatus.settings, revision: 7, logLevel: "debug", updatedAt: "2026-08-25T10:00:00Z" };
    const newestSettings = { ...openedStatus.settings, revision: 8, logLevel: "error", updatedAt: "2026-08-25T11:00:00Z" };
    const statuses = [
      openedStatus,
      statusWith([item], { settings: reloadedSettings }),
      statusWith([item], { settings: newestSettings }),
    ];
    let resolveReload!: (response: Response) => void;
    const pendingReload = new Promise<Response>((resolve) => { resolveReload = resolve; });
    let statusReads = 0;
    let settingsWrites = 0;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/status") return Promise.resolve(jsonResponse(statuses[Math.min(statusReads++, statuses.length - 1)]));
      if (url === "/api/v1/status/runtime") {
        return Promise.resolve(jsonResponse(runtimeStatus(statuses[2], [runtimeChannel(item)])));
      }
      if (url === "/api/v1/settings" && init?.method === "PUT") {
        settingsWrites += 1;
        return Promise.resolve(settingsWrites === 1
          ? jsonResponse({ error: { code: "revision_conflict", message: "settings changed since they were read" } }, 412)
          : jsonResponse({ error: "test stopped after revision assertion" }, 400));
      }
      if (url === "/api/v1/settings") return pendingReload;
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/opened at revision 6/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetch.mock.calls.map(([input]) => String(input))).toContain("/api/v1/status/runtime");
    await act(async () => {
      resolveReload(jsonResponse(reloadedSettings));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByRole("combobox", { name: /Media server log level/ }) as HTMLSelectElement).value).toBe("error");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    const putCalls = fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(new Headers(putCalls[1]?.[1]?.headers).get("If-Match")).toBe('"8"');
  });

  it("PATCHes only preview preference and preserves retained runtime fields", async () => {
    const user = userEvent.setup();
    const item = {
      ...channelWithMode("srt-push"),
      revision: 7,
      automaticPreview: false,
      available: true,
      online: true,
      outputReady: true,
      outputTracks: [{ codec: "H264" }],
      readers: [{ type: "whep", id: "reader-1" }],
      compatibility: { ...channelWithMode("srt-push").compatibility, state: "ready" as const },
    };
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/status") return Promise.resolve(jsonResponse(statusWith([item])));
      if (init?.method === "PATCH") return Promise.resolve(jsonResponse({
        ...item,
        revision: 8,
        automaticPreview: true,
        updatedAt: "2026-08-25T09:00:00Z",
        outputReady: false,
        readers: [],
      }));
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enable preview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Disable preview" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("Viewers").closest(".metric")?.textContent).toContain("1");
    expect(appPlayerHarness.calls).toHaveBeenCalledWith(expect.objectContaining({ whepPath: item.whepPath, enabled: true }));
    const patchCall = fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(new Headers(patchCall?.[1]?.headers).get("If-Match")).toBe('"7"');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ automaticPreview: true });
  });

  it("marks retained resource values stale when status polling is disconnected", () => {
    render(<ResourceFooter disconnected resources={{
      sampledAt: "2026-08-24T12:00:00Z",
      gateway: {
        status: "ok", scope: "gateway-cgroup",
        cpu: { percent: 12.5, usedCores: 1, capacityCores: 8 },
        memory: { usedBytes: 512 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 * 1024 },
      },
      host: {
        status: "ok", scope: "host",
        cpu: { percent: 25, usedCores: 2, capacityCores: 8 },
        memory: { usedBytes: 4 * 1024 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 * 1024 },
      },
      media: { status: "unavailable", scope: "mediamtx-cgroup", errorCode: "isolated_scope" },
    }} />);
    expect(screen.getAllByText("STALE")).toHaveLength(3);
    expect(screen.getByText("512 MiB / 8.0 GiB")).toBeDefined();
    expect(screen.getByRole("progressbar", { name: "Gateway CPU utilization" })).toBeDefined();
    expect(screen.getByRole("progressbar", { name: "Host CPU utilization" })).toBeDefined();
  });

  it("marks resources unavailable when the first status request fails", () => {
    render(<ResourceFooter disconnected />);
    expect(screen.getAllByText("UNAVAILABLE")).toHaveLength(3);
    expect(screen.queryByText("LOADING")).toBeNull();
  });

  it("marks the resource footer stale when the sampler retains old values", () => {
    render(<ResourceFooter resources={{
      sampledAt: "2026-08-24T12:00:00Z",
      gateway: {
        status: "stale", scope: "gateway-cgroup", errorCode: "sample_failed",
        cpu: { percent: 12.5, usedCores: 1, capacityCores: 8 },
        memory: { usedBytes: 512 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 * 1024 },
      },
      host: {
        status: "ok", scope: "host",
        cpu: { percent: 25, usedCores: 2, capacityCores: 8 },
        memory: { usedBytes: 4 * 1024 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 * 1024 },
      },
      media: { status: "unavailable", scope: "mediamtx-cgroup", errorCode: "isolated_scope" },
    }} />);
    expect(screen.getAllByText("STALE")).toHaveLength(2);
  });

  it("disables retained-status mutations without stopping established detail playback", async () => {
    vi.useFakeTimers();
    const item = {
      ...channelWithMode("srt-push"),
      automaticPreview: true,
      available: true,
      online: true,
      outputReady: true,
      compatibility: { ...channelWithMode("srt-push").compatibility, state: "ready" as const },
    };
    const currentStatus = statusWith([item], {
      gateway: { restartRequired: true },
      settings: { statisticsIntervalMs: 500 },
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(currentStatus))
      .mockRejectedValue(new TypeError("network down"));
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("heading", { name: "Studio" })).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(screen.getByRole("button", { name: "Settings" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Configure" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Disable preview" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Restart Gateway" }).hasAttribute("disabled")).toBe(true);
    expect(appPlayerHarness.calls).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, collectStats: true }));
    const liveRegion = document.querySelector("[aria-live='polite'][aria-atomic='true']");
    expect(liveRegion?.textContent).toContain("Dashboard status is stale");
  });

  it("rejects stale passphrase reveals and exposes mutually exclusive accessible controls", async () => {
    const user = userEvent.setup();
    const item = { ...channelWithMode("srt-push"), revision: 5 };
    let reveals = 0;
    const fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/status") return Promise.resolve(jsonResponse(statusWith([item])));
      if (url.endsWith("/srt-passphrase")) {
        reveals += 1;
        return Promise.resolve(jsonResponse({ configured: true, passphrase: "secret-value", revision: reveals === 1 ? 4 : 5 }));
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${item.id}`);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Reveal SRT passphrase" }));
    expect(await screen.findByText(/channel changed while the passphrase was being read/i)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Reveal SRT passphrase" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Passphrase value" }) as HTMLInputElement).value).toBe("secret-value"));

    await user.click(screen.getByRole("button", { name: "Configure" }));
    const passphrase = screen.getAllByLabelText(/SRT passphrase/).find((element) => element.tagName === "INPUT") as HTMLInputElement;
    expect(passphrase).toBeDefined();
    expect(passphrase.type).toBe("password");
    await user.type(passphrase, "replacement-secret");
    await user.click(screen.getByRole("checkbox", { name: "Clear stored passphrase" }));
    expect(passphrase.disabled).toBe(true);
    expect(passphrase.value).toBe("");
    await user.click(screen.getByRole("button", { name: "RTP unicast" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("textbox", { name: "Passphrase value" }) as HTMLInputElement).value).toBe("Configured, hidden");
  });

  it("shows pending apply state and allows failed deletion cleanup to be retried", async () => {
    const user = userEvent.setup();
    const deleting = { ...channelWithMode("srt-push"), enabled: false, applyState: "deleting" as const, applyError: "remove path: unavailable" };
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/status") return Promise.resolve(jsonResponse(statusWith([deleting], { settings: { applyState: "pending" } })));
      if (init?.method === "DELETE") return Promise.resolve(jsonResponse({ status: "deleting" }, 202));
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", `/?channel=${deleting.id}`);
    render(<App />);

    expect(await screen.findByText(/Global settings changes are pending/)).toBeDefined();
    expect(screen.getByText(/Deletion is pending after cleanup failed/)).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Retry deletion" }));
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("makes the numbered channel embed URL copyable and openable", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const value = "http://192.168.15.5:8080/embed/1";
    render(<ConnectionRow label="Channel embed URL" value={value} openURL />);

    expect((screen.getByRole("textbox", { name: "Channel embed URL value" }) as HTMLInputElement).value).toBe(value);
    expect(screen.getByRole("link", { name: "Open Channel embed URL" }).getAttribute("href")).toBe(value);
    await user.click(screen.getByRole("button", { name: "Copy Channel embed URL" }));
    expect(writeText).toHaveBeenCalledWith(value);
  });
});

describe("dashboard URLs", () => {
  it("reads and updates the channel query without dropping other URL state", () => {
    expect(dashboardChannelID("?channel=studio&debug=1")).toBe("studio");
    expect(dashboardURL("http://desk.local/?debug=1#status", "channel 2")).toBe("/?debug=1&channel=channel+2#status");
    expect(dashboardURL("http://desk.local/?debug=1&channel=studio#status")).toBe("/?debug=1#status");
  });
});

describe("input connection details", () => {
  afterEach(cleanup);

  const renderPanel = (channel: Channel, mediaHost = "192.0.2.10") => render(<InputConnectionPanel
    channel={channel}
    bindingState="active"
    bindingName="Follow eth0 IPv4"
    mediaHost={mediaHost}
    srtURL=""
    activeSRTPort=""
    advancedSRTURL=""
    passphrase={null}
    passphraseLoading={false}
    passphraseError=""
    onReveal={() => undefined}
    onHide={() => undefined}
  />);

  it("shows a complete SRT pull source URL without push-only rows", () => {
    renderPanel(channelWithMode("srt-pull"));
    expect(screen.getByRole("textbox", { name: "Source URL value" })).toHaveProperty(
      "value",
      "srt://[2001:db8::10]:9000?streamid=studio%20feed&latency=120",
    );
    expect(screen.queryByRole("textbox", { name: "Destination IP value" })).toBeNull();
  });

  it("shows unicast RTP destination and source restriction", () => {
    renderPanel(channelWithMode("rtp-unicast"));
    expect(screen.getByRole("textbox", { name: "Destination IP value" })).toHaveProperty("value", "192.0.2.10");
    expect(screen.getByRole("textbox", { name: "Source IP restriction value" })).toHaveProperty("value", "192.0.2.20");
    expect(screen.queryByRole("textbox", { name: "SRT URL value" })).toBeNull();
  });

  it("does not present desired SRT values as current without a confirmed listener", () => {
    renderPanel(channelWithMode("srt-push"), "");
    expect(screen.getByRole("textbox", { name: "SRT URL value" })).toHaveProperty("value", "Unavailable - listener not confirmed active");
    expect(screen.getByRole("textbox", { name: "Destination IP value" })).toHaveProperty("value", "Unavailable - listener not confirmed active");
    expect(screen.getByRole("textbox", { name: "Destination port value" })).toHaveProperty("value", "Unavailable - listener not confirmed active");
  });
});
