import { render, screen } from "@testing-library/react";
import { ActiveBandHighlight } from "./ActiveBandHighlight";
import { bandCenters } from "../../lib/trendBars";

describe("ActiveBandHighlight", () => {
  it("renders nothing when there is no active index", () => {
    const { container } = render(<ActiveBandHighlight n={3} index={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the index is outside the series", () => {
    const { container } = render(<ActiveBandHighlight n={3} index={5} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("positions the highlight at the active band's center minus half its width", () => {
    render(<ActiveBandHighlight n={3} index={1} />);
    const centers = bandCenters(3);
    const el = screen.getByTestId("active-band-highlight");
    expect(el.style.left).toBe(`${(centers[1].center - centers[1].width / 2) * 100}%`);
    expect(el.style.width).toBe(`${centers[1].width * 100}%`);
  });
});
