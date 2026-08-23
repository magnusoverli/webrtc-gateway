import { afterEach, describe, expect, it, vi } from "vitest";
import { startSerialPolling } from "./polling";

afterEach(() => vi.useRealTimers());

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
});
