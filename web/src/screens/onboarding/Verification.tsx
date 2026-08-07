/**
 * The provider's held confirmation, if there is one, and then the first real
 * bank email.
 *
 * One screen for two things because the machine has one slot for them, and
 * because in practice they are one wait: the user sets the forward, the
 * provider's confirmation lands within seconds, and the bank's first alert lands
 * whenever the bank feels like it.
 *
 * # Everything here is read out of the QUARANTINE lane, by design
 *
 * A provider's confirmation is signed by the PROVIDER (Gmail's by `google.com`);
 * §3.2 forbids ever promoting a forwarder domain; so the message onboarding
 * depends on is one the product will never trust. `quarantine.go`'s own header
 * records the dependency in as many words ("onboarding (Task D6) reads the
 * confirmation link out of a quarantined message"). It is held forever and read
 * in place, and `QUARANTINE_HELD` says "held on purpose" before it says anything
 * else — because otherwise a new user's first impression is a fault.
 *
 * # Some users have no confirmation to wait for at all
 *
 * iCloud sends no code — you enter the destination address and mail flows — and
 * a user who set this address with their bank DIRECTLY never had a forwarder in
 * the first place. Offering them a code reader and a screen about confirmations
 * is a promise the flow cannot keep, so {@link VerificationProps.expectConfirmation}
 * picks the opening: `WAITING_FOR_FIRST_MAIL` and no code affordance.
 *
 * Three things it deliberately does NOT change:
 *
 *  1. **The gate.** `firstMailAt()` either way. A transaction in the log is the
 *     only provider-agnostic proof that mail actually reaches ledger.
 *  2. **The list.** Every held message is still listed with its verified signing
 *     domain, because held mail the user cannot see reads as lost mail.
 *  3. **Trust.** It is a hint about which sentences to render, sourced from a
 *     provider the user tapped. Nothing an unauthenticated party influences may
 *     move a trust boundary, and this moves none.
 *
 * And it is never a dead end: a provider believed to send no code may send one,
 * so the user can ask for the reader themselves. That control is the honest
 * version of the flag — "we did not expect one" rather than "there is none".
 *
 * # The app does not guess which held message is which
 *
 * It used to: a Google domain meant "the forwarder's confirmation" and anything
 * else meant "a bank". That was wrong for every other provider, and it cannot be
 * fixed by widening the list, because a bank that registers this address
 * DIRECTLY is signed by itself and has no inner domain either — exactly like a
 * provider's confirmation. So every held message is listed with the domain that
 * signed it and when it arrived, and the user opens the one they are waiting
 * for. See `couldBeConfirmation`.
 *
 * # What may be rendered as trusted, and what may not
 *
 * Every row shows `trustBasis(item)` — the VERIFIED signing domain, or a
 * prominent unauthenticated state — and never a subject, a display name or any
 * part of a body. The API does not even send those fields, for exactly this
 * reason: a sheet that rendered the subject line would be asking the user to
 * authenticate the sender using text the sender wrote.
 *
 * An OPENED message *does* render body text, because it has to. It is labelled
 * as raw and untrusted, capped at 8 KB by `scanForCode`, and rendered as a React
 * text child, which interpolates no markup. The only two things lifted out of it
 * and offered as actions are a bounded digit run and a URL on the message's own
 * verified signing domain — a host this screen passes IN, never one read out of
 * the body. See `v2/verificationCode.ts`. Only a message whose outer domain the
 * server verified can be opened at all.
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
import { QUARANTINE_HELD, TRUST_ONLY_YOUR_BANK, WAITING_FOR_FIRST_MAIL } from "../../v2/onboarding";
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
  couldBeConfirmation,
  verifiedOuterDomain,
  heldBody,
  NO_CODE_COPY,
  scanForCode,
  UNTRUSTED_BODY_LABEL,
  type CodeScan,
} from "../../v2/verificationCode";
import { sinceLabel } from "../../lib/sinceLabel";
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

/**
 * How many bounded re-ingest batches one tap may chain.
 *
 * Each round is up to 500 messages through the parse cascade, synchronously,
 * inside one request — the most expensive thing a session can ask this API to do
 * — and the route's per-user budget will refuse a caller that keeps asking. Four
 * rounds is 2,000 messages, comfortably past any real beta backlog, and a
 * remainder past that stays on screen with a control rather than being retried
 * forever.
 */
