/**
 * The inbound address, and how bank mail is going to get to it.
 *
 * Two positions of the machine (`address_issued`, then `forwarding_configured`)
 * on one component, because they are one subject: here is your address, now send
 * mail to it. The `phase` prop picks which half is on screen.
 *
 * # There were two routes. One is retired, and it is retired, not deleted
 *
 * Most UAE banks let a customer set the address their alerts go to, and that
 * route has no forwarder, no confirmation code, and no rule a provider can
 * silently switch off. On the availability argument alone it was the better one,
 * and it was offered first and named as such.
 *
 * The argument was incomplete. A bank's alert address is also where that bank
 * sends security alerts and one-time codes, and most banks keep exactly one. So
 * the route asked the user to hand ledger their bank's only channel to them —
 * "very dumb as it prevents them from managing their bank account", in the
 * operator's words. The `Notice` under it half-admitted this and left the user
 * to weigh it.
 *
 * So it is **sunset behind {@link DIRECT_BANK_ROUTE}, not deleted**, per the
 * standing rule in this project: the operator decides how and whether a feature
 * returns, and a route with a live user behind it is not a thing to delete. Its
 * code, its tests and its copy — including that `Notice`, which is now the
 * record of why it was retired — all stay.
 *
 * **Nobody is migrated and nobody is interrupted.** This screen only ever asked
 * where mail would come from; it never wrote a rule anywhere. A user whose bank
 * already writes to this address directly keeps working exactly as before —
 * that mail verifies on the OUTER scope, on the verification screen, and this
 * flag cannot reach it.
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
 * # The instructions are a REGISTRY, and nobody is asked to pick from it
 *
 * This half used to be four hardcoded Gmail sentences, which were simply wrong
 * for every other provider — and worst for iCloud, whose flow has no
 * confirmation code at all while the copy told the user to wait for one. The
 * sentences come from `v2/providers.ts`, which carries instructions and
 * nothing else.
 *
 * The first fix made the registry a PICKER — a fork asking "where does your
 * bank mail arrive?" before any instructions appeared, when the generic set is
 * true everywhere. So the fork is gone too: {@link GENERIC} leads, and each
 * provider's exact taps are a collapsed disclosure ({@link ProviderHelp}),
 * opened only by a user who wants them. Which disclosures are open is UI state
 * that never leaves this screen; `onForwardingDeclared` carries the registry's
 * conservative answer (`GENERIC.needsConfirmation`), and it never reaches a
 * trust decision: `providers.test.ts` asserts no module in the trust path can
 * even import the registry.
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { ChevronDown, ChevronRight } from "../../components/ui/PixelIcon";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { Pressable } from "../../components/ui/Pressable";
import { readAddress } from "../../v2/address";
import { readQuarantine, type TokenSource } from "../../v2/onboardingIO";
import { GENERIC, PROVIDERS } from "../../v2/providers";
import { confirmationTask, type ConfirmationTask } from "../../v2/verificationCode";
import {
  enablePush,
  isPushSubscribed,
  pushUnsupportedReason,
  type PushEnvironment,
  type PushUnsupportedReason,
  type WebPushDeps,
} from "../../v2/webpush";
import { OPEN_CONFIRMATION_COPY } from "./SetupStatus";
import { Notice, SkipStep, Step } from "./Shell";

/**
 * Whether "set this address with your bank directly" is offered at all.
 *
 * **Off.** See the header for why the route was retired and why it is still
 * here. Flipping this back to `true` restores the route picker, the direct
 * instructions, its caveat `Notice` and both ways to swap between the routes —
 * nothing else in the product has to change, because both routes always ended
 * at the same `forwarding_declared` fact.
 *
 * `AddressProps.directRoute` overrides it, which is how `Address.test.tsx` keeps
 * testing a retired route: the copy and behaviour must not rot while it is off,
 * or turning it back on ships something nobody has run.
 */
export const DIRECT_BANK_ROUTE = false;

