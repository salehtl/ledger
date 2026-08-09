/**
 * The home-currency picker — the one irreversible control in the product.
 *
 * Spec §3.7 makes the home currency **log state, set once, with no in-product
 * way to change it**. Changing it later would re-denominate every already-frozen
 * FX snapshot, so the only remedy is deleting the account. This screen is
 * therefore a one-shot, irreversible choice made by somebody who has been using
 * the app for ninety seconds and does not yet know what a snapshot is.
 *
 * # The consequence is legible BEFORE the tap, in three places
 *
 *  1. **At first paint of the list**, before a currency is selected: a card
 *     saying this cannot be changed later. Not a toast, not a footnote — a
 *     confirmation that arrives after the choice is a receipt, not a warning.
 *  2. **On a second step of its own.** Selecting a currency arms; it does not
 *     emit. The confirm step echoes the code back in every line and states the
 *     remedy in §3.7's words: delete the account and start again.
 *  3. **Behind an acknowledgement the user has to make.** The confirm button is
 *     inert until it is made, which turns "the copy was on screen" into "the
 *     user acted on the copy" — the difference between a check that is true by
 *     construction and one that measures something.
 *
 * And a fourth, indirect: for an AED home the peg is shown as arithmetic
 * (`USD 100.00 is recorded as AED 367.25`) with the note that *rates* can be
 * changed any time. A changeable thing beside an unchangeable one is what makes
 * the unchangeable one legible.
 *
 * # It does not author the ops itself
 *
 * `commit` is injected. The op SHAPE comes from `homeCurrencyOps` in
 * `v2/onboarding.ts` — ported wholesale rather than re-derived here, because the
 * AED-only USD peg and the decimal-STRING `rate_micro` are two rules a screen
 * would get wrong (`parseMoney` refuses a JSON number outright, since
 * `JSON.parse` of one is a float64 and a rate that rounds re-values every
 * conversion made against it).
 */

