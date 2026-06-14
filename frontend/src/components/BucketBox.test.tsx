import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BucketBox, barColor } from "./BucketBox";

describe("barColor", () => {
  it("greens under 0.8, ambers under 1.0, reds at/over 1.0", () => {
    expect(barColor(0.5)).toBe("bar-green");
    expect(barColor(0.85)).toBe("bar-amber");
    expect(barColor(1.2)).toBe("bar-red");
  });
});

describe("BucketBox", () => {
  it("renders the bucket label and spent/target", () => {
    render(<BucketBox b={{ bucket: "need", target: 100000, spent: 50000, remaining: 50000, pct_used: 0.5, projection: 100000 }} />);
    expect(screen.getByText(/needs/i)).toBeInTheDocument();
  });
});
