/**
 * FX: what a transaction in a foreign currency is worth in the user's home
 * currency, and *when* that number is decided (spec §3.7).
 *
 * # The rule, exactly
 *
 *     snapshot(T) = convert(amount(T), head_rate(ccy(T), P))
 *
 * where **P is the smallest log position ≥ pos(T) at which a non-null head rate
 * for `ccy(T)` exists**, and null if no such position exists in the synced
 * prefix. `head_rate(ccy, P)` is the last `rate_set` / `rate_unset` for that
 * currency at a position ≤ P, resolved purely by fold-by-`seq` — never by wall
 * clock or author timestamp, because a parent-free `rate_set` has no fork to
 * arbitrate and `authored_at` is the fork tiebreak and nothing else.
 *
 * Read "exists" as "exists and is non-null". A `rate_unset` is a live fact at
 * its position, not a rate: a row sequenced into an unset gap has no P yet and
 * waits for the next real `rate_set`, which is what {@link onRateSet}'s backfill
 * then gives it.
 *
 * # Why there is no `seq` parameter anywhere in this file
 *
 * Because the position is the *call site*. Everything here runs from inside the
 * fold, at the moment the op it belongs to is applied, so "the head live at P"
 * is simply `s.rates` as it stands when the function is entered. Passing a
 * position in would suggest these functions could be called at some other time
 * and still be right, and that is exactly the mistake this module is built to
 * make unwriteable: **freezing at the end of a fold, against the final rate
 * head, is the classic wrong implementation.** It agrees with this one on the
 * final state of many logs and disagrees on every intermediate one, so it
 * breaks prefix-monotonicity — a device that synced in ten chunks and one
 * restoring from scratch would show different money — while looking correct in
 * any test that only inspects the end of the log.
 *
 * The three claims that follow, each pinned by a test in `fx.test.ts`:
 *
 *   1. **A snapshot's only transition is null → value.** A later `rate_set`
 *      backfills the rows still waiting and touches nothing else; a `rate_unset`
 *      thaws nothing. The one exception is a `txn_edited` carrying
 *      `amount_home_minor` explicitly (§3.7:137) — a logged decision by the
 *      user, not a re-derivation, and it lives in `replay.ts` with the other
 *      edits.
 *   2. **A supersede never inherits.** It is a new row at a new position and is
 *      computed against the head live *there*, including the case where the
 *      template fix changed the currency. It is also never left permanently
 *      null: {@link freezeIfPossible} runs for it exactly as it does for an
 *      ingest.
 *   3. **The home currency carries the implicit identity rate**, 1.000000, and
 *      is un-unsettable by construction: `replay.ts` refuses `rate_set` and
 *      `rate_unset` aimed at it, in both directions across the onboarding op.
 *      Spec §3.7:125 says the home currency "carries no rate row"; this
 *      materializes it as one anyway, so `head_rate(home, P)` is a single lookup
 *      instead of a special case at every call site. That is a representation
 *      choice with a cross-executor consequence — the conformance cases encode
 *      it literally in `rates` — so it is stated in the manifest too.
 *
 * # Money is BigInt, and the hazard is the intermediate
 *
 * `amount_minor × rate_micro` exceeds 2^53 long before the result does — 25
 * billion fils at the USD peg is a 9.18e16 product and a 9.18e10 answer. A
 * `number` anywhere on this path is a bug, and it is the kind that produces a
 * plausible number rather than an obvious one: the conformance case
 * `13-bigint-intermediate-exceeds-a-double` is a real pair where the float path
 * is off by exactly one fil.
 */

import { HOME_IDENTITY_MICRO, clearPending, markPending, type State, type Txn } from "./state";

/**
 * The implicit rate of the home currency against itself, 1.000000 in
 * `rate_micro` units. Re-exported from `state.ts`, where the *rate head* lives;
 * a second declaration of a constant this load-bearing is how two executors end
 * up denominating in two different units.
 */
export { HOME_IDENTITY_MICRO };

/** One micro-unit of rate: `rate_micro` is home units per foreign unit × 10^6. */
const MICRO = 1_000_000n;
/** Half a micro-unit, added before truncation to make the division round half-up. */
const HALF_MICRO = 500_000n;

