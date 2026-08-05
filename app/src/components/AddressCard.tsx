/**
 * The inbound address, on the glass: the string, a copy target you cannot miss,
 * and a QR.
 *
 * # Why this is a shared component and not two screens' worth of JSX
 *
 * The address is shown twice - once during onboarding, where it is the whole
 * point of the step, and once in settings, where it is the thing rotation is
 * about to retire. Those two must not drift, because the failure mode is
 * silent: an address rendered with a different truncation, a different case or
 * a stray space in one of the two places is an address the user copies and a
 * forward rule that quietly goes nowhere.
 *
 * # The address is rendered VERBATIM, and never prettified
 *
 * No grouping into blocks of four, no soft hyphens, no ellipsis. Every one of
 * those makes the string easier to read and makes what the eye reads differ
 * from what the clipboard holds, and a user reading it onto a laptop by eye is
 * exactly the case the 20 pt monospace size exists for.
 *
 * # The QR is black on white in both themes, deliberately
 *
 * It is the one element in the app that is not themed. A QR is read by a camera
 * with a contrast threshold, and an "accessible dark mode" QR is a QR that does
 * not scan. `t.colors` is therefore not consulted for the code itself, only for
 * the frame around it.
 */

import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import { TOUCH_TARGET_MIN, useTheme } from "../app/Theme.tsx";
import { graceNotice, PREDECESSOR_SCOPE_NOTE, type AddressRecord } from "../lib/address.ts";

/** Big enough to scan across a desk from a phone held in the other hand. */
const QR_SIZE = 220;
const QR_DARK = "#000000";
const QR_LIGHT = "#ffffff";

export interface AddressCardProps {
  record: AddressRecord;
  copy: (text: string) => Promise<void>;
  /** Injected in tests; the grace countdown is the only clock-dependent part. */
  nowMs?: number;
}

export function AddressCard({ record, copy, nowMs = Date.now() }: AddressCardProps) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const grace = graceNotice(record, nowMs);

  const onCopy = async () => {
    setFailed(false);
    try {
      await copy(record.address);
      setCopied(true);
    } catch {
      // Said, never swallowed: a user who believes they have the address and
      // does not is a user whose forward rule points at nothing.
      setCopied(false);
      setFailed(true);
    }
  };

  return (
    <View testID="address-card" style={{ gap: t.space.lg }}>
      <View
        style={{
          gap: t.space.sm,
          padding: t.space.lg,
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderColor: t.colors.hairline,
          backgroundColor: t.colors.surface,
        }}
      >
        <Text style={[t.type.label, { color: t.colors.textMuted }]}>Forward your bank mail to</Text>
        <Text
          testID="address-value"
          selectable
          accessibilityLabel={`Your inbound address, ${record.address}`}
          style={[t.type.address, { color: t.colors.text }]}
        >
          {record.address}
        </Text>
      </View>

      <Pressable
        testID="address-copy"
        accessibilityRole="button"
        accessibilityLabel="Copy address"
        onPress={() => void onCopy()}
        style={({ pressed }) => ({
          minHeight: TOUCH_TARGET_MIN,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: t.radius.md,
          backgroundColor: t.colors.text,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={[t.type.heading, { color: t.colors.bg }]}>{copied ? "Copied" : "Copy address"}</Text>
      </Pressable>
      {failed && (
        <Text testID="address-copy-failed" accessibilityRole="alert" style={[t.type.body, { color: t.colors.danger }]}>
          This device would not let ledger use the clipboard. The address above can be selected and copied by hand.
        </Text>
      )}

      <View style={{ alignItems: "center", gap: t.space.sm }}>
        <View testID="address-qr" style={{ padding: t.space.md, borderRadius: t.radius.md, backgroundColor: QR_LIGHT }}>
          <QRCode value={record.address} size={QR_SIZE} color={QR_DARK} backgroundColor={QR_LIGHT} />
        </View>
        <Text style={[t.type.label, { color: t.colors.textMuted, textAlign: "center" }]}>
          Point another device's camera at this to read the address without typing it.
        </Text>
      </View>

      {grace !== null && (
        <View
          testID="address-grace"
          style={{
            gap: t.space.xs,
            padding: t.space.md,
            borderRadius: t.radius.md,
            borderWidth: 1,
            borderColor: t.colors.hairline,
            backgroundColor: t.colors.surface,
          }}
        >
          <Text style={[t.type.heading, { color: grace.expired ? t.colors.textMuted : t.colors.warning }]}>
            Your previous address
          </Text>
          <Text testID="address-grace-text" style={[t.type.body, { color: t.colors.text }]}>{grace.text}</Text>
          <Text style={[t.type.label, { color: t.colors.textMuted }]}>{PREDECESSOR_SCOPE_NOTE}</Text>
        </View>
      )}
    </View>
  );
}
