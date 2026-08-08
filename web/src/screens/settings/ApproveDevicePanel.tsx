/**
 * The enrolled device's half of second-device enrolment: paste the code the
 * other device is showing, compare the check code, approve.
 *
 * # Why this is a paste field and not a list
 *
 * There is no server-side list of pending requests to render — `internal/v2`
 * stores an enrolment only once it has succeeded (`deviceEnrolment.ts` says so
 * at length). The request travels out of band, which is why this screen's first
 * control is a text field and not a row.
 *
 * # The comparison code gates the button, and that is the whole point
 *
 * Approving signs `RegistrationMessage(nonce, writerID, pubkey)` with this
 * device's enrolled key — the one thing that can enrol a writer at all. So the
 * confirmation is not a courtesy prompt: it is the moment the person, and not
 * the server, decides that the key being signed for is the key the other device
 * holds. Two consequences, both deliberate:
 *
 *  - Approve is disabled until the switch is on.
 *  - If THIS device could not derive the code, Approve is disabled outright and
 *    the switch is not offered. An unverifiable approval dressed up as a
 *    verified one is worse than no check at all.
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Switch } from "../../components/ui/Switch";
import { isEnrollmentError } from "../../v2/session";
import {
  comparisonCode,
  decodeEnrolmentRequest,
  EnrolmentCodeError,
  type EnrolmentRequest,
  type KeyHistoryEntry,
} from "../../v2/deviceEnrolment";

/**
 * A failure of the APPROVAL, said to the person doing the approving.
 *
 * `enrollmentCopy` is deliberately not reused here, and the reason is the whole
 * of this function: every sentence in it is written from the point of view of
 * the device being ADDED. Its `rejected` arm says "this device cannot make
 * changes until a device that is already signed in approves it — use the code
 * below". On this screen all three clauses are false: this device is enrolled,
 * it is the approver, and there is no code below. Correct copy shown to the
 * wrong person is still a sentence the code does not make true.
 *
 * The `rejected` arm may not claim a reason — `handleRegister` answers every
 * refusal with the same bodyless 403 — but it may not name causes that cannot
 * happen either, and the first draft did. It said "its code is stale … get a
 * fresh code", and neither half survives contact with the code:
 *
 *  - Nothing here goes stale. `Client.enroll` mints a fresh 5-minute challenge
 *    immediately before each register, so the NONCE is seconds old; and the
 *    pasted code is a writer id and a public key, which have no expiry at all.
 *  - A fresh code cures nothing. The peer's writer id and key are the same on
 *    the next copy, so a re-paste re-registers the identical enrolment and
 *    collects the identical 403.
 *
 * The 403s that can actually arrive are `ErrWriterExists` /
 * `ErrKeyAlreadyEnrolled` (that device is already added) and `ErrNotAuthorized`
 * (this device's key is no longer accepted). So those are what it names, and
 * the action it offers matches the second — re-enrol THIS device — because that
 * is the one a person can act on.
 */
function refusalCopy(error: unknown): string {
  const kind = isEnrollmentError(error) ? error.enrollmentKind : "unavailable";
  switch (kind) {
    case "offline":
      return "That device was not added: ledger could not reach the server. Nothing was changed. Try again when you are online.";
    case "rate_limited":
      return "That device was not added: too many attempts in a row. Wait a minute and try again.";
    case "rejected":
      return (
        "That device was not added, and the server does not say why. Most likely it is already added, or this " +
        "device's key is no longer accepted for changes. Check the other device first; if it still cannot make " +
        "changes, set this device up on the account again."
      );
    case "revoked":
      // A 403 for a signing key the server no longer accepts: the fault is on
      // THIS side of the pair, and no code from the other device changes it.
      return "That device was not added, because this device can no longer sign for changes on this account. Approve from a device that still can.";
    case "key_lost":
      // The LOCAL refusal `V2Handle.approveDevice` raises before any request:
      // this device holds no enrolled writer, so it has nothing to sign with.
      // It must not read as a server answer — nothing was asked.
      return "That device was not added. This device is signed in but cannot make changes itself, so it cannot approve another one. Use a device that can.";
    case "misconfigured":
      return "That device was not added: this copy of ledger is not set up correctly. Nothing you do here will fix it — this is ours to repair.";
    case "unavailable":
      return "That device was not added: the server could not be asked just now. Nothing was changed. Try again in a moment.";
  }
}

