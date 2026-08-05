/**
 * The inbound address, as a value — and the one thing the UI is not allowed to
 * infer about it.
 *
 * Everything here is pure and runs under `bun test`. `GET /api/v1/address`,
 * `POST /api/v1/address/challenge` and `POST /api/v1/address/rotate` live in
 * `src/account/address.ts`; the screens hold no policy, the same split
 * `lib/onboarding.ts` documents.
 *
 * # The predecessor is ONE HOP, and this module must never pretend otherwise
 *
 * `internal/v2/api/addresses.go`'s `writeAddress` calls
 * `Addresses.Predecessor(addr)`, which reads `addr.RotatedFrom` — a single
 * column naming a single earlier address. A user who rotates twice inside the
 * seven-day grace window therefore has **two** still-accepting old addresses
 * and the response names only the newer of them.
 *
 * That is a real bug when the UI infers a chain from it: "your old address
 * stops working on X" is then false for the older one, which is still
 * accepting mail and about to stop without any notice at all. The rule this
 * module enforces is therefore narrow and mechanical:
 *
 *   - {@link AddressRecord.rotatesFrom} is a `string | null`, never a list;
 *   - {@link decodeAddress} REFUSES a response that carries anything other
 *     than a single string there, so a server that later grew a chain cannot
 *     be half-rendered by this build;
 *   - {@link graceNotice} names the exact address the server returned and
 *     nothing else, and {@link PREDECESSOR_SCOPE_NOTE} says out loud that
 *     other, older addresses may also still be accepting.
 *
 * # `rotates_from` and `grace_until` are a PAIR
 *
 * The Go side populates both or neither, and drops both once the window
 * closes, because "an address shown next to a deadline that has already passed
 * reads as though it still works". A half pair is a response this build does
 * not understand, so it is refused rather than rendered as an address with no
 * deadline or a countdown with no address.
 */

// ---------------------------------------------------------------------------
// The value
// ---------------------------------------------------------------------------

export interface AddressRecord {
  /** The full inbound address, e.g. `k7q…@in.example`. */
  address: string;
  /** RFC 3339, as the server sent it. */
  createdAt: string;
  /**
   * The immediately previous address, present **only** while it is still
   * accepting. One hop — see the file header.
   */
  rotatesFrom: string | null;
  /** RFC 3339 instant {@link rotatesFrom} stops accepting. */
  graceUntil: string | null;
}

export class AddressDecodeError extends Error {
  constructor(detail: string) {
    super(`address response: ${detail}`);
    this.name = "AddressDecodeError";
  }
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v === "") throw new AddressDecodeError(`${name} is not a non-empty string`);
  return v;
};

/**
 * Decodes `AddressResponse` (Go: `internal/v2/api/addresses.go`).
 *
 * Strict on purpose. This is the one response whose *absence* of a field is
 * meaningful — `rotates_from`/`grace_until` are `omitempty` and their absence
 * means "no predecessor is still accepting" — so a shape this build does not
 * recognise must fail loudly rather than degrade into that same silence.
 */
export function decodeAddress(v: unknown): AddressRecord {
  if (typeof v !== "object" || v === null) throw new AddressDecodeError("not an object");
  const r = v as Record<string, unknown>;
  const address = str(r["address"], "address");
  const createdAt = str(r["created_at"], "created_at");

  const rawFrom = r["rotates_from"];
  const rawUntil = r["grace_until"];
  const hasFrom = rawFrom !== undefined && rawFrom !== null && rawFrom !== "";
  const hasUntil = rawUntil !== undefined && rawUntil !== null && rawUntil !== "";
  // Both, or neither. There is deliberately no separate `hasFrom !== hasUntil`
  // branch: a mutation deleting one was written and SURVIVED the suite, because
  // `str()` below refuses a missing or empty half with a message at least as
  // good. A guard no test can distinguish from its absence is not defence in
  // depth, it is a second place for the rule to be written down and later
  // disagree - the same finding `platform/signing.ts` records about a
  // seed-length check it does not have.
  if (!hasFrom && !hasUntil) return { address, createdAt, rotatesFrom: null, graceUntil: null };
  // A chain would arrive here as an array. Refused, not flattened: this build
  // has no way to show a second still-accepting address honestly, and showing
  // the first of several as though it were the only one is the defect the file
  // header describes.
  if (Array.isArray(rawFrom)) throw new AddressDecodeError("rotates_from is a list; this build shows one predecessor");
  return {
    address,
    createdAt,
    rotatesFrom: str(rawFrom, "rotates_from"),
    graceUntil: str(rawUntil, "grace_until"),
  };
}

