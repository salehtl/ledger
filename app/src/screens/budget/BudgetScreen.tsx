import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../app/Theme.tsx";
import { formatMoney } from "../../lib/money.ts";
import type { BudgetBucket, BudgetSource } from "./source.ts";

const TARGET: Record<BudgetBucket, number> = { need: 50, want: 30, saving: 20 };
const LABEL: Record<BudgetBucket, string> = { need: "Needs", want: "Wants", saving: "Savings & debt" };

export function BudgetScreen({ source, nowMs, onCurrencies, onImport, onClose }: { source: BudgetSource; nowMs: number; onCurrencies: () => void; onImport: () => void; onClose: () => void }) {
  const t = useTheme(); const data = source.read(nowMs); const currency = data.homeCurrency ?? "";
  return <View style={{ flex: 1, padding: t.space.lg, gap: t.space.md, backgroundColor: t.colors.bg }}>
    <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}>50 / 30 / 20</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Close budget" onPress={onClose} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.accent }]}>Back</Text></Pressable>
    {data.warming ? <View testID="budget-warming" style={{ gap: t.space.sm }}><Text style={[t.type.body, { color: t.colors.text }]}>Your budget is warming up. Add 14 days or 10 confirmed transactions for a steadier view.</Text><Pressable accessibilityRole="button" onPress={onImport} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.accent }]}>Import a statement</Text></Pressable></View> : null}
    {(["need", "want", "saving"] as const).map((bucket) => <View key={bucket} style={{ padding: t.space.md, gap: t.space.xs, backgroundColor: t.colors.surface, borderRadius: t.radius.md }}><Text style={[t.type.heading, { color: t.colors.text }]}>{LABEL[bucket]} · {TARGET[bucket]}%</Text><Text style={[t.type.body, { color: t.colors.text }]}>{currency ? formatMoney(data.buckets[bucket], currency) : "Choose a home currency"}</Text></View>)}
    <Text style={[t.type.body, { color: t.colors.text }]}>Income context: {currency ? formatMoney(data.income, currency) : "—"}</Text>
    {data.unassigned !== 0n ? <Text style={[t.type.body, { color: t.colors.warning }]}>Unassigned spending excluded from 50 / 30 / 20: {currency ? formatMoney(data.unassigned, currency) : "—"}. Categorize it before treating these buckets as complete.</Text> : null}
    {data.excluded.unresolvedDuplicates > 0 ? <Text style={[t.type.label, { color: t.colors.warning }]}>{data.excluded.unresolvedDuplicates} possible duplicate{data.excluded.unresolvedDuplicates === 1 ? " needs" : "s need"} review and is excluded.</Text> : null}
    {data.excluded.missingHomeRate > 0 ? <Pressable testID="budget-missing-rates" accessibilityRole="button" onPress={onCurrencies} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.warning }]}>{data.excluded.missingHomeRate} transaction{data.excluded.missingHomeRate === 1 ? " is" : "s are"} missing a home-currency rate. Add rates</Text></Pressable> : null}
    {data.excluded.unparsed > 0 ? <Text style={[t.type.label, { color: t.colors.textMuted }]}>{data.excluded.unparsed} unread message{data.excluded.unparsed === 1 ? " was" : "s were"} excluded.</Text> : null}
  </View>;
}
