export type InvalidationScheduler = { schedule: () => void; cancel: () => void };

// Trailing debounce with a max-wait: a burst of SSE events collapses into one
// flush ~delayMs after the last event, but a sustained burst still flushes
// every maxWaitMs so the UI is never more than maxWaitMs stale.
export function createInvalidationScheduler(
  flush: () => void,
  delayMs = 300,
  maxWaitMs = 2000,
): InvalidationScheduler {
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (trailing) clearTimeout(trailing);
    if (deadline) clearTimeout(deadline);
    trailing = null;
    deadline = null;
  };
  const fire = () => {
    clear();
    flush();
  };

  return {
    schedule() {
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(fire, delayMs);
      if (!deadline) deadline = setTimeout(fire, maxWaitMs);
    },
    cancel: clear,
  };
}
