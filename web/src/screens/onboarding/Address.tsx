/**
 * The inbound address, and how bank mail is going to get to it.
 *
 * Two positions of the machine (`address_issued`, then `forwarding_configured`)
 * on one component, because they are one subject: here is your address, now send
 * mail to it. The `phase` prop picks which half is on screen.
 *
 * # There are two routes, and forwarding is the weaker one
 *
 * Most UAE banks let a customer set the address their alerts go to. That route
 * has no forwarder, no confirmation code, and no rule a provider can silently
 * switch off — which removes the largest availability risk in the product, a
 * forwarding rule that turns itself off after an outage with nobody noticing. So
 * it is offered first and named as the better one, and forwarding is the answer
 * for a bank that will not let the address be changed.
 *
 * Both routes end at the same `forwarding_declared` fact. The name is now wider
 * than the thing it describes, and that is preferred to renaming a milestone the
 * boot gate, the local record and the step table all read: the fact means "the
 * user says mail will now arrive here", which is exactly as much as this screen
 * has ever known.
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
 * Nothing on this device can see a mail rule, and the only evidence a forward
 * works is mail arriving — which is the *next* step. So this step ends with the
 * user saying they have done it, and the verification step is what actually
 * measures it. Calling the fact `forwardingDeclared` rather than
 * `forwardingConfigured` is the same honesty in the machine.
 *
 * # The instructions are a REGISTRY, and the choice is UI state
 *
 * This half used to be four hardcoded Gmail sentences, which were simply wrong
 * for every other provider — and worst for iCloud, whose flow has no
 * confirmation code at all while the copy told the user to wait for one. The
 * sentences now come from `v2/providers.ts`, which carries instructions and
 * nothing else.
 *
 * The one thing the choice is allowed to decide beyond which sentences render is
 * whether the NEXT screen offers a confirmation-code reader, which travels as
 * the boolean argument to {@link AddressProps.onForwardingDeclared}. It never
 * reaches a trust decision: `providers.test.ts` asserts no module in the trust
 * path can even import the registry.
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { Pressable } from "../../components/ui/Pressable";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { readAddress } from "../../v2/address";
import type { TokenSource } from "../../v2/onboardingIO";
import { GENERIC, PROVIDERS, providerFor, type Provider } from "../../v2/providers";
import { Notice, Step } from "./Shell";

export interface AddressProps {
  client: TokenSource;
  phase: "address" | "forwarding";
  /** `address_issued`, with the address the server actually minted. */
  onIssued: (address: string) => void;
  /**
   * `forwarding_declared`.
   *
   * `expectConfirmation` says whether the verification step should offer to read
   * a confirmation code — true unless the chosen provider is known to send none.
   * It is a hint about which sentences and controls to render, and nothing else
   * may be decided by it.
   */
  onForwardingDeclared: (expectConfirmation: boolean) => void;
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
  /**
   * Which provider's instructions are on screen. `null` is not "unset waiting to
   * be filled in" — it renders {@link GENERIC}, so there are always instructions
   * on the glass and no provider is presumed to be the user's.
   */
  const [providerId, setProviderId] = useState<string | null>(null);
  /**
   * How mail is going to reach ledger. `null` until the user says.
   *
   * Deliberately not defaulted to forwarding: the direct route is the one with
   * no rule to break, and defaulting would bury it under instructions for the
   * fragile path. Both routes end at the same `forwarding_declared` fact,
   * because the fact means "the user says mail will now arrive here" — the
   * screen after it is what measures whether that is true.
   */
  const [route, setRoute] = useState<"direct" | "forward" | null>(null);

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

  if (phase === "forwarding" && route === null) {
    return (
      <Step
        testId="forwarding"
        title="How should your bank mail reach ledger?"
        intro="Two ways, and the first one is steadier. ledger never holds a password to any mailbox either way."
      >
        <AddressCard address={address} copied={copied} onCopy={() => void onCopy(address ?? "")} />
        <div
          data-testid="route-picker"
          className="flex flex-col rounded-[var(--radius)] border border-border bg-surface divide-y divide-border"
        >
          <RouteRow
            title="Set this address with your bank directly"
            detail="Recommended. Most banks let you choose where alerts are sent, and there is no forwarding rule in between to be switched off."
            onClick={() => setRoute("direct")}
          />
          <RouteRow
            title="Forward it from my email"
            detail="One rule in the mailbox your bank already writes to. Works with any provider, and with a bank that will not let the address be changed."
            onClick={() => setRoute("forward")}
          />
        </div>
      </Step>
    );
  }

  if (phase === "forwarding" && route === "direct") {
    return (
      <Step
        testId="forwarding"
        title="Give this address to your bank"
        intro="Your bank writes to ledger, and nothing sits in between. Nothing else on this device needs setting up."
        footer={
          <>
            <Button variant="primary" onClick={() => onForwardingDeclared(false)}>
              I have set this address with my bank
            </Button>
            <Button variant="ghost" onClick={() => setRoute("forward")}>
              Forward it from my email instead
            </Button>
          </>
        }
      >
        <AddressCard address={address} copied={copied} onCopy={() => void onCopy(address ?? "")} />
        <ol data-testid="direct-steps" className="flex flex-col gap-3 text-sm leading-relaxed list-decimal pl-5">
          <li>
            In your bank&rsquo;s app or online banking, find where the email address for alerts or statements is
            set — often under your profile, contact details or notification settings.
          </li>
          <li>Set it to the address above.</li>
          <li>That is all. Each transaction email your bank sends becomes a transaction as it arrives.</li>
        </ol>
        {/*
          The two ways this route fails, said on the screen that proposes it
          rather than discovered halfway through a banking app.
        */}
        <Notice title="If your bank will not let you" testId="direct-caveat">
          <p>
            Some banks keep only one alert address, so setting this one stops those emails arriving where they
            arrive now. If that address cannot be changed at all, or you would rather keep it, forward from your
            email instead — the button below switches.
          </p>
        </Notice>
      </Step>
    );
  }

  if (phase === "forwarding") {
    const provider: Provider = providerId === null ? GENERIC : providerFor(providerId);
    return (
      <Step
        testId="forwarding"
        title="Send your bank mail here"
        intro="One forwarding rule in the mailbox your bank already writes to. ledger never sees the rest of that mailbox and never holds a password to it."
        footer={
          <>
            <Button variant="primary" onClick={() => onForwardingDeclared(provider.needsConfirmation)}>
              I have set up forwarding
            </Button>
            <Button variant="ghost" onClick={() => setRoute("direct")}>
              Set this address with my bank directly instead
            </Button>
          </>
        }
      >
        <AddressCard address={address} copied={copied} onCopy={() => void onCopy(address ?? "")} />

        <ProviderPicker selected={providerId} onSelect={setProviderId} />

        {/*
          The caveat is a Notice rather than a numbered step: it is not something
          to do, it is something that may stop the doing from working — and it is
          rendered ABOVE the steps, because "before the user tries" is a position
          on the page and not a tone of voice. Outlook's is the case that settles
          it: a Microsoft 365 work account may be unable to forward at all, so
          the list beneath it is not merely incomplete, it is unusable. Under the
          steps, that read as a footnote to instructions already being followed.
        */}
        {provider.caveat !== undefined && (
          <Notice announce title={`Before you start with ${provider.label}`} testId="provider-caveat">
            <p>{provider.caveat}</p>
          </Notice>
        )}

        <ol data-testid="forwarding-steps" className="flex flex-col gap-3 text-sm leading-relaxed list-decimal pl-5">
          {provider.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        <Notice>
          <p>
            A rule rather than blanket forwarding is the point: ledger only ever receives the messages you chose,
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
          <Notice tone="danger" announce title="ledger could not get your address" testId="address-failed">
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

/**
 * One of the two ways mail can reach ledger.
 *
 * A two-line row rather than a `SegmentedControl`: the difference between these
 * routes is the second line, not the label, and a user picking blind between two
 * short words is how the fragile route gets chosen by accident.
 */
function RouteRow({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) {
  return (
    <Pressable
      onClick={onClick}
      className="min-h-11 px-4 py-3 text-left flex flex-col gap-1 hover:bg-surface-2 transition-colors"
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs leading-relaxed text-muted">{detail}</span>
    </Pressable>
  );
}

/**
 * Which provider's instructions to show.
 *
 * The same bordered, divided list of `Pressable` rows the bank step uses, rather
 * than a `SegmentedControl`: six labels of this length in one row would either
 * wrap or fall under the 44px target on a narrow phone, which is exactly the
 * case the catalog says to keep out of a segmented control.
 *
 * `aria-pressed` rather than a radio group: nothing is submitted, and the rows
 * are not a form field — they swap the copy underneath them.
 */
function ProviderPicker({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const rows = [...PROVIDERS, GENERIC];
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel as="h2">Where does your bank mail arrive?</SectionLabel>
      <div
        data-testid="provider-picker"
        className="flex flex-col rounded-[var(--radius)] border border-border bg-surface divide-y divide-border"
      >
        {rows.map((p) => (
          <Pressable
            key={p.id}
            aria-pressed={selected === p.id}
            onClick={() => onSelect(p.id)}
            className={`min-h-11 px-4 py-3 text-left text-sm font-medium transition-colors ${
              selected === p.id ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            {p.label}
          </Pressable>
        ))}
      </div>
      {/*
        Said plainly because the list is short on purpose: it is a shortcut to a
        set of instructions, never a statement about which providers work.

        And it stops at what is true. "ledger never learns which provider you
        use" was the sentence this nearly became, and it is false: this choice
        is never sent anywhere, but the server can see the domain that signed a
        forwarded message, which is usually the provider.
      */}
      <p className="text-xs text-muted">
        Any provider that can forward mail works. This choice only picks which instructions you see.
      </p>
    </div>
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
