/**
 * The first screen: create an account against an invite, or sign in.
 *
 * # Sign-in is USERNAME-LESS, and this screen is where that is visible
 *
 * There is no email field, no username field and no password field anywhere in
 * this file, because `internal/v2/auth/passkey.go` requires resident/discoverable
 * credentials: the authenticator returns the account's user handle inside the
 * signed assertion, and `ValidateDiscoverableLogin` resolves the account from
 * bytes it verified. A username box would not be redundant, it would be a field
 * the server ignores. `V2Handle.signIn()` takes no argument at all, and the
 * button calls it with none — `Onboarding.test.tsx` asserts that literally,
 * because "we pass nothing" is exactly the kind of claim a later refactor
 * quietly breaks by threading a hint through.
 *
 * # A returning user is never asked for a code
 *
 * The invite code belongs to `signUp` and only to `signUp`. Sign-in is one
 * button, and a `403 not_invited` cannot arise from it: the code is redeemed by
 * `POST /api/v1/auth/passkey/register/begin` and nothing else looks at one.
 *
 * # `not_invited` is matched STRUCTURALLY
 *
 * `isPasskeyError(err) && err.passkeyKind === "not_invited"`, never a string
 * match on a message. `session.ts` says why the class test alone is not enough
 * (a bundler with two copies of a module makes `instanceof` fail silently, in
 * the wrong direction) and `classifyPasskeyFailure` has already turned the
 * server's `403` + `not_invited` pair into that kind.
 *
 * # The recovery warning is on this screen, before the passkey exists
 *
 * There is no account recovery and there cannot be one — see
 * `RECOVERY_WARNING`. A consequence that severe belongs in front of the person
 * *before* they create the credential it is about, not in a settings screen they
 * will not open, and not as a toast afterwards, which is a receipt. The offer of
 * a second passkey follows immediately on success, on this same screen, for the
 * same reason: it is the only backup the product can offer and the only moment
 * the user is thinking about the question.
 */

import { useCallback, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { wipeLocalData } from "../../v2/BootGate";
import { ADD_PASSKEY_COPY, RECOVERY_WARNING } from "../../v2/onboarding";
import { passkeyFailureCopy as failureCopy } from "../../v2/passkeyCopy";
import { addPasskey } from "../../v2/passkeyAdd";
import {
  isAccountMismatch,
  isEnrollmentError,
  isPasskeyError,
  type PasskeyFailureKind,
  type V2Handle,
} from "../../v2/session";
import { DevSignInPanel } from "./DevSignInPanel";
import { Notice, Step } from "./Shell";

export interface WelcomeProps {
  handle: V2Handle;
  /** The boot gate's `again`: re-runs boot, which is what leaves this screen. */
  done: () => void;
  /** Injected by tests; defaults to the real add-passkey ceremony. */
  addSecondPasskey?: (handle: V2Handle) => Promise<string>;
  /** Injected by tests; defaults to {@link wipeLocalData}, which reloads. */
  wipe?: (handle: V2Handle) => Promise<void>;
}

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; what: "create" | "signin" }
  /** The account exists. The only thing left is the backup nobody else can give. */
  | { kind: "created"; adding: boolean; added: boolean; note: string | null }
  /** `not_invited`. `failure` carries a LATER failure of the retry, if any. */
  | { kind: "not_invited"; failure: PasskeyFailureKind | null }
  /**
   * This profile holds another account's database. Only a wipe clears it.
   *
   * `unsynced` is the count of locally-authored ops that have never reached the
   * server — see the screen for why it is the difference between an honest
   * button and a destructive one.
   */
  | { kind: "account_mismatch"; bound: string; offered: string; unsynced: number; wiping: boolean; armed: boolean };