export const MAX_CONFIRM_ROUNDS = 4;

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
  /**
   * Whether the user's provider is expected to email a confirmation code.
   *
   * From the provider they picked on the forwarding step, or `false` when they
   * registered this address with their bank directly. UI state only: it picks
   * the opening copy and whether the code reader is offered up front. See the
   * header for the three things it does not change.
   *
   * Defaults to `true`, which is also what a reloaded tab gets — the choice is
   * not persisted. Expecting a code that never comes costs a control nobody
   * presses; not expecting one that does would hide the thing the user is
   * holding, and the control below covers even that.
   */
  expectConfirmation?: boolean;
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
  expectConfirmation = true,
}: VerificationProps) {
  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  /**
   * Which held message the user opened to look for a code, if any.
   *
   * The app cannot tell a provider's confirmation from a bank's first direct
   * alert — both are mail whose only signature is the outer one — so it does not
   * guess. See `couldBeConfirmation`.
   */
  const [openId, setOpenId] = useState<string | null>(null);
  /**
   * The user said a code arrived anyway.
   *
   * Only reachable when {@link VerificationProps.expectConfirmation} is false,
   * and it exists because that flag is a belief about a provider rather than a
   * fact about a mailbox. A provider that changes its flow, a bank that verifies
   * an alert address by email — either leaves someone holding a code with
   * nowhere to read it, and "reinstall to get the button back" is not an answer.
   */
  const [codeSought, setCodeSought] = useState(false);
  const readingCode = expectConfirmation || codeSought;
  /** A confirmation that filed only part of its batch. See {@link ConfirmResult}. */
  const [partial, setPartial] = useState<{ domain: string; scope: TrustScope; remaining: number } | null>(null);
  const live = useRef(true);
  /** `onConfirmed` is a step transition; firing it twice dispatches into a dead tree. */
  const advanced = useRef(false);
  /** One round of watching at a time. See {@link watch}. */
  const inFlight = useRef(false);
  /** Read by {@link watch}, which must not advance past an unfiled remainder. */
  const partialRef = useRef<{ domain: string; scope: TrustScope; remaining: number } | null>(null);
  partialRef.current = partial;

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
   *
   * # Two things it refuses to do
   *
   * **It will not run twice at once.** The sync layer coalesces, so there was no
   * fetch storm, but two overlapping `readQuarantine` calls are last-write-wins
   * and a slow page landing after a fast one briefly resurrects an item that has
   * already been promoted — an offer to confirm mail that is no longer held.
   * It self-corrected on the next tick, which is exactly the kind of flicker
   * nobody can reproduce on purpose.
   *
   * **It will not advance while a remainder is outstanding — until the user
   * says so.** See {@link confirm} and {@link handOff}. Advancing automatically
   * unmounts the notice in the frame it appears, so the sentence pointing at
   * Settings → Held mail never gets read; the user releases the pause with a
   * button, which is the handoff being made rather than assumed.
   */
  const watch = useCallback(async () => {
    if (advanced.current || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      try {
        await io.current.sync?.();
      } catch {
        // A failed pull is not a failed step. The next tick tries again.
      }
      await load();
      if (advanced.current || !live.current) return;
      // Held mail this user has already vouched for is still unfiled, and this
      // screen is the only place it can be filed from.
      if (partialRef.current !== null) return;
      const at = io.current.firstMailAt();
      if (at === null) return;
      advanced.current = true;
      io.current.onConfirmed(at);
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  }, [load]);

  /**
   * The handoff, and the reason it is a BUTTON rather than a removed guard.
   *
   * Task 7 blocked the step on an undrainable remainder, and that was right only
   * while this was the sole surface in the product that could file held mail.
   * Task 10 gave Settings a held-mail screen, so the block is now a dead end
   * where a handoff will do — a user whose remainder never drains (a server
   * that keeps reporting the same number, a repeated 429) could not finish
   * setting up at all.
   *
   * But simply deleting the guard was wrong in the other direction: `confirm`
   * ends by calling {@link watch}, so the step would advance in the same frame
   * the notice appeared, and the sentence telling the user where the rest lives
   * would unmount before it could be read. Pressing this is the user having
   * been told. It releases the block for this mount only — nothing is filed and
   * nothing is dismissed server-side; the mail stays held, and Settings still
   * shows it with its expiry.
   */
  const handOff = useCallback(() => {
    setPartial(null);
    // `watch` reads the ref, and React has not re-rendered yet.
    partialRef.current = null;
    void watch();
  }, [watch]);

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

  /**
   * The message the user said is the one they are waiting for.
   *
   * Re-derived from the CURRENT page rather than kept as an object, so an item
   * that has left the lane between polls closes itself instead of leaving a
   * stale body on screen. {@link couldBeConfirmation} is re-applied here rather
   * than trusted from the render that offered the control.
   */
  const opened = readingCode ? (items.find((item) => item.id === openId && couldBeConfirmation(item)) ?? null) : null;

  /**
   * Memoized on the blob, not recomputed per render.
   *
   * This screen re-renders on every poll, and the work behind it is a full MIME
   * normalize of a message that may be a megabyte. Phase 0's >500 MB freeze was
   * partly unguarded repeated passes over large bodies; there is no reason for
   * this one to run more than once per distinct message.
   *
   * `linkHost` is the item's own VERIFIED signing domain, read off server data
   * and never out of the body. It is what confines the only link this screen
   * will offer to open — a held message can point at the domain that signed it
   * and nowhere else.
   */
  const linkHost = opened === null ? "" : (verifiedOuterDomain(opened) ?? "");
  const scan: CodeScan | null = useMemo(
    () =>
      opened === null || opened.blob === undefined
        ? null
        : scanForCode(heldBody(opened.blob, opened.receivedAt).text, { linkHost }),
    [opened?.blob, opened?.receivedAt, linkHost],
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
   * Trusts one origin and files **everything** that released.
   *
   * # Why this loops rather than confirming once
   *
   * `handleConfirmSender` re-ingests a bounded batch and reports the rest as
   * `remaining`. Round 1 surfaced that remainder in a notice with a "File the
   * rest" control — which was right, and still lost the mail, because the very
   * next thing this function did was call {@link watch}, and a successful watch
   * ADVANCES THE STEP. The notice and its control unmounted with the screen, and
   * nothing outside `screens/onboarding/` reads the quarantine lane, so the
   * remainder sat until it expired. That is the defect the notice was added to
   * fix, reappearing on the path where everything went right.
   *
   * So the batch is drained here, before the step is allowed to end, and
   * {@link watch} additionally refuses to advance while `partial` is non-null —
   * belt and braces, because the two are reached from different places ("File
   * the rest" re-enters here; the poll does not). Since Task 10 that pause is
   * releasable by the user through {@link handOff}, because Settings can file
   * held mail now and a permanent block would strand a setup on a remainder
   * that never drains.
   *
   * Repetition is safe and converges: `Confirm` returns the ids still HELD, a
   * promoted message is no longer held, and an already-allowlisted origin gets
   * an empty release rather than `origin_unproven` (`quarantine.go:414-418`).
   *
   * # Why it is bounded twice
   *
   * {@link MAX_CONFIRM_ROUNDS} caps the work one tap can ask of the server —
   * each round runs the parse cascade over up to 500 messages synchronously. And
   * a round that does not REDUCE the remainder stops the loop regardless: a
   * server that keeps answering with the same number is not making progress, and
   * spinning on it would be this screen's own version of the unguarded repeat
   * that produced Phase 0's freeze. Either way the notice stays up, the step
   * stays put, and the control is there to try again.
   */
  const confirm = useCallback(
    async (domain: string, scope: TrustScope): Promise<void> => {
      setBusy(true);
      setMessage("");
      let request = { domain, scope };
      let left = 0;
      try {
        for (let round = 0; round < MAX_CONFIRM_ROUNDS; round += 1) {
          const result = await confirmSender(client, request.domain, request.scope, {
            ...(server === undefined ? {} : { server }),
            ...(doFetch === undefined ? {} : { fetch: doFetch }),
          });
          // The server's normalized spelling, so a continuation sends the string
          // this server would match.
          request = { domain: result.domain, scope: request.scope };
          const now = result.reingest?.remaining ?? 0;
          if (result.reingest?.incomplete === true) {
            setMessage(
              "ledger filed part of the mail held for that sender and then hit an error. The rest is still held " +
                "and still safe — try filing it again.",
            );
            left = now;
            break;
          }
          if (now === 0) {
            left = 0;
            break;
          }
          // No progress: stop rather than spin.
          if (round > 0 && now >= left) {
            left = now;
            break;
          }
          left = now;
          if (!live.current) break;
          setPartial({ domain: request.domain, scope: request.scope, remaining: now });
        }
      } catch (error) {
        const code = error instanceof ApiError ? error.code : "";
        setMessage(CONFIRM_CONFLICT_COPY[code] ?? "Could not trust this sender. Try again.");
        if (live.current) {
          setBusy(false);
          // Whatever this attempt learned was outstanding stays outstanding,
          // and now stays in the REF too — symmetrically with the success path
          // below, which sets both and says why. This path does not call
          // `watch` itself, so today the only exposure is a poll tick landing
          // before React flushes this render; the reason to fix it anyway is
          // that the asymmetry is the kind that survives a refactor, and
          // whoever later adds a `watch()` here would inherit a remainder the
          // guard cannot see.
          //
          // It only ever WRITES a remainder, never clears one. A throw means
          // this attempt learned nothing, and `left` is still 0 when round 0 is
          // the one that threw — so clearing on `left === 0` would discard a
          // real remainder recorded by an earlier confirm the moment a retry
          // hit a 429, unblocking the advance and losing the mail. That is the
          // bug this whole finding exists to prevent, and it would have been
          // reintroduced by making the two paths symmetric in the naive way.
          if (left > 0) {
            const outstanding = { domain: request.domain, scope: request.scope, remaining: left };
            setPartial(outstanding);
            partialRef.current = outstanding;
          }
        }
        return;
      }
      if (!live.current) return;
      const outstanding = left > 0 ? { domain: request.domain, scope: request.scope, remaining: left } : null;
      setPartial(outstanding);
      // `watch` reads the ref, and React has not re-rendered yet.
      partialRef.current = outstanding;
      setBusy(false);

      await watch();
      if (live.current && !advanced.current && outstanding === null) {
        // A confirmation that produced no transaction. Said plainly rather than
        // treated as progress: the milestone is a transaction in the log, and
        // there is not one yet. The loop is still running, so the promise in
        // this sentence is now true.
        setMessage((held) =>
          held !== ""
            ? held
            : `${request.domain} is trusted. No transaction has come out of its mail yet — ledger will keep checking.`,
        );
      }
    },
    [client, server, doFetch, watch],
  );

  // Two openings for one step. The gate behind them is the same `firstMailAt`,
  // so neither promises anything the other cannot deliver.
  const opening = readingCode ? QUARANTINE_HELD : WAITING_FOR_FIRST_MAIL;

  return (
    <Step
      testId="verification"
      title={opening.title}
      intro={opening.body}
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
          {/*
            "ledger will keep trying" and NOT "setup will wait here until they
            are filed", which is what this said and which a reload makes false:
            the block lives in `partialRef`, which is component state, so a
            remount starts with no remainder and `watch` advances. The block is
            deliberately not persisted — a schema change to
            `LocalOnboardingRecord` for a constraint that is now a pause rather
            than a wall is bad value — but that is an argument for deferring
            DURABILITY, not for keeping a sentence the code does not honour.
          */}
          <p>
            ledger files a bounded batch at a time, and {partial.remaining}{" "}
            {partial.remaining === 1 ? "message" : "messages"} from{" "}
            <span className="font-mono">{partial.domain}</span> {partial.remaining === 1 ? "is" : "are"} still
            held. Nothing is lost, and ledger will keep trying to file{" "}
            {partial.remaining === 1 ? "it" : "them"} while you are here. You can also finish this any time from
            Settings, under Held mail.
          </p>
          <Button variant="primary" disabled={busy} onClick={() => void confirm(partial.domain, partial.scope)}>
            File the rest
          </Button>
          <Button variant="ghost" disabled={busy} onClick={handOff}>
            Carry on — I&rsquo;ll finish this in Settings
          </Button>
        </Notice>
      )}

      {/*
        ---- One list, because the app cannot honestly make two ----

        This was two sections: "Google's confirmation" and "your first bank
        email", split by a predicate that asked whether the outer domain was
        Google's. That predicate could not be generalised, it could only be
        deleted — a bank that registers this address DIRECTLY has no inner
        domain either, so nothing in the data distinguishes a provider's
        confirmation from a bank's first alert. Guessing would either hide the
        confirmation (what it did for every non-Gmail user) or file a bank under
        a heading about forwarding.

        So every held message is listed with the one thing that is actually
        known about it — the domain that SIGNED it — and the two actions are
        offered side by side. The user knows which message they are waiting for.
      */}
      <SectionLabel as="h2">Mail held for you</SectionLabel>

      {/*
        The one thing a user can get wrong here, above the control that does it.
        Rendered only when there is something to press: a warning about a button
        that is not on screen is noise, and noise is how the real one stops being
        read. Not `announce` — it is present at first paint, which is exactly the
        case `Notice`'s doc says must not be an alert.
      */}
      {items.length > 0 && (
        <Notice title={TRUST_ONLY_YOUR_BANK.title} testId="verification-trust-warning">
          <p>{TRUST_ONLY_YOUR_BANK.body}</p>
        </Notice>
      )}

      {items.length === 0 ? (
        <Notice testId="verification-no-bank-mail">
          <p>
            {readingCode
              ? "Nothing has arrived yet. If your mail provider sends a confirmation code, it will appear here — and so will your first bank email. This step finishes on its own when a bank email arrives, so you can leave the app open or come back later."
              : "Nothing has arrived yet. This step finishes on its own when your first bank email arrives, so you can leave the app open or come back later. Anything ledger cannot prove came from a bank appears here rather than being filed."}
          </p>
        </Notice>
      ) : (
        items.map((item) => {
          const basis = trustBasis(item);
          const request = trustRequest(item);
          const openable = readingCode && couldBeConfirmation(item);
          const open = opened !== null && opened.id === item.id;
          const arrived = Date.parse(item.receivedAt);
          return (
            <Notice key={item.id} title={basis.label} testId={`verification-item-${item.id}`}>
              <p className="text-xs text-muted">Verification: {basis.source}</p>
              <p className="text-xs text-muted">
                DKIM: {item.dkim} · ARC: {item.arc}
              </p>
              {Number.isFinite(arrived) && (
                <p className="text-xs text-muted">Arrived {sinceLabel(arrived, Date.now())}</p>
              )}

              {/*
                Reading a body is offered only for a message whose outer domain
                the SERVER verified — the same bar `trustRequest` uses. An
                unverified message is still listed, so it is not a mystery, but
                nothing is lifted out of it and offered as an action.
              */}
              {openable && (
                <Button variant="secondary" onClick={() => setOpenId(open ? null : item.id)}>
                  {open ? "Hide this message" : "Look for a confirmation code"}
                </Button>
              )}

              {open && scan === null && (
                <p data-testid="verification-no-body">
                  This message is held but its contents were not sent to this device. Open it from held mail in
                  settings once you are through setup.
                </p>
              )}
              {open && scan !== null && (
                <>
                  {scan.code !== null ? (
                    <>
                      <p data-testid="verification-code" className="font-mono text-2xl select-all tnum">
                        {scan.code}
                      </p>
                      <Button variant="primary" onClick={() => void onCopyCode(scan.code as string)}>
                        {copied ? "Copied" : "Copy code"}
                      </Button>
                      <p className="text-xs text-muted">
                        Paste this into the confirmation box in your mail provider&rsquo;s forwarding settings.
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
                  {scan.link !== null && (
                    <a
                      data-testid="verification-open-link"
                      href={scan.link}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="min-h-11 inline-flex items-center text-sm underline"
                    >
                      {/*
                        The domain named here is the one the SERVER verified, not
                        a host parsed out of the link — and `scanForCode` was
                        given that same domain as the only host it may return a
                        link on, so the sentence and the destination cannot come
                        apart.
                      */}
                      Open the confirmation link on {linkHost}
                    </a>
                  )}
                </>
              )}

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

      {/*
        The way out of a wrong belief, and the reason `expectConfirmation` is
        allowed to be a belief at all. It says what it does — reveals the reader —
        and promises nothing about whether a code exists.
      */}
      {!readingCode && (
        <Button variant="ghost" onClick={() => setCodeSought(true)}>
          My provider did send a confirmation code
        </Button>
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
