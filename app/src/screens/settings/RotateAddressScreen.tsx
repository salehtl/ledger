/**
 * Settings: the inbound address, and the one way to change it.
 *
 * # It is a *read* screen first
 *
 * Onboarding shows the address once, on the launch the user sets ledger up. If
 * that were the only place it appeared, a user who force-quit mid-setup, or who
 * simply wants to re-add the forward on a new mail account a month later, would
 * have no way to see their own address again - the onboarding step is skipped
 * on every later launch, because bootstrap reads the address and the machine
 * walks past it. So this screen exists whether or not anyone ever rotates.
 *
 * # Rotation is destructive and SILENT, which is why the copy comes first
 *
 * `internal/v2/api/addresses.go`: "It is destructive, it is silent, and the
 * user finds out by noticing, days later, that transactions stopped appearing."
 * {@link rotationCopy} states every consequence spec 3.2 names before the
 * button is even armed, and the button is two-stage for the same reason
 * `DeleteAccountScreen`'s is.
 *
 * # The grace deadline is the SERVER's, and it covers ONE address
 *
 * {@link AddressCard} renders `grace_until` exactly as the response carried it,
 * beside {@link PREDECESSOR_SCOPE_NOTE}. `Addresses.Predecessor` is a single
 * hop (`addresses.go:291`), so an account that rotated twice inside a week has
 * an older address that is still accepting and that the response does not
 * mention. Nothing here reconstructs it, and nothing here caches a previous
 * answer to stitch a chain out of - the screen shows the newest response and
 * says out loud what that response does not cover.
 */

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { rotationFailureCopy, type AddressSource } from "../../account/address.ts";
import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { AddressCard } from "../../components/AddressCard.tsx";
import { rotationCopy, type AddressRecord } from "../../lib/address.ts";

export interface RotateAddressScreenProps {
  source: AddressSource;
  copy: (text: string) => Promise<void>;
  /** The whole three-factor rotation. Resolves with the NEW record. */
  rotate: () => Promise<AddressRecord>;
  onClose(): void;
  nowMs?: number;
}

export function RotateAddressScreen({ source, copy, rotate, onClose, nowMs }: RotateAddressScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const words = rotationCopy();
  const [record, setRecord] = useState<AddressRecord | null>(null);
  const [busy, setBusy] = useState(true);
  const [armed, setArmed] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setRecord(await source.current());
      setNotice(null);
    } catch {
      setNotice({ text: "ledger could not read your address from the server. Nothing has changed.", ok: false });
    } finally {
      setBusy(false);
    }
  }, [source]);

  useEffect(() => { void load(); }, [load]);

  const run = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const next = await rotate();
      // Straight from the server's answer. Not merged with what was on screen a
      // moment ago: the previous record's own predecessor is not this record's.
      setRecord(next);
      setArmed(false);
      setNotice({ text: "Your address has changed. Update your forwarding rule and any bank alert registration now.", ok: true });
    } catch (error) {
      setNotice({ text: rotationFailureCopy(error), ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      testID="rotate-address-screen"
      style={{ flex: 1, backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: Math.max(insets.top, t.space.lg),
        paddingBottom: insets.bottom + t.space.xl,
        gap: t.space.lg,
      }}
    >
      <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}>Inbound address</Text>

      {record !== null && <AddressCard record={record} copy={copy} {...(nowMs === undefined ? {} : { nowMs })} />}
      {record === null && busy && <ActivityIndicator accessibilityLabel="Reading your address" color={t.colors.accent} />}

      {notice !== null && (
        <Text
          testID="rotate-address-notice"
          accessibilityRole="alert"
          style={[t.type.body, { color: notice.ok ? t.colors.text : t.colors.danger }]}
        >
          {notice.text}
        </Text>
      )}

      <View style={{ gap: t.space.sm }}>
        <Text accessibilityRole="header" style={[t.type.heading, { color: t.colors.text }]}>{words.title}</Text>
        {words.consequences.map((line, i) => (
          <Text key={line} testID={`rotate-consequence-${i}`} style={[t.type.body, { color: t.colors.text }]}>
            {line}
          </Text>
        ))}
        <Text style={[t.type.label, { color: t.colors.textMuted }]}>{words.reauth}</Text>
      </View>

      {!armed ? (
        <Pressable
          testID="rotate-address-arm"
          accessibilityRole="button"
          disabled={record === null || busy}
          onPress={() => setArmed(true)}
          style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center", opacity: record === null || busy ? 0.5 : 1 }}
        >
          <Text style={[t.type.body, { color: t.colors.danger }]}>{words.confirm}</Text>
        </Pressable>
      ) : (
        <>
          <Pressable
            testID="rotate-address-confirm"
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void run()}
            style={{
              minHeight: TOUCH_TARGET_MIN,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: t.radius.md,
              backgroundColor: t.colors.danger,
              opacity: busy ? 0.6 : 1,
            }}
          >
            <Text style={[t.type.heading, { color: t.colors.bg }]}>{busy ? "Verifying" : words.confirm}</Text>
          </Pressable>
          <Pressable
            testID="rotate-address-cancel"
            accessibilityRole="button"
            onPress={() => setArmed(false)}
            style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
          >
            <Text style={[t.type.body, { color: t.colors.accent }]}>{words.cancel}</Text>
          </Pressable>
        </>
      )}

      <Pressable
        testID="rotate-address-close"
        accessibilityRole="button"
        accessibilityLabel="Close inbound address"
        onPress={onClose}
        style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
      >
        <Text style={[t.type.body, { color: t.colors.accent }]}>Done</Text>
      </Pressable>
    </ScrollView>
  );
}
