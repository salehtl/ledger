import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider, type Persister } from "@tanstack/react-query-persist-client";
import { Home } from "./Home";
import type { Summary, CategorySpend, MonthlyTotal, Project } from "../api/types";

const summary: Summary = {
  period: "2026-06", income: 1500000, month_progress: 0.5,
  buckets: [
    { bucket: "need", target: 300000, spent: 210000, remaining: 90000, pct_used: 0.7, projection: 300000 },
    { bucket: "want", target: 200000, spent: 180000, remaining: 20000, pct_used: 0.9, projection: 240000 },
    { bucket: "saving", target: 100000, spent: 92000, remaining: 8000, pct_used: 0.92, projection: 100000 },
  ],
  project_excluded: 0,
  recent: [
    { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 1, CategoryName: "Groceries", Bucket: "need", Kind: "spending", BucketSnapshot: "" },
    { ID: 2, PostedAt: "2026-06-11", AmountFils: 1009, AmountAedFils: 3706, Currency: "USD", Direction: "debit", MerchantRaw: "NETFLIX", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "" },
    { ID: 3, PostedAt: "2026-06-12", AmountFils: 2412, AmountAedFils: null, Currency: "EUR", Direction: "debit", MerchantRaw: "BAHN.DE", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "" },
  ],
};
const cats: CategorySpend[] = [{ category_id: 1, name: "Groceries", bucket: "need", spent: 210000 }];
const trend: MonthlyTotal[] = [{ period: "2026-06", spent: 482000, income: 1500000 }];

// Mutable per-test: most tests want zero active projects (section absent);
// the Projects-section tests below populate this before rendering.
let projects: Project[] = [];

