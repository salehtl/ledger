// The operator console.
//
// Plain DOM, no framework, no build step. See ui.go's header for why.
//
// Authority is the operator token in sessionStorage, sent as a bearer header on
// every request. It is never put in a cookie and never in a URL: a cookie would
// be attached to cross-origin requests and would need a CSRF defence, and a URL
// would put the credential in history and in any log that records a path.
//
// WHAT THIS FILE MUST NOT GROW: a view of transactions, amounts, merchants,
// balances or category detail. Every route it calls returns operational data
// only, and from Phase 3 the server cannot read anything else anyway.

"use strict";

const TOKEN_KEY = "ledger.admin.token";

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs, children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "text") n.textContent = v;
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children || []) if (c) n.append(c);
  return n;
};

// ── formatting ────────────────────────────────────────────────────────────

const fmtTime = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
};
const ago = (v) => {
  if (!v) return "never";
  const ms = Date.now() - new Date(v).getTime();
  if (!Number.isFinite(ms)) return "—";
  const h = Math.floor(ms / 3600000);
  if (h < 1) return "under an hour ago";
  if (h < 48) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
};
const short = (id) => (typeof id === "string" ? id.slice(0, 8) : "");
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

// ── transport ─────────────────────────────────────────────────────────────

let token = sessionStorage.getItem(TOKEN_KEY) || "";

async function req(method, path, body) {
  const init = { method, headers: { Authorization: "Bearer " + token } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    forgetToken("That token was refused.");
    throw new Error("unauthorized");
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.status + " " + res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message, isError) {
  const old = $(".toast");
  if (old) old.remove();
  const n = el("div", { class: isError ? "toast bad" : "toast", role: "status", text: message });
  document.body.append(n);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.remove(), 5000);
}

// ── the gate ──────────────────────────────────────────────────────────────

function forgetToken(reason) {
  token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  $("#shell").hidden = true;
  $("#gate").hidden = false;
  const err = $("#gate-error");
  err.hidden = !reason;
  err.textContent = reason || "";
  $("#token").value = "";
}

function openShell() {
  $("#gate").hidden = true;
  $("#shell").hidden = false;
  render();
}

// ── views ─────────────────────────────────────────────────────────────────

const VIEWS = {};
let current = "accounts";

function table(headers, rows, emptyText) {
  if (!rows.length) return el("div", { class: "empty", text: emptyText });
  const thead = el("thead", {}, [el("tr", {}, headers.map((h) => el("th", { text: h })))]);
  return el("div", { class: "table-wrap" }, [el("table", {}, [thead, el("tbody", {}, rows)])]);
}

function section(title, note, ...nodes) {
  return el("section", { class: "card" }, [
    el("div", { class: "section-head" }, [el("h2", { text: title })]),
    note ? el("p", { class: "section-note", text: note }) : null,
    ...nodes,
  ]);
}

function bar(n, d) {
  const p = pct(n, d);
  return el("div", { class: "row" }, [
    el("div", { class: "bar", title: p === null ? "no mail" : p + "%" }, [
      el("span", { style: "width:" + (p === null ? 0 : p) + "%" }),
    ]),
    el("span", { class: "tnum muted", text: p === null ? "—" : p + "%" }),
  ]);
}

