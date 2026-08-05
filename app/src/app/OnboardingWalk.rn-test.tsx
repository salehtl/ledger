/**
 * The onboarding walk, pressed for real: bank -> address -> forwarding ->
 * verification -> home currency.
 *
 * # Why this file exists
 *
 * "Written, tested green, never wired" is at instance eight on this project, so
 * a screen that only its own unit test can reach does not count as built. Every
 * assertion below goes through the REAL `Navigation`, the real `OnboardingShell`
 * and the real step machine, and each step is reached by pressing the control a
 * user presses.
 *
 * # The dead end this reproduces
 *
 * `facts.inboundAddress` is null here, which is exactly the state a user is in
 * on the launch where they sign in: `RuntimeProvider` bootstraps once at mount,
 * that happens before there is a session, and `Navigation` therefore passes
 * `inboundAddress: null`. Before `AddressScreen` existed the shell's
 * placeholder for that step correctly refused to advance (the address is server
 * truth), so onboarding stopped there with nothing to press. The first case
 * below is that exact state, and it walks out of it.
 */

import { NavigationContainer } from "@react-navigation/native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import { SECRET_WRITER_ID } from "../auth/keys.ts";
import { ONBOARDING_LOCAL_KEY } from "../lib/onboarding.ts";
import { toBase64, utf8Encode } from "../platform/bytes.ts";
import { Navigation } from "./Navigation.tsx";
import { RuntimeProvider } from "./RuntimeProvider.tsx";
import { ThemeProvider } from "./Theme.tsx";
import type { AppRuntime } from "./runtime.ts";

const mockSetString = jest.fn(async (_text: string) => true);
jest.mock("expo-clipboard", () => ({ setStringAsync: (text: string) => mockSetString(text) }));

const USER = "123e4567-e89b-42d3-a456-426614174000";
const ADDRESS = "k7qmz3x9r2w5t8v4n6p1c0abcd@in.example";

/**
 * `toBase64(utf8Encode(...))` rather than `Buffer`: `host-globals.test.ts`
 * exempts `*.test.ts` from the Hermes host-global rule but not `*.rn-test.tsx`,
 * and the app's own primitives are the right tool here anyway.
 */
const b64 = (s: string) => toBase64(utf8Encode(s));

const GMAIL = b64([
  "From: Gmail Team <forwarding-noreply@google.com>",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "you@example.com has requested to automatically forward mail to your address.",
  "",
  "Confirmation code: 123456789",
  "",
  "https://mail-settings.google.com/mail/vf-%5BANGjdJ8abc%5D-XyZ",
  "",
].join("\r\n"));

function held(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "q1", ingest_id: "aa", received_at: "2026-08-05T10:00:00Z", expires_at: "2026-09-04T10:00:00Z",
    outer_domain: "google.com", inner_domain: "", attested: true, attested_by: "dkim",
    dkim: "pass", arc: "none", size_bucket: 1, blob: GMAIL, ...over,
  };
}

const BANK_ITEM = held({ id: "q2", ingest_id: "bb", outer_domain: "google.com", inner_domain: "dib.ae", blob: undefined });

function fakeSecrets() {
  const values = new Map<string, string>([
    [SECRET_SESSION, "held"],
    [SECRET_WRITER_ID, "phone"],
    [`${SECRET_WRITER}phone`, toBase64(new Uint8Array(32).fill(7))],
    [ONBOARDING_LOCAL_KEY, JSON.stringify({ bank: "dib", forwardingDeclared: false, finishedAt: null })],
  ]);
  return { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string | null) => { if (v === null) values.delete(k); else values.set(k, v); } };
}

interface Harness {
  runtime: AppRuntime;
  listCalls: { includeBlob: boolean }[];
  confirmCalls: { domain: string; scope: string }[];
  currentCalls: number;
  postConfirm(): void;
}

