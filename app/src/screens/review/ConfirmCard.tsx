/**
 * The card for a parsed row that needs confirming — the beta's most-touched
 * surface.
 *
 * The layout answers, in order, the three questions a person asks dozens of
 * times a day: *how much*, *who*, *why am I being asked*. The amount is the
 * largest thing on the card because the amount is what the user is actually
 * checking; the reason banner is below it because it is the same reason on
 * every card for a DIB user, and putting a paragraph they have already read
 * above the number they have not would be a screen that fights its own use.
 */

import { ScrollView, Text, View } from "react-native";

import { useTheme } from "../../app/Theme.tsx";
import { type ReviewItem } from "../../lib/review.ts";
import { formatDay, formatMoney } from "./format.ts";
import { Button, CategoryGrid, Field, ReasonBanner } from "./parts.tsx";

export interface ConfirmCardProps {
  item: ReviewItem;
  categories: readonly string[];
  /** Held by the screen so a category survives the card re-rendering. */
  selected: string | null;
  onSelect: (category: string | null) => void;
  onConfirm: () => void;
  onSkip: () => void;
  /** Injected; Task 18's `lib/money.ts` replaces the default. */
  format?: (minor: bigint, currency: string) => string;
}

export function ConfirmCard({ item, categories, selected, onSelect, onConfirm, onSkip, format = formatMoney }: ConfirmCardProps) {
  const t = useTheme();
  const txn = item.txn;
  const willWriteRule = selected !== null && txn.merchant_raw.trim() !== "";

  return (
    <ScrollView
      contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: t.space.xs }}>
        <Text accessibilityRole="header" style={[t.type.display, { color: txn.direction === "credit" ? t.colors.credit : t.colors.text }]}>
          {format(txn.amount_minor, txn.currency)}
        </Text>
        <Text style={[t.type.body, { color: t.colors.textMuted }]}>
          {txn.direction === "credit" ? "Money in" : "Money out"}
          {txn.last4 === "" ? "" : ` · card ${txn.last4}`}
        </Text>
      </View>

      <View style={{ gap: t.space.md }}>
        <Field
          label="Merchant"
          value={txn.merchant_raw === "" ? "Not given" : txn.merchant_raw}
          {...(txn.merchant_raw === "" ? { tone: "muted" as const } : {})}
        />
        <Field label="Date" value={formatDay(txn.posted_at)} />
        {txn.amount_home_minor === null && txn.currency !== "" ? (
          <Field label="In your currency" value="No rate set for this currency yet" tone="muted" />
        ) : null}
      </View>

      <View style={{ height: 1, backgroundColor: t.colors.hairline }} />

      <ReasonBanner reason={item.reason} />

      <View style={{ gap: t.space.sm }}>
        <Text style={[t.type.heading, { color: t.colors.text }]}>Category</Text>
        <CategoryGrid categories={categories} selected={selected} onSelect={onSelect} />
        <Text style={[t.type.label, { color: t.colors.textMuted }]}>
          {willWriteRule
            ? "Confirming also remembers this merchant, so it won't be asked about again."
            : "Confirm without a category if you'd rather sort it later."}
        </Text>
      </View>

      <View style={{ gap: t.space.sm }}>
        <Button label="Confirm" tone="primary" onPress={onConfirm} />
        <Button label="Skip for now" onPress={onSkip} />
        <Text style={[t.type.label, { color: t.colors.textMuted }]}>Swipe right to confirm, left to skip.</Text>
      </View>
    </ScrollView>
  );
}
