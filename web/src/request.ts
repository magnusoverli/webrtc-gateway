export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type BoundedRequestInit = RequestInit & {
  timeoutMs?: number;
};

export type BoundedResponse<T> = {
  response: Response;
  body: T;
};

export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isRequestTimeoutError(error: unknown): error is RequestTimeoutError {
  return error instanceof RequestTimeoutError;
}

export async function requestWithDeadline<T>(
  input: RequestInfo | URL,
  init: BoundedRequestInit,
  readBody: (response: Response) => Promise<T>,
): Promise<BoundedResponse<T>> {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal: callerSignal, ...requestInit } = init;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Request timeout must be a non-negative finite number.");
  }
  if (callerSignal?.aborted) throw abortReason(callerSignal.reason);

  const controller = new AbortController();
  let rejectCancellation: (reason: unknown) => void = () => undefined;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (reason: unknown) => {
    if (controller.signal.aborted) return;
    const error = abortReason(reason);
    controller.abort(error);
    rejectCancellation(error);
  };
  const onCallerAbort = () => cancel(callerSignal?.reason);

  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => cancel(new RequestTimeoutError(timeoutMs)), timeoutMs);

  const operation = (async () => {
    try {
      const response = await fetch(input, { ...requestInit, signal: controller.signal });
      throwIfAborted(controller.signal);
      const body = await readBody(response);
      throwIfAborted(controller.signal);
      return { response, body };
    } catch (error) {
      if (controller.signal.aborted) throw abortReason(controller.signal.reason);
      throw error;
    }
  })();

  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

export function requestText(
  input: RequestInfo | URL,
  init: BoundedRequestInit = {},
): Promise<BoundedResponse<string>> {
  return requestWithDeadline(input, init, (response) => response.text());
}

export function requestJSON<T>(
  input: RequestInfo | URL,
  init: BoundedRequestInit = {},
): Promise<BoundedResponse<T>> {
  return requestWithDeadline(input, init, (response) => response.json() as Promise<T>);
}

function abortReason(reason: unknown) {
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  throw abortReason(signal.reason);
}