export function Welcome({
  handle,
  done,
  addSecondPasskey = (h) => addPasskey({ client: h.client }),
  wipe = wipeLocalData,
}: WelcomeProps) {
  /** A string draft all the way to submit — never coerced on keystroke. */
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [failure, setFailure] = useState<PasskeyFailureKind | null>(null);

  const busy = phase.kind === "busy";
  const canCreate = code.trim() !== "" && !busy;

  /**
   * Files a failure without losing where the user is.
   *
   * Returns true when it handled the error as a screen of its own. The
   * `not_invited` case is the reason this exists: a retry from that screen that
   * hits a DIFFERENT failure used to reset `phase` to `idle`, throwing the user
   * back to the front door with their code gone from view and no explanation —
   * so a rate limit or a dropped connection looked like the app had simply
   * forgotten what they were doing. A later failure now stays on whichever
   * screen raised it.
   */
  const fail = useCallback((error: unknown, from: Phase): void => {
    if (isAccountMismatch(error)) {
      // Counted BEFORE the wipe is ever offered. `Client.pending` is the outbox
      // — ops this device authored that have not reached the server — and it is
      // persisted only in the local store, which is what the wipe destroys.
      let unsynced = 0;
      try {
        unsynced = handle.client.pending.length;
      } catch {
        // A store that cannot be read is one whose contents cannot be vouched
        // for either. Treating that as "nothing unsynced" would be the same
        // false reassurance by another route, so it counts as unknown-and-risky.
        unsynced = -1;
      }
      setPhase({
        kind: "account_mismatch",
        bound: error.boundUserId,
        offered: error.offeredUserId,
        unsynced,
        wiping: false,
        armed: false,
      });
      return;
    }
    const kind = isPasskeyError(error) ? error.passkeyKind : "unavailable";
    if (isPasskeyError(error) && error.passkeyKind === "not_invited") {
      setPhase({ kind: "not_invited", failure: from.kind === "not_invited" ? "not_invited" : null });
      return;
    }
    if (from.kind === "not_invited") {
      setPhase({ kind: "not_invited", failure: kind });
      return;
    }
    setFailure(kind);
    setPhase({ kind: "idle" });
  }, [handle]);

  const create = useCallback(async () => {
    const from = phase;
    setFailure(null);
    setPhase({ kind: "busy", what: "create" });
    try {
      await handle.signUp(code.trim());
      setPhase({ kind: "created", adding: false, added: false, note: null });
    } catch (error) {
      fail(error, from);
    }
  }, [handle, code, phase, fail]);

  const signIn = useCallback(async () => {
    const from = phase;
    setFailure(null);
    setPhase({ kind: "busy", what: "signin" });
    try {
      // No argument, deliberately. See this module's header.
      await handle.signIn();
      done();
    } catch (error) {
      // An ENROLMENT failure is not a sign-in failure, and reporting it as one
      // is what made a second device a dead end: `session.ts`'s `ceremony`
      // persists the session and THEN enrols, so by the time this throws the
      // user is signed in, their account is fine, and "the server refused the
      // request — nothing was created on this device" is false on both counts.
      // It is also the exact state the boot gate exists to explain: `done()`
      // re-runs boot, which calls `enrol()` again and puts up the wall that
      // carries this device's enrolment code. So hand off rather than report.
      if (isEnrollmentError(error)) {
        done();
        return;
      }
      fail(error, from);
    }
  }, [handle, done, phase, fail]);

  const startFresh = useCallback(async () => {
    setPhase((p) => (p.kind === "account_mismatch" ? { ...p, wiping: true } : p));
    // `wipeLocalData` ends in a reload, so there is deliberately nothing after
    // this: the handle and the engine are memoised for the tab's lifetime and
    // both are dead once their database is.
    await wipe(handle);
  }, [wipe, handle]);

  const addAnother = useCallback(async () => {
    setPhase((p) => (p.kind === "created" ? { ...p, adding: true, note: null } : p));
    try {
      await addSecondPasskey(handle);
      setPhase({ kind: "created", adding: false, added: true, note: ADD_PASSKEY_COPY.done });
    } catch (error) {
      // A failure here never blocks the account: it already exists and is
      // usable. Saying so is the difference between a warning and a dead end.
      const kind = isPasskeyError(error) ? error.passkeyKind : "unavailable";
      setPhase({
        kind: "created",
        adding: false,
        added: false,
        note:
          kind === "cancelled"
            ? "No second passkey was added. You can add one from Settings."
            : `${failureCopy(kind).title}. Your account is fine — you can add a second passkey from Settings.`,
      });
    }
  }, [handle, addSecondPasskey]);

  // -- the account exists; the backup is the last thing --------------------
  if (phase.kind === "created") {
    return (
      <Step
        testId="welcome-created"
        title="Your account is ready"
        intro="One thing first — it is the one thing nobody can fix for you later."
        footer={
          <>
            <Button variant="primary" disabled={phase.adding} onClick={() => void addAnother()}>
              {phase.adding ? "Waiting for your authenticator…" : ADD_PASSKEY_COPY.action}
            </Button>
            <Button variant="ghost" disabled={phase.adding} onClick={done}>
              {phase.added ? "Carry on" : ADD_PASSKEY_COPY.skip}
            </Button>
          </>
        }
      >
        <Notice tone="danger" title={RECOVERY_WARNING.title} testId="recovery-warning">
          <p>{RECOVERY_WARNING.body}</p>
          <p>{RECOVERY_WARNING.advice}</p>
        </Notice>
        <Notice title={ADD_PASSKEY_COPY.title}>
          <p>{ADD_PASSKEY_COPY.body}</p>
        </Notice>
        {phase.note !== null && (
          <p data-testid="add-passkey-note" role="status" className="text-sm text-muted">
            {phase.note}
          </p>
        )}
      </Step>
    );
  }

  // -- this browser holds another account's database ----------------------
  if (phase.kind === "account_mismatch") {
    return (
      <Step
        testId="welcome-account-mismatch"
        title="This browser is already holding another account"
        intro="Your passkey is fine and the server accepted it. The data left here by a different ledger account is in the way."
      >
        <Notice tone="danger" announce title="Two accounts cannot share one browser profile" testId="account-mismatch">
          {/* The notice's first paragraph said ledger "keeps each account's
              records in this browser's own storage and will not mix two of them
              together" — the title again, in a longer sentence. The title is
              the claim; this is now only what to do about it. */}
          {/*
            The narrow truth, and only the narrow truth. This used to say the
            other account's records were "untouched on the server" full stop,
            which is false for anything authored offline and never pushed:
            `Client.pending` lives ONLY in the local store, and the wipe deletes
            that store unconditionally. On a money app that made a destructive
            button carry a reassurance it could not honour.
          */}
          <p>
            Clearing this browser&rsquo;s ledger data lets you sign in. Anything the other account has{" "}
            <strong>already synced</strong> is safe on the server — signing in as that account on a device it has
            a passkey for brings it all back.
          </p>
        </Notice>

        {phase.unsynced !== 0 && (
          <Notice
            tone="danger"
            announce
            title={
              phase.unsynced < 0
                ? "ledger cannot tell whether there is unsent work here"
                : `${String(phase.unsynced)} ${phase.unsynced === 1 ? "change has" : "changes have"} never been sent to the server`
            }
            testId="unsynced-warning"
          >
            <p>
              {phase.unsynced < 0
                ? "This browser's ledger data could not be read well enough to say whether it holds anything the server has not received. Clearing it would destroy anything that is there."
                : `${phase.unsynced === 1 ? "It was" : "They were"} recorded on this device for the other account and exist nowhere else. Clearing this browser's data deletes ${phase.unsynced === 1 ? "it" : "them"} permanently. No copy is kept, and nobody can restore ${phase.unsynced === 1 ? "it" : "them"}.`}
            </p>
            <p>
              To keep {phase.unsynced === 1 ? "it" : "them"}, go back and sign in as the other account first, on a
              device holding its passkey. Once it has synced, this data is safe to clear.
            </p>
            {/*
              An explicit acknowledgement, not a second confirm dialog: the
              consequence is unrecoverable and the user should have to say they
              understand it rather than merely tap past it. Same argument as the
              home-currency step.
            */}
            <label className="min-h-11 flex items-center gap-3 text-sm leading-relaxed">
              <input
                type="checkbox"
                className="w-5 h-5 accent-[var(--color-accent)] rounded-[var(--radius)]"
                aria-label="I understand this unsent work will be destroyed"
                checked={phase.armed}
                disabled={phase.wiping}
                onChange={() =>
                  setPhase((p) => (p.kind === "account_mismatch" ? { ...p, armed: !p.armed } : p))
                }
              />
              <span>I understand this unsent work will be destroyed.</span>
            </label>
          </Notice>
        )}

        {/*
          SPACING IS THE SAFETY MECHANISM HERE, and it is deliberate.

          The acknowledgement checkbox is the last thing inside the warning above
          and this is the button it arms. At the default rhythm they sat about
          36px apart (the notice's `p-4`, plus `Step`'s `gap-5`) — under the
          44px this codebase holds every touch target to, and therefore within
          one thumb's reach of each other. A fast double-tap could arm the
          checkbox and fire the wipe in a single gesture, which on this screen
          means accidental, permanent, unrecoverable destruction of a user's
          unsynced records.

          `pt-6` adds 24px, putting roughly 60px between them: past the
          convention, and past the distance a double-tap can span. Not another
          confirmation dialog — nothing else on this screen is destructive, so
          the answer is distance, not a second thing to tap through. If this
          layout is ever restyled, this gap is load-bearing.

          `gap-5` inside, not `gap-3`: these two buttons were direct children of
          `Step` before this wrapper existed and sat 20px apart. Wrapping them
          would otherwise have narrowed that to 12px as a side effect — widening
          the gap that guards the destructive button while quietly tightening the
          one between it and "Go back". A mis-tap there resolves toward the
          harmless button either way, so this is not the same class of hazard,
          but there is no reason to prefer 12px and the change would have been
          incidental rather than chosen.
        */}
        <div className="pt-6 flex flex-col gap-5">
          <Button
            variant="danger"
            disabled={phase.wiping || (phase.unsynced !== 0 && !phase.armed)}
            onClick={() => void startFresh()}
          >
            {phase.wiping ? "Clearing…" : "Clear this browser's data and start fresh"}
          </Button>
          <Button variant="ghost" disabled={phase.wiping} onClick={() => setPhase({ kind: "idle" })}>
            Go back
          </Button>
        </div>
      </Step>
    );
  }

  // -- the invite was refused ---------------------------------------------
  if (phase.kind === "not_invited") {
    const later = phase.failure === null || phase.failure === "not_invited" ? null : failureCopy(phase.failure);
    return (
      <Step
        testId="welcome-not-invited"
        title="ledger is invite-only right now"
        intro="This is a closed beta, so an account needs a code. The one you used was not accepted."
      >
        {/*
          A LATER failure of the retry, kept on this screen. Bouncing back to the
          front door for it would lose the code the user was mid-way through
          correcting, and read as the app forgetting what they were doing.
        */}
        {later !== null && (
          <Notice tone="danger" announce title={later.title} testId="not-invited-failure">
            <p>{later.body}</p>
          </Notice>
        )}

        <Notice testId="not-invited">
          <p>
            The person running this beta hands out codes one at a time, and each one works once. A code that has
            already been used will not work again.
          </p>
          <p>There is no waiting list to join from inside the app.</p>
        </Notice>

        <InviteField code={code} setCode={setCode} disabled={busy} onSubmit={() => void create()} />

        <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
          Try this code
        </Button>
        <Button variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
          Go back
        </Button>
      </Step>
    );
  }

  // -- the front door ------------------------------------------------------
  const copy = failure === null ? null : failureCopy(failure);
  return (
    <Step
      testId="welcome"
      title="ledger"
      intro="Your bank already emails you every transaction. Forward those emails here and ledger keeps the running picture."
    >
      {copy !== null && (
        <Notice tone="danger" announce title={copy.title} testId="welcome-failure">
          <p>{copy.body}</p>
        </Notice>
      )}

      <Notice tone="danger" title={RECOVERY_WARNING.title} testId="recovery-warning">
        <p>{RECOVERY_WARNING.body}</p>
        <p>{RECOVERY_WARNING.advice}</p>
      </Notice>

      <div className="flex flex-col gap-3">
        <SectionLabel as="h2">Create an account</SectionLabel>
        <InviteField code={code} setCode={setCode} disabled={busy} onSubmit={() => void create()} />
        <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
          {phase.kind === "busy" && phase.what === "create" ? <PixelSpinner size={12} /> : null}
          Create my account
        </Button>
      </div>

      <div className="flex flex-col gap-3 pt-2 border-t border-border">
        <SectionLabel as="h2">Already have an account</SectionLabel>
        <p className="text-sm leading-relaxed text-muted">
          Your passkey knows which account it belongs to, so there is nothing to type.
        </p>
        <Button variant="secondary" disabled={busy} onClick={() => void signIn()}>
          {phase.kind === "busy" && phase.what === "signin" ? <PixelSpinner size={12} /> : null}
          Sign in
        </Button>
      </div>

      {/*
        Below the real controls, never above them, and folded out of a production
        bundle by the constant rather than merely hidden. See DevSignInPanel.
      */}
      {import.meta.env.DEV && <DevSignInPanel disabled={busy} onPrefill={setCode} />}
    </Step>
  );
}

/**
 * The one text field in this flow.
 *
 * `autoComplete="one-time-code"` rather than anything account-shaped: an invite
 * code is not a username and must not be offered to a password manager as one.
 */
function InviteField({
  code,
  setCode,
  disabled,
  onSubmit,
}: {
  code: string;
  setCode: (v: string) => void;
  disabled: boolean;
  onSubmit: () => void;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm text-muted">Invite code</span>
      <Input
        aria-label="Invite code"
        value={code}
        disabled={disabled}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        placeholder="Paste the code you were sent"
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
      />
    </label>
  );
}
