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

  it("applies the requested height", () => {
    const { container } = render(
      <DitherFill segments={[{ value: 1, color: "green" }]} max={1} height={12} />,
    );
    expect(container.firstElementChild).toHaveStyle({ height: "12px" });
  });
});
