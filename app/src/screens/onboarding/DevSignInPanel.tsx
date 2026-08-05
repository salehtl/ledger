/**
 * The development-only sign-in affordance — `LEDGER_DEV_SIGN_IN`.
 *
 * # Why this module exists at all
 *
 * The operator's Apple ID is protected by a hardware security key, which an iOS
 * simulator cannot present. Sign in with Apple is therefore unusable in the
 * simulator, and the simulator is the only place this app can be seen render.
 * `ledgerd serve --dev-auth` has accepted `dev:<subject>` since Task 14; until
 * now nothing in `app/` could reach it.
 *
 * # Why it is a separate module rather than a block inside SignInScreen
 *
 * This file is loaded through a `require` that sits inside the `__DEV__`
 * ternary in `SignInScreen.tsx`. Metro replaces `__DEV__` with `false` in a
 * production build, constant-folds the ternary to `null`, and therefore never
 * collects this file as a dependency — so neither the control, its copy, nor
 * `devAuth.ts` exists in a production bundle. A `{__DEV__ && <Panel/>}` block
 * over a *static* import would strip the JSX and ship the module.
 *
 * That is a claim about a bundler, so it is measured rather than asserted:
 * `dev-signin-report.md` records the `expo export` and the `grep` for
 * {@link DEV_SIGN_IN_MARKER} over the emitted JavaScript.
 *
 * # This is an authentication bypass and is dressed as one
 *
 * It is a bordered, warning-toned block that says what it does in the first
 * sentence. Nothing about it is styled to look like a product affordance, and
 * it sits below the real providers rather than above them, because the day it
 * looks like the ordinary way in is the day somebody reaches for it on a device
 * pointed at a real server and cannot work out why nothing signs in.
 */

import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { INPUT_FONT_MIN, TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import {
  DEV_SIGN_IN_MARKER,
  DEV_SUBJECT_DEFAULT,
  devIdToken,
  devSubjectProblem,
} from "../../auth/devAuth.ts";

export interface DevSignInPanelProps {
  /** True while another sign-in is in flight, or while no server is configured. */
  disabled: boolean;
  /**
   * Hand the `dev:<subject>` identity to the screen.
   *
   * The screen drives it through the SAME reducer transitions a provider round
   * trip produces (`press` then `authenticated`), so the exchange, the invite
   * gate and every failure branch below it are one code path — this panel has
   * no network call of its own and cannot acquire one without being noticed.
   */
  onSignIn: (idToken: string) => void;
}

export function DevSignInPanel({ disabled, onSignIn }: DevSignInPanelProps) {
  const t = useTheme();
  const [subject, setSubject] = useState(DEV_SUBJECT_DEFAULT);
  const [focused, setFocused] = useState(false);
  const problem = devSubjectProblem(subject);
  const canSubmit = problem === null && !disabled;

  return (
    <View
      testID="dev-sign-in-panel"
      style={{
        gap: t.space.sm,
        padding: t.space.md,
        borderRadius: t.radius.md,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: t.colors.warning,
        backgroundColor: t.colors.surface,
      }}
    >
      <Text style={[t.type.heading, { color: t.colors.warning }]}>Developer sign-in</Text>
      <Text style={[t.type.label, { color: t.colors.textMuted }]}>
        Only in a development build, and only against a server started with{" "}
        <Text style={t.type.mono}>--dev-auth</Text>. It signs in as a made-up identity so the app can be driven in a
        simulator, where Sign in with Apple cannot be used. An invite code is still required to create an account.
      </Text>

      <Text style={[t.type.label, { color: t.colors.textMuted }]}>Developer subject</Text>
      <TextInput
        testID="dev-sign-in-subject"
        accessibilityLabel="Developer subject"
        value={subject}
        onChangeText={setSubject}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        returnKeyType="go"
        onSubmitEditing={() => {
          if (canSubmit) onSignIn(devIdToken(subject));
        }}
        placeholder={DEV_SUBJECT_DEFAULT}
        placeholderTextColor={t.colors.textMuted}
        style={[
          t.type.input,
          {
            fontSize: INPUT_FONT_MIN,
            color: t.colors.text,
            backgroundColor: t.colors.bg,
            borderColor: focused ? t.colors.accent : t.colors.hairline,
            borderWidth: 1,
            borderRadius: t.radius.md,
            paddingHorizontal: t.space.md,
            minHeight: TOUCH_TARGET_MIN,
          },
        ]}
      />
      {problem !== null && (
        <Text testID="dev-sign-in-error" style={[t.type.label, { color: t.colors.danger }]}>
          {problem}
        </Text>
      )}

      <Pressable
        testID="dev-sign-in"
        accessibilityRole="button"
        accessibilityLabel="Sign in as a developer identity"
        accessibilityState={{ disabled: !canSubmit }}
        disabled={!canSubmit}
        onPress={() => onSignIn(devIdToken(subject))}
        style={({ pressed }) => ({
          minHeight: TOUCH_TARGET_MIN,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderColor: t.colors.warning,
          backgroundColor: t.colors.bg,
          opacity: canSubmit ? (pressed ? 0.85 : 1) : 0.5,
        })}
      >
        <Text style={[t.type.heading, { color: t.colors.warning }]}>Sign in as a developer identity</Text>
      </Pressable>

      {/*
        The grep marker, on the glass. It is the same string the
        production-bundle proof searches for, so "can I read this string in the
        running app" and "is this string in the bundle" are one question with
        one answer — a build showing it is a build carrying the bypass.
      */}
      <Text testID="dev-sign-in-marker" style={[t.type.label, { color: t.colors.textMuted }]}>
        Present only in a development build: <Text style={t.type.mono}>{DEV_SIGN_IN_MARKER}</Text>
      </Text>
    </View>
  );
}
