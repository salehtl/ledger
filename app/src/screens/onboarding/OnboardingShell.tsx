/**
 * The onboarding shell: the container that decides which step is on the glass.
 *
 * # It is one screen, not a navigation stack, and that is the design
 *
 * The step is **derived from facts** (`lib/onboarding.ts`), so a cold launch
 * lands where the last one left off with nothing to restore. A pushed stack
 * would need its own persistence, and a persisted stack can disagree with the
 * facts — the dangerous direction being a device that believes it has not set a
 * home currency when the log says it has. One screen reading one derivation
 * makes that disagreement unrepresentable.
 *
 * # Two states a new user reaches on the happy path, which must not read as faults
 *
 * **Gmail's confirmation email is held forever** (plan Decision 7). The
 * forwarder-domain rule refuses to promote `google.com`, so the first thing a
 * new alpha sees is a quarantined message. {@link QUARANTINE_HELD} is the
 * wording, and it says "held on purpose" before it says anything else.
 *
 * **A second device hard-stops until a checkpoint names it.** Enrolment and
 * first checkpoint are strictly ordered (`escapableDuringPush` in
 * `client/src/invariants/surface.ts` records why). {@link onboardingGate} turns
 * that one halt into a *wait* with its own copy; every other hard stop is
 * handed on with the library's own words, unaltered.
 *
 * # The steps this build does not have yet
 *
 * Tasks 15, 16 and 17 own the bank picker, the address and forwarding screens
 * and the quarantine lane. They are **not written here**: a screen written
 * blind against an API nobody has run is the "written, tested green, never
 * wired" defect this project has paid for six times. Instead each is a named
 * slot — `screens.bank`, `screens.address`, … — and an unfilled slot renders a
 * placeholder saying which task owns it.
 *
 * A placeholder may advance the machine **only over a device-local fact**. The
 * address and the first confirmed email are server and log truth, and a
 * placeholder that faked one would put the machine past a step that never
 * happened.
 */

import { useEffect, useMemo, useReducer, type ReactElement } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Halt } from "@ledger/client/invariants/surface.ts";

import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { HaltBanner } from "../../components/HaltBanner.tsx";
import {
  onboardingGate,
  onboardingReducer,
  QUARANTINE_HELD,
  screenFor,
  stepFor,
  type OnboardingEvent,
  type OnboardingFacts,
  type OnboardingScreen,
  type OpSpec,
} from "../../lib/onboarding.ts";
import { HomeCurrencyScreen } from "./HomeCurrencyScreen.tsx";

/** A step screen a later task fills in. It reports completion as an event. */
export type StepRenderer = (props: { advance: (e: OnboardingEvent) => void }) => ReactElement;

export interface OnboardingShellProps {
  /** Rebuilt on every cold launch by `resumeFacts`. */
  initialFacts: OnboardingFacts;
  /** Persist the device-local half. `encodeLocal` is what to store. */
  onFactsChange?: (f: OnboardingFacts) => void;
  /** The one hard stop `surface()` chose to show, or null. */
  halt?: Halt | null;
  /** Authors ops. Null until something constructs a `Client` (Task 13's handoff). */
  commitOps: ((ops: readonly OpSpec[]) => Promise<void>) | null;
  /** Screens later tasks provide. An unfilled slot renders a placeholder. */
  screens?: Partial<Record<OnboardingScreen, StepRenderer>>;
  /** Onboarding is complete. */
  onDone: () => void;
  /** There is no session — Task 13's screen owns this. */
  onSignedOut?: () => void;
}

