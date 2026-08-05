/**
 * Enrolling THIS device as a writer, which is what makes the app able to
 * author anything at all.
 *
 * # What was wrong
 *
 * `Client.enroll` has existed, tested, since Task 5. Until this module it was
 * called from exactly one non-test place in the repository — `client/src/cli/
 * main.ts` — and from nowhere under `app/`. A phone therefore signed in
 * successfully, stored a session, and then had `ClientState.writerId === null`
 * forever: every write path (`Outbox` push, `txn_edited`, `txn_categorized`,
 * `home_currency_set`, a split) reads `Client.writerId`, which throws when no
 * writer is selected. The product was read-only in principle and the first
 * launch after signing in landed on the full-screen "could not safely open
 * this account" wall. Every test suite was green. This is the "written, tested
 * green, never wired" shape, at its most expensive.
 *
 * # Idempotency, by measurement rather than by construction
 *
 * A device that enrols twice pollutes an append-only roster permanently, and
 * the second enrolment orphans the first writer's chain. So enrolment is
 * guarded three deep, and none of the three guards is derived from the thing
 * it is checking:
 *
 *  1. The writer **id** is minted once per install and persisted in the
 *     Keychain before it is used ({@link ensureWriterId}). Every retry, every
 *     relaunch and every second sign-in therefore asks about the SAME id — the
 *     roster can never grow a second row for this phone no matter how many
 *     times this runs.
 *  2. The fast path is "this device already authors as that id AND holds its
 *     private seed" — read from `ClientState` and from the secret store, the
 *     two places `account/deletion.ts` and `account/address.ts` read. It costs
 *     no network call, which is what makes calling this on every launch free.
 *  3. When the fast path misses, the **server's roster** decides, not local
 *     state. That closes the window where a process died between the server's
 *     `204` and `Client.enroll`'s `commit()`: the id is enrolled, local state
 *     does not know it, and re-registering would earn a permanent
 *     `403 registration_rejected` (`auth.ErrWriterExists`). Seeing our id in
 *     the roster we adopt it with {@link Client.useWriter} instead.
 *
 * Guard 3 compares the roster's public key against the one this device holds
 * rather than trusting that a matching id implies a matching key. The two can
 * genuinely diverge — a restored-from-backup install keeps `writer_id` (it is
 * not secret and a naive migration could carry it) while the
 * `..._THIS_DEVICE_ONLY` seed does not travel — and that device must be told
 * it cannot sign, not handed a writer whose blobs nobody can verify.
 *
 * # What this never does
 *
 * It never mints a second writer id, never regenerates a key for an id the
 * server already knows, and never retries by itself. Retrying is a user
 * pressing something; see {@link enrollmentCopy}, which is the only source of
 * what a person is told when this fails.
 */

import { SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import type { SecretStore } from "@ledger/client/store/store.ts";
import type { Writer } from "@ledger/client/invariants/check.ts";

import { ensureWriterId } from "./keys.ts";
import { fromBase64, toHex } from "../platform/bytes.ts";

/**
 * The roster row as this module needs it.
 *
 * `pubkey` is additive over {@link Writer}: `GET /api/v1/writers` has always
 * returned it (`api.WriterEntry.PubKey`) and the shared type simply did not
 * name it. It is optional because the ingest writer has no key, so an absent
 * value is a legitimate answer and not a reason to refuse.
 */
export type RosterEntry = Writer & { pubkey?: string };

export interface EnrollmentClient {
  roster(): Promise<readonly RosterEntry[]>;
  enroll(writerId: string): Promise<void>;
  useWriter(writerId: string): void;
}

export interface EnrollmentDeps {
  /** The Keychain. Holds `writer_id` and `writer_key:<id>`. */
  secrets: SecretStore;
  /** `Store.load()`. The persisted client state, not the folded projection. */
  state: () => { writerId: string | null; writers: Map<string, { x: string }> };
  client: EnrollmentClient;
  /** Mints an id for a device that has never had one. `crypto.randomUUID`. */
  mint: () => string;
}

export type EnrollmentStatus =
  /** Already enrolled and already selected. No network call was made. */
  | "already"
  /** The roster already named this id; local state was pointed back at it. */
  | "adopted"
  /** Registered with the server on this call. */
  | "enrolled";

export interface EnrollmentOutcome {
  status: EnrollmentStatus;
  writerId: string;
}

export type EnrollmentKind =
  /** The request never reached a server that answered. */
  | "offline"
  /** The server answered, but not with a yes: 5xx, or a shape we cannot read. */
  | "unavailable"
  /** 429. */
  | "rate_limited"
  /** 403 — every registration rejection is the same bodyless 403, by design. */
  | "rejected"
  /** The roster names this device's writer, and it has been retired. */
  | "revoked"
  /** The roster names this device's writer and this device has lost its key. */
  | "key_lost";

/**
 * A failure of enrolment specifically, as opposed to of the session.
 *
 * `status`/`code` are copied off the cause when it had them, because
 * `bootstrap.ts`'s `classify` and `session.ts`'s `mayWipeLocalData` match
 * **structurally** on those two fields: an `401` or a
 * `410 account_deleted` raised while enrolling has to keep meaning "sign out"
 * and "this account is gone", and wrapping it in an opaque error would take
 * that away.
 */
export class EnrollmentError extends Error {
  /**
   * The brand `isEnrollmentError` matches on, for the same reason
   * `session.ts` matches `ApiError` structurally: a class identity check
   * across two module copies fails silently and in the wrong direction.
   */
  readonly enrollmentKind: EnrollmentKind;
  readonly status?: number;
  readonly code?: string;

  constructor(kind: EnrollmentKind, message: string, cause?: unknown) {
    super(message);
    this.name = "EnrollmentError";
    this.enrollmentKind = kind;
    const http = httpShape(cause);
    if (http !== null) {
      this.status = http.status;
      this.code = http.code;
    }
  }
}

export function isEnrollmentError(err: unknown): err is EnrollmentError {
  if (typeof err !== "object" || err === null) return false;
  const kind = (err as { enrollmentKind?: unknown }).enrollmentKind;
  return typeof kind === "string";
}

function httpShape(err: unknown): { status: number; code: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; code?: unknown };
  if (typeof e.status !== "number") return null;
  return { status: e.status, code: typeof e.code === "string" ? e.code : "" };
}

/**
 * `401` and `410` are the session's business, not enrolment's, and travel
 * unwrapped so the callers that already classify them keep working.
 */
function isSessionFailure(err: unknown): boolean {
  const http = httpShape(err);
  return http !== null && (http.status === 401 || http.status === 410);
}

function classify(err: unknown): EnrollmentError {
  const http = httpShape(err);
  if (http === null) {
    const detail = err instanceof Error ? err.message : String(err);
    return /network|fetch|timeout|connect/i.test(detail)
      ? new EnrollmentError("offline", detail, err)
      : new EnrollmentError("unavailable", detail, err);
  }
  if (http.status === 429) return new EnrollmentError("rate_limited", `${String(http.status)} ${http.code}`, err);
  if (http.status === 403) return new EnrollmentError("rejected", `${String(http.status)} ${http.code}`, err);
  return new EnrollmentError("unavailable", `${String(http.status)} ${http.code}`, err);
}

/** Base64url (JWK `x`) and standard base64 (the API) compared as bytes. */
function keyFingerprint(value: string): string {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return toHex(fromBase64(standard + "=".repeat((4 - (standard.length % 4)) % 4)));
}

/**
 * Makes sure this device can author, and returns what it had to do.
 *
 * Safe to call on every launch and after every sign-in: the common case
 * returns `already` without touching the network.
 */
