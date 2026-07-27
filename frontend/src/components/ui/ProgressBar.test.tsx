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
    expect((getByRole("progressbar") as HTMLElement).className).toContain("bg-white/25");
  });
});
