/**
 * Onboarding step 4: the inbound address.
 *
 * # What was actually missing here, and it was not the state machine
 *
 * `lib/onboarding.ts` has had the milestone since Task 14
 * (`["address_issued", (f) => f.inboundAddress !== null]`), and `bootstrap.ts`
 * has fetched the address on every launch since. What did not exist was this
 * screen and, less obviously, any way to *reach* a non-null address on the
 * launch where the user signs in:
 *
 *   - `RuntimeProvider` bootstraps once, at mount. On a first run that happens
 *     before there is a session, so `persistedBootstrap` returns `signed_out`
 *     and `onboardingFacts()` never runs.
 *   - `Navigation` then passes `inboundAddress: null` (the `bootstrap.step ===
 *     "onboarding"` guard is false for a `signed_out` bootstrap), so a user who
 *     has just signed in and picked a bank lands on this step with the fact
 *     still null.
 *   - The shell's placeholder for it had `advance: null` - correctly, because
 *     the address is server truth and nothing on the device may fake one.
 *
 * So onboarding dead-ended on the launch where onboarding happens. The fix is
 * this screen performing the read itself: `GET /api/v1/address` mints on first
 * call, so the request that displays the address is the same request that
 * creates it.
 *
 * # Why it does not advance the machine by itself
 *
 * The instant `inboundAddress` is non-null, `stepFor` walks on. If this screen
 * reported the address the moment it arrived, it would render for one frame and
 * be replaced by the next step - handing the user nothing, which is precisely
 * the failure the copy target and the QR exist to prevent. The user presses
 * Continue, and only then does the fact reach the reducer.
 *
 * A later launch skips this screen, because bootstrap will have read the same
 * address. That is intended, and it is why the address is also a settings
 * screen (`screens/settings/RotateAddressScreen.tsx`) rather than only here.
 */

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { AddressCard } from "../../components/AddressCard.tsx";
import type { AddressSource } from "../../account/address.ts";
import type { AddressRecord } from "../../lib/address.ts";

export interface AddressScreenProps {
  source: AddressSource;
  copy: (text: string) => Promise<void>;
  /** Called when the user has the address. Emits `address_issued`. */
  onIssued(address: string): void;
  nowMs?: number;
}

export function AddressScreen({ source, copy, onIssued, nowMs }: AddressScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [record, setRecord] = useState<AddressRecord | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      setRecord(await source.current());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [source]);

  useEffect(() => { void load(); }, [load]);

  return (
    <ScrollView
      testID="onboarding-address"
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: insets.top + t.space.xl,
        paddingBottom: insets.bottom + t.space.xl,
        gap: t.space.lg,
        flexGrow: 1,
      }}
    >
      <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}>
        Your inbound address
      </Text>
      <Text style={[t.type.body, { color: t.colors.text }]}>
        This address is yours alone. Bank mail sent here becomes transactions in ledger; nothing else about your
        mailbox is read, and ledger never holds a password to it.
      </Text>

      {busy && <ActivityIndicator accessibilityLabel="Getting your address" color={t.colors.accent} />}

      {failed && (
        <>
          <Text testID="address-failed" accessibilityRole="alert" style={[t.type.body, { color: t.colors.danger }]}>
            ledger could not get your address from the server. Nothing is wrong with this device and nothing has been
            lost - the address is created on the server the first time it is asked for, so trying again is safe.
          </Text>
          <Pressable
            testID="address-retry"
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={() => void load()}
            style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
          >
            <Text style={[t.type.body, { color: t.colors.accent }]}>Try again</Text>
          </Pressable>
        </>
      )}

      {record !== null && (
        <>
          <AddressCard record={record} copy={copy} {...(nowMs === undefined ? {} : { nowMs })} />
          <Pressable
            testID="address-continue"
            accessibilityRole="button"
            accessibilityLabel="I have my address"
            onPress={() => onIssued(record.address)}
            style={({ pressed }) => ({
              minHeight: TOUCH_TARGET_MIN,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: t.radius.md,
              borderWidth: 1,
              borderColor: t.colors.hairline,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={[t.type.heading, { color: t.colors.text }]}>I have my address</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}
