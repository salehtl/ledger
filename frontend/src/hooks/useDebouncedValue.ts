import { useEffect, useState } from "react";

/** The value as it stood `ms` after the last change. For search boxes that
 *  query the server: the field itself stays live, the request waits. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}
