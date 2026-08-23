export function startSerialPolling(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    try {
      await task(controller.signal);
    } finally {
      if (!controller.signal.aborted) {
        timer = setTimeout(() => void run().catch(() => undefined), intervalMs);
      }
    }
  };

  void run().catch(() => undefined);
  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  };
}
