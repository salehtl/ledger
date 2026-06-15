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
});
