/**
 * The recovery step. Two ceremonies, one step of the machine.
 *
 * # Which one is on the glass
 *
 * `keyStatus` decides, and there are exactly two answers this screen serves:
 *
 *   - **`unpublished`** — the account has no key material. Generate a phrase and
 *     a key set, show the words, make the user prove they wrote them down, then
 *     wrap, publish and store the handles.
 *   - **`needs_recovery`** — the account has keys and this browser does not.
 *     This is a reinstall, a cleared cache, a private window or a second device.
 *     The phrase is the only way through, because it is the only thing that
 *     exists: the server holds a blob it cannot open and nothing else.
 *
 * # There is no skip, and there is no way to defer
 *
 * `v2/onboarding.ts`'s milestone table refuses to walk past a gap, and this step
 * is the gap until `keysReady` is true. That is not friction for its own sake:
 * on iOS the native design could treat the phrase as a backstop because iCloud
 * Keychain syncs a device wrap key, and a browser has no Keychain. A user who
 * skipped this and cleared their site data would have an account nobody could
 * open — including the operator, who holds nothing that would help. The copy in
 * `RECOVERY_PHRASE_COPY` says that in those words.
 *
 * # There is no quiz, and there will not be one
 *
 * This step used to hide the words and ask for three of them back by position.
 * It is gone, on the operator's instruction and in his words: **the user is
 * trusted to store the words the way they wish, and the app does not need to
 * double check.**
 *
 * The reasoning holds up on its own. Typing three words back proves the phrase
 * was in short-term memory thirty seconds ago; it proves nothing about whether
 * it was written on paper, saved to a password manager, or screenshotted — which
 * is the only thing that matters. So it bought very little, and it cost every
 * single user real friction in their first minute with the product.
 *
 * What it did NOT buy is worth stating too, because "we removed a safety check"
 * is the wrong reading: the warning is untouched. The words are still shown in
 * full, once, under a danger notice that says clearing this browser without them
 * loses the account and that nobody — the operator included — can let you back
 * in. That sentence is the safety property. The quiz was a ritual around it.
 *
 * # Nothing is published before the user has said they have the words
 *
 * `establishAccountKeys` awaits `confirmPhrase` before it wraps or publishes,
 * and this screen resolves that promise when the user says they have the words.
 * So a user who closes the tab mid-ceremony leaves an account with no published
 * keys — a state the next boot handles by starting the ceremony again with a NEW
 * phrase, rather than one with keys nobody recorded the phrase for. Removing the
 * quiz moved which press resolves it and nothing else.
 */

import { useCallback, useRef, useState } from "react";

import { Button } from "../../components/ui/Button";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { Notice, Step } from "./Shell";
import { RECOVERY_ENTRY_COPY, RECOVERY_PHRASE_COPY } from "../../v2/onboarding";
import {
  establishAccountKeys,
  recoverAccountKeys,
  type KeyVault,
  type KeysIO,
  type PublishedKeys,
} from "../../v2/keys";
import { validatePhrase } from "@ledger/client/crypto/phrase";
import { webPlatform } from "@ledger/client/platform.web";

export interface RecoveryPhraseProps {
  accountId: string;
  vault: KeyVault;
  io: KeysIO;
  /** `null` when the account has published nothing — the generate ceremony. */
  published: PublishedKeys | null;
  /** Called once this device holds usable keys. */
  onSecured: () => void;
}

