/**
 * Settings -> Inbound address, pressed for real, including the destructive half.
 *
 * `RuntimeDestructive.rn-test.tsx` is the model: the route table listing a
 * screen and a source-reading test confirming the props proves nothing that
 * survives a refactor. Everything below presses the control a user presses and
 * then observes the dependency behind it - `runtime.address` for the read, and
 * the real `rotateAddress` composition (challenge, provider, signature, rotate)
 * for the write.
 *
 * Apple's native module is mocked because there is no device on this box; the
 * app code under test is not. `rotateAddress`, `rotationMessage`, the Ed25519
 * signature and the request order are all the production ones.
 */

import { NavigationContainer } from "@react-navigation/native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import { SECRET_WRITER_ID } from "../auth/keys.ts";
import { toBase64 } from "../platform/bytes.ts";
import { Navigation } from "./Navigation.tsx";
import { RuntimeProvider } from "./RuntimeProvider.tsx";
import { ThemeProvider } from "./Theme.tsx";
import type { AppRuntime } from "./runtime.ts";

const mockSignIn = jest.fn(async (_options: unknown) => ({ identityToken: "fresh-apple-token", email: null, fullName: null }));
jest.mock("expo-apple-authentication", () => ({
  isAvailableAsync: async () => true,
  signInAsync: (options: unknown) => mockSignIn(options),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

const mockSetString = jest.fn(async (_text: string) => true);
jest.mock("expo-clipboard", () => ({ setStringAsync: (text: string) => mockSetString(text) }));

const USER = "123e4567-e89b-42d3-a456-426614174000";
const OLD = "k7qmz3x9r2w5t8v4n6p1c0abcd@in.example";
const NEW = "z1y2x3w4v5u6t7s8r9q0p1abcd@in.example";
const NONCE = toBase64(new Uint8Array(32).fill(9));

function fakeSecrets() {
  const values = new Map<string, string>([
    [SECRET_SESSION, "held"],
    [SECRET_WRITER_ID, "phone"],
    [`${SECRET_WRITER}phone`, toBase64(new Uint8Array(32).fill(7))],
  ]);
  return { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string | null) => { if (v === null) values.delete(k); else values.set(k, v); } };
}

function makeRuntime() {
  return {
    server: "https://ledger.test",
    secrets: fakeSecrets(),
    client: { sessionToken: "held", userId: USER, state: () => ({ txns: new Map(), homeCurrency: "AED" }) },
    store: { load: () => ({ userId: USER }) },
    address: { current: async () => ({ address: OLD, createdAt: "2026-07-01T00:00:00Z", rotatesFrom: null, graceUntil: null }) },
    txns: {
      list: () => ({ rows: [], next: null }), read: () => null, forks: () => [], facets: () => ({ categories: [], currencies: [] }),
      homeCurrency: () => "AED", edit: () => ({ ok: true, changed: false } as const), split: () => ({ ok: true, changed: false } as const),
      recomputeHome: () => ({ ok: false, error: "missing" } as const),
    },
    deviceIdentity: () => null,
    dispose: async () => {}, wipeAccount: async () => {},
  } as unknown as AppRuntime;
}

/** `rotateAddress` uses the global fetch; these are the only answers it needs. */
function serve(answers: { status: number; body: unknown }[]) {
  const seen: { url: string; method: string; body: unknown }[] = [];
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const raw = await request.text();
    seen.push({ url: request.url, method: request.method, body: raw === "" ? null : JSON.parse(raw) });
    const a = answers[Math.min(call++, answers.length - 1)] as { status: number; body: unknown };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body } as unknown as Response;
  }) as typeof fetch;
  return seen;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function openAddressScreen() {
  const runtime = makeRuntime();
  const bootstrapper = async () => ({ step: "ready", userId: USER, facts: { inboundAddress: OLD, firstMailConfirmedAt: "2026-08-01T00:00:00Z", homeCurrency: "AED" } } as const);
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
  fireEvent.press(screen.getByTestId("open-address"));
  await waitFor(() => expect(screen.getByTestId("rotate-address-screen")).toBeTruthy());
  return mounted;
}

