import { render } from "@testing-library/react";
import { DitherFill } from "./DitherFill";

describe("DitherFill", () => {
  it("renders a canvas", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "blue" }]} max={100} />,
    );
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("is hidden from assistive tech — callers state the numbers in text", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "blue" }]} max={100} />,
    );
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("survives a zero max without dividing by zero", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 0, color: "blue" }]} max={0} />,
    );
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("survives an empty segment list", () => {
    const { container } = render(<DitherFill segments={[]} max={100} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("defaults bloom off — the aura is clipped by the wrapper at these heights", () => {
    // ~20 of these live in a scrolling LensBreakdown; a blurred, plus-lighter
    // blended layer per row is real compositing cost for a glow the
    // overflow-hidden wrapper crops away.
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "blue" }]} max={100} />,
    );
    const bloom = container.querySelectorAll("canvas")[1] as HTMLCanvasElement;
    expect(bloom.style.opacity).toBe("0");
    expect(bloom.style.filter).toBe("");
    expect(bloom.style.mixBlendMode).toBe("");
  });

  it("still honours an explicit bloom opt-in", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "blue" }]} max={100} bloom="aura" />,
    );
    const bloom = container.querySelectorAll("canvas")[1] as HTMLCanvasElement;
    expect(bloom.style.filter).toContain("blur");
  });

  it("applies the requested height", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 1, color: "green" }]} max={1} height={12} />,
    );
    expect(container.firstElementChild).toHaveStyle({ height: "12px" });
  });
});
