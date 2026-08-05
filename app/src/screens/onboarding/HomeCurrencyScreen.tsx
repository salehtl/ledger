/**
 * The home-currency picker — the one irreversible control in the product.
 *
 * Spec §3.7 makes the home currency **log state, set once, with no in-product
 * way to change it**. Changing it later would re-denominate every already-frozen
 * FX snapshot, so the only remedy is deleting the account. This screen is
 * therefore a one-shot, irreversible choice made by somebody who has been using
 * the app for ninety seconds and does not yet know what a snapshot is.
 *
 * # The consequence is legible BEFORE the tap, in three places
 *
 *  1. **At first paint of the list**, before a currency is selected: a card
 *     saying this cannot be changed later. Not a toast, not a footnote — a
 *     confirmation that arrives after the choice is a receipt, not a warning.
 *  2. **On a second step of its own.** Selecting a currency arms; it does not
 *     emit. The confirm step echoes the code back in every line and states the
 *     remedy in §3.7's words: delete the account and start again.
 *  3. **Behind an acknowledgement the user has to make.** The confirm button is
 *     inert until it is made, which turns "the copy was on screen" into "the
 *     user acted on the copy" — the difference between a check that is true by
 *     construction and one that measures something.
 *
 * And a fourth, indirect: for an AED home the peg is shown as arithmetic
 * (`USD 100.00 is recorded as AED 367.25`) with the note that *rates* can be
 * changed any time. A changeable thing beside an unchangeable one is what makes
 * the unchangeable one legible.
 *
 * # What it does not do
 *
 * It does not author ops itself. `commit` is injected, because the app has no
 * `Client` yet (Task 13's handoff: a `Client` needs a server base URL this repo
 * deliberately does not record). While it is null the confirm button renders
 * **disabled with the reason on it**, which is the convention the sign-in
 * screen set.
 */

