/**
 * Sign in with Apple and Google — the app's first screen.
 *
 * The screen holds no policy. Every decision it renders was made in
 * `src/auth/` and tested under `bun test`: which scopes are asked for, what a
 * nonce is, whether a failure means "try again" or "there is nothing to try",
 * and — the one that matters most on the day the beta opens — whether an
 * invite code is asked for at all.
 *
 * # A returning account is never asked for a code
 *
 * `POST /api/v1/auth/exchange` ignores `invite_code` for an account that
 * already exists, so the server would not reject a returning alpha who
 * supplied one. The failure this screen has to avoid is one screen earlier:
 * asking. The first exchange carries no code (`signInReducer`), and the code
 * field does not exist in this tree until the server has answered
 * `403 not_invited`. Every returning alpha therefore signs in with two taps
 * and never sees the word "invite".
 *
 * And most of them will not see this screen at all: a device that already
 * holds a session in the Keychain reports it on the very first render, before
 * paint, so a relaunch resumes rather than re-authenticating.
 *
 * # Both providers ship
 *
 * App Store review requires Sign in with Apple wherever a third-party sign-in
 * is offered, so Google without Apple is not shippable. Apple without Google
 * is — which is what this build is today, because the Google iOS client id is
 * a portal item nobody here can create (NEEDS-SALEH §1b). The Google button is
 * therefore rendered **disabled with the reason on it** rather than omitted or
 * left live: a live button over a missing client id fails at the one moment a
 * user touches it, and an omitted one is a missing feature nobody notices
 * until review.
 *
 * # The development-only third way in
 *
 * See {@link devSignInPanel}. It is additive: not one line of the Apple or
 * Google path below branches on it, and it establishes its session through the
 * same reducer, the same `exchangeOnce` and the same invite handling as they do.
 */

import { useCallback, useEffect, useReducer, useRef, useState, type ComponentType } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { IDP_APPLE, runIdpFlow, type Idp, type IdpAuthenticator } from "../../auth/idp.ts";
import type { SignInDeps } from "../../auth/native.ts";
import {
  classifyFailure,
  exchangeOnce,
  failureCopy,
  hasSession,
  initialSignInState,
  signInReducer,
  type SignInState,
} from "../../auth/session.ts";
import { NotInvitedView } from "./NotInvitedView.tsx";
import type { DevSignInPanelProps } from "./DevSignInPanel.tsx";

/**
 * The **one** gate on the development sign-in path, and the only place
 * `__DEV__` is read for it.
 *
 * # Why a `require` inside a ternary, and not an import plus `{__DEV__ && …}`
 *
 * Both forms hide the control. Only this one removes it. Metro replaces the
 * `__DEV__` identifier with `false` in a production build and constant-folds
 * what is left, so in production this function's body is `return null`, the
 * `require` never survives to dependency collection, and `DevSignInPanel.tsx`
 * and `auth/devAuth.ts` are not in the bundle at all — no control, no copy, no
 * `"dev:"` prefix, nothing to find. A static import would keep both modules in
 * the graph with only the JSX folded away, which is a bypass that ships and is
 * merely not rendered.
 *
 * # Why it cannot be turned on at build time
 *
 * `__DEV__` is set by the bundler from its own dev/production mode: `expo
 * start` makes it true, `expo export` and every release build make it false.
 * There is no environment variable, no `app.json` key and no CLI flag that
 * makes a production bundle report `true`. That is the whole reason an
 * `EXPO_PUBLIC_*` flag is NOT used here, alone or in combination: an
 * `EXPO_PUBLIC_*` value is inlined from whatever environment ran the build, so
 * it is exactly one `export` away from being on in a shipped binary, and adding
 * it would only add a way to turn the path *off* in development — which is not
 * a safety property anyone needs.
 *
 * # Called during render, deliberately
 *
 * A module-scope `const` would read `__DEV__` once at import and could then
 * only be exercised by re-evaluating this module — which, under jest, means a
 * second copy of React and an "invalid hook call" instead of a test. Read here,
 * the gate is observable by a mounted render in both directions, which is what
 * `DevSignIn.rn-test.tsx` asserts and what the mutation battery in
 * `dev-signin-report.md` kills. In production it costs nothing: the whole body
 * is folded to `null`.
 */
