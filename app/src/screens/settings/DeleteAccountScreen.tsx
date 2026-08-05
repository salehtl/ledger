import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { deletionFailureCopy, deletionResultCopy, type DeletionCopy, type DeletionResult } from "../../account/deletion.ts";
import { useTheme } from "../../app/Theme.tsx";

/**
 * `remove` resolves with a {@link DeletionResult} on the two endings that erase
 * this device (`204` and `410 account_deleted`) and rejects on every ending
 * that leaves it intact. The screen never composes its own sentence: it renders
 * the copy that ships with the outcome, so the message cannot contradict what
 * happened. It used to say "your data remains on this device" on the 410 path,
 * which had just deleted the database.
 */
export function DeleteAccountScreen({ remove, onExport }: { remove(): Promise<DeletionResult>; onExport(): void }) {
  const t = useTheme(); const [armed, setArmed] = useState(false); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<DeletionCopy | null>(null);
  const run = async () => { setBusy(true); setNotice(null); try { setNotice(deletionResultCopy(await remove())); } catch (error) { setNotice(deletionFailureCopy(error)); setBusy(false); } };
  return <View testID="delete-account-screen" style={{ flex: 1, padding: t.space.lg, gap: t.space.lg, backgroundColor: t.colors.bg }}>
    <Text style={[t.type.title, { color: t.colors.text }]}>Delete account</Text>
    <Text style={[t.type.body, { color: t.colors.text }]}>This permanently deletes your account and server data. Backup copies are not removed instantly; they expire on the server's retention schedule. This device's local ledger is erased only after the server confirms deletion.</Text>
    <Text style={[t.type.body, { color: t.colors.text }]}>You will need a new invitation if you return. Export first if you want to keep a copy.</Text>
    <Pressable accessibilityRole="button" onPress={onExport} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.accent }]}>Export before deleting</Text></Pressable>
    {!armed ? <Pressable accessibilityRole="button" onPress={() => setArmed(true)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.danger }]}>Continue to delete</Text></Pressable> : <Pressable accessibilityRole="button" disabled={busy} onPress={() => void run()} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: t.space.md, backgroundColor: t.colors.danger, opacity: busy ? 0.6 : 1 }}><Text style={[t.type.body, { color: t.colors.bg }]}>{busy ? "Verifying…" : "Delete my account permanently"}</Text></Pressable>}
    {notice === null ? null : <Text testID="delete-account-notice" accessibilityRole="alert" style={[t.type.body, { color: notice.wiped ? t.colors.text : t.colors.danger }]}>{notice.body}</Text>}
  </View>;
}