// ---------------------------------------------------------------------------
// The grace window
// ---------------------------------------------------------------------------

/**
 * Pinned to `addresses.DefaultGrace` (`7 * 24 * time.Hour`). It is a number the
 * copy states out loud, so a server-side change that this constant did not
 * follow would be a lie on the glass rather than a rounding error.
 */
export const GRACE_DAYS = 7;

export interface GraceNotice {
  /** The exact predecessor the server named. Never a set. */
  address: string;
  /** Days remaining, rounded up; 0 on the last day. */
  daysLeft: number;
  expired: boolean;
  text: string;
}

/**
 * What to say about the one still-accepting predecessor, or null when there is
 * none.
 *
 * `expired` is possible and is not dead code: the deadline is evaluated
 * against the SERVER's clock when the response is written, and this device's
 * clock can be behind or ahead. Saying "it has already stopped" is honest;
 * silently hiding the row would leave a user who is watching for the cutover
 * with nothing.
 */
export function graceNotice(rec: AddressRecord, nowMs: number): GraceNotice | null {
  if (rec.rotatesFrom === null || rec.graceUntil === null) return null;
  const deadline = Date.parse(rec.graceUntil);
  if (!Number.isFinite(deadline)) {
    return {
      address: rec.rotatesFrom,
      daysLeft: 0,
      expired: false,
      text: `${rec.rotatesFrom} is still accepting mail, but this device could not read the deadline the server sent.`,
    };
  }
  if (deadline <= nowMs) {
    return { address: rec.rotatesFrom, daysLeft: 0, expired: true, text: `${rec.rotatesFrom} has stopped accepting mail.` };
  }
  const daysLeft = Math.ceil((deadline - nowMs) / 86_400_000);
  const when = daysLeft === 1 ? "today" : `in ${daysLeft} days`;
  return {
    address: rec.rotatesFrom,
    daysLeft,
    expired: false,
    text: `${rec.rotatesFrom} still accepts mail and stops ${when}.`,
  };
}

/**
 * Shown beside every grace notice, and it is not boilerplate.
 *
 * The server names one predecessor. If this account rotated twice inside a
 * single grace window, an older address is *also* still accepting and nothing
 * in the response mentions it — so the honest thing to put on the glass is
 * that the deadline above covers the address it names and no other.
 */
export const PREDECESSOR_SCOPE_NOTE =
  "This deadline is for the one address named above. If you rotated more than once recently, an earlier address " +
  "may still be accepting mail on its own schedule, which ledger cannot show you here.";

// ---------------------------------------------------------------------------
// Rotation: what it costs, said before the tap
// ---------------------------------------------------------------------------

export interface RotationCopy {
  title: string;
  /** Every consequence §3.2 names, one per line, in the order they bite. */
  consequences: readonly string[];
  reauth: string;
  confirm: string;
  cancel: string;
}

/**
 * The words on the rotation screen.
 *
 * §3.2 makes rotation destructive and silent — "the user finds out by noticing,
 * days later, that transactions stopped appearing" — so every consequence is
 * stated before the button, not after it. `address.test.ts` asserts each one is
 * present, and asserts the copy never claims the old address keeps working, or
 * that anything is re-pointed automatically.
 */
export function rotationCopy(): RotationCopy {
  return {
    title: "Change your inbound address",
    consequences: [
      "Your mail provider's forwarding rule points at the old address. It will keep sending there and ledger will stop filing those emails once the old address expires. You have to edit the rule yourself.",
      "Any alert address you registered with your bank also points at the old address, and has to be changed with the bank. ledger cannot do this for you.",
      `The old address keeps accepting mail for ${GRACE_DAYS} days. That is the whole window you have to redo both of the above.`,
      "Nothing already in your ledger changes. This only affects where new mail is accepted.",
    ],
    reauth: "Changing your address needs you to sign in again and confirm on this device, the same as deleting your account.",
    confirm: "Change my address",
    cancel: "Keep my current address",
  };
}
