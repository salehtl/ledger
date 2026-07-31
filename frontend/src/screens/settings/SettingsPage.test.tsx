import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MotionProvider } from "../../app/MotionProvider";
import { SettingsPage } from "./SettingsPage";

// The page's motion is Framer's now, so the two halves are tested where each
// can actually be observed: the *decision* (how far / how fast commits a
// back-swipe) is a pure function with its own tests in lib/edgeBack.test.ts,
// and the *lifecycle* (exit plays, then the parent is told to unmount) is
// tested here. A Framer drag cannot be driven meaningfully in jsdom — there is
// no layout to measure and no frame clock behind the pointer stream — so this
// file deliberately does not fake one; a test that pretended to would pass
// whether or not the gesture was wired up at all.
function renderPage(onClose = vi.fn()) {
  render(
    <MotionProvider>
      <SettingsPage title="Budget" onClose={onClose}>
        <p>body</p>
      </SettingsPage>
    </MotionProvider>,
  );
  return onClose;
}

/** The panel is the strip's parent; it has no role of its own. */
const panel = () => screen.getByTestId("edge-back-strip").parentElement!;

/**
 * Resolve once LazyMotion's feature bundle is live — the panel has moved off
 * its seeded `translateX(100%)` start. Without this gate the assertions below
 * would hold even with motion features absent, where `exit` never runs.
 */
async function motionReady() {
  const el = panel();
  await waitFor(() => expect(el.style.transform).not.toBe("translateX(100%)"));
}

describe("SettingsPage", () => {
  it("renders the title and body", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Budget" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("plays the exit before the back arrow's onClose reaches the parent", async () => {
    const onClose = renderPage();
    await motionReady();
    fireEvent.click(screen.getByRole("button", { name: "Back from Budget" }));
    expect(onClose).not.toHaveBeenCalled();      // slide-out in flight
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("keeps the edge strip swallowing horizontal gestures", () => {
    // touch-none on the strip (and only the strip) is what lets a horizontal
    // pointermove reach the drag controls instead of scrolling the page.
    renderPage();
    expect(screen.getByTestId("edge-back-strip")).toHaveClass("touch-none");
  });

  it("takes the header out of the tab order when a deeper panel covers it", () => {
    render(
      <MotionProvider>
        <SettingsPage title="Budget" onClose={vi.fn()} covered>
          <p>body</p>
        </SettingsPage>
      </MotionProvider>,
    );
    expect(screen.getByRole("banner")).toHaveAttribute("inert");
  });
});
