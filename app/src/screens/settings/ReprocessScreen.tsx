import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../app/Theme.tsx";
import { BACKFILL_SCOPE, HEURISTIC_LIMITATION, type ReprocessProgress, type ReprocessResult } from "../../sync/reprocess.ts";

export interface ReprocessScreenProps {
  start(onProgress: (p: ReprocessProgress) => void, cancelled: () => boolean): Promise<ReprocessResult>;
  onClose?: () => void;
}

export function ReprocessScreen({ start, onClose }: ReprocessScreenProps) {
  const t = useTheme(); const cancel = useRef(false); const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ReprocessProgress | null>(null); const [message, setMessage] = useState("");
  const run = async () => { cancel.current = false; setRunning(true); setMessage("");
    try { const result = await start(setProgress, () => cancel.current); setMessage(result.cancelled ? "Re-check stopped. No queued change was removed." : `${result.emitted} corrected transaction${result.emitted === 1 ? "" : "s"} queued.`); }
    catch { setMessage("Could not re-check mail. No unverified message was parsed."); } finally { setRunning(false); }
  };
  return <View style={{ flex: 1, padding: t.space.lg, gap: t.space.lg, backgroundColor: t.colors.bg }}>
    <Text style={[t.type.title, { color: t.colors.text }]}>Re-check past mail</Text>
    {onClose ? <Pressable accessibilityRole="button" accessibilityLabel="Close re-check" onPress={onClose} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.accent }]}>Back</Text></Pressable> : null}
    <Text style={[t.type.body, { color: t.colors.text }]}>{BACKFILL_SCOPE}</Text>
    <Text style={[t.type.label, { color: t.colors.textMuted }]}>{HEURISTIC_LIMITATION}</Text>
    {progress ? <Text accessibilityRole="progressbar" style={[t.type.body, { color: t.colors.text }]}>{progress.examined} of {progress.total} checked · {progress.emitted} corrected · {progress.unavailable} unavailable</Text> : null}
    <Pressable accessibilityRole="button" onPress={running ? () => { cancel.current = true; } : () => void run()} style={{ minHeight: 44, justifyContent: "center", backgroundColor: t.colors.accent, paddingHorizontal: t.space.md }}><Text style={[t.type.body, { color: t.colors.bg }]}>{running ? "Stop" : "Re-check mail"}</Text></Pressable>
    {message ? <Text accessibilityRole="alert" style={[t.type.body, { color: t.colors.textMuted }]}>{message}</Text> : null}
  </View>;
}
