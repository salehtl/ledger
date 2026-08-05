/**
 * The three destructive/settings entry points, pressed for real.
 *
 * `RuntimeNavigation.rn-test.tsx` walks Currencies, Reprocess, Budget and
 * Import. Export, Security and Delete account were reachable only on paper:
 * the route table listed them and a source-reading test confirmed the props
 * were passed, which is the "written, tested green, never wired" shape one
 * refactor away from being false again. Everything below presses the control a
 * user presses and then observes the RUNTIME dependency behind it -
 * `runtime.db` for export, `runtime.deviceIdentity()` for security, and for
 * deletion the wipe counter and where the navigator ends up.
 *
 * The deletion cases are the point of this file. `410 account_deleted` and a
 * plain `401` are the pair the plan calls a data-loss footgun, and they are
 * asserted here through the real composition - real screen, real
 * `deleteAccount`, real navigator - because the defect they had was in the
 * composition and not in any one of those parts.
 */

import { NavigationContainer } from "@react-navigation/native";
import { Pressable, Text } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import { SECRET_WRITER_ID } from "../auth/keys.ts";
import { toBase64 } from "../platform/bytes.ts";
import { Navigation } from "./Navigation.tsx";
import { RuntimeProvider, useAccountWipe } from "./RuntimeProvider.tsx";
import { ThemeProvider } from "./Theme.tsx";
import { deletionResultCopy } from "../account/deletion.ts";
import type { AppRuntime } from "./runtime.ts";

/**
 * The Apple authenticator, and ONLY the Apple authenticator.
 *
 * Deletion carries three factors (spec 3.4), and the third is a fresh IdP
 * credential. A `410` on the challenge short-circuits before that round trip,
 * which is why the 410 case below needs no mock — but the `204` case, the one a
 * user reaches deliberately, does, and jest cannot open Apple's sheet. Only the
 * authenticator is replaced: `deviceSignInDeps` is otherwise the real one, so
 * the Keychain seam, the nonce and the signature over `deletionMessage` are all
 * still the production code paths.
 */
jest.mock("../auth/native.ts", () => {
  const actual = jest.requireActual("../auth/native.ts") as typeof import("../auth/native.ts");
  return {
    ...actual,
    deviceSignInDeps: (options: Parameters<typeof actual.deviceSignInDeps>[0]) => ({
      ...actual.deviceSignInDeps(options),
      apple: { idp: "apple" as const, isAvailable: async () => true, authenticate: async () => ({ idToken: "fresh-apple-token", email: null }) },
    }),
  };
});

const USER = "123e4567-e89b-42d3-a456-426614174000";
const SEED = toBase64(new Uint8Array(32).fill(7));
const FINGERPRINT = "AB12 CD34 EF56 7890";

/**
 * Enough Keychain material for `deleteAccount` to get as far as the network,
 * and a `purge` that removes exactly what production's `keychainNames` removes
 * - the session token included. A fake that kept the token through a wipe
 * would hide the difference between a device that was erased and one that was
 * not, which is the difference these tests exist to measure.
 */
function fakeSecrets() {
  const values = new Map<string, string>([[SECRET_SESSION, "held"], [SECRET_WRITER_ID, "phone"], [`${SECRET_WRITER}phone`, SEED]]);
  return {
    held: () => values.size,
    purge: () => { values.clear(); },
    store: { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string | null) => { if (value === null) values.delete(key); else values.set(key, value); } },
  };
}

function sqlSpy() {
  const statements: string[] = [];
  const db = { location: "spy", exec: () => {}, prepare: (sql: string) => { statements.push(sql); return { all: () => [], run: () => {}, get: () => null }; }, transaction: <T,>(fn: () => T) => fn(), close: () => {} };
  return { statements, db };
}

function makeRuntime(secrets: ReturnType<typeof fakeSecrets>["store"], over: Partial<AppRuntime> = {}) {
  const txns = {
    list: () => ({ rows: [], next: null }), read: () => null, forks: () => [], facets: () => ({ categories: [], currencies: [] }),
    homeCurrency: () => "AED", edit: () => ({ ok: true, changed: false } as const), split: () => ({ ok: true, changed: false } as const),
    recomputeHome: () => ({ ok: false, error: "missing" } as const),
  };
  return {
    server: "https://ledger.test", secrets, txns,
    client: { sessionToken: "held", userId: USER },
    store: { load: () => ({ userId: USER }) },
    deviceIdentity: () => ({ writerId: "phone", fingerprint: FINGERPRINT }),
    dispose: async () => {}, wipeAccount: async () => {},
    ...over,
  } as unknown as AppRuntime;
}

async function mount(runtime: AppRuntime) {
  const bootstrapper = async () => ({ step: "ready", userId: USER, facts: { inboundAddress: "u@in.example", firstMailConfirmedAt: "2026-08-03T00:00:00Z", homeCurrency: "AED" } } as const);
  const mounted = await render(
    <ThemeProvider>
      <NavigationContainer>
        <RuntimeProvider runtime={runtime} bootstrapper={bootstrapper}>
          <Navigation />
        </RuntimeProvider>
      </NavigationContainer>
    </ThemeProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("txn-search")).toBeTruthy());
  return mounted;
}

