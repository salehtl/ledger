/**
 * Reading a held message, and typing the transaction it describes.
 *
 * # This screen shows attacker-controlled text. That is new.
 *
 * No screen in the app had ever rendered a held message body. The inbound
 * address is an unauthenticated write endpoint, so anyone who learns it can put
 * arbitrary text on this panel. Two rules follow, and neither is negotiable:
 *
 *  1. **The body is React text children.** No `dangerouslySetInnerHTML`, no
 *     markup, no link-ification, no images. `norm.normalize` has already stripped
 *     the HTML to text; what arrives here is a string, and React escapes it. A
 *     test asserts an injected `<script>` and an `<img onerror>` land as visible
 *     characters and create no elements.
 *  2. **Trust facts, not letterhead.** The heading is the verification state —
 *     "Unverified. Claims to be from x. Nothing checked this." — and the sender's
 *     own words appear only *below* it, in a quoted block, clearly the message's
 *     rather than the app's. A screen that showed the bank's name in a headline
 *     would be authenticating the sender with text the sender wrote.
 *
 * # The containment is honesty, not a filter
 *
 * This lane opens a social-engineering path: a stranger emails a plausible bank
 * alert hoping the user confirms it. What that buys them is a wrong row in the
 * user's own ledger. No money moves, nothing is sent anywhere, no sender is
 * trusted, and the row can be edited or superseded. So the defence is telling
 * the user exactly that, in the sentence above the form, rather than pretending
 * to a verification that does not exist.
 *
 * # It never promotes anything
 *
 * No `sender_allowlist` row, no confirmation call, no change to `Decide`. The
 * message stays held and expires on its own TTL. The only thing that leaves this
 * panel is a `txn_ingested` op identical to a hand-typed one but for its
 * `entry_method` label.
 */

import { useCallback, useMemo, useState } from "react";

import { newEntityID } from "@ledger/client/net/client";

import { Button } from "../components/ui/Button";
import { Dialog, DialogFooter } from "../components/ui/Dialog";
import { InfoTip } from "../components/ui/InfoTip";
import { SectionLabel } from "../components/ui/SectionLabel";
import { ManualTxnFields, emptyDraft, todayISO } from "../components/transactions/ManualTxnSheet";
import type { QuarantineItem } from "../v2/onboardingIO";
import { REVIEWED_ENTRY_METHOD, type Prefill } from "../v2/sources/heldMessage";
import { manualTxnOps, newIngestID, type ManualDraft } from "../v2/sources/transactions";
import type { Writer } from "../v2/writer";

export interface HeldMessageSheetProps {
  item: QuarantineItem;
  /** From `prefillFromHeld`, or `null` while the blob is still being fetched. */
  prefill: Prefill | null;
  /** The currency a draft with none falls back to. */
  homeCurrency: string;
  categories: readonly string[];
  currencies: readonly string[];
  writer: Writer | null;
  onClose: () => void;
  /** Called once the op is queued, so the caller can refresh and say so. */
  onAdded: () => void;
}

/**
 * What the sender CLAIMS, spelled so it cannot be mistaken for a verdict.
 *
 * `outer_domain` may carry the `unverified:` prefix the server attaches to an
 * envelope-asserted name; it is shown with the prefix intact, because stripping
 * it here would present the server's own warning as a fact.
 */
export function claimLine(item: QuarantineItem): string {
  const claim = item.innerDomain !== "" ? item.innerDomain : item.outerDomain;
  return claim === ""
    ? "Unverified. This message names no sender. Nothing checked it."
    : `Unverified. Claims to be from ${claim}. Nothing checked this.`;
}

export function HeldMessageSheet({
  item,
  prefill,
  homeCurrency,
  categories,
  currencies,
  writer,
  onClose,
  onAdded,
}: HeldMessageSheetProps) {
  const initial = useMemo<ManualDraft>(() => {
    const filled = prefill?.draft ?? null;
    if (filled === null) return emptyDraft(homeCurrency);
    // A template that produced no currency still needs one the picker can show,
    // and the account's own is the only defensible default.
    return { ...filled, currency: filled.currency === "" ? homeCurrency : filled.currency, date: filled.date === "" ? todayISO() : filled.date };
  }, [prefill, homeCurrency]);

  const [draft, setDraft] = useState<ManualDraft>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const add = useCallback((): void => {
    if (writer === null) return;
    setBusy(true);
    setError("");
    try {
      const built = manualTxnOps({
        draft,
        // Random, never a hash of the message: a second alert for the same
        // amount on the same day is a second transaction, and a content-hashed
        // ingest id would make it a `duplicate_ingest` anomaly that drops it.
        // A repeat surfaces through replay's fingerprint index instead, as a
        // notice on the review queue.
        ingestID: newIngestID(),
        newID: newEntityID,
        entryMethod: REVIEWED_ENTRY_METHOD,
      });
      if (!built.ok) {
        setError(built.reason);
        return;
      }
      writer.enqueueMany(built.specs);
      writer.flush().catch(() => undefined);
      onAdded();
    } finally {
      setBusy(false);
    }
  }, [writer, draft, onAdded]);

  return (
    <Dialog title="Add a transaction from this message" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <p data-testid="held-claim" className="text-sm font-semibold leading-relaxed text-bad">
            {claimLine(item)}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Adding this puts a row in your own ledger. It moves no money, sends nothing anywhere, and does not trust
            this sender — the message stays held.{" "}
            <InfoTip about="why this message is held" testId="held-tip">
              A forwarded email loses its bank's signature, so nothing can check who really sent it. You are the one
              checking it.
            </InfoTip>
          </p>
        </div>

        {prefill === null ? (
          <p role="status" className="text-sm text-muted">
            Reading the message…
          </p>
        ) : (
          <>
            <p data-testid="held-reason" className="text-sm leading-relaxed text-fg">
              {prefill.reason}
            </p>

            <ManualTxnFields
              idPrefix="held"
              draft={draft}
              onChange={setDraft}
              categories={categories}
              currencies={currencies}
            />

            <div>
              <SectionLabel>The message</SectionLabel>
              {prefill.subject !== "" && (
                <p data-testid="held-subject" className="mt-1 text-sm text-muted break-words">
                  Subject: {prefill.subject}
                </p>
              )}
              {/*
                Text children. Never markup — see this file's header. `pre-wrap`
                keeps the sender's line breaks without letting the sender's
                characters become elements, and `break-words` keeps a 400-
                character unbroken string inside the panel.
              */}
              <p
                data-testid="held-body"
                className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius)] border border-border bg-surface-2 p-3 text-xs leading-relaxed text-muted"
              >
                {prefill.body === "" ? "This message has no readable text." : prefill.body}
              </p>
            </div>
          </>
        )}

        {error !== "" && (
          <p role="alert" data-testid="held-error" className="text-sm text-bad">
            {error}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="held-add"
          disabled={busy || writer === null || prefill === null}
          onClick={add}
        >
          Add transaction
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
