import { useEffect, type RefObject } from "react";

// How many mounted sheets currently want this element inert. An element the
// app itself marked inert (AppShell's covered layers) is never in this map,
// so cleanup never strips a mark it did not make.
const holds = new WeakMap<Element, number>();

/**
 * While the referenced element is mounted, every sibling of it and of each of
 * its ancestors is `inert`: out of the tab order, out of the screen-reader
 * cursor, and not clickable. A modal sheet renders inline (no portal), so
 * inerting an ancestor would swallow the sheet itself; the siblings along the
 * path are what must go quiet. Nested sheets ref-count, so the outer sheet's
 * marks survive the inner one closing. `[data-inert-exempt]` opts a sibling
 * out — the toast region, which must stay tappable over a sheet.
 */
export function useInertOthers(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const taken: Element[] = [];
    for (let child: Element = node; child.parentElement && child !== document.body; child = child.parentElement) {
      for (const sib of child.parentElement.children) {
        if (sib === child || sib.hasAttribute("data-inert-exempt") || sib.tagName === "SCRIPT") continue;
        const n = holds.get(sib) ?? 0;
        if (n === 0 && sib.hasAttribute("inert")) continue; // the app's own mark
        holds.set(sib, n + 1);
        sib.setAttribute("inert", "");
        taken.push(sib);
      }
    }
    return () => {
      for (const sib of taken) {
        const n = (holds.get(sib) ?? 1) - 1;
        if (n <= 0) {
          holds.delete(sib);
          sib.removeAttribute("inert");
        } else {
          holds.set(sib, n);
        }
      }
    };
  }, [ref]);
}
