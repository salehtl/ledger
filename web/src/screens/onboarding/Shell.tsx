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

import type { ReactNode } from "react";

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
  return (
    <div className="min-h-[100svh] bg-bg text-fg overflow-y-auto" {...(testId === undefined ? {} : { "data-testid": testId })}>
      <div className="max-w-screen-sm mx-auto min-h-[100svh] flex flex-col gap-5 px-6 pt-12 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-[-0.015em]">{title}</h1>
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
 * `tone="danger"` carries `role="alert"`: it is used for the two consequences in
 * this flow that cannot be undone — no account recovery, and the permanent home
 * currency — and a screen reader must interrupt for those rather than reach them
 * in reading order. `tone="note"` is an ordinary hairline card and stays silent.
 */
export function Notice({
  tone = "note",
  title,
  children,
  testId,
}: {
  tone?: "note" | "danger";
  title?: string;
  children: ReactNode;
  testId?: string;
}) {
  const danger = tone === "danger";
  return (
    <div
      className={`flex flex-col gap-2 p-4 rounded-[var(--radius)] border bg-surface ${danger ? "border-bad" : "border-border"}`}
      {...(danger ? { role: "alert" } : {})}
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      {title !== undefined && (
        <p className={`text-sm font-semibold ${danger ? "text-bad" : "text-fg"}`}>{title}</p>
      )}
      <div className="text-sm leading-relaxed text-fg flex flex-col gap-2">{children}</div>
    </div>
  );
}
