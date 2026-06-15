import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Pill } from "./Pill";

describe("Pill", () => {
  it("renders its label with a tone class", () => {
    const { container } = render(<Pill tone="warn">Needs review</Pill>);
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("text-warn");
  });
});
