/**
 * Device enrolment, WIRED — the mounted proof.
 *
 * `auth/enrollment.test.ts` pins what `ensureDeviceWriter` does. That is worth
 * nothing on its own, because `Client.enroll` was correct and tested from the
 * day it was written and was called by nothing in `app/` for eight tasks: a
 * phone signed in, stored a session, and then could not author a single op.
 * Every write path reads `Client.writerId`, which threw, and the launch after
 * signing in landed on the full-screen "could not safely open this account"
 * wall carrying the words `run cli enroll --writer <id>`.
 *
 * So nothing below stubs `runtime.ensureDeviceWriter`. Each case builds the
 * REAL runtime graph (`createRuntime` — real `sqliteStore`, real `Client`,
 * real `Outbox`) over an in-memory SQL driver and a fake server, mounts the
 * REAL `Navigation` inside the REAL `RuntimeProvider`, and then either presses
 * "Sign in with Apple" or lets launch bootstrap run. What is asserted is what
 * a device ends up holding: a row in the server's roster, a private seed in
 * the Keychain under the name `account/deletion.ts` and `account/address.ts`
 * read, and a `Client.writerId` that answers instead of throwing.
 */

import { NavigationContainer } from "@react-navigation/native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import { SECRET_SESSION, SECRET_WRITER, sqliteStore } from "@ledger/client/store/sqlite.ts";
import { emptyClientState } from "@ledger/client/store/store.ts";
import type { SqlDriver, SqlStatement } from "@ledger/client/store/driver.ts";

import { SECRET_WRITER_ID } from "../auth/keys.ts";
import { toBase64 } from "../platform/bytes.ts";
import { bootstrapRuntime } from "./bootstrap.ts";
import { createRuntime, type AppRuntime } from "./runtime.ts";
import { Navigation } from "./Navigation.tsx";
import { RuntimeProvider } from "./RuntimeProvider.tsx";
import { ThemeProvider } from "./Theme.tsx";

const SERVER = "https://ledger.test";
const USER = "123e4567-e89b-42d3-a456-426614174000";

/**
 * The real `deviceSignInDeps`, with only Apple's sheet replaced.
 *
 * `enrollDevice` is deliberately NOT replaced: it is the seam this file
 * exists to prove is connected, so the mock spreads the production object and
 * overrides one field. The returned id token is a real compact JWS carrying
 * the nonce claim Apple would carry, so `runIdpFlow`'s `checkNonceClaim` runs
 * for real.
 */
