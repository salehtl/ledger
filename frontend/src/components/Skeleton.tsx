export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {/* `animate-pulse` stays CSS and is deliberately NOT gated behind
          prefers-reduced-motion. Reduced motion asks for less *movement*, not
          less comprehension, and this is pure opacity — there is nothing
          travelling across the screen to trigger on. Same ruling as the pixel
          spinner (styles/app.css). It also stays out of Framer: an indefinite
          loop is the one shape a JS animation scheduler is strictly worse at
          than a CSS keyframe. A CSS animation is handed to the compositor once
          and then costs the main thread nothing, whereas Framer would hold a
          driver open for the entire duration of a load — on the screen where
          the main thread is already the scarce resource, and for motion no
          gesture can ever interrupt.

          This is the canonical statement of the rule; the other four
          `animate-pulse` sites point back here. */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 rounded-[var(--radius)] bg-surface-2 animate-pulse" />
      ))}
    </div>
  );
}