export function RecoveryPhrase(props: RecoveryPhraseProps) {
  return props.published === null ? <GeneratePhrase {...props} /> : <EnterPhrase {...props} published={props.published} />;
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

type GeneratePhase = "working" | "showing" | "publishing" | "failed";

function GeneratePhrase({ accountId, vault, io, onSecured }: RecoveryPhraseProps) {
  const [phase, setPhase] = useState<GeneratePhase>("working");
  const [phrase, setPhrase] = useState<string | null>(null);
  // Resolves the `confirmPhrase` promise inside `establishAccountKeys`. A ref
  // rather than state: it is a continuation, not something rendered.
  const confirmed = useRef<(() => void) | null>(null);
  const started = useRef(false);

  const begin = useCallback(() => {
    if (started.current) return;
    started.current = true;
    setPhase("working");
    void establishAccountKeys({
      accountId,
      vault,
      io,
      confirmPhrase: (p) =>
        new Promise<void>((resolve) => {
          setPhrase(p);
          setPhase("showing");
          confirmed.current = resolve;
        }),
    }).then(
      () => onSecured(),
      () => {
        // The phrase is unchanged and still on this device, so the retry is the
        // publish and not the whole ceremony.
        setPhase("failed");
      },
    );
  }, [accountId, vault, io, onSecured]);

  // Started from render on first pass rather than from an effect: an effect
  // would run after a paint that has nothing on it, and this screen's first
  // paint is the spinner either way.
  if (!started.current) begin();

  if (phase === "working" || phrase === null) {
    return (
      <Step title={RECOVERY_PHRASE_COPY.title} testId="onboarding-recovery">
        <div className="flex items-center gap-3 text-muted" role="status">
          <PixelSpinner size={12} />
          <span className="text-sm">Generating your keys…</span>
        </div>
      </Step>
    );
  }

  if (phase === "showing" || phase === "publishing") {
    return (
      <Step
        title={RECOVERY_PHRASE_COPY.title}
        intro={RECOVERY_PHRASE_COPY.intro}
        testId="onboarding-recovery"
        footer={
          <Button
            variant="primary"
            disabled={phase === "publishing"}
            onClick={() => {
              // The one press. It says the words are kept somewhere; the app
              // takes that at its word and publishes. See the header for why
              // there is nothing here that checks.
              setPhase("publishing");
              confirmed.current?.();
            }}
          >
            {phase === "publishing" ? RECOVERY_PHRASE_COPY.working : RECOVERY_PHRASE_COPY.recorded}
          </Button>
        }
      >
        <ol
          data-testid="recovery-phrase-words"
          className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 rounded-[var(--radius)] border border-border bg-surface"
        >
          {phrase.split(" ").map((word, i) => (
            <li key={`${i}-${word}`} className="flex gap-2 text-base font-mono">
              <span className="text-muted tabular-nums w-6 text-right">{i + 1}</span>
              <span>{word}</span>
            </li>
          ))}
        </ol>
        <Notice tone="danger" title="If you lose these words">
          <p>{RECOVERY_PHRASE_COPY.noWayBack}</p>
          {/* Directly above the advice about where to keep them, because that
              is the decision it changes — see the copy's own comment. */}
          <p>{RECOVERY_PHRASE_COPY.alsoWrites}</p>
          <p>{RECOVERY_PHRASE_COPY.advice}</p>
        </Notice>
        {/*
          The encryption pair, back on this step because the step it had been
          moved to no longer exists. It was moved to keep this screen short, and
          that pressure is real — but the two halves have to be on screen
          together somewhere in this ceremony, and there is now exactly one
          screen in it. They stay ADJACENT and in this order: the claim that is
          true, and immediately the window it does not close. Splitting them is
          how "encrypted at rest" turns into "we can't see it" in a reader's
          head. It sits below the words and the danger notice, so the thing to
          DO is still above it.
        */}
        <Notice title="What this protects">
          <p>{RECOVERY_PHRASE_COPY.whatItProtects}</p>
          <p>{RECOVERY_PHRASE_COPY.whatItDoesNot}</p>
        </Notice>
      </Step>
    );
  }

  if (phase === "failed") {
    return (
      <Step
        title={RECOVERY_PHRASE_COPY.title}
        testId="onboarding-recovery"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              started.current = false;
              setPhase("working");
              begin();
            }}
          >
            Try again
          </Button>
        }
      >
        <Notice tone="danger" announce title="Not finished yet">
          <p>{RECOVERY_PHRASE_COPY.failed}</p>
        </Notice>
      </Step>
    );
  }

  /*
    Unreachable: `phase` is one of four and the three above are handled. Kept as
    an explicit nothing rather than a fifth screen, because the state that used
    to be here — the quiz — was deleted, not hidden.
  */
  return null;
}

// ---------------------------------------------------------------------------
// Recovering
// ---------------------------------------------------------------------------

function EnterPhrase({
  accountId,
  vault,
  published,
  onSecured,
}: RecoveryPhraseProps & { published: PublishedKeys }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = useCallback(async () => {
    // Checked BEFORE the KDF runs, so a typo is named in a millisecond instead
    // of after a several-second Argon2id pass that can only say "no".
    const verdict = validatePhrase(draft, webPlatform);
    if (!verdict.ok) {
      setProblem(verdict.message);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await recoverAccountKeys({ accountId, phrase: verdict.phrase, published, vault });
      onSecured();
    } catch {
      setProblem(RECOVERY_ENTRY_COPY.failed);
    } finally {
      setBusy(false);
    }
  }, [draft, accountId, published, vault, onSecured]);

  return (
    <Step
      title={RECOVERY_ENTRY_COPY.title}
      testId="onboarding-recovery-entry"
      /*
        Above the title, because it is the answer to the question the person is
        actually holding: "did my sign-in work?" This screen is what the gate
        puts up the moment a passkey sign-in succeeds, and until this line
        existed it never said so — which read as sign-in being broken.
      */
      intro={
        <>
          <strong className="text-fg font-semibold" data-testid="signed-in-note">
            {RECOVERY_ENTRY_COPY.signedIn}
          </strong>{" "}
          {RECOVERY_ENTRY_COPY.intro}
        </>
      }
      footer={
        <Button variant="primary" disabled={busy || draft.trim() === ""} onClick={() => void submit()}>
          {busy ? RECOVERY_ENTRY_COPY.working : RECOVERY_ENTRY_COPY.action}
        </Button>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">{RECOVERY_ENTRY_COPY.label}</span>
        {/*
          A textarea rather than twelve inputs: a phrase arrives pasted from a
          password manager as one string far more often than it is typed word by
          word, and twelve fields make that paste a manual redistribution.
          `text-base` is the 16px rule — anything smaller zooms iOS Safari.
        */}
        <textarea
          value={draft}
          rows={3}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-testid="recovery-entry-phrase"
          placeholder={RECOVERY_ENTRY_COPY.placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(null);
          }}
          className="w-full min-h-11 p-3 rounded-[var(--radius)] border border-border bg-surface text-base font-mono"
        />
      </label>
      {problem !== null && (
        <p role="alert" className="text-sm text-bad">
          {problem}
        </p>
      )}
      <Notice tone="danger" title="There is no other way in">
        <p>{RECOVERY_ENTRY_COPY.noWayBack}</p>
        <p>{RECOVERY_ENTRY_COPY.alsoWrites}</p>
      </Notice>
    </Step>
  );
}
