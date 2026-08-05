/**
 * The unparsed lane: a message that arrived and that no tier could read.
 *
 * # What this card is asking of a person
 *
 * Everything a transaction card usually shows is missing. There is no amount,
 * no currency and no direction — `Txn.unparsed` means exactly that, and the
 * type says so: `direction` is `""` and `countsTowardMoney` is false. So the
 * user is not *checking* a reading, they are *reconstructing* one, and that is
 * the hardest thing this app asks anyone to do.
 *
 * Two consequences shape the layout:
 *
 *  1. **The message is on the card, not behind a link.** Reconstructing a
 *     transaction from a message you cannot see is not a task, it is a memory
 *     test. The raw body is the whole input the user has.
 *  2. **The empty fields are shown as empty, never as zero.** A `0.00` in an
 *     amount field would be indistinguishable from a real zero-amount reading,
 *     and `Number("") === 0` is precisely how v1 produced one. The draft is a
 *     string until it is committed and an empty draft is an error, not a zero.
 *
 * # The message may not be here
 *
 * Nothing in this build can turn an `ingest_id` into raw text — cold bodies
 * sync lazily and no lookup by ingest id exists yet (see `deps.ts`). When the
 * source is absent the card says so plainly and still lets the user type what
 * they remember, because the alternative is a dead card.
 */

import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";

