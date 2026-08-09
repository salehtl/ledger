/**
 * The onboarding walk: the machine in `v2/onboarding.ts` on one side, the five
 * screens on the other, and nothing else.
 *
 * # There is exactly one routing mechanism, and it is not here
 *
 * `screenFor(stepFor(facts))` decides what is on the glass. This component
 * holds no step number, no `next()` and no ordering of its own — every screen
 * reports a FACT (`banks_declared`, `address_issued`, …) and the position falls out
 * of the milestone table. That is what makes a force-quit free: nothing here is
 * a resume cursor that could disagree with what the log and the server say.
 *
 * The boot gate owns the layer above: it decides signed-out vs onboarding vs
 * ready, and re-derives the facts from scratch every time `done` is called. So
 * `done` is the only exit, and it is called once — when the machine reaches
 * `done`, which needs `setupSeen`, which the finish screen sets.
 *
 * # The device-local half is one field wide, and it is written on every change
 *
 * `saveLocalRecord` runs from an effect on the facts, so a tab closed between
 * two steps keeps the address it was given. Everything else a resumed walk needs
 * — the banks, the currency, whether mail has arrived — is in the log and on the
 * server, which is what makes a SECOND device resume at the same place rather
 * than at the beginning (`v2/onboarding.ts`'s header).
 *
 * # Ops go through `emitMany`, and the outbox is the receipt
 *
 * The bank step and the currency step both commit by handing `Client.emitMany`
 * the specs their pure module built. Nothing here waits for a push: an op in the
 * outbox is durable (`emitMany` commits the client state before it returns), and the sync
 * engine drains it. A screen that awaited a network round trip before advancing
 * would strand an offline user on the last step of setup.
 */

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import { Button } from "../../components/ui/Button";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import type { SecretStore } from "@ledger/client/store/store";
import type { SqlDriver } from "@ledger/client/store/driver";

import {
  onboardingReducer,
  saveLocalRecord,
  screenFor,
  stepFor,
  type OnboardingFacts,
  type OpSpec,
  type SkippableStep,
} from "../../v2/onboarding";
import { PROFILE, SERVER } from "../../v2/BootGate";
import { bankDeclaredOps } from "../../v2/sources/banks";
import { sqlBudgetSource, type BudgetSource } from "../../v2/sources/budget";
import { webSecretStore, type V2Handle } from "../../v2/session";
import { browserKeyVault, keyStatus, type KeyStatus, type KeyVault } from "../../v2/keys";
import { Address } from "./Address";
import { RecoveryPhrase } from "./RecoveryPhrase";
import { Bank } from "./Bank";
import { BudgetSplitStep } from "./BudgetSplitStep";
import { HomeCurrency } from "./HomeCurrency";
import { Notice, Step } from "./Shell";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { ImportFile } from "../ImportFile";
import type { Writer } from "../../v2/writer";

export interface OnboardingProps {
  handle: V2Handle;
  /** Where the walk resumes from, as `boot()` re-derived it. */
  facts: OnboardingFacts;
  /** The boot gate's `again`. Called once the machine reaches `done`. */
  done: () => void;
  /** Injected by tests. */
  fetch?: typeof fetch;
  secrets?: SecretStore;
  server?: string;
  /** Injected by tests. Defaults to the browser's IndexedDB key vault. */
  vault?: KeyVault;
  /**
   * Injected by tests. Defaults to this device's projection — the finish
   * screen's plan control must read the plan the account already holds before
   * it can offer to replace it.
   */
  budgetSource?: BudgetSource;
}