// Accounts — the roster. Structural facts plus forwarding health, and the one
// lever that is not a deletion: pause and resume.
VIEWS.accounts = async (view) => {
  const data = await req("GET", "/admin/accounts");
  const rows = data.accounts.map((a) => {
    const health = !a.local_part
      ? el("span", { class: "pill pill-warn", text: "no address" })
      : !a.last_mail_at
        ? el("span", { class: "pill pill-bad", text: "no mail yet" })
        : el("span", { class: "muted", text: ago(a.last_mail_at) });

    // Pause and resume. The button offered is the one that changes the state
    // the row is in, so there is never a pair to choose between and never a
    // no-op click.
    //
    // Suspending asks first. It is reversible, but it stops a real person's
    // writes and holds their bank mail at the door, and it sits in a table the
    // operator is scrolling — a mis-click must not be the whole gesture. Resume
    // does not ask: it only ever gives access back.
    const suspended = a.status === "suspended";
    const action = el("button", {
      class: suspended ? "btn btn-sm btn-primary" : "btn btn-sm",
      type: "button",
      text: suspended ? "Resume" : "Pause",
      title: suspended
        ? "Accept writes and inbound mail from this account again."
        : "Refuse writes and hold inbound mail. Their devices keep reading their own data.",
    });
    action.addEventListener("click", async () => {
      if (
        !suspended &&
        !confirm(
          "Pause " +
            short(a.user_id) +
            "?\n\nTheir devices keep READING their own data, uploads are refused, and " +
            "their bank mail is told to retry rather than bounce. Reversible from this table.",
        )
      ) {
        return;
      }
      action.disabled = true;
      try {
        const base = "/admin/accounts/" + encodeURIComponent(a.user_id);
        await req("POST", base + (suspended ? "/resume" : "/suspend"));
        toast(suspended ? "Resumed " + short(a.user_id) + "." : "Paused " + short(a.user_id) + ".");
        render();
      } catch (e) {
        action.disabled = false;
        toast(e.message, true);
      }
    });

    return el("tr", {}, [
      el("td", { class: "mono", title: a.user_id, text: short(a.user_id) }),
      el("td", { class: "num", text: fmtTime(a.created_at) }),
      el("td", {}, [
        suspended
          ? el("span", { class: "pill pill-bad", text: "paused" })
          : el("span", { class: "pill pill-live", text: "active" }),
      ]),
      el("td", { class: "mono", text: a.local_part || "—" }),
      el("td", {}, [health]),
      el("td", { class: "num" }, [bar(a.parsed, a.arrivals)]),
      el("td", { class: "num", text: String(a.arrivals) }),
      el("td", { class: "num", text: String(a.held) }),
      el("td", { class: "num", text: String(a.devices) }),
      el("td", {}, [
        a.keys_published
          ? el("span", { class: "pill pill-live", text: "v" + (a.key_version || 1) })
          : el("span", { class: "pill pill-warn", text: "none" }),
      ]),
      el("td", {}, [action]),
    ]);
  });
  view.append(
    section(
      "Accounts",
      "One row per account. Parsed and arrivals cover the last 7 days; everything else is current state. " +
        "Nothing here reads the op log, so it keeps working after the transaction data is sealed. " +
        "Pausing an account refuses its writes and holds its mail; it keeps reading, and nothing is deleted.",
      table(
        [
          "Account",
          "Joined",
          "State",
          "Inbound address",
          "Last mail",
          "Parsed",
          "Arrivals",
          "Held",
          "Devices",
          "Keys",
          "",
        ],
        rows,
        "No accounts yet.",
      ),
    ),
  );
};