import { INPUT_FONT_MIN, TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { normalizeCurrencyDraft, parseAmountDraft, type ReviewItem } from "../../lib/review.ts";
import type { RawMessage, RawMessageSource } from "./deps.ts";
import { formatDay } from "./format.ts";
import { Button, CategoryGrid, ReasonBanner } from "./parts.tsx";
import type { ManualEntryFields } from "./useReviewQueue.ts";

export interface UnparsedCardProps {
  item: ReviewItem;
  categories: readonly string[];
  raw: RawMessageSource | null;
  /** The user's home currency, used as the default. `null` if not set yet. */
  homeCurrency: string | null;
  onSave: (fields: ManualEntryFields) => void;
  onDismiss: () => void;
  /**
   * Send the layout only — one ingest identifier the server already holds, no
   * body. Absent when this build has no sample lane.
   */
  onReport?: () => void;
  /** Open the donation sheet for this message. Absent for the same reason. */
  onDonate?: () => void;
  /** The result of the last content-free report, shown next to its button. */
  sampleNote?: string | null;
}

type RawState = { kind: "loading" } | { kind: "absent"; why: string } | { kind: "have"; message: RawMessage };

export function UnparsedCard({ item, categories, raw, homeCurrency, onSave, onDismiss, onReport, onDonate, sampleNote }: UnparsedCardProps) {
  const t = useTheme();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(homeCurrency ?? "");
  const [direction, setDirection] = useState<"debit" | "credit">("debit");
  const [merchant, setMerchant] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [message, setMessage] = useState<RawState>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    if (raw === null) {
      setMessage({ kind: "absent", why: "This device hasn't downloaded the message bodies yet." });
      return;
    }
    setMessage({ kind: "loading" });
    void raw
      .read(item.txn.ingest_id)
      .then((m) => {
        if (!live) return;
        setMessage(m === null ? { kind: "absent", why: "This message isn't in the window this device keeps." } : { kind: "have", message: m });
      })
      .catch((err: unknown) => {
        if (live) setMessage({ kind: "absent", why: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, [raw, item.txn.ingest_id]);

  const parsed = parseAmountDraft(amount);
  const ccy = normalizeCurrencyDraft(currency);
  const canSave = parsed.ok && ccy !== null;

  return (
    <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }} keyboardShouldPersistTaps="handled">
      <ReasonBanner reason={item.reason} />

      <View style={{ gap: t.space.xs }}>
        <Text style={[t.type.label, { color: t.colors.textMuted }]}>Arrived</Text>
        <Text style={[t.type.body, { color: t.colors.text }]}>{formatDay(item.txn.posted_at)}</Text>
      </View>

      {/*
        The message itself. Monospaced and scrollable inside its own box: a
        bank's plain-text mail is column-aligned and reflowing it loses the
        alignment that makes an amount findable.
      */}
      <View style={{ gap: t.space.sm }}>
        <Text style={[t.type.heading, { color: t.colors.text }]}>The message</Text>
        {message.kind === "loading" ? (
          <Text style={[t.type.body, { color: t.colors.textMuted }]}>Looking for it…</Text>
        ) : message.kind === "absent" ? (
          <View style={{ padding: t.space.md, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.hairline, gap: t.space.xs }}>
            <Text style={[t.type.body, { color: t.colors.textMuted }]}>{message.why}</Text>
            <Text style={[t.type.label, { color: t.colors.textMuted }]}>
              Nothing is lost — the message is on the server in full, and a later fix to the reader can still turn it into a transaction on its own.
            </Text>
          </View>
        ) : (
          <ScrollView
            style={{ maxHeight: 220, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.hairline }}
            contentContainerStyle={{ padding: t.space.md }}
            horizontal={false}
            nestedScrollEnabled
          >
            <Text selectable style={[t.type.mono, { color: t.colors.text }]}>
              {message.message.text}
            </Text>
          </ScrollView>
        )}
      </View>

      <View style={{ height: 1, backgroundColor: t.colors.hairline }} />

      <Text style={[t.type.heading, { color: t.colors.text }]}>Type it in</Text>

      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <View style={{ flex: 2, gap: t.space.xs }}>
          <Text style={[t.type.label, { color: t.colors.textMuted }]}>Amount</Text>
          <TextInput
            accessibilityLabel="Amount"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder=""
            placeholderTextColor={t.colors.textMuted}
            style={inputStyle(t)}
          />
        </View>
        <View style={{ flex: 1, gap: t.space.xs }}>
          <Text style={[t.type.label, { color: t.colors.textMuted }]}>Currency</Text>
          <TextInput
            accessibilityLabel="Currency"
            value={currency}
            onChangeText={setCurrency}
            autoCapitalize="characters"
            maxLength={3}
            style={inputStyle(t)}
          />
        </View>
      </View>
      {amount === "" ? null : parsed.ok ? null : (
        <Text accessibilityRole="alert" style={[t.type.label, { color: t.colors.danger }]}>
          {parsed.error}
        </Text>
      )}

      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        {(["debit", "credit"] as const).map((d) => (
          <View key={d} style={{ flex: 1 }}>
            <Button
              label={d === "debit" ? "Money out" : "Money in"}
              tone={direction === d ? "primary" : "secondary"}
              onPress={() => setDirection(d)}
            />
          </View>
        ))}
      </View>

      <View style={{ gap: t.space.xs }}>
        <Text style={[t.type.label, { color: t.colors.textMuted }]}>Merchant</Text>
        <TextInput accessibilityLabel="Merchant" value={merchant} onChangeText={setMerchant} style={inputStyle(t)} />
      </View>

      <View style={{ gap: t.space.sm }}>
        <Text style={[t.type.heading, { color: t.colors.text }]}>Category</Text>
        <CategoryGrid categories={categories} selected={category} onSelect={setCategory} />
      </View>

      <View style={{ gap: t.space.sm }}>
        <Button
          label="Save this transaction"
          tone="primary"
          disabled={!canSave}
          onPress={() => {
            if (!parsed.ok || ccy === null) return;
            onSave({
              amountMinor: parsed.minor,
              currency: ccy,
              direction,
              postedAt: item.txn.posted_at,
              merchantRaw: merchant.trim(),
              last4: item.txn.last4,
              category,
            });
          }}
          {...(canSave ? {} : { note: "An amount and a three-letter currency are needed." })}
        />
        <Button label="Not a transaction" onPress={onDismiss} note="Keeps the message, takes it off this list." />
      </View>

      {/*
        The sample lane. Two separate offers, never one: the default sends the
        LAYOUT and nothing else, and the donation sends the whole email behind
        its own preview and consent. Collapsing them into one button would make
        the content-free default indistinguishable from the disclosure.
      */}
      {onReport === undefined && onDonate === undefined ? null : (
        <View testID="unparsed-samples" style={{ gap: t.space.sm }}>
          <View style={{ height: 1, backgroundColor: t.colors.hairline }} />
          <Text style={[t.type.heading, { color: t.colors.text }]}>Help ledger read this bank</Text>
          {onReport === undefined ? null : (
            <Button
              label="Tell the operator this layout failed"
              onPress={onReport}
              note="Sends the message's identifier only — no amounts, no merchant, no text."
            />
          )}
          {sampleNote == null ? null : (
            <Text accessibilityRole="alert" style={[t.type.label, { color: t.colors.textMuted }]}>{sampleNote}</Text>
          )}
          {onDonate === undefined ? null : (
            <Button
              label="Donate this email…"
              onPress={onDonate}
              note="Shows you the exact message first. Sends the complete email, and only if you agree."
            />
          )}
        </View>
      )}
    </ScrollView>
  );
}

function inputStyle(t: ReturnType<typeof useTheme>) {
  return {
    minHeight: TOUCH_TARGET_MIN,
    // 16 pt floor: `INPUT_FONT_MIN`, and never a literal.
    fontSize: INPUT_FONT_MIN,
    color: t.colors.text,
    borderWidth: 1,
    borderColor: t.colors.hairline,
    borderRadius: t.radius.md,
    paddingHorizontal: t.space.md,
  };
}