it("Settings reaches the address, which is read from the runtime and can be copied", async () => {
  const mounted = await openAddressScreen();
  await waitFor(() => expect(screen.getByTestId("address-value")).toBeTruthy());
  expect(screen.getByTestId("address-value").props.children).toBe(OLD);
  expect(screen.getByTestId("address-qr")).toBeTruthy();
  fireEvent.press(screen.getByTestId("address-copy"));
  await waitFor(() => expect(mockSetString).toHaveBeenCalledWith(OLD));
  // Nothing destructive is armed by arriving here.
  expect(screen.queryByTestId("rotate-address-confirm")).toBeNull();
  await mounted.unmount();
});

it("the consequences are on the glass before the button is armed", async () => {
  const mounted = await openAddressScreen();
  const said = [0, 1, 2, 3].map((i) => String(screen.getByTestId(`rotate-consequence-${i}`).props.children)).join(" ");
  expect(said).toContain("forwarding rule");
  expect(said).toContain("7 days");
  expect(said).toContain("cannot do this for you");
  await mounted.unmount();
});

it("rotation runs the real three-factor path and shows the grace deadline it gets back", async () => {
  const seen = serve([
    { status: 200, body: { address: OLD, created_at: "2026-07-01T00:00:00Z" } },
    { status: 200, body: { nonce: NONCE } },
    { status: 200, body: { address: NEW, created_at: "2026-08-05T00:00:00Z", rotates_from: OLD, grace_until: new Date(Date.now() + 7 * 86_400_000).toISOString() } },
  ]);
  const mounted = await openAddressScreen();

  fireEvent.press(screen.getByTestId("rotate-address-arm"));
  await waitFor(() => expect(screen.getByTestId("rotate-address-confirm")).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByTestId("rotate-address-confirm")); });

  await waitFor(() => expect(screen.getByTestId("rotate-address-notice")).toBeTruthy());
  expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
    "GET /api/v1/address",
    "POST /api/v1/address/challenge",
    "POST /api/v1/address/rotate",
  ]);

  // Factor 2 really happened, bound to the server's own nonce.
  expect(mockSignIn).toHaveBeenCalled();
  const sent = seen[2]?.body as { idp: string; id_token: string; nonce: string; sig: string };
  expect(sent.idp).toBe("apple");
  expect(sent.id_token).toBe("fresh-apple-token");
  expect(sent.nonce).toBe(NONCE);
  expect(sent.sig.length).toBeGreaterThan(0);

  // The new address and the predecessor's deadline, both straight from the
  // server's answer.
  await waitFor(() => expect(screen.getByTestId("address-value").props.children).toBe(NEW));
  expect(screen.getByTestId("address-grace")).toBeTruthy();
  const grace = String(screen.getByTestId("address-grace-text").props.children);
  expect(grace).toContain(OLD);
  expect(grace).toContain("in 7 days");
  expect(String(screen.getByTestId("rotate-address-notice").props.children)).toContain("Update your forwarding rule");
  await mounted.unmount();
});

it("a rejected rotation says nothing changed and leaves the old address on screen", async () => {
  serve([
    { status: 200, body: { address: OLD, created_at: "2026-07-01T00:00:00Z" } },
    { status: 200, body: { nonce: NONCE } },
    { status: 403, body: { error: "rotation_rejected" } },
  ]);
  const mounted = await openAddressScreen();
  fireEvent.press(screen.getByTestId("rotate-address-arm"));
  await waitFor(() => expect(screen.getByTestId("rotate-address-confirm")).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByTestId("rotate-address-confirm")); });
  await waitFor(() => expect(screen.getByTestId("rotate-address-notice")).toBeTruthy());
  expect(String(screen.getByTestId("rotate-address-notice").props.children)).toContain("was not changed");
  expect(screen.getByTestId("address-value").props.children).toBe(OLD);
  expect(screen.queryByTestId("address-grace")).toBeNull();
  await mounted.unmount();
});
