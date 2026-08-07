/**
 * The page shape every onboarding step shares.
 *
 * Structurally the same thing `BootGate`'s `Wall` is, and for the same reason:
 * an onboarding step is rendered **instead of** the app, never over it, so
 * `components/README.md`'s "every sheet/modal is a Dialog" rule does not apply —
 * there is nothing behind it to dismiss back to. `100svh` rather than `100vh`
 * so an iOS URL bar cannot push the primary action under the fold, and the
 * content is top-aligned rather than centred because these steps scroll.
 *
 * It is deliberately not exported from `components/`: it encodes the onboarding
 * flow's own rhythm (one question per page, the action last) and a second caller
 * outside this folder would be a sign the flow had leaked somewhere it should
 * not be.
 */

import { useEffect, useRef, type ReactNode } from "react";

export function Step({
  title,
  intro,
  children,
  footer,
  testId,
}: {
  title: string;
  intro?: ReactNode;
  children?: ReactNode;
  /** The step's actions. Rendered last, after everything it acts on. */
  footer?: ReactNode;
  testId?: string;
}) {
  /**
   * Focus moves to the heading whenever the step changes.
   *
   * A step swaps the whole tree, so without this the focus ring stays on
   * whatever was pressed — a button that no longer exists — and the browser
   * drops focus to `<body>`. A screen-reader user is then given no indication
   * that the page changed at all, and a keyboard user's next Tab restarts from
   * the top of the document. Keyed on `title` rather than on mount, because the
   * two `Address` phases and the two `HomeCurrency` phases are one component
   * rendering a different step.
   *
   * `tabIndex={-1}` makes the heading programmatically focusable without adding
   * it to the tab order; `outline-none` because the ring on a heading nobody
   * clicked reads as a rendering fault rather than as focus.
   */
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);

  return (
    <div className="min-h-[100svh] bg-bg text-fg overflow-y-auto" {...(testId === undefined ? {} : { "data-testid": testId })}>
      <div className="max-w-screen-sm mx-auto min-h-[100svh] flex flex-col gap-5 px-6 pt-12 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <header className="flex flex-col gap-2">
          <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold tracking-[-0.015em] outline-none">
            {title}
          </h1>
          {intro !== undefined && <p className="text-sm leading-relaxed text-muted">{intro}</p>}
        </header>
        {children}
        {footer !== undefined && <div className="mt-auto pt-4 flex flex-col gap-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A bordered block that says something the user has to weigh.
 *
 * # `tone` is the look; `announce` is the live region, and they are separate
 *
 * They were one thing, and that was wrong. `tone="danger"` used to imply
 * `role="alert"`, which put an alert on content **present at first paint** — the
 * recovery warning. An `alert` is announced when it is dynamically INSERTED into
 * an already-rendered page; one that is in the initial markup is generally read
 * in ordinary document order like any other text, so the role bought nothing and
 * the claim that a screen reader would interrupt for it was overstated.
 *
 * Worse than useless, in fact: `role="alert"` is `role="status"`-with-assertive,
 * and assertive announcements interrupt whatever is being read. Applying it to
 * static content risks cutting off the heading the user is listening to.
 *
 * So the rule now is: **`announce` only where the notice appears in response to
 * something.** A sign-in failure, a partial re-ingest, the confirm step's
 * consequence panel — all inserted after a user action, all correctly assertive.
 * The recovery warning on the front door is not; it is ordinary content, placed
 * high in reading order, which is what actually makes it heard.
 */
export function Notice({
  tone = "note",
  announce = false,
  title,
  children,
  testId,
}: {
  tone?: "note" | "danger";
  /** Renders a live region. Only for a notice inserted after first paint. */
  announce?: boolean;
  title?: string;
  children: ReactNode;
  testId?: string;
}) {
  const danger = tone === "danger";
  return (
    <div
      className={`flex flex-col gap-2 p-4 rounded-[var(--radius)] border bg-surface ${danger ? "border-bad" : "border-border"}`}
      {...(announce ? { role: "alert" } : {})}
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      {title !== undefined && (
        <p className={`text-sm font-semibold ${danger ? "text-bad" : "text-fg"}`}>{title}</p>
      )}
      <div className="text-sm leading-relaxed text-fg flex flex-col gap-2">{children}</div>
    </div>
  );
}
