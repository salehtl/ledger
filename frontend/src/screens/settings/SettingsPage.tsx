import { useCallback, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, m, useDragControls } from "motion/react";
import { ArrowLeft } from "../../components/ui/PixelIcon";
import { IconButton } from "../../components/ui/IconButton";
import { SHEET_ENTER, SHEET_EXIT } from "../../lib/motion";
import { inEdgeZone, shouldGoBack } from "../../lib/edgeBack";

/**
 * Shared full-screen drill-in shell for a Settings subpage. Matches the
 * CategoryManager / RulesManager panel: a back-arrow header over a scrolling
 * body. `headerRight` hosts the page's autosave feedback.
 *
 * The shell slides in from the right and supports iOS-style edge-swipe-back:
 * a drag starting in the 24px left-edge strip tracks the finger and reveals
 * the screen underneath; the back arrow and a committed drag both play the
 * slide-out before onClose unmounts the page. Reduced motion is the global
 * MotionConfig's business: it drops the slide and leaves the rest alone.
 */
export function SettingsPage({
  title,
  onClose,
  headerRight,
  covered = false,
  children,
}: {
  title: string;
  onClose: () => void;
  headerRight?: ReactNode;
  /** A deeper panel is open over this one: take its header out of the tab order. */
  covered?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Same lifecycle as Dialog: the page owns its exit and the parent is only
  // told to unmount once AnimatePresence says the slide-out has finished.
  // Closing twice is `setOpen(false)` twice, so no double-close guard is
  // needed — onExitComplete fires exactly once per exit.
  const [open, setOpen] = useState(true);
  const requestClose = useCallback(() => setOpen(false), []);
  const dragControls = useDragControls();

  return (
    <AnimatePresence onExitComplete={() => onCloseRef.current()}>
      {open && (
        <m.div
          ref={panelRef}
          // `initial` is committed as the first render's inline style, so the
          // offscreen start state is there before the first paint and needs no
          // flush. That is what the hand-rolled version used `void offsetHeight`
          // for and still got wrong in WebKit, which left the panel parked
          // off-screen and then snapped it in (see Dialog).
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          // Exit transition on the exit target: Framer has no `transition.exit`
          // key, so the shorter slide-out has to be declared here (see Dialog).
          exit={{ x: "100%", transition: SHEET_EXIT }}
          transition={SHEET_ENTER}
          drag="x"
          dragControls={dragControls}
          dragListener={false}
          dragConstraints={{ left: 0, right: 0 }}
          // Rightward only: there is nothing to the left to reveal, so a
          // leftward pull is clamped rather than tracked.
          dragElastic={{ left: 0, right: 0.9 }}
          dragMomentum={false}
          onDragEnd={(_, info) => {
            const width = panelRef.current?.offsetWidth || window.innerWidth; // jsdom: offsetWidth is 0
            if (shouldGoBack(info.offset.x, info.velocity.x, width)) requestClose();
          }}
          className="fixed inset-0 z-40 bg-bg flex flex-col"
        >
          {/* Invisible activation strip: touch-none here (and only here) lets
              horizontal pointermoves reach us instead of scrolling the page. */}
          <div
            aria-hidden
            data-testid="edge-back-strip"
            className="absolute left-0 inset-y-0 w-6 z-10 touch-none"
            onPointerDown={(e) => { if (inEdgeZone(e.clientX)) dragControls.start(e); }}
          />
          {/* `covered` marks only the header inert, never the body: a nested panel
              renders inside the body, so making that inert would disable the very
              page sitting on top. Its own content handles its own inertness. */}
          {/* This panel is `fixed inset-0`, so it covers TopBar and BottomNav and
              inherits none of their safe-area padding. Without these insets the
              back arrow sits under the notch and the last row under the home
              indicator on every drill-in screen. */}
          <header
            className="flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3 border-b border-border"
            inert={covered}
          >
            <IconButton label={`Back from ${title}`} className="-ml-2" onClick={requestClose}>
              <ArrowLeft size={20} />
            </IconButton>
            <h1 className="flex-1 text-lg font-semibold text-fg">{title}</h1>
            {headerRight}
          </header>
          <div className="flex-1 overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-6 max-w-screen-sm w-full mx-auto">
            {children}
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
