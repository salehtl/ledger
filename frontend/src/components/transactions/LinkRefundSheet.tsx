// frontend/src/components/transactions/LinkRefundSheet.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PixelSpinner } from "../ui/PixelSpinner";
import { getRefundCandidates, linkRefund } from "../../api/client";
import type { Txn } from "../../api/types";
import { Dialog, DialogFooter } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Pressable } from "../ui/Pressable";
import { Money } from "../Money";
import { aedFils, nativeAmountTag } from "../../lib/money";

/** Pick the original purchase a refund credit belongs to. Linking copies the
 *  purchase's category onto the credit so it offsets that category instead of
 *  looking like income. */
export function LinkRefundSheet({ txn, onLinked, onClose }: {
  txn: Txn;
  onLinked: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = useQuery({
    queryKey: ["refund-candidates", txn.ID],
    queryFn: () => getRefundCandidates(txn.ID),
  });

  const pick = async (target: Txn) => {
    setBusy(true);
    setError("");
    try {
      await linkRefund(txn.ID, target.ID);
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't link refund");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Link refund" onClose={onClose}>
      <p className="text-sm text-muted mb-3">
        {txn.MerchantRaw || "—"} · <Money fils={aedFils(txn) ?? txn.AmountFils} />
        {" — pick the purchase this refunds."}
      </p>
      {candidates.isPending && (
        <div className="flex justify-center py-8">
          <PixelSpinner size={24} role="status" aria-label="Loading" className="text-muted" />
        </div>
      )}
      {candidates.isError && <p className="text-sm text-bad py-4">Couldn't load purchases.</p>}
      {candidates.data && candidates.data.length === 0 && (
        <p className="text-sm text-muted py-4">
          No categorized purchases found in the 90 days before this credit.
        </p>
      )}
      {candidates.data && candidates.data.length > 0 && (
        <ul className="divide-y divide-border">
          {candidates.data.map((c) => (
            <li key={c.ID}>
              <Pressable
                disabled={busy}
                className="w-full min-h-11 text-left py-2.5 flex items-center justify-between gap-3 disabled:opacity-50"
                onClick={() => pick(c)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.MerchantRaw || "—"}</span>
                  <span className="block text-xs text-muted truncate">
                    {c.PostedAt.slice(0, 10)} · {c.CategoryName}
                    {nativeAmountTag(c) ? ` · ${nativeAmountTag(c)}` : ""}
                  </span>
                </span>
                <span className="shrink-0 tnum"><Money fils={-(aedFils(c) ?? c.AmountFils)} /></span>
              </Pressable>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-bad mt-2">{error}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </DialogFooter>
    </Dialog>
  );
}
