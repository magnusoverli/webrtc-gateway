// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { startSerialPolling } from "./polling";

afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
});

describe("startSerialPolling", () => {
  it("waits for each request and aborts on disposal", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    const task = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => releases.push(resolve));
    });

    const stop = startSerialPolling(task, 1000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.runAllTicks();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    await vi.runOnlyPendingTimersAsync();
    expect(task).toHaveBeenCalledTimes(2);

    stop();
    expect(signals.at(-1)?.aborted).toBe(true);
    releases.shift()?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("uses normal success cadence and capped exponential failure backoff", async () => {
    vi.useFakeTimers();
    const task = vi.fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValue(undefined);
    const results: Array<{ status: string; nextDelayMs: number | null }> = [];

    const poller = startSerialPolling(task, {
      intervalMs: 100,
      maxFailureDelayMs: 150,
      jitterRatio: 0.2,
      random: () => 0.5,
      onResult: (result) => results.push(result),
    });
    await flush();
    expect(results.at(-1)).toMatchObject({ status: "failure", nextDelayMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(2);
    expect(results.at(-1)).toMatchObject({ status: "failure", nextDelayMs: 150 });
    await vi.advanceTimersByTimeAsync(149);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(3);
    expect(results.at(-1)).toMatchObject({ status: "success", failureCount: 0, nextDelayMs: 100 });

    poller.stop();
  });

  it("coalesces runNow requests without overlapping work", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const task = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    });
    const poller = startSerialPolling(task, 1000);

    poller.runNow();
    poller.runNow();
    expect(task).toHaveBeenCalledTimes(1);
    releases.shift()?.();
    await flush();
    expect(task).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);

    poller();
    releases.shift()?.();
    await flush();
  });

  it("aborts while hidden and refreshes immediately when visible", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const task = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const poller = startSerialPolling(task, 1000);

    setVisibility("hidden");
    expect(signals[0].aborted).toBe(true);
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await flush();
    expect(task).toHaveBeenCalledTimes(2);

    poller.stop();
    await flush();
    setVisibility("hidden");
    setVisibility("visible");
    expect(task).toHaveBeenCalledTimes(2);
  });
});

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}
