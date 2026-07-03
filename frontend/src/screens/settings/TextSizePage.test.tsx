import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TextSizePage } from "./TextSizePage";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("font-size");
});

describe("TextSizePage", () => {
  it("renders every scale option with the current one selected", () => {
    render(<TextSizePage onClose={() => {}} />);
    for (const label of ["80%", "85%", "90%", "95%", "100%"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "100%" })).toHaveAttribute("aria-pressed", "true");
  });

  it("applies and persists a selected scale immediately", () => {
    render(<TextSizePage onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "90%" }));
    expect(document.documentElement.style.fontSize).toBe("90%");
    expect(localStorage.getItem("ledger-font-scale")).toBe("90");
    expect(screen.getByRole("button", { name: "90%" })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers reset only when off the default, and reset clears the override", () => {
    render(<TextSizePage onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /reset to default/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "80%" }));
    fireEvent.click(screen.getByRole("button", { name: /reset to default/i }));
    expect(document.documentElement.style.fontSize).toBe("");
    expect(localStorage.getItem("ledger-font-scale")).toBe("100");
    expect(screen.getByRole("button", { name: "100%" })).toHaveAttribute("aria-pressed", "true");
  });
});
