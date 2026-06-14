# Real-Time Budgeting App — Build Plan

> A spec for Claude Code to build and deploy a private, self-hosted, mobile-first budgeting PWA on the remote server **dinosaur**. Working project name: **ledger** (rename freely). Currency context: **AED** (fils as minor units).

---

## 1. Goal

Replace batch PDF-extraction with a **real-time, event-driven** budget tracker. The event source is the per-transaction emails the banks already send. A single Go service watches a mailbox, parses each transaction email through a resilient extraction cascade, categorizes it (rules first, AI only as a fallback), stores it in SQLite, and serves a mobile PWA that shows live budget state against a customizable 50/30/20 plan.

The two friction points this must kill:
1. **Transaction logging** — fully automatic via the email stream; no manual entry, no PDF uploads.
2. **Categorization** — rules-first and self-improving, so it converges toward zero AI calls and full determinism, with a human-in-the-loop review queue for the uncertain remainder.

---

## 2. Core principles (do not violate)

- **Deterministic-first extraction, graceful fallback.** Field extraction runs a cascade — precise per-bank template, then a generic heuristic extractor, then (only on failure) an AI extractor whose output is *always* low-confidence and routed to review. The LLM is never the default extraction path and AI-extracted transactions are never auto-trusted. AI is the *primary* tool only for categorizing unknown merchants.
- **Nothing is ever silently dropped — and everything is recoverable.** Any email that no tier resolves goes to a visible review queue tagged `unparsed`. The full raw body of every email is retained, so a parser break is never permanent loss: fix the parser, reprocess, and the missing transactions backfill.
- **Self-improving rules.** Every manual or AI-confirmed categorization writes back a merchant→category rule. Known merchants never hit the LLM again.
- **Single binary, single process, single user.** No microservices, no message broker, no external DB server. One Go binary holds the ingest worker, the HTTP API, the SSE stream, and the embedded PWA. SQLite is the database.
- **Private and least-privilege.** Runs entirely on dinosaur, reachable only over a private network (Tailscale), never public. The mailbox credential is scoped as tightly as possible — read-only, and ideally a dedicated mailbox that holds *only* bank mail (§9). The only data that ever leaves the server is a bare merchant string sent to the AI for categorization, and that path is disableable.
- **Money is integer minor units.** Store amounts as `int64` fils (AED × 100). Never use floats for money.

---

## 3. Architecture

```
Banks ──txn email──▶ Primary mailbox
                          │  auto-forward rule (bank senders only)
                          ▼
                  Dedicated mailbox  (contains ONLY bank mail)
                          │  IMAP · read-only (EXAMINE) · TLS
                          ▼
            ┌─────────────────────────────────────────┐
            │  ledger (single Go binary on dinosaur)   │
            │                                          │
            │  Ingest ─▶ Parse cascade ─▶ Categorize   │
            │               │                 │        │
            │               └───────┬─────────┘        │
            │                       ▼                   │
            │                    SQLite                 │
            │                       │                   │
            │    HTTP API ◀─────────┴────────▶ SSE      │
            │         │                        │        │
            │    embed.FS (React PWA bundle)            │
            └─────────────────────────────────────────┘
                      │ HTTPS over Tailscale (required for PWA)
                      ▼
            Mobile PWA (dashboard · review · transactions)
```

**Mailbox approach — forward to a dedicated mailbox (recommended default).** Set an auto-forward rule in your primary mail provider that forwards bank-transaction senders to a **separate, dedicated mailbox** the app reads over IMAP. This is *not* running a mail server — the forwarding is done by your existing provider; the destination is just another hosted inbox. The win is least privilege: the app's credential only ever has access to a mailbox containing nothing but bank notifications, so a compromise of dinosaur exposes bank alerts, not your entire personal email. (See §9 for the full reasoning.)

Fallbacks, in order of preference: forward to a dedicated mailbox (best) → if forwarding is blocked, read your primary mailbox directly but filter bank mail to one folder and accept that the credential is broader → only run your own mail server if you truly want zero third parties (heavy; not recommended here). **Avoid** inbound-email-to-webhook services — they insert a third party that parses your bank email content.

The worker holds an IMAP IDLE connection (falling back to a 30–60s poll if IDLE is unavailable) and opens the mailbox **read-only**.

---