export function Onboarding({
  handle,
  facts: initial,
  done,
  fetch: doFetch,
  secrets,
  server = SERVER,
  vault,
  budgetSource,
}: OnboardingProps) {
  const [facts, dispatch] = useReducer(onboardingReducer, initial);
  const step = stepFor(facts);
  /**
   * The forwarding claim, and the flag this walk no longer keeps.
   *
   * `Address` still reports whether the chosen provider is expected to email a
   * confirmation code, because that decides what its own screen says. Nothing
   * downstream reads it any more: the step that used to — a wait for the code
   * and then for a bank alert — is gone, and the provider's confirmation is now
   * a task the user does from Held mail whenever it turns up. A value with no
   * reader is dropped here rather than carried as state that looks meaningful.
   */
  const declareForwarding = useCallback((_expectConfirmation: boolean) => {
    dispatch({ type: "forwarding_declared" });
  }, []);

  /**
   * "Set this up later", from whichever step asked.
   *
   * The one piece of policy: **skipping the address skips the forwarding step
   * too.** They are one subject — here is your address, now send mail to it —
   * and the forwarding screen with no address on it is a page of instructions
   * pointing at nothing. Keeping the rule here rather than in `Address` means
   * the two steps' relationship is stated once, next to the table it is derived
   * from.
   */
  const skip = useCallback((step: SkippableStep) => {
    dispatch({ type: "step_skipped", step });
    if (step === "address_issued") dispatch({ type: "step_skipped", step: "forwarding_configured" });
  }, []);

  useEffect(() => {
    saveLocalRecord(secrets ?? webSecretStore(PROFILE), facts);
  }, [facts, secrets]);

  useEffect(() => {
    // The one exit. `done` re-runs boot, which re-derives these same facts from
    // the log, the server and the record just written — so the hand-off cannot
    // disagree with what this component believed.
    if (step === "done") done();
  }, [step, done]);

  const io = {
    ...(server === "" ? {} : { server }),
    ...(doFetch === undefined ? {} : { fetch: doFetch }),
  };

  const commit = useCallback(
    (ops: readonly OpSpec[]) => {
      if (ops.length === 0) return;
      handle.client.emitMany(ops);
    },
    [handle],
  );

  switch (screenFor(step)) {
    case "recovery":
      return (
        <RecoveryStep
          handle={handle}
          vault={vault ?? browserKeyVault()}
          server={server}
          {...(doFetch === undefined ? {} : { fetch: doFetch })}
          onSecured={() => dispatch({ type: "keys_secured" })}
        />
      );

    case "bank":
      return (
        <Bank
          client={handle.client}
          onDeclared={(banks) => {
            // The ops FIRST, then the fact. The log is what a second device
            // reads — a fact dispatched without them would advance this walk and
            // leave the next phone at the bank step.
            commit(banks.flatMap((bank) => bankDeclaredOps(bank, true)));
            dispatch({ type: "banks_declared", banks });
          }}
          onSkip={() => skip("banks_declared")}
          {...io}
        />
      );

    case "address":
      return (
        <Address
          client={handle.client}
          phase="address"
          known={facts.inboundAddress}
          onIssued={(address) => dispatch({ type: "address_issued", address })}
          onForwardingDeclared={declareForwarding}
          onSkip={skip}
          {...io}
        />
      );

    case "forwarding":
      return (
        <Address
          client={handle.client}
          phase="forwarding"
          known={facts.inboundAddress}
          onIssued={(address) => dispatch({ type: "address_issued", address })}
          onForwardingDeclared={declareForwarding}
          onSkip={skip}
          {...io}
        />
      );

    case "home_currency":
      return (
        <HomeCurrency
          commit={commit}
          onSet={(currency) => dispatch({ type: "home_currency_set", currency })}
          existing={facts.homeCurrency}
          onSkip={() => skip("home_currency_set")}
        />
      );

    case "finish":
      return (
        <Finish
          facts={facts}
          commit={commit}
          driver={handle.driver}
          {...(budgetSource === undefined ? {} : { budgetSource })}
          onFinish={() => dispatch({ type: "finished" })}
        />
      );

    // `sign_in`, `confirming` and `product` are the boot gate's, not this
    // component's. Reaching one means the gate routed here on facts that no
    // longer say "onboarding", so the honest answer is to hand control back
    // rather than render a step whose preconditions are not met.
    case "sign_in":
    case "confirming":
    case "product":
      return (
        <Step title="Finishing setup" testId="onboarding-handback">
          <div className="flex items-center gap-3 text-muted" role="status">
            <PixelSpinner size={12} />
            <span className="text-sm">One moment…</span>
          </div>
        </Step>
      );
  }
}