// Mail — accounting, per-sender parse rate, ingest failures, held mail.
VIEWS.mail = async (view) => {
  const acct = await req("GET", "/admin/accounting");
  const stat = (label, value, bad) =>
    el("div", { class: "stat" }, [
      el("span", { class: "label", text: label }),
      el("span", { class: bad ? "stat-value bad" : "stat-value", text: String(value) }),
    ]);
  const findings = acct.findings || [];
  view.append(
    section(
      "Every message accounted for",
      "The last 14 days. " +
        (findings.length
          ? "There are findings below. Read them before trusting the totals."
          : "No findings. The totals still cannot see the refusal classes listed as blind spots."),
      el("div", { class: "stats" }, [
        stat("Arrived", acct.inbound_total),
        stat("Placed", acct.arrival_sum),
        stat("Unaccounted", acct.unaccounted, acct.unaccounted > 0),
        stat("Refused at SMTP", acct.protocol_rejections_total),
        stat("Held", (acct.quarantine && acct.quarantine.held) || 0),
      ]),
      findings.length
        ? el("ul", { class: "bad" }, findings.map((f) => el("li", { text: String(f) })))
        : null,
      el("details", {}, [
        el("summary", { class: "label", text: "Full report" }),
        el("pre", { class: "out", text: JSON.stringify(acct, null, 2) }),
      ]),
    ),
  );

  // Parse rate by sender, computed from the diagnostics page. It is the drift
  // signal: a sender whose rate falls is a template that stopped matching.
  const diag = await req("GET", "/admin/diagnostics?event=arrival&limit=500");
  const bySender = new Map();
  for (const r of diag.rows) {
    const k = r.sender_domain || "(none)";
    const e = bySender.get(k) || { total: 0, matched: 0, empty: new Set(), last: null };
    e.total++;
    if (r.matched) e.matched++;
    for (const g of r.empty_groups || []) e.empty.add(g);
    if (!e.last || r.received_at > e.last) e.last = r.received_at;
    bySender.set(k, e);
  }
  const senders = [...bySender.entries()].sort((a, b) => b[1].total - a[1].total);
  view.append(
    section(
      "Parse rate by sender",
      "The last 500 arrivals" +
        (diag.complete ? "" : " (there are older ones this page does not cover)") +
        ". Empty groups name the capture groups that matched and captured nothing, which is what drift looks like.",
      table(
        ["Sender", "Arrivals", "Parsed", "Empty groups", "Last seen"],
        senders.map(([name, e]) =>
          el("tr", {}, [
            el("td", { class: "mono", text: name }),
            el("td", { class: "num", text: String(e.total) }),
            el("td", { class: "num" }, [bar(e.matched, e.total)]),
            el("td", { class: "mono", text: [...e.empty].join(", ") || "—" }),
            el("td", { class: "num", text: fmtTime(e.last) }),
          ]),
        ),
        "No arrivals recorded.",
      ),
    ),
  );

  const failed = diag.rows.filter((r) => !r.matched);
  view.append(
    section(
      "Arrivals that did not parse",
      "The same page, filtered. An account id is shown so a message can be traced; the message itself is not here.",
      table(
        ["Received", "Account", "Sender", "DKIM", "ARC", "Tier", "Outcome", "Reason"],
        failed.slice(0, 100).map((r) =>
          el("tr", {}, [
            el("td", { class: "num", text: fmtTime(r.received_at) }),
            el("td", { class: "mono", title: r.user_id || "", text: short(r.user_id) || "—" }),
            el("td", { class: "mono", text: r.sender_domain || "—" }),
            el("td", { class: "mono", text: r.dkim_result }),
            el("td", { class: "mono", text: r.arc_result }),
            el("td", { class: "mono", text: r.tier }),
            el("td", { class: "mono", text: r.outcome }),
            el("td", { class: "mono", text: r.reject_reason || "—" }),
          ]),
        ),
        "Every arrival on this page parsed.",
      ),
    ),
  );

  // Held mail is per account by design: the store's List takes a user id.
  const input = el("input", { class: "input", id: "q-user", placeholder: "account id", spellcheck: "false" });
  const out = el("div", {});
  const load = async () => {
    out.replaceChildren();
    const user = input.value.trim();
    if (!user) return;
    try {
      const q = await req("GET", "/admin/quarantine?user=" + encodeURIComponent(user));
      out.append(
        table(
          ["Received", "Expires", "Warned", "Outer domain", "Inner domain", "DKIM", "ARC", "Attested"],
          q.items.map((it) =>
            el("tr", {}, [
              el("td", { class: "num", text: fmtTime(it.received_at) }),
              el("td", { class: "num", text: fmtTime(it.expires_at) }),
              el("td", { class: "num", text: it.warned_at ? fmtTime(it.warned_at) : "—" }),
              el("td", { class: "mono", text: it.outer_domain || "—" }),
              el("td", { class: "mono", text: it.inner_domain || "—" }),
              el("td", { class: "mono", text: it.dkim }),
              el("td", { class: "mono", text: it.arc }),
              el("td", { class: "mono", text: it.attested ? it.attested_by || "yes" : "no" }),
            ]),
          ),
          "Nothing held for that account.",
        ),
      );
    } catch (e) {
      toast(e.message, true);
    }
  };
  const btn = el("button", { class: "btn", type: "button", text: "Show" });
  btn.addEventListener("click", load);
  view.append(
    section(
      "Held mail",
      "Mail waiting for the user to confirm its origin. Paste an account id from the Accounts table. " +
        "Raw messages are not shown here.",
      el("div", { class: "row" }, [el("div", { class: "field" }, [input]), btn]),
      out,
    ),
  );
};

