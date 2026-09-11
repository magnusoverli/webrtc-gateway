// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preferLowDelay, useWHEPPlayer } from "./useWHEPPlayer";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible", false);
  MockPeer.instances = [];
  MockPeer.initialICEState = "complete";
  MockPeer.initialConnectionState = "connected";
  MockPeer.getStatsResult = async () => emptyReport();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_input, init) => init?.method === "DELETE"
    ? response(204, "")
    : response(201, "answer", "/sessions/one"));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("RTCPeerConnection", MockPeer);
  vi.stubGlobal("MediaStream", MockMediaStream);
});

afterEach(async () => {
  cleanup();
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useWHEPPlayer", () => {
  it("replaces a ready session when its output generation changes without an offline poll", async () => {
    const view = renderHook(({ generation }) => useWHEPPlayer({
      whepPath: "/whep", outputGeneration: generation, enabled: true, retry: true, random: middleRandom,
    }), { initialProps: { generation: "first" } });
    await settle();
    const first = MockPeer.instances[0];
    view.rerender({ generation: "first" });
    await settle();
    expect(postCalls()).toHaveLength(1);
    view.rerender({ generation: "second" });
    await settle();
    expect(first.close).toHaveBeenCalledOnce();
    expect(deleteCalls()).toHaveLength(1);
    expect(postCalls()).toHaveLength(2);
    expect(view.result.current.state).toBe("playing");
  });

  it("waits for old reader cleanup across generation changes and cancels superseded starts", async () => {
    let finishDelete: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(async (_input, init) => init?.method === "DELETE"
      ? new Promise<Response>((resolve) => { finishDelete = resolve; })
      : response(201, "answer", "/sessions/one"));
    const view = renderHook(({ generation }) => useWHEPPlayer({
      whepPath: "/whep", outputGeneration: generation, enabled: true,
    }), { initialProps: { generation: "first" } });
    await settle();
    view.rerender({ generation: "second" });
    view.rerender({ generation: "third" });
    await settle();
    expect(postCalls()).toHaveLength(1);
    finishDelete?.(response(204, ""));
    await settle();
    expect(postCalls()).toHaveLength(2);
    expect(MockPeer.instances).toHaveLength(2);
  });

  it.each(["peer", "transceiver"])("handles synchronous %s setup failure and retries cleanly", async (stage) => {
    let broken = true;
    class FailingPeer extends MockPeer {
      constructor() {
        if (broken && stage === "peer") throw new Error("Peer unavailable");
        super();
        if (broken) this.addTransceiver.mockImplementationOnce(() => { throw new Error("Transceiver unavailable"); });
      }
    }
    vi.stubGlobal("RTCPeerConnection", FailingPeer);
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true, retry: true, random: middleRandom }));
    await settle();
    expect(view.result.current.state).toBe("error");
    expect(view.result.current.error).toContain("unavailable");
    expect(postCalls()).toHaveLength(0);
    if (stage === "transceiver") expect(MockPeer.instances[0].close).toHaveBeenCalledOnce();
    broken = false;
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(view.result.current.state).toBe("playing");
    expect(postCalls()).toHaveLength(1);
  });

  it("never renders the previous channel's failure on navigation, including while hidden", async () => {
    const renders: Array<{ path: string; state: string; error: string }> = [];
    fetchMock.mockResolvedValue(response(503, "old channel failure"));
    const view = renderHook(({ path }) => {
      const player = useWHEPPlayer({ whepPath: path, enabled: true });
      renders.push({ path, state: player.state, error: player.error });
      return player;
    }, { initialProps: { path: "/one" } });
    await settle();
    expect(view.result.current.error).toBe("old channel failure");
    setVisibility("hidden");
    view.rerender({ path: "/two" });
    expect(renders.filter((entry) => entry.path === "/two").every((entry) => entry.state === "off" && entry.error === "")).toBe(true);
    expect(view.result.current.stats).toBeNull();
  });

  it("sets and posts the stereo-enabled local offer before applying the answer", async () => {
    const offer = vi.spyOn(MockPeer.prototype, "createOffer").mockResolvedValue({ type: "offer", sdp: "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n" });
    try {
      renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true }));
      await settle();
      const peer = MockPeer.instances[0];
      expect(peer.localDescription?.sdp).toContain("useinbandfec=1;stereo=1");
      expect(postCalls()[0][1]?.body).toBe(peer.localDescription?.sdp);
      expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer" });
    } finally { offer.mockRestore(); }
  });

  it("exposes the received audio track and clears it on session replacement, failure and disable", async () => {
    const view = renderHook(({ path, enabled }) => useWHEPPlayer({ whepPath: path, enabled }), { initialProps: { path: "/one", enabled: true } });
    await settle();
    const oldPeer = MockPeer.instances[0];
    const staleTrackHandler = oldPeer.ontrack!;
    const track = { kind: "audio" } as MediaStreamTrack;
    act(() => oldPeer.ontrack?.({ track } as RTCTrackEvent));
    expect(view.result.current.audioTrack).toBe(track);
    view.rerender({ path: "/two", enabled: true });
    expect(view.result.current.audioTrack).toBeNull();
    act(() => staleTrackHandler({ track } as RTCTrackEvent));
    expect(view.result.current.audioTrack).toBeNull();
    await settle();
    const peer = MockPeer.instances[1];
    act(() => peer.ontrack?.({ track } as RTCTrackEvent));
    expect(view.result.current.audioTrack).toBe(track);
    act(() => peer.setConnectionState("failed"));
    expect(view.result.current.audioTrack).toBeNull();
    view.rerender({ path: "/two", enabled: false });
    expect(view.result.current.audioTrack).toBeNull();
  });

  it("opts out of stats collection by default", async () => {
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true }));
    await settle();

    expect(view.result.current.state).toBe("playing");
    expect(MockPeer.instances[0].getStats).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(MockPeer.instances[0].getStats).not.toHaveBeenCalled();
  });

  it("requests minimum browser jitter buffering for both receivers", async () => {
    renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true }));
    await settle();

    expect(MockPeer.instances[0].receivers.map((receiver) => receiver.jitterBufferTarget)).toEqual([0, 0]);
  });

  it("treats unsupported or rejected receiver hints as nonfatal", () => {
    expect(() => preferLowDelay({} as RTCRtpReceiver)).not.toThrow();
    const receiver = {} as RTCRtpReceiver;
    Object.defineProperty(receiver, "jitterBufferTarget", { set: () => { throw new Error("unsupported"); } });
    expect(() => preferLowDelay(receiver)).not.toThrow();
  });

  it("runs opted-in stats serially and treats failures as nonfatal", async () => {
    let statsCalls = 0;
    let release: ((report: RTCStatsReport) => void) | undefined;
    MockPeer.getStatsResult = () => {
      statsCalls += 1;
      if (statsCalls === 1) return Promise.reject(new Error("stats unavailable"));
      return new Promise<RTCStatsReport>((resolve) => { release = resolve; });
    };
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true, collectStats: true }));
    await settle();
    expect(MockPeer.instances[0].getStats).toHaveBeenCalledTimes(1);
    expect(view.result.current.state).toBe("playing");
    expect(view.result.current.error).toBe("");

    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(MockPeer.instances[0].getStats).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(MockPeer.instances[0].getStats).toHaveBeenCalledTimes(2);

    release?.(emptyReport());
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(MockPeer.instances[0].getStats).toHaveBeenCalledTimes(3);
  });

  it("requires Location and does not apply a failed signaling result", async () => {
    fetchMock.mockResolvedValue(response(201, "answer"));
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true }));
    await settle();

    expect(view.result.current.state).toBe("error");
    expect(view.result.current.error).toContain("required Location");
    expect(MockPeer.instances[0].setRemoteDescription).not.toHaveBeenCalled();
    expect(deleteCalls()).toHaveLength(0);
  });

  it("cleans an established Location once and retries one failed DELETE", async () => {
    let deletes = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method !== "DELETE") return response(201, "answer", "/sessions/one");
      deletes += 1;
      return deletes === 1 ? response(503, "busy") : response(204, "");
    });
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true }));
    await settle();

    view.unmount();
    await settle();

    expect(deleteCalls()).toHaveLength(2);
    expect(deleteCalls().every((call) => String(call[0]).endsWith("/sessions/one"))).toBe(true);
  });

  it("uses one keepalive cleanup when pagehide and unmount both close the session", async () => {
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true }));
    await settle();

    act(() => window.dispatchEvent(new Event("pagehide")));
    await settle();
    view.unmount();
    await settle();

    expect(deleteCalls()).toHaveLength(1);
    expect(deleteCalls()[0][1]).toMatchObject({ method: "DELETE", keepalive: true });
    expect(MockPeer.instances[0].close).toHaveBeenCalledOnce();
  });

  it("ignores a POST response that arrives after disposal", async () => {
    let resolvePost: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation((_input, init) => init?.method === "DELETE"
      ? Promise.resolve(response(204, ""))
      : new Promise<Response>((resolve) => { resolvePost = resolve; }));
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true }));
    await settle();
    expect(postCalls()).toHaveLength(1);

    view.unmount();
    resolvePost?.(response(201, "answer", "/sessions/late"));
    await settle();

    expect(MockPeer.instances[0].setRemoteDescription).not.toHaveBeenCalled();
    expect(deleteCalls()).toHaveLength(0);
  });

  it("does not POST a non-trickle offer when ICE gathering times out", async () => {
    MockPeer.initialICEState = "gathering";
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true }));
    await settle();
    expect(postCalls()).toHaveLength(0);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await settle();

    expect(view.result.current.state).toBe("error");
    expect(view.result.current.error).toContain("non-trickle WHEP offer was not sent");
    expect(postCalls()).toHaveLength(0);
  });

  it("backs off retries and resets only after a stable connection", async () => {
    let posts = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === "DELETE") return response(204, "");
      posts += 1;
      return posts === 1 ? response(503, "unavailable") : response(201, "answer", `/sessions/${posts}`);
    });
    const view = renderHook(() => useWHEPPlayer({
      whepPath: "/whep",
      enabled: true,
      retry: true,
      random: middleRandom,
    }));
    await settle();
    expect(postCalls()).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(postCalls()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(postCalls()).toHaveLength(2);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    act(() => MockPeer.instances[1].setConnectionState("failed"));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(postCalls()).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(postCalls()).toHaveLength(3);

    view.unmount();
  });

  it("pauses an established session while hidden, closes it after grace, and reconnects with jitter", async () => {
    const view = renderHook(() => useWHEPPlayer({
      whepPath: "/whep",
      enabled: true,
      random: middleRandom,
    }));
    await settle();
    expect(postCalls()).toHaveLength(1);

    act(() => setVisibility("hidden"));
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(MockPeer.instances[0].close).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(MockPeer.instances[0].close).toHaveBeenCalledOnce();

    act(() => setVisibility("visible"));
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(postCalls()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await settle();
    expect(postCalls()).toHaveLength(2);

    view.unmount();
  });

  it("uses three fast retries, then backs off, and bypasses that backoff for a new generation", async () => {
    fetchMock.mockResolvedValue(response(503, "output starting"));
    const view = renderHook(({ generation }) => useWHEPPlayer({
      whepPath: "/whep", outputGeneration: generation, enabled: true, retry: true, random: middleRandom,
    }), { initialProps: { generation: "one" } });
    await settle();
    for (let count = 2; count <= 4; count++) {
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(postCalls()).toHaveLength(count);
    }
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(postCalls()).toHaveLength(4);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(postCalls()).toHaveLength(5);
    view.rerender({ generation: "two" });
    await settle();
    expect(postCalls()).toHaveLength(6);
  });

  it("recovers frozen video even while packets and audio continue on a connected peer", async () => {
    let bytes = 100;
    MockPeer.getStatsResult = async () => mediaReport(10, bytes += 100);
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true, retry: true, random: middleRandom }));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(postCalls()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(view.result.current.error).toContain("Video decoding stopped");
    expect(MockPeer.instances[0].close).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(postCalls()).toHaveLength(2);
  });

  it("lets a short video gap recover without replacing the session", async () => {
    let frames = 10;
    MockPeer.getStatsResult = async () => mediaReport(frames, 100);
    renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true, retry: true }));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    frames++;
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(postCalls()).toHaveLength(1);
    expect(MockPeer.instances[0].close).not.toHaveBeenCalled();
  });

  it("gives a new video decoder twelve seconds for its first frame", async () => {
    MockPeer.getStatsResult = async () => mediaReport(0, 100);
    const view = renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true, retry: true, random: middleRandom }));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(11_999));
    expect(MockPeer.instances[0].close).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(view.result.current.error).toContain("Video decoding stopped");
  });

  it("monitors audio-only output without treating an empty video placeholder as a stalled decoder", async () => {
    let bytes = 0;
    MockPeer.getStatsResult = async () => mediaReport(undefined, bytes += 100);
    renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true, retry: true }));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(postCalls()).toHaveLength(1);
    MockPeer.getStatsResult = async () => mediaReport(undefined, bytes);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(MockPeer.instances[0].close).toHaveBeenCalledOnce();
  });

  it("resets watchdog evidence across visibility pauses and ignores stats failures", async () => {
    MockPeer.getStatsResult = async () => mediaReport(10, 100);
    renderHook(() => useWHEPPlayer({ whepPath: "/whep", enabled: true, retry: true }));
    await settle();
    act(() => setVisibility("hidden"));
    const calls = MockPeer.instances[0].getStats.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(MockPeer.instances[0].getStats).toHaveBeenCalledTimes(calls);
    act(() => setVisibility("visible"));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(MockPeer.instances[0].close).not.toHaveBeenCalled();
    MockPeer.getStatsResult = async () => { throw new Error("stats unavailable"); };
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(MockPeer.instances[0].close).not.toHaveBeenCalled();
  });
});

