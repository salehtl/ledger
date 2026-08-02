/**
 * The `403 not_invited` surface — the closed beta's front door (plan Task 13
 * Step 5, Decision 8).
 *
 * It is a full-screen state rather than a pushed route, deliberately: the
 * navigation param it would need is the **ID token**, and a live credential in
 * a navigator's state is a credential in whatever that navigator later decides
 * to persist or log. Keeping it in the sign-in screen's reducer keeps it in
 * memory, where it belongs, and costs nothing — the user experiences a screen
 * either way.
 *
 * # What it does not do
 *
 * It does not offer a waiting list. The plan's step says "offering the
 * waitlist", and there is nothing to offer: `00012_waitlist.sql` is
 * `waitlist(bank, demand, first_seen, last_seen)` — a **bank-demand counter
 * with no users in it at all** — and no endpoint accepts a person. A button
 * that posted nowhere would be the same lie as Decision 10's recovery phrase
 * that recovers nothing, so the copy says plainly where a code comes from
 * instead.
 */

import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { failureCopy, type AuthFailure } from "../../auth/session.ts";

export interface NotInvitedViewProps {
  draft: string;
  /** Set once a code has actually been rejected — never on first arrival. */
  failure: AuthFailure | null;
  busy: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  onStartOver: () => void;
}

export function NotInvitedView({
  draft,
  failure,
  busy,
  onDraftChange,
  onSubmit,
  onStartOver,
}: NotInvitedViewProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [focused, setFocused] = useState(false);
  const copy = failureCopy({ kind: "not_invited", detail: "" });
  const canSubmit = draft.trim() !== "" && !busy;

  return (
    <ScrollView
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: insets.top + t.space.xl,
        paddingBottom: insets.bottom + t.space.xl,
        gap: t.space.lg,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: t.space.sm }}>
        <Text accessibilityRole="header" style={[t.type.display, { color: t.colors.text }]}>
          {copy.title}
        </Text>
        <Text style={[t.type.body, { color: t.colors.textMuted }]}>{copy.body}</Text>
      </View>

      <View style={{ gap: t.space.sm }}>
        <Text style={[t.type.label, { color: t.colors.textMuted }]}>Invite code</Text>
        <TextInput
          testID="invite-code"
          accessibilityLabel="Invite code"
          value={draft}
          onChangeText={onDraftChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={!busy}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          returnKeyType="go"
          onSubmitEditing={() => {
            if (canSubmit) onSubmit();
          }}
          placeholder="Paste the code you were sent"
          placeholderTextColor={t.colors.textMuted}
          style={[
            t.type.input,
            {
              color: t.colors.text,
              backgroundColor: t.colors.surface,
              borderColor: focused ? t.colors.accent : t.colors.hairline,
              borderWidth: 1,
              borderRadius: t.radius.md,
              paddingHorizontal: t.space.md,
              minHeight: TOUCH_TARGET_MIN,
            },
          ]}
        />
        {failure !== null && (
          <Text testID="invite-error" style={[t.type.label, { color: t.colors.danger }]}>
            That code was not accepted. Codes are single use, so one that has already been redeemed will not work
            again.
          </Text>
        )}
      </View>

      <Pressable
        testID="invite-submit"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit, busy }}
        disabled={!canSubmit}
        onPress={onSubmit}
        style={{
          minHeight: TOUCH_TARGET_MIN,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: t.radius.md,
          backgroundColor: canSubmit ? t.colors.accent : t.colors.hairline,
          opacity: busy ? 0.6 : 1,
        }}
      >
        <Text style={[t.type.heading, { color: canSubmit ? t.colors.surface : t.colors.textMuted }]}>
          {busy ? "Checking…" : "Use this code"}
        </Text>
      </Pressable>

      <Text style={[t.type.label, { color: t.colors.textMuted }]}>
        Codes are handed out one at a time by the person running this beta, and each one works once. There is no
        waiting list to join from inside the app.
      </Text>

      <Pressable
        testID="invite-start-over"
        accessibilityRole="button"
        onPress={onStartOver}
        hitSlop={t.space.md}
        style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
      >
        <Text style={[t.type.body, { color: t.colors.accent }]}>Use a different account</Text>
      </Pressable>
    </ScrollView>
  );
}
