/**
 * The shell smoke screen — **temporary**.
 *
 * Task 14 landed the onboarding flow in front of it (`SignIn → Onboarding →
 * Shell`), so this is no longer the first thing after sign-in; it is what
 * "finished onboarding" currently lands on, and Task 18's transactions list
 * replaces it. It is kept rather than deleted because it is still the only
 * thing on the device that reports whether the two seams below are live.
 *
 * Task 3 Step 1 asks for "a throwaway import of `fold` from
 * `@ledger/client/replay/replay.ts` that type-checks and bundles". A throwaway
 * import is deleted the moment it has served, and then nothing in the app graph
 * reaches `client/src` again until Task 8 — so the next person to break Metro's
 * resolution of the library finds out weeks later, in a task that is about
 * something else.
 *
 * This is that import, kept, and made to do the one thing a throwaway cannot:
 * report on the device whether the two seams the app depends on are actually
 * live. `platform()` throws unless `app/src/platform` installed the React
 * Native implementation, and `fold()` is the top of the replay stack. Both are
 * exercised on mount and rendered as text, so a failure is visible on the
 * screen rather than hidden in a bundle that merely built.
 */

import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";

import { platform } from "@ledger/client/platform.ts";
import { emptyState, fold } from "@ledger/client/replay/replay.ts";

import { useTheme } from "../app/Theme.tsx";

interface Check {
  name: string;
  detail: string;
  ok: boolean;
}

function runChecks(): Check[] {
  const out: Check[] = [];

  try {
    const p = platform();
    const digest = p.toHex(p.sha256(p.utf8Encode("abc")));
    out.push({
      name: "platform seam",
      detail: digest.slice(0, 16),
      // The real SHA-256 of "abc", not "it returned something".
      ok: digest === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  } catch (e) {
    out.push({ name: "platform seam", detail: String(e), ok: false });
  }

  try {
    const s = fold([], emptyState());
    out.push({
      name: "replay fold",
      detail: `${s.txns.size} txns, home ${s.homeCurrency ?? "unset"}`,
      ok: s.txns.size === 0 && s.homeCurrency === null,
    });
  } catch (e) {
    out.push({ name: "replay fold", detail: String(e), ok: false });
  }

  return out;
}

export function Shell() {
  const t = useTheme();
  const checks = useMemo(runChecks, []);
  const allOk = checks.every((c) => c.ok);

  return (
    <ScrollView
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={{ padding: t.space.lg, gap: t.space.md }}
    >
      {/*
        Transform-only entrance. `FadeIn` would be wrong for content visible on
        first paint — v1 learned that the hard way with Framer's `LazyMotion`,
        where an `opacity: 0` initial left first-paint content simply invisible
        until a lazily-resolved chunk landed. Reanimated has no such window, but
        the convention holds because the failure is silent when it does bite.
      */}
      <Animated.View entering={FadeIn.duration(t.motion.base)}>
        <Text style={[t.type.display, { color: t.colors.text }]}>ledger</Text>
        <Text style={[t.type.body, { color: t.colors.textMuted }]}>
          Phase 2 shell. Onboarding replaces this screen.
        </Text>
      </Animated.View>

      <View style={[styles.card, { backgroundColor: t.colors.surface, borderRadius: t.radius.md, padding: t.space.lg, gap: t.space.sm }]}>
        <Text style={[t.type.heading, { color: t.colors.text }]}>
          client/src {allOk ? "is wired" : "is NOT wired"}
        </Text>
        {checks.map((c) => (
          <View key={c.name} style={{ gap: t.space.xs }}>
            <Text style={[t.type.label, { color: c.ok ? t.colors.credit : t.colors.danger }]}>
              {c.ok ? "ok" : "FAIL"} — {c.name}
            </Text>
            <Text style={[t.type.mono, { color: t.colors.textMuted }]}>{c.detail}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderColor: "transparent" },
});