function devSignInPanel(): ComponentType<DevSignInPanelProps> | null {
  return __DEV__ ? (require("./DevSignInPanel.tsx") as typeof import("./DevSignInPanel.tsx")).DevSignInPanel : null;
}

export interface SignInScreenProps {
  deps: SignInDeps;
  /**
   * A sentence from the screen that sent the user here, rendered above
   * everything else.
   *
   * Account deletion is its only source today, and it is a prop rather than
   * state because the screen that has something to say has already been
   * unmounted by `navigation.reset` before it could say it. Shown even while a
   * session is being restored, since arriving here at all is the exceptional
   * case worth explaining.
   */
  notice?: string | null;
  /**
   * Called once there is a session. `null` means one was already on this
   * device and no exchange happened — the user id is in the store, and this
   * screen deliberately does not open the store to read it.
   */
  onSignedIn: (userId: string | null) => void;
  /**
   * An escape hatch, rendered **only** while `deps.backend` is null.
   *
   * Sign-in is the app's first screen, which means a build with no server
   * configured has nothing else reachable — including the shell's seam checks,
   * which are the only thing a device build can currently be pointed at. The
   * affordance removes itself the moment a backend exists, so it cannot ship
   * to an alpha as a way around signing in.
   */
  onSkip?: () => void;
}

