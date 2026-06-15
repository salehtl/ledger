import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title and hint", () => {
    render(<EmptyState icon="tick" title="All caught up" hint="Nothing to review" />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
    expect(screen.getByText("Nothing to review")).toBeInTheDocument();
  });
});
