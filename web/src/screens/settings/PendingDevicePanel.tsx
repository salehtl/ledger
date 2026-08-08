/**
 * What the device being ADDED shows: its enrolment code, the comparison code,
 * and the one instruction that can actually get it enrolled.
 *
 * It lives under `screens/settings/` beside its other half
 * ({@link ApproveDevicePanel}) rather than under `v2/`, because the two are one
 * flow read from two sides and the copy on them has to be kept in step. It is
 * rendered by `BootGate`'s `unenrolled` wall, not by Settings — this device
 * cannot reach Settings; it cannot reach anything until it is enrolled.
 *
 * # Why there is no "waiting" spinner
 *
 * Nothing on the server holds a pending request (see `deviceEnrolment.ts`), so
 * there is nothing to poll and no event to wait for. The approval happens on
 * the other device, and the only way this one learns of it is by asking the
 * roster again — which is exactly what "Check again" does. A spinner labelled
 * "waiting for approval" would be an animation over a socket that does not
 * exist.
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { SectionLabel } from "../../components/ui/SectionLabel";
import {
  comparisonCode,
  encodeEnrolmentRequest,
  type EnrolmentRequest,
  type KeyHistoryEntry,
} from "../../v2/deviceEnrolment";

export interface PendingDevicePanelProps {
  request: EnrolmentRequest;
  /** `V2Handle.keyHistory`. Its result is hashed into the comparison code. */
  loadKeyHistory: () => Promise<KeyHistoryEntry[]>;
  /** Re-runs boot, which re-reads the roster. The only way this device learns it was approved. */
  onRecheck: () => void;
  /** Test seam. Defaults to the Clipboard API. */
  copy?: (text: string) => Promise<void>;
}

async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
    throw new Error("this browser has no clipboard access");
  }
  await navigator.clipboard.writeText(text);
}

export function PendingDevicePanel({ request, loadKeyHistory, onRecheck, copy = writeClipboard }: PendingDevicePanelProps) {
  const code = encodeEnrolmentRequest(request);
  const [check, setCheck] = useState<{ code: string } | { error: true } | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const entries = await loadKeyHistory();
        if (live) setCheck({ code: comparisonCode(request, entries) });
      } catch {
        // Nothing is shown in place of it. A comparison code that could not be
        // derived is not "—" and not a spinner that never ends: it is a check
        // that did not happen, and saying so is the only honest option. See
        // `deviceEnrolment.ts`.
        if (live) setCheck({ error: true });
      }
    })();
    return () => {
      live = false;
    };
  }, [loadKeyHistory, request]);

  const onCopy = useCallback(async () => {
    try {
      await copy(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [copy, code]);

  return (
    <div className="w-full space-y-5 text-left">
      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">
          Step 1 — copy this code
        </SectionLabel>
        <Card className="space-y-3">
          <p
            data-testid="enrolment-code"
            className="font-mono text-sm select-all break-all leading-relaxed"
          >
            {code}
          </p>
          <Button variant="secondary" onClick={() => void onCopy()}>
            {copied === true ? "Copied" : "Copy code"}
          </Button>
          {copied === false && (
            <p role="status" className="text-xs text-bad">
              This browser would not let ledger use the clipboard. The code above can be selected by hand.
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted">
            It holds this device&rsquo;s name and public key. It is not a secret and cannot read your ledger —
            but whoever you send it to can add this device.
          </p>
        </Card>
      </section>

      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">
          Step 2 — approve it on your other device
        </SectionLabel>
        <Card className="space-y-3">
          <p className="text-sm leading-relaxed">
            On a device already signed in to this account, open <strong>Settings &rsaquo; Add a device</strong>,
            paste the code, and check that it shows the same ten characters as below.
          </p>
          <div data-testid="comparison-code" className="space-y-1">
            {check === null ? (
              <span className="flex items-center gap-2 text-sm text-muted" role="status">
                <PixelSpinner size={12} />
                Working out the check code…
              </span>
            ) : "code" in check ? (
              <>
                <p className="font-mono text-2xl tracking-widest tnum">{check.code}</p>
                <p className="text-xs leading-relaxed text-muted">
                  Both devices work this out for themselves. If the two do not match, do not approve — something
                  changed the code on its way over.
                </p>
              </>
            ) : (
              <p className="text-sm leading-relaxed text-warn">
                ledger could not work out the check code here — it could not read the account&rsquo;s key history.
                Nothing is shown in its place, because a code that was not computed is not a check. Your other
                device will refuse to approve without one too.
              </p>
            )}
          </div>
        </Card>
      </section>

      <section className="space-y-2">
        <SectionLabel as="h2" className="px-1">
          Step 3 — come back here
        </SectionLabel>
        <Card className="space-y-3">
          <p className="text-sm leading-relaxed text-muted">
            ledger is not told when the other device approves, so this one has to look. Press this once you have
            approved it.
          </p>
          <Button variant="primary" onClick={onRecheck}>
            Check again
          </Button>
          <p className="text-xs leading-relaxed text-muted">
            If no other device is signed in to this account, this device cannot be added this way — the
            account&rsquo;s one self-approval was used when it was set up.
          </p>
        </Card>
      </section>
    </div>
  );
}
