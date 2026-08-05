import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { SUPPORTED_BANKS, WAITLIST_BANK, type WaitlistSource } from "../../samples/source.ts";
import { useTheme } from "../../app/Theme.tsx";

/**
 * The bank step.
 *
 * A supported bank calls {@link BankScreenProps.onSelect} with its id. An
 * unsupported one joins the waitlist and then calls `onSelect` with
 * {@link WAITLIST_BANK} — the step machine gates every later step on
 * `facts.bank !== null`, and a join that did not write that fact left the user
 * whose bank the waitlist exists for permanently stuck on this screen, with the
 * only forward path being to claim a bank they do not use.
 *
 * The donation invitation is issued last, after the step is recorded, so that
 * declining it (or the Review screen having nothing to donate yet) can never
 * cost the user their place in the flow.
 */
export interface BankScreenProps {
  waitlist: WaitlistSource;
  onSelect(bank: string): void;
  onInviteDonation(): void;
}

export function BankScreen({ waitlist, onSelect, onInviteDonation }: BankScreenProps) {
  const t = useTheme();
  const [other, setOther] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true);
    try {
      await waitlist.join(other);
      setMessage("Added to the bank request list.");
      onSelect(WAITLIST_BANK);
      onInviteDonation();
    } catch {
      setMessage("Could not add that bank. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return <View testID="bank-screen" style={{ flex: 1, padding: t.space.lg, gap: t.space.lg, backgroundColor: t.colors.bg }}><Text style={[t.type.title, { color: t.colors.text }]}>Which bank sends your alerts?</Text>
    {SUPPORTED_BANKS.map((bank) => <Pressable key={bank.id} accessibilityRole="button" onPress={() => onSelect(bank.id)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.text }]}>{bank.name}</Text></Pressable>)}
    <Text style={[t.type.body, { color: t.colors.text }]}>Another bank</Text><TextInput accessibilityLabel="Bank name" value={other} onChangeText={setOther} style={{ minHeight: 44, fontSize: 16, color: t.colors.text, backgroundColor: t.colors.surface, padding: t.space.md }} />
    <Pressable testID="bank-request" accessibilityRole="button" disabled={!other.trim() || busy} onPress={() => void join()} style={{ minHeight: 44, justifyContent: "center", opacity: other.trim() && !busy ? 1 : 0.5 }}><Text style={[t.type.body, { color: t.colors.accent }]}>Request support</Text></Pressable>
    <Text style={[t.type.label, { color: t.colors.textMuted }]}>A request adds only an aggregate count for this bank. If you want, the next screen separately offers to donate one email so this bank can be read.</Text>{message ? <Text accessibilityRole="alert" style={[t.type.body, { color: t.colors.textMuted }]}>{message}</Text> : null}</View>;
}
