/**
 * Google's held confirmation, and then the first real bank email.
 *
 * One screen for two things because the machine has one slot for them, and
 * because in practice they are one wait: the user sets the forward, Google's
 * confirmation lands within seconds, and the bank's first alert lands whenever
 * the bank feels like it.
 *
 * # Everything here is read out of the QUARANTINE lane, by design
 *
 * Gmail's confirmation is signed by `google.com`; §3.2 forbids ever promoting a
 * forwarder domain; so the message onboarding depends on is one the product will
 * never trust. `quarantine.go`'s own header records the dependency in as many
 * words ("onboarding (Task D6) reads the confirmation link out of a quarantined
 * message"). It is held forever and read in place, and `QUARANTINE_HELD` says
 * "held on purpose" before it says anything else — because otherwise a new
 * user's first impression is a fault.
 *
 * # What may be rendered as trusted, and what may not
 *
 * The bank half shows `trustBasis(item)` — the VERIFIED signing domain, or a
 * prominent unauthenticated state — and never a subject, a display name or any
 * part of a body. The API does not even send those fields, for exactly this
 * reason: a sheet that rendered the subject line would be asking the user to
 * authenticate the sender using text the sender wrote.
 *
 * The Google half *does* render body text, because it has to. It is labelled as
 * raw and untrusted, capped at 8 KB by `scanForCode`, and rendered as a React
 * text child, which interpolates no markup. The only two things lifted out of it
 * and offered as actions are a nine-digit run and a URL whose host is a literal
 * in the pattern — see `v2/verificationCode.ts`.
 *
 * # Advancing is MEASURED, not inferred
 *
 * `first_mail_confirmed` is a fact about the LOG: a genuine bank email became a
 * transaction. A `200` from `POST /api/v1/quarantine/confirm` is not that fact —
 * `reingest` can legitimately report zero — so after a confirmation this screen
 * re-reads `firstMailAt`, which folds the log, and advances only if that answers
 * with a timestamp. Otherwise it says what happened and stays put.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "@ledger/client/net/client";

import { Button } from "../../components/ui/Button";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { QUARANTINE_HELD } from "../../v2/onboarding";
import {
  CONFIRM_CONFLICT_COPY,
  confirmSender,
  readQuarantine,
  trustBasis,
  trustRequest,
  type QuarantineItem,
  type TokenSource,
} from "../../v2/onboardingIO";
import {
  heldBody,
  isForwarderConfirmation,
  NO_CODE_COPY,
  scanForCode,
  UNTRUSTED_BODY_LABEL,
  type CodeScan,
} from "../../v2/verificationCode";
import { Notice, Step } from "./Shell";

/**
 * How often the lane is re-read while the user waits.
 *
 * There is no push for held mail (`quarantine.go`: "Nothing here pushes"), so a
 * poll is the only way this screen learns anything. 15 s is chosen against the
 * wait it covers — a Gmail confirmation arrives in seconds, a bank alert in
 * minutes to hours — and the request is a page of held mail, not a sync.
 */
export const VERIFICATION_POLL_MS = 15_000;

export interface VerificationProps {
  client: TokenSource;
  /** Folds the log. The ONLY thing that may say the first mail is confirmed. */
  firstMailAt: () => string | null;
  onConfirmed: (at: string) => void;
  server?: string;
  fetch?: typeof fetch;
  /** 0 disables the poll — what tests pass. */
  pollMs?: number;
  copy?: (text: string) => Promise<void>;
}

