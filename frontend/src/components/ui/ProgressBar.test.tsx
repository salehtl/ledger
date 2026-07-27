import { render, screen } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
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

  it("an explicit tone still overrides the automatic one", () => {
    render(<ProgressBar pct={0.2} label="Saving" tone="bad" />);
    const fill = screen.getByRole("progressbar").querySelector("[data-fill]");
    expect(fill).toHaveAttribute("data-fill", "solid");
  });
});
