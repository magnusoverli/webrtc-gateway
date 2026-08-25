// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, ConnectionRow, dashboardChannelID, dashboardURL, InputConnectionPanel, ResourceFooter } from "./App";
import type { Channel, InputMode } from "./channel";

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
    useAbsoluteTimestamp: false,
    applyState: "applied",
    createdAt: "2026-08-25T08:00:00Z",
    updatedAt: "2026-08-25T08:00:00Z",
    whepPath: "/whep/1",
    viewerPath: "/view/1",
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
    ...(mode === "srt-push" ? { relay: { state: "running" as const, restarts: 0, listenerAddress: "192.0.2.10:10000", listenerActive: true } } : {}),
    compatibility: { state: "offline", required: false, reasons: [], worker: { running: false, restarts: 0 } },
  };
}

function statusWith(channels: Channel[], overrides: { settings?: Record<string, unknown>; gateway?: Record<string, unknown>; media?: Record<string, unknown> } = {}) {
  return {
    gateway: { version: "test", startedAt: "2026-08-25T08:00:00Z", restartRequired: false, ...overrides.gateway },
    media: { reachable: true, version: "1.0", ...overrides.media },
    settings: {
      revision: 2,
      managementBindAddress: "*",
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
    },
    channels,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

  it("PATCHes only preview preference and preserves retained runtime fields", async () => {
    const user = userEvent.setup();
    const item = {
      ...channelWithMode("srt-push"),
      revision: 7,
      automaticPreview: false,
      available: true,
      online: true,
      outputReady: true,
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
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Enable preview for Studio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Disable preview for Studio" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByText("1", { selector: ".overview-card-stats strong" })).toBeDefined();
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
