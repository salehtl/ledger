// A setTimeout wrapper that pauses while the tab is hidden, mirroring the
// pause logic Toast.tsx applies to its own 5s auto-dismiss. Anything whose
// lifetime must stay in lockstep with an on-screen toast (e.g. an undo
// window's delayed commit) uses this instead of a bare setTimeout, so
// backgrounding the PWA can never let the commit outrun the toast offering
// to undo it.

export interface PausableTimeout {
  /** Stop the timer and detach the visibility listener; fn never fires. */
  cancel(): void;
}

/** Minimal surface of Document the timer needs — injectable for tests. */
export interface VisibilityDoc {
  hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Run `fn` once after `ms` of *visible* time. While `doc.hidden`, the clock
 * stops; it resumes with the remaining time when the tab returns. If created
 * while hidden, the countdown starts on the first return to visibility.
 */
export function startPausableTimeout(
  fn: () => void,
  ms: number,
  doc: VisibilityDoc = document,
): PausableTimeout {
  let remaining = ms;
  let startedAt = Date.now();
  let id: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  const fire = () => {
    id = null;
    done = true;
    doc.removeEventListener("visibilitychange", onVis);
    fn();
  };

  const onVis = () => {
    if (done) return;
    if (doc.hidden) {
      if (id == null) return; // already paused
      clearTimeout(id);
      id = null;
      remaining -= Date.now() - startedAt;
    } else {
      if (id != null) return; // already running
      startedAt = Date.now();
      id = setTimeout(fire, Math.max(0, remaining));
    }
  };

  doc.addEventListener("visibilitychange", onVis);
  if (!doc.hidden) id = setTimeout(fire, remaining);

  return {
    cancel() {
      if (done) return;
      done = true;
      if (id != null) clearTimeout(id);
      id = null;
      doc.removeEventListener("visibilitychange", onVis);
    },
  };
}