import { useCallback, useMemo, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { Pressable } from "../../components/ui/Pressable";
import {
  confirmCopy,
  homeCurrencyOps,
  pegIllustration,
  searchCurrencies,
  type CurrencyChoice,
  type OpSpec,
} from "../../v2/onboarding";
import { Notice, SkipStep, Step } from "./Shell";

export interface HomeCurrencyProps {
  /** Authors the ops. Throwing leaves the screen on its confirm step. */
  commit: (ops: readonly OpSpec[]) => Promise<void> | void;
  /** Called once the ops are authored, with the normalised code. */
  onSet: (currency: string) => void;
  /**
   * The log already carries one. Renders the refusal rather than the picker — a
   * second `home_currency_set` is a permanent anomaly, so the screen must be
   * unable to offer one even if the machine routed here by mistake.
   */
  existing?: string | null;
  /**
   * "Set this up later".
   *
   * A one-shot, irreversible choice is exactly the one a person should be
   * allowed to defer: nothing about the product needs it on day one — totals
   * simply stay in the currency each purchase was made in — and deferring is the
   * opposite of softening it. The ceremony is unchanged when they do choose,
   * including from Settings.
   */
  onSkip?: () => void;
  /** Rendered inside a `Dialog` rather than as a whole step. See `Shell`. */
  embedded?: boolean;
}

type Phase =
  | { kind: "choose" }
  | { kind: "confirm"; code: string; acknowledged: boolean }
  | { kind: "committing"; code: string }
  | { kind: "failed"; code: string; message: string };

export function HomeCurrency({ commit, onSet, existing = null, onSkip, embedded = false }: HomeCurrencyProps) {
  /** A string draft, never coerced on keystroke. See `components/README.md`. */
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });

  const results = useMemo(() => searchCurrencies(query), [query]);

  const confirmChoice = useCallback(
    async (code: string) => {
      // The isRunning guard, in the shape a phase machine gives for free: a
      // second press while a commit is in flight cannot start a second one, and
      // this one would author the op twice — which is a permanent
      // `home_currency_reset` anomaly no later op can repair.
      setPhase({ kind: "committing", code });
      try {
        await commit(homeCurrencyOps(code));
        onSet(code);
      } catch (e) {
        setPhase({ kind: "failed", code, message: e instanceof Error ? e.message : String(e) });
      }
    },
    [commit, onSet],
  );

  if (existing !== null) {
    return (
      <Step
        testId="home-currency-set"
        embedded={embedded}
        title={`Your home currency is ${existing}`}
        intro={`ledger has no way to change it. Everything you have recorded is kept in ${existing}.`}
        footer={
          <Button variant="primary" onClick={() => onSet(existing)}>
            Carry on
          </Button>
        }
      />
    );
  }

  if (phase.kind !== "choose") {
    const copy = confirmCopy(phase.code);
    const peg = pegIllustration(phase.code);
    const acknowledged = phase.kind === "confirm" ? phase.acknowledged : true;
    const busy = phase.kind === "committing";
    return (
      <Step
        testId="home-currency-confirm"
        embedded={embedded}
        title={copy.title}
        intro={copy.meaning}
        footer={
          <>
            <Button variant="primary" disabled={!acknowledged || busy} onClick={() => void confirmChoice(phase.code)}>
              {busy ? <PixelSpinner size={12} /> : null}
              {copy.confirm}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPhase({ kind: "choose" })}>
              {copy.back}
            </Button>
          </>
        }
      >
        <Notice tone="danger" announce title="This cannot be undone" testId="home-currency-consequence">
          <p>{copy.consequence}</p>
        </Notice>

        {peg !== null && (
          <div className="flex flex-col gap-2" data-testid="home-currency-peg">
            <p className="text-xs text-muted">ledger will also record the USD peg</p>
            <p className="font-mono text-sm tnum">{peg}</p>
            <p className="text-xs text-muted">
              Exchange rates like that one you can change whenever you like. The home currency is the one thing you
              cannot.
            </p>
          </div>
        )}

        {/*
          A real checkbox inside a 44px label: this is an acknowledgement, not a
          setting, so it takes checkbox semantics rather than `Switch`.
        */}
        <label className="min-h-11 flex items-center gap-3 text-sm leading-relaxed">
          <input
            type="checkbox"
            className="w-5 h-5 accent-[var(--color-accent)] rounded-[var(--radius)]"
            aria-label={copy.acknowledgement}
            checked={acknowledged}
            disabled={busy}
            onChange={() => setPhase((p) => (p.kind === "confirm" ? { ...p, acknowledged: !p.acknowledged } : p))}
          />
          <span>{copy.acknowledgement}</span>
        </label>

        {phase.kind === "failed" && (
          <p role="alert" data-testid="home-currency-error" className="text-sm text-bad">
            That did not save: {phase.message}. Nothing was recorded, so nothing is stuck — try again.
          </p>
        )}
      </Step>
    );
  }

  return (
    <Step
      testId="home-currency"
      embedded={embedded}
      title="Which currency do you think in?"
      intro="Your totals, your budget and every converted purchase are kept in this one."
    >
      {/*
        Before any selection, above the list, at first paint. A warning that
        appears after the choice is a receipt.
      */}
      <Notice tone="danger" title="Pick carefully — this one is permanent" testId="home-currency-permanence">
        {/* The mechanism — "ledger converts each foreign purchase once, when it
            arrives, and keeps that figure" — is `confirmCopy.meaning`, one tap
            later, where the currency being weighed has a name. Here the user is
            still choosing, and what they need is the consequence. */}
        <p>
          There is no way to change your home currency afterwards. The only way out is to delete your account and
          start again.
        </p>
      </Notice>

      <Input
        aria-label="Search currencies"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search, or type a three-letter code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
      />

      <div className="flex flex-col rounded-[var(--radius)] border border-border bg-surface divide-y divide-border">
        {results.map((c) => (
          <CurrencyRow
            key={c.code}
            choice={c}
            onPick={() => setPhase({ kind: "confirm", code: c.code, acknowledged: false })}
          />
        ))}
      </div>
      {results.length === 0 && (
        <p data-testid="home-currency-empty" className="text-sm text-muted">
          No currency matches that. Any three-letter code works — try typing it in full.
        </p>
      )}

      {/* A choice this permanent is one a person is allowed to sleep on. It is
          the same ceremony whenever they come back to it. */}
      {onSkip !== undefined && <SkipStep step="home_currency_set" onSkip={onSkip} />}
    </Step>
  );
}

function CurrencyRow({ choice, onPick }: { choice: CurrencyChoice; onPick: () => void }) {
  return (
    <Pressable
      aria-label={`${choice.code} — ${choice.name}`}
      className="min-h-11 px-4 py-3 flex items-center gap-4 text-left hover:bg-surface-2 transition-colors"
      onClick={onPick}
    >
      <span className="font-mono text-sm w-12 shrink-0">{choice.code}</span>
      <span className="text-sm text-muted">{choice.name}</span>
    </Pressable>
  );
}
