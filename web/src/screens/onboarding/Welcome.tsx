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
import { addPasskey } from "../../v2/passkeyAdd";
import { isAccountMismatch, isPasskeyError, type PasskeyFailureKind, type V2Handle } from "../../v2/session";
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

/**
 * What each failure says. Every arm is a true sentence about what happened and,
 * where it matters, about whether pressing again could plausibly help — the
 * distinction `BootGate`'s walls make and for the same reason.
 */
function failureCopy(kind: PasskeyFailureKind): { title: string; body: string } {
  switch (kind) {
    case "unsupported":
      return {
        title: "This browser cannot use passkeys",
        body: "ledger signs you in with a passkey and this browser has no support for them. A current Safari, Chrome, Edge or Firefox will work.",
      };
    case "cancelled":
      return {
        title: "The passkey prompt was closed",
        body: "Nothing was sent and nothing was created. Press the button again when you are ready.",
      };
    case "rejected":
      return {
        title: "That passkey was not accepted",
        body: "The signature did not check out, or the credential is not one this account knows. If you are trying to get into an existing account, use the device that holds its passkey.",
      };
    case "rate_limited":
      return {
        title: "Too many attempts just now",
        body: "The server is asking for a pause. Wait a minute and try again — nothing is wrong with your passkey.",
      };
    case "offline":
      return {
        title: "ledger could not reach the server",
        body: "There was no answer at all, which is almost always the connection. Nothing was created, so trying again is safe.",
      };
    case "not_invited":
    case "unavailable":
      return {
        title: "That did not go through",
        body: "The server refused the request. Nothing was created on this device, so trying again is safe.",
      };
  }
}

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; what: "create" | "signin" }
  /** The account exists. The only thing left is the backup nobody else can give. */
  | { kind: "created"; adding: boolean; added: boolean; note: string | null }
  /** `not_invited`. `failure` carries a LATER failure of the retry, if any. */
  | { kind: "not_invited"; failure: PasskeyFailureKind | null }
  /** This profile holds another account's database. Only a wipe clears it. */
  | { kind: "account_mismatch"; bound: string; offered: string; wiping: boolean };

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
      setPhase({ kind: "account_mismatch", bound: error.boundUserId, offered: error.offeredUserId, wiping: false });
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
  }, []);

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
            ? "No second passkey was added. You can add one later from Settings."
            : `${failureCopy(kind).title}. Your account is fine — a second passkey can be added later from Settings.`,
      });
    }
  }, [handle, addSecondPasskey]);

  // -- the account exists; the backup is the last thing --------------------
  if (phase.kind === "created") {
    return (
      <Step
        testId="welcome-created"
        title="Your account is ready"
        intro="One thing before you carry on, and it is the one thing nobody can fix for you later."
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
        intro="Your passkey is fine and the server accepted it. What is in the way is the data left here by a different ledger account."
      >
        <Notice tone="danger" announce title="Two accounts cannot share one browser profile" testId="account-mismatch">
          <p>
            ledger keeps each account&rsquo;s records in this browser&rsquo;s own storage, and it will not mix two
            of them together — sync positions from one account applied to another&rsquo;s records would corrupt
            both. So it refused rather than letting you in.
          </p>
          <p>
            Clearing this browser&rsquo;s ledger data lets you sign in. It removes only what is stored{" "}
            <em>here</em>: the other account, its records and everything you have recorded for it are untouched on
            the server, and signing in as that account on its own device brings it all back.
          </p>
        </Notice>
        <Button variant="danger" disabled={phase.wiping} onClick={() => void startFresh()}>
          {phase.wiping ? "Clearing…" : "Clear this browser's data and start fresh"}
        </Button>
        <Button variant="ghost" disabled={phase.wiping} onClick={() => setPhase({ kind: "idle" })}>
          Go back
        </Button>
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
            Codes are handed out one at a time by the person running this beta, and each one works once — a code
            that has already been redeemed will not work again.
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
      intro="Your bank already emails you every transaction. Forward those emails here and ledger keeps the running picture — on your device, for you only."
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