## 4. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Language | **Go** (1.22+) | Single static binary; great for one process doing IMAP + HTTP concurrently. |
| Database | **SQLite** via `modernc.org/sqlite` | Pure Go, **no cgo** → `CGO_ENABLED=0` static binary, trivial cross-compile and deploy. |
| HTTP | stdlib `net/http` (1.22 routing) | Add `chi` only if routing gets unwieldy. Avoid heavy frameworks. |
| IMAP | `github.com/emersion/go-imap` (IDLE-capable version) | Use IDLE; poll fallback. `github.com/emersion/go-message` for MIME/body parsing. OAuth2 (XOAUTH2) support required (§9). |
| Real-time | Server-Sent Events (stdlib) | Single user → SSE is plenty; no WebSocket needed. |
| Push alerts | Web Push (VAPID) | e.g. `github.com/SherClockHolmes/webpush-go`. Optional, build last. |
| Config | TOML file + env overrides | `github.com/BurntSushi/toml`. Secrets via env / systemd credentials. |
| AI | Anthropic API over `net/http` | Pluggable behind interfaces; disableable. Used for categorization and, as a gated last resort, extraction. Model + thresholds configurable. |
| Frontend | **React 18 + TypeScript + Vite**, TanStack (Router / Query / Table), **XP.css** theme, `vite-plugin-pwa` | Built to static assets, embedded via `embed.FS`. Node/Vite are **build-time only**; runtime stays a single Go binary. |
| Deploy | systemd unit on dinosaur + Tailscale (or Caddy) | HTTPS is mandatory for service workers. |

The frontend is a normal Vite/React app during development and CI; `npm run build` emits static assets that are copied into the Go module and embedded with `embed.FS`. The server (dinosaur) **never runs Node** — it serves the embedded bundle from the single binary, so the "single binary, single process" principle in §2 still holds.

---

## 5. Data model (SQLite)

All schema is created idempotently on startup (`CREATE TABLE IF NOT EXISTS`). Amounts are `INTEGER` fils.

```sql
-- Bank accounts the user holds
CREATE TABLE accounts (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,          -- "Emirates NBD Current"
  bank       TEXT NOT NULL,          -- bank key, matches a parser
  last4      TEXT,                   -- last 4 of card/account, for matching emails
  currency   TEXT NOT NULL DEFAULT 'AED',
  is_active  INTEGER NOT NULL DEFAULT 1
);

-- Categories. Bucket assignment is USER-EDITABLE (see §6.6).
CREATE TABLE categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,    -- "Groceries", "Rent", "Dining"
  kind      TEXT NOT NULL DEFAULT 'spending',  -- 'spending' | 'income' | 'excluded'
  bucket    TEXT,                    -- 'need' | 'want' | 'saving'  (only when kind='spending')
  parent_id INTEGER REFERENCES categories(id),  -- sub-categories, for split cases
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Merchant -> category rules (the self-improving lookup)
CREATE TABLE rules (
  id          INTEGER PRIMARY KEY,
  match_type  TEXT NOT NULL,         -- 'contains' | 'exact' | 'regex'
  pattern     TEXT NOT NULL,         -- matched against merchant_raw (case-insensitive)
  category_id INTEGER NOT NULL REFERENCES categories(id),
  priority    INTEGER NOT NULL DEFAULT 100,  -- lower = checked first
  source      TEXT NOT NULL,         -- 'manual' | 'ai_confirmed'
  created_at  TEXT NOT NULL
);

-- Raw ingest log: every email seen, parsed or not. Nothing is ever dropped.
-- raw_body is retained IN FULL so emails can be reprocessed after a parser fix.
CREATE TABLE ingest_log (
  id            INTEGER PRIMARY KEY,
  message_uid   TEXT UNIQUE,         -- IMAP UID, for resume/idempotency
  received_at   TEXT,
  from_addr     TEXT,
  subject       TEXT,
  bank_detected TEXT,                -- null if unknown sender
  parse_status  TEXT NOT NULL,       -- 'parsed' | 'unparsed' | 'low_confidence' | 'ignored'
  parse_tier    TEXT,                -- 'template' | 'heuristic' | 'ai' | null
  parse_error   TEXT,
  structure_sig TEXT,                -- fingerprint of body structure, for drift detection
  raw_body      TEXT,                -- FULL body, retained for reprocessing
  created_at    TEXT NOT NULL
);

-- The transactions themselves
CREATE TABLE transactions (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER REFERENCES accounts(id),
  posted_at       TEXT NOT NULL,     -- ISO8601, from the email
  amount          INTEGER NOT NULL,  -- fils, always positive; sign comes from direction
  currency        TEXT NOT NULL DEFAULT 'AED',
  direction       TEXT NOT NULL,     -- 'debit' | 'credit'
  merchant_raw    TEXT,              -- raw string from email
  description     TEXT,
  category_id     INTEGER REFERENCES categories(id),
  bucket_snapshot TEXT,              -- set ONLY when budget.freeze_history = true (see §6.6)
  status          TEXT NOT NULL,     -- see status state machine below
  confidence      REAL,              -- categorizer/extractor confidence 0..1
  fingerprint     TEXT NOT NULL,     -- dedup key, see §6.4
  source          TEXT NOT NULL DEFAULT 'email',  -- 'email' | 'import' | 'manual'
  ingest_id       INTEGER REFERENCES ingest_log(id),  -- null for imported/manual
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_tx_posted ON transactions(posted_at);
CREATE INDEX idx_tx_status ON transactions(status);
CREATE UNIQUE INDEX idx_tx_fingerprint ON transactions(fingerprint);

-- Budget configuration (singleton)
CREATE TABLE budget_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  monthly_income  INTEGER NOT NULL,   -- fils; base for 50/30/20 when income_source='config'
  need_pct        REAL NOT NULL DEFAULT 0.50,
  want_pct        REAL NOT NULL DEFAULT 0.30,
  saving_pct      REAL NOT NULL DEFAULT 0.20,
  income_source   TEXT NOT NULL DEFAULT 'config',  -- 'config' | 'categories'
  freeze_history  INTEGER NOT NULL DEFAULT 0       -- 1 = snapshot bucket per transaction
);

-- Optional: web push subscriptions
CREATE TABLE push_subscriptions (
  id         INTEGER PRIMARY KEY,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Bulk import batches, for auditability and resumable seeding (§6.9)
CREATE TABLE import_log (
  id           INTEGER PRIMARY KEY,
  file_name    TEXT,
  rows_total   INTEGER,
  rows_added   INTEGER,
  rows_skipped INTEGER,   -- dedup collisions
  rows_review  INTEGER,   -- routed to needs_review
  rows_error   INTEGER,
  created_at   TEXT NOT NULL
);
```

