import { describe, it, expect } from "vitest";
import {
  budgetSplitLabel,
  categorizationSummary,
  currenciesLabel,
  fontScaleLabel,
  swipeSummary,
} from "./settingsSummary";
import type { AppSettings, BudgetConfig, RatesResponse } from "../api/types";

const budget = (over: Partial<BudgetConfig> = {}): BudgetConfig => ({
  monthly_income: 0,
  need_pct: 0.5,
  want_pct: 0.3,
  saving_pct: 0.2,
  income_source: "",
  freeze_history: false,
  ...over,
});

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  auto_categorize: true,
  ai_enabled: false,
  ai_auto_accept: false,
  ai_threshold: 0.8,
  ingest_silence_days: 3,
  ...over,
});

describe("budgetSplitLabel", () => {
  it("formats the standard split as whole percents", () => {
    expect(budgetSplitLabel(budget())).toBe("50/30/20");
  });
  it("rounds fractional percents", () => {
    expect(budgetSplitLabel(budget({ need_pct: 0.555, want_pct: 0.245, saving_pct: 0.2 }))).toBe("56/25/20");
  });
});

describe("categorizationSummary", () => {
  it("is Off when auto-categorize is off", () => {
    expect(categorizationSummary(settings({ auto_categorize: false }))).toBe("Off");
    // AI on but auto-categorize off still reads Off — nothing runs automatically.
    expect(categorizationSummary(settings({ auto_categorize: false, ai_enabled: true }))).toBe("Off");
  });
  it("is On with rules only", () => {
    expect(categorizationSummary(settings())).toBe("On");
  });
  it("notes AI when enabled", () => {
    expect(categorizationSummary(settings({ ai_enabled: true }))).toBe("On · AI");
  });
});

describe("currenciesLabel", () => {
  const rates = (codes: string[], missing: string[] = []): RatesResponse => ({
    rates: codes.map((c) => ({ currency: c, rate: 1, updated_at: "" })),
    missing,
  });
  it("is None when no rates are configured", () => {
    expect(currenciesLabel(rates([]))).toBe("None");
  });
  it("lists up to two codes", () => {
    expect(currenciesLabel(rates(["AED", "USD"]))).toBe("AED · USD");
  });
  it("collapses the remainder into a +N", () => {
    expect(currenciesLabel(rates(["AED", "USD", "EUR", "GBP"]))).toBe("AED · USD +2");
  });
  it("flags a missing rate even when some are configured", () => {
    expect(currenciesLabel(rates(["AED"], ["USD"]))).toBe("AED · 1 missing");
  });
  it("flags missing rates when none are configured", () => {
    expect(currenciesLabel(rates([], ["USD", "EUR"]))).toBe("2 missing");
  });
});

describe("swipeSummary", () => {
  it("shows the fixed horizontal directions", () => {
    expect(swipeSummary()).toBe("← Want · → Need");
  });
});

describe("fontScaleLabel", () => {
  it("names the default scale", () => {
    expect(fontScaleLabel(100)).toBe("Default");
  });
  it("shows reduced scales as percentages", () => {
    expect(fontScaleLabel(90)).toBe("90%");
  });
});
