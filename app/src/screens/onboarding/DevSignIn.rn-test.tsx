/**
 * The development-only sign-in path, mounted — presence, absence, and the fact
 * that it goes through the ordinary door.
 *
 * Three properties are asserted here and none of them can be got from a pure
 * test:
 *
 *  1. **It is reachable in a development build.** A control that exists in a
 *     module and is never put on the glass is this project's "written, tested
 *     green, never wired" shape, and the whole point of this task is that the
 *     server's `--dev-auth` capability had exactly that problem on the client
 *     side.
 *  2. **It is gone when the dev signal is false.** `__DEV__` is read during
 *     render by `SignInScreen`'s `devSignInPanel()`, so flipping the global and
 *     mounting is a real exercise of the production gate rather than of a mock.
 *     Deleting that `__DEV__` read kills this test; that mutation is recorded in
 *     `dev-signin-report.md`.
 *  3. **It establishes a session through the same path Apple uses.** The
 *     backend double records every `(idp, idToken, inviteCode)` it is given, so
 *     an implementation that grew a second exchange, dropped the provider, or
 *     let a new account through without a code fails here rather than passing
 *     quietly.
 *
 * `__DEV__` is true under jest-expo, so case 1 and case 3 run against the same
 * gate a simulator does.
 */

import { NavigationContainer } from "@react-navigation/native";
import { render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { memSecretStore } from "@ledger/client/store/store.ts";

import { Navigation } from "../../app/Navigation.tsx";
import { RuntimeProvider } from "../../app/RuntimeProvider.tsx";
import type { AppRuntime } from "../../app/runtime.ts";
import { ThemeProvider, INPUT_FONT_MIN, TOUCH_TARGET_MIN } from "../../app/Theme.tsx";
import { DEV_SUBJECT_DEFAULT, DEV_TOKEN_PREFIX } from "../../auth/devAuth.ts";
import { IDP_APPLE, type IdpAuthenticator } from "../../auth/idp.ts";
import type { SignInDeps } from "../../auth/native.ts";
import type { ExchangeBackend } from "../../auth/session.ts";
import { SignInScreen } from "./SignInScreen.tsx";

/**
 * Apple's native module, and only that. jest cannot open Apple's sheet, and
 * `deviceSignInDeps` calls `AppleAuthentication.isAvailableAsync()` on mount.
 * Everything else in `auth/native.ts` — the Keychain seam included — stays real,
 * so the navigator below is composed exactly as production composes it.
 */
jest.mock("../../auth/native.ts", () => {
  const actual = jest.requireActual("../../auth/native.ts") as typeof import("../../auth/native.ts");
  return {
    ...actual,
    deviceSignInDeps: (options: Parameters<typeof actual.deviceSignInDeps>[0]) => ({
      ...actual.deviceSignInDeps(options),
      apple: { idp: "apple" as const, isAvailable: async () => true, authenticate: async () => ({ idToken: "unused", email: null }) },
    }),
  };
});

/** Never called by these tests — the dev path must not touch a provider. */
function unusedAuthenticator(): IdpAuthenticator {
  return {
    idp: IDP_APPLE,
    isAvailable: async () => true,
    authenticate: async () => {
      throw new Error("the dev sign-in path must not open a provider sheet");
    },
  };
}

interface Attempt {
  idp: string;
  idToken: string;
  inviteCode: string | undefined;
}

function recordingBackend(answer: (a: Attempt) => Promise<string>): ExchangeBackend & { attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  return {
    attempts,
    login(idp: string, idToken: string, inviteCode?: string) {
      const attempt: Attempt = { idp, idToken, inviteCode };
      attempts.push(attempt);
      return answer(attempt);
    },
  };
}

function deps(overrides: Partial<SignInDeps> = {}): SignInDeps {
  return {
    apple: unusedAuthenticator(),
    google: null,
    backend: null,
    enrollDevice: null,
    secrets: memSecretStore(),
    newNonce: () => "unused",
    ...overrides,
  };
}

function renderScreen(d: SignInDeps, onSignedIn: (u: string | null) => void = () => {}) {
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <ThemeProvider>
        <SignInScreen deps={d} onSignedIn={onSignedIn} />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

function flatStyle(node: { props: Record<string, unknown> }): Record<string, number> {
  const style = node.props["style"];
  return (Array.isArray(style) ? Object.assign({}, ...style) : style) as Record<string, number>;
}

function apiError(status: number, code: string): Error & { status: number; code: string } {
  return Object.assign(new Error(`${status} ${code}`), { status, code });
}

describe("the development sign-in affordance", () => {
  it("is on the glass in a development build, next to the real providers and not instead of them", async () => {
    await renderScreen(deps({ backend: recordingBackend(async () => "u-dev") }));
    expect(screen.getByTestId("dev-sign-in")).toBeTruthy();
    expect(screen.getByTestId("dev-sign-in-subject")).toBeTruthy();
    // The real path is untouched and still the primary one.
    expect(screen.getByTestId("sign-in-apple")).toBeTruthy();
    expect(screen.getByTestId("sign-in-apple").props.accessibilityState.disabled).toBe(false);
  });

  it("clears the mobile floors: a 44pt button and a 16px field", async () => {
    await renderScreen(deps({ backend: recordingBackend(async () => "u-dev") }));
    expect(flatStyle(screen.getByTestId("dev-sign-in")).minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
    const field = flatStyle(screen.getByTestId("dev-sign-in-subject"));
    expect(field.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
    expect(field.fontSize).toBeGreaterThanOrEqual(INPUT_FONT_MIN);
  });

  /**
   * The gate, exercised in the direction that matters.
   *
   * `__DEV__` is read inside `SignInScreen`'s render, so this is the production
   * expression running with the production value a release bundle would carry —
   * not a stub, not a prop, not a mock of the panel.
   */
  it("is absent — control, field and marker — when __DEV__ is false", async () => {
    const globals = globalThis as unknown as { __DEV__: boolean };
    const previous = globals.__DEV__;
    globals.__DEV__ = false;
    try {
      await renderScreen(deps({ backend: recordingBackend(async () => "u-dev") }));
      expect(screen.queryByTestId("dev-sign-in")).toBeNull();
      expect(screen.queryByTestId("dev-sign-in-subject")).toBeNull();
      expect(screen.queryByTestId("dev-sign-in-panel")).toBeNull();
      expect(screen.queryByTestId("dev-sign-in-marker")).toBeNull();
      // And the screen is otherwise entirely itself: this gate removes the dev
      // path and nothing else.
      expect(screen.getByTestId("sign-in-apple")).toBeTruthy();
      expect(screen.getByTestId("sign-in-google")).toBeTruthy();
    } finally {
      globals.__DEV__ = previous;
    }
  });

  it("signs in through the ordinary exchange, as apple, with a dev: identity and no invite code", async () => {
    const backend = recordingBackend(async () => "u-dev");
    const signedIn: (string | null)[] = [];
    await renderScreen(deps({ backend }), (u) => signedIn.push(u));

    await userEvent.press(screen.getByTestId("dev-sign-in"));

    await waitFor(() => expect(signedIn).toEqual(["u-dev"]));
    expect(backend.attempts).toEqual([
      { idp: IDP_APPLE, idToken: `${DEV_TOKEN_PREFIX}${DEV_SUBJECT_DEFAULT}`, inviteCode: undefined },
    ]);
  });

  it("a typed subject is the identity that is sent — two subjects are two accounts", async () => {
    const backend = recordingBackend(async () => "u-bob");
    await renderScreen(deps({ backend }));

    await userEvent.clear(screen.getByTestId("dev-sign-in-subject"));
    await userEvent.type(screen.getByTestId("dev-sign-in-subject"), "bob");
    await userEvent.press(screen.getByTestId("dev-sign-in"));

    await waitFor(() => expect(backend.attempts.length).toBe(1));
    expect(backend.attempts[0]?.idToken).toBe(`${DEV_TOKEN_PREFIX}bob`);
    expect(backend.attempts[0]?.idToken).not.toBe(`${DEV_TOKEN_PREFIX}${DEV_SUBJECT_DEFAULT}`);
  });

  /**
   * The property this task is most likely to have broken silently: a dev
   * sign-in is a different *identity*, not a way past the closed beta.
   */
  it("still has to produce an invite code to create an account", async () => {
    const backend = recordingBackend(async (a) => {
      if (a.inviteCode === undefined) throw apiError(403, "not_invited");
      if (a.inviteCode !== "GOOD") throw apiError(403, "not_invited");
      return "u-new";
    });
    const signedIn: (string | null)[] = [];
    await renderScreen(deps({ backend }), (u) => signedIn.push(u));

    await userEvent.press(screen.getByTestId("dev-sign-in"));

    // The real invite screen, reached by the real reducer transition.
    const field = await screen.findByTestId("invite-code");
    expect(field.props.value).toBe("");
    expect(screen.queryByTestId("dev-sign-in")).toBeNull();

    await userEvent.type(field, "GOOD");
    await userEvent.press(screen.getByTestId("invite-submit"));

    await waitFor(() => expect(signedIn).toEqual(["u-new"]));
    expect(backend.attempts.map((a) => a.inviteCode)).toEqual([undefined, "GOOD"]);
    // The same identity across both attempts — the retry did not silently
    // become a different account.
    expect(new Set(backend.attempts.map((a) => a.idToken))).toEqual(
      new Set([`${DEV_TOKEN_PREFIX}${DEV_SUBJECT_DEFAULT}`]),
    );
  });

  it("refuses a subject the server would reject, without sending it", async () => {
    const backend = recordingBackend(async () => "u-dev");
    await renderScreen(deps({ backend }));

    await userEvent.clear(screen.getByTestId("dev-sign-in-subject"));
    await userEvent.type(screen.getByTestId("dev-sign-in-subject"), "a|b");

    expect(screen.getByTestId("dev-sign-in-error")).toBeTruthy();
    expect(screen.getByTestId("dev-sign-in").props.accessibilityState.disabled).toBe(true);
    await userEvent.press(screen.getByTestId("dev-sign-in"));
    expect(backend.attempts).toEqual([]);
  });

  it("is offered but inert while the build has no server, exactly like the real providers", async () => {
    await renderScreen(deps());
    expect(screen.getByTestId("no-server")).toBeTruthy();
    expect(screen.getByTestId("dev-sign-in").props.accessibilityState.disabled).toBe(true);
  });
});

/**
 * The wiring, through the app's own navigator rather than through a hand-mounted
 * screen.
 *
 * Every test above renders `SignInScreen` directly, which proves the control
 * works and proves nothing about whether the *app* puts it anywhere. That gap is
 * the shape AGENT-RULES calls "written, tested green, never wired" — six
 * instances on this project — so the initial route is mounted the way
 * `Root.tsx` mounts it, with the real `deviceSignInDeps`, and the control is
 * looked for on the glass.
 */
describe("the app's initial route", () => {
  it("puts the developer sign-in on the screen a launch actually lands on", async () => {
    const runtime = {
      server: "https://ledger.test",
      secrets: memSecretStore(),
      client: { login: async () => "u-1" },
      dispose: async () => {},
    } as unknown as AppRuntime;
    const mounted = await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <ThemeProvider>
          <NavigationContainer>
            <RuntimeProvider runtime={runtime} bootstrapper={async () => ({ step: "signed_out" } as const)}>
              <Navigation />
            </RuntimeProvider>
          </NavigationContainer>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("sign-in-apple")).toBeTruthy());
    expect(screen.getByTestId("dev-sign-in")).toBeTruthy();
    // And it is live, because the navigator hands the screen a real backend —
    // the `no-server` state would disable it.
    expect(screen.queryByTestId("no-server")).toBeNull();
    expect(screen.getByTestId("dev-sign-in").props.accessibilityState.disabled).toBe(false);
    await mounted.unmount();
  });
});
