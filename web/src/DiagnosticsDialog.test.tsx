// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsDialog } from "./DiagnosticsDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

describe("DiagnosticsDialog", () => {
  it("renders the system snapshot as labelled, compact semantic sections", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(diagnostics())));

    render(<DiagnosticsDialog scope="system" onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "System diagnostics" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close diagnostics" }));
    expect(await screen.findByText("1.20.1")).toBeDefined();
    expect(screen.getByText("Gateway", { selector: "h4" })).toBeDefined();
    expect(screen.getByText("Settings", { selector: "h4" })).toBeDefined();
    expect(screen.getByRole("table", { name: "Configured channel diagnostics" })).toBeDefined();
    expect(dialog.querySelector("dl")).not.toBeNull();
    expect(dialog.querySelector("details")).not.toBeNull();
  });

  it("renders selected channel runtime, relay, compatibility, and readers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(diagnostics())));

    render(<DiagnosticsDialog scope="channel" channelID="channel-long-id" channelName="Studio" onClose={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Channel diagnostics: Studio" })).toBeDefined();
    expect(await screen.findByText("Selected channel")).toBeDefined();
    expect(screen.getByText("channel-long-id").className).toContain("diagnostics-id");
    expect(screen.getByText("studio-input")).toBeDefined();
    expect(screen.getByText("Compatibility process exited")).toBeDefined();
    expect(screen.getByText("FFmpeg exited with status 1")).toBeDefined();
    expect(screen.getByText("192.0.2.20:10000")).toBeDefined();
    expect(screen.getByText("H264 has B-frames")).toBeDefined();
    const readers = screen.getByText("Active readers", { selector: "summary" }).closest("details");
    expect(readers).not.toBeNull();
    expect(within(readers as HTMLElement).getByText("reader-with-a-very-long-id")).toBeDefined();
  });

  it("shows request failures and retries without remounting", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(jsonResponse(diagnostics()));
    vi.stubGlobal("fetch", fetchMock);

    render(<DiagnosticsDialog scope="system" onClose={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Diagnostics unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("1.20.1")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses ModalShell dismissal and focus behavior", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(diagnostics())));

    render(<DiagnosticsDialog scope="system" onClose={onClose} />);
    const close = screen.getByRole("button", { name: "Close diagnostics" });
    expect(document.activeElement).toBe(close);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reports a channel missing from the current snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(diagnostics())));

    render(<DiagnosticsDialog scope="channel" channelID="deleted-channel" channelName="Deleted" onClose={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Channel not found");
    expect((screen.getByRole("button", { name: "Copy diagnostic report" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("copies only explicitly allowlisted diagnostic fields", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const payload = diagnostics() as ReturnType<typeof diagnostics> & Record<string, unknown>;
    payload.secret = "root-secret";
    Object.assign(payload.gateway, { token: "gateway-secret" });
    Object.assign(payload.channels[0], { passphrase: "channel-secret" });
    Object.assign(payload.channels[0].runtime.source, { credential: "source-secret" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

    render(<DiagnosticsDialog scope="channel" channelID="channel-long-id" channelName="Studio" onClose={vi.fn()} />);
    const copy = await screen.findByRole("button", { name: "Copy diagnostic report" });
    await user.click(copy);

    expect(writeText).toHaveBeenCalledOnce();
    const report = writeText.mock.calls[0][0] as string;
    expect(report).not.toContain("root-secret");
    expect(report).not.toContain("gateway-secret");
    expect(report).not.toContain("channel-secret");
    expect(report).not.toContain("source-secret");
    expect(JSON.parse(report).channels).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Report copied");
  });
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function diagnostics() {
  return {
    gateway: { version: "dev-build", startedAt: "2026-08-25T08:00:00Z" },
    media: {
      reachable: true,
      version: "1.20.1",
      started: "2026-08-25T08:01:00Z",
      activeListeners: { srt: ":8890", webRTCUDP: ":8189", webRTCTCP: ":8189" },
    },
    settings: { revision: 4, applyState: "applied", updatedAt: "2026-08-25T08:02:00Z" },
    resources: {
      sampledAt: "2026-08-25T08:03:00Z",
      gateway: {
        status: "stale", scope: "gateway-cgroup", errorCode: "sample_failed", sampledAt: "2026-08-25T08:02:59Z", windowMs: 1000,
        cpu: { percent: 12.5, usedCores: 1, capacityCores: 8 },
        memory: { usedBytes: 536870912, currentBytes: 603979776, totalBytes: 8589934592 },
      },
      host: {
        status: "ok", scope: "host", windowMs: 1000,
        cpu: { percent: 25, usedCores: 2, capacityCores: 8 },
        memory: { usedBytes: 4294967296, totalBytes: 17179869184 },
      },
      media: { status: "unavailable", scope: "mediamtx-cgroup", errorCode: "isolated_scope" },
    },
    channels: [{
      id: "channel-long-id",
      number: 1,
      name: "Studio",
      path: "studio-input",
      enabled: true,
      revision: 7,
      applyState: "applied",
      createdAt: "2026-08-25T08:04:00Z",
      updatedAt: "2026-08-25T08:05:00Z",
      runtime: {
        available: true,
        availableTime: "2026-08-25T08:06:00Z",
        online: true,
        onlineTime: "2026-08-25T08:06:01Z",
        outputAvailableTime: "2026-08-25T08:06:02Z",
        source: { type: "srtSession", id: "source-with-a-very-long-id" },
        readers: [{ type: "whepSession", id: "reader-with-a-very-long-id" }],
      },
      outputReady: true,
      relay: {
        state: "running", restarts: 2, listenerAddress: "192.0.2.20:10000", listenerActive: true,
      },
      compatibility: {
        state: "ready", mode: "transcoded", required: true, reasons: ["H264 has B-frames"],
        lastError: "Compatibility process exited",
        worker: { running: true, restarts: 1, error: "FFmpeg exited with status 1" },
      },
    }],
  };
}
