import { render } from "@testing-library/react";
import { ColorSwatch } from "./ColorSwatch";

const swatch = (c: HTMLElement) => c.querySelector("[data-swatch]") as HTMLElement;

describe("ColorSwatch", () => {
  it("hatches the box in the project hue, not just outlines it", () => {
    const { container } = render(<ColorSwatch color="azure" />);
    const el = swatch(container);
    expect(el.style.borderColor).toBe("var(--color-azure)");
    // The hue must appear *inside* the box too — an outline alone left the
    // mark reading as a grey box at 10px.
    expect(el.style.backgroundImage).toContain("repeating-linear-gradient");
    expect(el.style.backgroundImage).toContain("var(--color-azure)");
  });

  it("resolves an unknown or missing colour through projectColor's neutral fallback", () => {
    const { container } = render(<ColorSwatch color={null} />);
    const el = swatch(container);
    expect(el.style.borderColor).toBe("var(--color-slate)");
    expect(el.style.backgroundImage).toContain("var(--color-slate)");
  });

  it("passes a legacy stored hex through unchanged", () => {
    const { container } = render(<ColorSwatch color="#1660a0" />);
    expect(swatch(container).style.borderColor).toBe("rgb(22, 96, 160)");
  });

  it("tightens the hatch pitch on the small size so both keep visible lines", () => {
    const md = render(<ColorSwatch color="sage" />);
    expect(swatch(md.container).style.backgroundImage).toContain("1px 3px");
    md.unmount();
    const sm = render(<ColorSwatch color="sage" size="sm" />);
    expect(swatch(sm.container).style.backgroundImage).toContain("1px 2px");
  });

  it("is decorative — every call site prints the project name beside it", () => {
    const { container } = render(<ColorSwatch color="rose" />);
    expect(swatch(container)).toHaveAttribute("aria-hidden");
  });
});
