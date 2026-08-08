/**
 * Settings: turning passkey unlock on and off.
 *
 * # What this offers, and what it must never say
 *
 * It adds a passkey whose PRF secret opens a second copy of the account's keys
 * (`web/src/v2/prf.ts`), so a later launch unlocks with Face ID, Touch ID or a
 * security key instead of twelve typed words.
 *
 * The recovery phrase stays mandatory, and every string here has to be
 * compatible with that. A passkey can be deleted from a keychain, a security key
 * can be lost or reset, and an operating system can rotate a credential without
 * asking. The server holds nothing that would help. So this is a convenience,
 * never a replacement, and no sentence on this panel may imply otherwise.
 *
 * # Why it asks for the phrase
 *
 * A wrap is built from the raw key bytes, and after installation those are gone:
 * the DEK is a non-extractable handle and the recovery seed was never stored. So
 * turning this on unwraps the published blob with the phrase — which also means
 * it cannot be enabled on a phone somebody found unlocked.
 *
 * # Why it is not part of onboarding
 *
 * It needs keys that already exist and a phrase the user has already written
 * down. Both are true only after first run.
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { readPublishedKeys, type PublishedKeys } from "../../v2/keys";
import { enrolPrfUnlock, forgetPrfUnlock, isPrfError, listPrfUnlocks, prfAvailability } from "../../v2/prf";
import { validatePhrase } from "@ledger/client/crypto/phrase";
import { webPlatform } from "@ledger/client/platform.web";

/** Every string on this panel, in one place, so the honesty rule is reviewable at a glance. */
export const PASSKEY_UNLOCK_COPY = {
  title: "Unlock with a passkey",
  what: "Open ledger with Face ID, Touch ID or a security key instead of typing your recovery phrase.",
  phraseStays:
    "You still need your recovery phrase. A passkey can be lost, reset or removed, and we hold nothing that can open your account without the phrase.",
  howItGoes: "Turning this on asks for your phrase once, then shows two passkey prompts in a row.",
  label: "Your recovery phrase",
  placeholder: "twelve words, separated by spaces",
  turnOn: "Turn on",
  working: "Setting up…",
  on: "Passkey unlock is on.",
  turnOff: "Turn off",
  unsupported: "This browser cannot unlock with a passkey. Your recovery phrase still works.",
  failed: "That did not work. Your recovery phrase still opens your account.",
  noKeys: "This account has no recovery phrase set up yet, so there is nothing to unlock.",
} as const;

export interface PasskeyUnlockPanelProps {
  /** `handle.client` — read for its bearer token only. */
  client: { sessionToken: string | null };
  server?: string;
  /** Injected by tests. */
  fetch?: typeof fetch;
  credentials?: CredentialsContainer;
}

export function PasskeyUnlockPanel({ client, server = "", fetch: doFetch, credentials }: PasskeyUnlockPanelProps) {
  const deps = {
    client,
    server,
    ...(doFetch === undefined ? {} : { fetch: doFetch }),
    ...(credentials === undefined ? {} : { credentials }),
  };

  const [supported, setSupported] = useState<boolean | null>(null);
  const [enrolled, setEnrolled] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const availability = await prfAvailability(credentials === undefined ? {} : { credentials });
      if (live) setSupported(availability !== "unsupported");
      try {
        const wraps = await listPrfUnlocks(deps);
        if (live) setEnrolled(wraps.length);
      } catch {
        // A listing that fails offline is not a fact about this feature, and
        // the panel has nothing useful to say about it. The phrase works either
        // way.
        if (live) setEnrolled(null);
      }
    })();
    return () => {
      live = false;
    };
    // Keyed on the session and the server only. `deps` and `credentials` are
    // rebuilt on every render, so listing them would re-run the ceremony probe
    // on every keystroke in the phrase field.
  }, [client.sessionToken, server]);

  const turnOn = useCallback(async () => {
    const verdict = validatePhrase(draft, webPlatform);
    if (!verdict.ok) {
      setProblem(verdict.message);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const published: PublishedKeys | null = await readPublishedKeys({
        sessionToken: client.sessionToken,
        server,
        ...(doFetch === undefined ? {} : { fetch: doFetch }),
      });
      if (published === null) {
        setProblem(PASSKEY_UNLOCK_COPY.noKeys);
        return;
      }
      await enrolPrfUnlock({ deps, published, phrase: verdict.phrase });
      setDraft("");
      setEnrolled((n) => (n ?? 0) + 1);
    } catch (err) {
      // A dismissed prompt is not a failure to apologise for: nothing changed.
      if (isPrfError(err) && err.prfKind === "cancelled") return;
      setProblem(isPrfError(err) && err.prfKind === "no_prf" ? err.message : PASSKEY_UNLOCK_COPY.failed);
    } finally {
      setBusy(false);
    }
  }, [draft, client.sessionToken, server, doFetch, credentials]);

  const turnOff = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      for (const wrap of await listPrfUnlocks(deps)) {
        await forgetPrfUnlock(deps, wrap.credentialId);
      }
      setEnrolled(0);
    } catch {
      setProblem(PASSKEY_UNLOCK_COPY.failed);
    } finally {
      setBusy(false);
    }
  }, [client.sessionToken, server, doFetch, credentials]);

  return (
    <section data-testid="passkey-unlock" className="flex flex-col gap-3">
      <h2 className="text-base font-medium">{PASSKEY_UNLOCK_COPY.title}</h2>
      <p className="text-sm text-muted">{PASSKEY_UNLOCK_COPY.what}</p>
      {/* Not a footnote. It is the fact that keeps this feature honest, and it
          sits above the control rather than under it. */}
      <p className="text-sm text-muted">{PASSKEY_UNLOCK_COPY.phraseStays}</p>

      {supported === false ? (
        <p className="text-sm text-muted">{PASSKEY_UNLOCK_COPY.unsupported}</p>
      ) : enrolled !== null && enrolled > 0 ? (
        <>
          <p className="text-sm">{PASSKEY_UNLOCK_COPY.on}</p>
          <Button variant="secondary" disabled={busy} onClick={() => void turnOff()}>
            {PASSKEY_UNLOCK_COPY.turnOff}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">{PASSKEY_UNLOCK_COPY.howItGoes}</p>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-muted">{PASSKEY_UNLOCK_COPY.label}</span>
            <textarea
              value={draft}
              rows={3}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-testid="passkey-unlock-phrase"
              placeholder={PASSKEY_UNLOCK_COPY.placeholder}
              onChange={(e) => {
                setDraft(e.target.value);
                setProblem(null);
              }}
              className="w-full min-h-11 p-3 rounded-[var(--radius)] border border-border bg-surface text-base font-mono"
            />
          </label>
          <Button variant="primary" disabled={busy || draft.trim() === ""} onClick={() => void turnOn()}>
            {busy ? PASSKEY_UNLOCK_COPY.working : PASSKEY_UNLOCK_COPY.turnOn}
          </Button>
        </>
      )}

      {problem !== null && (
        <p role="alert" className="text-sm text-bad">
          {problem}
        </p>
      )}
    </section>
  );
}
