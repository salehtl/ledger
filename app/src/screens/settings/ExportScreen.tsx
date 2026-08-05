import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../app/Theme.tsx";
import { EXPORT_OMISSIONS, type ExportFormat } from "../../lib/export.ts";

export function ExportScreen({ run }: { run(format: ExportFormat): Promise<{ bytes: number }> }) {
  const t = useTheme(); const [format, setFormat] = useState<ExportFormat>("csv"); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const start = async () => { setBusy(true); setMessage(""); try { const r = await run(format); setMessage(`${r.bytes.toLocaleString()} bytes ready to share.`); } catch { setMessage("Export failed. Your ledger was not changed."); } finally { setBusy(false); } };
  return <View testID="export-screen" style={{ flex: 1, padding: t.space.lg, gap: t.space.lg, backgroundColor: t.colors.bg }}>
    <Text style={[t.type.title, { color: t.colors.text }]}>Export your ledger</Text>
    <Text style={[t.type.body, { color: t.colors.text }]}>CSV opens in spreadsheets and contains transactions. JSON is the complete readable copy of this device's current ledger state.</Text>
    <View style={{ flexDirection: "row", gap: t.space.sm }}>{(["csv", "json"] as const).map((f) => <Pressable key={f} accessibilityRole="button" accessibilityState={{ selected: format === f }} onPress={() => setFormat(f)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: t.space.md, backgroundColor: format === f ? t.colors.accent : t.colors.surface }}><Text style={[t.type.body, { color: format === f ? t.colors.bg : t.colors.text }]}>{f.toUpperCase()}</Text></Pressable>)}</View>
    <Text style={[t.type.label, { color: t.colors.textMuted }]}>{EXPORT_OMISSIONS[format].join(" ")}</Text>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void start()} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: t.space.md, backgroundColor: t.colors.accent, opacity: busy ? 0.6 : 1 }}><Text style={[t.type.body, { color: t.colors.bg }]}>{busy ? "Preparing…" : "Create and share export"}</Text></Pressable>
    {message ? <Text accessibilityRole="alert" style={[t.type.body, { color: t.colors.textMuted }]}>{message}</Text> : null}
  </View>;
}