/**
 * Converts a native minor-unit amount to home-currency minor units, half-up.
 * Identical to v1's `store.ConvertToAEDFils` (`internal/store/fx.go:21-23`),
 * generalized from AED to the user's home currency.
 *
 * The positivity check is not defensive padding. `+ HALF_MICRO` then truncate is
 * half-up **only above zero**: BigInt division truncates toward zero, so a
 * negative amount would round the wrong way and produce a number that is
 * plausible, signed correctly, and off by one minor unit. Amounts are positive
 * by invariant — `direction` carries the sign and `positiveMoney` enforces it on
 * the way off the wire — so this throws rather than returning a wrong number: it
 * is unreachable through the op vocabulary, and if it ever becomes reachable the
 * honest response is a crash in a test, not a rounding rule that silently
 * changes meaning.
 */
export function convert(amountMinor: bigint, rateMicro: bigint): bigint {
  if (amountMinor < 0n || rateMicro < 0n) {
    throw new Error(
      `convert(${amountMinor}, ${rateMicro}): both must be positive — ` +
        `truncating division is half-up only above zero, so a negative operand rounds the wrong way`,
    );
  }
  return (amountMinor * rateMicro + HALF_MICRO) / MICRO;
}

/**
 * Adopts the home currency: installs its implicit identity rate and backfills
 * every home-currency row already waiting.
 *
 * The backfill is not a nicety. A home-currency transaction ingested *before*
 * the onboarding op has no other way to ever be converted — `rate_set` for the
 * home currency is an anomaly, so no later op could give it a P — and §3.7:133
 * says P is the smallest position ≥ pos(T) at which a head rate exists. This op
 * is that position.
 *
 * The one-shot rule and its `home_currency_reset` anomaly live in `replay.ts`
 * with the rest of the op vocabulary; by the time this is called, the decision
 * to adopt has been made.
 */
export function onHomeCurrencySet(s: State, ccy: string): void {
  s.homeCurrency = ccy;
  s.rates.set(ccy, HOME_IDENTITY_MICRO);
  backfill(s, ccy, HOME_IDENTITY_MICRO);
}

/**
 * Moves a currency's rate head and backfills every row of that currency whose
 * snapshot is still null — **and only those**. Rows frozen at an earlier
 * position keep the basis they were frozen at, which is what makes the log a
 * history rather than a running re-computation.
 */
export function onRateSet(s: State, ccy: string, micro: bigint): void {
  s.rates.set(ccy, micro);
  backfill(s, ccy, micro);
}

/**
 * Moves a currency's rate head to "unset": present and null, which is a live
 * fact at this position and deliberately different from a currency that never
 * had a rate at all.
 *
 * Nothing else happens, and that is the whole content of the op. Pending rows
 * stay pending — they are still waiting for their first non-null head, and a
 * later `rate_set` will backfill them, including rows sequenced before this
 * unset. Frozen rows stay frozen, because §3.7 never rewrites a snapshot.
 */
export function onRateUnset(s: State, ccy: string): void {
  s.rates.set(ccy, null);
}

/**
 * Computes a freshly created row's snapshot against the head live at its own
 * position, or files it as pending if there is none.
 *
 * Called for `txn_ingested` **and** `txn_superseded`, which is what makes "a
 * supersede recomputes at its own position and never inherits" (§3.7:129) true
 * by construction rather than by a rule someone has to remember.
 *
 * It takes the row rather than its id on purpose: the caller has just built it,
 * so an id would buy a second map lookup and an "unknown transaction" branch
 * that cannot happen. Call it exactly once per row, at that row's create
 * position — it assigns unconditionally, so calling it later would recompute a
 * snapshot the spec says is frozen.
 */
export function freezeIfPossible(s: State, t: Txn): void {
  const rate = s.rates.get(t.currency);
  if (typeof rate === "bigint") {
    t.amount_home_minor = convert(t.amount_minor, rate);
    clearPending(s, t);
    return;
  }
  // Absent (no rate ever) and null (a live unset) are the same answer here, and
  // differ only in what `state.rates` reports to the user.
  t.amount_home_minor = null;
  markPending(s, t);
}

/**
 * Freezes every row waiting on `ccy` at `micro`, then empties the bucket.
 *
 * Order-independent by construction: every row in the bucket freezes against the
 * same rate, so the answer does not depend on the order the set is walked — the
 * property `serializeState` relies on when it sorts these sets rather than
 * witnessing their order.
 */
function backfill(s: State, ccy: string, micro: bigint): void {
  const waiting = s.pendingByCurrency.get(ccy);
  if (waiting === undefined) return;
  for (const id of waiting) {
    const t = s.txns.get(id);
    // The index holds only live, unfrozen rows, so this lookup cannot miss; the
    // check is what TypeScript needs in order to say so.
    if (t === undefined) continue;
    t.amount_home_minor = convert(t.amount_minor, micro);
  }
  s.pendingByCurrency.delete(ccy);
}
