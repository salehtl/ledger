/**
 * The passkey list: what this account can sign in with, and the way to end one.
 *
 * The client half of `2026-08-09-passkey-management-design.md`'s screen. It
 * lives inside Settings' Device group, in the "Passkeys" panel that already
 * carries the add control — a list where "Passkeys" already lives, per the
 * spec, not a new screen.
 *
 * # The two guards, and which one is real
 *
 * Deleting the last passkey is an unrecoverable lockout, and the refusal that
 * matters is the SERVER's — `409 last_passkey`, a guard this screen must not be
 * the only holder of. That endpoint does not exist yet (see `v2/passkeys.ts`).
 * This screen ALSO disables removal at one credential, because a control that
 * lets you try something the server will refuse is a worse sentence after the
 * fact than a disabled button with the reason on it before.
 *
 * The disabled control is shown WITH its reason, not hidden: a hidden control
 * teaches nothing.
 *
 * # Removal is a destructive confirm
 *
 * A Dialog, naming what happens: that device can no longer sign in. When the
 * row is THIS device's credential the dialog says that too — the marker exists
 * so a person does not remove the one they are standing on, and the confirm is
 * the last place to say it.
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Dialog, DialogFooter } from "../../components/ui/Dialog";
import { Pill } from "../../components/ui/Pill";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { isLastPasskeyRefusal, type PasskeySummary } from "../../v2/passkeys";

export interface PasskeysPanelProps {
  /** Test seam in `V2Settings`; production is `listPasskeys` over the handle. */
  list: () => Promise<PasskeySummary[]>;
  /** Test seam; production is `removePasskey`. */
  remove: (credentialId: string) => Promise<void>;
  /** Bump to reload — the parent does after adding a passkey. */
  reloadKey?: number;
}

/** "2026-08-09", from an RFC3339 stamp. Coarse on purpose; a date is enough. */
function day(stamp: string): string {
  return stamp.slice(0, 10);
}

export function passkeyName(p: PasskeySummary): string {
  return p.authenticator ?? "Passkey";
}

export function PasskeysPanel({ list, remove, reloadKey = 0 }: PasskeysPanelProps) {
  const [entries, setEntries] = useState<PasskeySummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  /** The row the confirm dialog is about, or null. */
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeNote, setRemoveNote] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setFailed(false);
    list().then(
      (rows) => {
        if (!stale) setEntries(rows);
      },
      () => {
        if (!stale) {
          setEntries(null);
          setFailed(true);
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [list, reloadKey, retryTick]);

  const confirmRemove = useCallback(async (): Promise<void> => {
    if (removing === null) return;
    setBusy(true);
    setRemoveNote(null);
    try {
      await remove(removing.credentialId);
      // The server's answer is the truth; drop the row only after it said yes.
      setEntries((held) => (held === null ? null : held.filter((p) => p.credentialId !== removing.credentialId)));
      setRemoving(null);
    } catch (error) {
      // The server-side guard, in the server's own code. The disabled control
      // below should make this unreachable; when it is reached anyway, say the
      // server's rule rather than a generic failure.
      setRemoveNote(
        isLastPasskeyRefusal(error)
          ? "This is your only passkey, so it cannot be removed."
          : "ledger could not remove it just now. Nothing changed — try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [remove, removing]);

  if (failed) {
    return (
      <div data-testid="passkeys-error" className="space-y-2">
        <p className="text-sm text-warn">
          ledger could not read your passkeys just now. They all still work, and adding one still works.
        </p>
        <Button variant="ghost" onClick={() => setRetryTick((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  if (entries === null) {
    return (
      <div className="flex items-center gap-3 text-muted" role="status">
        <PixelSpinner size={12} />
        <span className="text-sm">Reading your passkeys…</span>
      </div>
    );
  }
  if (entries.length === 0) {
    // A signed-in account has at least one credential, so an empty answer is a
    // server-side surprise; say nothing stronger than what is on the wire.
    return <p className="text-sm text-muted">No passkeys to show.</p>;
  }

  const lastOne = entries.length === 1;
  return (
    <div data-testid="passkeys-list" className="space-y-2">
      <ul className="divide-y divide-border">
        {entries.map((p) => (
          <li key={p.credentialId} data-testid="passkey-row" className="py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium truncate">
                {passkeyName(p)}
                {p.current && (
                  <span className="ml-2 align-middle">
                    <Pill tone="muted">This device</Pill>
                  </span>
                )}
              </p>
              <p className="text-xs text-muted">
                Added {day(p.createdAt)}
                {p.lastUsedAt === null ? " · never used to sign in" : ` · last used ${day(p.lastUsedAt)}`}
              </p>
            </div>
            <Button
              variant="ghost"
              className="text-bad shrink-0"
              disabled={lastOne}
              onClick={() => {
                setRemoveNote(null);
                setRemoving(p);
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {lastOne && (
        <p data-testid="passkeys-last-reason" className="text-xs leading-relaxed text-muted">
          Your only passkey cannot be removed. It is the only way into this account.
        </p>
      )}

      {removing !== null && (
        <Dialog title="Remove this passkey?" onClose={() => (busy ? undefined : setRemoving(null))}>
          <p className="text-sm leading-relaxed mb-2">
            {passkeyName(removing)} can no longer sign in to this account. The device holding it loses its way in.
          </p>
          {removing.current && (
            <p className="text-sm leading-relaxed text-bad mb-2">
              This is the passkey you are signed in with on this device.
            </p>
          )}
          <p className="text-sm leading-relaxed text-muted mb-4">
            Your records are not touched, and your other passkeys keep working.
          </p>
          {removeNote !== null && (
            <p data-testid="passkeys-remove-note" role="status" className="text-sm text-bad mb-4">
              {removeNote}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void confirmRemove()}>
              {busy ? "Removing…" : "Remove passkey"}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
