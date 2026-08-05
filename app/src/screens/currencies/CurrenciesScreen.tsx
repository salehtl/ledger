import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../../app/Theme.tsx";
import { formatRateMicro } from "../../lib/fxUi.ts";
import type { CurrencySource } from "./source.ts";

export interface CurrenciesScreenProps { source: CurrencySource | null; onClose?: () => void; now?: () => number }

export function CurrenciesScreen({ source, onClose, now = Date.now }: CurrenciesScreenProps) {
  const theme = useTheme();
  const [revision, setRevision] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const view = source?.read(now()) ?? { usable: false, homeCurrency: null, rates: [] };
  const act = useCallback((fn: () => { ok: boolean; error?: string }) => {
    const result = fn();
    setMessage(result.ok ? "Queued for sync." : result.error ?? "Could not save rate.");
    if (result.ok) setRevision((v) => v + 1);
  }, []);
  void revision;

  return <ScrollView style={[styles.root, { backgroundColor: theme.colors.bg }]} contentContainerStyle={styles.content}>
    <View style={styles.header}>
      <Text style={[styles.title, { color: theme.colors.text }]}>Currencies & FX</Text>
      {onClose ? <Pressable accessibilityRole="button" accessibilityLabel="Close currencies" onPress={onClose}><Text style={{ color: theme.colors.accent }}>Done</Text></Pressable> : null}
    </View>
    {!view.usable ? <Text style={{ color: theme.colors.textMuted }}>Rates are available after the local ledger finishes rebuilding.</Text> : null}
    {view.homeCurrency ? <Text style={{ color: theme.colors.textMuted }}>Home currency: {view.homeCurrency} · fixed at 1.000000</Text> : null}
    {view.rates.map((row) => {
      const draft = drafts[row.currency] ?? (row.rateMicro === null ? "" : formatRateMicro(row.rateMicro));
      return <View key={row.currency} style={[styles.card, { borderColor: theme.colors.hairline }]}>
        <View style={styles.row}>
          <Text style={[styles.currency, { color: theme.colors.text }]}>{row.currency}</Text>
          <Text style={{ color: row.age.stale ? theme.colors.danger : theme.colors.textMuted }}>
            {row.updatedAt === "" ? "No rate" : `${row.age.label}${row.age.stale ? " · stale" : ""}`}
          </Text>
        </View>
        {row.pending > 0 ? <Text style={{ color: theme.colors.textMuted }}>{row.pending} transaction{row.pending === 1 ? "" : "s"} waiting for a rate</Text> : null}
        <TextInput
          accessibilityLabel={`${row.currency} exchange rate`}
          keyboardType="decimal-pad"
          value={draft}
          onChangeText={(value) => setDrafts((d) => ({ ...d, [row.currency]: value }))}
          style={[styles.input, { borderColor: theme.colors.hairline, color: theme.colors.text }]}
        />
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={() => act(() => source!.setRate(row.currency, draft))}><Text style={{ color: theme.colors.accent }}>{row.rateMicro === null ? "Add rate" : "Update"}</Text></Pressable>
          {row.rateMicro !== null ? <Pressable accessibilityRole="button" onPress={() => act(() => source!.unsetRate(row.currency))}><Text style={{ color: theme.colors.danger }}>Remove</Text></Pressable> : null}
        </View>
      </View>;
    })}
    {message !== "" ? <Text accessibilityRole="alert" style={{ color: theme.colors.textMuted }}>{message}</Text> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, content: { padding: 20, gap: 16 }, header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 28, fontWeight: "700" }, card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 14, gap: 10 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, currency: { fontSize: 18, fontWeight: "700" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontVariant: ["tabular-nums"] },
  actions: { flexDirection: "row", gap: 24 },
});