function harness(over: {
  items?: unknown[];
  /** What the folded log says after a confirmation. Null models "nothing came out of it". */
  confirmedAt?: string | null;
  addressFails?: boolean;
} = {}): Harness {
  const listCalls: { includeBlob: boolean }[] = [];
  const confirmCalls: { domain: string; scope: string }[] = [];
  let currentCalls = 0;
  let txns = new Map<string, { posted_at: string }>();
  const state = { get txns() { return txns; }, homeCurrency: null };
  const h: Harness = {
    listCalls, confirmCalls,
    get currentCalls() { return currentCalls; },
    postConfirm() {
      if (over.confirmedAt !== null && over.confirmedAt !== undefined) {
        txns = new Map([["t1", { posted_at: over.confirmedAt }]]);
      }
    },
    runtime: {
      server: "https://ledger.test",
      secrets: fakeSecrets(),
      client: { sessionToken: "held", userId: USER, state: () => state },
      store: { load: () => ({ userId: USER }) },
      address: {
        current: async () => {
          currentCalls += 1;
          if (over.addressFails === true) throw new Error("offline");
          return { address: ADDRESS, createdAt: "2026-08-05T00:00:00Z", rotatesFrom: null, graceUntil: null };
        },
      },
      quarantine: {
        list: async (_cursor: unknown, options: { includeBlob?: boolean } = {}) => {
          listCalls.push({ includeBlob: options.includeBlob === true });
          return { items: (over.items ?? []).map(decodeLikeSource), actionNeeded: 0, expiringSoon: 0, next: {}, complete: true };
        },
        confirm: async (domain: string, scope: string) => {
          confirmCalls.push({ domain, scope });
          h.postConfirm();
          return { domain, scope, ingestIds: [], reingest: null };
        },
      },
      waitlist: { join: async () => {} },
      txns: {
        list: () => ({ rows: [], next: null }), read: () => null, forks: () => [], facets: () => ({ categories: [], currencies: [] }),
        homeCurrency: () => "AED", edit: () => ({ ok: true, changed: false } as const), split: () => ({ ok: true, changed: false } as const),
        recomputeHome: () => ({ ok: false, error: "missing" } as const),
      },
      commitOnboardingOps: async () => {},
      deviceIdentity: () => null,
      dispose: async () => {}, wipeAccount: async () => {},
    } as unknown as AppRuntime,
  };
  return h;
}

/** The same field mapping `screens/quarantine/source.ts` performs on the wire. */
function decodeLikeSource(raw: unknown) {
  const r = raw as Record<string, unknown>;
  return {
    id: r.id, ingestId: r.ingest_id, receivedAt: r.received_at, expiresAt: r.expires_at,
    warnedAt: null, deleteAfter: null, outerDomain: r.outer_domain, innerDomain: r.inner_domain,
    attested: r.attested === true, attestedBy: r.attested_by, dkim: r.dkim, arc: r.arc,
    sizeBucket: r.size_bucket, ...(typeof r.blob === "string" ? { blob: r.blob } : {}),
  };
}

async function mount(h: Harness) {
  const bootstrapper = async () => ({
    step: "onboarding" as const,
    userId: USER,
    facts: { inboundAddress: null, firstMailConfirmedAt: null, homeCurrency: null },
  });
  return render(
    <ThemeProvider>
      <NavigationContainer>
        <RuntimeProvider runtime={h.runtime} bootstrapper={bootstrapper}>
          <Navigation />
        </RuntimeProvider>
      </NavigationContainer>
    </ThemeProvider>,
  );
}

beforeEach(() => { mockSetString.mockClear(); });

it("the address step is reachable, shows a real address, and walks on", async () => {
  const h = harness();
  const mounted = await mount(h);

  await waitFor(() => expect(screen.getByTestId("onboarding-address")).toBeTruthy());
  // The screen performed the read itself: this is what was missing, not the
  // milestone. `GET /api/v1/address` mints on first read.
  expect(h.currentCalls).toBeGreaterThan(0);
  expect(screen.getByTestId("address-value").props.children).toBe(ADDRESS);
  // The QR is rendered, not stubbed: a 26-character base32 token with no way
  // off the phone is the failure this step exists to avoid.
  expect(screen.getByTestId("address-qr")).toBeTruthy();

  fireEvent.press(screen.getByTestId("address-copy"));
  await waitFor(() => expect(mockSetString).toHaveBeenCalledWith(ADDRESS));
  await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());

  // The machine advances only on the press, never on the fetch: advancing on
  // arrival would render this screen for one frame and hand the user nothing.
  fireEvent.press(screen.getByTestId("address-continue"));
  await waitFor(() => expect(screen.getByTestId("step-forwarding-body")).toBeTruthy());
  expect(screen.queryByTestId("onboarding-address")).toBeNull();

  await mounted.unmount();
});

it("a failed address read says so and retries rather than dead-ending", async () => {
  const h = harness({ addressFails: true });
  const mounted = await mount(h);
  await waitFor(() => expect(screen.getByTestId("address-failed")).toBeTruthy());
  expect(screen.queryByTestId("address-continue")).toBeNull();
  const before = h.currentCalls;
  await act(async () => { fireEvent.press(screen.getByTestId("address-retry")); });
  expect(h.currentCalls).toBeGreaterThan(before);
  await mounted.unmount();
});

