/**
 * One row of the transaction list.
 *
 * # Calm rows
 *
 * The v1 UX notes record what the operator actually wants from this screen:
 * swipe and inline filters and *calm rows* — not a wall of badges. So the row
 * prints three things (merchant, category line, amount) and adds a marker only
 * when the marker changes what the user should do about the row.
 *
 * # The one row that is not a number
 *
 * A row Task 7 flagged `unparsed` carries `amount_minor: 0n`, so a row that
 * simply formatted its amount would print `0.00` and read as a purchase that
 * cost nothing. {@link txnAmountLabel} routes through `countsTowardMoney` and
 * gives an em dash; the category line says "Couldn't read this one". That pair
 * is Task 18 Step 5's requirement and it is asserted in the render test rather
 * than left to inspection.
 *
 * # The provenance marker is permanent
 *
 * Spec §3.3(b) requires the UI to distinguish server-ingested rows from
 * user-authored ones, because the ingest writer's chain proves the blob was
 * stored intact and proves **nothing** about whether the operator's server was
 * honest about what it ingested. It is a dot with an accessibility label rather
 * than a word, because it is on every ingested row and every ingested row is
 * most of them — but it is never absent, and it is never colour alone.
 */

import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import type { Txn } from "@ledger/client/replay/state.ts";

import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { shortDate } from "../../lib/format.ts";
import { formatMoney } from "../../lib/money.ts";
import { txnAmountLabel, txnCategoryLabel, txnMarkers } from "../../lib/transactions.ts";

export interface TransactionRowProps {
  txn: Txn;
  /** The user's home currency, so a native tag is shown only when it differs. */
  homeCurrency: string | null;
  /** RFC3339 "now", injected so the date label is testable without a clock. */
  nowIso: string;
  onPress: (id: string) => void;
}

function Row({ txn, homeCurrency, nowIso, onPress }: TransactionRowProps) {
  const t = useTheme();
  const amount = txnAmountLabel(txn);
  const markers = txnMarkers(txn);
  const foreign = txn.currency !== "" && txn.currency !== homeCurrency;
  const colour = amount.unreadable ? t.colors.textMuted : amount.flow === "in" ? t.colors.credit : t.colors.debit;

  return (
    <Pressable
      testID={`txn-row-${txn.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${txn.merchant_raw === "" ? "Unreadable message" : txn.merchant_raw}, ${amount.text}`}
      onPress={() => onPress(txn.id)}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET_MIN,
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.md,
        paddingHorizontal: t.space.lg,
        paddingVertical: t.space.md,
        backgroundColor: pressed ? t.colors.surface : t.colors.bg,
      })}
    >
      {txn.provenance === "ingest" && (
        <View
          testID={`txn-provenance-${txn.id}`}
          accessibilityLabel="From your inbox"
          style={{ width: t.space.sm, height: t.space.sm, borderRadius: t.radius.pill, backgroundColor: t.colors.accent }}
        />
      )}
      <View style={{ flex: 1, gap: t.space.xs }}>
        <Text numberOfLines={1} style={[t.type.body, { color: t.colors.text }]}>
          {txn.merchant_raw === "" ? "Message we couldn't read" : txn.merchant_raw}
        </Text>
        <Text numberOfLines={1} style={[t.type.label, { color: t.colors.textMuted }]}>
          {txnCategoryLabel(txn)} · {shortDate(txn.posted_at, nowIso)}
        </Text>
        {markers.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
            {markers
              .filter((m) => m.kind !== "ingest")
              .map((m) => (
                <Text
                  key={m.kind}
                  testID={`txn-marker-${txn.id}-${m.kind}`}
                  style={[
                    t.type.label,
                    {
                      color: m.kind === "unparsed" || m.kind === "needs_review" ? t.colors.warning : t.colors.textMuted,
                    },
                  ]}
                >
                  {m.label}
                </Text>
              ))}
          </View>
        )}
      </View>
      <View style={{ alignItems: "flex-end", gap: t.space.xs }}>
        <Text testID={`txn-amount-${txn.id}`} style={[t.type.body, { color: colour }]}>
          {amount.text}
        </Text>
        {foreign && (
          <Text style={[t.type.label, { color: t.colors.textMuted }]}>{formatMoney(txn.amount_minor, txn.currency)}</Text>
        )}
      </View>
    </Pressable>
  );
}

/**
 * Memoised on the row's identity and version.
 *
 * A `FlatList` re-renders every visible row when its parent's state changes, and
 * the parent's state changes on every keystroke in the search field. The version
 * is in the comparison because it is exactly what a fold bumps when anything
 * about the row changed.
 */
export const TransactionRow = memo(Row, (a, b) => {
  return (
    a.txn.id === b.txn.id &&
    a.txn.version === b.txn.version &&
    a.txn.superseded_by === b.txn.superseded_by &&
    a.homeCurrency === b.homeCurrency &&
    a.nowIso === b.nowIso
  );
});
