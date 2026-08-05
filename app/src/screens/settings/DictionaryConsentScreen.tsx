import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { DictionarySubmitter } from "../review/deps.ts";
import { DICTIONARY_CONSENT } from "../../dictionary/submission.ts";
import { useTheme } from "../../app/Theme.tsx";

export function DictionaryConsentScreen({ submitter, entry, onDone }: { submitter: DictionarySubmitter; entry: { pattern: string; match: "exact" | "contains"; category: string }; onDone?(): void }) {
  const t = useTheme(); const [agreed, setAgreed] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const submit = async () => { if (!agreed) return; setBusy(true); setMessage(""); try { await submitter.submit(entry); setMessage("Shared. Thank you."); onDone?.(); } catch { setMessage("Could not share this entry. Your own rule is unchanged."); } finally { setBusy(false); } };
  return <View testID="dictionary-consent-screen" style={{ flex: 1, padding: t.space.lg, gap: t.space.lg, backgroundColor: t.colors.bg }}>
    <Text style={[t.type.title, { color: t.colors.text }]}>Help improve suggestions?</Text>
    <Text style={[t.type.body, { color: t.colors.text }]}>{entry.pattern} → {entry.category}</Text>
    <Text style={[t.type.body, { color: t.colors.textMuted }]}>{DICTIONARY_CONSENT}</Text>
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: agreed }} onPress={() => setAgreed((v) => !v)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.text }]}>{agreed ? "☑" : "☐"} I choose to share this entry</Text></Pressable>
    <Pressable accessibilityRole="button" disabled={!agreed || busy} onPress={() => void submit()} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: t.space.md, backgroundColor: t.colors.accent, opacity: !agreed || busy ? 0.5 : 1 }}><Text style={[t.type.body, { color: t.colors.bg }]}>{busy ? "Sharing…" : "Share entry"}</Text></Pressable>
    {message ? <Text accessibilityRole="alert" style={[t.type.body, { color: t.colors.textMuted }]}>{message}</Text> : null}
  </View>;
}
