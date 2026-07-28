import { render, screen } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar";

const fillOf = (bar: HTMLElement) => bar.querySelector("[data-fill]") as HTMLElement;

describe("ProgressBar", () => {
  it("clamps width to 0..100 and sets aria-valuenow", () => {
    const { getByRole } = render(<ProgressBar pct={1.4} />);
    const bar = getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(fillOf(bar).style.width).toBe("100%");
  });

  it("prints ink dots while inside pace", () => {
    const { getByRole } = render(<ProgressBar pct={0.3} pace={0.5} label="Needs" />);
    const fill = fillOf(getByRole("progressbar"));
    expect(fill).toHaveAttribute("data-state", "under");
    expect(fill).toHaveAttribute("data-fill", "dithered");
    expect(fill.className).toContain("dither-mask");
    expect(fill.style.background).toBe("var(--color-pace-under)");
  });

  it("turns amber once past pace but still inside budget", () => {
    const { getByRole } = render(<ProgressBar pct={0.7} pace={0.5} label="Wants" />);
    const fill = fillOf(getByRole("progressbar"));
    expect(fill).toHaveAttribute("data-state", "over");
    expect(fill.style.background).toBe("var(--color-pace-over)");
  });

  it("turns red once past budget", () => {
    const { getByRole } = render(<ProgressBar pct={1.12} pace={0.5} label="Wants" />);
    const fill = fillOf(getByRole("progressbar"));
    expect(fill).toHaveAttribute("data-state", "overbudget");
    expect(fill.style.background).toBe("var(--color-pace-exceeded)");
  });

  it("stays dotted in every state — over is a colour change, not a texture change", () => {
    for (const pct of [0.3, 0.7, 1.4]) {
      const { getByRole, unmount } = render(<ProgressBar pct={pct} pace={0.5} />);
      const fill = fillOf(getByRole("progressbar"));
      expect(fill, `pct=${pct}`).toHaveAttribute("data-fill", "dithered");
      unmount();
    }
  });

  it("never reads over-pace without a pace — an open-ended project has nothing to be ahead of", () => {
    const { getByRole } = render(<ProgressBar pct={0.9} label="Trip" />);
    const fill = fillOf(getByRole("progressbar"));
    expect(fill).toHaveAttribute("data-state", "under");
    expect(fill.style.background).toBe("var(--color-pace-under)");
  });

  it("still reads over-budget without a pace", () => {
    const { getByRole } = render(<ProgressBar pct={1.05} label="Trip" />);
    expect(fillOf(getByRole("progressbar"))).toHaveAttribute("data-state", "overbudget");
  });

  it("an explicit status overrides the geometric reading", () => {
    // Home passes its run-rate verdict so the bar agrees with the label beside it.
    const { getByRole } = render(<ProgressBar pct={0.2} pace={0.5} status="over" label="Saving" />);
    const fill = fillOf(getByRole("progressbar"));
    expect(fill).toHaveAttribute("data-state", "over");
    expect(fill.style.background).toBe("var(--color-pace-over)");
  });

  it("an explicit status can pull a high pct back to under", () => {
    const { getByRole } = render(<ProgressBar pct={1.5} status="under" label="Projection" />);
    expect(fillOf(getByRole("progressbar"))).toHaveAttribute("data-state", "under");
  });

  it("draws a pace marker at the given fraction", () => {
    const { getByRole } = render(<ProgressBar pct={0.6} pace={0.5} />);
    const marker = getByRole("progressbar").querySelector("[data-pace]") as HTMLElement;
    expect(marker).not.toBeNull();
    expect(marker.style.left).toBe("50%");
  });

  it("omits the marker when no pace is given", () => {
    const { getByRole } = render(<ProgressBar pct={0.6} />);
    expect(getByRole("progressbar").querySelector("[data-pace]")).toBeNull();
  });

  it("uses a translucent track on accent surfaces", () => {
    const { getByRole } = render(<ProgressBar pct={0.5} onAccent />);
    expect((getByRole("progressbar") as HTMLElement).className).toContain("bg-hero-fg/25");
  });

  it("onAccent never hardcodes white — the hero panel inverts between themes, so a literal bg-white fill is invisible in dark", () => {
    const { getByRole } = render(<ProgressBar pct={0.6} pace={0.5} onAccent />);
    const bar = getByRole("progressbar") as HTMLElement;
    const marker = bar.querySelector("[data-pace]") as HTMLElement;
    for (const el of [bar, fillOf(bar), marker]) {
      expect(el.className).not.toMatch(/bg-white\b/);
    }
    expect(bar.className).toContain("bg-hero-fg/25");
    expect(fillOf(bar).className).toContain("bg-hero-fg");
    expect(marker.className).toContain("bg-hero-fg");
  });

  it("onAccent carries state as texture, not ink — neither pace hue clears 3:1 on the hero ground in both themes", () => {
    const over = render(<ProgressBar pct={0.7} pace={0.5} onAccent />);
    const overFill = fillOf(over.getByRole("progressbar"));
    expect(overFill.style.background).toBe("");
    expect(overFill).toHaveAttribute("data-fill", "dithered");
    over.unmount();

    render(<ProgressBar pct={1.2} pace={0.5} onAccent label="Total" />);
    const badFill = fillOf(screen.getByRole("progressbar"));
    expect(badFill.style.background).toBe("");
    expect(badFill).toHaveAttribute("data-fill", "solid");
    expect(badFill.className).not.toContain("dither-mask");
  });
});
