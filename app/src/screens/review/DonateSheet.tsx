import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { DONATION_CONSENT, type DonationPreview } from "../../lib/redaction.ts";
import { SAMPLE_DISCLOSURE, type SampleSource } from "../../samples/source.ts";
import { useTheme } from "../../app/Theme.tsx";

export function DonateSheet({ source, ingestId, onDone }: { source: SampleSource; ingestId: string; onDone?(): void }) {
  const t = useTheme(); const [preview, setPreview] = useState<DonationPreview | null>(null); const [agreed, setAgreed] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => { let alive = true; void source.preview(ingestId).then((p) => { if (alive) setPreview(p); }, () => { if (alive) setMessage("The verified original email is unavailable."); }); return () => { alive = false; }; }, [source, ingestId]);
  const donate = async () => { if (!preview || !agreed) return; try { await source.donate(preview, DONATION_CONSENT); setMessage("Email donated."); onDone?.(); } catch { setMessage("Could not donate this email."); } };
  return <ScrollView testID="donate-sheet" style={{ flex: 1, backgroundColor: t.colors.bg }} contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }}><Text style={[t.type.title, { color: t.colors.text }]}>Donate this email?</Text><Text style={[t.type.body, { color: t.colors.danger }]}>{SAMPLE_DISCLOSURE}</Text>
    {preview ? <View style={{ padding: t.space.md, backgroundColor: t.colors.surface }}><Text selectable style={[t.type.label, { color: t.colors.text }]}>{preview.text}</Text></View> : <Text style={[t.type.body, { color: t.colors.textMuted }]}>Loading the chain-verified original…</Text>}
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: agreed }} disabled={!preview} onPress={() => setAgreed((v) => !v)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.text }]}>{agreed ? "☑" : "☐"} I understand this sends the complete email shown above under consent {DONATION_CONSENT}</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!preview || !agreed} onPress={() => void donate()} style={{ minHeight: 44, justifyContent: "center", opacity: preview && agreed ? 1 : 0.5 }}><Text style={[t.type.body, { color: t.colors.accent }]}>Donate complete email</Text></Pressable>{message ? <Text accessibilityRole="alert" style={[t.type.body, { color: t.colors.textMuted }]}>{message}</Text> : null}</ScrollView>;
}
