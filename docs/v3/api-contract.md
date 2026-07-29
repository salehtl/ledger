# ledger v3 — API contract (backend piece 1)

The authoritative wire contract for every endpoint and event added or changed
by the v3 backend. Frontend pieces 2–6 build against this document sight-unseen.

Conventions:

- **All money is `int64` AED fils** (AED × 100) unless a field name says
  otherwise. Split-line `amount_fils` is in the **parent transaction's**
  currency minor units.
- **New v3 endpoints use snake_case JSON** (shown literally below).
  **Exception:** items in the existing transaction-list payloads
  (`GET /api/transactions`, `recent` in `GET /api/summary`) keep their
  historical **Go-field-name keys** (`ID`, `PostedAt`, `MerchantRaw`, …); the
  v3 additions to those items (`Note`, `DisplayName`, `Splits`) follow that
  same Go-name convention.
- Months are `"YYYY-MM"`, dates `"YYYY-MM-DD"`, instants RFC3339 UTC.
- **Error shape** for every endpoint below: `{"error":"<message>"}` with
  status `400` (validation — the message is human-usable), `404` (missing
  resource), `503` (store not wired), `500` (`{"error":"db error"}`).
  Store-validation 400 messages are specific, e.g.
  `"invalid category target: amount_fils must be > 0"`.

---

## 1. Category targets

One target max per category. `target_type`: `"set_aside" | "refill" |
"save_by_date"`. `cadence`: `"weekly" | "monthly" | "yearly"` (default
`"monthly"` when omitted). `due_date` required iff `save_by_date`.

### `GET /api/targets`

→ `200` array (may be `[]`):

```json
[
  {
    "category_id": 5,
    "target_type": "set_aside",
    "amount_fils": 50000,
    "cadence": "monthly",
    "created_at": "2026-07-29T10:00:00Z",
    "updated_at": "2026-07-29T10:00:00Z"
  }
]
```

`due_date` is omitted (not `""`) when unset — i.e. on every target that is not
`save_by_date`.

### `GET /api/targets/{categoryId}`

→ `200` single target object (shape above) | `404 {"error":"no target for category"}`.

### `PUT /api/targets/{categoryId}`

Creates or overwrites the category's target.

Request:

```json
{ "target_type": "save_by_date", "amount_fils": 120000, "cadence": "monthly", "due_date": "2026-12-01" }
```

→ `200` the stored target object. `400` on invalid type/amount/cadence,
`save_by_date` without a `due_date` or with one that is not a valid
`YYYY-MM-DD` date, or unknown category (`{"error":"unknown category"}`).
A `due_date` sent on a `set_aside`/`refill` payload is silently dropped —
never stored or echoed.

### `DELETE /api/targets/{categoryId}`

→ `200 {"ok":true}` (idempotent — deleting a nonexistent target is ok).

---

## 2. Envelopes

### The envelope summary object

Returned by `GET /api/envelopes` and by **every envelope mutation** (so the
client never needs a follow-up fetch). One envelope per **active spending
category**, ordered need → want → saving, then name. Income resolves exactly
like the jar summary (`budget_config.income_source`: fixed figure vs
income-category credits).

```json
{
  "month": "2026-07",
  "income_fils": 300000,
  "assigned_fils": 100000,
  "overspend_debt_fils": 0,
  "ready_to_assign_fils": 200000,
  "envelopes": [
    {
      "category_id": 5,
      "category_name": "Groceries",
      "bucket": "need",
      "carryover_fils": 0,
      "assigned_fils": 100000,
      "activity_fils": 40000,
      "available_fils": 60000,
      "overspent": false,
      "overspend_debt_fils": 0,
      "target": {
        "type": "save_by_date",
        "amount_fils": 100000,
        "cadence": "monthly",
        "due_date": "2026-12-01",
        "months_left": 6,
        "needed_fils": 23333,
        "still_needed_fils": 0,
        "funded": true
      }
    }
  ]
}
```

Semantics:

- `available_fils = carryover + assigned − activity`. `overspent` ⇔ available < 0.
- `carryover_fils` is always ≥ 0. Uncovered cash overspend surfaces as
  `overspend_debt_fils` (per envelope and summed) and is charged against RTA
  **exactly once**, in the month after it happened; the charge itself settles
  the envelope (its carryover baseline is credited by the same amount), so
  the same overspend never re-charges and no manual "covering" assignment is
  needed — assigning to the category later is ordinary new funding that stays
  spendable and carries forward.
- Carryover and overspend debt are scoped to each category's **envelope era**:
  prior activity counts only from the category's first assignment month
  onward. A category never assigned to always enters the month with
  `carryover_fils: 0` and `overspend_debt_fils: 0` — pre-envelope (v2)
  history and deliberately un-enveloped categories never become debt.
- All envelope activity uses the app-wide AED convention: a foreign-currency
  transaction with no FX rate yet contributes **nothing** (it backfills when a
  rate exists), so Plan and the Home jars always agree.
- Envelope activity honors the **project carve-out** exactly like the jars:
  confirmed spend assigned to a `count_in_monthly=0` life project contributes
  nothing to any envelope's activity — and therefore can never fold into
  `overspend_debt_fils` charged against Ready-to-Assign. Toggling the project
  back to counting restores the activity (recomputed on read, like the jars).
  Split lines follow their **parent's** project link.
- `ready_to_assign_fils = income − assigned − overspend_debt`; **may be
  negative** (over-assignment is allowed — render red).
- `target` is omitted for envelopes with no target. `due_date` /
  `months_left` only on `save_by_date` targets. `needed_fils` is this month's
  full ask; `still_needed_fils = max(0, needed − assigned)`.

### `GET /api/envelopes?month=YYYY-MM`

`month` defaults to the current UTC month. → `200` summary. `400` bad month.

### `POST /api/envelopes/assign`

Absolute batch set (the assign/edit sheet).

```json
{
  "month": "2026-07",
  "assignments": [
    { "category_id": 5, "assigned_fils": 150000 },
    { "category_id": 7, "assigned_fils": 90000 }
  ]
}
```

→ `200` fresh summary. `400` when `assignments` empty, any
`assigned_fils < 0`, bad month, or a category that is not an envelope —
missing, inactive, or not `kind=spending`
(`{"error":"invalid envelope assignment: category 9 is not an active spending category"}`).
A rejected batch writes nothing (single transaction).

### `POST /api/envelopes/move`

Two-tap move-money. Takes from one envelope's assignment, gives to another.

```json
{ "month": "2026-07", "from_category_id": 5, "to_category_id": 7, "amount_fils": 40000 }
```

→ `200` fresh summary. `400` when `amount_fils <= 0`, ids missing/equal, bad
month, or either category is not an envelope (same message shape as assign).
The source may go negative-assigned (over-move is the user's call; RTA math
absorbs it). The move is **atomic**: both legs land in one store transaction,
so any non-200 response means neither envelope changed.

### `POST /api/envelopes/auto-assign`

One-call distribution of a positive RTA: targets funded first (row order),
leftover pro-rata by the 50/30/20 bucket weights across untargeted envelopes.

Request: `{ "month": "2026-07" }` (`month` optional, defaults current).

→ `200`:

```json
{
  "allocations": [ { "category_id": 5, "amount_fils": 50000 } ],
  "summary": { }
}
```

`allocations` are the **deltas applied** (empty array when RTA ≤ 0 — nothing
happens); `summary` is the post-assign envelope summary (shape above). The
whole plan is applied in one store transaction — a `500` means nothing was
assigned, never a partial plan. Allocations always sum to **exactly** the
positive RTA when at least one untargeted envelope exists (integer pro-rata;
auto-assign can never drive RTA negative).

---

## 3. Scheduled transactions (recurring bills)

### The schedule object