// Templates — the parser roster, plus author, validate, publish, reprocess.
VIEWS.templates = async (view) => {
  const data = await req("GET", "/admin/templates");
  const out = el("div", {});
  const rows = data.templates.map((t) => {
    const act = (label, run) => {
      const b = el("button", { class: "btn btn-sm", type: "button", text: label });
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const res = await run();
          out.replaceChildren(
            el("p", { class: "label", text: label + " · " + t.id + " v" + t.version }),
            el("pre", { class: "out", text: JSON.stringify(res, null, 2) }),
          );
        } catch (e) {
          out.replaceChildren(
            el("p", { class: "label bad", text: label + " refused · " + e.message }),
            e.data ? el("pre", { class: "out", text: JSON.stringify(e.data, null, 2) }) : null,
          );
        } finally {
          b.disabled = false;
        }
      });
      return b;
    };
    const base = "/admin/templates/" + encodeURIComponent(t.id) + "/" + t.version;
    return el("tr", {}, [
      el("td", { class: "mono", text: t.id }),
      el("td", { class: "num", text: String(t.version) }),
      el("td", { class: "mono", text: t.bank }),
      el("td", {}, [
        el("span", {
          class: t.status === "published" ? "pill pill-live" : "pill",
          text: t.status,
        }),
      ]),
      el("td", { class: "num", text: String(t.normalizer_version) }),
      el("td", { class: "num", text: fmtTime(t.created_at) }),
      // A draft has no publication date, and showing its creation date under a
      // "Published" heading would say it is live.
      el("td", { class: "num", text: t.published_at ? fmtTime(t.published_at) : "—" }),
      el("td", {}, [
        el("div", { class: "row" }, [
          act("Validate", () => req("POST", base + "/validate")),
          act("Publish", () => req("POST", base + "/publish")),
          act("Publish, accepting changes", () => req("POST", base + "/publish", { accept_changes: true })),
          act("Reprocess", () => req("POST", base + "/reprocess")),
        ]),
      ]),
    ]);
  });

  view.append(
    section(
      "Templates",
      "Validate replays a version over the donated samples. Publish refuses if a sample stops parsing; " +
        "it also refuses if a sample parses to a different value, until you accept the change. " +
        "Reprocess re-parses mail this template could have changed.",
      table(
        ["Template", "Version", "Bank", "Status", "Normalizer", "Created", "Published", ""],
        rows,
        "No templates stored.",
      ),
      out,
    ),
  );

  const area = el("textarea", { class: "input", spellcheck: "false", placeholder: '{"id": "...", "version": 1, ...}' });
  const save = el("button", { class: "btn btn-primary", type: "button", text: "Save draft" });
  const authorOut = el("div", {});
  save.addEventListener("click", async () => {
    let definition;
    try {
      definition = JSON.parse(area.value);
    } catch (e) {
      toast("That is not valid JSON.", true);
      return;
    }
    save.disabled = true;
    try {
      const res = await req("POST", "/admin/templates", { definition });
      toast("Saved " + res.id + " v" + res.version + " as a draft.");
      render();
    } catch (e) {
      authorOut.replaceChildren(el("pre", { class: "out", text: e.message }));
    } finally {
      save.disabled = false;
    }
  });
  view.append(
    section(
      "New template version",
      "Paste a definition. It is stored as a draft; publishing is a separate step.",
      area,
      el("div", { class: "row" }, [save]),
      authorOut,
    ),
  );
};

// Donated formats — which untemplated layout the most people hit.
VIEWS.samples = async (view) => {
  const data = await req("GET", "/admin/samples");
  const rows = data.clusters.map((c) => {
    return el("tr", {}, [
      el("td", { class: "mono", text: c.sender_domain }),
      el("td", { class: "mono", title: c.structure_sig, text: short(c.structure_sig) }),
      el("td", { class: "num", text: String(c.user_count) }),
      el("td", { class: "num", text: String(c.sample_count) }),
      el("td", { class: "num", text: String(c.donated_count) }),
      el("td", { class: "num", text: fmtTime(c.first_seen) }),
    ]);
  });
  const id = el("input", { class: "input", placeholder: "sample id", spellcheck: "false" });
  const retire = el("button", { class: "btn", type: "button", text: "Retire" });
  retire.addEventListener("click", async () => {
    const v = id.value.trim();
    if (!v) return;
    retire.disabled = true;
    try {
      await req("DELETE", "/admin/samples/" + encodeURIComponent(v));
      toast("Retired " + v + ". It no longer gates a publish, and it is deleted.");
      id.value = "";
    } catch (e) {
      toast(e.message, true);
    } finally {
      retire.disabled = false;
    }
  });

  view.append(
    section(
      "Donated formats",
      "Counts and a layout digest, ordered by how many people hit each format. No message content is shown, " +
        "and none is available here.",
      table(
        ["Sender", "Layout", "People", "Samples", "Donated", "First seen"],
        rows,
        "No donated samples.",
      ),
    ),
    section(
      "Retire a sample",
      "This is the only way past a publish that a sample blocks. It deletes that message. " +
        "Sample ids come from a validate or publish response.",
      el("div", { class: "row" }, [el("div", { class: "field" }, [id]), retire]),
    ),
  );
};

