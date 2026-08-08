/**
 * "Use my recovery phrase" — the way out of the enrolment wall for a device
 * with no other device to ask.
 *
 * # The dead end this exists to remove
 *
 * A browser whose site data was cleared is a NEW WRITER: the device writer's
 * Ed25519 identity key lived in the local database that was destroyed. The
 * account's one TOFU self-approval was spent by the original device, so
 * `auth.Writers.Register` refuses the self-signature and the boot gate raises
 * the `rejected` wall — which offers a code for another device to approve.
 *
 * A user with one device has no other device. Before the recovery authorizer
 * they recovered their DATA from the phrase and were then permanently
 * read-only, holding the very secret that was supposed to make them whole.
 *
 * # What this panel actually does
 *
 * Unwraps the account's key blob with the phrase, and uses the Ed25519 recovery
 * authorizer inside it to sign THIS device's writer registration. That
 * signature is what the server accepts in place of an enrolled device's
 * (00027_recovery_authorizer.sql), and it is still a proof of key possession —
 * the session token authorizes nothing here, exactly as before.
 *
 * The authorizer is never stored: `recoverAccountKeys` hands it over for the
 * duration of the callback and zeroes it afterwards, whether the enrolment
 * succeeded or not. The two keys that ARE kept — the ingest key and the DEK —
 * land in the vault as non-extractable handles on the same pass, so one phrase
 * entry restores both reading and writing.
 *
 * # Why it sits on the wall rather than in Settings
 *
 * Same reason `PendingDevicePanel` does: a device that is not enrolled cannot
 * reach Settings, or anything else. The wall is the only surface it has.
 */

import { useCallback, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Notice } from "../onboarding/Shell";
import { browserKeyVault, readPublishedKeys, recoverAccountKeys } from "../../v2/keys";
import { RECOVERY_ENTRY_COPY } from "../../v2/onboarding";
import { ensureWriterId, mintWriterId, webSecretStore, type V2Handle } from "../../v2/session";
import { validatePhrase } from "@ledger/client/crypto/phrase";
import { webPlatform } from "@ledger/client/platform.web";

export interface RecoverWritePanelProps {
  handle: V2Handle;
  /** The boot gate's `again`. Called once this device can author. */
  onRecovered: () => void;
  /** Injected by tests. */
  profile?: string;
  server?: string;
  fetch?: typeof fetch;
}

export function RecoverWritePanel({ handle, onRecovered, profile = "ledger", server = "", fetch: doFetch }: RecoverWritePanelProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = useCallback(async () => {
    // Before the KDF, so a typo is named in a millisecond rather than after a
    // several-second Argon2id pass that could only say "no".
    const verdict = validatePhrase(draft, webPlatform);
    if (!verdict.ok) {
      setProblem(verdict.message);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const io = {
        sessionToken: handle.client.sessionToken,
        server,
        ...(doFetch === undefined ? {} : { fetch: doFetch }),
      };
      const published = await readPublishedKeys(io);
      if (published === null) {
        // An account with no published key set has no authorizer, so there is
        // nothing a phrase could prove. Said plainly rather than as a failure:
        // this is an account that predates encryption, not a broken one.
        setProblem(
          "This account has no recovery phrase set up, so there is nothing to unlock with. It will need a device " +
            "that is already signed in to approve this one.",
        );
        return;
      }

      // The writer id is minted once and kept forever — the same id this device
      // would enrol under any other way, so a later approval-based enrolment
      // cannot end up naming a second writer for one browser.
      const secrets = webSecretStore(profile);
      const writerId = ensureWriterId(secrets, mintWriterId);

      await recoverAccountKeys({
        accountId: handle.client.userId,
        phrase: verdict.phrase,
        published,
        vault: browserKeyVault(),
        // The enrolment happens INSIDE the recovery, while the authorizer is
        // alive. `enroll` with `authorize` never puts this key in the writer
        // store — it is the one key this device must not keep.
        authorize: async (sign) => {
          await handle.client.enroll(writerId, { authorize: sign });
        },
      });
      onRecovered();
    } catch {
      setProblem(RECOVERY_ENTRY_COPY.failed);
    } finally {
      setBusy(false);
    }
  }, [draft, handle, onRecovered, profile, server, doFetch]);

  return (
    <section data-testid="recover-write" className="flex flex-col gap-3">
      <Notice title="Or use your recovery phrase">
        <p>
          If you have the twelve words ledger gave you when you set this account up, this device can unlock itself with
          no other device involved. It is the same phrase that decrypts your records.
        </p>
        {/*
          Said at the exact moment the phrase is used to authorise a WRITE, not
          only where it is written down. This screen's button enrols a device
          that can author into the user's financial log, and "the phrase that
          decrypts your records" above describes only half of what is about to
          happen. `RecoverWritePanel.test.tsx` pins its presence.
        */}
        <p>{RECOVERY_ENTRY_COPY.alsoWrites}</p>
      </Notice>
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">{RECOVERY_ENTRY_COPY.label}</span>
        <textarea
          value={draft}
          rows={3}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-testid="recover-write-phrase"
          placeholder={RECOVERY_ENTRY_COPY.placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(null);
          }}
          className="w-full min-h-11 p-3 rounded-[var(--radius)] border border-border bg-surface text-base font-mono"
        />
      </label>
      <Button variant="primary" disabled={busy || draft.trim() === ""} onClick={() => void submit()}>
        {busy ? RECOVERY_ENTRY_COPY.working : "Unlock this device"}
      </Button>
      {problem !== null && (
        <p role="alert" className="text-sm text-bad">
          {problem}
        </p>
      )}
    </section>
  );
}