export interface AddressProps {
  client: TokenSource;
  phase: "address" | "forwarding";
  /** `address_issued`, with the address the server actually minted. */
  onIssued: (address: string) => void;
  /**
   * `forwarding_declared`.
   *
   * `expectConfirmation` says whether a later mail check should offer to read a
   * confirmation code. No provider is asked for any more, so the forwarding
   * route always reports {@link GENERIC}'s conservative `true`, and the retired
   * direct route reports `false` — a bank writing straight to the address has
   * no forwarder to confirm. It is a hint about which sentences and controls to
   * render, and nothing else may be decided by it.
   */
  onForwardingDeclared: (expectConfirmation: boolean) => void;
  /**
   * "Set this up later", for whichever half is on screen.
   *
   * The address half is the one this matters most on. `GET /api/v1/address` is a
   * network call, and until this existed a failure left the screen with exactly
   * one control — "Try again" — so a user whose address could not be minted had
   * no way into the app at all. That is the shape of every lockout this design
   * removes: one call, no second door.
   */
  onSkip?: (step: "address_issued" | "forwarding_configured") => void;
  /** The address already known, so the forwarding half need not re-read. */
  known: string | null;
  server?: string;
  fetch?: typeof fetch;
  /** Injected by tests; defaults to the Clipboard API. */
  copy?: (text: string) => Promise<void>;
  /**
   * Rendered inside a `Dialog` rather than as a whole step. See `Shell`.
   *
   * Settings opens the forwarding half this way, because a step that was skipped
   * during setup has to be finishable afterwards — and the instructions a user
   * needs are the same instructions, not a second copy of them.
   */
  embedded?: boolean;
  /** Overrides {@link DIRECT_BANK_ROUTE}. Tests only — see that flag. */
  directRoute?: boolean;
  /**
   * Opens the held-mail surface. The fallback when the provider's confirmation
   * is held but no link could be read out of it — a message that exists must
   * never be a dead end. Same seam `SetupStatus` takes.
   */
  onOpenHeldMail?: () => void;
  /**
   * Test seam: how the confirmation link opens. Defaults to a new tab with no
   * opener, so the held page cannot reach back into this one.
   */
  openUrl?: (url: string) => void;
  /**
   * Test seams for the "notify me when it arrives" opt-in, mirroring the ones
   * `PushNotificationsPanel` takes. `env` probes support, `enable` runs the
   * subscription, `subscribed` reports whether this browser already holds one —
   * each defaulting to the real browser + webpush, so production needs no extra
   * wiring for the control to work.
   */
  env?: PushEnvironment;
  enable?: typeof enablePush;
  subscribed?: typeof isPushSubscribed;
  /** Namespaces the push writer id; defaults to the app profile. */
  profile?: string;
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
  onSkip,
  known,
  server,
  fetch: doFetch,
  copy = writeClipboard,
  embedded = false,
  directRoute = DIRECT_BANK_ROUTE,
  onOpenHeldMail,
  openUrl,
  env,
  enable = enablePush,
  subscribed = isPushSubscribed,
  profile,
}: AddressProps) {
  const [address, setAddress] = useState<string | null>(known);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(known === null);
  const [copied, setCopied] = useState<boolean | null>(null);
  /**
   * How mail is going to reach ledger.
   *
   * With {@link DIRECT_BANK_ROUTE} off there is one route, so this starts at
   * `"forward"` and the picker is never drawn — an onboarding question with one
   * answer is a tap the user gains nothing by making. With the flag on it starts
   * `null`, which is the picker, deliberately not pre-answered.
   *
   * Both routes end at the same `forwarding_declared` fact, because the fact
   * means "the user says mail will now arrive here" — the screen after it is
   * what measures whether that is true.
   */
  const [route, setRoute] = useState<"direct" | "forward" | null>(directRoute ? null : "forward");
  /**
   * The provider's held confirmation, when one is already in the lane — the
   * same one-tap task `SetupStatus` shows, surfaced here because this screen is
   * where the user is when the confirmation arrives. Best-effort: a lane that
   * cannot be read just means no notice, never a broken screen.
   */
  const [confirmation, setConfirmation] = useState<ConfirmationTask | null>(null);

  useEffect(() => {
    if (phase !== "forwarding") return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await readQuarantine(
          client,
          { includeBlob: true },
          {
            ...(server === undefined ? {} : { server }),
            ...(doFetch === undefined ? {} : { fetch: doFetch }),
          },
        );
        if (!cancelled) setConfirmation(confirmationTask(page.items));
      } catch {
        // The instructions stand on their own; a notice that cannot be built
        // is simply not shown.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, client, server, doFetch]);

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

  // The picker, and below it the direct route. Both are unreachable while
  // `DIRECT_BANK_ROUTE` is off — `route` starts at `"forward"` and nothing on
  // screen sets it back. Kept whole, running, and under test; see the header.
  if (phase === "forwarding" && route === null) {
    return (
      <Step
        testId="forwarding"
        embedded={embedded}
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
            detail="Recommended. Most banks let you choose where alerts go, and there is no forwarding rule in between to break."
            onClick={() => setRoute("direct")}
          />
          <RouteRow
            title="Forward it from my email"
            detail="One rule in the mailbox your bank already writes to. Works with any provider, and with a bank that will not change the address."
            onClick={() => setRoute("forward")}
          />
        </div>
        {onSkip !== undefined && <SkipStep step="forwarding_configured" onSkip={() => onSkip("forwarding_configured")} />}
      </Step>
    );
  }

  if (phase === "forwarding" && route === "direct") {
    return (
      <Step
        testId="forwarding"
        embedded={embedded}
        title="Give this address to your bank"
        intro="Your bank writes to ledger, with nothing in between."
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
          <li>That is all. Each transaction email becomes a transaction as it arrives.</li>
        </ol>
        {/*
          The two ways this route fails, said on the screen that proposes it
          rather than discovered halfway through a banking app.
        */}
        <Notice title="If your bank will not let you" testId="direct-caveat">
          <p>
            Some banks keep only one alert address. Setting this one would stop those emails arriving where they
            do now. If it cannot be changed, or you would rather keep it, use the forwarding button below instead.
          </p>
        </Notice>
        {onSkip !== undefined && <SkipStep step="forwarding_configured" onSkip={() => onSkip("forwarding_configured")} />}
      </Step>
    );
  }

  if (phase === "forwarding") {
    return (
      <Step
        testId="forwarding"
        embedded={embedded}
        title="Send your bank mail here"
        /*
          Not "the other way", and not "works with a bank that will not change
          the address" — that was this route being described as the fallback for
          a route that is gone, and copy that apologises for the only path is
          copy that makes a user look for a better one. What stays is what a
          privacy-conscious person weighs before doing it, which is the second
          sentence and is not a candidate for a tip.
        */
        intro="One forwarding rule in the mailbox your bank already writes to. ledger never sees the rest of that mailbox and never holds a password to it."
        footer={
          <>
            <Button variant="primary" onClick={() => onForwardingDeclared(GENERIC.needsConfirmation)}>
              I have set up forwarding
            </Button>
            {directRoute && (
              <Button variant="ghost" onClick={() => setRoute("direct")}>
                Set this address with my bank directly instead
              </Button>
            )}
          </>
        }
      >
        <AddressCard address={address} copied={copied} onCopy={() => void onCopy(address ?? "")} />

        {/*
          The one-tap task, above the instructions: a held confirmation means
          the rule is already made, and the tap is all that is left. Same words
          as the setup list — imported, not forked. A status, never an error.
          The verified domain is shown verbatim, as evidence. No extracted link
          is not a dead end: the tap opens held mail instead.
        */}
        {confirmation !== null && (
          <Notice title={OPEN_CONFIRMATION_COPY.title} testId="forwarding-confirmation">
            <p>{OPEN_CONFIRMATION_COPY.body}</p>
            {(confirmation.url !== null || onOpenHeldMail !== undefined) && (
              <Button
                variant="primary"
                onClick={() => {
                  if (confirmation.url !== null) {
                    (openUrl ?? ((url: string) => void window.open(url, "_blank", "noopener")))(confirmation.url);
                  } else {
                    onOpenHeldMail?.();
                  }
                }}
              >
                {OPEN_CONFIRMATION_COPY.action}
              </Button>
            )}
            <p data-testid="forwarding-confirmation-domain" className="text-xs text-muted">
              {confirmation.domain}
            </p>
          </Notice>
        )}

        {/*
          The generic instruction set, first and for everyone. It used to sit
          behind a picker as "Another provider" — a fork the user had to answer
          before seeing instructions that are true everywhere. Its last step is
          the whole confirmation story: no promised code, no promised screen,
          just where the message will be if one comes.
        */}
        <ol data-testid="forwarding-generic" className="flex flex-col gap-3 text-sm leading-relaxed list-decimal pl-5">
          {GENERIC.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        <ProviderHelp />

        {/*
          The optional "tell me when it arrives", offered only where a user is
          actually waiting: on the onboarding surface, not the Settings re-open
          (`embedded`), and only while no confirmation is already in hand — a
          notification for a message that has landed is noise. It blocks
          nothing; the confirmation surfaces in-app regardless.
        */}
        {!embedded && confirmation === null && (
          <NotifyOptIn
            client={client}
            server={server}
            fetch={doFetch}
            profile={profile}
            env={env}
            enable={enable}
            subscribed={subscribed}
          />
        )}

        {onSkip !== undefined && <SkipStep step="forwarding_configured" onSkip={() => onSkip("forwarding_configured")} />}
      </Step>
    );
  }

  return (
    <Step
      testId="address"
      embedded={embedded}
      title="Your inbound address"
      intro="This address is yours alone. Bank mail sent here becomes transactions. Nothing else about your mailbox is read, and ledger never holds a password to it."
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
            <p>Nothing is wrong with this device and nothing was lost. Trying again is safe.</p>
          </Notice>
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </>
      )}

      {address !== null && <AddressCard address={address} copied={copied} onCopy={() => void onCopy(address)} />}

      {/* Present whether or not the read succeeded — see `onSkip`. */}
      {onSkip !== undefined && <SkipStep step="address_issued" onSkip={() => onSkip("address_issued")} />}
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
 * Per-provider steps, offered rather than asked.
 *
 * This was a picker — a fork titled "Where does your bank mail arrive?" that
 * stood between the user and any instructions, when the generic set above is
 * true everywhere. Each provider is now a collapsed disclosure: a 44px
 * `Pressable` header whose label names exactly what it reveals ("Show the
 * Gmail steps"), with the chevron state the transaction rows already use, and
 * content that is conditionally rendered — no animation, matching the
 * codebase's other disclosures. Several can be open at once, because reading
 * two providers' steps is not answering a question.
 *
 * A provider's caveat renders INSIDE its opened disclosure, still a `Notice`,
 * still above the steps it may invalidate: "before the user tries" is a
 * position on the page, not a tone of voice. Outlook's is the case that
 * settles it — a Microsoft 365 work account may be unable to forward at all,
 * so the list beneath it is not merely incomplete, it is unusable.
 */
function ProviderHelp() {
  const [open, setOpen] = useState<readonly string[]>([]);
  const toggle = (id: string) =>
    setOpen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  return (
    <div
      data-testid="provider-help"
      className="flex flex-col rounded-[var(--radius)] border border-border bg-surface divide-y divide-border"
    >
      {PROVIDERS.map((p) => {
        const isOpen = open.includes(p.id);
        return (
          <div key={p.id} className="flex flex-col">
            <Pressable
              aria-expanded={isOpen}
              onClick={() => toggle(p.id)}
              className={`min-h-11 px-4 py-3 text-left text-sm font-medium flex items-center justify-between gap-3 transition-colors ${
                isOpen ? "text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
              }`}
            >
              <span>{isOpen ? `Hide the ${p.label} steps` : `Show the ${p.label} steps`}</span>
              {isOpen ? (
                <ChevronDown size={16} aria-hidden className="shrink-0" />
              ) : (
                <ChevronRight size={16} aria-hidden className="shrink-0" />
              )}
            </Pressable>
            {isOpen && (
              <div data-testid={`provider-steps-${p.id}`} className="px-4 pb-4 flex flex-col gap-3">
                {p.caveat !== undefined && (
                  <Notice announce title={`Before you start with ${p.label}`} testId={`provider-caveat-${p.id}`}>
                    <p>{p.caveat}</p>
                  </Notice>
                )}
                <ol className="flex flex-col gap-3 text-sm leading-relaxed list-decimal pl-5">
                  {p.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        );
      })}
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

/**
 * The opt-in's words. Honest about a content-free push: it can say a thing
 * arrived, and no more — the server payload carries nothing and the service
 * worker renders its own constant. The unsupported strings are the Settings
 * panel's own, mirrored here; the iOS one is the sole actionable reason.
 */
const NOTIFY_COPY = {
  body: "The confirmation can take a while to arrive. ledger can tell you the moment it does — it says only that something arrived, never what.",
  action: "Get a notification when it arrives",
  on: "ledger will let you know when it arrives.",
  blockedTitle: "Notifications are blocked for ledger in this browser.",
  blockedHelp: "Only you can undo that, in your browser's settings for this site.",
} as const;

const NOTIFY_UNSUPPORTED_COPY: Record<PushUnsupportedReason, string> = {
  browser: "This browser can't show notifications.",
  insecure: "Notifications need a secure connection.",
  install: "On iPhone and iPad, add ledger to your Home Screen first. Then notifications can be turned on.",
};

type NotifyState =
  | { kind: "checking" }
  | { kind: "unsupported"; reason: PushUnsupportedReason }
  | { kind: "offer" }
  | { kind: "hidden" }
  | { kind: "on" }
  | { kind: "blocked" };

/**
 * The optional, skippable "tell me when it arrives".
 *
 * The provider's confirmation can land minutes or hours after the rule is made,
 * and nothing makes the user sit on this screen until it does — so this offers,
 * once, to have ledger buzz the phone when it comes. It gates nothing: the
 * confirmation still surfaces in the app the moment it lands (the notice above,
 * and `SetupStatus` on the home screen), taken or not. Skipping is the default.
 *
 * A notification says only what it ever says — that something arrived, never
 * what. So no copy here promises more than "it's here".
 *
 * Support and subscription are probed through the same seams the Settings panel
 * uses, so an environment that cannot show a notification is told the honest
 * reason (the iOS one is the actionable one — add to the Home Screen) rather
 * than handed a button that cannot work, and a browser already subscribed is
 * never asked again.
 */
function NotifyOptIn({
  client,
  server,
  fetch: doFetch,
  profile,
  env,
  enable,
  subscribed,
}: {
  client: TokenSource;
  server?: string;
  fetch?: typeof fetch;
  profile?: string;
  env?: PushEnvironment;
  enable: typeof enablePush;
  subscribed: typeof isPushSubscribed;
}) {
  const [state, setState] = useState<NotifyState>({ kind: "checking" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The one guard: an unsupported environment is told the honest reason and
    // never probed further. Dropping this line is what would put a dead button
    // on iOS — the test holds it shut.
    const reason = pushUnsupportedReason(env);
    if (reason !== null) {
      setState({ kind: "unsupported", reason });
      return;
    }
    let cancelled = false;
    void subscribed(env)
      .then((on) => {
        if (!cancelled) setState({ kind: on ? "hidden" : "offer" });
      })
      .catch(() => {
        // A browser that will not say whether it is subscribed is not one to
        // pester with an offer; stay quiet.
        if (!cancelled) setState({ kind: "hidden" });
      });
    return () => {
      cancelled = true;
    };
  }, [env, subscribed]);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const deps: WebPushDeps = {
        client,
        ...(profile === undefined ? {} : { profile }),
        ...(server === undefined ? {} : { server }),
        ...(doFetch === undefined ? {} : { fetch: doFetch }),
        ...env,
      };
      const outcome = await enable(deps);
      switch (outcome.kind) {
        case "on":
          setState({ kind: "on" });
          break;
        case "denied":
          setState({ kind: "blocked" });
          break;
        case "unavailable":
          // This deployment has no push to subscribe to. Nothing to offer, and
          // nothing gone wrong — fold the control away.
          setState({ kind: "hidden" });
          break;
        case "dismissed":
        case "failed":
          // A closed prompt or a transient failure both leave the offer
          // standing: the browser will ask again, and this blocks nothing.
          setState({ kind: "offer" });
          break;
      }
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "checking" || state.kind === "hidden") return null;

  if (state.kind === "unsupported") {
    return (
      <p data-testid="notify-unsupported" className="text-xs leading-relaxed text-muted">
        {NOTIFY_UNSUPPORTED_COPY[state.reason]}
      </p>
    );
  }

  if (state.kind === "on") {
    return (
      <p data-testid="notify-on" className="text-xs leading-relaxed text-muted">
        {NOTIFY_COPY.on}
      </p>
    );
  }

  if (state.kind === "blocked") {
    return (
      <div data-testid="notify-blocked" className="space-y-1">
        <p className="text-xs leading-relaxed">{NOTIFY_COPY.blockedTitle}</p>
        <p className="text-xs leading-relaxed text-muted">{NOTIFY_COPY.blockedHelp}</p>
      </div>
    );
  }

  return (
    <div
      data-testid="notify-opt-in"
      className="flex flex-col gap-3 p-4 rounded-[var(--radius)] border border-border bg-surface"
    >
      <p className="text-xs leading-relaxed text-muted">{NOTIFY_COPY.body}</p>
      <Button variant="secondary" disabled={busy} onClick={() => void run()}>
        {NOTIFY_COPY.action}
      </Button>
    </div>
  );
}
