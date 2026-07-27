import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PixelSpinner } from "./PixelSpinner";

const rects = (c: HTMLElement) => [...c.querySelectorAll<SVGRectElement>("rect")];

describe("PixelSpinner", () => {
  it("draws the ring on the pixel grid", () => {
    const { container } = render(<PixelSpinner />);
    const r = rects(container);
    expect(r).toHaveLength(8);
    // Every edge on an even coordinate, or the 2-unit grid lands a block edge
    // on a fractional device pixel and the pixel-art edges blur.
    for (const rect of r) {
      for (const attr of ["x", "y", "width", "height"]) {
        expect(Number(rect.getAttribute(attr)) % 2).toBe(0);
      }
    }
  });

  it("keeps pixel snapping even when the caller passes its own style", () => {
    // The caller's style object used to replace the component's, silently
    // dropping imageRendering.
    const { container } = render(<PixelSpinner style={{ opacity: 0.5 }} />);
    const svg = container.querySelector("svg")!;
    expect(svg.style.imageRendering).toBe("pixelated");
    expect(svg.style.opacity).toBe("0.5");
  });

  it("animates every block when indeterminate", () => {
    const { container } = render(<PixelSpinner />);
    expect(container.querySelectorAll(".pixel-spinner-cell")).toHaveLength(8);
  });

  it("holds still when given a progress value", () => {
    const { container } = render(<PixelSpinner progress={0.5} />);
    expect(container.querySelector(".pixel-spinner-cell")).toBeNull();
  });

  it("clamps progress rather than over- or under-filling the ring", () => {
    const lit = (p: number) => {
      const { container } = render(<PixelSpinner progress={p} />);
      return rects(container).filter((r) => r.getAttribute("opacity") === "1").length;
    };
    expect(lit(-5)).toBe(0);
    expect(lit(0)).toBe(0);
    expect(lit(1)).toBe(8);
    expect(lit(99)).toBe(8);
  });
});