/**
 * The recovery step, with the one question it has to answer first: does the
 * ACCOUNT already have keys?
 *
 * Both ceremonies live in `RecoveryPhrase`, and which one it shows is decided by
 * `keyStatus` — so the read happens here rather than in the boot gate, whose
 * `keysReady` deliberately collapses the three states into one boolean. A
 * `ready` answer at this point means another tab finished the ceremony while
 * this one sat on the step; reporting the fact is the right response to that,
 * not rendering a screen asking for keys that already exist.
 */
function RecoveryStep({
  handle,
  vault,
  server,
  fetch: doFetch,
  onSecured,
}: {
  handle: V2Handle;
  vault: KeyVault;
  server: string;
  fetch?: typeof fetch;
  onSecured: () => void;
}) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * Bumped by "Try again", and a dependency of the read below.
   *
   * Explicit, rather than resting on the effect happening to re-run: `vault`
   * defaults to `browserKeyVault()` called inline in the JSX, so it is a new
   * object on every render and the read already re-fires more often than it
   * looks like it does. Depending on that accident to drive a retry would be a
   * retry that stops working the day someone memoises the prop.
   */
  const [attempt, setAttempt] = useState(0);
  const io = useMemo(
    () => ({
      sessionToken: handle.client.sessionToken,
      server,
      ...(doFetch === undefined ? {} : { fetch: doFetch }),
    }),
    [handle, server, doFetch],
  );

  useEffect(() => {
    let live = true;
    void keyStatus(handle.client.userId, vault, io).then(
      (s) => {
        if (!live) return;
        // A read that lands clears the wall. Without this the screen was
        // one-way: `failed` was only ever set to true, so a device that came
        // back online — and whose next read succeeded — kept the "could not
        // reach the server" notice on the glass with nothing behind it.
        setFailed(false);
        if (s.kind === "ready") onSecured();
        else setStatus(s);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [handle, vault, io, onSecured, attempt]);

  if (failed) {
    return (
      /*
       * A refusal with a way out of it, on the same screen.
       *
       * This branch used to render a title and a `Notice` and nothing else — no
       * footer, no skip (the recovery step is deliberately not skippable), no
       * sign-out. The only escape was force-quitting the app, which is what the
       * copy asked for. The product principles name this exact shape: "Never let
       * a security rule become a dead end. Every refusal needs a next action on
       * the same screen." The sibling ceremony in `RecoveryPhrase` already gives
       * the identical failure a "Try again"; this is the same button.
       */
      <Step
        title="Setting up encryption"
        testId="onboarding-recovery-unavailable"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
        }
      >
        <Notice tone="danger" announce title="ledger could not reach the server">
          <p>
            Setting up encryption needs one call to the server, and this device could not make it. Nothing is lost —
            try again when you have a connection, or reopen ledger later and this step will pick up where it left off.
          </p>
        </Notice>
      </Step>
    );
  }

  if (status === null) {
    return (
      <Step title="Setting up encryption" testId="onboarding-recovery">
        <div className="flex items-center gap-3 text-muted" role="status">
          <PixelSpinner size={12} />
          <span className="text-sm">One moment…</span>
        </div>
      </Step>
    );
  }

  return (
    <RecoveryPhrase
      accountId={handle.client.userId}
      vault={vault}
      io={io}
      published={status.kind === "needs_recovery" ? status.published : null}
      onSecured={onSecured}
    />
  );
}

/**
 * The last screen, and the reason `setupSeen` is a fact at all.
 *
 * The currency op is emitted the instant the picker is confirmed, so without
 * this the screen explaining what happens next would be skipped in the same
 * frame it appeared. It is in-memory because it is about what this person has
 * been shown in this session, not about the account — and on a device that has
 * never seen it for an account that is already set up, `resumeFacts` treats the
 * prerequisites being met as answer enough, so a second phone opens the app.
 */
function Finish({
  facts,
  commit,
  driver,
  budgetSource,
  onFinish,
}: {
  facts: OnboardingFacts;
  commit: (ops: readonly OpSpec[]) => void;
  driver: SqlDriver;
  budgetSource?: BudgetSource;
  onFinish: () => void;
}) {
  /*
    Built HERE and not in `Onboarding`, so it is constructed only when this
    screen is actually on the glass: `sqlBudgetSource` runs `ensureProjection`
    against the driver, and the earlier steps must not depend on a projection
    that a device part-way through setup may not have written yet.
  */
  const source = useMemo(() => budgetSource ?? sqlBudgetSource(driver), [budgetSource, driver]);
  return (
    <Step
      testId="onboarding-finish"
      title="That is setup done"
      intro="From here ledger works on its own. Nothing else needs configuring."
      footer={
        <Button variant="primary" onClick={onFinish}>
          Open ledger
        </Button>
      }
    >
      <Notice title="What happens now">
        {/*
          "Every transaction email your FILTER forwards" — which a user who set
          this address with their bank directly does not have. The sentence says
          what is true of both routes: mail that reaches the address is filed.
        */}
        <p>
          Every transaction email that reaches{" "}
          <span className="font-mono break-all">{facts.inboundAddress ?? "your ledger address"}</span> becomes a
          transaction, usually within a minute of your bank sending it.
        </p>
        <p>
          Mail from a sender ledger cannot verify is held rather than filed, and it waits for you in the app — it
          is never dropped and never read on your behalf.
        </p>
        <p>
          Your totals are kept in {facts.homeCurrency ?? "your home currency"}, and exchange rates are yours to
          adjust whenever you like.
        </p>
      </Notice>

      {/* Optional, and it rides here rather than being a step of its own
          because the machine's steps are derived from milestones that must be
          MET — see `BudgetSplitStep`'s header. "Open ledger" above is a complete
          answer to it, and an account that ignores it keeps 50/30/20. */}
      <BudgetSplitStep commit={commit} currency={facts.homeCurrency ?? null} source={source} />

      {/* Same argument, for the same reason: a new account's ledger is empty
          until its bank sends its first alert, and the user has a statement they
          could import right now. It is an offer on the last screen, never a
          milestone — nothing here has to be met to leave. */}
      <ImportOffer commit={commit} />
    </Step>
  );
}

/**
 * "You can bring your history with you", on the last screen of the walk.
 *
 * # Why the walk and not only Settings
 *
 * A new account's ledger is empty, and stays empty until the user's bank sends
 * its first alert — which may be days. The one thing that fills it today is a
 * statement the user can already download. Burying that in Settings means the
 * app's first impression is a screen with nothing on it.
 *
 * # It authors through the SAME outbox as everything else here
 *
 * `commit` is `Client.emitMany`, which is what the bank step and the currency
 * step append with; it commits before it returns, so the ops are durable the
 * moment they are queued and the sync coordinator drains them. The adapter
 * below is the `Writer` shape {@link ImportFile} expects — `pending` is empty
 * because nothing on this screen reads it, and `flush` is a no-op because there
 * is no outbox to drain yet: the coordinator picks the ops up on boot.
 */
function ImportOffer({ commit }: { commit: (ops: readonly OpSpec[]) => void }) {
  const [open, setOpen] = useState(false);
  const writer = useMemo<Writer>(
    () => ({ pending: [], enqueueMany: (specs) => commit(specs), flush: async () => undefined }),
    [commit],
  );
  return (
    <Card>
      <h2 className="text-sm font-semibold text-fg">Bring your history with you</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        If your bank lets you export a CSV, you can add those transactions now. The file is read on this device and
        never uploaded. You can also do this later, in Settings.
      </p>
      <Button variant="secondary" className="mt-3" onClick={() => setOpen(true)}>
        Import a statement
      </Button>
      {open && (
        <Dialog title="Import a statement" onClose={() => setOpen(false)}>
          <ImportFile writer={writer} />
        </Dialog>
      )}
    </Card>
  );
}
