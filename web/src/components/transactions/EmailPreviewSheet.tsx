import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../../api/client";
import type { TransactionEmail, Txn } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { PixelSpinner } from "../ui/PixelSpinner";

export function EmailPreviewSheet({ txn, onClose }: { txn: Txn; onClose: () => void }) {
  const email = useQuery({
    queryKey: ["transaction-email", txn.ID],
    queryFn: () => getJSON<TransactionEmail>(`/api/transactions/${txn.ID}/email`),
    retry: false,
  });

  return (
    <Dialog title="Source email" onClose={onClose}>
      {email.isPending ? (
        <div className="flex justify-center py-10"><PixelSpinner role="status" aria-label="Loading source email" /></div>
      ) : email.isError ? (
        <p role="status" className="text-sm text-muted py-4">No source email is available for this transaction.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted">From</dt><dd className="min-w-0 break-words">{email.data.from || "—"}</dd>
            <dt className="text-muted">Subject</dt><dd className="min-w-0 break-words">{email.data.subject || "—"}</dd>
          </dl>
          <pre className="max-h-[55dvh] overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-[var(--radius)] bg-surface-2 p-3 font-mono text-xs leading-relaxed text-fg">{email.data.body}</pre>
        </div>
      )}
    </Dialog>
  );
}
