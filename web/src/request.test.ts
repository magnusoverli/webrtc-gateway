import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestTimeoutError, requestJSON, requestText } from "./request";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded requests", () => {
  it("aborts a fetch when its deadline expires", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }));

    const request = requestText("/status", { timeoutMs: 100 });
    const rejection = expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(RequestTimeoutError);
  });

  it("keeps the deadline active while consuming the response body", async () => {
    vi.useFakeTimers();
    const text = vi.fn(() => new Promise<string>(() => undefined));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ text } as unknown as Response));

    const request = requestText("/status", { timeoutMs: 50 });
    const rejection = expect(request).rejects.toMatchObject({ name: "RequestTimeoutError", timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(text).toHaveBeenCalledOnce();
  });

  it("preserves caller cancellation as an AbortError instead of a timeout", async () => {
    vi.useFakeTimers();
    const lifecycle = new AbortController();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    const request = requestText("/status", { signal: lifecycle.signal, timeoutMs: 100 });
    lifecycle.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns response metadata with parsed JSON", async () => {
    const response = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ready: true }),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(requestJSON<{ ready: boolean }>("/status")).resolves.toEqual({
      response,
      body: { ready: true },
    });
  });
});
