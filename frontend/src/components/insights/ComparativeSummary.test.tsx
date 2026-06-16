import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComparativeSummary } from "./ComparativeSummary";

const buckets = [
  { bucket: "need", spent: 400000, prevSpent: 380000, delta: 20000 },
  { bucket: "want", spent: 210000, prevSpent: 240000, delta: -30000 },
  { bucket: "saving", spent: 90000, prevSpent: 80000, delta: 10000 },
];

describe("ComparativeSummary", () => {
  it("renders the focus label, note, savings rate and bucket rows", () => {
    render(<ComparativeSummary label="Jun 2026" note="latest in range" net={120000} savings={{ net: 120000, rate: 0.18 }} buckets={buckets} />);
    expect(screen.getByText("Jun 2026")).toBeInTheDocument();
    expect(screen.getByText("latest in range")).toBeInTheDocument();
    expect(screen.getByText("18%")).toBeInTheDocument();
    expect(screen.getByText("Needs")).toBeInTheDocument();
    expect(screen.getByText("Wants")).toBeInTheDocument();
    expect(screen.getByText("Savings")).toBeInTheDocument();
  });
  it("shows an em dash for savings rate when rate is null", () => {
    render(<ComparativeSummary label="Jun 2026" note="" net={-5000} savings={{ net: -5000, rate: null }} buckets={buckets} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