export function OnboardingShell({
  initialFacts,
  onFactsChange,
  halt = null,
  commitOps,
  screens,
  onDone,
  onSignedOut,
}: OnboardingShellProps) {
  const [facts, advance] = useReducer(onboardingReducer, initialFacts);
  const position = stepFor(facts);
  const screen = screenFor(position);
  const gate = useMemo(() => onboardingGate(halt), [halt]);

  useEffect(() => {
    onFactsChange?.(facts);
  }, [facts, onFactsChange]);

  useEffect(() => {
    if (position === "done") onDone();
  }, [position, onDone]);

  useEffect(() => {
    if (position === "signed_out") onSignedOut?.();
  }, [position, onSignedOut]);

  if (gate.kind === "awaiting_vouch") {
    return <StopView testID="onboarding-awaiting-vouch" tone="warning" {...gate.copy} />;
  }
  if (gate.kind === "halted") {
    // Task 12's component, with the library's own words and its violation
    // detail — not a second copy of them here. Onboarding is the first thing in
    // the app that renders it: `Root.tsx` will hold the app-wide gate once
    // something computes `surface()`, which needs a synced `Client`.
    return <HaltBanner halt={gate.halt} />;
  }

  const provided = screens?.[screen];
  if (provided !== undefined) return provided({ advance });

  switch (screen) {
    case "sign_in":
    case "product":
      // Somebody else's screen entirely. The effects above have already told
      // the navigator; rendering anything here would flash behind the replace.
      return null;

    case "confirming":
      // Nothing on this device can confirm an account without a client, so it
      // says so rather than spinning forever. The shape the sign-in screen set.
      return <ConfirmingView blocked={commitOps === null} />;

    case "home_currency":
      return (
        <HomeCurrencyScreen
          commit={commitOps}
          existing={facts.homeCurrency}
          onSet={(currency) => advance({ type: "home_currency_set", currency })}
        />
      );

    case "finish":
      return <FinishView onDone={() => advance({ type: "finished", at: new Date().toISOString() })} />;

    case "bank":
    case "address":
    case "forwarding":
    case "verification":
      return <PendingStep screen={screen} advance={advance} />;
  }
}

// ---------------------------------------------------------------------------
// The steps later tasks own
// ---------------------------------------------------------------------------

interface PendingSpec {
  title: string;
  owner: string;
  body: string;
  /**
   * The event a "carry on for now" affordance emits, or null when the fact is
   * server or log truth and nothing on this device may fake it.
   */
  advance: OnboardingEvent | null;
}

const PENDING: Record<"bank" | "address" | "forwarding" | "verification", PendingSpec> = {
  bank: {
    title: "Which bank do you use?",
    owner: "Task 16 builds the bank picker, the waitlist and the sample donation.",
    body: "ledger reads three banks today. If yours is not one of them you can join the waitlist and, if you want to, donate one email so it can be added.",
    advance: { type: "bank_picked", bank: "unspecified" },
  },
  address: {
    title: "Your inbound address",
    owner: "Task 15 builds the address screen, the QR code and rotation.",
    body: "ledger gives you an address of your own to forward bank mail to. It is minted by the server on first read, so nothing on this device can stand in for it.",
    advance: null,
  },
  forwarding: {
    title: "Forward your bank mail",
    owner: "Task 15 builds the forwarding instructions from Task 2's measured record.",
    body: "You set a rule in your mail provider so bank alerts are copied to your ledger address. Nothing here can watch that rule — the proof is mail arriving.",
    advance: { type: "forwarding_declared" },
  },
  verification: {
    title: QUARANTINE_HELD.title,
    owner: "Task 15 reads the code out of the held message; Task 17 builds the quarantine lane.",
    body: QUARANTINE_HELD.body,
    advance: null,
  },
};