export function Verification({
  client,
  firstMailAt,
  onConfirmed,
  server,
  fetch: doFetch,
  pollMs = VERIFICATION_POLL_MS,
  copy,
}: VerificationProps) {
  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const page = await readQuarantine(
        client,
        { includeBlob: true },
        { ...(server === undefined ? {} : { server }), ...(doFetch === undefined ? {} : { fetch: doFetch }) },
      );
      if (live.current) setItems(page.items);
    } catch {
      if (live.current) setMessage("Could not check for held mail. ledger will keep trying.");
    } finally {
      if (live.current) setBusy(false);
    }
  }, [client, server, doFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      clearInterval(timer);
    };
  }, [load, pollMs]);

  const forwarder = items.find(isForwarderConfirmation) ?? null;
  const banks = items.filter((item) => !isForwarderConfirmation(item));

  /**
   * Memoized on the blob, not recomputed per render.
   *
   * This screen re-renders on every poll, and the work behind it is a full MIME
   * normalize of a message that may be a megabyte. Phase 0's >500 MB freeze was
   * partly unguarded repeated passes over large bodies; there is no reason for
   * this one to run more than once per distinct message.
   */
  const scan: CodeScan | null = useMemo(
    () =>
      forwarder === null || forwarder.blob === undefined
        ? null
        : scanForCode(heldBody(forwarder.blob, forwarder.receivedAt).text),
    [forwarder?.blob, forwarder?.receivedAt],
  );

  const onCopyCode = async (code: string): Promise<void> => {
    try {
      if (copy !== undefined) await copy(code);
      else if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(code);
      } else throw new Error("no clipboard");
      setCopied(true);
    } catch {
      setMessage("This browser would not let ledger use the clipboard. The code above can be selected by hand.");
    }
  };

  const confirm = async (item: QuarantineItem): Promise<void> => {
    const request = trustRequest(item);
    if (request === null) return;
    setBusy(true);
    setMessage("");
    try {
      await confirmSender(client, request.domain, request.scope, {
        ...(server === undefined ? {} : { server }),
        ...(doFetch === undefined ? {} : { fetch: doFetch }),
      });
      const at = firstMailAt();
      if (at === null) {
        // A confirmation that re-ingested nothing. Said plainly rather than
        // treated as progress: the milestone is a transaction in the log, and
        // there is not one.
        setMessage(
          `${request.domain} is trusted, but no transaction came out of the mail held for it yet. ledger will keep watching.`,
        );
        await load();
        return;
      }
      onConfirmed(at);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "";
      setMessage(CONFIRM_CONFLICT_COPY[code] ?? "Could not trust this sender. Try again.");
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <Step
      testId="verification"
      title={QUARANTINE_HELD.title}
      intro={QUARANTINE_HELD.body}
      footer={
        <Button variant="ghost" disabled={busy} onClick={() => void load()}>
          {busy ? "Checking…" : "Check now"}
        </Button>
      }
    >
      {message !== "" && (
        <p role="alert" data-testid="verification-message" className="text-sm leading-relaxed text-bad">
          {message}
        </p>
      )}

      {/* ---- Google's confirmation ---- */}
      {forwarder === null ? (
        <Notice title="Waiting for Google's confirmation" testId="verification-waiting">
          <p>
            When you add the forward, Google emails a code to your ledger address. It usually arrives within a
            minute, and it will appear here.
          </p>
        </Notice>
      ) : (
        <Notice title={`From ${forwarder.outerDomain}`} testId="verification-forwarder">
          {scan === null ? (
            <p data-testid="verification-no-body">
              This message is held but its contents were not sent to this device. Open it from held mail in
              settings once you are through setup.
            </p>
          ) : scan.code !== null ? (
            <>
              <p data-testid="verification-code" className="font-mono text-2xl select-all tnum">
                {scan.code}
              </p>
              <Button variant="primary" onClick={() => void onCopyCode(scan.code as string)}>
                {copied ? "Copied" : "Copy code"}
              </Button>
              <p className="text-xs text-muted">
                Paste this into the confirmation box in Gmail&rsquo;s forwarding settings.
              </p>
            </>
          ) : (
            <>
              <p data-testid="verification-no-code">{NO_CODE_COPY}</p>
              <p className="text-xs text-muted">{UNTRUSTED_BODY_LABEL}</p>
              <pre
                data-testid="verification-raw-body"
                className="font-mono text-xs text-muted whitespace-pre-wrap break-all max-h-64 overflow-y-auto"
              >
                {scan.body}
              </pre>
            </>
          )}
          {scan?.link != null && (
            <a
              data-testid="verification-open-link"
              href={scan.link}
              target="_blank"
              rel="noreferrer noopener"
              className="min-h-11 inline-flex items-center text-sm underline"
            >
              Open the confirmation link on mail-settings.google.com
            </a>
          )}
        </Notice>
      )}

      {/* ---- The first real bank email ---- */}
      <SectionLabel as="h2">Your first bank email</SectionLabel>
      {banks.length === 0 ? (
        <Notice testId="verification-no-bank-mail">
          <p>
            Nothing from a bank has arrived yet. This step finishes on its own when one does, so you can leave the
            app open or come back later.
          </p>
        </Notice>
      ) : (
        banks.map((item) => {
          const basis = trustBasis(item);
          return (
            <Notice key={item.id} title={basis.label} testId={`verification-bank-${item.id}`}>
              <p className="text-xs text-muted">Verification: {basis.source}</p>
              <p className="text-xs text-muted">
                DKIM: {item.dkim} · ARC: {item.arc}
              </p>
              <Button
                variant={basis.authenticated ? "primary" : "secondary"}
                disabled={!basis.authenticated || busy}
                onClick={() => void confirm(item)}
              >
                {basis.authenticated ? "This is my bank — file its mail" : "Cannot trust unauthenticated mail"}
              </Button>
            </Notice>
          );
        })
      )}

      {busy && (
        <div className="flex items-center gap-3 text-muted" role="status">
          <PixelSpinner size={12} />
          <span className="text-sm">Checking held mail…</span>
        </div>
      )}
    </Step>
  );
}