export function SignInScreen({ deps, onSignedIn, onSkip, notice = null }: SignInScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [state, dispatch] = useReducer(signInReducer, undefined, initialSignInState);

  /**
   * Read synchronously in a lazy initialiser, not in an effect: an effect
   * would paint the sign-in screen for a frame to somebody who is already
   * signed in, which reads as "it logged me out".
   */
  const [restored] = useState(() => hasSession(deps.secrets));

  const [appleAvailable, setAppleAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    deps.apple
      .isAvailable()
      .then((ok) => live && setAppleAvailable(ok))
      .catch(() => live && setAppleAvailable(false));
    return () => {
      live = false;
    };
  }, [deps.apple]);

  useEffect(() => {
    if (restored) onSignedIn(null);
  }, [restored, onSignedIn]);

  useEffect(() => {
    if (state.step === "signed_in") onSignedIn(state.userId);
  }, [state, onSignedIn]);

  /**
   * The exchange, driven off the state rather than off a button handler, so
   * the first attempt and the invite retry are one code path. The ref keys on
   * the state object's identity — the reducer makes a new one per transition
   * — so a resubmitted code runs again and a re-render does not.
   *
   * # Enrolment is part of it, not a step after it
   *
   * `exchanged` is dispatched only once this device can also AUTHOR. Until
   * this existed the screen dispatched `exchanged` on the session alone and
   * navigated on, and the account it navigated into could not write a single
   * op — no edit, no category, no home currency — because nothing in `app/`
   * had ever called `Client.enroll`. Reversing the order (navigate, then
   * enrol) would put the failure on a screen that has already moved on.
   *
   * A failure here is a `failed` dispatch like any other, so the user is left
   * on this screen with a true sentence and both buttons live. Pressing one
   * again re-runs the whole thing; `ensureDeviceWriter` is idempotent, so the
   * retry adopts this device's existing writer id rather than minting a
   * second. Nothing retries on its own.
   */
  const handled = useRef<SignInState | null>(null);
  useEffect(() => {
    if (state.step !== "exchanging" || handled.current === state) return;
    handled.current = state;
    const backend = deps.backend;
    if (backend === null) {
      dispatch({
        type: "failed",
        failure: { kind: "unknown", detail: "this build has no server configured" },
      });
      return;
    }
    let live = true;
    const enrollDevice = deps.enrollDevice;
    exchangeOnce(backend, state.idp, state.idToken, state.inviteCode)
      .then(async (userId) => {
        if (enrollDevice !== null) await enrollDevice();
        return userId;
      })
      .then((userId) => live && dispatch({ type: "exchanged", userId }))
      .catch((e) => live && dispatch({ type: "failed", failure: classifyFailure(e) }));
    return () => {
      live = false;
    };
  }, [state, deps.backend, deps.enrollDevice]);

  const start = useCallback(
    async (auth: IdpAuthenticator) => {
      dispatch({ type: "press", idp: auth.idp });
      try {
        const identity = await runIdpFlow(auth, deps.newNonce());
        dispatch({ type: "authenticated", idp: auth.idp, idToken: identity.idToken });
      } catch (e) {
        dispatch({ type: "failed", failure: classifyFailure(e) });
      }
    },
    [deps],
  );

  /**
   * The development identity, entering the machine at exactly the point a real
   * provider's answer enters it.
   *
   * `press` then `authenticated` are the same two transitions `start` produces,
   * so everything downstream — the `exchanging` effect, `exchangeOnce`, the
   * `403 not_invited` routing into {@link NotInvitedView}, every failure in the
   * taxonomy — is the one code path, not a copy. In particular there is no
   * branch here that skips the invite gate: a dev sign-in is a different
   * *identity*, and creating an account with it still needs a code.
   *
   * `IDP_APPLE` because `--dev-auth` installs the dev verifier for BOTH
   * providers (`api.NewServer`), so the choice is free, and Apple is the
   * provider this build actually ships — sending `"google"` would exercise a
   * provider string the real app never sends.
   */
  const startDev = useCallback((idToken: string) => {
    dispatch({ type: "press", idp: IDP_APPLE });
    dispatch({ type: "authenticated", idp: IDP_APPLE, idToken });
  }, []);

  if (restored || state.step === "signed_in") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: t.space.lg, padding: t.space.lg, backgroundColor: t.colors.bg }}>
        {notice !== null && <Banner testID="sign-in-notice" tone="warning" title="Account deleted" body={notice} />}
        <ActivityIndicator color={t.colors.accent} />
      </View>
    );
  }

  if (state.step === "needs_invite") {
    return (
      <NotInvitedView
        draft={state.draft}
        failure={state.failure}
        busy={false}
        onDraftChange={(draft) => dispatch({ type: "invite_draft", draft })}
        onSubmit={() => dispatch({ type: "invite_submit" })}
        onStartOver={() => dispatch({ type: "restart" })}
      />
    );
  }

  const busy = state.step === "authenticating" || state.step === "exchanging";
  const activeIdp = state.step === "authenticating" || state.step === "exchanging" ? state.idp : null;
  const failure = state.step === "idle" ? state.failure : null;
  const copy = failure === null ? null : failureCopy(failure);
  const DevSignIn = devSignInPanel();

  return (
    <ScrollView
      style={{ backgroundColor: t.colors.bg }}
      contentContainerStyle={{
        padding: t.space.lg,
        paddingTop: insets.top + t.space.xxl,
        paddingBottom: insets.bottom + t.space.xl,
        gap: t.space.xl,
        flexGrow: 1,
      }}
    >
      <View style={{ gap: t.space.sm }}>
        <Text accessibilityRole="header" style={[t.type.display, { color: t.colors.text }]}>
          ledger
        </Text>
        <Text style={[t.type.body, { color: t.colors.textMuted }]}>
          Your bank already emails you every transaction. Forward those emails here and ledger keeps the running
          picture — on your phone, for you only.
        </Text>
      </View>

      {deps.backend === null && (
        <View style={{ gap: t.space.sm }}>
          <Banner
            testID="no-server"
            tone="warning"
            title="This build has no server configured"
            body="Sign-in cannot complete until the app is pointed at a ledger server. Nothing here is broken on your phone."
          />
          {onSkip !== undefined && (
            <Pressable
              testID="skip-to-shell"
              accessibilityRole="button"
              onPress={onSkip}
              hitSlop={t.space.md}
              style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
            >
              <Text style={[t.type.body, { color: t.colors.accent }]}>Open the seam checks instead</Text>
            </Pressable>
          )}
        </View>
      )}

      {/*
        Above the failure banner and above the provider buttons: it is the
        answer to "did the thing I just pressed do anything", and a user who has
        to scroll to find that has not been told.
      */}
      {notice !== null && (
        <Banner testID="sign-in-notice" tone="warning" title="Account deleted" body={notice} />
      )}

      {copy !== null && (
        <Banner testID="sign-in-failure" tone="danger" title={copy.title} body={copy.body} />
      )}

      <View style={{ gap: t.space.md }}>
        <ProviderButton
          testID="sign-in-apple"
          label="Sign in with Apple"
          idp="apple"
          disabled={busy || appleAvailable === false || deps.backend === null}
          busy={activeIdp === "apple"}
          note={appleAvailable === false ? "Sign in with Apple is not available on this device." : null}
          onPress={() => void start(deps.apple)}
        />
        <ProviderButton
          testID="sign-in-google"
          label="Sign in with Google"
          idp="google"
          disabled={busy || deps.google === null || deps.backend === null}
          busy={activeIdp === "google"}
          note={
            deps.google === null
              ? "Google sign-in is not configured in this build. Sign in with Apple instead."
              : null
          }
          onPress={() => {
            if (deps.google !== null) void start(deps.google);
          }}
        />
      </View>

      {/*
        Below the real providers, never above them. In a production bundle this
        whole expression is `null && …` and `DevSignInPanel.tsx` is not in the
        graph at all — see `devSignInPanel`.
      */}
      {DevSignIn !== null && (
        <DevSignIn disabled={busy || deps.backend === null} onSignIn={startDev} />
      )}

      <View style={{ flex: 1 }} />

      <Text style={[t.type.label, { color: t.colors.textMuted }]}>
        ledger asks Apple or Google only who you are — your name and email address. It never asks either of them
        for access to your mail.
      </Text>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------

function Banner({
  testID,
  tone,
  title,
  body,
}: {
  testID: string;
  tone: "warning" | "danger";
  title: string;
  body: string;
}) {
  const t = useTheme();
  const color = tone === "danger" ? t.colors.danger : t.colors.warning;
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={{
        gap: t.space.xs,
        padding: t.space.md,
        borderRadius: t.radius.md,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: t.colors.surface,
      }}
    >
      <Text style={[t.type.heading, { color }]}>{title}</Text>
      <Text style={[t.type.body, { color: t.colors.text }]}>{body}</Text>
    </View>
  );
}

function ProviderButton({
  testID,
  label,
  idp,
  disabled,
  busy,
  note,
  onPress,
}: {
  testID: string;
  label: string;
  idp: Idp;
  disabled: boolean;
  busy: boolean;
  note: string | null;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, busy }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => ({
          minHeight: TOUCH_TARGET_MIN,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: t.space.sm,
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderColor: t.colors.hairline,
          backgroundColor: idp === "apple" ? t.colors.text : t.colors.surface,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        })}
      >
        {busy && <ActivityIndicator color={idp === "apple" ? t.colors.bg : t.colors.text} />}
        <Text style={[t.type.heading, { color: idp === "apple" ? t.colors.bg : t.colors.text }]}>{label}</Text>
      </Pressable>
      {note !== null && (
        <Text testID={`${testID}-note`} style={[t.type.label, { color: t.colors.textMuted }]}>
          {note}
        </Text>
      )}
    </View>
  );
}
