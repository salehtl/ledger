// frontend/src/lib/reviewMeta.ts
// Pure helpers describing where a review-queue transaction came from: which
// account it moved on, and why it needs a human look at all.

import type { Txn } from "../api/types";

/** Confidence at or above this means a per-bank template parsed the email
 *  exactly; below it the fields came from the heuristic or AI tier. */
const TEMPLATE_CONFIDENCE = 0.9;

/** Account chip text: the registered account's name when the last4 is known,
 *  a masked "···1234" otherwise, null when the email carried no digits. */
export function accountLabel(t: Txn): string | null {
  if (t.AccountName) return t.AccountName;
  if (t.Last4) return `···${t.Last4}`;
  return null;
}

/** One short line explaining why this transaction is in the review queue. */
export function reviewReason(t: Txn): string {
  switch (t.Source) {
    case "import":
      return "Imported from a file";
    case "manual":
      return "Added manually";
    default:
      return t.Confidence >= TEMPLATE_CONFIDENCE
        ? "New merchant"
        : "Auto-read from the email — double-check";
  }
}
