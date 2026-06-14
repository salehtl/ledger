import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Icon } from "./Icon";

describe("Icon", () => {
  it("resolves a name to its png under /icons", () => {
    render(<Icon name="gear" alt="Settings" />);
    const img = screen.getByAltText("Settings") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/icons/gear.png");
  });
  it("maps aliases to the real filename", () => {
    render(<Icon name="transfer" alt="Transfer" />);
    expect((screen.getByAltText("Transfer") as HTMLImageElement).getAttribute("src"))
      .toBe("/icons/arrow-switch.png");
  });
  it("is decorative (aria-hidden) when alt is empty", () => {
    const { container } = render(<Icon name="chart" />);
    expect(container.querySelector("img")?.getAttribute("aria-hidden")).toBe("true");
  });
});
