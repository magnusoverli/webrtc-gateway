// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, ConnectionRow, dashboardChannelID, dashboardURL, InputConnectionPanel, ResourceFooter } from "./App";
import type { Channel, InputMode } from "./channel";

function channelWithMode(mode: InputMode): Channel {
  return {
    id: "channel-1",
    number: 1,
    name: "Studio",
    path: "channel-1",
    enabled: true,
    automaticPreview: false,
    input: mode === "srt-pull"
      ? { mode, srt: { host: "2001:db8::10", port: 9000, streamId: "studio feed", hasPassphrase: true, latencyMs: 120 } }
      : { mode, rtp: { address: mode === "rtp-multicast" ? "239.0.0.1" : "0.0.0.0", port: 22000, sourceIp: "192.0.2.20", sdp: "v=0" } },
    maxReaders: 0,
    useAbsoluteTimestamp: false,
    applyState: "applied",
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
    compatibility: { state: "offline", required: false, reasons: [], worker: { running: false, restarts: 0 } },
  };
}

describe("dashboard navigation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("exposes the overview as the current primary navigation item", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Settings" }).hasAttribute("disabled")).toBe(true);
  });

  it("synchronizes detail state with browser history", () => {
    window.history.replaceState(null, "", "/?channel=studio");
    render(<App />);
    expect(document.querySelector(".detail-breadcrumb")).not.toBeNull();

    window.history.replaceState(null, "", "/");
    fireEvent.popState(window);
    expect(document.querySelector(".detail-breadcrumb")).toBeNull();
    expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
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

  const renderPanel = (channel: Channel) => render(<InputConnectionPanel
    channel={channel}
    bindingState="active"
    bindingName="Follow eth0 IPv4"
    mediaHost="192.0.2.10"
    srtURL=""
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
});