export interface ApproveDevicePanelProps {
  /** `V2Handle.keyHistory`. */
  loadKeyHistory: () => Promise<KeyHistoryEntry[]>;
  /** `V2Handle.approveDevice` — signs the registration with this device's enrolled key. */
  approve: (request: EnrolmentRequest) => Promise<void>;
}

type Phase = "entering" | "approving" | "done";

export function ApproveDevicePanel({ loadKeyHistory, approve }: ApproveDevicePanelProps) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("entering");
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [history, setHistory] = useState<KeyHistoryEntry[] | "error" | null>(null);

  // Fetched once, when the panel opens, rather than on each keystroke: it is
  // the account's log and does not depend on what was typed.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const entries = await loadKeyHistory();
        if (live) setHistory(entries);
      } catch {
        if (live) setHistory("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [loadKeyHistory]);

  let request: EnrolmentRequest | null = null;
  let codeError: string | null = null;
  if (text.trim() !== "") {
    try {
      request = decodeEnrolmentRequest(text);
    } catch (error) {
      codeError = error instanceof EnrolmentCodeError ? error.message : "This code could not be read.";
    }
  }

  const check = request !== null && Array.isArray(history) ? comparisonCode(request, history) : null;

  const onApprove = useCallback(async () => {
    if (request === null) return;
    setPhase("approving");
    setFailure(null);
    try {
      await approve(request);
      setPhase("done");
    } catch (error) {
      setFailure(refusalCopy(error));
      setPhase("entering");
    }
  }, [approve, request]);

  if (phase === "done") {
    return (
      <div data-testid="approve-device-done" className="space-y-3">
        <p className="text-sm leading-relaxed">
          That device can now make changes to this account. Go back to it and press <strong>Check again</strong>.
        </p>
        <p className="text-sm leading-relaxed text-muted">
          It is recorded in this account&rsquo;s key history, where every device can see it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">
          The code from the other device
        </SectionLabel>
        <Card className="space-y-3">
          <p className="text-sm leading-relaxed text-muted">
            On the device you are adding, ledger shows a code and a check code. Paste the code here.
          </p>
          <Input
            inset
            aria-label="Device code"
            data-testid="device-code-input"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setConfirmed(false);
              setFailure(null);
            }}
          />
          {codeError !== null && (
            <p data-testid="device-code-error" role="alert" className="text-sm text-bad leading-relaxed">
              {codeError}
            </p>
          )}
        </Card>
      </section>

      {request !== null && (
        <section className="space-y-2">
          <SectionLabel as="h2" className="px-1">
            Check the two screens match
          </SectionLabel>
          <Card className="space-y-3">
            {history === null ? (
              <span className="flex items-center gap-2 text-sm text-muted" role="status">
                <PixelSpinner size={12} />
                Working out the check code…
              </span>
            ) : check !== null ? (
              <>
                <p data-testid="approve-comparison-code" className="font-mono text-2xl tracking-widest tnum">
                  {check}
                </p>
                <p className="text-sm leading-relaxed text-muted">
                  The device you are adding is showing ten characters of its own. They must be identical. If they
                  are not, stop — the code was changed on its way here.
                </p>
                <label className="flex items-center gap-3 text-sm leading-relaxed">
                  <Switch
                    checked={confirmed}
                    data-testid="comparison-confirm"
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>The other device shows the same ten characters.</span>
                </label>
              </>
            ) : (
              <p data-testid="approve-no-code" role="alert" className="text-sm leading-relaxed text-bad">
                ledger could not read this account&rsquo;s key history, so it cannot work out the check code — and
                it will not let you approve a device without one. Close this, make sure you are online, and open it
                again.
              </p>
            )}
          </Card>
        </section>
      )}

      {failure !== null && (
        <p data-testid="approve-failure" role="alert" className="text-sm leading-relaxed text-bad">
          {failure}
        </p>
      )}

      <Button
        variant="primary"
        data-testid="approve-device"
        disabled={request === null || check === null || !confirmed || phase === "approving"}
        onClick={() => void onApprove()}
      >
        {phase === "approving" ? "Approving…" : "Approve this device"}
      </Button>
    </div>
  );
}