beforeEach(() => {
  projects = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/summary")) return new Response(JSON.stringify(summary));
    if (url.includes("/api/insights/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
    if (url.includes("/api/projects")) return new Response(JSON.stringify(projects));
    return new Response("[]");
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function wrap(props: Partial<Parameters<typeof Home>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Home {...props} /></QueryClientProvider>);
}

describe("Home", () => {
  it("shows the skeleton (not a crash) while the persisted cache is restoring", () => {
    // Under PersistQueryClientProvider, queries pause until restore completes:
    // isPending=true but isFetching=false, so v5's isLoading is false while
    // data is still undefined. The guard must hold in that window.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const neverRestores: Persister = {
      persistClient: () => {},
      restoreClient: () => new Promise(() => {}),
      removeClient: () => {},
    };
    render(
      <PersistQueryClientProvider client={qc} persistOptions={{ persister: neverRestores }}>
        <Home />
      </PersistQueryClientProvider>,
    );
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
  });

  it("shows the spent-this-month hero and budget", async () => {
    wrap();
    // 482000 fils => 4,820.00; 600000 => 6,000.00
    // findAllByText because the DonutChart center also renders the same value
    expect(await screen.findByText("Spent this month")).toBeInTheDocument();
    expect(screen.getAllByText(/4,820\.00/).length).toBeGreaterThan(0); // spent
    expect(screen.getByText(/6,000\.00/)).toBeInTheDocument(); // budget
  });

  it("surfaces pace: projection and an over-pace verdict", async () => {
    wrap();
    // projection 640000 > 600000 budget → over pace; want bucket also projects over
    expect((await screen.findAllByText("Over pace")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Projected/)).toBeInTheDocument();
    expect(screen.getByText(/50% of month gone/)).toBeInTheDocument();
  });

  it("lists the recent transactions", async () => {
    wrap();
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
  });

  it("shows AED-converted amounts with native tags in the recent list", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    // Converted foreign row: primary amount is the AED snapshot, native tag in the subtitle.
    expect(screen.getByText("−37.06")).toBeInTheDocument();
    expect(screen.getByText(/USD 10\.09/)).toBeInTheDocument();
    // Unconverted foreign row: native tag plus the no-rate note.
    expect(screen.getByText(/EUR 24\.12/)).toBeInTheDocument();
    expect(screen.getByText(/no AED rate/)).toBeInTheDocument();
  });

  it("aggregates over a multi-month range", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/api/summary")) return new Response(JSON.stringify(summary));
      if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
      return new Response("[]");
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Home scope={{ kind: "range", from: "2026-03", to: "2026-06" }} />
      </QueryClientProvider>,
    );
    // Hero reflects the span, and the summary request carries from/to so the
    // server sums every month rather than just the latest.
    expect(await screen.findByText(/Mar–Jun 2026/)).toBeInTheDocument();
    expect(calls.some((u) => u.includes("from=2026-03") && u.includes("to=2026-06"))).toBe(true);
    // Pace/projection stay scoped to the live current month, not a span.
    expect(screen.queryByText(/Projected/)).not.toBeInTheDocument();
  });

  it("shows a Projects section with active projects, opening a card and the All affordance", async () => {
    const onOpenProject = vi.fn();
    const onOpenProjects = vi.fn();
    projects = [
      {
        id: 7, name: "Kitchen reno", budget_fils: 1_000_000, color: "#1373d9",
        starts_on: "", ends_on: "", status: "active", count_in_monthly: false,
        completed_at: "", net_spent_fils: 400_000, pending_fils: 0, txn_count: 3,
      },
    ];
    wrap({ onOpenProject, onOpenProjects });

    expect(await screen.findByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Kitchen reno")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Kitchen reno"));
    expect(onOpenProject).toHaveBeenCalledWith(7);

    fireEvent.click(screen.getByText("All ›"));
    expect(onOpenProjects).toHaveBeenCalledTimes(1);
  });

  it("shows no Projects section when there are no active projects", async () => {
    wrap();
    // Wait for a settled render (recent list) so we know the projects query resolved too.
    await screen.findByText("SPINNEYS");
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
  });

  it("shows a budget reconciliation note when project spend is excluded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/summary")) return new Response(JSON.stringify({ ...summary, project_excluded: 123456 }));
      if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
      return new Response("[]");
    }));
    wrap();
    expect(await screen.findByText(/Excludes 1,234\.56 in project spend/)).toBeInTheDocument();
  });

  it("hides the budget reconciliation note when nothing is excluded", async () => {
    wrap();
    await screen.findByText("SPINNEYS");
    expect(screen.queryByText(/project spend/i)).not.toBeInTheDocument();
  });

  it("paints each bucket bar on the pace ramp, not in its bucket hue — hue is identity, the bar is state", async () => {
    // The swatch dot beside the label still carries the bucket's hue; the bar
    // carries the verdict, so the two are never competing signals.
    wrap();
    const fillOf = async (label: string) => {
      const bar = await screen.findByLabelText(label);
      return (bar.querySelector("[data-fill]") as HTMLElement).style.background;
    };
    // needs: projected exactly on target → under. wants: projected 2.4k over
    // a 2k target → over pace. savings: projected on target → under.
    expect(await fillOf("Needs budget used")).toBe("var(--color-pace-under)");
    expect(await fillOf("Wants budget used")).toBe("var(--color-pace-over)");
    expect(await fillOf("Savings budget used")).toBe("var(--color-pace-under)");
  });

  it("turns a bucket bar red once it is over budget", async () => {
    const blown = {
      ...summary,
      buckets: [{ bucket: "need", target: 300000, spent: 330000, remaining: -30000, pct_used: 1.1, projection: 400000 }],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/summary")) return new Response(JSON.stringify(blown));
      if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
      return new Response("[]");
    }));
    wrap();
    const bar = await screen.findByLabelText("Needs budget used");
    const fill = bar.querySelector("[data-fill]") as HTMLElement;
    expect(fill.style.background).toBe("var(--color-pace-exceeded)");
    // Red *dots*, not a solid bar — the texture is constant across the ramp.
    expect(fill).toHaveAttribute("data-fill", "dithered");
  });


  it("leaves the hero total bar monochrome — it sums all three buckets, so no single bucket hue is honest for it", async () => {
    wrap();
    const hero = await screen.findByLabelText("Total budget used");
    const fill = hero.querySelector("[data-fill]") as HTMLElement;
    expect(fill.style.background).toBe("");
    expect(fill.className).toContain("bg-hero-fg");
  });
});
