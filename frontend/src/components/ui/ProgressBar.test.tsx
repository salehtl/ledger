import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("clamps width to 0..100 and sets aria-valuenow", () => {
    const { getByRole } = render(<ProgressBar pct={1.4} />);
    const bar = getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    const fill = bar.firstChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });
  it("uses the bad tone at/over 100%", () => {
    const { getByRole } = render(<ProgressBar pct={1.0} />);
    expect((getByRole("progressbar").firstChild as HTMLElement).className).toContain("bg-bad");
  });
  it("honors a tone override", () => {
    const { getByRole } = render(<ProgressBar pct={0.1} tone="warn" />);
    expect((getByRole("progressbar").firstChild as HTMLElement).className).toContain("bg-warn");
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
