import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { LANES, LANE_TITLE, type Lane } from "../../lib/review.ts";
import { ConfirmCard } from "./ConfirmCard.tsx";
import type { ReviewDeps } from "./deps.ts";
import { formatMoney } from "./format.ts";
import { Button, Field } from "./parts.tsx";
import { SwipeCard } from "./SwipeCard.tsx";
import { UnparsedCard } from "./UnparsedCard.tsx";
import { useReviewQueue } from "./useReviewQueue.ts";

export function ReviewScreen({ deps, onClose }: { deps: ReviewDeps; onClose: () => void }) {
  const queue = useReviewQueue(deps);
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const item = queue.items[0] ?? null;
  const fork = queue.forks[0] ?? null;
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => setSelected(item?.txn.category ?? null), [item?.key, item?.txn.category]);

  return (
    <View style={{ flex: 1, paddingTop: insets.top + t.space.md, backgroundColor: t.colors.bg }}>
      <View style={{ paddingHorizontal: t.space.lg, gap: t.space.sm }}>
        <Pressable testID="review-close" accessibilityRole="button" onPress={onClose} style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}><Text style={{ color: t.colors.accent }}>Transactions</Text></Pressable>
        <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}>Review</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space.sm }}>
          {LANES.map((lane) => <LaneButton key={lane} lane={lane} selected={queue.lane === lane} count={queue.counts[lane]} onPress={() => queue.setLane(lane)} />)}
        </ScrollView>
        <Text testID="review-live-count" style={[t.type.label, { color: t.colors.textMuted }]}>
          {queue.money.counted} with amounts · {queue.money.excluded} without
          {queue.money.awaitingRate === 0 ? "" : ` · ${queue.money.awaitingRate} awaiting rates`}
        </Text>
        {queue.error !== null && <Pressable accessibilityRole="button" onPress={queue.dismissError}><Text accessibilityRole="alert" style={{ color: t.colors.danger }}>{queue.error}</Text></Pressable>}
      </View>

      {queue.loading ? <ActivityIndicator style={{ flex: 1 }} /> : queue.lane === "forks" ? (
        fork === null ? <Empty /> : <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }}>
          <Text style={[t.type.heading, { color: t.colors.text }]}>Two offline edits touched the same item</Text>
          <Text style={[t.type.body, { color: t.colors.textMuted }]}>Ledger kept the deterministic winner and recorded the other edit instead of silently dropping it.</Text>
          <Field label="Item" value={`${fork.notice.entity.kind} · ${fork.notice.entity.id}`} />
          <Field label="Kept edit" value={fork.notice.winner_op} />
          <Field label="Other edit" value={fork.notice.loser_op} />
          <Field label="Resolved at log position" value={fork.notice.at_seq.toString(10)} />
          <Button label="Got it" tone="primary" onPress={() => void queue.acknowledgeFork(fork)} />
        </ScrollView>
      ) : item === null ? <Empty /> : queue.lane === "unparsed" ? (
        <UnparsedCard item={item} categories={queue.categories} raw={deps.raw} homeCurrency={null} onSave={(fields) => void queue.saveManualEntry(item, fields)} onDismiss={() => void queue.dismiss(item, "not_transaction")} />
      ) : queue.lane === "duplicate" ? (
        <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }}>
          <Text style={[t.type.heading, { color: t.colors.text }]}>Do these look like the same purchase?</Text>
          <Field label="This entry" value={`${item.txn.merchant_raw || "Unknown merchant"} · ${formatMoney(item.txn.amount_minor, item.txn.currency)}`} />
          <Field label="Compared with" value={item.counterpart === null ? "The other entry is no longer available" : `${item.counterpart.merchant_raw || "Unknown merchant"} · ${formatMoney(item.counterpart.amount_minor, item.counterpart.currency)}`} />
          <Text style={[t.type.body, { color: t.colors.textMuted }]}>Either answer keeps both ledger rows. This only dismisses the review notice.</Text>
          <Button label="They are different purchases" tone="primary" onPress={() => void queue.dismiss(item, "not_duplicate")} />
          <Button label="They are the same purchase" onPress={() => void queue.dismiss(item, "duplicate_confirmed")} />
        </ScrollView>
      ) : (
        <SwipeCard onConfirm={() => void queue.confirm(item, selected)} onSkip={() => queue.skip(item)}>
          <ConfirmCard item={item} categories={queue.categories} selected={selected} onSelect={setSelected} onConfirm={() => void queue.confirm(item, selected)} onSkip={() => queue.skip(item)} />
        </SwipeCard>
      )}

      {queue.undo !== null && <View style={{ padding: t.space.lg, borderTopWidth: 1, borderTopColor: t.colors.hairline, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[t.type.body, { color: t.colors.text }]}>{queue.undo.label}</Text>
        <Pressable testID="review-undo" accessibilityRole="button" onPress={() => void queue.performUndo()} style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}><Text style={[t.type.heading, { color: t.colors.accent }]}>Undo</Text></Pressable>
      </View>}
    </View>
  );
}

function LaneButton({ lane, selected, count, onPress }: { lane: Lane; selected: boolean; count: number; onPress: () => void }) {
  const t = useTheme();
  return <Pressable testID={`review-tab-${lane}`} accessibilityRole="tab" accessibilityState={{ selected }} onPress={onPress} style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center", paddingVertical: t.space.sm, paddingHorizontal: t.space.md, borderRadius: t.radius.pill, backgroundColor: selected ? t.colors.accent : t.colors.surface }}><Text style={[t.type.label, { color: selected ? t.colors.bg : t.colors.text }]}>{LANE_TITLE[lane]} {count}</Text></Pressable>;
}

function Empty() {
  const t = useTheme();
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: t.space.xl }}><Text style={[t.type.body, { color: t.colors.textMuted }]}>Nothing waiting here.</Text></View>;
}
