/**
 * The tooltip primitive's non-negotiables.
 *
 * The last assertion in this file is the one that matters most: a tip contains
 * no control. A tooltip is a dead end by design, so nothing important can hide
 * in one — and the way that rule dies is somebody adding "Learn more" to a tip
 * in six months. It fails here rather than in review.
 */

import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MotionProvider } from "../../app/MotionProvider";
import { InfoTip } from "./InfoTip";

function mount(children: React.ReactNode = "Held mail is filed under the domain that signed it.") {
  return render(
    <MotionProvider>
      <InfoTip about="held mail" testId="tip">
        {children}
      </InfoTip>
    </MotionProvider>,
  );
}

const trigger = () => screen.getByRole("button", { name: "About held mail" });

describe("the trigger", () => {
  it("is a real button that names what it explains, not 'info'", () => {
    mount();
    expect(trigger()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^info$/i })).toBeNull();
  });

  it("keeps a 44px touch target around a smaller glyph", () => {
    mount();
    // h-11/w-11 is the catalog's 44px. The glyph inside is 12px, which is the
    // point: the target is the rule, the drawing is not.
    expect(trigger().className).toMatch(/\bh-11\b/);
    expect(trigger().className).toMatch(/\bw-11\b/);
    expect(trigger().querySelector("svg")?.getAttribute("width")).toBe("12");
  });

  it("says whether it is open", async () => {
    const user = userEvent.setup();
    mount();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });
});

describe("opening and dismissing", () => {
  it("opens on tap, not on hover", async () => {
    const user = userEvent.setup();
    mount();
    await user.hover(trigger());
    expect(screen.queryByTestId("tip-panel")).toBeNull();
    await user.click(trigger());
    expect(await screen.findByTestId("tip-panel")).toBeInTheDocument();
  });

  it("dismisses on a second tap on the trigger", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(trigger());
    await screen.findByTestId("tip-panel");
    await user.click(trigger());
    await waitForGone();
  });

  it("dismisses on a tap outside", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(trigger());
    await screen.findByTestId("tip-panel");
    await user.click(document.body);
    await waitForGone();
  });

  it("dismisses on Escape", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(trigger());
    await screen.findByTestId("tip-panel");
    await user.keyboard("{Escape}");
    await waitForGone();
  });

  it("dismisses on a scroll, including one on an inner scroller", async () => {
    const user = userEvent.setup();
    // The app scrolls an inner <main>, whose scroll event does not bubble to
    // window — so the listener is registered in the capture phase, and this is
    // what proves it.
    const scroller = document.createElement("main");
    document.body.append(scroller);
    mount();
    await user.click(trigger());
    await screen.findByTestId("tip-panel");
    act(() => {
      scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    await waitForGone();
    scroller.remove();
  });
});

describe("a tip is a dead end", () => {
  /**
   * Asserted on the RENDERED TREE rather than on the props, so it survives a
   * child that renders a link two components deep.
   */
  it("contains no interactive element", async () => {
    const user = userEvent.setup();
    mount(
      <>
        A forwarding confirmation is signed by your mail provider, not your bank. Reading one does not file it.
      </>,
    );
    await user.click(trigger());
    const panel = await screen.findByTestId("tip-panel");
    expect(
      panel.querySelectorAll(
        'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]',
      ),
    ).toHaveLength(0);
  });
});

async function waitForGone(): Promise<void> {
  await expect
    .poll(() => screen.queryByTestId("tip-panel"), { timeout: 2000 })
    .toBeNull();
}
