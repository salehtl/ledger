/**
 * The bank step: which bank's mail can ledger actually read?
 *
 * # The supported set is the SERVER'S, not a constant in this build
 *
 * `GET /api/v1/templates` answers one entry per published template, and a bank
 * has several (`dib.card.v1`, `dib.account.v1`). `readSupportedBanks` collapses
 * them, so a template published after this bundle shipped appears here without a
 * deploy — which is the whole reason the list is fetched rather than hard-coded.
 *
 * # The waitlist may never decide whether onboarding continues
 *
 * It is a demand counter: `internal/v2/admin/waitlist.go` writes
 * `waitlist(bank, demand, first_seen, last_seen)` and stores no user at all. Its
 * entire output is "write the Mashreq parser next". So there are three ways off
 * this screen and the server can close none of them:
 *
 *   - **A supported bank** advances immediately.
 *   - **A name the counter can store** is recorded, and the confirmation is
 *     where the walk STOPS — deliberately, because the honest thing to say to
 *     somebody whose bank cannot be read yet is that it cannot be read yet, not
 *     to march them into a mail-forwarding setup that will file nothing. They
 *     carry on from there with one more tap, and the fact recorded is
 *     {@link WAITLIST_BANK}. If the request itself fails — offline, a 500, a
 *     grammar the server tightened after this build — the confirmation still
 *     appears and says plainly that the request was not recorded. Retrying
 *     cannot help them and their place in the flow is not the counter's to
 *     withhold.
 *   - **"Continue without adding it"** advances with no request at all. This is
 *     the path for a name the grammar cannot represent — Arabic, an en dash, a
 *     Turkish dotted I — where no amount of retyping will work. Without it, a
 *     grammar refusal is a dead end wearing a helpful message.
 *
 * A refusal from {@link normalizeBankName} is the one case that does not advance
 * by itself, and deliberately: it is instantly correctable, the message names
 * what IS allowed, and advancing would throw away the demand signal the user was
 * one edit from giving.
 */

import { useEffect, useState } from "react";

import { ApiError } from "@ledger/client/net/client";

import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { Pressable } from "../../components/ui/Pressable";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { BANK_NAME_RULE, bankDisplayName, normalizeBankName, WAITLIST_BANK } from "../../v2/bank";
import { joinWaitlist, readSupportedBanks, type SupportedBank, type TokenSource } from "../../v2/onboardingIO";
import { Notice, Step } from "./Shell";

export interface BankProps {
  client: TokenSource;
  onPicked: (bank: string) => void;
  server?: string;
  fetch?: typeof fetch;
}

type Listing = { kind: "loading" } | { kind: "ready"; banks: SupportedBank[] } | { kind: "failed" };

export function Bank({ client, onPicked, server, fetch: doFetch }: BankProps) {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [other, setOther] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Non-null once the counter has been asked; the walk stops here. */
  const [waitlisted, setWaitlisted] = useState<{ bank: string; recorded: boolean; detail: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const banks = await readSupportedBanks(client, { ...(server === undefined ? {} : { server }), ...(doFetch === undefined ? {} : { fetch: doFetch }) });
        if (live) setListing({ kind: "ready", banks });
      } catch {
        // Not fatal, and not a retry loop: the "another bank" path below works
        // with no listing at all, so a failed read costs the shortcut and
        // nothing else.
        if (live) setListing({ kind: "failed" });
      }
    })();
    return () => {
      live = false;
    };
  }, [client, server, doFetch]);

  const request = async (): Promise<void> => {
    // Checked before the request, with the same grammar the server enforces, so
    // the refusal is this sentence and not a 400 rendered as "Try again."
    const name = normalizeBankName(other);
    if (!name.ok) {
      setProblem(name.reason);
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      await joinWaitlist(client, name.bank, { ...(server === undefined ? {} : { server }), ...(doFetch === undefined ? {} : { fetch: doFetch }) });
      setWaitlisted({ bank: name.bank, recorded: true, detail: "" });
    } catch (error) {
      const detail =
        error instanceof ApiError && error.detail !== "" ? error.detail : "the request did not go through";
      setWaitlisted({ bank: name.bank, recorded: false, detail });
    } finally {
      setBusy(false);
    }
  };

  if (waitlisted !== null) {
    return (
      <Step
        testId="bank-waitlisted"
        title={waitlisted.recorded ? "Noted — that bank is on the list" : "That request did not reach us"}
        intro={
          waitlisted.recorded
            ? "ledger cannot read this bank's emails yet, so there is nothing for it to file."
            : `ledger could not record the request: ${waitlisted.detail}.`
        }
      >
        <Notice testId="waitlist-confirmation">
          <p>
            A request adds one number to a count of how many people bank with <strong>{waitlisted.bank}</strong>.
            It records nothing about you — not your name, not your address, not that it was you who asked. That
            count is the whole of how the next parser gets chosen.
          </p>
          <p>
            You can carry on setting up now. Mail from a bank ledger cannot read yet is not lost: it is held, and
            it becomes transactions the day the parser lands.
          </p>
        </Notice>
        <Button variant="primary" onClick={() => onPicked(WAITLIST_BANK)}>
          Carry on setting up
        </Button>
        <Button variant="ghost" onClick={() => setWaitlisted(null)}>
          Pick a different bank
        </Button>
      </Step>
    );
  }

  return (
    <Step
      testId="bank"
      title="Which bank sends your alerts?"
      intro="ledger reads the transaction emails your bank already sends. It needs to know how yours are written."
    >
      {listing.kind === "loading" && (
        <div className="flex items-center gap-3 text-muted" role="status">
          <PixelSpinner size={12} />
          <span className="text-sm">Checking which banks ledger can read…</span>
        </div>
      )}

      {listing.kind === "failed" && (
        <Notice testId="bank-listing-failed">
          <p>
            ledger could not fetch the list of supported banks. Type your bank below instead — nothing about this
            step needs the list.
          </p>
        </Notice>
      )}

      {listing.kind === "ready" && listing.banks.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel as="h2">Supported today</SectionLabel>
          <div className="flex flex-col rounded-[var(--radius)] border border-border bg-surface divide-y divide-border">
            {listing.banks.map((bank) => (
              <Pressable
                key={bank.id}
                className="min-h-11 px-4 py-3 text-left text-sm font-medium hover:bg-surface-2 transition-colors"
                onClick={() => onPicked(bank.id)}
              >
                {bankDisplayName(bank.id)}
              </Pressable>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 pt-2 border-t border-border">
        <SectionLabel as="h2">Another bank</SectionLabel>
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Bank name</span>
          <Input
            aria-label="Bank name"
            value={other}
            disabled={busy}
            onChange={(e) => {
              setOther(e.target.value);
              setProblem(null);
            }}
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
          />
        </label>
        {/*
          The rule is on the glass before anything is refused. A constraint a
          user only discovers by tripping it is a constraint shown too late.
        */}
        <p className={`text-xs ${problem === null ? "text-muted" : "text-bad"}`} data-testid="bank-name-rule">
          {problem ?? BANK_NAME_RULE}
        </p>
        <Button variant="secondary" disabled={other.trim() === "" || busy} onClick={() => void request()}>
          Request support
        </Button>
      </div>

      <Button variant="ghost" disabled={busy} onClick={() => onPicked(WAITLIST_BANK)}>
        Continue without adding it
      </Button>
    </Step>
  );
}