function PendingStep({
  screen,
  advance,
}: {
  screen: "bank" | "address" | "forwarding" | "verification";
  advance: (e: OnboardingEvent) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const spec = PENDING[screen];
  return (
    <ScrollView
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: insets.top + t.space.xl,
        paddingBottom: insets.bottom + t.space.xl,
        gap: t.space.lg,
        flexGrow: 1,
      }}
    >
      <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}>
        {spec.title}
      </Text>
      <Text testID={`step-${screen}-body`} style={[t.type.body, { color: t.colors.text }]}>
        {spec.body}
      </Text>

      {/*
        The same shape the sign-in screen set for a dependency this build does
        not have: rendered, named, with the reason on it. Not omitted, and not
        live over nothing.
      */}
      <View
        testID={`step-${screen}-pending`}
        style={{
          gap: t.space.xs,
          padding: t.space.md,
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderColor: t.colors.hairline,
          backgroundColor: t.colors.surface,
        }}
      >
        <Text style={[t.type.heading, { color: t.colors.warning }]}>This step is not built yet</Text>
        <Text style={[t.type.label, { color: t.colors.textMuted }]}>{spec.owner}</Text>
      </View>

      {spec.advance !== null ? (
        <Pressable
          testID={`step-${screen}-skip`}
          accessibilityRole="button"
          accessibilityLabel="Carry on for now"
          onPress={() => advance(spec.advance as OnboardingEvent)}
          hitSlop={t.space.md}
          style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
        >
          <Text style={[t.type.body, { color: t.colors.accent }]}>Carry on for now</Text>
        </Pressable>
      ) : (
        <Text testID={`step-${screen}-blocked`} style={[t.type.label, { color: t.colors.textMuted }]}>
          There is nothing to press: this step is a fact the server or your own mail has to produce, and nothing
          on this device may stand in for one.
        </Text>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// The shell's own small screens
// ---------------------------------------------------------------------------

function ConfirmingView({ blocked }: { blocked: boolean }) {
  const t = useTheme();
  return (
    <View
      testID="onboarding-confirming"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: t.space.md,
        padding: t.space.lg,
        backgroundColor: t.colors.bg,
      }}
    >
      {!blocked && <ActivityIndicator color={t.colors.accent} />}
      <Text style={[t.type.body, { color: t.colors.textMuted, textAlign: "center" }]}>
        {blocked
          ? "This build has no ledger server configured, so your account cannot be checked. Nothing is wrong with this device."
          : "Checking your account…"}
      </Text>
    </View>
  );
}

function FinishView({ onDone }: { onDone: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: insets.top + t.space.xl,
        paddingBottom: insets.bottom + t.space.xl,
        gap: t.space.lg,
        flexGrow: 1,
      }}
    >
      <Text accessibilityRole="header" style={[t.type.display, { color: t.colors.text }]}>
        You're set up
      </Text>
      <Text style={[t.type.body, { color: t.colors.text }]}>
        From here ledger works on its own: each bank email your provider forwards becomes a transaction, and
        anything it cannot read with confidence waits for you in the review queue rather than being guessed at.
      </Text>
      <Text testID="finish-quarantine-note" style={[t.type.body, { color: t.colors.textMuted }]}>
        {QUARANTINE_HELD.body}
      </Text>
      <View style={{ flex: 1 }} />
      <Pressable
        testID="onboarding-finish"
        accessibilityRole="button"
        accessibilityLabel="Open ledger"
        onPress={onDone}
        style={({ pressed }) => ({
          minHeight: TOUCH_TARGET_MIN,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: t.radius.md,
          backgroundColor: t.colors.text,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={[t.type.heading, { color: t.colors.bg }]}>Open ledger</Text>
      </Pressable>
    </ScrollView>
  );
}

function StopView({
  testID,
  tone,
  title,
  body,
  action,
}: {
  testID: string;
  tone: "warning" | "danger";
  title: string;
  body: string;
  action: string | null;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const color = tone === "danger" ? t.colors.danger : t.colors.warning;
  return (
    <ScrollView
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: insets.top + t.space.xxl,
        paddingBottom: insets.bottom + t.space.xl,
        gap: t.space.md,
        flexGrow: 1,
        justifyContent: "center",
      }}
    >
      <Text testID={testID} accessibilityRole="header" style={[t.type.title, { color }]}>
        {title}
      </Text>
      <Text style={[t.type.body, { color: t.colors.text }]}>{body}</Text>
      {action !== null && <Text style={[t.type.body, { color: t.colors.textMuted }]}>{action}</Text>}
    </ScrollView>
  );
}
