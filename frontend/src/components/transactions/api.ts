// frontend/src/components/transactions/api.ts
//
// Piece-local data hooks for transaction depth (v3 piece 6): splits, notes,
// merchant clean-names. Endpoints per docs/v3/api-contract.md §6. Kept out of
// the shared api/client.ts on purpose — integration consolidates later.
//
// NOTE for integration: the contract defines how `display_name` is READ
// (resolved from the matching rule) but the backend ships no HTTP write path
// for it yet — store.SetRuleDisplayName exists unwired. The rename hook below
// writes `PUT /api/rules/{id}/display-name {"display_name": "..."}`, the
// shape that mirrors the existing PUT /api/rules/{id}/active and pairs with
// the existing store method; the backend must add that route for renames to
// land. Until then the sheet surfaces the failure honestly.
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../../api/client";
import type { SplitLineBody, TxnDepth } from "../../lib/txSplit";
import { matchingRule, renameTarget, type DepthRule } from "./merchantRename";

export type { DepthRule } from "./merchantRename";
export type { SplitLineBody, TxnDepth, TxnSplit } from "../../lib/txSplit";

/** Split lines move money between categories, so everything derived from
 *  category activity refetches — same set useTxnActions invalidates, plus
 *  envelopes (split lines feed envelope activity per the contract). */
function invalidateMoneyViews(qc: QueryClient) {
  for (const key of ["transactions", "summary", "review", "insights-categories", "insights-trend", "envelopes"]) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

/** PUT /api/transactions/{id}/splits — replace-set; [] un-splits. */
export function useSaveSplits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ txnId, splits }: { txnId: number; splits: SplitLineBody[] }) =>
      postJSON(`/api/transactions/${txnId}/splits`, { splits }, "PUT"),
    onSuccess: () => invalidateMoneyViews(qc),
  });
}

/** PUT /api/transactions/{id}/note — user memo; "" clears. */
export function useSaveNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ txnId, note }: { txnId: number; note: string }) =>
      postJSON(`/api/transactions/${txnId}/note`, { note }, "PUT"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
}

/** GET /api/rules — for resolving the rename target. Fetched lazily so the
 *  list screen never pays for it until a rename sheet opens. */
export function useRules(enabled: boolean) {
  return useQuery({
    queryKey: ["rules"],
    queryFn: () => getJSON<DepthRule[]>("/api/rules"),
    enabled,
  });
}

/**
 * The composed rename write. With a matching rule, one PUT lands the name on
 * it. With none (categorized txn, or split parent via its largest line), the
 * rename itself becomes the write-back: create the contains-rule the
 * categorizer would have written, re-list to find its id (POST /api/rules
 * returns no id), then PUT the name onto it.
 */
export async function renameMerchant(txn: TxnDepth, rules: DepthRule[], name: string): Promise<void> {
  const target = renameTarget(rules, txn);
  if (target.kind === "blocked") {
    throw new Error("no rule to carry the name");
  }
  let ruleId: number;
  if (target.kind === "rule") {
    ruleId = target.rule.ID;
  } else {
    await postJSON("/api/rules", {
      match_type: "contains",
      pattern: txn.MerchantRaw,
      category_id: target.categoryId,
      priority: 100,
    });
    const fresh = await getJSON<DepthRule[]>("/api/rules");
    const created = fresh
      .filter((r) => r.MatchType === "contains" && r.Pattern === txn.MerchantRaw && r.CategoryID === target.categoryId)
      .reduce<DepthRule | null>((a, b) => (a && a.ID > b.ID ? a : b), null);
    if (!created) throw new Error("rule was not created");
    ruleId = created.ID;
  }
  await postJSON(`/api/rules/${ruleId}/display-name`, { display_name: name }, "PUT");
}

/** Mutation wrapper for renameMerchant with cache invalidation. */
export function useRenameMerchant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ txn, rules, name }: { txn: TxnDepth; rules: DepthRule[]; name: string }) =>
      renameMerchant(txn, rules, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
      qc.invalidateQueries({ queryKey: ["rules"] });
    },
  });
}

/** The display name a merchant currently resolves to from a rule set. */
export function currentDisplayName(rules: DepthRule[], merchant: string): string {
  const withName = rules.filter((r) => !!r.DisplayName);
  return matchingRule(withName, merchant)?.DisplayName ?? "";
}
