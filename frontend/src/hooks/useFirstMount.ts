import { useEffect, useRef } from "react";

/** True only during the component's first render; false on every render after.
 *  Use to play a one-shot entrance once per mount without replaying on updates. */
export function useFirstMount(): boolean {
  const first = useRef(true);
  useEffect(() => { first.current = false; }, []);
  return first.current;
}