jest.mock("../auth/native.ts", () => {
  const actual = jest.requireActual("../auth/native.ts") as typeof import("../auth/native.ts");
  const idp = jest.requireActual("../auth/idp.ts") as typeof import("../auth/idp.ts");
  const bytes = jest.requireActual("../platform/bytes.ts") as typeof import("../platform/bytes.ts");
  const b64url = (s: string) =>
    bytes.toBase64(bytes.utf8Encode(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return {
    ...actual,
    deviceSignInDeps: (options: Parameters<typeof actual.deviceSignInDeps>[0]) => ({
      ...actual.deviceSignInDeps(options),
      apple: {
        idp: idp.IDP_APPLE,
        isAvailable: async () => true,
        authenticate: async (nonce: string) => ({
          idToken: `${b64url(JSON.stringify({ alg: "RS256" }))}.${b64url(
            JSON.stringify({ nonce: idp.expectedNonceClaim(idp.IDP_APPLE, nonce), email: "a@b.test" }),
          )}.sig`,
          email: null,
        }),
      },
    }),
  };
});

// ---------------------------------------------------------------------------
// An in-memory SqlDriver
// ---------------------------------------------------------------------------

/**
 * Enough SQLite for `sqliteStore`: the single `client_state` row, and empty
 * answers for every other query. `wire_rows` stays empty, so every fold is
 * over an empty log — which is what a device that has just signed in has.
 */
function memoryDriver(): SqlDriver & { json(): string | undefined } {
  let stateJSON: string | undefined;
  const stmt = (sql: string): SqlStatement => {
    if (sql.startsWith("SELECT json FROM client_state")) {
      return { run: () => {}, all: () => (stateJSON === undefined ? [] : [{ json: stateJSON }]) };
    }
    if (sql.startsWith("INSERT INTO client_state")) {
      return { run: (...args: unknown[]) => { stateJSON = args[0] as string; }, all: () => [] };
    }
    return { run: () => {}, all: () => [] };
  };
  return {
    location: "memory",
    exec: () => {},
    prepare: stmt,
    transaction: <T,>(fn: () => T): T => fn(),
    close: () => {},
    json: () => stateJSON,
  };
}

function memorySecrets(initial: Iterable<readonly [string, string]> = []) {
  const values = new Map<string, string>(initial);
  return {
    values,
    store: {
      get: (k: string) => values.get(k) ?? null,
      set: (k: string, v: string | null) => { if (v === null) values.delete(k); else values.set(k, v); },
    },
  };
}

// ---------------------------------------------------------------------------
// A fake server
// ---------------------------------------------------------------------------

interface Call { method: string; path: string; body: unknown }

function server(over: { roster?: () => unknown; failEnrolment?: () => boolean } = {}) {
  const calls: Call[] = [];
  const registered: { writer_id: string; pubkey: string }[] = [];
  let nonce = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // `Client.request` passes (url, init); `account/address.ts` and friends
    // pass a `Request`. Both shapes reach here.
    const asRequest = typeof input === "object" && input !== null && "url" in input ? (input as Request) : null;
    const url = asRequest === null ? String(input) : asRequest.url;
    const path = url.startsWith(SERVER) ? url.slice(SERVER.length) : url;
    const method = init?.method ?? asRequest?.method ?? "GET";
    const raw = init?.body ?? null;
    const body: unknown = raw === null ? undefined : JSON.parse(String(raw));
    calls.push({ method, path, body });
    const answer = (status: number, payload: unknown) => ({
      ok: status < 400,
      status,
      text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
      json: async () => payload ?? {},
    }) as unknown as Response;

    if (path === "/api/v1/auth/exchange") return answer(200, { user_id: USER, session_token: "session-token" });
    if (path.startsWith("/api/v1/writers/challenge")) {
      if (over.failEnrolment?.() === true) throw new TypeError("Network request failed");
      nonce += 1;
      return answer(200, { nonce: toBase64(new Uint8Array(32).fill(nonce)) });
    }
    if (path.startsWith("/api/v1/writers/register")) {
      const b = body as { writer_id: string; pubkey: string };
      if (registered.some((w) => w.writer_id === b.writer_id)) {
        return answer(403, { error: "registration_rejected" });
      }
      registered.push({ writer_id: b.writer_id, pubkey: b.pubkey });
      return answer(204, undefined);
    }
    if (path === "/api/v1/writers") {
      if (over.failEnrolment?.() === true) throw new TypeError("Network request failed");
      const rows = over.roster?.() ?? registered.map((w) => ({ ...w, kind: "device", revoked_at: null }));
      return answer(200, { writers: rows });
    }
    if (path.startsWith("/api/v1/address")) {
      return answer(200, { address: "abc@in.example", created_at: "2026-08-05T00:00:00Z" });
    }
    // Sync, dictionary, templates, quarantine: not what this file measures, and
    // bootstrap already treats each of their failures correctly.
    return answer(503, { error: "unavailable" });
  }) as typeof fetch;
  return { calls, registered, fetch: fetchImpl };
}

// ---------------------------------------------------------------------------

let live: AppRuntime | null = null;

afterEach(async () => {
  await live?.dispose();
  live = null;
});

function build(opts: {
  secrets: ReturnType<typeof memorySecrets>;
  fetch: typeof fetch;
  driver?: ReturnType<typeof memoryDriver>;
}) {
  const driver = opts.driver ?? memoryDriver();
  const runtime = createRuntime({
    server: SERVER,
    openDriver: () => driver,
    secrets: opts.secrets.store,
    fetch: opts.fetch,
  });
  live = runtime;
  return { runtime, driver };
}

/**
 * The launch sync is stubbed at `bootstrapRuntime`'s own `refresh` seam so the
 * fake server does not have to serve the whole `/api/v1/sync` protocol.
 * Everything this file measures — `ensureDeviceWriter` and its classification
 * — happens before that call and is the real thing.
 */
function mount(runtime: AppRuntime) {
  return render(
    <ThemeProvider>
      <NavigationContainer>
        <RuntimeProvider
          runtime={runtime}
          bootstrapper={(rt, deps) => bootstrapRuntime(rt, { ...deps, refresh: async () => {} })}
        >
          <Navigation />
        </RuntimeProvider>
      </NavigationContainer>
    </ThemeProvider>,
  );
}

/** A device that has signed in before: a persisted state row and a token. */
function seedSignedIn(driver: SqlDriver, secrets: ReturnType<typeof memorySecrets>) {
  const store = sqliteStore(driver, { secrets: secrets.store, server: SERVER });
  store.save({ ...emptyClientState(SERVER), userId: USER, sessionToken: "session-token" });
}