/** `deleteAccount` uses the global fetch; these are the only answers it needs. */
function serveDeletion(answers: { ok: boolean; status: number; body: unknown }[]) {
  const urls: string[] = [];
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const a = answers[Math.min(call++, answers.length - 1)]!;
    return { ok: a.ok, status: a.status, json: async () => a.body } as unknown as Response;
  }) as typeof fetch;
  return urls;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

it("Export is reachable and runs against the runtime's own database", async () => {
  const spy = sqlSpy();
  const mounted = await mount(makeRuntime(fakeSecrets().store, { db: spy.db as unknown as AppRuntime["db"] }));
  fireEvent.press(screen.getByTestId("open-export"));
  await waitFor(() => expect(screen.getByTestId("export-screen")).toBeTruthy());
  fireEvent.press(screen.getByText("Create and share export"));
  // The projection this stub reports is empty, so the export refuses - which is
  // the honest answer AND proof the press reached `runtime.db` rather than a
  // screen wired to nothing.
  await waitFor(() => expect(screen.getByText("Export failed. Your ledger was not changed.")).toBeTruthy());
  expect(spy.statements.some((sql) => sql.includes("projection_meta"))).toBe(true);
  await mounted.unmount();
});

it("Security is reachable and shows this device's real key fingerprint", async () => {
  const mounted = await mount(makeRuntime(fakeSecrets().store));
  fireEvent.press(screen.getByTestId("open-security"));
  await waitFor(() => expect(screen.getByTestId("security-screen")).toBeTruthy());
  expect(screen.getByText(FINGERPRINT)).toBeTruthy();
  expect(screen.getByText("Writer phone")).toBeTruthy();
  await mounted.unmount();
});

it("410 account_deleted wipes this device AND leaves the signed-in graph", async () => {
  let wipes = 0;
  const secrets = fakeSecrets();
  const urls = serveDeletion([{ ok: false, status: 410, body: { error: "account_deleted" } }]);
  const mounted = await mount(makeRuntime(secrets.store, { wipeAccount: async () => { wipes++; secrets.purge(); } }));
  fireEvent.press(screen.getByTestId("open-delete-account"));
  await waitFor(() => expect(screen.getByTestId("delete-account-screen")).toBeTruthy());
  fireEvent.press(screen.getByText("Continue to delete"));
  await waitFor(() => expect(screen.getByText("Delete my account permanently")).toBeTruthy());
  fireEvent.press(screen.getByText("Delete my account permanently"));
  await waitFor(() => expect(screen.getByTestId("sign-in-apple")).toBeTruthy());
  expect(wipes).toBe(1);
  expect(secrets.held()).toBe(0);
  expect(screen.queryByTestId("delete-account-screen")).toBeNull();
  expect(urls[0]).toContain("/api/v1/account/challenge");

  // AND the user is told what happened, ON THE SCREEN THEY ENDED UP ON.
  // `deletionResultCopy`'s 410 sentence used to be set on `DeleteAccountScreen`
  // AFTER `navigation.reset` had unmounted it, so it rendered nowhere at all:
  // the truthful copy was real and invisible, and pressing "Delete my account
  // permanently" dropped the user at sign-in with no confirmation of anything.
  // Asserted from the tree after the reset, not from a setter having been
  // called.
  const notice = screen.getByTestId("sign-in-notice");
  expect(String(notice.props.children ?? "")).toBeTruthy();
  expect(screen.getByText(deletionResultCopy({ outcome: "already_deleted", wiped: true }).body)).toBeTruthy();
  await mounted.unmount();
});

/**
 * The other erasing ending, and the one a user actually reaches on purpose.
 *
 * A `204` is the deliberate deletion. It has the same shape of defect as the
 * 410 above — reset first, copy second, copy never seen — so it is asserted the
 * same way: the sentence is read out of the rendered tree AFTER the navigator
 * has thrown the delete screen away.
 */
it("a 204 wipes, leaves the signed-in graph, and CONFIRMS it on the screen the user lands on", async () => {
  let wipes = 0;
  const secrets = fakeSecrets();
  serveDeletion([{ ok: true, status: 200, body: { nonce: btoa(String.fromCharCode(...new Uint8Array(32))) } }, { ok: true, status: 204, body: null }]);
  const mounted = await mount(makeRuntime(secrets.store, { wipeAccount: async () => { wipes++; secrets.purge(); } }));
  fireEvent.press(screen.getByTestId("open-delete-account"));
  await waitFor(() => expect(screen.getByTestId("delete-account-screen")).toBeTruthy());
  fireEvent.press(screen.getByText("Continue to delete"));
  await waitFor(() => expect(screen.getByText("Delete my account permanently")).toBeTruthy());
  fireEvent.press(screen.getByText("Delete my account permanently"));

  await waitFor(() => expect(screen.getByTestId("sign-in-apple")).toBeTruthy());
  expect(wipes).toBe(1);
  expect(screen.queryByTestId("delete-account-screen")).toBeNull();
  const said = screen.getByText(deletionResultCopy({ outcome: "deleted", wiped: true }).body);
  expect(said).toBeTruthy();
  // The 204 sentence, not the 410 one: they are different facts and the user is
  // owed the one that happened.
  expect(screen.queryByText(deletionResultCopy({ outcome: "already_deleted", wiped: true }).body)).toBeNull();
  await mounted.unmount();
});

