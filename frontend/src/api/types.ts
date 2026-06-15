export interface Category { ID: number; Name: string; Kind: string; Bucket: string; IsActive: boolean; }
export interface Rule { ID: number; MatchType: string; Pattern: string; CategoryID: number; Priority: number; Source: string; IsActive: boolean; }
export interface AppSettings {
  auto_categorize: boolean;
  ai_enabled: boolean;
  ai_auto_accept: boolean;
  ai_threshold: number;
}
export interface Txn {
  ID: number; PostedAt: string; AmountFils: number; Currency: string;
  Direction: string; MerchantRaw: string; Status: string; Confidence: number; Source: string;
  CategoryID: number | null; CategoryName: string; Bucket: string;
}
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
