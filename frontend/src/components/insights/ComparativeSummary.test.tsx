import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

const buckets2 = [
  { bucket: "need", spent: 1000, prevSpent: 800, delta: 200 },
  { bucket: "want", spent: 500, prevSpent: 500, delta: 0 },
];
const savings2 = { net: 1500, rate: 0.2 } as any;

describe("ComparativeSummary onSelectBucket", () => {
  it("fires onSelectBucket when a bucket row is tapped", () => {
    const onSelectBucket = vi.fn();
    render(<ComparativeSummary label="June 2026" note="" net={1500} savings={savings2} buckets={buckets2 as any} onSelectBucket={onSelectBucket} />);
    fireEvent.click(screen.getByRole("button", { name: /Needs/ }));
    expect(onSelectBucket).toHaveBeenCalledWith("need");
  });
});
