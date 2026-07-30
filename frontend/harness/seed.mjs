// Seeds a scratch ledger DB over the HTTP API with data shaped for UI review.
//
// Deliberately includes the cases that break mobile layouts — a merchant name
// longer than the viewport, a seven-figure amount, a foreign-currency row, a
// negative (over-assigned) envelope, an unregistered account — so a screenshot
// pass sees the hard cases, not just the happy path.
//
// Usage: node harness/seed.mjs [baseUrl]
const BASE = process.argv[2] || process.env.LEDGER_API || "http://127.0.0.1:8099";

// Deterministic PRNG (mulberry32) so repeated seeds produce byte-identical
// screenshots — a visual diff should only ever show a real UI change.
let _s = 0x9e3779b9;
const rnd = () => {
  _s |= 0;
  _s = (_s + 0x6d2b79f5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => Math.floor(lo + rnd() * (hi - lo));

const TODAY = new Date("2026-07-30T12:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};

let failures = [];
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    failures.push(`${method} ${path} -> ${res.status} ${text.slice(0, 160)}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const cats = await api("GET", "/api/categories");
  const byName = Object.fromEntries(cats.map((c) => [c.Name, c.ID]));
  const spend = cats.filter((c) => c.Kind === "spending");

  // ---- budget -------------------------------------------------------------
  await api("PUT", "/api/budget", {
    monthly_income: 2_500_000, // AED 25,000.00
    need_pct: 0.5,
    want_pct: 0.3,
    saving_pct: 0.2,
    income_source: "categories",
    freeze_history: false,
  });

  // ---- accounts -----------------------------------------------------------
  // The third name is intentionally long: it is the horizontal-overflow probe.
  const accountSpecs = [
    { name: "Emirates NBD Current", bank: "ENBD", last4: "4412", kind: "budget", open: 4_182_350 },
    { name: "DIB Everyday Credit Card", bank: "DIB", last4: "8891", kind: "budget", open: -1_247_800 },
    {
      name: "Sarwa Long-Term Investment & Retirement Portfolio",
      bank: "Sarwa",
      last4: "0021",
      kind: "tracking",
      open: 18_940_500,
    },
    { name: "Cash", bank: "", last4: "9999", kind: "budget", open: 55_000 },
  ];
  const accounts = [];
  for (const a of accountSpecs) {
    const created = await api("POST", "/api/accounts", { name: a.name, bank: a.bank, last4: a.last4 });
    if (!created) continue;
    const id = created.id ?? created.ID ?? created;
    if (a.kind === "tracking") await api("PUT", `/api/accounts/${id}`, { kind: a.kind });
    accounts.push({ ...a, id });
  }

  // ---- balance history (net worth chart needs several anchors) ------------
  for (const a of accounts) {
    let bal = a.open;
    for (let m = 6; m >= 0; m--) {
      const drift = a.kind === "tracking" ? between(120_000, 420_000) : between(-180_000, 220_000);
      bal += drift;
      await api("POST", `/api/accounts/${a.id}/balances`, {
        balance_fils: bal,
        as_of: daysAgo(m * 30 + 2).toISOString(),
        note: m === 0 ? "" : "monthly statement",
      });
    }
  }

  // ---- FX rates -----------------------------------------------------------
  await api("PUT", "/api/rates/USD", { rate: 3.6725 });
  await api("PUT", "/api/rates/EUR", { rate: 3.9812 });
  // GBP deliberately left unset so the "missing rate" warning surface renders.

  // ---- transactions -------------------------------------------------------
  const MERCHANTS = [
    ["CARREFOUR MALL OF EMIRATES", "Groceries", 8_000, 42_000],
    ["SPINNEYS DUBAI MARINA", "Groceries", 5_000, 31_000],
    ["TALABAT", "Dining", 3_500, 14_000],
    ["STARBUCKS DIFC", "Dining", 1_800, 4_500],
    ["CAREEM RIDE", "Transport", 1_200, 8_800],
    ["ENOC PETROL STATION", "Transport", 9_000, 22_000],
    ["NETFLIX.COM", "Subscriptions", 5_600, 5_600],
    ["SPOTIFY AB", "Subscriptions", 2_199, 2_199],
    ["AMAZON.AE", "Shopping", 4_000, 68_000],
    ["NOON.COM", "Shopping", 3_000, 45_000],
    ["VOX CINEMAS", "Entertainment", 5_000, 14_000],
    ["DU TELECOM", "Utilities", 12_000, 31_000],
    ["DEWA", "Utilities", 22_000, 64_000],
    ["ASTER PHARMACY", "Healthcare", 2_500, 18_000],
    // The overflow probe: longer than any mobile viewport at any font size.
    [
      "CARREFOUR HYPERMARKET SHEIKH ZAYED ROAD BRANCH MALL OF THE EMIRATES DUBAI UNITED ARAB EMIRATES",
      "Groceries",
      15_000,
      15_000,
    ],
  ];

  const created = [];
  for (let day = 165; day >= 0; day--) {
    const n = between(0, 4);
    for (let i = 0; i < n; i++) {
      const [merchant, catName, lo, hi] = pick(MERCHANTS);
      const r = await api("POST", "/api/transactions", {
        posted_at: iso(daysAgo(day)),
        amount_fils: between(lo, hi + 1),
        currency: "AED",
        direction: "debit",
        merchant_raw: merchant,
        category_id: byName[catName] ?? 0,
        account_id: pick(accounts.filter((a) => a.kind === "budget")).id,
      });
      if (r) created.push({ id: r.id, day, merchant });
    }
    // Monthly salary on the 28th.
    const d = daysAgo(day);
    if (d.getUTCDate() === 28) {
      await api("POST", "/api/transactions", {
        posted_at: iso(d),
        amount_fils: 2_500_000,
        currency: "AED",
        direction: "credit",
        merchant_raw: "SALARY TRANSFER - EMPLOYER LLC",
        category_id: byName["Salary"],
        account_id: accounts[0].id,
      });
    }
    // Monthly saving + investment on the 2nd, so the saving bucket is never
    // an all-zero row — a budgeting app reviewed with an empty third bucket
    // is being reviewed in a state its user would never be in.
    if (d.getUTCDate() === 2) {
      await api("POST", "/api/transactions", {
        posted_at: iso(d),
        amount_fils: 300_000,
        currency: "AED",
        direction: "debit",
        merchant_raw: "STANDING ORDER - SAVINGS",
        category_id: byName["Savings"],
        account_id: accounts[0].id,
      });
      await api("POST", "/api/transactions", {
        posted_at: iso(d),
        amount_fils: 200_000,
        currency: "AED",
        direction: "debit",
        merchant_raw: "SARWA INVEST TOPUP",
        category_id: byName["Investments"],
        account_id: accounts[0].id,
      });
    }
    // Rent on the 1st.
    if (d.getUTCDate() === 1) {
      await api("POST", "/api/transactions", {
        posted_at: iso(d),
        amount_fils: 750_000,
        currency: "AED",
        direction: "debit",
        merchant_raw: "AL HABTOOR PROPERTIES RENT",
        category_id: byName["Rent"],
        account_id: accounts[0].id,
      });
    }
  }

  // The widest amount string the formatter realistically emits (AED 250,000.00).
  // Marked as a transfer and dated to a previous month so it stresses row
  // layout everywhere without distorting the current month's budget maths —
  // the default view has to look like a normal month, or every screenshot is
  // reviewing an edge case instead of the product.
  const bigTx = await api("POST", "/api/transactions", {
    posted_at: iso(daysAgo(45)),
    amount_fils: 25_000_000,
    currency: "AED",
    direction: "debit",
    merchant_raw: "EMIRATES NBD PROPERTY DOWNPAYMENT",
    category_id: 0,
    account_id: accounts[0].id,
  });
  if (bigTx) await api("POST", `/api/transactions/${bigTx.id}/status`, { status: "transfer" });

  // Foreign currency (exercises the FX conversion display).
  await api("POST", "/api/transactions", {
    posted_at: iso(daysAgo(5)),
    amount_fils: 12_999,
    currency: "USD",
    direction: "debit",
    merchant_raw: "GITHUB INC",
    category_id: byName["Subscriptions"],
    account_id: accounts[1].id,
  });
  // Currency with no configured rate — the "missing rate" path.
  await api("POST", "/api/transactions", {
    posted_at: iso(daysAgo(4)),
    amount_fils: 4_500,
    currency: "GBP",
    direction: "debit",
    merchant_raw: "BBC STUDIOS LTD",
    category_id: byName["Entertainment"],
    account_id: accounts[1].id,
  });

  // A refund credit, and an uncategorized row, and an ignored row.
  await api("POST", "/api/transactions", {
    posted_at: iso(daysAgo(3)),
    amount_fils: 18_500,
    currency: "AED",
    direction: "credit",
    merchant_raw: "AMAZON.AE REFUND",
    category_id: byName["Reimbursements"],
    account_id: accounts[1].id,
  });

  // ---- review queue -------------------------------------------------------
  // Uncategorized rows flipped to needs_review so Review/swipe deck has stock.
  const reviewMerchants = [
    "UNKNOWN POS 884213",
    "PAYPAL *STEAMGAMES",
    "ETISALAT EMIRATES TELECOMMUNICATIONS GROUP COMPANY PJSC",
    "APPLE.COM/BILL",
    "TRF FROM 1234567890",
    "LULU HYPERMARKET",
    "DUBAI TAXI CORPORATION",
    "ADCB ATM WITHDRAWAL",
  ];
  for (let i = 0; i < reviewMerchants.length; i++) {
    const r = await api("POST", "/api/transactions", {
      posted_at: iso(daysAgo(i + 1)),
      amount_fils: between(2_000, 90_000),
      currency: "AED",
      direction: "debit",
      merchant_raw: reviewMerchants[i],
      category_id: 0,
      account_id: accounts[0].id,
    });
    if (r) await api("POST", `/api/transactions/${r.id}/status`, { status: "needs_review" });
  }

  // One ignored + one transfer so those filter states are non-empty.
  const ig = await api("POST", "/api/transactions", {
    posted_at: iso(daysAgo(7)),
    amount_fils: 100_00,
    currency: "AED",
    direction: "debit",
    merchant_raw: "TEST CHARGE REVERSED",
    category_id: 0,
    account_id: accounts[0].id,
  });
  if (ig) await api("POST", `/api/transactions/${ig.id}/status`, { status: "ignored" });
  const tr = await api("POST", "/api/transactions", {
    posted_at: iso(daysAgo(6)),
    amount_fils: 500_000,
    currency: "AED",
    direction: "debit",
    merchant_raw: "TRANSFER TO SARWA INVESTMENT",
    category_id: 0,
    account_id: accounts[0].id,
  });
  if (tr) await api("POST", `/api/transactions/${tr.id}/status`, { status: "transfer" });

  // ---- notes & splits on a real row --------------------------------------
  if (bigTx) {
    await api("PUT", `/api/transactions/${bigTx.id}/note`, {
      note: "Down payment — split across the joint account, reconcile with the bank statement before month close.",
    });
  }
  // Splits must sum to the parent amount, so read the real row first.
  const splitTarget = created[created.length - 3];
  if (splitTarget) {
    const all = await api("GET", "/api/transactions?limit=1000");
    const list = Array.isArray(all) ? all : (all?.items ?? []);
    const parent = list.find((t) => t.ID === splitTarget.id);
    if (parent) {
      const half = Math.floor(parent.AmountFils / 2);
      await api("PUT", `/api/transactions/${splitTarget.id}/splits`, {
        splits: [
          { category_id: byName["Groceries"], amount_fils: half },
          { category_id: byName["Dining"], amount_fils: parent.AmountFils - half },
        ],
      });
    }
  }

  // ---- rules --------------------------------------------------------------
  const rules = [
    { match_type: "contains", pattern: "carrefour", category_id: byName["Groceries"], priority: 10 },
    { match_type: "contains", pattern: "talabat", category_id: byName["Dining"], priority: 10 },
    { match_type: "exact", pattern: "NETFLIX.COM", category_id: byName["Subscriptions"], priority: 20 },
    { match_type: "regex", pattern: "^(CAREEM|UBER).*", category_id: byName["Transport"], priority: 15 },
    { match_type: "contains", pattern: "dewa", category_id: byName["Utilities"], priority: 10 },
    {
      match_type: "contains",
      pattern: "etisalat emirates telecommunications group company pjsc",
      category_id: byName["Utilities"],
      priority: 5,
    },
  ];
  for (const r of rules) await api("POST", "/api/rules", r);

  // ---- recurring / scheduled ---------------------------------------------
  const sched = [
    { merchant: "netflix.com", label: "Netflix", amount_fils: 5_600, interval_days: 30, next_due: iso(daysAgo(-3)), direction: "debit", category_id: byName["Subscriptions"] },
    { merchant: "spotify ab", label: "Spotify Premium", amount_fils: 2_199, interval_days: 30, next_due: iso(daysAgo(-11)), direction: "debit", category_id: byName["Subscriptions"] },
    { merchant: "al habtoor properties rent", label: "Rent", amount_fils: 750_000, interval_days: 30, next_due: iso(daysAgo(-2)), direction: "debit", category_id: byName["Rent"] },
    { merchant: "dewa", label: "DEWA utility bill — Dubai Electricity & Water Authority", amount_fils: 42_000, interval_days: 30, next_due: iso(daysAgo(1)), direction: "debit", category_id: byName["Utilities"] },
    { merchant: "salary transfer - employer llc", label: "Salary", amount_fils: 2_500_000, interval_days: 30, next_due: iso(daysAgo(-8)), direction: "credit", category_id: byName["Salary"] },
  ];
  for (const s of sched) await api("POST", "/api/scheduled", { ...s, tolerance_pct: 10, account_id: accounts[0].id });

  // ---- projects -----------------------------------------------------------
  const projects = [
    { name: "Japan Trip", budget_fils: 1_200_000, color: "#e07a5f", starts_on: iso(daysAgo(60)), ends_on: iso(daysAgo(-30)), status: "active", count_in_monthly: false },
    { name: "Home Office Refresh", budget_fils: 350_000, color: "#3d8361", starts_on: iso(daysAgo(120)), ends_on: iso(daysAgo(20)), status: "completed", count_in_monthly: true },
    { name: "Emergency Fund Top-Up (no budget set)", budget_fils: null, color: "#5b7fa6", starts_on: iso(daysAgo(30)), ends_on: "", status: "active", count_in_monthly: true },
  ];
  const projIds = [];
  for (const p of projects) {
    const r = await api("POST", "/api/projects", p);
    if (r) projIds.push(r.id ?? r.ID);
  }
  // Assign a handful of real transactions to the first project.
  if (projIds[0]) {
    for (const t of created.slice(0, 9)) {
      await api("POST", `/api/transactions/${t.id}/project`, { project_id: projIds[0] });
    }
  }

  // ---- targets + envelope assignments ------------------------------------
  const targets = [
    [byName["Rent"], { target_type: "refill", amount_fils: 750_000, cadence: "monthly" }],
    [byName["Groceries"], { target_type: "refill", amount_fils: 220_000, cadence: "monthly" }],
    [byName["Subscriptions"], { target_type: "set_aside", amount_fils: 30_000, cadence: "monthly" }],
    [byName["Savings"], { target_type: "save_by_date", amount_fils: 5_000_000, cadence: "monthly", due_date: "2027-01-31" }],
    [byName["Transport"], { target_type: "refill", amount_fils: 90_000, cadence: "monthly" }],
  ];
  for (const [cid, body] of targets) if (cid) await api("PUT", `/api/targets/${cid}`, body);

  const month = "2026-07";
  await api("POST", "/api/envelopes/assign", {
    month,
    assignments: [
      { category_id: byName["Rent"], assigned_fils: 750_000 },
      { category_id: byName["Groceries"], assigned_fils: 180_000 },
      { category_id: byName["Dining"], assigned_fils: 60_000 },
      { category_id: byName["Transport"], assigned_fils: 90_000 },
      { category_id: byName["Subscriptions"], assigned_fils: 30_000 },
      // Deliberately under-funded relative to spend → negative "available",
      // which is the state most likely to break the envelope row layout.
      { category_id: byName["Shopping"], assigned_fils: 5_000 },
      { category_id: byName["Savings"], assigned_fils: 400_000 },
    ].filter((a) => a.category_id),
  });

  // ---- a custom category with a long name --------------------------------
  await api("POST", "/api/categories", {
    name: "Professional Development & Continuing Education",
    kind: "spending",
    bucket: "want",
  });

  const summary = await api("GET", "/api/summary");
  const txns = await api("GET", "/api/transactions?limit=1000");
  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        accounts: accounts.length,
        transactions: Array.isArray(txns) ? txns.length : (txns?.items?.length ?? "?"),
        period: summary?.period,
        failures: failures.slice(0, 25),
        failureCount: failures.length,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("SEED FAILED", e);
  process.exit(1);
});
