// frontend/src/components/transactions/merchantRename.ts
//
// Pure decision logic for the rename-merchant flow. A rename writes
// `display_name` onto the rule the transaction listing resolves clean-names
// from, so it must pick the SAME rule the backend picks: the highest-priority
// (lowest number, then lowest id) ACTIVE exact/contains rule matching the raw
// merchant, case-insensitively (internal/store/categories.go's display-name
// subquery / categorize.ruleMatches). Regex rules never carry a clean-name.
//
// Framework-free and tested; lives beside the sheet because piece 6 owns only
// lib/txSplit.ts in lib/ — fold into lib/ at integration if it grows shared.
import type { Rule, Txn } from "../../api/types";
import type { TxnDepth, TxnSplit } from "../../lib/txSplit";

/** Rule as the v3 payload decorates it (DisplayName absent pre-integration). */
export interface DepthRule extends Rule {
  DisplayName?: string;
}

/** Case-insensitive exact/contains match, mirroring the backend. Regex rules
 *  can't resolve a display name server-side, so they never match here. */
export function ruleMatchesMerchant(rule: DepthRule, merchant: string): boolean {
  if (!rule.Pattern || !merchant) return false;
  const m = merchant.toLowerCase();
  const p = rule.Pattern.toLowerCase();
  if (rule.MatchType === "exact") return m === p;
  if (rule.MatchType === "contains") return m.includes(p);
  return false;
}

/**
 * The rule a rename should write onto: first active exact/contains match by
 * (priority asc, id asc) — the same ordering the listing resolves display
 * names with, so the written name is guaranteed to be the one that shows.
 */
export function matchingRule(rules: DepthRule[], merchant: string): DepthRule | null {
  let best: DepthRule | null = null;
  for (const r of rules) {
    if (!r.IsActive || !ruleMatchesMerchant(r, merchant)) continue;
    if (!best || r.Priority < best.Priority || (r.Priority === best.Priority && r.ID < best.ID)) {
      best = r;
    }
  }
  return best;
}

/** The category of a split parent's largest line (ties → first line), mirroring
 *  the backend's refund-link precedent. Null when there are no lines. */
export function largestSplitCategory(splits: TxnSplit[] | undefined): number | null {
  let best: TxnSplit | null = null;
  for (const s of splits ?? []) {
    if (!best || s.AmountFils > best.AmountFils) best = s;
  }
  return best ? best.CategoryID : null;
}

export type RenameTarget =
  | { kind: "rule"; rule: DepthRule }
  | { kind: "create"; categoryId: number }
  | { kind: "blocked" };

/**
 * Where a rename for this transaction's merchant would land: an existing
 * matching rule; a new contains-rule (needs a category — the transaction's
 * own, else its largest split line's); or nowhere yet (uncategorized with no
 * rule — categorize first, the write-back rule will carry the name).
 */
export function renameTarget(rules: DepthRule[], txn: TxnDepth): RenameTarget {
  const rule = matchingRule(rules, txn.MerchantRaw);
  if (rule) return { kind: "rule", rule };
  const categoryId = txn.CategoryID ?? largestSplitCategory(txn.Splits);
  if (categoryId != null) return { kind: "create", categoryId };
  return { kind: "blocked" };
}

/**
 * How many loaded transactions the rename will re-label. Against an existing
 * rule, everything that rule matches; on the create path, everything the
 * would-be contains-rule (pattern = this merchant string) matches.
 */
export function affectedCount(txns: Txn[], target: RenameTarget, merchant: string): number {
  const probe: DepthRule =
    target.kind === "rule"
      ? target.rule
      : { ID: 0, MatchType: "contains", Pattern: merchant, CategoryID: 0, Priority: 100, Source: "manual", IsActive: true };
  let n = 0;
  for (const t of txns) {
    if (ruleMatchesMerchant(probe, t.MerchantRaw)) n++;
  }
  return n;
}
