/**
 * One transaction, and the form that edits it.
 *
 * # Every numeric field is a string draft
 *
 * The amount is held as the text the user typed and converted exactly once, on
 * save, by `parseAmountDraft`. `Number("") === 0` is the springback v1's harness
 * found by clearing every field on every screen — bind a number and the field
 * refuses to stay empty — and here it would be worse than an annoyance: an
 * amount field that springs back to `0` on an *unparsed* row is a field that
 * offers to write a zero-dirham transaction over a message the parser could not
 * read.
 *
 * # "Correct the amount" is a different op, and the screen says so
 *
 * `txn_edited` cannot carry an amount, a currency or a direction — they are
 * `PARSE_OWNED` in `replay.ts` and an edit naming one is recorded as rejected.
 * The correction is a `txn_superseded`: a *new row* for the same email, which
 * retires this one. That is a bigger thing than fixing a merchant's spelling, so
 * it is behind a disclosure and it is labelled with what it does.
 *
 * For an `unparsed` row the disclosure is open from the start, because there is
 * nothing else this screen can usefully do for it: the whole row is the money
 * that could not be read.
 *
 * # A concurrent edit is shown, never silent
 *
 * §3.3 requires a resolved fork to be surfaced. The notices for this entity are
 * read from the projection and printed with what won and what lost. Task 19 owns
 * the queue lane; this is the same fact, where the user is looking.
 */

