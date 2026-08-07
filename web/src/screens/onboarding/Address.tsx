/**
 * The inbound address, and the forwarding rule that points at it.
 *
 * Two positions of the machine (`address_issued`, then `forwarding_configured`)
 * on one component, because they are one subject: here is your address, now send
 * mail to it. The `phase` prop picks which half is on screen.
 *
 * # The read is what creates the address
 *
 * `GET /api/v1/address` mints on first call — `addresses.go` says so explicitly
 * and explains why a GET is permitted to write ("creating the FIRST address
 * gives a session holder nothing it could not already read, whereas rotation
 * destroys a working one"). So the request that displays the address is the
 * request that creates it, and there is no separate provisioning step to fail
 * halfway through.
 *
 * # Why it does not advance the machine by itself
 *
 * The instant `inboundAddress` is non-null, `stepFor` walks on. A screen that
 * reported the address the moment it arrived would render for one frame and be
 * replaced — handing the user nothing, which is precisely what the copy target
 * exists to prevent. The user presses Continue, and only then does the fact
 * reach the reducer.
 *
 * # `forwardingDeclared` is a claim, not an observation
 *
 * Nothing on this device can see a Gmail filter, and the only evidence a forward
 * works is mail arriving — which is the *next* step. So this step ends with the
 * user saying they have done it, and the verification step is what actually
 * measures it. Calling the fact `forwardingDeclared` rather than
 * `forwardingConfigured` is the same honesty in the machine.
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { readAddress } from "../../v2/address";
import type { TokenSource } from "../../v2/onboardingIO";
import { Notice, Step } from "./Shell";

export interface AddressProps {
  client: TokenSource;
  phase: "address" | "forwarding";
  /** `address_issued`, with the address the server actually minted. */
  onIssued: (address: string) => void;
  /** `forwarding_declared`. */
  onForwardingDeclared: () => void;
  /** The address already known, so the forwarding half need not re-read. */
  known: string | null;
  server?: string;
  fetch?: typeof fetch;
  /** Injected by tests; defaults to the Clipboard API. */
  copy?: (text: string) => Promise<void>;
}

async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
    throw new Error("this browser has no clipboard access");
  }
  await navigator.clipboard.writeText(text);
}

export function Address({
  client,
  phase,
  onIssued,
  onForwardingDeclared,
  known,
  server,
  fetch: doFetch,
  copy = writeClipboard,
}: AddressProps) {
  const [address, setAddress] = useState<string | null>(known);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(known === null);
  const [copied, setCopied] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      const got = await readAddress(client, {
        ...(server === undefined ? {} : { server }),
        ...(doFetch === undefined ? {} : { fetch: doFetch }),
      });
      setAddress(got);
      setFailed(got === null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [client, server, doFetch]);

  useEffect(() => {
    // Always read on the address half, even with a cached copy: `onboarding.ts`
    // caches the address as a RESUME HINT and says the screen must render a
    // fresh read rather than that. On the forwarding half the address is only
    // being echoed back, so a cached one is fine.
    if (phase === "address") void load();
  }, [phase, load]);

  const onCopy = async (value: string): Promise<void> => {
    try {
      await copy(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (phase === "forwarding") {
    return (
      <Step
        testId="forwarding"
        title="Send your bank mail here"
        intro="One forwarding rule in the mailbox your bank already writes to. ledger never sees the rest of that mailbox and never holds a password to it."
        footer={
          <Button variant="primary" onClick={onForwardingDeclared}>
            I have set up forwarding
          </Button>
        }
      >
        <AddressCard address={address} copied={copied} onCopy={() => void onCopy(address ?? "")} />
        <ol className="flex flex-col gap-3 text-sm leading-relaxed list-decimal pl-5">
          <li>
            In Gmail on a computer, open <strong>Settings → See all settings → Forwarding and POP/IMAP</strong>.
          </li>
          <li>
            Press <strong>Add a forwarding address</strong> and paste the address above.
          </li>
          <li>
            Gmail emails a confirmation code to it. That message is held by ledger on purpose — the next screen
            shows you the code and the link.
          </li>
          <li>
            Back in Gmail, create a filter for your bank&rsquo;s sender address and tick{" "}
            <strong>Forward it to</strong> your ledger address. Forward the bank, not the whole mailbox.
          </li>
        </ol>
        <Notice>
          <p>
            A filter rather than blanket forwarding is the point: ledger only ever receives the messages you chose,
            and anything else that reaches this address is held rather than read.
          </p>
        </Notice>
      </Step>
    );
  }

  return (
    <Step
      testId="address"
      title="Your inbound address"
      intro="This address is yours alone. Bank mail sent here becomes transactions in ledger; nothing else about your mailbox is read, and ledger never holds a password to it."
      footer={
        address === null ? undefined : (
          <Button variant="primary" onClick={() => onIssued(address)}>
            I have my address
          </Button>
        )
      }
    >
      {busy && (
        <div className="flex items-center gap-3 text-muted" role="status">
          <PixelSpinner size={12} />
          <span className="text-sm">Getting your address…</span>
        </div>
      )}

      {failed && !busy && (
        <>
          <Notice tone="danger" title="ledger could not get your address" testId="address-failed">
            <p>
              Nothing is wrong with this device and nothing has been lost — the address is created on the server
              the first time it is asked for, so trying again is safe.
            </p>
          </Notice>
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </>
      )}

      {address !== null && <AddressCard address={address} copied={copied} onCopy={() => void onCopy(address)} />}
    </Step>
  );
}

function AddressCard({
  address,
  copied,
  onCopy,
}: {
  address: string | null;
  copied: boolean | null;
  onCopy: () => void;
}) {
  if (address === null) return null;
  return (
    <div className="flex flex-col gap-3 p-4 rounded-[var(--radius)] border border-border bg-surface">
      {/*
        `select-all` and `break-all`: the address is the one string on this
        screen a person may need to move by hand when the clipboard is refused,
        and it is longer than a phone is wide.
      */}
      <p data-testid="inbound-address" className="font-mono text-sm select-all break-all">
        {address}
      </p>
      <Button variant="secondary" onClick={onCopy}>
        {copied === true ? "Copied" : "Copy address"}
      </Button>
      {copied === false && (
        <p role="status" className="text-xs text-bad">
          This browser would not let ledger use the clipboard. The address above can be selected by hand.
        </p>
      )}
    </div>
  );
}
