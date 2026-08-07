import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MotionProvider } from "../../app/MotionProvider";
import { ComparativeSummary } from "./ComparativeSummary";
import type { BucketDelta, InsightsBucket } from "../../v2/sources/insights";

const wrap = (ui: React.ReactNode) => render(<MotionProvider>{ui}</MotionProvider>);

function bucket(name: InsightsBucket, spent: bigint, prevSpent: bigint): BucketDelta {
  return {
    key: name,
    name,
    bucket: name,
    spent,
    prevSpent,
    delta: spent - prevSpent,
    deltaPct: prevSpent === 0n ? null : Number(spent - prevSpent) / Number(prevSpent),
    isNew: prevSpent === 0n && spent > 0n,
    isGone: spent === 0n && prevSpent > 0n,
  };
}

const buckets = [
  bucket("need", 400000n, 380000n),
  bucket("want", 210000n, 240000n),
  bucket("saving", 90000n, 80000n),
];

describe("ComparativeSummary", () => {
  it("renders the focus label, note, net, savings rate and bucket rows", () => {
    wrap(<ComparativeSummary label="Jun 2026" note="latest in range" net={120000n} savingsRate={0.18} buckets={buckets} />);
    expect(screen.getByText("Jun 2026")).toBeInTheDocument();
    expect(screen.getByText("latest in range")).toBeInTheDocument();
    expect(screen.getByText("1,200.00")).toBeInTheDocument();
    expect(screen.getByText("18%")).toBeInTheDocument();
    expect(screen.getByText("Needs")).toBeInTheDocument();
    expect(screen.getByText("Wants")).toBeInTheDocument();
    expect(screen.getByText("Savings & debt")).toBeInTheDocument();
  });

  it("names the uncategorized remainder rather than leaving it out of the split", () => {
    wrap(
      <ComparativeSummary
        label="Jun 2026"
        note=""
        net={0n}
        savingsRate={null}
        buckets={[...buckets, bucket("unassigned", 5000n, 0n)]}
      />,
    );
    expect(screen.getByText("Uncategorized")).toBeInTheDocument();
    expect(screen.getByText("50.00")).toBeInTheDocument();
  });

  it("shows an em dash for savings rate when there is no income to divide by", () => {
    wrap(<ComparativeSummary label="Jun 2026" note="" net={-5000n} savingsRate={null} buckets={buckets} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("keeps a net past 2^53 exact", () => {
    wrap(<ComparativeSummary label="Jun 2026" note="" net={9007199254740993n} savingsRate={null} buckets={buckets} />);
    expect(screen.getByText("90,071,992,547,409.93")).toBeInTheDocument();
  });

  it("fires onSelectBucket with the bucket that was tapped", () => {
    const onSelectBucket = vi.fn();
    wrap(<ComparativeSummary label="June 2026" note="" net={1500n} savingsRate={0.2} buckets={buckets} onSelectBucket={onSelectBucket} />);
    fireEvent.click(screen.getByRole("button", { name: /See Needs transactions/ }));
    expect(onSelectBucket).toHaveBeenCalledWith(buckets[0]);
  });
});
