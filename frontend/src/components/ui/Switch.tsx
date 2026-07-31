import type { InputHTMLAttributes } from "react";

/**
 * Toggle switch rendered over a real checkbox, so it keeps native semantics
 * (label association, checked/disabled, change events) for forms and tests.
 *
 * The track stays 28px tall, but the control occupies a full 44px so the tap
 * target meets the app's minimum — the checkbox fills that box while the two
 * painted layers sit centred inside it. They have to remain siblings of the
 * input, not children of a wrapper, or the `peer-checked:` variants stop
 * matching.
 */
export function Switch({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className={`relative inline-block h-11 w-12 shrink-0 ${className}`}>
      <input
        type="checkbox"
        {...rest}
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none rounded-[var(--radius)] disabled:cursor-default"
      />
      {/* top-2: (44 − 28) / 2, centring the track without a transform that
          would collide with the knob's translate. */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-2 h-7 rounded-[var(--radius)] border border-border bg-surface-2 transition-colors duration-200 peer-checked:border-accent peer-checked:bg-accent peer-disabled:opacity-40 peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50 peer-focus-visible:ring-offset-1"
      />
      {/* bg-muted when off: painting the knob bg-surface made it the same
          colour as the page behind it, so "off" read as an empty slot. */}
      {/* data-css-transition: the app's only sanctioned CSS transition on a
          transform, and the harness auditor's check 9 skips it on the strength
          of this marker.

          The reason is narrower than "Framer can't do this". Every current
          call site passes `checked`, so `rest.checked` is right there and an
          `m.span animate={{ x: checked ? 20 : 0 }}` would work today with no
          new state and no API change. What stops it is the *type*: this
          component takes `InputHTMLAttributes<HTMLInputElement>`, so an
          uncontrolled `<Switch defaultChecked />` is a legal call. In that
          case the checked state lives only in the DOM node, and a sibling
          selector is the one thing that can observe it — React never re-renders,
          so no `animate` prop would ever update. Migrating means either
          narrowing the prop type to require `checked` (an API break for a
          decorative 200ms slide) or leaving a documented trap where one call
          shape animates and the other silently does not.

          If the type is ever narrowed to a controlled-only signature, delete
          this marker and move the knob to Framer.

          `motion-reduce:transition-none` is hand-written for the same reason:
          this element is outside `MotionConfig`'s reach. */}
      <span
        aria-hidden
        data-css-transition="peer-checked drives the knob; see comment above"
        className="absolute left-1 top-3 h-5 w-5 rounded-[var(--radius)] bg-muted transition-[transform,background-color] duration-200 motion-reduce:transition-none peer-checked:translate-x-5 peer-checked:bg-surface peer-disabled:opacity-60"
      />
    </span>
  );
}
