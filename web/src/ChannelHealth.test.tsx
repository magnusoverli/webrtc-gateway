// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelHealth } from "./ChannelHealth";
import { channelStateLabel, type Channel, type ChannelIssue } from "./channel";
import type { WHEPPlayerState } from "./useWHEPPlayer";
import type { PreviewStats } from "./webrtc";

const ready: Channel = {
  id: "studio", revision: 1, number: 1, name: "Studio", path: "studio", enabled: true, automaticPreview: true,
  input: { mode: "srt-pull", srt: { hasPassphrase: true } }, maxReaders: 0, useAbsoluteTimestamp: false,
  applyState: "applied", createdAt: "", updatedAt: "", whepPath: "/whep/studio", viewerPath: "/view", embedPath: "/embed/1",
  available: true, online: true, inputGeneration: "one", inboundBytes: 1000, outputInboundBytes: 1000,
  outputGeneration: "one", outboundBytes: 1000, inboundFramesInError: 0, readers: [], readerCount: 1,
  tracks: [{ codec: "H264" }], outputReady: true, outputTracks: [{ codec: "H264" }], issues: [],
  compatibility: { state: "ready", required: false, reasons: [], worker: { running: false, restarts: 0 } },
};
const issue: ChannelIssue = {
  code: "srt.elementary_rtp_requires_sdp", source: "ingest", severity: "error", summary: "Input rejected",
  message: "unsafe raw detail", firstSeenAt: "2026-09-09T10:00:00Z", lastSeenAt: "2026-09-09T10:01:00Z", occurrences: 3,
};
const preview = { state: "playing" as WHEPPlayerState, stats: null as PreviewStats | null };
const props = { channel: ready, stale: false, mediaReachable: true, preview, onDiagnostics: vi.fn() };

afterEach(cleanup);