const registrations = (s: ReturnType<typeof server>) =>
  s.calls.filter((c) => c.path.startsWith("/api/v1/writers/register"));

// ---------------------------------------------------------------------------

describe("signing in on this device enrols it", () => {
  test("pressing Sign in with Apple leaves the device able to author", async () => {
    const s = server();
    const secrets = memorySecrets();
    const { runtime } = build({ secrets, fetch: s.fetch });
    await mount(runtime);

    await waitFor(() => expect(screen.getByTestId("sign-in-apple")).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId("sign-in-apple")); });
    await waitFor(() => expect(registrations(s)).toHaveLength(1));

    const writerId = secrets.store.get(SECRET_WRITER_ID);
    expect(writerId).not.toBeNull();
    // The registration the server saw names the id the Keychain holds.
    expect((registrations(s)[0]?.body as { writer_id: string }).writer_id).toBe(writerId as string);
    // The private seed lands under the name `account/deletion.ts:91` and
    // `account/address.ts:177` read it back from. A key stored anywhere else
    // is an account that cannot be deleted and an address that cannot rotate.
    const seed = secrets.store.get(`${SECRET_WRITER}${writerId as string}`);
    expect(typeof seed).toBe("string");
    expect(seed).not.toBe("");
    expect(secrets.store.get(SECRET_SESSION)).toBe("session-token");
    // The getter that used to throw "no writer selected: run `cli enroll`".
    expect(runtime.client.writerId).toBe(writerId as string);
    // And what `SecurityScreen` renders comes out non-null.
    expect(runtime.deviceIdentity()?.writerId).toBe(writerId as string);
  });

  /**
   * The sign-in screen must not walk a user into an account they cannot write
   * to. The exchange succeeds here — the session token IS stored — and only
   * enrolment fails, so the only thing that can hold the line is that
   * `exchanged` is dispatched after enrolment rather than before it.
   */
  test("a failed enrolment keeps the user on sign-in, with a true sentence", async () => {
    let offline = true;
    const s = server({ failEnrolment: () => offline });
    const secrets = memorySecrets();
    const { runtime } = build({ secrets, fetch: s.fetch });
    await mount(runtime);

    await waitFor(() => expect(screen.getByTestId("sign-in-apple")).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByTestId("sign-in-apple")); });
    await waitFor(() => expect(screen.getByTestId("sign-in-failure")).toBeTruthy());

    expect(screen.getByTestId("sign-in-failure")).toBeTruthy();
    expect(screen.getByText(/could not finish setting up this phone/i)).toBeTruthy();
    // It must not claim the sign-in failed, because it did not.
    expect(screen.queryByText("Sign-in failed")).toBeNull();
    expect(screen.queryByText(/--writer|\bcli\b/i)).toBeNull();
    expect(registrations(s)).toHaveLength(0);
    // Still on sign-in: the provider buttons are there to press again.
    expect(screen.getByTestId("sign-in-apple")).toBeTruthy();

    // Pressing again after the connection comes back finishes the job, and
    // enrols ONE writer rather than a second.
    offline = false;
    await act(async () => { fireEvent.press(screen.getByTestId("sign-in-apple")); });
    await waitFor(() => expect(registrations(s)).toHaveLength(1));
    expect(runtime.client.writerId).toBe(secrets.store.get(SECRET_WRITER_ID) as string);
  });
});