**Transaction status state machine:**

```
needs_review ──(user/auto categorize)──▶ confirmed
needs_review ──(user marks)────────────▶ transfer   (excluded from spend)
needs_review ──(user marks)────────────▶ ignored
parsed ──(rule matched, high confidence)─▶ confirmed   (auto)
parsed ──(AI categorize, low conf)──────▶ needs_review
parsed ──(AI/heuristic extraction)──────▶ needs_review  (extraction was a fallback)
```

A transaction reaches the dashboard's spend totals only when `confirmed`, `direction = debit`, its category `kind = spending`, and it is not a `transfer`.

---

## 6. Components

### 6.1 Ingest worker

- On startup, connect to IMAP over TLS using the configured auth (§9); open the mailbox **read-only** (IMAP `EXAMINE`, never `SELECT`) so the app can never alter or delete mail.
- **Backfill:** fetch UIDs not already in `ingest_log` (resume via stored UIDs), process oldest→newest.
- **Live:** hold an IMAP IDLE connection; on new mail, process immediately. If the server doesn't support IDLE, poll every `poll_interval`.
- For each message: write an `ingest_log` row first (recording the **full raw body**, so it's never lost even if parsing fails), compute a structure signature, detect the bank, then run the parse cascade (§6.2).
- Robust to reconnects (network drops, server timeouts): exponential backoff, resume from last UID.

### 6.2 Parsing — resilient extraction cascade

Format drift is the main threat to extraction, so parsing is a **cascade with graceful degradation**, not one rigid template. Each email descends the ladder and stops at the first tier that yields a *validated, confident* result:

1. **Per-bank template** (default path, handles ~all email). Precise, fast, free. Anchored on **stable semantic labels in the plain-text body** ("the value after `Amount`"), never on HTML structure or cell positions — banks restyle layout often but rarely rename labels. Strip HTML to text first, then match labels.
2. **Generic heuristic extractor** (template miss). Bank-agnostic patterns for the *shape* of a transaction: any currency+amount token, any plausible date, a merchant-like string near keywords (`at`, `to`, `merchant`). Lower confidence; recovers core fields through cosmetic redesigns.
3. **AI extractor** (heuristic weak/failed; only if AI enabled). Operates on the single short email body. Output is **always written low-confidence → `needs_review`, never auto-trusted.** This is the one deliberate, gated use of AI in extraction — the rare drift case, where the alternative is losing the transaction entirely.
4. **Review-queue floor.** Anything still unresolved is logged `unparsed` and surfaced for review. Never discarded.

**Field validation gates every tier.** Amount must parse as a real number with a currency; date must be plausible; direction must be `debit|credit`; account must resolve via `last4`. A field that fails validation drops the result's confidence and routes it to review — this catches the subtle post-redesign failure where a parser "succeeds" but grabs the wrong number.

```go
type ParsedTxn struct {
    PostedAt    time.Time
    AmountFils  int64
    Currency    string
    Direction   string  // "debit" | "credit"
    MerchantRaw string
    Last4       string
    IsTransfer  bool
    Confidence  float64
    Tier        string  // "template" | "heuristic" | "ai"
}

type BankParser interface {
    Bank() string
    Matches(from, subject string) bool       // cheap sender/subject check
    Parse(textBody string) (ParsedTxn, error) // template tier; anchor-based
}
// The generic heuristic extractor and the AI extractor are bank-agnostic
// fallbacks the worker invokes when no BankParser matches or validation fails.
// Validate(ParsedTxn) error gates the result regardless of tier.
```

**Raw retention + reprocessing = recoverability.** Because `ingest_log.raw_body` keeps the original email, a format change is never permanent loss. Recovery loop: drift alert → inspect the new format sitting in review → update/extend the template (or let the AI tier clear the backlog) → **reprocess** the affected `unparsed`/`low_confidence` rows → missing transactions backfill.

**Drift monitoring (active).** Track a rolling per-bank parse-success rate and which tier resolved each email. A bank that normally parses cleanly but suddenly leans on the heuristic/AI tiers, or starts failing, is a drift signal → push alert ("ENBD emails stopped parsing — parser needs attention"). Cheap companion check: emails from a known sender arriving but none parsing → flag. Optional: compare the stored `structure_sig` per sender and alert when it shifts, catching drift *before* extraction fails. Optional nice-to-have: on drift, have the AI propose an updated extraction pattern for you to confirm.

- **Claude Code cannot write the per-bank templates without sample emails** — see §11. Build the **heuristic and AI tiers (bank-agnostic) up front** so the system degrades gracefully even before every bank has a template, and stub one template parser with a fixture-driven test harness so adding/fixing banks is mechanical.

### 6.3 Categorizer (rules first, AI fallback)

For each successfully extracted transaction:
1. **Rules pass.** Match `merchant_raw` against `rules` (by `priority`, case-insensitive). On hit → set `category_id`, `status = confirmed`, no AI call.
2. **AI fallback** (only on miss, only if enabled). Send the LLM **only the merchant string** plus the list of active categories; require strict JSON `{category, confidence}`.
   - `confidence >= auto_accept_threshold` → set category, `status = confirmed`, and **propose a rule** (one-tap confirm, or auto-created if `auto_rule = true`).
   - else → `status = needs_review`.
3. **No AI / disabled / error** → `status = needs_review`. Never block ingestion on the LLM.

Note: a transaction extracted by the heuristic/AI *extraction* tier is already `needs_review` regardless of categorization, because its fields are not fully trusted. The AI client is an interface (`Categorize(merchant string, cats []Category) (name string, conf float64, err error)`) so it can be swapped or mocked.

### 6.4 Dedup & reconciliation

- **Fingerprint:** `sha256(account_id | amount | direction | normalize(merchant_raw) | posted_date_rounded_to_day)`. Unique index prevents exact re-inserts (e.g. a duplicate forwarded email).
- **Pending vs posted:** on near-match (same account+amount+merchant within N hours, different UID), link and keep one canonical; flag for review if amounts differ.
- **Self-transfers:** if `IsTransfer` is set, or a debit on account A matches a credit on account B (same amount, close time), mark both `transfer` so they net to zero and never count as spend.
- **Refunds/reversals:** a credit matching a prior debit merchant is a negative expense, not income. Decide the sign convention in one place (the budget engine) and document it; surface ambiguous ones for review. *(The user's existing Excel already shows reversed amounts under expense flows — same ambiguity, handle it deliberately.)*

### 6.5 Budget engine (50/30/20)

- **Income base:** if `income_source = 'config'`, use `budget_config.monthly_income`; if `'categories'`, sum the month's `confirmed` credits in `income`-kind categories.
- **Spend per jar:** for the current month, sum `confirmed` debit transactions of `spending` categories per bucket (`need`/`want`/`saving`); exclude `transfer`/`ignored` and any `income`/`excluded` categories; net out refunds.
- **Bucket source:** when `freeze_history = false` (default), the jar is derived live from each category's *current* `bucket`, so reassigning a category reclassifies its history too. When `freeze_history = true`, use `transactions.bucket_snapshot`.
- Per bucket compute: target (`income × pct`), spent, remaining, % used, and a simple linear end-of-month projection.
- Recomputed on read (cheap at single-user scale) and pushed over SSE on every new confirmed transaction.

### 6.6 Categories, buckets & customization

The 50/30/20 jars are **fully user-defined**, not hardcoded. The bucket lives on each *category*, and a jar is just a live roll-up of the categories assigned to it.

- **Editable mapping.** Reassign any category between `need`/`want`/`saving` in Settings. Because jars are derived from the category, reassignment is instant and consistent.
- **Retroactive vs frozen history (one config choice).** Default `freeze_history = false`: a reassignment reclassifies that category's past *and* future transactions. With `freeze_history = true`, the bucket is snapshotted onto each transaction at categorization time (`bucket_snapshot`), so reassignment affects only future transactions, with an optional "apply to past?" action. Default is retroactive — simpler and matches how people reason about their own budget.
- **New categories need a bucket.** Whenever a category is created — including one the AI proposes for an unknown merchant — the review/categorize flow requires a bucket (with a suggested default the user can override), so nothing is ever bucket-less.
- **Income & excluded aren't jars.** `categories.kind` is `spending` (fills a jar), `income` (a salary credit feeds the income base, not a bucket), or `excluded` (reimbursable, internal, etc.). Percentages are computed against income; jars against spending.
- **Tunable split.** `need_pct`/`want_pct`/`saving_pct` are config, so 50/30/20 can become 60/20/20, etc., and the jars resize.
- **Splits → sub-categories, not fractions.** For "half need, half want" cases (groceries with treats), create sub-categories (`parent_id`) rather than fractional bucketing — one category, one jar, keeps the math simple.
- **Seed defaults** so it works day one: Rent/Utilities/Groceries → need; Dining/Entertainment/Shopping → want; Savings/Investments/Debt paydown → saving; Salary → kind `income`. User edits freely.

### 6.7 HTTP API

JSON over `net/http`. All under `/api`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/summary?period=current` | Bucket totals, targets, remaining, % used, projection |
| GET | `/api/transactions?status=&from=&to=&account=` | Filtered transaction list |
| GET | `/api/review` | Items needing attention (`needs_review`, `unparsed`, `low_confidence`) |
| POST | `/api/transactions/{id}/categorize` | `{category_id, make_rule:bool}` → confirm + optional rule write-back |
| POST | `/api/transactions/{id}/status` | `{status}` → mark `transfer`/`ignored`/`confirmed` |
| GET/POST | `/api/categories` | List / create (create requires `kind`, and `bucket` when spending) |
| PUT | `/api/categories/{id}` | Update name/kind/bucket; `{apply_to_past:bool}` honored when `freeze_history` |
| GET/POST/DELETE | `/api/rules` | Manage rules |
| GET/PUT | `/api/budget` | Read/update `budget_config` (income, %, income_source, freeze_history) |
| POST | `/api/reprocess` | `{bank?}` → re-run the parse cascade over retained raw emails (after a parser fix) |
| GET | `/api/events` | **SSE stream**: new transactions, summary updates, drift alerts |
| POST | `/api/push/subscribe` | Store a web push subscription |
| GET | `/api/health` | Liveness: IMAP connected, last ingest time, **per-bank parse-success / drift status** |

### 6.8 PWA frontend

**Stack.** React 18 + TypeScript, built with **Vite**. Routing via **TanStack Router**, server state via **TanStack Query**, data grids via **TanStack Table**. PWA behaviour (service worker, manifest, offline shell, installability) via **vite-plugin-pwa**. The built `dist/` is embedded into the Go binary (`embed.FS`); API and SPA are served from the same origin.

**Theme — Windows XP "Luna", mobile-first.** A touch-friendly homage to the XP desktop. Base the chrome on **XP.css** (`botoxparty/XP.css`) for windows, title bars, beveled buttons, sunken fields, group boxes, tabs, and segmented progress bars, then layer mobile-first overrides: full-width windows, ≥44px touch targets, larger type than XP's native ~8pt. **Self-host the fonts** (Tahoma / Trebuchet MS fallbacks, or the pixel MS-Sans web font XP.css ships) — no CDN, since the app is private and offline-capable.

> Keep it a clean homage: **do not** use Microsoft logos, the Windows flag, the "Start" wordmark, or the Bliss wallpaper. Use a generic green menu pill and a plain blue backdrop in place of trademarked assets.

Concrete visual tokens:
- Window surface: Luna gray-beige `#ECE9D8`.
- Title bar: Luna blue gradient (`#0058E6` → `#3F8CF5`), white bold Trebuchet text, rounded top corners, faux window buttons on the right.
- Beveled 3D edges via inset box-shadows (light top-left, dark bottom-right); buttons raised, `:active` sunken.
- Accent green `#3CA63C` for the menu button, the savings bucket, and progress fills.
- Inputs: white with a sunken inset border.
- Money rendered accounting-style (grouped thousands, negatives in red parentheses, dash for zero) inside XP fields/labels.

**Icons — Fugue icon pack** (Yusuke Kamiyamane). Use Fugue for all in-app iconography (tab/taskbar buttons, list-row and status glyphs, dialog buttons). They're 16px raster PNGs from the same mid-2000s desktop era, so they sit perfectly against the XP chrome. **Self-host** the set in the bundle (no CDN). Because they're raster, render at native 16px or an exact 2× (32px) inside the ≥44px touch targets — never upscale to arbitrary sizes, or they blur. A few mappings: dashboard `chart`/`money`, review `exclamation`/`flag`, transactions `table`, settings `gear`, transfer `arrow-switch`, confirmed `tick`, ignored `cross`.

> **License:** Fugue is **CC BY 3.0** — attribution is required. Credit "Fugue Icons by Yusuke Kamiyamane" in an About/Settings screen and keep a `NOTICE` file in the repo. (A paid license is available if you ever want to drop the attribution.) Verify the current terms on the icon set's site before shipping.

**Layout (mobile rendition of the desktop metaphor).**
- Each route renders as a **maximized window** filling the viewport: a fixed XP title bar on top (view name + faux window buttons) over a scrollable body.
- The **taskbar becomes the bottom tab bar** — a fixed blue-gradient bar with a green menu button (opens Settings as a Start-menu-style drawer) and taskbar-button tabs for **Dashboard / Review / Transactions**. The active tab renders pressed/sunken, like XP's active-window button. The review tab carries a count badge.
- Dialogs (e.g. categorize) render as **centered XP dialog windows** with a title bar and beveled OK/Cancel.
- Budget alerts (and drift alerts) may use a **system-tray balloon-tip** style popup in addition to real web push.

**Views.**
- *Dashboard* — three XP group boxes (Needs / Wants / Savings), each with a **segmented XP progress bar** (green → amber → red as spend approaches the bucket target), plus spent vs target, remaining, and a month-progress bar. Below: a live "recent transactions" list styled as an Explorer details view.
- *Review* — TanStack Table of items needing attention (`needs_review`, `unparsed`, `low_confidence`). Tapping a row opens the categorize **dialog** (category radio list + bucket selector for new categories + "Save as rule" checkbox + OK/Cancel). One-tap mark-as-transfer / ignore. Unparsed items show the raw email for context.
- *Transactions* — TanStack Table with filters (status, date range, account). Narrow screens collapse columns into list-row cards; wider screens show the Explorer details grid. Sorting/pagination via TanStack Table.
- *Settings* (Start-menu drawer) — monthly income & income source, the three bucket targets (%), **category→bucket assignment** (the three buckets as group boxes; each category shows its current jar with a tap-to-reassign dropdown; drag-between-boxes optional), category & sub-category CRUD with `kind`, rules CRUD, and the `freeze_history` toggle.

**Real-time.** Open `/api/events` (`EventSource`/SSE) on mount; on a new-transaction or drift event, invalidate the relevant TanStack Query keys (`summary`, `transactions`, `review`) so the dashboard and badges refresh live. Use an XP marquee/segmented bar for loading states.

**PWA specifics.** `vite-plugin-pwa` generates `sw.js` + `manifest.webmanifest`; cache the app shell so the dashboard opens offline (read-only); `display: standalone`. The **launcher/manifest icons** (192px, 512px) are separate larger original art — Fugue's 16px PNGs are for in-app UI only. Handle push for threshold and drift alerts.

### 6.9 Seeding & historical import

Day one must not be empty — the system is seedable from your existing history (the Excel "All Transactions" sheet and friends). Two seed paths, **both feeding the same persist pipeline as live email**:

1. **Email backfill** (already covered in §6.1): the worker backfills whatever bank emails exist in the mailbox. This only reaches as far back as mail retention, so it is not the full archive.
2. **Bulk file import** (the main path for "a lot of history"): a CLI subcommand imports a CSV/XLSX export of your historical transactions.

```bash
ledger import --file all-transactions.csv --map map.toml --dry-run   # validate, commit nothing
ledger import --file all-transactions.csv --map map.toml             # commit
```

Design points:

- **Shared persist path.** Factor a single `Persist(NormalizedTxn)` step that validation, dedup/reconciliation (§6.4), and storage all hang off. Both the email cascade and the importer normalize their input into the same shape and call it — one source of truth for fingerprinting, dedup, sign convention, and money normalization.
- **Idempotent and overlap-safe.** The importer computes the **same `fingerprint`** as the parser, so re-running an import never duplicates, and an imported historical purchase won't double-count against a later email for the same transaction where date ranges overlap. Imported rows carry `source = 'import'`.
- **Bootstraps the rules engine (the big win).** Historical transactions are already categorized, so the importer seeds the `categories` table (name + kind + bucket) from your taxonomy *and* derives an initial `rules` set from the most frequent historical merchant→category pairs. Live categorization is then mostly solved from day one and the AI rarely fires. It also seeds `budget_config` (income, %) from your Budget sheet.
- **Trusted status.** Imported, already-categorized rows land as `confirmed`. Rows whose category can't be mapped, or that look ambiguous (sign anomalies, unmatched account), land in `needs_review` instead — never dropped.
- **Mapping file.** `map.toml` declares the column mapping (your headers → fields) and a category-name mapping (Excel names → canonical categories/buckets). It handles AED amounts → `int64` fils, your date format → ISO8601, and your sign convention → `direction` + positive amount — watch the reversed-refund rows your Excel already has (§6.4).
- **Dry-run + report.** `--dry-run` validates and prints what *would* happen — rows to insert, dedup collisions skipped, unmapped categories, sign/parse anomalies — committing nothing, so you correct the mapping before touching the DB.
- **Transactional load.** Commit in batched SQLite transactions; resumable. `import_log` records each batch (file, counts) for auditability.

Optional later: a Settings "Import" screen wrapping the same path for CSV upload. The CLI is primary, since bulk seeding is a one-time admin operation that wants a dry-run.

---

## 7. Configuration

`config.toml` on dinosaur; **secrets never live in this file** — they come from the environment or systemd credentials (§9).

```toml
[server]
listen   = "127.0.0.1:8080"   # bound to localhost; Tailscale/Caddy fronts it
data_dir = "/var/lib/ledger"  # SQLite file lives here

[imap]
# Recommended: a DEDICATED mailbox receiving ONLY forwarded bank emails,
# so this credential can never read your personal mail (see §3, §9).
host          = "imap.example.com"
port          = 993               # implicit TLS; the server certificate is verified
username      = "bankmail@example.com"
auth          = "oauth2"          # "oauth2" (preferred) | "app_password"
folder        = "INBOX"           # dedicated mailbox → bank mail lands here
read_only     = true              # open with EXAMINE; the app can never alter mail
use_idle      = true
poll_interval = "60s"             # fallback if IDLE unsupported
# Secrets via env (never here):
#   oauth2:        LEDGER_IMAP_OAUTH_REFRESH_TOKEN, LEDGER_IMAP_OAUTH_CLIENT_ID, LEDGER_IMAP_OAUTH_CLIENT_SECRET
#   app_password:  LEDGER_IMAP_APP_PASSWORD

[ai]
enabled               = true       # false → fully local; everything uncertain goes to review
model                 = "claude-..."   # configurable; api key via env LEDGER_AI_API_KEY
auto_accept_threshold = 0.85       # >= this → auto-confirm category + propose rule
auto_rule             = false      # true = auto-create rule without confirmation
allow_ai_extraction   = true       # the gated last-resort extraction tier (§6.2)

[budget]
currency       = "AED"
monthly_income = 0                 # fils; used when income_source = "config"
income_source  = "config"          # "config" | "categories"
need_pct       = 0.50
want_pct       = 0.30
saving_pct     = 0.20
freeze_history = false             # true = snapshot bucket per transaction

[monitoring]
drift_window = "7d"                # rolling window for per-bank parse-success
drift_min    = 0.80                # alert if a bank's parse-success drops below this

# One block per bank; ties a sender to a parser
[[banks]]
key          = "enbd"
from_match   = "alerts@emiratesnbd.com"
subject_hint = ""
```

Env secrets: `LEDGER_IMAP_OAUTH_*` or `LEDGER_IMAP_APP_PASSWORD`, `LEDGER_AI_API_KEY`, `LEDGER_VAPID_PRIVATE` / `LEDGER_VAPID_PUBLIC`.

---

## 8. Build & deploy on dinosaur

**Build (two steps: frontend bundle → embedded static binary):**
```bash
# 1. Build the React/TanStack PWA (build machine / CI only)
cd web && npm ci && npm run build      # emits web/dist
cp -r web/dist ../internal/web/dist    # into the Go embed path

# 2. Build the cgo-free static binary that embeds the bundle
CGO_ENABLED=0 go build -o ledger ./cmd/ledger
```
Node is required at **build time only**. Cross-compile the Go step from the dev machine (`GOOS=linux GOARCH=<arch>`), or build on dinosaur if both Node and Go are present. The deployed artifact is a single binary.

**Layout on dinosaur:**
```
/usr/local/bin/ledger
/etc/ledger/config.toml          # 0644 (no secrets)
/etc/ledger/ledger.env           # 0600, secrets — or prefer systemd credentials (§9)
/var/lib/ledger/ledger.db        # SQLite, 0600
```

**Hardened systemd unit** (`/etc/systemd/system/ledger.service`):
```ini
[Unit]
Description=Ledger budgeting service
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/ledger -config /etc/ledger/config.toml
EnvironmentFile=/etc/ledger/ledger.env     # or use LoadCredential= (§9)
User=ledger
Restart=on-failure
RestartSec=5
StateDirectory=ledger
# --- sandboxing ---
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
ReadWritePaths=/var/lib/ledger

[Install]
WantedBy=multi-user.target
```

**HTTPS (mandatory — service workers require it):** prefer **Tailscale** for a private tailnet with HTTPS (`tailscale serve` / tailnet cert), so the PWA is reachable only from your own devices and never publicly exposed. Alternative: **Caddy** with a real domain for automatic Let's Encrypt certs. The Go service binds to `127.0.0.1` behind whichever you choose.

**Backups:** the database is one file. Use a cron `sqlite3 ledger.db ".backup"` snapshot or **Litestream** for continuous replication. Backups contain financial data — **encrypt them** if they leave the box (§9). Document the restore path.

---

## 9. Security & hardening

The mailbox credential is the most sensitive thing in the system; security concentrates there, then defends in depth.

**Connection.** Connect over implicit TLS (IMAPS, port 993) and **verify the server certificate** — never plaintext, never skip validation. Outbound only; the app never accepts inbound mail.

**Authentication.** Password-only IMAP is being eliminated by the major providers (Google enforced OAuth-only for IMAP/POP/SMTP in 2025; Microsoft is completing basic-auth removal by April 30, 2026), so the default is **OAuth2 (XOAUTH2)** — the app holds a *revocable token*, not your password, scoped read-only where the provider supports it (e.g. Gmail's `gmail.readonly`). For a personal Gmail account, a **16-character App Password** (requires 2-Step Verification) is an acceptable simpler fallback, but note it grants full-mailbox access — which is exactly why the dedicated mailbox below matters. **Never** use your primary account password.

**Least privilege, two ways.**
1. **Dedicated mailbox** (see §3): forward bank mail to a separate inbox the app reads, so the credential — however scoped — only ever has access to bank notifications, never your personal mail. A dinosaur compromise then leaks bank alerts, not your life.
2. **Read-only open:** the worker opens the mailbox with IMAP `EXAMINE`, so even a bug or compromise cannot delete or modify mail.

**Secret storage.** Tokens / app passwords never go in source or in `config.toml`. Use a `0600` `EnvironmentFile` owned by the `ledger` user, or better, systemd's encrypted credential store (`LoadCredential=` / `systemd-creds`). An OAuth refresh token is itself a long-lived bearer secret and gets the same treatment.

**Process & host isolation.** Run as a dedicated unprivileged user (never root) inside the systemd sandbox in §8. The SQLite file is `0600`. The HTTP server binds only to `127.0.0.1` and is reachable solely over the Tailscale tailnet — nothing is exposed to the public internet. The only outbound connections are the TLS mailbox link and, optionally, the AI API.

**AI data minimization.** The AI categorization call is the single point where data leaves the server, so it sends **only the bare merchant string** — never amounts, account numbers, balances, or identity. The AI extraction fallback (§6.2) sends a single email body only on the rare drift case. Setting `ai.enabled = false` keeps everything fully local; nothing ever leaves dinosaur.

**Backups.** Snapshots/replicas contain financial history — encrypt them at rest if they leave the box (e.g. age/gpg before upload, or Litestream to an encrypted bucket).

---

## 10. Build order (milestones)

Build in phases, each independently runnable and verifiable on dinosaur:

1. **Skeleton + deploy loop.** Go module, config loading, SQLite schema-on-startup, `net/http` serving a placeholder PWA, `/api/health`. Installed as the hardened systemd service behind Tailscale. *Verify: app loads over HTTPS on a phone.*
2. **Ingest (no parsing).** Connect IMAP with OAuth2, open the dedicated mailbox **read-only**, backfill + IDLE, write every message (full raw body) to `ingest_log`. *Verify: `ingest_log` fills as forwarded bank emails arrive; the app cannot alter mail.*
3. **Parse cascade + dead-letter.** Anchor-based template parser + the bank-agnostic heuristic and AI extraction tiers + field validation; unmatched/low-confidence → review; implement `/api/reprocess`. *Verify: real transactions appear; a deliberately broken template still degrades to heuristic/AI → review, and reprocessing after a fix backfills nothing-lost.*
4. **Categorizer.** Rules lookup, AI categorization behind interface, confidence + review routing, rule write-back. *Verify: known merchants auto-confirm with no AI call; AI receives only the merchant string.*
5. **Budget engine + customization + API.** 50/30/20 with income source + freeze_history modes, editable category→bucket mapping, full REST surface. *Verify: `/api/summary` matches a hand calculation; reassigning a category moves its spend between jars.*
6. **Seed / historical import.** The `ledger import` CLI with `map.toml`, dry-run, the shared `Persist` path, fingerprint-based dedup, and rules/category/budget bootstrap from history. *Verify: a dry-run reports cleanly; committing populates the dashboard with real months; re-running the import adds nothing (idempotent); seeded rules categorize new live transactions without the AI.*
7. **PWA (React + TanStack, XP theme).** Vite app embedded into the binary: dashboard, review (categorize dialog with bucket selector), transactions table, Settings (bucket assignment, %, rules), SSE live updates, installability. *Verify: live update on a new transaction; reassign a bucket in Settings and watch the dashboard recompute; installs to the home screen.*
8. **Hardening & monitoring.** Dedup, self-transfers, refunds/sign convention, **drift monitoring + alerts**, push alerts, encrypted backups. *Verify: a self-transfer nets to zero; a duplicate email doesn't double-count; simulating a format change raises a drift alert.*

---

## 11. What the user must provide

Claude Code can build everything except the per-bank templates without these. Gather before/at phase 3:

1. **Sample transaction emails** — 2–3 real examples per bank, per email type (purchase, transfer, refund/reversal). Redact account numbers but keep formatting and labels. These define the templates.
2. **Bank + account list** — each bank, the sender address(es) it mails from, and the last-4 to map emails to accounts.
3. **Mailbox setup** — the dedicated mailbox's provider, IMAP host/port, OAuth2 credentials (or app password), and confirmation that the auto-forward rule in the primary mailbox is in place and preserves the email body.
4. **Category taxonomy** — categories with each one's `kind` and (for spending) its 50/30/20 bucket, aligned to the existing Excel "Setup" / "Budget" sheets.
5. **Monthly income** figure (or choose `income_source = 'categories'` and tag income categories).
6. **Historical data export** — your existing transactions (e.g. the Excel "All Transactions" sheet) as CSV/XLSX, plus a category-name mapping (Excel names → canonical categories/buckets), so the archive can be imported and used to bootstrap rules and budget config (§6.9).

---

## 12. Explicit non-goals

- No multi-user / auth beyond the private network boundary (single user; Tailscale is the perimeter).
- No public internet exposure.
- **No AI as the default extraction path** — AI extraction is a gated, low-confidence, last-resort fallback only, always routed to review.
- No inbound-email-to-webhook third parties (they parse your bank email content).
- No message broker, no external database, no microservices.
- No Node or build toolchain at **runtime** on dinosaur (the frontend is pre-built and embedded; Node is build-time only).
