export interface Category { ID: number; Name: string; Kind: string; Bucket: string; IsActive: boolean; }
export interface Rule { ID: number; MatchType: string; Pattern: string; CategoryID: number; Priority: number; Source: string; IsActive: boolean; }
export interface AppSettings {
  auto_categorize: boolean;
  ai_enabled: boolean;
  ai_auto_accept: boolean;
  ai_threshold: number;
  ingest_silence_days: number;
  /** Read-only: whether an Anthropic key is loaded (env-only). Not sent on save. */
  ai_key_present?: boolean;
}
export interface Txn {
  ID: number; PostedAt: string; AmountFils: number; AmountAedFils: number | null; Currency: string;
  Direction: string; MerchantRaw: string; Status: string; Confidence: number; Source: string;
  CategoryID: number | null; CategoryName: string; Bucket: string;
  Kind: string; BucketSnapshot: string;
}
export interface FXRateDTO { currency: string; rate: number; updated_at: string; }
export interface RatesResponse { rates: FXRateDTO[]; missing: string[]; }
export interface BudgetConfig {
  monthly_income: number; need_pct: number; want_pct: number; saving_pct: number;
  income_source: string; freeze_history: boolean;
}
export interface BucketSummary {
  bucket: string; target: number; spent: number; remaining: number; pct_used: number; projection: number;
}
export interface Summary {
  period: string; income: number; month_progress: number; buckets: BucketSummary[]; recent: Txn[];
}
export interface CategorySpend { category_id: number; name: string; bucket: string; spent: number; }
export interface MonthlyTotal { period: string; spent: number; income: number; }
export interface CategoryUsage { transactions: number; rules: number; }
export interface CategorizeStatus { status: "idle" | "running"; processed: number; total: number; failed: number; error: string; }
export interface IngestHealth {
  configured: boolean;
  count: number;
  last_at?: string;
  status: "ok" | "warn" | "starting" | "off";
  reasons: string[];
  last_poll_success_at?: string;
  last_poll_attempt_at?: string;
  consecutive_failures: number;
  last_error?: string;
  poll_interval_seconds: number;
  silence_days: number;
}
export interface Health { status: string; db: string; ingest?: IngestHealth; }

export interface Account {
  id: number;
  name: string;
  bank: string;
  last4: string;
}

export interface SweepResult {
  marked: number;
}
