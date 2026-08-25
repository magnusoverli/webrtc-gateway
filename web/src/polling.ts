export type PollResult = {
  status: "success" | "failure" | "aborted";
  failureCount: number;
  nextDelayMs: number | null;
  error?: unknown;
};

export type SerialPollingOptions = {
  intervalMs: number | (() => number);
  maxFailureDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  pauseWhenHidden?: boolean;
  onResult?: (result: PollResult) => void;
};

export type SerialPollingHandle = (() => void) & {
  stop: () => void;
  runNow: () => void;
};

type LegacyPollingOptions = Omit<SerialPollingOptions, "intervalMs">;

export function startSerialPolling(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  options?: LegacyPollingOptions,
): SerialPollingHandle;
export function startSerialPolling(
  task: (signal: AbortSignal) => Promise<void>,
  options: SerialPollingOptions,
): SerialPollingHandle;
export function startSerialPolling(
  task: (signal: AbortSignal) => Promise<void>,
  intervalOrOptions: number | SerialPollingOptions,
  legacyOptions: LegacyPollingOptions = {},
): SerialPollingHandle {
  const options = typeof intervalOrOptions === "number"
    ? { ...legacyOptions, intervalMs: intervalOrOptions }
    : intervalOrOptions;
  const intervalMs = () => nonNegative(
    typeof options.intervalMs === "function" ? options.intervalMs() : options.intervalMs,
    "Polling interval",
  );
  const initialIntervalMs = intervalMs();
  const maxFailureDelayMs = nonNegative(
    options.maxFailureDelayMs ?? Math.max(initialIntervalMs, 30_000),
    "Maximum polling failure delay",
  );
  const jitterRatio = Math.min(1, Math.max(0, options.jitterRatio ?? 0.2));
  const random = options.random ?? Math.random;
  const pauseWhenHidden = options.pauseWhenHidden ?? true;
  const visibilityDocument = typeof document === "undefined" ? undefined : document;

  let stopped = false;
  let running = false;
  let runPending = false;
  let failureCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeController: AbortController | undefined;

  const isHidden = () => Boolean(
    pauseWhenHidden && visibilityDocument?.visibilityState === "hidden",
  );
  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const failureDelay = () => {
    const exponent = Math.min(Math.max(0, failureCount - 1), 30);
    const base = Math.min(maxFailureDelayMs, intervalMs() * 2 ** exponent);
    const unit = Math.min(1, Math.max(0, random()));
    return Math.min(maxFailureDelayMs, Math.round(base * (1 - jitterRatio + unit * 2 * jitterRatio)));
  };

  const run = () => {
    clearTimer();
    if (stopped) return;
    if (isHidden()) {
      runPending = true;
      return;
    }
    if (running) {
      runPending = true;
      return;
    }

    running = true;
    const controller = new AbortController();
    activeController = controller;
    void (async () => {
      let status: PollResult["status"] = "success";
      let error: unknown;
      try {
        await task(controller.signal);
        failureCount = 0;
      } catch (caught) {
        error = caught;
        if (controller.signal.aborted) {
          status = "aborted";
        } else {
          status = "failure";
          failureCount += 1;
        }
      } finally {
        if (activeController === controller) activeController = undefined;
        running = false;

        let nextDelayMs: number | null = null;
        if (!stopped && !isHidden()) {
          if (runPending) {
            runPending = false;
            nextDelayMs = 0;
          } else if (status !== "aborted") {
            nextDelayMs = status === "failure" ? failureDelay() : intervalMs();
          }
        }
        try {
          options.onResult?.({ status, failureCount, nextDelayMs, ...(error === undefined ? {} : { error }) });
        } catch {
          // Observability must not interrupt the polling lifecycle.
        }

        if (stopped || isHidden()) return;
        if (nextDelayMs === 0) {
          run();
        } else if (nextDelayMs !== null) {
          timer = setTimeout(run, nextDelayMs);
        }
      }
    })();
  };

  const runNow = () => {
    if (stopped) return;
    clearTimer();
    runPending = running || isHidden();
    if (!runPending) run();
  };
  const onVisibilityChange = () => {
    if (!pauseWhenHidden) return;
    if (isHidden()) {
      clearTimer();
      runPending = true;
      activeController?.abort(new DOMException("Polling paused while the page is hidden.", "AbortError"));
    } else {
      runNow();
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    runPending = false;
    clearTimer();
    activeController?.abort(new DOMException("Polling stopped.", "AbortError"));
    if (pauseWhenHidden) visibilityDocument?.removeEventListener("visibilitychange", onVisibilityChange);
  };

  if (pauseWhenHidden) visibilityDocument?.addEventListener("visibilitychange", onVisibilityChange);
  if (isHidden()) runPending = true;
  else run();

  const handle = stop as SerialPollingHandle;
  handle.stop = stop;
  handle.runNow = runNow;
  return handle;
}

function nonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a non-negative finite number.`);
  return value;
}
