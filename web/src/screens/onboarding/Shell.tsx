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

import { Button } from "../../components/ui/Button";
import { SKIP_COPY, type SkippableStep } from "../../v2/onboarding";

export function Step({
  title,
  intro,
  children,
  footer,
  testId,
  embedded = false,
}: {
  title: string;
  intro?: ReactNode;
  children?: ReactNode;
  /** The step's actions. Rendered last, after everything it acts on. */
  footer?: ReactNode;
  testId?: string;
  /**
   * Render the step's CONTENT with no page around it.
   *
   * A step is normally the whole glass. Since setup stopped being a corridor,
   * two of these screens are also reachable from Settings — the home-currency
   * ceremony a user skipped, and the mail check, which must be re-runnable long
   * after setup — and they open in a `Dialog`, which owns the page shape and the
   * title. Reusing the component rather than writing a second version of it is
   * the point: the home-currency ceremony's three-places-before-the-tap warning
   * is exactly the copy that must not exist twice and drift.
   *
   * So this drops the `100svh` frame, the outer heading and its focus move (the
   * dialog labels and focuses itself), and keeps the rhythm: intro, content,
   * actions last.
   */
  embedded?: boolean;
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
    if (embedded) return;
    heading.current?.focus();
  }, [title, embedded]);

  if (embedded) {
    return (
      <div className="flex flex-col gap-4" {...(testId === undefined ? {} : { "data-testid": testId })}>
        {/* Still rendered, as a heading one level down. The dialog's own title
            names the drawer; this names the step inside it, and for the
            home-currency ceremony the two differ at the moment it matters — the
            confirm phase's title is the code being weighed. */}
        <h2 className="text-base font-semibold tracking-[-0.015em]">{title}</h2>
        {intro !== undefined && <p className="text-sm leading-relaxed text-muted">{intro}</p>}
        {children}
        {footer !== undefined && <div className="pt-1 flex flex-col gap-3">{footer}</div>}
      </div>
    );
  }

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

/**
 * The way past a step, on every step after account creation.
 *
 * # It is a control, not a hidden link, and it is never disabled
 *
 * Onboarding was a chain, and any broken link in a chain is a locked door — the
 * operator was locked out of his own app twice in one day by two unrelated bugs
 * in two different links. A skip that greys out while something loads, or that
 * hides behind a "having trouble?" disclosure, is the same door with a politer
 * handle. So this is a plain button that is always pressable, and the copy above
 * it says what will not work until the step is done rather than pretending the
 * step does not matter.
 *
 * The consequence comes FIRST, because it is what the press is weighed against;
 * the action is last, which is the rhythm every {@link Step} keeps.
 *
 * Nothing here softens a security step. There is no skip on the invite, the
 * passkey or the recovery phrase, and `SKIPPABLE_STEPS` is what enforces that —
 * this component cannot be pointed at a step that is not in it.
 */
export function SkipStep({ step, onSkip, testId }: { step: SkippableStep; onSkip: () => void; testId?: string }) {
  const copy = SKIP_COPY[step];
  return (
    <div data-testid={testId ?? `skip-${step}`} className="flex flex-col gap-2 pt-4 mt-2 border-t border-border">
      <p className="text-xs leading-relaxed text-muted">{copy.consequence}</p>
      <Button variant="ghost" onClick={onSkip}>
        {copy.action}
      </Button>
    </div>
  );
}