function mediaReport(frames: number | undefined, bytes: number): RTCStatsReport {
  return new Map([
    ["video", { id: "video", type: "inbound-rtp", kind: "video", framesDecoded: frames ?? 0, bytesReceived: frames === undefined ? 0 : bytes }],
    ["audio", { id: "audio", type: "inbound-rtp", kind: "audio", bytesReceived: bytes }],
  ]) as unknown as RTCStatsReport;
}

function middleRandom() {
  return 0.5;
}

function response(status: number, body: string, location?: string) {
  const headers = new Headers();
  if (location) headers.set("Location", location);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function postCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
}

function deleteCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

function setVisibility(state: DocumentVisibilityState, dispatch = true) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  if (dispatch) document.dispatchEvent(new Event("visibilitychange"));
}

function emptyReport() {
  return { forEach: () => undefined } as unknown as RTCStatsReport;
}

class MockMediaStream {
  addTrack = vi.fn();
}

class MockPeer extends EventTarget {
  static instances: MockPeer[] = [];
  static initialICEState: RTCIceGatheringState = "complete";
  static initialConnectionState: RTCPeerConnectionState = "connected";
  static getStatsResult: () => Promise<RTCStatsReport> = async () => emptyReport();

  iceGatheringState = MockPeer.initialICEState;
  connectionState = MockPeer.initialConnectionState;
  localDescription: RTCSessionDescription | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  receivers = [{ jitterBufferTarget: null }, { jitterBufferTarget: null }];
  addTransceiver = vi.fn(() => ({ receiver: this.receivers[this.addTransceiver.mock.calls.length - 1] }));
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: "offer" }; }
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description as RTCSessionDescription;
  });
  setRemoteDescription = vi.fn(async () => undefined);
  getStats = vi.fn(() => MockPeer.getStatsResult());
  close = vi.fn();

  constructor() {
    super();
    MockPeer.instances.push(this);
  }

  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event("connectionstatechange"));
  }
}