describe("launching an already signed-in device enrols it", () => {
  test("a device that signed in before enrolment existed is enrolled at launch", async () => {
    const s = server();
    const secrets = memorySecrets();
    const driver = memoryDriver();
    seedSignedIn(driver, secrets);
    const { runtime } = build({ secrets, fetch: s.fetch, driver });
    // The state this defect actually produced: a session, and no writer.
    expect(() => runtime.client.writerId).toThrow(/not set up to make changes/);

    await mount(runtime);
    await waitFor(() => expect(registrations(s)).toHaveLength(1));
    expect(runtime.client.writerId).toBe(secrets.store.get(SECRET_WRITER_ID) as string);
    // Not the wall.
    expect(screen.queryByTestId("bootstrap-fatal")).toBeNull();
    expect(screen.queryByTestId("bootstrap-unenrolled")).toBeNull();
  });

  /**
   * Two launches, because one cannot tell "enrols once" from "enrols". A
   * second registration for the same account is a permanently polluted
   * append-only roster.
   */
  test("relaunching does not enrol a second writer", async () => {
    const s = server();
    const secrets = memorySecrets();
    const driver = memoryDriver();
    seedSignedIn(driver, secrets);

    const first = build({ secrets, fetch: s.fetch, driver });
    const view = await mount(first.runtime);
    await waitFor(() => expect(registrations(s)).toHaveLength(1));
    const writerId = secrets.store.get(SECRET_WRITER_ID);
    view.unmount();
    await first.runtime.dispose();
    live = null;

    const second = build({ secrets, fetch: s.fetch, driver });
    await mount(second.runtime);
    await waitFor(() => expect(second.runtime.client.writerId).toBe(writerId as string));
    expect(registrations(s)).toHaveLength(1);
    // The already-enrolled path is free: it does not even read the roster.
    expect(s.calls.filter((c) => c.path === "/api/v1/writers")).toHaveLength(1);
  });

  /**
   * The window between the server's 204 and `Client.enroll`'s `commit()`.
   * Local state does not know it is enrolled; re-registering would be a
   * permanent 403.
   */
  test("an enrolment the server accepted but this device did not record is adopted, not repeated", async () => {
    const s = server();
    const secrets = memorySecrets();
    const driver = memoryDriver();
    seedSignedIn(driver, secrets);

    const first = build({ secrets, fetch: s.fetch, driver });
    const view = await mount(first.runtime);
    await waitFor(() => expect(registrations(s)).toHaveLength(1));
    const writerId = secrets.store.get(SECRET_WRITER_ID) as string;
    view.unmount();
    await first.runtime.dispose();
    live = null;

    // Roll local selection back, exactly as a crash in that window would.
    const raw = JSON.parse(driver.json() as string) as Record<string, unknown>;
    raw["writer_id"] = null;
    driver.prepare("INSERT INTO client_state").run(JSON.stringify(raw));

    const second = build({ secrets, fetch: s.fetch, driver });
    expect(() => second.runtime.client.writerId).toThrow();
    await mount(second.runtime);
    await waitFor(() => expect(second.runtime.client.writerId).toBe(writerId));
    expect(registrations(s)).toHaveLength(1);
  });
});

describe("the wall a user sees instead of a CLI instruction", () => {
  test("an offline launch enrolment is a recoverable screen, and the retry works", async () => {
    let offline = true;
    const s = server({ failEnrolment: () => offline });
    const secrets = memorySecrets();
    const driver = memoryDriver();
    seedSignedIn(driver, secrets);
    const { runtime } = build({ secrets, fetch: s.fetch, driver });
    await mount(runtime);

    await waitFor(() => expect(screen.getByTestId("bootstrap-unenrolled")).toBeTruthy());
    const rendered = JSON.stringify(screen.toJSON());
    expect(rendered).not.toMatch(/--writer/);
    expect(rendered).not.toMatch(/cli enroll/i);
    expect(rendered).not.toMatch(/could not safely open this account/i);
    expect(screen.queryByTestId("bootstrap-fatal")).toBeNull();

    offline = false;
    await act(async () => { fireEvent.press(screen.getByTestId("enrollment-retry")); });
    await waitFor(() => expect(screen.queryByTestId("bootstrap-unenrolled")).toBeNull());
    expect(registrations(s)).toHaveLength(1);
    expect(runtime.client.writerId).toBe(secrets.store.get(SECRET_WRITER_ID) as string);
  });

  test("a refused registration offers no retry button, because pressing it would fail identically", async () => {
    const s = server({ roster: () => [{ writer_id: "someone-else", kind: "device", revoked_at: null, pubkey: toBase64(new Uint8Array(32).fill(9)) }] });
    const secrets = memorySecrets();
    const driver = memoryDriver();
    seedSignedIn(driver, secrets);
    // The account's TOFU bootstrap is spent: every registration is a bare 403.
    const refusing = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/writers/register")) {
        return Promise.resolve({ ok: false, status: 403, text: async () => JSON.stringify({ error: "registration_rejected" }) } as unknown as Response);
      }
      return s.fetch(input, init);
    }) as typeof fetch;
    const { runtime } = build({ secrets, fetch: refusing, driver });
    await mount(runtime);

    await waitFor(() => expect(screen.getByTestId("bootstrap-unenrolled")).toBeTruthy());
    expect(screen.queryByTestId("enrollment-retry")).toBeNull();
    expect(screen.getByText(/does not say why/i)).toBeTruthy();
    expect(() => runtime.client.writerId).toThrow();
  });
});