```json
{
  "id": 3,
  "merchant": "netflix.com",
  "label": "Netflix",
  "amount_fils": 3900,
  "tolerance_pct": 10,
  "interval_days": 30,
  "next_due": "2026-08-01",
  "direction": "debit",
  "category_id": 5,
  "account_id": null,
  "source": "detected",
  "status": "proposed",
  "last_matched_tx_id": 812,
  "last_matched_at": "2026-07-02T09:12:00Z",
  "last_amount_fils": 3900,
  "missed": false,
  "price_change": false,
  "provenance": { "count": 6, "avg_interval_days": 30, "last_amounts_fils": [3900, 3900, 3900], "tx_ids": [700, 750, 812], "price_stepped": true },
  "created_at": "2026-07-29T10:00:00Z",
  "updated_at": "2026-07-29T10:00:00Z"
}
```

- `merchant` is normalized (lowercased, whitespace-collapsed).
- `source`: `"manual" | "detected"`; `status`: `"proposed" | "active" |
  "paused" | "dismissed"`. Detector rows enter as `detected`/`proposed`.
- `tolerance_pct` is integer percent points (10 = ±10%). It is the
  **price_change flagging band**, and the match band for **early** arrivals
  (before `next_due`) — there `0` means exact-amount only. **On/after**
  `next_due` the matcher deliberately widens the band to
  `max(tolerance_pct, 50)`% so a repriced bill still matches (and is then
  flagged `price_change`); `tolerance_pct` never narrows that ±50% floor.
- `category_id` / `account_id` / `last_matched_tx_id` / `last_amount_fils`
  are `null` when unset. `last_matched_at` omitted when never matched.
- `provenance` is a **read-only** JSON object present only on detected rows
  (render "seen 6× every ~30 days"; `tx_ids` link the mined transactions;
  `price_stepped` omitted when false). Never sent on writes.
- `missed`: next_due + grace passed with no matching email (grace =
  interval/10 clamped 2..7 days). A late arrival clears it.
- `price_change`: the last match landed outside the ± tolerance band.

### `GET /api/scheduled?status=active,proposed`

`status` optional comma-list; empty = **all** statuses (incl. proposed and
dismissed). Ordered by `next_due` ascending. → `200` array of schedule
objects (may be `[]`). `400` on an unknown status token.

### `POST /api/scheduled`