/**
 * The wipe itself failing after the server confirmed.
 *
 * `wipeAccount()` closes the driver, deletes the database file and purges the
 * Keychain; any of the three can reject. That rejection used to travel as a
 * plain error into `deletionFailureCopy`'s fallthrough, which says "Your
 * account was not deleted. Your data remains on this device." — both false. The
 * account is gone and the local copy is in an unknown state, and the user has
 * something to do about it.
 */
it("a wipe that throws after a 204 says the account IS gone and this device may not be clean", async () => {
  const secrets = fakeSecrets();
  serveDeletion([{ ok: true, status: 200, body: { nonce: btoa(String.fromCharCode(...new Uint8Array(32))) } }, { ok: true, status: 204, body: null }]);
  const mounted = await mount(makeRuntime(secrets.store, { wipeAccount: async () => { throw new Error("database file is locked"); } }));
  fireEvent.press(screen.getByTestId("open-delete-account"));
  await waitFor(() => expect(screen.getByTestId("delete-account-screen")).toBeTruthy());
  fireEvent.press(screen.getByText("Continue to delete"));
  await waitFor(() => expect(screen.getByText("Delete my account permanently")).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByText("Delete my account permanently")); });

  // The reset is skipped, correctly: this device is not clean, so the user has
  // to see the message rather than be swept to sign-in.
  await waitFor(() => expect(screen.getByTestId("delete-account-notice")).toBeTruthy());
  expect(screen.getByTestId("delete-account-screen")).toBeTruthy();
  const said = String(screen.getByTestId("delete-account-notice").props.children);
  expect(said).toMatch(/Your account is deleted/);
  expect(said).toMatch(/reinstall/);
  // The two false claims the fallthrough used to make.
  expect(said).not.toMatch(/was not deleted/);
  expect(said).not.toMatch(/Your data remains on this device/);
  await mounted.unmount();
});

it("a plain 401 keeps every local row, stays put, and says so", async () => {
  let wipes = 0;
  const secrets = fakeSecrets();
  serveDeletion([{ ok: false, status: 401, body: { error: "unauthorized" } }]);
  const mounted = await mount(makeRuntime(secrets.store, { wipeAccount: async () => { wipes++; secrets.purge(); } }));
  fireEvent.press(screen.getByTestId("open-delete-account"));
  await waitFor(() => expect(screen.getByTestId("delete-account-screen")).toBeTruthy());
  fireEvent.press(screen.getByText("Continue to delete"));
  await waitFor(() => expect(screen.getByText("Delete my account permanently")).toBeTruthy());
  // Inside `act`: the rejection lands in a microtask that sets state, and a
  // bare press would report it as an update outside act.
  await act(async () => { fireEvent.press(screen.getByText("Delete my account permanently")); });
  await waitFor(() => expect(screen.getByTestId("delete-account-notice")).toBeTruthy());
  expect(wipes).toBe(0);
  expect(secrets.held()).toBe(3);
  expect(screen.getByTestId("delete-account-screen")).toBeTruthy();
  expect(screen.queryByTestId("sign-in-apple")).toBeNull();
  const said = String(screen.getByTestId("delete-account-notice").props.children);
  expect(said).toMatch(/untouched/);
  expect(said).not.toMatch(/has been erased|has now been erased/);
  await mounted.unmount();
});

/**
 * The wipe has to replace the runtime it just killed.
 *
 * `wipeAccount()` closes the shared driver and deletes the database, so the
 * held runtime is unusable afterwards. Bootstrap always replaced it; the
 * deletion route called `runtime.wipeAccount()` straight through and did not,
 * which left the sign-in screen it returns to holding a closed driver. One
 * wipe path now, and this is the test that says the replacement happens.
 */
it("an account wipe replaces the dead runtime", async () => {
  let built = 0;
  let wipes = 0;
  const factory = () => { built++; return { wipeAccount: async () => { wipes++; }, dispose: async () => {} } as unknown as AppRuntime; };
  const bootstrapper = async () => ({ step: "signed_out" } as const);
  function Wiper() {
    const wipe = useAccountWipe();
    return <Pressable testID="wipe" accessibilityRole="button" onPress={() => void wipe()}><Text>wipe</Text></Pressable>;
  }
  const mounted = await render(<RuntimeProvider factory={factory} bootstrapper={bootstrapper}><Wiper /></RuntimeProvider>);
  expect(built).toBe(1);
  fireEvent.press(screen.getByTestId("wipe"));
  await waitFor(() => expect(wipes).toBe(1));
  await waitFor(() => expect(built).toBe(2));
  await mounted.unmount();
});
