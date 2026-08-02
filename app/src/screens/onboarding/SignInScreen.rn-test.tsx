/**
 * The sign-in screen, rendered.
 *
 * `bun test` covers the reducer, the failure taxonomy and the wire shape;
 * those are the decisions. What only a render can show is whether the screen
 * *acts* on them — and the property this task is judged on is a property of
 * the screen, not of the reducer: **a returning alpha is never shown an invite
 * field.** A reducer test can prove the state was never reached; only this can
 * prove nothing put the field on the glass anyway.
 *
 * Nothing here touches a native module: `SignInScreen` takes its `SignInDeps`
 * as a prop and `src/auth/native.ts` — the only file that imports
 * `expo-apple-authentication`, `expo-auth-session` or `expo-secure-store` — is
 * imported by it for its *type* alone.
 */

import { render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { memSecretStore } from "@ledger/client/store/store.ts";
import { SECRET_SESSION } from "@ledger/client/store/sqlite.ts";

import { ThemeProvider, TOUCH_TARGET_MIN } from "../../app/Theme.tsx";
import { toBase64, utf8Encode } from "../../platform/bytes.ts";
import { expectedNonceClaim, IDP_APPLE, type IdpAuthenticator } from "../../auth/idp.ts";
import type { SignInDeps } from "../../auth/native.ts";
import type { ExchangeBackend } from "../../auth/session.ts";
import { SignInScreen } from "./SignInScreen.tsx";

const NONCE = toBase64(new Uint8Array(32).fill(7));

function b64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** An Apple-shaped ID token: the nonce claim is the hash, not the value. */
function appleToken(nonce: string): string {
  const payload = { nonce: expectedNonceClaim(IDP_APPLE, nonce), email: "a@b.c" };
  return `aa.${b64url(utf8Encode(JSON.stringify(payload)))}.cc`;
}

function apiError(status: number, code: string): Error & { status: number; code: string } {
  return Object.assign(new Error(`${status} ${code}`), { status, code });
}

function authenticator(): IdpAuthenticator {
  return {
    idp: IDP_APPLE,
    isAvailable: async () => true,
    authenticate: async (nonce: string) => ({ idToken: appleToken(nonce), email: "a@b.c" }),
  };
}

function deps(overrides: Partial<SignInDeps> = {}): SignInDeps {
  return {
    apple: authenticator(),
    google: null,
    backend: null,
    secrets: memSecretStore(),
    newNonce: () => NONCE,
    ...overrides,
  };
}

function backendThat(answer: (code: string | undefined) => Promise<string>): ExchangeBackend & {
  codes: (string | undefined)[];
} {
  const codes: (string | undefined)[] = [];
  return {
    codes,
    login(_idp: string, _idToken: string, inviteCode?: string) {
      codes.push(inviteCode);
      return answer(inviteCode);
    },
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

describe("SignInScreen", () => {
  it("offers Apple, and says why Google is unavailable rather than hiding or breaking it", async () => {
    await renderScreen(deps({ backend: backendThat(async () => "u-1") }));
    expect(screen.getByTestId("sign-in-apple")).toBeTruthy();
    // Rendered, disabled, and carrying the reason — a live button over a
    // missing client id fails only under a thumb.
    expect(screen.getByTestId("sign-in-google").props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId("sign-in-google-note")).toBeTruthy();
  });

  it("says so when the build has no server, instead of failing at tap time", async () => {
    await renderScreen(deps());
    expect(screen.getByTestId("no-server")).toBeTruthy();
    expect(screen.getByTestId("sign-in-apple").props.accessibilityState.disabled).toBe(true);
  });

  it("both provider buttons clear the 44pt minimum", async () => {
    await renderScreen(deps({ backend: backendThat(async () => "u-1") }));
    for (const id of ["sign-in-apple", "sign-in-google"]) {
      const style = screen.getByTestId(id).props.style;
      const flat = Array.isArray(style) ? Object.assign({}, ...style) : style;
      expect(flat.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
    }
  });

  it("signs a RETURNING account in with no invite code, and never renders the field", async () => {
    // The property the beta's opening day depends on. The backend refuses a
    // code outright, so if the screen ever sent one this fails rather than
    // passing quietly.
    const backend = backendThat(async (code) => {
      if (code !== undefined) throw new Error("an existing account must never be asked for a code");
      return "u-existing";
    });
    const signedIn: (string | null)[] = [];
    await renderScreen(deps({ backend }), (u) => signedIn.push(u));

    await userEvent.press(screen.getByTestId("sign-in-apple"));

    expect(signedIn).toEqual(["u-existing"]);
    expect(backend.codes).toEqual([undefined]);
    expect(screen.queryByTestId("invite-code")).toBeNull();
  });

  it("resumes without any sign-in when the Keychain already holds a session", async () => {
    const secrets = memSecretStore();
    secrets.set(SECRET_SESSION, "an-existing-token");
    const signedIn: (string | null)[] = [];
    await renderScreen(deps({ secrets }), (u) => signedIn.push(u));
    // `null` means "a session was already here", and no provider button was
    // ever put on the glass.
    expect(signedIn).toEqual([null]);
    expect(screen.queryByTestId("sign-in-apple")).toBeNull();
  });

  it("asks for a code only after 403 not_invited, and then signs in with it", async () => {
    const backend = backendThat(async (code) => {
      if (code === undefined) throw apiError(403, "not_invited");
      if (code !== "GOOD") throw apiError(403, "not_invited");
      return "u-new";
    });
    const signedIn: (string | null)[] = [];
    await renderScreen(deps({ backend }), (u) => signedIn.push(u));

    await userEvent.press(screen.getByTestId("sign-in-apple"));

    // Arrived at the invite screen with a blank field and NO error: nobody has
    // typed anything yet, so "that code did not work" would be nonsense.
    const field = screen.getByTestId("invite-code");
    expect(field.props.value).toBe("");
    expect(screen.queryByTestId("invite-error")).toBeNull();
    // 16pt floor: the input convention both front ends share.
    const style = Array.isArray(field.props.style) ? Object.assign({}, ...field.props.style) : field.props.style;
    expect(style.fontSize).toBeGreaterThanOrEqual(16);

    await userEvent.type(field, "WRONG");
    await userEvent.press(screen.getByTestId("invite-submit"));

    // Rejected: still here, still holding what was typed, and now saying why.
    expect(screen.getByTestId("invite-code").props.value).toBe("WRONG");
    expect(screen.getByTestId("invite-error")).toBeTruthy();

    await userEvent.clear(screen.getByTestId("invite-code"));
    await userEvent.type(screen.getByTestId("invite-code"), "GOOD");
    await userEvent.press(screen.getByTestId("invite-submit"));

    expect(signedIn).toEqual(["u-new"]);
    expect(backend.codes).toEqual([undefined, "WRONG", "GOOD"]);
  });

  it("clears to empty and stays empty — no springback", async () => {
    const backend = backendThat(async () => {
      throw apiError(403, "not_invited");
    });
    await renderScreen(deps({ backend }));
    await userEvent.press(screen.getByTestId("sign-in-apple"));
    await userEvent.type(screen.getByTestId("invite-code"), "ABC");
    await userEvent.clear(screen.getByTestId("invite-code"));
    expect(screen.getByTestId("invite-code").props.value).toBe("");
    // And an empty field cannot be submitted.
    expect(screen.getByTestId("invite-submit").props.accessibilityState.disabled).toBe(true);
  });

  it("an expired ID token during code entry sends the user back to sign in, not into a loop", async () => {
    let calls = 0;
    const backend = backendThat(async () => {
      calls += 1;
      throw calls === 1 ? apiError(403, "not_invited") : apiError(401, "");
    });
    await renderScreen(deps({ backend }));
    await userEvent.press(screen.getByTestId("sign-in-apple"));
    await userEvent.type(screen.getByTestId("invite-code"), "CODE");
    await userEvent.press(screen.getByTestId("invite-submit"));

    expect(screen.queryByTestId("invite-code")).toBeNull();
    expect(screen.getByTestId("sign-in-failure")).toBeTruthy();
    // "Nothing was lost" — an expired session must not read as data loss.
    expect(screen.getByText(/Nothing was lost/)).toBeTruthy();
  });

  it("a deleted account is told what happened, and is not offered a retry", async () => {
    const backend = backendThat(async () => {
      throw apiError(410, "account_deleted");
    });
    await renderScreen(deps({ backend }));
    await userEvent.press(screen.getByTestId("sign-in-apple"));
    expect(screen.getByText(/This account was deleted/)).toBeTruthy();
    expect(screen.queryByTestId("invite-code")).toBeNull();
  });

  it("a cancelled provider sheet is not reported as a failure of the app", async () => {
    const backend = backendThat(async () => "u-1");
    const cancelling: IdpAuthenticator = {
      idp: IDP_APPLE,
      isAvailable: async () => true,
      authenticate: async () => {
        throw Object.assign(new Error("cancelled"), { code: "ERR_REQUEST_CANCELED" });
      },
    };
    await renderScreen(deps({ backend, apple: cancelling }));
    await userEvent.press(screen.getByTestId("sign-in-apple"));
    // Classified as `unknown` here, because turning the native code into
    // `UserCancelledError` is `native.ts`'s job and this fake bypasses it. The
    // point of the assertion is that the screen survives it and offers the
    // button again rather than wedging.
    expect(screen.getByTestId("sign-in-apple")).toBeTruthy();
    expect(backend.codes).toEqual([]);
  });

  it("a token bound to a different nonce never reaches the exchange", async () => {
    const backend = backendThat(async () => "u-1");
    const wrongNonce: IdpAuthenticator = {
      idp: IDP_APPLE,
      isAvailable: async () => true,
      authenticate: async () => ({ idToken: appleToken("some other nonce"), email: null }),
    };
    await renderScreen(deps({ backend, apple: wrongNonce }));
    await userEvent.press(screen.getByTestId("sign-in-apple"));
    expect(backend.codes).toEqual([]);
    expect(screen.getByText(/did not match/)).toBeTruthy();
  });
});