Manual create (bills that don't email). `source` is forced to `"manual"`,
status starts `"active"`.

```json
{
  "merchant": "Gym Co",
  "label": "Gym membership",
  "amount_fils": 25000,
  "tolerance_pct": 10,
  "interval_days": 30,
  "next_due": "2026-08-05",
  "direction": "debit",
  "category_id": 5,
  "account_id": null
}
```

Only `merchant`, `amount_fils > 0`, `interval_days > 0`, `next_due` are
required. Omitted `tolerance_pct` defaults to **10** — send `0` explicitly
for the strictest behavior: exact-amount matching in the early window and any
price drift flagging `price_change` (on/after `next_due` the ±50% match floor
still applies; see the `tolerance_pct` semantics above). Omitted `direction`
= `"debit"`.

→ `201` the created schedule object. `400` validation, incl.
`{"error":"unknown category or account"}`.

### `PUT /api/scheduled/{id}`

Full replace of the user-editable fields (same request shape as POST). Status,
match bookkeeping and provenance are untouched. → `200` updated schedule
object | `404` | `400`.

### `DELETE /api/scheduled/{id}`

→ `200 {"ok":true}` (idempotent). Prefer **dismiss** for detector proposals —
a deleted merchant can be re-proposed, a dismissed one never is.

### `POST /api/scheduled/{id}/confirm` · `/dismiss` · `/pause`

Status transitions, each → `200` updated schedule object:

- `confirm` → `active` (from `proposed`, `paused`, or `dismissed` — it is
  also the "resume" action).
- `dismiss` → `dismissed` (from any; the merchant is never re-proposed).
- `pause` → `paused` (from `active` only).

Same-status calls are idempotent `200`. Illegal transitions → `400`
(`"invalid scheduled transaction: cannot go dismissed → paused"`); unknown id
→ `404`.

### `GET /api/upcoming?days=N`

Active schedules due within `N` days (default **14**, max 366), **including
overdue/missed rows** (they are still money about to be owed). Ordered
soonest first.

→ `200`:

```json
{
  "days": 14,
  "items": [
    { "id": 3, "merchant": "netflix.com", "...": "(full schedule object)", "due_in_days": 2 }
  ]
}
```

Each item is a full schedule object **plus** `due_in_days` (int, relative to
today UTC; negative = overdue). `missed` and `price_change` ride along for
badges. `400` when `days` outside 0..366.

---

## 4. Accounts, balances, reconcile

### `GET /api/accounts` (changed)

Items gain `kind`:

```json
[ { "id": 1, "name": "DIB Current", "bank": "DIB", "last4": "1234", "kind": "budget" } ]
```

`kind`: `"budget"` (spendable, participates in envelopes) or `"tracking"`
(investments/property — net worth only).

### `PUT /api/accounts/{id}` (new)

Only `kind` is mutable.

Request: `{ "kind": "tracking" }` → `200` the account object (shape above).
`400` bad kind, `404` unknown account.

### `DELETE /api/accounts/{id}` (changed)

Hard delete is only allowed for accounts with **no** balance check-in history
(`account_balances` is cascade-deleted, and check-ins are net-worth ground
truth — deleting them would retroactively rewrite the net-worth report).
→ `200 {"ok":true}` when clean; with history →
`409 {"error":"in use","balances":N}`.

### `GET /api/accounts/balances`

The accounts screen in one call — every **active** account with its balance
state:

```json
[
  {
    "account_id": 1,
    "name": "DIB Current",
    "bank": "DIB",
    "last4": "1234",
    "kind": "budget",
    "has_checkin": true,
    "anchor_fils": 70000,
    "anchor_as_of": "2026-07-29T10:00:00Z",
    "anchor_source": "checkin",
    "activity_since_fils": -12000,
    "txn_count": 3,
    "computed_fils": 58000
  }
]
```

`computed_fils = anchor + activity since anchor` (credit +, debit −,
attributed by the account's `last4`; confirmed + needs_review + transfer rows
count, ignored/archived never). When `has_checkin` is false the account has
never been checked in and the anchor/computed fields are zero/omitted.

### `GET /api/accounts/{id}/balances?limit=N`

Balance history, newest first (`limit` optional, 0/omitted = all):

```json
[
  { "id": 9, "account_id": 1, "as_of": "2026-07-29T10:00:00Z", "balance_fils": 70000, "source": "checkin", "note": "monthly", "created_at": "2026-07-29T10:00:00Z" }
]
```

`note` omitted when empty. `404` unknown account.

### `POST /api/accounts/{id}/balances`

Plain balance point (tracking-account updates — no reconcile math).

Request: `{ "balance_fils": 500000, "as_of": "2026-07-01T10:00:00Z", "note": "opening" }`
(`as_of` optional RFC3339, defaults now; `balance_fils` may be negative).
An `as_of` carrying a UTC offset is accepted and **normalized to UTC** before
storing (all balance windows compare against UTC timestamps).

→ `201 { "ok": true, "id": 9 }`. `400` bad `as_of`.

### `POST /api/accounts/{id}/checkin`

The 30-second reconcile: user types the balance from the bank app.

Request: `{ "stated_fils": 70000, "note": "" }`

→ `200`:

```json
{
  "account_id": 1,
  "stated_fils": 70000,
  "expected_fils": 80000,
  "delta_fils": -10000,
  "since": "2026-07-01T10:00:00Z",
  "txn_count": 4,
  "unconverted_count": 0,
  "first_checkin": false,
  "balance_id": 10,
  "unparsed": [
    { "id": 88, "received_at": "2026-07-15T09:00:00Z", "from_addr": "bank@dib.ae", "subject": "Card transaction alert", "parse_error": "no amount found" }
  ]
}
```

- `expected_fils` = previous anchor + attributable signed activity since it.
  Activity follows the app-wide **AED convention**: a foreign-currency
  transaction with no FX rate configured contributes **nothing** (never its
  raw foreign minor units) until a rate is added — the same rule as jars and
  envelopes.
- `unconverted_count` is how many transactions in the window are such no-rate
  foreign rows. Non-zero means part of any delta is explained by them: render
  it as a named discrepancy cause ("N foreign transactions await an FX rate"),
  next to `unparsed`. `0` when all rows carry AED values.
- The activity window is **day-granular**: a check-in states the balance as of
  the **end of its calendar day**, so transactions dated the same day as the
  previous anchor count as already inside it and only later days accumulate.
  (Bank-parsed `posted_at` is a bare date; residual ambiguity — e.g. the bank
  app's balance already including a next-day-dated GST line — surfaces as a
  small delta that the next check-in absorbs.)
- `delta_fils = stated − expected`. `0` ⇒ books match.
- The stated balance **is persisted immediately** as the new anchor
  (`balance_id`) — it is the bank's truth regardless of the delta.
- `unparsed` (only populated when `delta_fils ≠ 0`, max 20, newest first)
  lists retained emails since the previous anchor that produced **no**
  transaction — candidate causes. `id` is the `ingest_log` id;
  `parse_error` omitted when empty. Fetch raw source via the existing
  transaction-email pattern is not possible for these (no transaction) —
  render subject/from/received.
- First check-in ever: `first_checkin: true`, `expected == stated`,
  `delta 0`, `since` omitted, `unparsed` `[]`.

### `POST /api/transactions` (changed)

The existing manual-entry endpoint gains an optional `account_id`. When set,
the transaction is stamped with that account's `last4`, so the entry
participates in check-in expected-balance math (`computed_fils`) and net
worth — the discrepancy card's "open manual entry" path converges the delta.
`400 {"error":"unknown account"}` on an unregistered id; omitted/`0` keeps
today's unattributed behavior.

### `POST /api/accounts/{id}/adjust`

Writes the reconciliation adjustment transaction (the "accept delta" tap).
Pass the check-in's `delta_fils` verbatim.

Request: `{ "delta_fils": -10000, "note": "ATM cash" }`

→ `201 { "ok": true, "transaction_id": 913 }`. `400` when `delta_fils` is 0.

Semantics: negative delta → a **debit** of |delta|, positive → credit. The
transaction is `status=confirmed`, `source=manual`, merchant
`"Balance adjustment"`, uncategorized (kept out of jar/envelope math), carries
the account's `last4`, and is **backdated to just before the latest anchor**
so `computed_fils` equals the stated balance after adjusting. Broadcasts the
`tx` SSE event.

---

## 5. Reports

### `GET /api/reports/networth?months=N`

`months` default 12, max 60. Month-end series, oldest first; always exactly
`N` entries ending at the current month.

```json
{
  "months": [
    { "month": "2026-06", "budget_fils": 100000, "tracking_fils": 500000, "networth_fils": 600000 }
  ]
}
```

Per account: latest balance anchor at/before month end + attributable signed
activity from anchor to month end. Accounts without a check-in yet (or
inactive) contribute nothing. Activity follows the app-wide AED convention: a
foreign-currency transaction with no FX rate yet contributes nothing until a
rate is added (same rule as the check-in's `expected_fils`).

### `GET /api/reports/income-expense?months=N`

`months` default 12, max 24. Confirmed transactions only; split lines count
under their own categories (parent never double-counts).

```json
{
  "months": ["2026-06", "2026-07"],
  "rows": [
    { "category_id": 2, "name": "Salary", "kind": "income", "by_month_fils": [300000, 300000], "total_fils": 600000, "avg_fils": 300000 },
    { "category_id": 5, "name": "Groceries", "kind": "spending", "by_month_fils": [45000, 52000], "total_fils": 97000, "avg_fils": 48500 }
  ],
  "net_by_month_fils": [255000, 248000]
}
```

- `by_month_fils` is index-aligned with `months`.
- Amounts are display-positive: income rows = income received, spending rows
  = net spend (refund credits subtract).
- Income rows sort first, then spending, alphabetical within each block.
- `net_by_month_fils` = income − expense per month.
- `avg_fils = total / N` (integer division). Categories with no activity in
  the window are absent.

### `GET /api/reports/age-of-money`

```json
{ "age_days": 24, "sample_size": 10 }
```

FIFO age of the last (≤10) funded spends: income credits fill a dated pool,
spends drain it oldest-first; a spend's age is days from the lot funding its
final fil. `sample_size: 0` ⇒ not computable yet (render "—").

---

## 6. Transaction depth

### `PUT /api/transactions/{id}/splits`

Replace-all split set. **Non-empty sets must sum exactly to the parent's
`amount`** (parent-currency minor units — put the rounding remainder on the
last line client-side). Every line's category must be an **active** category
of a kind the money aggregates count for the parent's direction: `spending`
for **debit** parents; `spending` (refund) or `income` for **credit**
parents. Anything else — missing, inactive, `excluded`-kind, or an
income-kind line on a debit — is refused with a 400 (those fils would
silently vanish from every surface). Empty array **un-splits**: the parent
returns to the review queue (`status: "needs_review"`, uncategorized) —
recategorize it via the normal categorize call. Un-splitting a transaction
that was never split is a no-op.

Request:

```json
{
  "splits": [
    { "category_id": 5, "amount_fils": 6000, "note": "mine" },
    { "category_id": 7, "amount_fils": 4000, "note": "" }
  ]
}
```

→ `200`:

```json
{
  "ok": true,
  "splits": [
    { "id": 1, "transaction_id": 42, "category_id": 5, "amount_fils": 6000, "note": "mine" },
    { "id": 2, "transaction_id": 42, "category_id": 7, "amount_fils": 4000 }
  ]
}
```

`404` unknown transaction. `400` with a precise message on bad lines
(`"invalid transaction splits: splits sum 9900 != parent amount 10000"`,
`"invalid transaction splits: line 2: category 9 is not an active category"`).
Splitting (non-empty set) clears the parent's `category_id` +
`bucket_snapshot` but never touches provenance, refund links, project links
or status; un-splitting (empty set) additionally sets the parent's status to
`needs_review` (see above). Broadcasts `tx`.

While a transaction is split, `POST /api/transactions/{id}/categorize`
returns `409 {"error":"transaction is split"}` — **both** branches: with a
`category_id` (the parent's category must stay `null`; its lines carry the
categories, categorizing it would double-count) and with `category_id`
null/0 (decategorizing would park a needs_review parent with lines still
attached, silently dropping the whole amount from every aggregate). Linking
a split **credit** as a refund is refused with the same 409. The one way out
of the split state is `PUT /splits` with an empty array.

Split lines feed **every** money aggregate under their own categories — the
Home 50/30/20 jars, insights category/trend, envelopes, income, and reports —
AED-scaled from the parent so the lines always sum to exactly the parent's
AED value; the parent never double-counts. Splitting a transaction therefore
never changes any period total, only its category breakdown. A split parent
also remains a refund-candidate purchase; linking a refund to it copies the
largest split line's category onto the credit.

### `GET /api/transactions/{id}/splits`

→ `200` array of split objects (above); `[]` when not split.

### `PUT /api/transactions/{id}/note`

User memo, distinct from the parsed description. `{"note":""}` clears.

Request: `{ "note": "team lunch" }` → `200 {"ok":true}` | `404`. Broadcasts `tx`.

### `GET /api/transactions` (changed items)

List items (Go-name keys, as before) gain three fields:

```json
{
  "ID": 42, "PostedAt": "…", "AmountFils": 10000, "…": "(existing fields)",
  "Note": "team lunch",
  "DisplayName": "Netflix",
  "Splits": [ { "ID": 1, "TransactionID": 42, "CategoryID": 5, "AmountFils": 6000, "Note": "mine" } ]
}
```

- `Note`: `""` when unset.
- `DisplayName`: merchant clean-name resolved from the highest-priority
  active exact/contains rule carrying a `display_name`; `""` when none.
- `Splits`: **absent** (omitted key) for unsplit transactions. Split parents
  additionally have `CategoryID: null`.
- The same three fields appear on `recent` items in `GET /api/summary`
  (`Note`/`DisplayName` only — `recent` is not split-decorated).

### `DELETE /api/categories/{id}` (changed)

The 409 guard now counts transactions **plus split lines** in `transactions`,
and additionally blocks when the category has non-zero envelope assignments
(they are cascade-deleted, which would silently rewrite past budget months):
`409 {"error":"in use","transactions":N,"rules":M,"assignments":K}`.
`GET /api/categories/{id}/usage` returns the same three counts. Zero-amount
assignment rows, targets, and schedule references never block (targets die
with the category; schedules detach).

### `PUT /api/categories/{id}` (changed)

Changing `kind` away from `"spending"` is guarded the same way: with non-zero
envelope assignments on the books it returns
`409 {"error":"in use","assignments":K}` (the assignments would drop out of
the envelope summary and RTA would silently overstate). Zero the category's
assignments (or keep `kind: "spending"`) first. Name/bucket edits are never
blocked.

---

## 7. Notification settings

### `GET /api/settings/notifications`

```json
{ "notify_thresholds": true, "notify_upcoming_days": 3 }
```

Defaults (existing DBs migrate to these): thresholds **on**, horizon **3**
days. `notify_upcoming_days: 0` = upcoming/missed push off.

### `PUT /api/settings/notifications`

Request/response: same shape. `notify_upcoming_days` must be 0..60 → else
`400`. This endpoint is the **only** writer of these fields — the existing
`PUT /api/settings` never touches them (and vice versa).

---

## 8. SSE + push events

All SSE events arrive on the existing `GET /api/events` stream as
`data: {"type":"<type>","data":<payload>}` lines. Push notifications (Web
Push, `{"title","body"}`) fire only when VAPID is configured, and are gated
per the table:

| event | SSE | push | payload |
|---|---|---|---|
| `budget_threshold` | only when `notify_thresholds` | same gate | see below |
| `upcoming_bill` | only when `notify_upcoming_days > 0` | same gate | schedule object + `due_in_days` |
| `missed_bill` | **always** | when `notify_upcoming_days > 0` | schedule object |
| `schedule_detected` | **always** | when `notify_upcoming_days > 0` | schedule object |

(`missed_bill`/`schedule_detected` SSE stays on regardless of settings so the
UI's Recurring lists refresh live; the settings gate the interrupting push.)

### `budget_threshold` payload

```json
{
  "scope": "envelope",
  "category_id": 5,
  "name": "Groceries",
  "bucket": "need",
  "level": 80,
  "activity_fils": 90000,
  "limit_fils": 100000,
  "month": "2026-07"
}
```

- `scope`: `"envelope"` (limit = carryover + assigned) or `"bucket"` (limit =
  income × bucket pct — the jar target; `category_id` omitted, `name` is the
  bucket name).
- `level`: `80` or `100`. Emitted **once per upward crossing** per month
  (in-memory state; a restart re-primes silently, never re-spams).
  Evaluated after every transaction confirm/categorize, split change,
  envelope assignment, and each ingest insert.

### `upcoming_bill`

Emitted by an hourly server sweep (and once at startup) for active schedules
entering the `notify_upcoming_days` horizon — **once per (schedule,
next_due)**; when a bill is matched/paid its `next_due` advances and re-arms.
Payload = full schedule object plus `due_in_days` (negative = overdue).

### `missed_bill`

Fired from the recurring sweep when a schedule passes next_due + grace with no
matching email. The sweep runs after every ingest batch **and** on the hourly
notifier tick, so detection is clocked by time even while IMAP is unreachable;
worst-case latency from the grace deadline is one tick. Payload = full
schedule object (`missed: true`).

### `schedule_detected`

Fired when the detector proposes a new recurring bill (after ingest batches
that created transactions, and after reprocess). Payload = full schedule
object (`status: "proposed"`, with `provenance`).

A committed `ledger import` also runs detection, but as a separate process it
only **persists** the proposals — no SSE/push fires for them. They appear on
the next `GET /api/scheduled`, so refetch after an import rather than waiting
for an event.

### Existing events (unchanged, for reference)

`new_transaction` `{id, merchant_raw, amount, direction}` · `tx` (null data —
invalidate transaction queries; now also fired by splits/note/adjust writes) ·
`drift_alert` · `heartbeat`.