import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { INPUT_FONT_MIN, TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import {
  confirmCopy,
  homeCurrencyOps,
  pegIllustration,
  searchCurrencies,
  type CurrencyChoice,
  type OpSpec,
} from "../../lib/onboarding.ts";

export interface HomeCurrencyScreenProps {
  /**
   * Authors the ops. Null when this build has no client; the screen says so at
   * first paint rather than failing under a thumb.
   */
  commit: ((ops: readonly OpSpec[]) => Promise<void>) | null;
  /** Called once the ops are authored, with the normalised code. */
  onSet: (currency: string) => void;
  /**
   * The log already carries one. Renders the refusal rather than the picker —
   * a second `home_currency_set` is a permanent anomaly, so the screen must be
   * unable to offer one even if the machine routed here by mistake.
   */
  existing?: string | null;
}

type Phase =
  | { kind: "choose" }
  | { kind: "confirm"; code: string; acknowledged: boolean }
  | { kind: "committing"; code: string }
  | { kind: "failed"; code: string; message: string };

export function HomeCurrencyScreen({ commit, onSet, existing = null }: HomeCurrencyScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  /** A string draft, never coerced on keystroke. See `components/README.md`. */
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });

  const results = useMemo(() => searchCurrencies(query), [query]);

  const confirmChoice = useCallback(
    async (code: string) => {
      // The isRunning guard, in the shape a phase machine gives for free: a
      // second press while a commit is in flight cannot start a second one.
      // Phase 0's >500 MB freeze was partly unguarded repeat presses, and this
      // one would author the op twice.
      if (commit === null) return;
      setPhase({ kind: "committing", code });
      try {
        await commit(homeCurrencyOps(code));
        onSet(code);
      } catch (e) {
        setPhase({ kind: "failed", code, message: e instanceof Error ? e.message : String(e) });
      }
    },
    [commit, onSet],
  );

  const pad = {
    padding: t.space.lg,
    paddingTop: insets.top + t.space.xl,
    paddingBottom: insets.bottom + t.space.xl,
    gap: t.space.lg,
    flexGrow: 1,
  };

  if (existing !== null) {
    return (
      <ScrollView style={{ backgroundColor: t.colors.bg }} contentContainerStyle={pad}>
        <Text accessibilityRole="header" style={[t.type.display, { color: t.colors.text }]}>
          {existing}
        </Text>
        <Text testID="home-currency-already-set" style={[t.type.body, { color: t.colors.text }]}>
          Your home currency is already {existing}, and ledger has no way to change it. Everything you have
          recorded is kept in {existing}.
        </Text>
        <PrimaryButton
          testID="home-currency-continue"
          label="Carry on"
          disabled={false}
          busy={false}
          onPress={() => onSet(existing)}
        />
      </ScrollView>
    );
  }

  if (phase.kind !== "choose") {
    const copy = confirmCopy(phase.code);
    const peg = pegIllustration(phase.code);
    const acknowledged = phase.kind === "confirm" ? phase.acknowledged : true;
    const busy = phase.kind === "committing";
    return (
      <ScrollView style={{ backgroundColor: t.colors.bg }} contentContainerStyle={pad}>
        <View style={{ gap: t.space.sm }}>
          <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}>
            {copy.title}
          </Text>
          <Text style={[t.type.body, { color: t.colors.textMuted }]}>{copy.meaning}</Text>
        </View>

        <View
          testID="home-currency-consequence"
          accessibilityRole="alert"
          style={{
            gap: t.space.xs,
            padding: t.space.md,
            borderRadius: t.radius.md,
            borderWidth: 1,
            borderColor: t.colors.danger,
            backgroundColor: t.colors.surface,
          }}
        >
          <Text style={[t.type.heading, { color: t.colors.danger }]}>This cannot be undone</Text>
          <Text style={[t.type.body, { color: t.colors.text }]}>{copy.consequence}</Text>
        </View>

        {peg !== null && (
          <View testID="home-currency-peg" style={{ gap: t.space.xs }}>
            <Text style={[t.type.label, { color: t.colors.textMuted }]}>ledger will also record the USD peg</Text>
            <Text style={[t.type.mono, { color: t.colors.text }]}>{peg}</Text>
            <Text style={[t.type.label, { color: t.colors.textMuted }]}>
              Exchange rates like that one you can change whenever you like. The home currency is the one thing
              you cannot.
            </Text>
          </View>
        )}

        <Pressable
          testID="home-currency-acknowledge"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: acknowledged }}
          accessibilityLabel={copy.acknowledgement}
          disabled={busy}
          onPress={() =>
            setPhase((p) => (p.kind === "confirm" ? { ...p, acknowledged: !p.acknowledged } : p))
          }
          hitSlop={t.space.sm}
          style={{
            minHeight: TOUCH_TARGET_MIN,
            flexDirection: "row",
            alignItems: "center",
            gap: t.space.md,
          }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: t.radius.sm,
              borderWidth: 2,
              borderColor: acknowledged ? t.colors.accent : t.colors.hairline,
              backgroundColor: acknowledged ? t.colors.accent : "transparent",
            }}
          />
          <Text style={[t.type.body, { color: t.colors.text, flexShrink: 1 }]}>{copy.acknowledgement}</Text>
        </Pressable>

        {phase.kind === "failed" && (
          <Text testID="home-currency-error" accessibilityRole="alert" style={[t.type.body, { color: t.colors.danger }]}>
            That did not save: {phase.message}. Nothing was recorded, so nothing is stuck — try again.
          </Text>
        )}

        {commit === null && (
          <Text testID="home-currency-no-client" style={[t.type.label, { color: t.colors.warning }]}>
            This build has no ledger client wired up yet, so nothing can be recorded. Your choice is not lost —
            nothing has been written either way.
          </Text>
        )}

        <PrimaryButton
          testID="home-currency-confirm"
          label={copy.confirm}
          disabled={!acknowledged || commit === null || busy}
          busy={busy}
          onPress={() => void confirmChoice(phase.code)}
        />
        <SecondaryButton
          testID="home-currency-back"
          label={copy.back}
          disabled={busy}
          onPress={() => setPhase({ kind: "choose" })}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={pad}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: t.space.sm }}>
        <Text accessibilityRole="header" style={[t.type.display, { color: t.colors.text }]}>
          Which currency do you think in?
        </Text>
        <Text style={[t.type.body, { color: t.colors.textMuted }]}>
          Your totals, your budget and every converted purchase are kept in this one.
        </Text>
      </View>

      {/*
        Before any selection, above the list, at first paint. A warning that
        appears after the choice is a receipt.
      */}
      <View
        testID="home-currency-permanence"
        accessibilityRole="alert"
        style={{
          gap: t.space.xs,
          padding: t.space.md,
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderColor: t.colors.warning,
          backgroundColor: t.colors.surface,
        }}
      >
        <Text style={[t.type.heading, { color: t.colors.warning }]}>Pick carefully — this one is permanent</Text>
        <Text style={[t.type.body, { color: t.colors.text }]}>
          ledger converts each foreign purchase once, when it arrives, and keeps that figure. Because of that
          there is no way to change your home currency afterwards; the only way out is to delete your account and
          start again.
        </Text>
      </View>

      <TextInput
        testID="home-currency-search"
        value={query}
        onChangeText={setQuery}
        placeholder="Search, or type a three-letter code"
        placeholderTextColor={t.colors.textMuted}
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Search currencies"
        style={[
          t.type.input,
          {
            minHeight: TOUCH_TARGET_MIN,
            fontSize: INPUT_FONT_MIN,
            paddingHorizontal: t.space.md,
            borderRadius: t.radius.md,
            borderWidth: 1,
            borderColor: t.colors.hairline,
            backgroundColor: t.colors.surface,
            color: t.colors.text,
          },
        ]}
      />

      <View style={{ gap: t.space.xs }}>
        {results.map((c) => (
          <CurrencyRow
            key={c.code}
            choice={c}
            onPress={() => setPhase({ kind: "confirm", code: c.code, acknowledged: false })}
          />
        ))}
        {results.length === 0 && (
          <Text testID="home-currency-empty" style={[t.type.body, { color: t.colors.textMuted }]}>
            No currency matches that. Any three-letter code works — try typing it in full.
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------

function CurrencyRow({ choice, onPress }: { choice: CurrencyChoice; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      testID={`currency-${choice.code}`}
      accessibilityRole="button"
      accessibilityLabel={`${choice.code} — ${choice.name}`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET_MIN,
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.md,
        paddingHorizontal: t.space.md,
        borderRadius: t.radius.md,
        backgroundColor: pressed ? t.colors.hairline : t.colors.surface,
      })}
    >
      <Text style={[t.type.heading, { color: t.colors.text, width: 52 }]}>{choice.code}</Text>
      <Text style={[t.type.body, { color: t.colors.textMuted, flexShrink: 1 }]}>{choice.name}</Text>
    </Pressable>
  );
}

function PrimaryButton({
  testID,
  label,
  disabled,
  busy,
  onPress,
}: {
  testID: string;
  label: string;
  disabled: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET_MIN,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: t.space.sm,
        borderRadius: t.radius.md,
        backgroundColor: t.colors.text,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {busy && <ActivityIndicator color={t.colors.bg} />}
      <Text style={[t.type.heading, { color: t.colors.bg }]}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  testID,
  label,
  disabled,
  onPress,
}: {
  testID: string;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: TOUCH_TARGET_MIN, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={[t.type.body, { color: t.colors.accent }]}>{label}</Text>
    </Pressable>
  );
}