describe("Channel health", () => {
  it("reports readiness without promising smooth playback or inventing history", () => {
    render(<ChannelHealth {...props} />);
    expect(screen.getByText("Output ready")).toBeDefined();
    expect(screen.getByText(/does not guarantee smooth playback/)).toBeDefined();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/Recovered/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(props.onDiagnostics).toHaveBeenCalledOnce();
  });

  it("explains retained reports and exposes only available timestamps and counts in collapsed details", () => {
    const view = render(<ChannelHealth {...props} channel={{ ...ready, issues: [issue] }} />);
    expect(screen.getByText("Unresolved")).toBeDefined();
    expect(screen.getByText("Input needs an SDP description")).toBeDefined();
    expect(screen.getByText(/Add the sender's matching SDP/)).toBeDefined();
    const details = screen.getByText("Technical details").closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(within(details).getByText("Technical details"));
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("Occurrences: 3");
    expect(details.textContent).toContain(new Date(issue.firstSeenAt).toLocaleString());
    expect(details.textContent).toContain(new Date(issue.lastSeenAt).toLocaleString());
    view.rerender(<ChannelHealth {...props} channel={{ ...ready,
      relay: { state: "running", restarts: 3, lastError: "old failure", listenerActive: false },
      compatibility: { ...ready.compatibility, lastError: "old failure", worker: { running: true, restarts: 2, error: "old failure" } },
    }} />);
    expect(screen.queryByText("Input needs an SDP description")).toBeNull();
    expect(screen.queryByText(/Recovered/)).toBeNull();
    expect(screen.queryByText("Browser-compatible output unavailable")).toBeNull();
    expect(screen.queryByText("Input relay is retrying")).toBeNull();
    expect(screen.getByText("Output ready")).toBeDefined();
  });

  it("bounds the visible list and keeps distinct stages and retry facts", () => {
    const channel: Channel = { ...ready, issues: [issue, { ...issue, code: "srt.media_bridge_failed", source: "gateway" }],
      outputReady: false, relay: { state: "retrying", restarts: 4, nextRetryAt: "2026-09-09T12:00:00Z", listenerActive: false },
      compatibility: { ...ready.compatibility, state: "error" }, inboundFramesInError: 7 };
    const { container } = render(<ChannelHealth {...props} channel={channel} />);
    expect(container.querySelectorAll(".channel-health > .health-items > li")).toHaveLength(3);
    expect(screen.getByText("2 more issues").closest("details")?.open).toBe(false);
    fireEvent.click(screen.getByText("2 more issues"));
    expect(screen.getByRole("heading", { name: "Input parse errors recorded" })).toBeDefined();
    expect(screen.getByText("Gateway bridge")).toBeDefined();
    expect(screen.getByText("SRT pull relay")).toBeDefined();
    expect(screen.queryByText("SRT listener")).toBeNull();
    expect(screen.getByText("Relay restarts: 4")).toBeDefined();
    expect(screen.getByText(/Next retry:/)).toBeDefined();
    expect(channelStateLabel({ ...channel, issues: [], compatibility: ready.compatibility })).toBe("Pull relay error");
  });

  it("does not render secrets from free-form errors, unknown fields, URLs, or SDP", () => {
    const secret = 'srt://user:credential@host?passphrase=private rtsp://user:password@host v=0\na=ice-pwd:private';
    const channel = { ...ready, issues: [{ ...issue, code: secret, source: secret, summary: secret, message: secret,
      firstSeenAt: secret, lastSeenAt: secret }],
      relay: { state: "retrying" as const, restarts: 1, lastError: secret, listenerActive: false },
      compatibility: { ...ready.compatibility, state: "error" as const, lastError: secret, worker: { running: false, restarts: 1, error: secret } } };
    const view = render(<ChannelHealth {...props} channel={channel} />);
    expect(view.container.textContent).not.toMatch(/credential|password|private|rtsp:|srt:|ice-pwd/);
    expect(screen.getByText("Channel issue reported")).toBeDefined();
    expect(screen.queryByText(/First seen:/)).toBeNull();
    view.rerender(<ChannelHealth {...props} channel={{ ...channel, applyState: "error", applyError: secret }} />);
    expect(screen.getByText("Configuration not applied")).toBeDefined();
    expect(view.container.textContent).not.toContain(secret);
  });

  it("marks a stale snapshot instead of presenting an active or healthy diagnosis", () => {
    const view = render(<ChannelHealth {...props} stale channel={{ ...ready, issues: [issue] }} />);
    expect(screen.getByText("Status stale")).toBeDefined();
    expect(screen.getByText("Last snapshot")).toBeDefined();
    expect(screen.queryByText("Unresolved")).toBeNull();
    view.rerender(<ChannelHealth {...props} mediaReachable={false} />);
    expect(screen.getByText("Gateway media unavailable")).toBeDefined();
    expect(screen.queryByText("Output ready")).toBeNull();
  });

  it("distinguishes pull waiting, disabled, pending, and worker queue states", () => {
    const offline = { ...ready, online: false, available: false, outputReady: false };
    const view = render(<ChannelHealth {...props} channel={offline} />);
    expect(screen.getByText(/No accepted media from the SRT pull source yet/)).toBeDefined();
    expect(view.container.textContent).not.toContain("listener is unavailable");
    view.rerender(<ChannelHealth {...props} channel={{ ...offline, enabled: false, issues: [issue] }} />);
    expect(screen.getByText("Disabled")).toBeDefined();
    expect(screen.queryByText("Unresolved")).toBeNull();
    view.rerender(<ChannelHealth {...props} channel={{ ...ready, applyState: "pending" }} />);
    expect(screen.getByText("Applying configuration")).toBeDefined();
    view.rerender(<ChannelHealth {...props} channel={{ ...ready, outputReady: false,
      compatibility: { ...ready.compatibility, state: "starting", worker: { running: false, queued: true, restarts: 0 } } }} />);
    expect(screen.getByText(/conversion is waiting for worker capacity/)).toBeDefined();
  });

  it("does not treat cumulative parse errors as a current error rate or proof of stutter", () => {
    render(<ChannelHealth {...props} channel={{ ...ready, inboundFramesInError: 12 }} />);
    expect(screen.getByText("Recorded")).toBeDefined();
    expect(screen.getByText(/12 media frames could not be parsed/).textContent).toContain("does not prove errors are continuing");
  });

  it("keeps viewer connection failures and recorded packet loss separate from source health", () => {
    const view = render(<ChannelHealth {...props} preview={{ state: "error", stats: null }} />);
    expect(screen.getByText("Output ready")).toBeDefined();
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.getByText(/does not establish a source fault/)).toBeDefined();
    view.rerender(<ChannelHealth {...props} preview={{ state: "playing", stats: {
      bitrateBps: 1000, icePath: "UDP", audio: { bitrateBps: 1000, codec: "Opus", jitterMs: 10, packetsLost: 4 },
    } }} />);
    expect(screen.getByText(/4 packets lost/)).toBeDefined();
    expect(screen.queryByText(/video frames dropped/)).toBeNull();
    expect(screen.queryByText("Input parse errors recorded")).toBeNull();
    view.rerender(<ChannelHealth {...props} channel={{ ...ready, automaticPreview: false }} preview={{ state: "error", stats: null }} />);
    expect(screen.getByText(/Preview disabled; no receiver health/)).toBeDefined();
    expect(screen.queryByText(/Preview connection failed/)).toBeNull();
  });
});
