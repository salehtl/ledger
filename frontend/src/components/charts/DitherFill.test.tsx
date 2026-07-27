import { render } from "@testing-library/react";
import { DitherFill } from "./DitherFill";

describe("DitherFill", () => {
  it("renders no canvas — a flat rectangle of one hue never needed one", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "azure" }]} max={100} />,
    );
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("is hidden from assistive tech — callers state the numbers in text", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 50, color: "azure" }]} max={100} />,
    );
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("paints each segment in its own hue", () => {
    const { container } = render(
      <DitherFill
        segments={[
          { value: 50, color: "amber" },
          { value: 30, color: "lilac" },
        ]}
        max={100}
      />,
    );
    const fills = container.querySelectorAll("[data-fill]");
    expect(fills).toHaveLength(2);
    expect((fills[0] as HTMLElement).style.background).toBe("var(--color-amber)");
    expect((fills[1] as HTMLElement).style.background).toBe("var(--color-lilac)");
  });

  it("sizes each segment by its share of max, leaving the remainder as track", () => {
    const { container } = render(
      <DitherFill
        segments={[
          { value: 50, color: "amber" },
          { value: 30, color: "lilac" },
        ]}
        max={100}
      />,
    );
    const fills = container.querySelectorAll("[data-fill]");
    expect((fills[0] as HTMLElement).style.width).toBe("50%");
    expect((fills[1] as HTMLElement).style.width).toBe("30%");
  });

  it("segments summing to max fill the bar exactly — no sliver of track at the end", () => {
    // segmentBounds rounds cumulative positions rather than each segment's own
    // share, so rounding-down cannot accumulate into a visible gap.
    const { container } = render(
      <DitherFill
        segments={[
          { value: 1, color: "amber" },
          { value: 1, color: "lilac" },
          { value: 1, color: "sage" },
        ]}
        max={3}
      />,
    );
    const total = [...container.querySelectorAll("[data-fill]")]
      .reduce((sum, el) => sum + parseFloat((el as HTMLElement).style.width), 0);
    expect(total).toBe(100);
  });

  it("dots by default and goes solid when a segment is over budget", () => {
    const { container } = render(
      <DitherFill
        segments={[
          { value: 50, color: "amber" },
          { value: 30, color: "lilac", density: "solid" },
        ]}
        max={100}
      />,
    );
    const fills = container.querySelectorAll("[data-fill]");
    expect(fills[0]).toHaveAttribute("data-fill", "dithered");
    expect(fills[0].className).toContain("dither-mask");
    expect(fills[1]).toHaveAttribute("data-fill", "solid");
    expect(fills[1].className).not.toContain("dither-mask");
  });

  it("survives a zero max without dividing by zero", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 0, color: "azure" }]} max={0} />,
    );
    expect((container.querySelector("[data-fill]") as HTMLElement).style.width).toBe("0%");
  });

  it("survives an empty segment list", () => {
    const { container } = render(<DitherFill segments={[]} max={100} />);
    expect(container.querySelectorAll("[data-fill]")).toHaveLength(0);
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it("applies the requested height", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 1, color: "sage" }]} max={1} height={12} />,
    );
    expect(container.firstElementChild).toHaveStyle({ height: "12px" });
  });
});