import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { INPUT_FONT_MIN, TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import {
  dayKey,
  longDate,
  parseErrorCopy,
  PROVENANCE_EXPLAINER,
  provenanceLabel,
  tierLabel,
  timeOfDay,
} from "../../lib/format.ts";
import { draftFromMinor, formatMoney, sanitizeAmountDraft } from "../../lib/money.ts";
import { txnAmountLabel, txnMarkers, type Direction } from "../../lib/transactions.ts";
import type { SplitDraftLine, TxnEditDraft } from "../../lib/txnEdit.ts";
import type { TxnSource } from "./source.ts";

export interface TransactionDetailScreenProps {
  source: TxnSource;
  id: string;
  /**
   * Called when a correction produced a NEW row: a supersede allocates a new
   * entity id, so the screen that was showing the old one has to follow it or it
   * is looking at a retired row.
   */
  onReplaced: (newId: string) => void;
  onClose: () => void;
}

export function TransactionDetailScreen({ source, id, onReplaced, onClose }: TransactionDetailScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [saved, setSaved] = useState(false);
  const txn = useMemo(() => source.read(id), [source, id]);
  const forks = useMemo(() => source.forks(id), [source, id]);

  const [merchant, setMerchant] = useState(txn?.merchant_raw ?? "");
  const [day, setDay] = useState(txn === null ? "" : dayKey(txn.posted_at));
  const [category, setCategory] = useState(txn?.category ?? "");
  const [amount, setAmount] = useState(txn === null || txn.unparsed ? "" : draftFromMinor(txn.amount_minor));
  const [currency, setCurrency] = useState(txn === null || txn.currency === "" ? (source.homeCurrency() ?? "") : txn.currency);
  const [direction, setDirection] = useState<Direction | "">(txn?.direction ?? "");
  // Open from the start for a row that carries no money at all.
  const [correcting, setCorrecting] = useState(txn?.unparsed === true);
  const [errors, setErrors] = useState<string[]>([]);
  const [splitting, setSplitting] = useState(false);
  const [splitLines, setSplitLines] = useState<SplitDraftLine[]>(() => txn?.splits.length
    ? txn.splits.map((part) => ({ category: part.category, amount: draftFromMinor(part.amount_minor) }))
    : [{ category: "", amount: "" }, { category: "", amount: "" }]);

  const save = useCallback(() => {
    if (txn === null) return;
    const draft: TxnEditDraft = {
      merchant,
      day,
      category: category.trim() === "" ? null : category.trim(),
      ...(correcting ? { amount, currency, ...(direction === "" ? {} : { direction }) } : {}),
    };
    const res = source.edit(txn.id, draft);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors([]);
    setSaved(true);
    if (res.changed && res.newId !== null) onReplaced(res.newId);
  }, [txn, source, merchant, day, category, correcting, amount, currency, direction, onReplaced]);

  const recomputeHome = useCallback(() => {
    if (txn === null) return;
    const result = source.recomputeHome(txn.id);
    if (!result.ok) { setErrors([result.error]); return; }
    setErrors([]);
    setSaved(true);
  }, [source, txn]);

  const saveSplit = useCallback(() => {
    if (txn === null) return;
    const result = source.split(txn.id, splitLines);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors([]);
    setSaved(true);
    setSplitting(false);
  }, [source, splitLines, txn]);

  if (txn === null) {
    return (
      <View style={{ flex: 1, backgroundColor: t.colors.bg, padding: t.space.lg, paddingTop: insets.top + t.space.xl, gap: t.space.md }}>
        <Text testID="txn-missing" style={[t.type.body, { color: t.colors.text }]}>
          That transaction is no longer on this device.
        </Text>
        <TextButton testID="txn-close" label="Back" onPress={onClose} />
      </View>
    );
  }

  const amountLabel = txnAmountLabel(txn);

  return (
    <ScrollView
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: insets.top + t.space.lg,
        paddingBottom: insets.bottom + t.space.xxl,
        gap: t.space.lg,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <TextButton testID="txn-close" label="Back" onPress={onClose} />

      <View style={{ gap: t.space.xs }}>
        <Text
          testID="detail-amount"
          accessibilityRole="header"
          style={[
            t.type.display,
            { color: amountLabel.unreadable ? t.colors.textMuted : amountLabel.flow === "in" ? t.colors.credit : t.colors.text },
          ]}
        >
          {amountLabel.text}
        </Text>
        <Text style={[t.type.title, { color: t.colors.text }]}>
          {txn.merchant_raw === "" ? "Message we couldn't read" : txn.merchant_raw}
        </Text>
        <Text style={[t.type.body, { color: t.colors.textMuted }]}>
          {longDate(txn.posted_at)} · {timeOfDay(txn.posted_at)} UTC
        </Text>
        {txn.currency !== "" && txn.currency !== source.homeCurrency() && (
          <View style={{ gap: t.space.xs }}>
            <Text style={[t.type.body, { color: t.colors.textMuted }]}>
              {formatMoney(txn.amount_minor, txn.currency)}
              {txn.amount_home_minor === null ? " · no rate set yet" : ""}
            </Text>
            <TextButton testID="recompute-home" label="Recompute at current rate" onPress={recomputeHome} />
          </View>
        )}
      </View>

      {txn.unparsed && (
        <Panel testID="detail-unparsed" tone="warning" title="We couldn't read this one">
          <Text style={[t.type.body, { color: t.colors.text }]}>
            The email arrived and is kept in full, but no template or pattern could find an amount in it
            {parseErrorCopy(txn.parse_error) === "" ? "" : ` (${parseErrorCopy(txn.parse_error).toLowerCase()})`}. Enter
            it below and this row becomes a real transaction — the original message stays attached to it.
          </Text>
        </Panel>
      )}

      {forks.length > 0 && (
        <Panel testID="detail-forks" tone="warning" title="Changed on another device">
          {forks.map((f) => (
            <Text key={f.winner_op + f.loser_op} style={[t.type.label, { color: t.colors.text }]}>
              Two edits were made at once. The one from {f.winner_op.slice(0, 8)} was kept; the one from{" "}
              {f.loser_op.slice(0, 8)} was not.
            </Text>
          ))}
        </Panel>
      )}

      {txn.possible_duplicate_of !== null && (
        <Panel testID="detail-duplicate" tone="warning" title="Possible duplicate">
          <Text style={[t.type.body, { color: t.colors.text }]}>
            This looks like {txn.possible_duplicate_of}. Both are kept — same-day repeat purchases are real, so this is
            a notice and never a deletion.
          </Text>
        </Panel>
      )}

      <View style={{ gap: t.space.md }}>
        <Field testID="edit-merchant" label="Merchant" value={merchant} onChangeText={setMerchant} />
        <Field testID="edit-day" label="Date (YYYY-MM-DD)" value={day} onChangeText={setDay} keyboard="numbers-and-punctuation" />
        <Field testID="edit-category" label="Category" value={category} onChangeText={setCategory} />
      </View>

      {!txn.unparsed && !splitting && (
        <TextButton testID="start-split" label={txn.splits.length ? "Edit split" : "Split transaction"} onPress={() => setSplitting(true)} />
      )}
      {splitting && (
        <View testID="split-editor" style={{ gap: t.space.md }}>
          <Text style={[t.type.heading, { color: t.colors.text }]}>Split the total</Text>
          <Text style={[t.type.label, { color: t.colors.textMuted }]}>Every part needs a category and the parts must add up to {formatMoney(txn.amount_minor, txn.currency)}.</Text>
          {splitLines.map((line, index) => (
            <View key={index} style={{ gap: t.space.sm }}>
              <Field testID={`split-category-${index}`} label={`Part ${index + 1} category`} value={line.category} onChangeText={(category) => setSplitLines((lines) => lines.map((v, i) => i === index ? { ...v, category } : v))} />
              <Field testID={`split-amount-${index}`} label={`Part ${index + 1} amount`} value={line.amount} onChangeText={(amount) => setSplitLines((lines) => lines.map((v, i) => i === index ? { ...v, amount: sanitizeAmountDraft(amount) } : v))} keyboard="decimal-pad" />
              {splitLines.length > 1 && <TextButton testID={`remove-split-${index}`} label={`Remove part ${index + 1}`} onPress={() => setSplitLines((lines) => lines.filter((_, i) => i !== index))} />}
            </View>
          ))}
          <TextButton testID="add-split" label="Add another part" onPress={() => setSplitLines((lines) => [...lines, { category: "", amount: "" }])} />
          <Pressable testID="save-split" accessibilityRole="button" onPress={saveSplit} style={{ minHeight: TOUCH_TARGET_MIN, alignItems: "center", justifyContent: "center", borderRadius: t.radius.md, backgroundColor: t.colors.accent }}><Text style={[t.type.heading, { color: t.colors.bg }]}>Save split</Text></Pressable>
        </View>
      )}

      {!correcting && (
        <TextButton
          testID="start-correcting"
          label="Correct the amount, currency or direction"
          onPress={() => setCorrecting(true)}
        />
      )}

      {correcting && (
        <View style={{ gap: t.space.md }}>
          <Text style={[t.type.label, { color: t.colors.textMuted }]}>
            Correcting these writes a new row for the same email and retires this one, so the conversion is worked out
            again from scratch. The old row is kept and stays readable.
          </Text>
          <Field
            testID="edit-amount"
            label="Amount"
            value={amount}
            onChangeText={(text) => setAmount(sanitizeAmountDraft(text))}
            keyboard="decimal-pad"
          />
          <Field testID="edit-currency" label="Currency" value={currency} onChangeText={setCurrency} autoCapitalize="characters" />
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            <Toggle testID="edit-direction-debit" label="Money out" on={direction === "debit"} onPress={() => setDirection("debit")} />
            <Toggle testID="edit-direction-credit" label="Money in" on={direction === "credit"} onPress={() => setDirection("credit")} />
          </View>
        </View>
      )}

      {errors.length > 0 && (
        <View testID="edit-errors" accessibilityRole="alert" style={{ gap: t.space.xs }}>
          {errors.map((e) => (
            <Text key={e} style={[t.type.body, { color: t.colors.danger }]}>
              {e}
            </Text>
          ))}
        </View>
      )}

      <Pressable
        testID="edit-save"
        accessibilityRole="button"
        onPress={save}
        style={({ pressed }) => ({
          minHeight: TOUCH_TARGET_MIN,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: t.radius.md,
          backgroundColor: t.colors.accent,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={[t.type.heading, { color: t.colors.bg }]}>Save</Text>
      </Pressable>

      {saved && (
        <Text testID="edit-saved" style={[t.type.label, { color: t.colors.textMuted }]}>
          Saved on this device. It appears here once this device syncs — the change is a record in your log, not an
          edit in place, so it is folded back in with everything else.
        </Text>
      )}

      <View style={{ gap: t.space.xs }}>
        <Text testID="detail-provenance" style={[t.type.label, { color: t.colors.textMuted }]}>
          {provenanceLabel(txn.provenance)} · {tierLabel(txn.tier, txn.unparsed)}
        </Text>
        <Text style={[t.type.label, { color: t.colors.textMuted }]}>{PROVENANCE_EXPLAINER}</Text>
        <Text style={[t.type.mono, { color: t.colors.textMuted }]}>
          {txn.id} · v{txn.version} · {txnMarkers(txn).map((m) => m.label).join(" · ")}
        </Text>
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------

function Field({
  testID,
  label,
  value,
  onChangeText,
  keyboard,
  autoCapitalize,
}: {
  testID: string;
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  keyboard?: "decimal-pad" | "numbers-and-punctuation";
  autoCapitalize?: "characters";
}) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }}>
      <Text style={[t.type.label, { color: t.colors.textMuted }]}>{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        autoCorrect={false}
        {...(keyboard === undefined ? {} : { keyboardType: keyboard })}
        {...(autoCapitalize === undefined ? {} : { autoCapitalize })}
        style={{
          minHeight: TOUCH_TARGET_MIN,
          // 16 pt is the floor for anything typed into (Theme.tsx's INPUT_FONT_MIN).
          fontSize: INPUT_FONT_MIN,
          color: t.colors.text,
          backgroundColor: t.colors.surface,
          borderRadius: t.radius.md,
          paddingHorizontal: t.space.md,
        }}
      />
    </View>
  );
}

function Toggle({ testID, label, on, onPress }: { testID: string; label: string; on: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={{
        flex: 1,
        minHeight: TOUCH_TARGET_MIN,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: t.radius.md,
        borderWidth: 1,
        borderColor: on ? t.colors.accent : t.colors.hairline,
        backgroundColor: on ? t.colors.accent : t.colors.surface,
      }}
    >
      <Text style={[t.type.body, { color: on ? t.colors.bg : t.colors.text }]}>{label}</Text>
    </Pressable>
  );
}

function TextButton({ testID, label, onPress }: { testID: string; label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={t.space.md}
      style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
    >
      <Text style={[t.type.body, { color: t.colors.accent }]}>{label}</Text>
    </Pressable>
  );
}

function Panel({
  testID,
  tone,
  title,
  children,
}: {
  testID: string;
  tone: "warning" | "danger";
  title: string;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const colour = tone === "danger" ? t.colors.danger : t.colors.warning;
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={{
        gap: t.space.xs,
        padding: t.space.md,
        borderRadius: t.radius.md,
        borderWidth: 1,
        borderColor: colour,
        backgroundColor: t.colors.surface,
      }}
    >
      <Text style={[t.type.heading, { color: colour }]}>{title}</Text>
      {children}
    </View>
  );
}
