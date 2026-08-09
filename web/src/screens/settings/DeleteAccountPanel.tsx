/**
 * Delete account — the destructive end of Settings.
 *
 * # Why this screen exists at all
 *
 * App Review 5.1.1(v) requires an app that creates an account to let a person
 * delete it from inside the app. That is the compliance reason. The product
 * reason is the one on the privacy page: "you own your data" is a claim about
 * what you can take away, and deletion is the half that proves it. The operator
 * has `ledgerd purge-user`, but an operator-only path is a promise you have to
 * ask permission to collect on.
 *
 * # Everything the user needs to decide is ON THE SCREEN
 *
 * Not behind a tooltip, not on a second step, not in a confirm dialog they will
 * tap through. Three facts, in order of how badly they are missed:
 *
 *  1. It cannot be undone, by anyone. The operator cannot restore it and this
 *     screen must never suggest otherwise — there is no backup to pull it out
 *     of, and saying "contact support" would be a lie with a deadline.
 *  2. The inbound address stops existing. Mail sent to it afterwards is
 *     refused, so a bank whose alerts still point there is silently forwarding
 *     into nothing.
 *  3. SYNCED and UNSENT are different losses. Anything still in this device's
 *     outbox exists on no other machine and in no server table; it is not
 *     "also deleted", it is deleted from the only place it ever was.
 *
 * The count in (3) is `Client.pending.length`, read live rather than captured,
 * because a background sync can empty the outbox while this screen is open and
 * a number that went stale would over-state the loss at the moment it matters.
 *
 * # A typed word, not two taps
 *
 * Two sequential confirmations are not a safety mechanism: people tap through
 * both, and the second one teaches them that the first meant nothing. Typing a
 * word cannot be done by a mis-tap, and it is the same reason `Welcome`'s wipe
 * arms behind an explicit acknowledgement rather than a second dialog.
 *
 * # What happens after the server says yes
 *
 * `wipeLocalData`. The account is gone server-side, and this browser is still
 * holding the whole op log and projection under the database name the next
 * sign-in would open. That is exactly the state `410 account_deleted` produces,
 * and it already has one answer; this uses it rather than inventing a second.
 */

import { useCallback, useMemo, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { Notice } from "../onboarding/Shell";
import { deleteAccount } from "../../v2/deleteAccount";
import { isPasskeyError, webSecretStore, type V2Handle } from "../../v2/session";
import { passkeyFailureCopy } from "../../v2/passkeyCopy";
import { wipeLocalData, PROFILE, SERVER } from "../../v2/BootGate";

/**
 * The word. Fixed, short, and the same one every time — a phrase generated per
 * session would make this a copying exercise rather than a deliberate act.
 */
export const DELETE_CONFIRM_WORD = "DELETE";

/**
 * Matched after trimming and case-folded.
 *
 * The point of the typed word is that a mis-tap cannot produce it. Requiring
 * capitals as well would only punish a phone keyboard that decided not to
 * capitalise, and refusing "delete " for its trailing space would be a refusal
 * nobody can see.
 */
export function isConfirmed(draft: string): boolean {
  return draft.trim().toUpperCase() === DELETE_CONFIRM_WORD;
}

export interface DeleteAccountPanelProps {
  handle: V2Handle;
  /** Test seam. Defaults to the real three-factor ceremony. */
  destroy?: (handle: V2Handle) => Promise<void>;
  /** Test seam. Defaults to {@link wipeLocalData}. */
  wipe?: (handle: V2Handle) => Promise<void>;
}

/** The writer id, or null when this device holds no key that can author. */
function writerIdOf(handle: V2Handle): string | null {
  try {
    return handle.client.writerId;
  } catch {
    return null;
  }
}

export function DeleteAccountPanel({
  handle,
  destroy = (h) =>
    deleteAccount({ client: h.client, secrets: webSecretStore(PROFILE), server: SERVER }),
  wipe = wipeLocalData,
}: DeleteAccountPanelProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Live, not captured at mount. See the note at the top of the file.
  const unsent = handle.client.pending.length;
  const canAuthor = useMemo(() => writerIdOf(handle) !== null, [handle]);
  const armed = isConfirmed(draft);

  const run = useCallback(async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await destroy(handle);
    } catch (error) {
      const kind = isPasskeyError(error) ? error.passkeyKind : "unavailable";
      const copy = passkeyFailureCopy(kind);
      // Said out loud, and the account is stated to be intact: the server
      // refuses a deletion without deleting anything, and a user left guessing
      // whether half of it went through is the worst outcome this screen has.
      setProblem(`${copy.title}. ${copy.body} Your account has not been deleted.`);
      setBusy(false);
      return;
    }
    // No success state and nothing to render into: `wipe` ends in a reload, and
    // there is no account left for this screen to describe.
    await wipe(handle);
  }, [destroy, wipe, handle]);

  return (
    <section data-testid="delete-account" className="flex flex-col gap-4">
      <Notice tone="danger" title="This cannot be undone">
        <p>
          Deleting your account removes every transaction, budget, category and rule ledger holds for you. It
          removes your passkeys and this device&rsquo;s key.
        </p>
        <p>
          Nobody can bring it back. There is no copy to restore from, and the person who runs this server cannot
          undo it either.
        </p>
      </Notice>

      <Notice tone="danger" title="Your ledger address stops working">
        <p>
          The address your bank mail is forwarded to stops existing. Mail sent to it after that is refused, so
          turn off forwarding at your bank as well.
        </p>
      </Notice>

      {unsent > 0 ? (
        <Notice
          tone="danger"
          title={`${String(unsent)} ${unsent === 1 ? "change has" : "changes have"} not been sent yet`}
          testId="delete-account-unsent"
        >
          <p>
            {unsent === 1 ? "It is" : "They are"} on this device only. No other device and no server copy{" "}
            {unsent === 1 ? "has it" : "has them"}.{" "}
            {unsent === 1 ? "It goes" : "They go"} with everything else.
          </p>
          <p>
            To send {unsent === 1 ? "it" : "them"} first, close this and sync. It changes nothing about the
            deletion — it only means the server had {unsent === 1 ? "it" : "them"} for the moment before.
          </p>
        </Notice>
      ) : (
        <p data-testid="delete-account-synced" className="text-sm leading-relaxed text-muted">
          Everything on this device has reached the server. All of it will be deleted.
        </p>
      )}

      {!canAuthor && (
        <Notice tone="danger" title="This device cannot delete the account" testId="delete-account-no-key">
          <p>
            Deleting needs the key this device signs its changes with, and this browser does not have one. Use a
            device that is already set up to make changes.
          </p>
        </Notice>
      )}

      {problem !== null && (
        <Notice tone="danger" announce title="It did not go through" testId="delete-account-error">
          <p>{problem}</p>
        </Notice>
      )}

      <label className="flex flex-col gap-2 text-sm">
        <span>
          Type <strong>{DELETE_CONFIRM_WORD}</strong> to confirm.
        </span>
        <Input
          inset
          value={draft}
          disabled={busy}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-label={`Type ${DELETE_CONFIRM_WORD} to confirm`}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>

      {/*
        The gap is the safety mechanism, exactly as it is on `Welcome`'s wipe:
        the control that arms this button sits directly above it, and at the
        default rhythm a fast double-tap can span both. `pt-4` puts them beyond
        one thumb's reach. If this is ever restyled, the distance is load-bearing.
      */}
      <div className="pt-4">
        <Button
          variant="danger"
          disabled={!armed || busy || !canAuthor}
          onClick={() => void run()}
        >
          {busy ? "Deleting…" : "Delete my account"}
        </Button>
      </div>
    </section>
  );
}
