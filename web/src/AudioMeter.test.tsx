// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioMeter, useAudioMeterContext } from "./AudioMeter";

class TrackedTarget extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
    }
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

class MockTrack extends TrackedTarget {
  kind = "audio";
  enabled = true;
  muted = false;
  readyState = "live";
  stop = vi.fn();
  constructor(public channelCount?: number) { super(); }
  getSettings = vi.fn(() => ({ channelCount: this.channelCount }));
  asTrack() { return this as unknown as MediaStreamTrack; }
  mute(value: boolean) { this.muted = value; this.dispatchEvent(new Event(value ? "mute" : "unmute")); }
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}

class MockStream {
  constructor(public tracks: MediaStreamTrack[]) {}
  getAudioTracks() { return this.tracks; }
}

class MockNode {
  connections: { node: MockNode; output: number; input: number }[] = [];
  channelCount = 2;
  channelCountMode = "max";
  channelInterpretation = "speakers";
  gain = { value: 1 };
  fftSize = 0;
  smoothingTimeConstant = 0.8;
  amplitude = 0;
  waveform: number[] | null = null;
  buffers: Float32Array[] = [];
  constructor(public kind: string) {}
  connect = vi.fn((node: MockNode, output = 0, input = 0) => {
    if (node.kind === "destination") {
      expect(this.kind).toBe("gain");
      expect(this.gain.value).toBe(0);
    }
    this.connections.push({ node, output, input });
    return node;
  });
  disconnect = vi.fn(() => { this.connections = []; });
  getFloatTimeDomainData = vi.fn((buffer: Float32Array) => {
    this.buffers.push(buffer);
    for (let i = 0; i < buffer.length; i++) buffer[i] = this.waveform ? this.waveform[i % this.waveform.length] : this.amplitude * (i % 2 ? -1 : 1);
  });
}

class MockContext extends TrackedTarget {
  static instances: MockContext[] = [];
  static initialState = "running";
  static blocked = false;
  state = MockContext.initialState;
  destination = new MockNode("destination");
  nodes: MockNode[] = [];
  streams: MockStream[] = [];
  constructor() {
    super();
    if (MockContext.blocked) throw new Error("AudioContext blocked");
    MockContext.instances.push(this);
  }
  node(kind: string) { const node = new MockNode(kind); this.nodes.push(node); return node; }
  createMediaStreamSource = vi.fn((stream: MockStream) => { this.streams.push(stream); return this.node("source"); });
  createChannelSplitter = vi.fn((_count: number) => this.node("splitter"));
  createGain = vi.fn(() => this.node("gain"));
  createAnalyser = vi.fn(() => this.node("analyser"));
  resume = vi.fn(async () => { this.changeState("running"); });
  suspend = vi.fn(async () => { this.changeState("suspended"); });
  close = vi.fn(async () => { this.changeState("closed"); });
  changeState(state: string) { this.state = state; this.dispatchEvent(new Event("statechange")); }
  asContext() { return this as unknown as AudioContext; }
  get analysers() { return this.nodes.filter((node) => node.kind === "analyser"); }
}

let frames: Map<number, FrameRequestCallback>;
let frameId: number;
function tick(time: number) {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(time));
  });
}
function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}
function mountMeter(track = new MockTrack(2), context = new MockContext()) {
  const view = render(<AudioMeter track={track.asTrack()} context={context.asContext()} name="Camera 1" />);
  return { ...view, track, context, root: screen.getByRole("group", { name: "Camera 1 audio meters" }), bars: screen.getAllByRole("meter") };
}
function value(bar: HTMLElement) { return Number(bar.getAttribute("aria-valuenow")); }
function fill(bar: HTMLElement) { return bar.querySelector<HTMLElement>(".audio-meter-fill")!; }
function peak(bar: HTMLElement) { return bar.querySelector<HTMLElement>(".audio-meter-peak")!; }