export async function ensureDeviceWriter(deps: EnrollmentDeps): Promise<EnrollmentOutcome> {
  // Persisted BEFORE it is used, and never re-minted. See `keys.ts`.
  const writerId = ensureWriterId(deps.secrets, deps.mint);

  const st = deps.state();
  const local = st.writers.get(writerId);
  const seed = deps.secrets.get(`${SECRET_WRITER}${writerId}`);
  const holdsKey = local !== undefined && seed !== null && seed !== "";
  if (st.writerId === writerId && holdsKey) return { status: "already", writerId };

  let roster: readonly RosterEntry[];
  try {
    roster = await deps.client.roster();
  } catch (error) {
    if (isSessionFailure(error)) throw error;
    throw classify(error);
  }

  const entry = roster.find((w) => w.writer_id === writerId);
  if (entry !== undefined) {
    if (entry.revoked_at !== null) {
      throw new EnrollmentError("revoked", `writer ${writerId} is revoked on the server`);
    }
    if (local === undefined) {
      throw new EnrollmentError("key_lost", `the server knows writer ${writerId} and this device holds no key for it`);
    }
    if (entry.pubkey !== undefined && entry.pubkey !== "" && keyFingerprint(entry.pubkey) !== keyFingerprint(local.x)) {
      throw new EnrollmentError(
        "key_lost",
        `writer ${writerId} is enrolled with a different public key than this device holds`,
      );
    }
    // Enrolled already; only local selection was missing. Registering again
    // would be a permanent 403 (auth.ErrWriterExists).
    deps.client.useWriter(writerId);
    return { status: "adopted", writerId };
  }

  try {
    await deps.client.enroll(writerId);
  } catch (error) {
    if (isSessionFailure(error)) throw error;
    throw classify(error);
  }
  return { status: "enrolled", writerId };
}

// ---------------------------------------------------------------------------
// What a person is told
// ---------------------------------------------------------------------------

export interface EnrollmentCopy {
  title: string;
  body: string;
  /** Whether pressing the same button again could plausibly work. */
  retry: boolean;
}

/**
 * The copy, kept here rather than in a screen because two screens render it —
 * the launch wall and the sign-in banner — and because the honesty of each
 * sentence is the part of this task worth testing.
 *
 * Nothing here names a CLI, a writer id, or an endpoint. `rejected` is the one
 * that has to be careful: the server answers every registration refusal with
 * the same bodyless `403`, so the copy may not claim to know WHY, only what is
 * true — that this phone was not accepted and pressing again will not change
 * that.
 */
export function enrollmentCopy(kind: EnrollmentKind): EnrollmentCopy {
  switch (kind) {
    case "offline":
      return {
        title: "ledger could not finish setting up this phone",
        body:
          "You are signed in, but registering this phone as one that can make changes needs a connection. " +
          "Nothing was lost. Try again when you are online.",
        retry: true,
      };
    case "unavailable":
      return {
        title: "ledger could not finish setting up this phone",
        body:
          "You are signed in, but the server could not register this phone as one that can make changes. " +
          "Nothing was lost. Try again in a moment.",
        retry: true,
      };
    case "rate_limited":
      return {
        title: "Too many attempts",
        body: "Setting this phone up was tried too many times in a row. Wait a minute and try again.",
        retry: true,
      };
    case "rejected":
      return {
        title: "This phone was not accepted",
        body:
          "You are signed in, but the server refused to register this phone as one that can make changes, and it " +
          "does not say why. If another device is already set up on this account, adding a second one has to be " +
          "approved from that device — which this beta cannot do yet. Trying again will not change the answer.",
        retry: false,
      };
    case "revoked":
      return {
        title: "This phone's access was withdrawn",
        body:
          "This phone was set up on this account and then removed from it. It can still read what it already has, " +
          "but it cannot make changes, and signing in again will not restore it.",
        retry: false,
      };
    case "key_lost":
      return {
        title: "This phone can no longer prove who it is",
        body:
          "This account already knows this phone, but the private key that signed for it is gone from this device — " +
          "restoring a backup does not carry it. Nothing on the server was lost. This phone cannot make changes again " +
          "until a device that still has its key can add it back, which this beta cannot do yet.",
        retry: false,
      };
  }
}

/** The copy for an error, whatever shape it arrived in. */
export function enrollmentFailureCopy(err: unknown): EnrollmentCopy {
  return enrollmentCopy(isEnrollmentError(err) ? err.enrollmentKind : "unavailable");
}
