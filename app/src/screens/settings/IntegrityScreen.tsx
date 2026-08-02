/**
 * Settings → Integrity: everything the invariant checker found that is not a
 * wall.
 *
 * Three lanes reach this screen and they are not interchangeable:
 *
 *  - **Halts** (`surface.halts`) — listed at the top when there are any. The
 *    full-screen `HaltBanner` is what a user actually meets; this is the record
 *    of it, so an operator can read the details after the fact.
 *  - **Unreadable blobs** (`surface.unreadable`) — a blob was set aside and the
 *    cursor moved past it (spec §3.3:74). Nothing is lost and nothing is
 *    stopped, so it is a row here and a *dismissable* banner elsewhere. Making
 *    this a wall is the failure mode Task 12 names in its first sentence.
 *  - **Notices** (`surface.notices`) — grouped by condition with a count, tap
 *    to expand.
 *
 * # Why grouped, and why the routine ones are still here
 *
 * Phase 1's exit run produced, per device per stream, several routine `I11`
 * notices plus eighteen `possible_duplicate` anomalies from a thin corpus, and
 * its own record says a notice list nobody reads is the same as no invariants.
 * So the screen shows categories with counts and expands to detail — and the
 * routine ones (a hot-only pull cannot cross-check a cold checkpoint head; a
 * single-device account has no peer to be vouched for by; `I14` prints its
 * counts unconditionally *because* a report that appears only when it is
 * interesting cannot be told from a broken one) sort last and do not badge.
 *
 * They are collapsed, never dropped. Suppressing them would re-create exactly
 * the blind spot `I14`'s unconditional line exists to remove.
 *
 * # It holds no policy either
 *
 * Grouping, ordering, routineness, the badge and every title are decided by
 * `surface()` in `client/src/invariants/surface.ts` and tested under
 * `bun test`. This renders the answer.
 */

import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Surface } from "@ledger/client/invariants/surface.ts";

import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";

export interface IntegrityScreenProps {
  surface: Surface;
}

export function IntegrityScreen({ surface }: IntegrityScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const toggle = (key: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const nothing = surface.halts.length === 0 && surface.notices.length === 0 && surface.unreadable === null;

  return (
    <ScrollView
      testID="integrity-screen"
      style={{ flex: 1, backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: insets.top + t.space.lg,
        paddingBottom: insets.bottom + t.space.xl,
        gap: t.space.lg,
      }}
    >
      <Text style={{ ...t.type.title, color: t.colors.text }}>Integrity</Text>

      {nothing ? (
        // Said out loud, for the same reason `I14` reports zero forks: a screen
        // that is blank when everything is fine is indistinguishable from one
        // whose data never arrived.
        <Text testID="integrity-clean" style={{ ...t.type.body, color: t.colors.textMuted }}>
          Every check passed on the last sync.
        </Text>
      ) : null}

      {surface.halts.map((h) => (
        <View
          key={h.kind}
          testID={`integrity-halt-${h.kind}`}
          style={{
            padding: t.space.lg,
            borderRadius: t.radius.md,
            backgroundColor: t.colors.surface,
            gap: t.space.sm,
          }}
        >
          <Text style={{ ...t.type.label, color: t.colors.danger }}>Syncing stopped</Text>
          <Text style={{ ...t.type.heading, color: t.colors.text }}>{h.title}</Text>
          <Text style={{ ...t.type.body, color: t.colors.text }}>{h.body}</Text>
        </View>
      ))}

      {surface.unreadable === null ? null : (
        <View
          testID="integrity-unreadable"
          style={{
            padding: t.space.lg,
            borderRadius: t.radius.md,
            backgroundColor: t.colors.surface,
            gap: t.space.sm,
          }}
        >
          <Text style={{ ...t.type.heading, color: t.colors.warning }}>
            {surface.unreadable.count} entr{surface.unreadable.count === 1 ? "y" : "ies"} ledger couldn&apos;t read
          </Text>
          <Text style={{ ...t.type.body, color: t.colors.textMuted }}>
            They were set aside and everything after them synced normally. Nothing was lost — they can be read again
            after an update.
          </Text>
        </View>
      )}

      {surface.notices.map((n) => {
        const key = `${n.id}|${n.kind ?? ""}`;
        const expanded = open.has(key);
        return (
          <View key={key} testID={`integrity-notice-${key}`}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => {
                toggle(key);
              }}
              hitSlop={t.space.sm}
              style={{
                minHeight: TOUCH_TARGET_MIN,
                flexDirection: "row",
                alignItems: "center",
                gap: t.space.md,
              }}
            >
              <Text style={{ ...t.type.body, color: n.routine ? t.colors.textMuted : t.colors.text, flex: 1 }}>
                {n.title}
              </Text>
              <Text
                testID={`integrity-count-${key}`}
                style={{
                  ...t.type.label,
                  color: t.colors.textMuted,
                  paddingHorizontal: t.space.sm,
                  paddingVertical: t.space.xs,
                  borderRadius: t.radius.pill,
                  backgroundColor: t.colors.surface,
                  overflow: "hidden",
                }}
              >
                {n.count}
              </Text>
            </Pressable>
            {expanded ? (
              <View style={{ gap: t.space.xs, paddingBottom: t.space.sm }}>
                {n.details.map((d, i) => (
                  <Text key={`${key}:${String(i)}`} style={{ ...t.type.mono, color: t.colors.textMuted }}>
                    {d}
                  </Text>
                ))}
                {n.details.length < n.count ? (
                  <Text style={{ ...t.type.label, color: t.colors.textMuted }}>
                    …and {n.count - n.details.length} more like it
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}
