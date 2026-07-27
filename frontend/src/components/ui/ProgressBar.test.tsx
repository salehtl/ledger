import { render, screen } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("clamps width to 0..100 and sets aria-valuenow", () => {
    const { getByRole } = render(<ProgressBar pct={1.4} />);
    const bar = getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    const fill = bar.firstChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("a bucket under budget renders a dithered fill", () => {
    render(<ProgressBar pct={0.5} label="Needs" />);
    const fill = screen.getByRole("progressbar").querySelector("[data-fill]");
    expect(fill).toHaveAttribute("data-fill", "dithered");
  });

  it("a bucket at or over budget fills solid — over is a texture change, not a colour change", () => {
    render(<ProgressBar pct={1.12} label="Wants" />);
    const fill = screen.getByRole("progressbar").querySelector("[data-fill]");
    expect(fill).toHaveAttribute("data-fill", "solid");
  });

  it("an explicit tone still overrides the automatic one — tone='bad' forces solid", () => {
    render(<ProgressBar pct={0.2} label="Saving" tone="bad" />);
    const fill = screen.getByRole("progressbar").querySelector("[data-fill]");
    expect(fill).toHaveAttribute("data-fill", "solid");
  });

  it("an explicit tone can override auto-bad back to dithered — tone='good' forces dithered even at high pct", () => {
    render(<ProgressBar pct={1.5} label="Projection" tone="good" />);
    const fill = screen.getByRole("progressbar").querySelector("[data-fill]");
    expect(fill).toHaveAttribute("data-fill", "dithered");
  });

  it("draws a pace marker at the given fraction", () => {
    const { getByRole } = render(<ProgressBar pct={0.6} pace={0.5} />);
    const marker = getByRole("progressbar").querySelector("[data-pace]") as HTMLElement;
    expect(marker).not.toBeNull();
    expect(marker.style.left).toBe("50%");
  });

  it("uses a translucent track on accent surfaces", () => {
    const { getByRole } = render(<ProgressBar pct={0.5} onAccent />);
    expect((getByRole("progressbar") as HTMLElement).className).toContain("bg-hero-fg/25");
  });

  it("onAccent never hardcodes white — the hero panel inverts between themes, so a literal bg-white fill is invisible in dark", () => {
    const { getByRole } = render(<ProgressBar pct={0.6} pace={0.5} onAccent />);
    const bar = getByRole("progressbar") as HTMLElement;
    const fill = bar.querySelector("[data-fill]") as HTMLElement;
    const marker = bar.querySelector("[data-pace]") as HTMLElement;
    for (const el of [bar, fill, marker]) {
      expect(el.className).not.toMatch(/bg-white\b/);
    }
    expect(bar.className).toContain("bg-hero-fg/25");
    expect(fill.className).toContain("bg-hero-fg");
    expect(marker.className).toContain("bg-hero-fg");
  });

  it("the non-accent (default) variant is unchanged by the onAccent fix", () => {
    const { getByRole } = render(<ProgressBar pct={0.6} pace={0.5} />);
    const bar = getByRole("progressbar") as HTMLElement;
    const fill = bar.querySelector("[data-fill]") as HTMLElement;
    const marker = bar.querySelector("[data-pace]") as HTMLElement;
    expect(bar.className).toContain("bg-surface-2");
    expect(fill.className).toContain("bg-fg");
    expect(marker.className).toContain("bg-fg/70");
  });

  it("paints the fill in the given hue instead of the default ink", () => {
    const { getByRole } = render(<ProgressBar pct={0.5} color="amber" label="Needs" />);
    const fill = getByRole("progressbar").querySelector("[data-fill]") as HTMLElement;
    expect(fill.style.background).toBe("var(--color-amber)");
    expect(fill.className).not.toContain("bg-fg");
  });

  it("keeps the default ink when no hue is given", () => {
    const { getByRole } = render(<ProgressBar pct={0.5} label="Needs" />);
    const fill = getByRole("progressbar").querySelector("[data-fill]") as HTMLElement;
    expect(fill.className).toContain("bg-fg");
    expect(fill.style.background).toBe("");
  });

  it("onAccent overrides a hue — the hero totals all three buckets, so no single bucket hue is honest for it, and mid-chroma ink on the accent ground is a contrast problem", () => {
    const { getByRole } = render(<ProgressBar pct={0.5} color="amber" onAccent />);
    const fill = getByRole("progressbar").querySelector("[data-fill]") as HTMLElement;
    expect(fill.style.background).toBe("");
    expect(fill.className).toContain("bg-hero-fg");
  });

  it("a hue still goes solid at or over budget — over is a texture change, not a colour change", () => {
    const { getByRole } = render(<ProgressBar pct={1.2} color="lilac" label="Wants" />);
    const fill = getByRole("progressbar").querySelector("[data-fill]") as HTMLElement;
    expect(fill).toHaveAttribute("data-fill", "solid");
    expect(fill.className).not.toContain("dither-mask");
    expect(fill.style.background).toBe("var(--color-lilac)");
  });
});
