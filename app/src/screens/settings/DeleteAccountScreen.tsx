import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../app/Theme.tsx";

export function DeleteAccountScreen({ remove, onExport }: { remove(): Promise<void>; onExport(): void }) {
  const t = useTheme(); const [armed, setArmed] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const run = async () => { setBusy(true); setMessage(""); try { await remove(); } catch { setMessage("Your account was not deleted. Your data remains on this device."); setBusy(false); } };
  return <View testID="delete-account-screen" style={{ flex: 1, padding: t.space.lg, gap: t.space.lg, backgroundColor: t.colors.bg }}>
    <Text style={[t.type.title, { color: t.colors.text }]}>Delete account</Text>
    <Text style={[t.type.body, { color: t.colors.text }]}>This permanently deletes your account and server data. Backup copies are not removed instantly; they expire on the server's retention schedule. This device's local ledger is erased only after the server confirms deletion.</Text>
    <Text style={[t.type.body, { color: t.colors.text }]}>You will need a new invitation if you return. Export first if you want to keep a copy.</Text>
    <Pressable accessibilityRole="button" onPress={onExport} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.accent }]}>Export before deleting</Text></Pressable>
    {!armed ? <Pressable accessibilityRole="button" onPress={() => setArmed(true)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.danger }]}>Continue to delete</Text></Pressable> : <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run()} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: t.space.md, backgroundColor: t.colors.danger, opacity: busy ? 0.6 : 1 }}><Text style={[t.type.body, { color: t.colors.bg }]}>{busy ? "Verifying…" : "Delete my account permanently"}</Text></Pressable>}
    {message ? <Text accessibilityRole="alert" style={[t.type.body, { color: t.colors.danger }]}>{message}</Text> : null}
  </View>;
}