// Dictionary — the merchant-mapping moderation queue.
VIEWS.dictionary = async (view) => {
  const data = await req("GET", "/admin/dictionary");
  // Unmoderated first: approved === null means nobody has decided yet, which
  // is not the same as a rejection, and it is the only state with an action.
  const entries = [...data.entries].sort(
    (a, b) => Number(a.approved !== null) - Number(b.approved !== null),
  );
  const rows = entries.map((e) => {
    const act = (label, approved) => {
      const b = el("button", { class: "btn btn-sm", type: "button", text: label });
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await req("POST", "/admin/dictionary/moderate", {
            pattern: e.pattern,
            category: e.category,
            approved,
            note: "",
          });
          toast(label + ": " + e.pattern);
          render();
        } catch (err) {
          toast(err.message, true);
          b.disabled = false;
        }
      });
      return b;
    };
    return el("tr", {}, [
      el("td", { class: "mono", text: e.pattern }),
      el("td", { class: "mono", text: e.category }),
      el("td", { class: "mono", text: e.source || "—" }),
      el("td", { class: "num", text: e.distinct_submitters + " of " + data.k }),
      // also_matches is the breadth signal: other entries this pattern would
      // swallow if it published. A short generic pattern is the submission the
      // count cannot catch.
      el("td", { class: "mono", text: (e.also_matches || []).join(", ") || "—" }),
      el("td", {}, [
        e.approved === null
          ? el("span", { class: "pill pill-warn", text: "unmoderated" })
          : el("span", {
              class: e.approved ? "pill pill-live" : "pill pill-bad",
              text: e.approved ? "approved" : "rejected",
            }),
        e.published ? el("span", { class: "pill pill-live", text: "live" }) : null,
      ]),
      el("td", {}, [el("div", { class: "row" }, [act("Approve", true), act("Reject", false)])]),
    ]);
  });

  const seed = el("button", { class: "btn", type: "button", text: "Approve the seeded rules" });
  seed.addEventListener("click", async () => {
    seed.disabled = true;
    try {
      const res = await req("POST", "/admin/dictionary/approve-seed", { note: "" });
      toast("Approved " + res.approved + " seeded rules.");
      render();
    } catch (e) {
      toast(e.message, true);
      seed.disabled = false;
    }
  });

  view.append(
    section(
      "Merchant dictionary",
      "Approving a mapping ships it to every device in the beta. Entries below the submitter threshold are " +
        "shown here and nowhere else.",
      table(
        ["Pattern", "Category", "Source", "Submitters", "Also matches", "State", ""],
        rows,
        "The queue is empty.",
      ),
    ),
    section(
      "Seeded rules",
      "Approves every unmoderated rule the operator's own import created. It cannot approve a crowd submission.",
      el("div", { class: "row" }, [seed]),
    ),
  );
};

// Waitlist — which banks people asked for.
VIEWS.waitlist = async (view) => {
  const data = await req("GET", "/admin/waitlist");
  const rows = (data.banks || []).map((b) =>
    el("tr", {}, [
      el("td", { class: "mono", text: b.bank }),
      el("td", { class: "num", text: String(b.count) }),
      el("td", { class: "num", text: fmtTime(b.first_seen) }),
      el("td", { class: "num", text: fmtTime(b.last_seen) }),
    ]),
  );
  const input = el("input", { class: "input", placeholder: "bank", spellcheck: "false" });
  const add = el("button", { class: "btn", type: "button", text: "Record" });
  add.addEventListener("click", async () => {
    const bank = input.value.trim();
    if (!bank) return;
    add.disabled = true;
    try {
      await req("POST", "/admin/waitlist", { bank });
      input.value = "";
      render();
    } catch (e) {
      toast(e.message, true);
    } finally {
      add.disabled = false;
    }
  });
  view.append(
    section(
      "Bank waitlist",
      "Which banks people asked for, and how often.",
      table(["Bank", "Asks", "First asked", "Last asked"], rows, "Nobody has asked for a bank yet."),
      el("div", { class: "row" }, [el("div", { class: "field" }, [input]), add]),
    ),
  );
};

// ── render ────────────────────────────────────────────────────────────────

async function render() {
  const view = $("#view");
  view.replaceChildren(el("p", { class: "label", text: "Loading…" }));
  for (const tab of document.querySelectorAll(".tab")) {
    tab.setAttribute("aria-current", String(tab.dataset.view === current));
  }
  try {
    const fresh = el("div", { class: "view" });
    fresh.style.padding = "0";
    await VIEWS[current](fresh);
    view.replaceChildren(...fresh.childNodes);
  } catch (e) {
    if (e.message === "unauthorized") return;
    view.replaceChildren(el("p", { class: "bad", text: "Could not load this section: " + e.message }));
  }
}

// ── boot ──────────────────────────────────────────────────────────────────

$("#gate-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const v = $("#token").value.trim();
  if (!v) return;
  token = v;
  sessionStorage.setItem(TOKEN_KEY, v);
  openShell();
});
$("#tabs").addEventListener("click", (ev) => {
  const tab = ev.target.closest(".tab");
  if (!tab) return;
  current = tab.dataset.view;
  render();
});
$("#refresh").addEventListener("click", render);
$("#signout").addEventListener("click", () => forgetToken(""));

if (token) openShell();
else forgetToken("");
