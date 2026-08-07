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
import {
  comparisonCode,
  decodeEnrolmentRequest,
  EnrolmentCodeError,
  type EnrolmentRequest,
  type KeyHistoryEntry,
} from "../../v2/deviceEnrolment";
import { enrollmentFailureCopy } from "../../v2/enrollment";

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
      const copy = enrollmentFailureCopy(error);
      setFailure(`${copy.title}. ${copy.body}`);
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
                  The device you are adding is showing eight characters of its own. They must be identical. If they
                  are not, stop — the code was changed on its way here.
                </p>
                <label className="flex items-center gap-3 text-sm leading-relaxed">
                  <Switch
                    checked={confirmed}
                    data-testid="comparison-confirm"
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>The other device shows the same eight characters.</span>
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
