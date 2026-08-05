import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { SUPPORTED_BANKS, WAITLIST_BANK, type WaitlistSource } from "../../samples/source.ts";
import { BANK_NAME_RULE, normalizeBankName } from "../../lib/bank.ts";
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
 * # The waitlist may never decide whether onboarding continues
 *
 * It is a demand counter. Its entire output is "write the Mashreq parser next".
 * So there are exactly two ways this screen can end, and neither of them can be
 * closed by the server:
 *
 *   - **A name the counter can store** records it and advances. If the request
 *     itself fails — offline, 500, or a grammar the server tightened after this
 *     build shipped — the step STILL advances, saying honestly that the request
 *     was not recorded. Retrying cannot help the user and their place in the
 *     flow is not the counter's to withhold.
 *   - **"Continue without adding it"** advances with no request at all. This is
 *     the path for a name the grammar cannot represent — Arabic, an en dash, a
 *     Turkish dotted I — where no amount of retyping will work. Without it, a
 *     grammar refusal is a dead end wearing a helpful message.
 *
 * A refusal from {@link normalizeBankName} is the one case that does not
 * advance by itself, and deliberately: it is instantly correctable, the
 * message says what is allowed, and advancing would throw away the demand
 * signal the user was one edit from giving. The escape hatch is right there if
 * they would rather move on.
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
  const advance = () => {
    onSelect(WAITLIST_BANK);
    onInviteDonation();
  };
  const join = async () => {
    // Checked before the request, with the same grammar the server enforces,
    // so the refusal is this sentence and not a 400 rendered as "Try again."
    const name = normalizeBankName(other);
    if (!name.ok) {
      setMessage(name.reason);
      return;
    }
    setBusy(true);
    try {
      await waitlist.join(other);
      setMessage("Added to the bank request list.");
    } catch (error) {
      const detail = error instanceof Error && error.message !== "" ? error.message : "the request did not go through";
      setMessage(`We could not record that bank: ${detail}. Carrying on anyway — this only decides which bank ledger learns to read next.`);
    } finally {
      setBusy(false);
    }
    advance();
  };
  const invalid = other.trim() !== "" && !normalizeBankName(other).ok;
  return <View testID="bank-screen" style={{ flex: 1, padding: t.space.lg, gap: t.space.lg, backgroundColor: t.colors.bg }}><Text style={[t.type.title, { color: t.colors.text }]}>Which bank sends your alerts?</Text>
    {SUPPORTED_BANKS.map((bank) => <Pressable key={bank.id} accessibilityRole="button" onPress={() => onSelect(bank.id)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.text }]}>{bank.name}</Text></Pressable>)}
    <Text style={[t.type.body, { color: t.colors.text }]}>Another bank</Text><TextInput accessibilityLabel="Bank name" value={other} onChangeText={setOther} autoCorrect={false} style={{ minHeight: 44, fontSize: 16, color: t.colors.text, backgroundColor: t.colors.surface, padding: t.space.md, borderWidth: 1, borderColor: invalid ? t.colors.warning : t.colors.hairline }} />
    {/* The rule is on the glass before anything is refused. A constraint a user
        only discovers by tripping it is a constraint shown too late. */}
    <Text testID="bank-name-rule" style={[t.type.label, { color: invalid ? t.colors.warning : t.colors.textMuted }]}>{BANK_NAME_RULE}</Text>
    <Pressable testID="bank-request" accessibilityRole="button" disabled={!other.trim() || busy} onPress={() => void join()} style={{ minHeight: 44, justifyContent: "center", opacity: other.trim() && !busy ? 1 : 0.5 }}><Text style={[t.type.body, { color: t.colors.accent }]}>Request support</Text></Pressable>
    {/* The step is never closed by the counter. Some real bank names cannot be
        written in this grammar at all, and those users were invited too. */}
    <Pressable testID="bank-skip" accessibilityRole="button" disabled={busy} onPress={advance} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.textMuted }]}>Continue without adding it</Text></Pressable>
    <Text style={[t.type.label, { color: t.colors.textMuted }]}>A request adds only an aggregate count for this bank. If you want, the next screen separately offers to donate one email so this bank can be read.</Text>{message ? <Text testID="bank-message" accessibilityRole="alert" style={[t.type.body, { color: t.colors.textMuted }]}>{message}</Text> : null}</View>;
}