beforeEach(() => {
  frames = new Map();
  frameId = 0;
  MockContext.instances = [];
  MockContext.initialState = "running";
  MockContext.blocked = false;
  vi.stubGlobal("AudioContext", MockContext);
  vi.stubGlobal("MediaStream", MockStream);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  visibility("visible");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("useAudioMeterContext", () => {
  it("creates one context on mount without resume, reflects state changes, and closes on teardown", () => {
    const view = renderHook(() => useAudioMeterContext());
    const context = MockContext.instances[0];
    expect(MockContext.instances).toHaveLength(1);
    expect(view.result.current.context).toBe(context);
    expect(view.result.current.state).toBe("running");
    expect(context.resume).not.toHaveBeenCalled();
    for (const state of ["interrupted", "suspended", "running", "closed"]) {
      act(() => context.changeState(state));
      expect(view.result.current.state).toBe(state);
    }
    view.unmount();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.listenerCount()).toBe(0);
  });

  it("never auto-resumes suspended contexts, and calls resume synchronously in enable", async () => {
    MockContext.initialState = "suspended";
    const view = renderHook(() => useAudioMeterContext());
    const context = MockContext.instances[0];
    expect(view.result.current.state).toBe("suspended");
    expect(context.resume).not.toHaveBeenCalled();
    visibility("hidden");
    visibility("visible");
    act(() => window.dispatchEvent(new Event("pageshow")));
    expect(context.resume).not.toHaveBeenCalled();
    await act(async () => {
      view.result.current.enable();
      expect(context.resume).toHaveBeenCalledOnce();
      view.result.current.enable();
      expect(context.resume).toHaveBeenCalledOnce();
    });
    expect(view.result.current.state).toBe("running");
    act(() => view.result.current.enable());
    expect(context.resume).toHaveBeenCalledOnce();
  });

  it("handles rejected and synchronously throwing resume, allowing a gesture retry", async () => {
    MockContext.initialState = "suspended";
    const view = renderHook(() => useAudioMeterContext());
    const context = MockContext.instances[0];
    context.resume.mockRejectedValueOnce(new Error("NotAllowedError"));
    await act(async () => view.result.current.enable());
    expect(view.result.current.state).toBe("error");
    expect(view.result.current.context).toBe(context);
    context.resume.mockImplementationOnce(() => { throw new Error("blocked"); });
    act(() => view.result.current.enable());
    expect(view.result.current.state).toBe("error");
    await act(async () => view.result.current.enable());
    expect(view.result.current.state).toBe("running");
  });

  it("reports unsupported and blocked construction without throwing, and retries construction on enable", () => {
    vi.stubGlobal("AudioContext", undefined);
    const unsupported = renderHook(() => useAudioMeterContext());
    expect(unsupported.result.current).toMatchObject({ context: null, state: "unsupported" });
    act(() => unsupported.result.current.enable());
    unsupported.unmount();
    vi.stubGlobal("AudioContext", MockContext);
    MockContext.blocked = true;
    const blocked = renderHook(() => useAudioMeterContext());
    expect(blocked.result.current).toMatchObject({ context: null, state: "error" });
    MockContext.blocked = false;
    act(() => blocked.result.current.enable());
    expect(blocked.result.current.state).toBe("running");
  });

  it("isolates StrictMode contexts and ignores a late resume after unmount", async () => {
    MockContext.initialState = "suspended";
    const view = renderHook(() => useAudioMeterContext(), { wrapper: StrictMode });
    expect(MockContext.instances).toHaveLength(2);
    const [old, current] = MockContext.instances;
    expect(old.close).toHaveBeenCalledOnce();
    expect(old.listenerCount()).toBe(0);
    expect(view.result.current.context).toBe(current);
    let resolve!: () => void;
    current.resume.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    act(() => view.result.current.enable());
    const enable = view.result.current.enable;
    view.unmount();
    expect(current.close).toHaveBeenCalledOnce();
    await act(async () => {
      current.changeState("running");
      resolve();
    });
    expect(current.state).toBe("closed");
    expect(current.listenerCount()).toBe(0);
    enable();
    expect(current.resume).toHaveBeenCalledOnce();
  });

  it("absorbs late resume rejection and close failure", async () => {
    MockContext.initialState = "suspended";
    const view = renderHook(() => useAudioMeterContext());
    const context = MockContext.instances[0];
    let reject!: (reason: Error) => void;
    context.resume.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    context.close.mockRejectedValueOnce(new Error("closed"));
    act(() => view.result.current.enable());
    view.unmount();
    await act(async () => reject(new Error("disposed")));
    expect(context.listenerCount()).toBe(0);
  });
});

describe("AudioMeter", () => {
  it("measures separate L/R RMS and sample peaks through an always-silent graph", () => {
    const { root, bars, context, track } = mountMeter();
    context.analysers[0].amplitude = 0.5;
    context.analysers[1].amplitude = 0.125;
    tick(0);
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual(["Camera 1 channel L", "Camera 1 channel R"]);
    expect(value(bars[0])).toBeCloseTo(-6, 1);
    expect(value(bars[1])).toBeCloseTo(-18.1, 1);
    expect(parseFloat(fill(bars[0]).style.height)).toBeCloseTo(89.97, 1);
    expect(parseFloat(peak(bars[1]).style.bottom)).toBeCloseTo(69.9, 1);
    expect(bars[0].dataset.level).toBe("amber");
    expect(bars[1].dataset.level).toBe("green");
    expect(root.dataset.state).toBe("running");
    expect(root.classList.contains("unavailable")).toBe(false);
    expect(context.streams[0].getAudioTracks()).toEqual([track]);
    const [source, splitter, gain, left, right] = context.nodes;
    expect(source.connections).toEqual([{ node: splitter, output: 0, input: 0 }]);
    expect(splitter.connections).toEqual([{ node: left, output: 0, input: 0 }, { node: right, output: 1, input: 0 }]);
    expect(left.connections[0].node).toBe(gain);
    expect(right.connections[0].node).toBe(gain);
    expect(gain.connections[0].node).toBe(context.destination);
    expect(gain.gain.value).toBe(0);
    expect(track.enabled).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();
    expect(root.querySelector("[aria-live]")).toBeNull();
    expect(root.querySelector(".audio-meter-axis")?.textContent).toBe("0-6-18-60dBFS");
  });

  it("uses actual RMS rather than sample peak, floors silence and holds/decays peaks and clipping", () => {
    const { bars, context } = mountMeter(new MockTrack(1));
    const analyser = context.analysers[0];
    analyser.waveform = [1, 0, -1, 0];
    tick(0);
    expect(value(bars[0])).toBe(-3);
    expect(peak(bars[0]).style.bottom).toBe("100%");
    expect(bars[0].classList.contains("is-clipping")).toBe(true);
    expect(bars[0].dataset.level).toBe("red");
    analyser.waveform = null;
    tick(500);
    expect(value(bars[0])).toBe(-60);
    expect(parseFloat(fill(bars[0]).style.height)).toBeGreaterThan(0);
    expect(peak(bars[0]).style.bottom).toBe("100%");
    expect(bars[0].classList.contains("is-clipping")).toBe(true);
    tick(1050);
    expect(parseFloat(peak(bars[0]).style.bottom)).toBeLessThan(100);
    expect(bars[0].classList.contains("is-clipping")).toBe(false);
    for (let time = 1100; time <= 5000; time += 50) tick(time);
    expect(fill(bars[0]).style.height).toBe("0%");
    expect(peak(bars[0]).style.bottom).toBe("0%");
    expect(bars[0].getAttribute("aria-valuetext")).toContain("at or below -60.0 dBFS");
  });

  it("refreshes peak hold for small sample-window variations in a steady tone", () => {
    const { bars, context } = mountMeter(new MockTrack(1));
    const analyser = context.analysers[0];
    analyser.amplitude = 0.99;
    tick(0);
    const held = peak(bars[0]).style.bottom;
    analyser.amplitude = 0.989;
    tick(900);
    analyser.amplitude = 0;
    tick(1500);
    expect(peak(bars[0]).style.bottom).toBe(held);
    tick(1950);
    expect(parseFloat(peak(bars[0]).style.bottom)).toBeLessThan(parseFloat(held));
  });

  it("throttles sampling to at most 25 Hz, reuses 2048-float buffers and updates ARIA at most 4 Hz", () => {
    const { bars, context } = mountMeter(new MockTrack(1));
    const analyser = context.analysers[0];
    analyser.amplitude = 0.5;
    tick(0);
    analyser.amplitude = 0.25;
    tick(16);
    tick(32);
    expect(analyser.getFloatTimeDomainData).toHaveBeenCalledOnce();
    tick(48);
    expect(analyser.getFloatTimeDomainData).toHaveBeenCalledTimes(2);
    expect(value(bars[0])).toBe(-6);
    tick(300);
    expect(value(bars[0])).toBe(-12);
    expect(analyser.fftSize).toBe(2048);
    expect(analyser.buffers[0]).toHaveLength(2048);
    expect(analyser.buffers.every((buffer) => buffer === analyser.buffers[0])).toBe(true);
  });

  it.each([
    [1, ["M"]], [2, ["L", "R"]], [3, ["1", "2", "3"]],
    [12, ["1", "2", "3", "4", "5", "6", "7", "8"]],
    [undefined, ["1", "2"]], [0, ["1", "2"]], [NaN, ["1", "2"]],
  ])("labels channel count %s accurately and clamps splitter inputs/outputs", (count, labels) => {
    const { bars, root, context } = mountMeter(new MockTrack(count));
    expect(bars.map((bar) => bar.querySelector(".audio-meter-label")?.textContent)).toEqual(labels);
    expect(context.createChannelSplitter).toHaveBeenCalledWith(labels.length);
    const splitter = context.nodes.find((node) => node.kind === "splitter")!;
    expect(splitter.channelCount).toBe(labels.length);
    expect(splitter.channelCountMode).toBe("explicit");
    expect(splitter.channelInterpretation).toBe("discrete");
    if (!count) expect(root.title).toContain("First two decoded channels (channel count unknown)");
    if (count === 12) expect(root.title).toContain("First 8 of 12 decoded channels");
  });

  it("falls back to two decoded slots if track settings throw", () => {
    const track = new MockTrack();
    track.getSettings.mockImplementation(() => { throw new Error("settings unavailable"); });
    const { bars, root } = mountMeter(track);
    expect(bars).toHaveLength(2);
    expect(root.title).toContain("channel count unknown");
  });

  it("shows suspended/interrupted/closed explicitly and never samples or resumes a paused context", () => {
    MockContext.initialState = "suspended";
    const { context, bars, root } = mountMeter();
    tick(0);
    expect(root.dataset.state).toBe("suspended");
    expect(root.textContent).toContain("enable meters to resume");
    expect(bars[0].hasAttribute("aria-valuenow")).toBe(false);
    expect(context.analysers[0].getFloatTimeDomainData).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    act(() => context.changeState("running"));
    context.analysers[0].amplitude = 1;
    tick(100);
    expect(fill(bars[0]).style.height).toBe("100%");
    for (const state of ["interrupted", "suspended", "closed"]) {
      act(() => context.changeState(state));
      expect(root.dataset.state).toBe(state);
      expect(fill(bars[0]).style.height).toBe("0%");
      expect(peak(bars[0]).hidden).toBe(true);
      expect(bars[0].classList.contains("is-clipping")).toBe(false);
      expect(bars[0].hasAttribute("aria-valuenow")).toBe(false);
      tick(200);
    }
    expect(context.analysers[0].getFloatTimeDomainData).toHaveBeenCalledOnce();
    expect(context.resume).not.toHaveBeenCalled();
  });

  it("clears on track mute/end and disconnects and removes listeners on replacement/unmount", () => {
    const { context, bars, root, track, rerender, unmount } = mountMeter();
    context.analysers[0].amplitude = 1;
    tick(0);
    act(() => track.mute(true));
    expect(root.dataset.state).toBe("muted");
    expect(fill(bars[0]).style.height).toBe("0%");
    expect(frames.size).toBe(0);
    tick(100);
    expect(context.analysers[0].getFloatTimeDomainData).toHaveBeenCalledOnce();
    act(() => track.mute(false));
    tick(200);
    expect(fill(bars[0]).style.height).toBe("100%");
    act(() => track.end());
    expect(root.dataset.state).toBe("ended");
    expect(frames.size).toBe(0);
    const oldNodes = [...context.nodes];
    const replacement = new MockTrack(1);
    rerender(<AudioMeter track={replacement.asTrack()} context={context.asContext()} name="Replacement" />);
    expect(oldNodes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(track.listenerCount()).toBe(0);
    expect(screen.getByRole("meter", { name: "Replacement channel M" })).toBeDefined();
    act(() => track.mute(true));
    expect(root.dataset.state).toBe("running");
    unmount();
    expect(context.nodes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(replacement.listenerCount()).toBe(0);
    expect(context.listenerCount()).toBe(0);
    expect(frames.size).toBe(0);
    expect(track.stop).not.toHaveBeenCalled();
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(replacement.enabled).toBe(true);
    expect(context.close).not.toHaveBeenCalled();
  });

  it("pauses/clears on visibility and pagehide, resamples on return only when context is running", () => {
    const { context, bars, root } = mountMeter();
    context.analysers[0].amplitude = 1;
    tick(0);
    visibility("hidden");
    expect(root.dataset.state).toBe("hidden");
    expect(fill(bars[0]).style.height).toBe("0%");
    expect(frames.size).toBe(0);
    tick(100);
    visibility("visible");
    tick(200);
    expect(fill(bars[0]).style.height).toBe("100%");
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(root.dataset.state).toBe("hidden");
    visibility("visible");
    expect(frames.size).toBe(0);
    act(() => window.dispatchEvent(new Event("pageshow")));
    tick(300);
    expect(root.dataset.state).toBe("running");
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => context.changeState("suspended"));
    act(() => window.dispatchEvent(new Event("pageshow")));
    expect(root.dataset.state).toBe("suspended");
    expect(frames.size).toBe(0);
    expect(context.resume).not.toHaveBeenCalled();
    expect(context.suspend).not.toHaveBeenCalled();
    expect(context.analysers[0].getFloatTimeDomainData).toHaveBeenCalledTimes(3);
  });

  it("does not sample when initially hidden or when a track is disabled, and notices re-enable", () => {
    visibility("hidden");
    const { context, track, root } = mountMeter();
    tick(0);
    expect(context.analysers[0].getFloatTimeDomainData).not.toHaveBeenCalled();
    visibility("visible");
    track.enabled = false;
    tick(100);
    expect(root.dataset.state).toBe("disabled");
    expect(context.analysers[0].getFloatTimeDomainData).not.toHaveBeenCalled();
    track.enabled = true;
    tick(200);
    expect(root.dataset.state).toBe("running");
    expect(context.analysers[0].getFloatTimeDomainData).toHaveBeenCalledOnce();
  });

  it("distinguishes absent tracks and unavailable contexts from digital silence", () => {
    const { root, bars, rerender } = mountMeter();
    rerender(<AudioMeter track={null} context={null} name="Camera 1" />);
    expect(root.dataset.state).toBe("no-track");
    expect(bars[0].hasAttribute("aria-valuenow")).toBe(false);
    rerender(<AudioMeter track={new MockTrack(2).asTrack()} context={null} name="Camera 1" />);
    expect(root.dataset.state).toBe("unavailable");
    expect(root.classList.contains("unavailable")).toBe(true);
    expect(bars[0].getAttribute("aria-valuetext")).toBe("Audio metering unavailable");
    expect(frames.size).toBe(0);
  });

  it("cleans partial graph construction and sampling failures without affecting playback", () => {
    const context = new MockContext();
    context.createAnalyser.mockImplementationOnce(() => { throw new Error("unsupported graph"); });
    const view = mountMeter(new MockTrack(1), context);
    expect(view.root.dataset.state).toBe("error");
    expect(context.nodes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(frames.size).toBe(0);
    const replacement = new MockContext();
    view.rerender(<AudioMeter track={view.track.asTrack()} context={replacement.asContext()} name="Camera 1" />);
    replacement.analysers[0].getFloatTimeDomainData.mockImplementationOnce(() => { throw new Error("analysis failed"); });
    tick(0);
    expect(view.root.dataset.state).toBe("error");
    expect(replacement.nodes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(frames.size).toBe(0);
    expect(view.track.stop).not.toHaveBeenCalled();
  });

  it("shares a hook-owned context across tiles and cleans all StrictMode nodes and page listeners", () => {
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const track = new MockTrack(2);
    function Grid() {
      const { context } = useAudioMeterContext();
      return <><AudioMeter track={track.asTrack()} context={context} name="One" /><AudioMeter track={track.asTrack()} context={context} name="Two" /></>;
    }
    const view = render(<StrictMode><Grid /></StrictMode>);
    const [old, current] = MockContext.instances;
    expect(MockContext.instances).toHaveLength(2);
    expect(old.close).toHaveBeenCalledOnce();
    expect(current.streams).toHaveLength(2);
    expect(frames.size).toBe(2);
    view.unmount();
    expect(current.close).toHaveBeenCalledOnce();
    expect(current.nodes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(track.listenerCount()).toBe(0);
    expect(frames.size).toBe(0);
    expect(removeDocument.mock.calls.some(([type]) => type === "visibilitychange")).toBe(true);
    expect(removeWindow.mock.calls.some(([type]) => type === "pagehide")).toBe(true);
    expect(removeWindow.mock.calls.some(([type]) => type === "pageshow")).toBe(true);
    act(() => window.dispatchEvent(new Event("pageshow")));
    visibility("visible");
    expect(frames.size).toBe(0);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("disconnects StrictMode's first graph and ignores an already-dispatched frame after disposal", () => {
    const track = new MockTrack(2);
    const context = new MockContext();
    const view = render(<StrictMode><AudioMeter track={track.asTrack()} context={context.asContext()} name="Strict" /></StrictMode>);
    expect(context.streams).toHaveLength(2);
    expect(context.nodes.slice(0, 5).every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(context.nodes.slice(5).every((node) => node.disconnect.mock.calls.length === 0)).toBe(true);
    expect(frames.size).toBe(1);
    const dispatched = [...frames.values()][0];
    view.unmount();
    act(() => dispatched(100));
    expect(context.analysers.every((node) => node.getFloatTimeDomainData.mock.calls.length === 0)).toBe(true);
    expect(context.nodes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true);
    expect(frames.size).toBe(0);
    expect(context.listenerCount()).toBe(0);
    expect(track.listenerCount()).toBe(0);
    expect(context.close).not.toHaveBeenCalled();
  });

  it("preserves live DOM levels across parent rerenders and updates accessible names", () => {
    const { track, context, root, bars, rerender } = mountMeter();
    context.analysers[0].amplitude = 1;
    tick(0);
    const height = fill(bars[0]).style.height;
    rerender(<AudioMeter track={track.asTrack()} context={context.asContext()} name="Renamed" />);
    expect(screen.getByRole("group", { name: "Renamed audio meters" })).toBe(root);
    expect(screen.getByRole("meter", { name: "Renamed channel L" })).toBe(bars[0]);
    expect(root.dataset.state).toBe("running");
    expect(root.classList.contains("unavailable")).toBe(false);
    expect(fill(bars[0]).style.height).toBe(height);
    expect(bars[0].classList.contains("is-clipping")).toBe(true);
    expect(context.streams).toHaveLength(1);
  });
});
