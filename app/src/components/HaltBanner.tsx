/**
 * The wall.
 *
 * Spec §3.4: on a key-history mismatch or a writer-chain break the client
 * **halts sync and shows a non-dismissable warning**. This is that warning, and
 * it renders *instead of* the app — not over it, not behind a tab bar, and with
 * nothing on it that continues.
 *
 * # It holds no policy, and that is the point
 *
 * Which stops halt, which of them is shown when several fire, and what each one
 * says are all decided in `client/src/invariants/surface.ts` and tested under
 * `bun test` — including the two decisions this screen exists to carry:
 * `I11_roster_checkpoint`'s benign "this device hasn't been vouched for yet" and
 * its adversarial "the server is withholding data another of your devices has
 * already seen" get **different copy**, and when both fire the withholding one
 * is what `surface()` puts in `halt`. Phase 1 records that collapsing those two
 * into one message laundered a withholding attack into a notice; a screen that
 * re-derived its own wording from the id would reopen it one layer up.
 *
 * So this component takes a {@link Halt} and renders it. There is deliberately
 * no `severity` prop, no id switch and no string built here.
 *
 * # No dismissal, and no "continue anyway"
 *
 * `Halt.dismissable` is the literal type `false` and `syncStopped` the literal
 * `true`, so there is no value of `Halt` for which an escape would typecheck.
 * There is also no `onDismiss` prop: a control that does not exist cannot be
 * wired up by a later screen in a hurry.
 *
 * # The details are not optional
 *
 * `halt.violations` renders verbatim behind a disclosure. The plain-language
 * copy is for the person; the invariant ids and their details are for the
 * operator, who on this product is the same person on a worse day. A halt whose
 * only record is the friendly sentence cannot be diagnosed.
 *
 * # It reports the halt, it does not cause it
 *
 * The sync engine must already be stopped before this renders. Rendering is not
 * a side effect: `SyncEngine` halts on a `HardStopError` and persists nothing
 * over it, and this is the report of that.
 */

import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Halt } from "@ledger/client/invariants/surface.ts";

import { TOUCH_TARGET_MIN, useTheme } from "../app/Theme.tsx";

export interface HaltBannerProps {
  halt: Halt;
  /**
   * The other halts this sync raised, if any — shown as one line each under the
   * main one. `surface()` ranks them; this renders the ranking.
   *
   * They are listed rather than dropped because "your data is being withheld"
   * and "this app is out of date" can be true at once, and a user told only the
   * second would update and see the same wall.
   */
  also?: readonly Halt[];
}

export function HaltBanner({ halt, also = [] }: HaltBannerProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  return (
    <View
      // Not a modal, not an overlay: it is the screen. A modal has a dismissal
      // gesture on iOS whether or not a button is drawn.
      accessibilityViewIsModal
      accessibilityLabel={halt.title}
      testID="halt-banner"
      style={{
        flex: 1,
        backgroundColor: t.colors.bg,
        paddingTop: insets.top + t.space.xl,
        paddingBottom: insets.bottom + t.space.xl,
        paddingHorizontal: t.space.xl,
      }}
    >
      <ScrollView contentContainerStyle={{ gap: t.space.lg, flexGrow: 1 }}>
        <View
          style={{
            alignSelf: "flex-start",
            paddingHorizontal: t.space.md,
            paddingVertical: t.space.xs,
            borderRadius: t.radius.pill,
            backgroundColor: t.colors.surface,
          }}
        >
          <Text style={{ ...t.type.label, color: t.colors.danger }}>Syncing stopped</Text>
        </View>

        <Text style={{ ...t.type.title, color: t.colors.text }}>{halt.title}</Text>
        <Text style={{ ...t.type.body, color: t.colors.text }}>{halt.body}</Text>

        {halt.action === null ? null : (
          <View
            style={{
              padding: t.space.lg,
              borderRadius: t.radius.md,
              backgroundColor: t.colors.surface,
            }}
          >
            <Text style={{ ...t.type.body, color: t.colors.text }}>{halt.action}</Text>
          </View>
        )}

        {also.map((h) => (
          <Text key={h.kind} style={{ ...t.type.label, color: t.colors.textMuted }}>
            Also: {h.title}
          </Text>
        ))}

        <View style={{ flex: 1 }} />

        <Pressable
          testID="halt-details-toggle"
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => {
            setOpen((v) => !v);
          }}
          hitSlop={t.space.md}
          style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
        >
          <Text style={{ ...t.type.label, color: t.colors.accent }}>
            {open ? "Hide the details" : "What exactly happened?"}
          </Text>
        </Pressable>

        {open ? (
          <View style={{ gap: t.space.sm }} testID="halt-details">
            {halt.violations.map((v, n) => (
              <Text
                // Violations of one id differ only in their detail, and two
                // rows can legitimately share both, so the position is part of
                // the key. There is no id to key on that is unique here.
                key={`${v.id}:${String(n)}`}
                style={{ ...t.type.mono, color: t.colors.textMuted }}
              >
                {v.kind === undefined ? v.id : `${v.id} (${v.kind})`}: {v.detail}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
