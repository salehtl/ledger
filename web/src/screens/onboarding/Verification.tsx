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
 * # Advancing is MEASURED, not inferred — and measured REPEATEDLY
 *
 * `first_mail_confirmed` is a fact about the LOG: a genuine bank email became a
 * transaction. A `200` from `POST /api/v1/quarantine/confirm` is not that fact —
 * `reingest` can legitimately report zero — so this screen reads `firstMailAt`,
 * which folds the log, and advances only if that answers with a timestamp.
 *
 * **Sampling that fact once, immediately after the confirm call, is a bug, and
 * it was this screen's.** The re-ingested transaction reaches the LOCAL log only
 * via a sync pull, which has not happened at that instant, so the read returned
 * `null` essentially always. Meanwhile `reingest` had already promoted the mail
 * OUT of the lane, so the next poll dropped the item and took the confirm button
 * with it — leaving the user on "Nothing from a bank has arrived yet" forever,
 * with only a full reload to rescue them. The copy promising "ledger will keep
 * watching" was false.
 *
 * So the fact is re-read on a loop, and the loop is what the promise means:
 *
 *  1. {@link VerificationProps.sync} runs first, because nothing else on this
 *     screen can make the log change. The boot gate withholds its coordinator
 *     from `useSync` outside `ready`/`onboarding` (a background sync in the
 *     `unenrolled` state replaces a retryable wall with an un-retryable halt),
 *     so `onboarding` had to be added to that condition for this to work at
 *     all — there is otherwise no foreground trigger and no other path pulling
 *     while this screen is up.
 *  2. Then the lane is re-read, and
 *  3. Then `firstMailAt()` is sampled again.
 *
 * Any of the three can be what finally answers, and the mount does the same
 * three so a reload onto this screen with the fact already true leaves at once.
 * {@link advanced} latches, because `onConfirmed` is a step transition and a
 * poll that fired it twice would dispatch into an unmounted tree.
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
  type TrustScope,
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
  /**
   * Pulls the log, so `firstMailAt` has something new to say.
   *
   * Optional only so a test can leave it out; in the app it is always wired,
   * and without it this screen cannot advance at all — see the header. It must
   * never reject: a failed sync is an ordinary event on a phone and the poll
   * carries on regardless.
   */
  sync?: () => Promise<void>;
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
  sync,
  server,
  fetch: doFetch,
  pollMs = VERIFICATION_POLL_MS,
  copy,
}: VerificationProps) {
  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  /** A confirmation that filed only part of its batch. See {@link ConfirmResult}. */
  const [partial, setPartial] = useState<{ domain: string; scope: TrustScope; remaining: number } | null>(null);
  const live = useRef(true);
  /** `onConfirmed` is a step transition; firing it twice dispatches into a dead tree. */
  const advanced = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Held in a ref so the poll effect does not re-register every time a caller
  // re-creates one of these inline, which is the ordinary way to pass them.
  const io = useRef({ firstMailAt, onConfirmed, sync });
  io.current = { firstMailAt, onConfirmed, sync };

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

  /**
   * One round of watching: pull, re-read the lane, re-sample the fact.
   *
   * The order matters and is the fix. A pull that lands the promoted
   * transaction is the ONLY thing that can turn `firstMailAt()` from null, so it
   * goes first; the lane read second, because a promoted message leaves the lane
   * and the screen must stop offering to confirm it; the fact last, because it
   * is the only thing allowed to end this step.
   */
  const watch = useCallback(async () => {
    if (advanced.current) return;
    try {
      await io.current.sync?.();
    } catch {
      // A failed pull is not a failed step. The next tick tries again.
    }
    await load();
    if (advanced.current || !live.current) return;
    const at = io.current.firstMailAt();
    if (at === null) return;
    advanced.current = true;
    io.current.onConfirmed(at);
  }, [load]);

  useEffect(() => {
    void watch();
  }, [watch]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const timer = setInterval(() => void watch(), pollMs);
    return () => {
      clearInterval(timer);
    };
  }, [watch, pollMs]);

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

  /**
   * Trusts one origin and files what that released.
   *
   * It does NOT decide whether the step is over — {@link watch} does, on the
   * loop. All this adds is immediacy: one round of watching right now rather
   * than up to `pollMs` later.
   */
  const confirm = useCallback(
    async (domain: string, scope: TrustScope): Promise<void> => {
      setBusy(true);
      setMessage("");
      try {
        const result = await confirmSender(client, domain, scope, {
          ...(server === undefined ? {} : { server }),
          ...(doFetch === undefined ? {} : { fetch: doFetch }),
        });
        // The batch is BOUNDED. `remaining > 0` means mail this user has already
        // vouched for is still held, and — because the confirmed item has left
        // the lane — there is no longer a row offering to file it. Dropping this
        // is a silent partial ingest that ends in expiry.
        const left = result.reingest?.remaining ?? 0;
        setPartial(left > 0 ? { domain: result.domain, scope, remaining: left } : null);
        if (result.reingest?.incomplete === true) {
          setMessage(
            "ledger filed part of the mail held for that sender and then hit an error. The rest is still held " +
              "and still safe — try filing it again.",
          );
        }
      } catch (error) {
        const code = error instanceof ApiError ? error.code : "";
        setMessage(CONFIRM_CONFLICT_COPY[code] ?? "Could not trust this sender. Try again.");
        if (live.current) setBusy(false);
        return;
      }
      await watch();
      if (live.current) {
        setBusy(false);
        if (!advanced.current) {
          // A confirmation that produced no transaction. Said plainly rather
          // than treated as progress: the milestone is a transaction in the
          // log, and there is not one yet. The loop is still running, so the
          // promise in this sentence is now true.
          setMessage((held) =>
            held !== ""
              ? held
              : `${domain} is trusted. No transaction has come out of its mail yet — ledger will keep checking.`,
          );
        }
      }
    },
    [client, server, doFetch, watch],
  );

  return (
    <Step
      testId="verification"
      title={QUARANTINE_HELD.title}
      intro={QUARANTINE_HELD.body}
      footer={
        <Button variant="ghost" disabled={busy} onClick={() => void watch()}>
          {busy ? "Checking…" : "Check now"}
        </Button>
      }
    >
      {message !== "" && (
        <p role="alert" data-testid="verification-message" className="text-sm leading-relaxed text-bad">
          {message}
        </p>
      )}

      {/*
        The partial batch. It outlives the item that produced it, deliberately:
        the message that was confirmed has been promoted out of the lane, so
        this notice is the only thing left that can offer to file the rest.
      */}
      {partial !== null && (
        <Notice tone="danger" announce title="Some held mail is still waiting" testId="verification-partial">
          <p>
            ledger files a bounded batch per confirmation, and {partial.remaining}{" "}
            {partial.remaining === 1 ? "message" : "messages"} from{" "}
            <span className="font-mono">{partial.domain}</span> {partial.remaining === 1 ? "was" : "were"} not
            reached this time. Nothing is lost — it is still held — but it will not file itself.
          </p>
          <Button variant="primary" disabled={busy} onClick={() => void confirm(partial.domain, partial.scope)}>
            File the rest
          </Button>
        </Notice>
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
          const request = trustRequest(item);
          return (
            <Notice key={item.id} title={basis.label} testId={`verification-bank-${item.id}`}>
              <p className="text-xs text-muted">Verification: {basis.source}</p>
              <p className="text-xs text-muted">
                DKIM: {item.dkim} · ARC: {item.arc}
              </p>
              <Button
                variant={request === null ? "secondary" : "primary"}
                disabled={request === null || busy}
                onClick={() => {
                  if (request !== null) void confirm(request.domain, request.scope);
                }}
              >
                {request === null ? "Cannot trust unauthenticated mail" : "This is my bank — file its mail"}
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