it("forwarding leads to verification, which reads Google's code out of held mail", async () => {
  const h = harness({ items: [held()] });
  const mounted = await mount(h);

  await waitFor(() => expect(screen.getByTestId("onboarding-address")).toBeTruthy());
  fireEvent.press(screen.getByTestId("address-continue"));
  await waitFor(() => expect(screen.getByTestId("step-forwarding-skip")).toBeTruthy());
  fireEvent.press(screen.getByTestId("step-forwarding-skip"));

  await waitFor(() => expect(screen.getByTestId("onboarding-verification")).toBeTruthy());
  // The blob is asked for, which is the only way the code can be read at all.
  await waitFor(() => expect(h.listCalls.length).toBeGreaterThan(0));
  expect(h.listCalls.every((c) => c.includeBlob)).toBe(true);

  await waitFor(() => expect(screen.getByTestId("verification-code")).toBeTruthy());
  expect(screen.getByTestId("verification-code").props.children).toBe("123456789");
  expect(screen.getByTestId("verification-open-link")).toBeTruthy();

  fireEvent.press(screen.getByTestId("verification-copy-code"));
  await waitFor(() => expect(mockSetString).toHaveBeenCalledWith("123456789"));

  await mounted.unmount();
});

it("confirming a verified bank finishes the step, and lands on the currency picker", async () => {
  const h = harness({ items: [held(), BANK_ITEM], confirmedAt: "2026-08-05T09:30:00Z" });
  const mounted = await mount(h);

  await waitFor(() => expect(screen.getByTestId("onboarding-address")).toBeTruthy());
  fireEvent.press(screen.getByTestId("address-continue"));
  await waitFor(() => expect(screen.getByTestId("step-forwarding-skip")).toBeTruthy());
  fireEvent.press(screen.getByTestId("step-forwarding-skip"));
  await waitFor(() => expect(screen.getByTestId("verification-bank-q2")).toBeTruthy());

  // The VERIFIED inner domain is what is on the glass - never a subject line
  // or a display name, neither of which the API even sends.
  expect(screen.getByTestId("verification-bank-basis-q2").props.children).toBe("dib.ae");

  await act(async () => { fireEvent.press(screen.getByTestId("verification-trust-q2")); });
  expect(h.confirmCalls).toEqual([{ domain: "dib.ae", scope: "inner" }]);
  await waitFor(() => expect(screen.getByTestId("home-currency-permanence")).toBeTruthy());

  await mounted.unmount();
});

/**
 * The measured-not-inferred property.
 *
 * `POST /api/v1/quarantine/confirm` answering 200 is not the milestone; a
 * transaction in the log is. With the log still empty the screen must stay put
 * and say so, however cleanly the confirmation went.
 */
it("a confirmation that produced no transaction does NOT advance the machine", async () => {
  const h = harness({ items: [BANK_ITEM], confirmedAt: null });
  const mounted = await mount(h);

  await waitFor(() => expect(screen.getByTestId("onboarding-address")).toBeTruthy());
  fireEvent.press(screen.getByTestId("address-continue"));
  await waitFor(() => expect(screen.getByTestId("step-forwarding-skip")).toBeTruthy());
  fireEvent.press(screen.getByTestId("step-forwarding-skip"));
  await waitFor(() => expect(screen.getByTestId("verification-trust-q2")).toBeTruthy());

  await act(async () => { fireEvent.press(screen.getByTestId("verification-trust-q2")); });
  expect(h.confirmCalls).toHaveLength(1);
  await waitFor(() => expect(screen.getByTestId("verification-message")).toBeTruthy());
  expect(String(screen.getByTestId("verification-message").props.children)).toContain("no transaction");
  expect(screen.getByTestId("onboarding-verification")).toBeTruthy();
  expect(screen.queryByTestId("home-currency-permanence")).toBeNull();

  await mounted.unmount();
});

/**
 * The fallback the brief calls "never a dead end": a held message whose body
 * carries no nine-digit run still shows the user the message.
 */
it("a held message with no code shows the raw message, labelled untrusted", async () => {
  const noCode = b64("From: x@google.com\r\nContent-Type: text/plain\r\n\r\nNothing useful here at all.\r\n");
  const h = harness({ items: [held({ blob: noCode })] });
  const mounted = await mount(h);

  await waitFor(() => expect(screen.getByTestId("onboarding-address")).toBeTruthy());
  fireEvent.press(screen.getByTestId("address-continue"));
  await waitFor(() => expect(screen.getByTestId("step-forwarding-skip")).toBeTruthy());
  fireEvent.press(screen.getByTestId("step-forwarding-skip"));

  await waitFor(() => expect(screen.getByTestId("verification-no-code")).toBeTruthy());
  expect(String(screen.getByTestId("verification-raw-body").props.children)).toContain("Nothing useful here");
  expect(screen.queryByTestId("verification-code")).toBeNull();
  await mounted.unmount();
});
