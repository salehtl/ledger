import { useEffect, useRef } from "react";

/** True only on the first render where `ready` is true (e.g. the first paint
 *  after data has loaded), false on every render after. Use to play a one-shot
 *  entrance once the content actually exists — unlike useFirstMount, this is
 *  not fooled by an initial loading skeleton. */
export function useFirstReveal(ready: boolean): boolean {
  const seen = useRef(false);
  const firstReveal = ready && !seen.current;
  useEffect(() => { if (ready) seen.current = true; }, [ready]);
  return firstReveal;
}
