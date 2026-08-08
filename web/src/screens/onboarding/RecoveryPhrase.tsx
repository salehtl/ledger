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
 * # The confirmation is a check, not a claim
 *
 * "I have written these down" is a claim about the past that a person makes
 * while looking at the words. So the tick is followed by three words asked for
 * by position, chosen at random once per screen, with the phrase no longer
 * visible. It is the only difference between a phrase that was recorded and one
 * that was read.
 *
 * # Nothing is published before the user has confirmed
 *
 * `establishAccountKeys` awaits `confirmPhrase` before it wraps or publishes,
 * and this screen resolves that promise from the confirmation step. So a user
 * who closes the tab mid-ceremony leaves an account with no published keys — a
 * state the next boot handles by starting the ceremony again with a NEW phrase,
 * rather than one with keys nobody recorded the phrase for.
 */

import { useCallback, useMemo, useRef, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
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
import { normalizePhrase, validatePhrase } from "@ledger/client/crypto/phrase";
import { webPlatform } from "@ledger/client/platform.web";

/** How many words the confirmation asks for. Three of twelve; see the header. */
export const CONFIRM_WORD_COUNT = 3;

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

type GeneratePhase = "working" | "showing" | "confirming" | "publishing" | "failed";

function GeneratePhrase({ accountId, vault, io, onSecured }: RecoveryPhraseProps) {
  const [phase, setPhase] = useState<GeneratePhase>("working");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>(() => Array<string>(CONFIRM_WORD_COUNT).fill(""));
  const [wrong, setWrong] = useState(false);
  // Resolves the `confirmPhrase` promise inside `establishAccountKeys`. A ref
  // rather than state: it is a continuation, not something rendered.
  const confirmed = useRef<(() => void) | null>(null);
  const started = useRef(false);

  /**
   * Which positions the confirmation asks for: three distinct 1-based indices,
   * drawn once, from the platform's randomness rather than `Math.random` — a
   * predictable choice would let a user who screenshotted only the first line
   * pass.
   */
  const positions = useMemo(() => pickPositions(CONFIRM_WORD_COUNT), []);

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

  if (phase === "showing") {
    return (
      <Step
        title={RECOVERY_PHRASE_COPY.title}
        intro={RECOVERY_PHRASE_COPY.intro}
        testId="onboarding-recovery"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setPhase("confirming");
            }}
          >
            {RECOVERY_PHRASE_COPY.recorded}
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
        <Notice title="What this protects">
          <p>{RECOVERY_PHRASE_COPY.whatItProtects}</p>
          <p>{RECOVERY_PHRASE_COPY.whatItDoesNot}</p>
        </Notice>
        <Notice tone="danger" title="If you lose these words">
          <p>{RECOVERY_PHRASE_COPY.noWayBack}</p>
          {/* Directly above the advice about where to keep them, because that
              is the decision it changes — see the copy's own comment. */}
          <p>{RECOVERY_PHRASE_COPY.alsoWrites}</p>
          <p>{RECOVERY_PHRASE_COPY.advice}</p>
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

  const words = phrase.split(" ");
  const allAnswered = answers.every((a) => normalizePhrase(a) !== "");

  return (
    <Step
      title={RECOVERY_PHRASE_COPY.confirmTitle}
      intro={RECOVERY_PHRASE_COPY.confirmIntro}
      testId="onboarding-recovery-confirm"
      footer={
        <>
          <Button
            variant="primary"
            disabled={!allAnswered || phase === "publishing"}
            onClick={() => {
              const ok = positions.every((p, i) => normalizePhrase(answers[i] ?? "") === words[p - 1]);
              if (!ok) {
                setWrong(true);
                return;
              }
              setWrong(false);
              setPhase("publishing");
              confirmed.current?.();
            }}
          >
            {phase === "publishing" ? RECOVERY_PHRASE_COPY.working : RECOVERY_PHRASE_COPY.publish}
          </Button>
          <Button
            variant="ghost"
            disabled={phase === "publishing"}
            onClick={() => {
              setWrong(false);
              setPhase("showing");
            }}
          >
            {RECOVERY_PHRASE_COPY.back}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {positions.map((p, i) => (
          <label key={p} className="flex flex-col gap-1">
            <span className="text-sm text-muted">Word {p}</span>
            <Input
              value={answers[i] ?? ""}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-testid={`recovery-confirm-${p}`}
              onChange={(e) => {
                const next = [...answers];
                next[i] = e.target.value;
                setAnswers(next);
                setWrong(false);
              }}
            />
          </label>
        ))}
      </div>
      {wrong && (
        <p role="alert" className="text-sm text-bad">
          {RECOVERY_PHRASE_COPY.confirmWrong}
        </p>
      )}
    </Step>
  );
}

/**
 * Three distinct 1-based positions in a twelve-word phrase.
 *
 * Uniform, from `randomBytes`: rejection sampling rather than a modulo, because
 * a modulo over 256 would quietly favour the low positions — which are the ones
 * a partial screenshot catches.
 */
function pickPositions(count: number): number[] {
  const chosen = new Set<number>();
  while (chosen.size < count) {
    const b = webPlatform.randomBytes(1)[0]!;
    if (b >= 240) continue; // 240 = 12 * 20, the largest multiple of 12 under 256
    chosen.add((b % 12) + 1);
  }
  return [...chosen].sort((a, b) => a - b);
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
      intro={RECOVERY_ENTRY_COPY.intro}
      testId="onboarding-recovery-entry"
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
