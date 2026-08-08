/**
 * The onboarding walk: the machine in `v2/onboarding.ts` on one side, the five
 * screens on the other, and nothing else.
 *
 * # There is exactly one routing mechanism, and it is not here
 *
 * `screenFor(stepFor(facts))` decides what is on the glass. This component
 * holds no step number, no `next()` and no ordering of its own — every screen
 * reports a FACT (`bank_picked`, `address_issued`, …) and the position falls out
 * of the milestone table. That is what makes a force-quit free: nothing here is
 * a resume cursor that could disagree with what the log and the server say.
 *
 * The boot gate owns the layer above: it decides signed-out vs onboarding vs
 * ready, and re-derives the facts from scratch every time `done` is called. So
 * `done` is the only exit, and it is called once — when the machine reaches
 * `done`, which needs `finishedAt`, which the finish screen sets.
 *
 * # The device-local half is written on every change, not at the end
 *
 * `saveLocalRecord` runs from an effect on the facts, so a tab closed between
 * two steps resumes at the second one. Writing only at the end is what makes a
 * user re-pick their bank after a crash — cheap to repeat, but the point of the
 * record is that they do not have to.
 *
 * # Ops go through `emitMany`, and the outbox is the receipt
 *
 * The currency step commits by handing `Client.emitMany` the specs
 * `homeCurrencyOps` built. Nothing here waits for a push: an op in the outbox is
 * durable (`emitMany` commits the client state before it returns), and the sync
 * engine drains it. A screen that awaited a network round trip before advancing
 * would strand an offline user on the last step of setup.
 */

import { useCallback, useEffect, useReducer, useState } from "react";

import { Button } from "../../components/ui/Button";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import type { SecretStore } from "@ledger/client/store/store";

import {
  firstMailAt,
  onboardingReducer,
  saveLocalRecord,
  screenFor,
  stepFor,
  type OnboardingFacts,
  type OpSpec,
} from "../../v2/onboarding";
import { PROFILE, SERVER } from "../../v2/BootGate";
import { webSecretStore, type V2Handle } from "../../v2/session";
import { Address } from "./Address";
import { Bank } from "./Bank";
import { BudgetSplitStep } from "./BudgetSplitStep";
import { HomeCurrency } from "./HomeCurrency";
import { Notice, Step } from "./Shell";
import { Verification } from "./Verification";

export interface OnboardingProps {
  handle: V2Handle;
  /** Where the walk resumes from, as `boot()` re-derived it. */
  facts: OnboardingFacts;
  /** The boot gate's `again`. Called once the machine reaches `done`. */
  done: () => void;
  /**
   * The gate's coordinator, as a pull. Only the verification step uses it, and
   * that step cannot finish without it — see `Verification.tsx`'s header.
   */
  sync?: () => Promise<void>;
  /** Injected by tests. */
  fetch?: typeof fetch;
  secrets?: SecretStore;
  server?: string;
  pollMs?: number;
}

export function Onboarding({
  handle,
  facts: initial,
  done,
  sync,
  fetch: doFetch,
  secrets,
  server = SERVER,
  pollMs,
}: OnboardingProps) {
  const [facts, dispatch] = useReducer(onboardingReducer, initial);
  const step = stepFor(facts);
  /**
   * Whether the verification step should offer a confirmation-code reader.
   *
   * Component state, and deliberately NOT a fact: it decides copy and one
   * control, so it has no business in the milestone table, in the op log or in
   * `LocalOnboardingRecord` — a durable field would make a UI preference look
   * like something the machine reasons about, which is how a "which provider"
   * value ends up read by something that matters.
   *
   * The cost is that a reload during setup forgets it and the step opens in its
   * default, confirmation-expecting form. That is the safe direction: the code
   * reader is offered to someone who does not need it, rather than withheld from
   * someone who does, and either way the gate is the same transaction in the log.
   */
  const [expectConfirmation, setExpectConfirmation] = useState(true);

  const declareForwarding = useCallback((expect: boolean) => {
    setExpectConfirmation(expect);
    dispatch({ type: "forwarding_declared" });
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
    case "bank":
      return <Bank client={handle.client} onPicked={(bank) => dispatch({ type: "bank_picked", bank })} {...io} />;

    case "address":
      return (
        <Address
          client={handle.client}
          phase="address"
          known={facts.inboundAddress}
          onIssued={(address) => dispatch({ type: "address_issued", address })}
          onForwardingDeclared={declareForwarding}
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
          {...io}
        />
      );

    case "verification":
      return (
        <Verification
          client={handle.client}
          firstMailAt={() => firstMailAt(handle.client.state())}
          onConfirmed={(at) => dispatch({ type: "first_mail_confirmed", at })}
          expectConfirmation={expectConfirmation}
          {...(sync === undefined ? {} : { sync })}
          {...(pollMs === undefined ? {} : { pollMs })}
          {...io}
        />
      );

    case "home_currency":
      return (
        <HomeCurrency
          commit={commit}
          onSet={(currency) => dispatch({ type: "home_currency_set", currency })}
          existing={facts.homeCurrency}
        />
      );

    case "finish":
      return (
        <Finish
          facts={facts}
          commit={commit}
          onFinish={() => dispatch({ type: "finished", at: new Date().toISOString() })}
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
 * The last screen, and the reason `finishedAt` is a fact at all.
 *
 * The currency op is emitted the instant the picker is confirmed, so without
 * this the screen explaining what happens next would be skipped in the same
 * frame it appeared. It is device-local because it is about what this person has
 * been shown, not about the account.
 */
function Finish({
  facts,
  commit,
  onFinish,
}: {
  facts: OnboardingFacts;
  commit: (ops: readonly OpSpec[]) => void;
  onFinish: () => void;
}) {
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
      <BudgetSplitStep commit={commit} />
    </Step>
  );
}
