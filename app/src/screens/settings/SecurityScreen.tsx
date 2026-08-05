import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DORMANT_NOTICE, PLAINTEXT_DISCLOSURE, SECURITY_SLOTS, type DeviceIdentity } from "../../security/model.ts";
import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";

export function SecurityScreen({ identity }: { identity: DeviceIdentity | null }) {
  const t = useTheme(); const insets = useSafeAreaInsets(); const [open, setOpen] = useState<string | null>(null);
  return <ScrollView testID="security-screen" style={{ flex: 1, backgroundColor: t.colors.bg }} contentContainerStyle={{ padding: t.space.lg, paddingTop: Math.max(insets.top, t.space.lg), gap: t.space.lg }}>
    <Text style={[t.type.title, { color: t.colors.text }]}>Security</Text>
    <View style={{ padding: t.space.md, backgroundColor: t.colors.surface, gap: t.space.sm }}><Text style={[t.type.label, { color: t.colors.danger }]}>{DORMANT_NOTICE}</Text><Text style={[t.type.body, { color: t.colors.text }]}>{PLAINTEXT_DISCLOSURE}</Text></View>
    {SECURITY_SLOTS.map((slot) => <View key={slot.id}><Pressable accessibilityRole="button" accessibilityState={{ expanded: open === slot.id }} onPress={() => setOpen(open === slot.id ? null : slot.id)} style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center", borderBottomWidth: 1, borderBottomColor: t.colors.hairline }}><Text style={[t.type.body, { color: t.colors.text }]}>{slot.title}</Text><Text style={[t.type.label, { color: t.colors.textMuted }]}>Not yet active</Text></Pressable>{open === slot.id ? <Text style={[t.type.body, { color: t.colors.textMuted, paddingVertical: t.space.sm }]}>{slot.explanation}</Text> : null}</View>)}
    <View style={{ gap: t.space.sm }}><Text style={[t.type.body, { color: t.colors.text }]}>This device's key</Text>{identity === null ? <Text style={[t.type.body, { color: t.colors.textMuted }]}>No device writer is enrolled.</Text> : <><Text selectable style={[t.type.label, { color: t.colors.textMuted }]}>Writer {identity.writerId}</Text><Text selectable accessibilityLabel={`Public key fingerprint ${identity.fingerprint}`} style={[t.type.body, { color: t.colors.text }]}>{identity.fingerprint}</Text><Text style={[t.type.label, { color: t.colors.textMuted }]}>SHA-256 fingerprint of this device's real Ed25519 public identity key. This is not an encryption or recovery key.</Text></>}</View>
  </ScrollView>;
}
