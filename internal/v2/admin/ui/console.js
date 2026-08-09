// The operator console.
//
// Plain DOM, no framework, no build step. See ui.go's header for why.
//
// There are two ways to be authorized here and the page tries the free one
// first: it asks GET /admin/status with whatever it has. If the request is
// already authorized — because `tailscale serve` put the operator's identity on
// it — the token field is never shown at all. A 401 is what makes it appear.
//
// When a token IS needed it lives in localStorage, not sessionStorage: it is
// then entered once per device instead of once per tab, which is most of the
// friction this page ever caused. It is sent as a bearer header, never in a
// cookie and never in a URL — a cookie would ride along on cross-origin
// requests, and a URL would put the credential in history and in any log that
// records a path.
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

// Binary units, because the floor is one: 8 GiB is the number in the design and
// in the config, and printing it as "8.6 GB" would make the page and the
// operator's `df` disagree about the same byte count.
const fmtBytes = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (n < 0 ? "-" : "") + (i === 0 ? v : v.toFixed(1)) + " " + units[i];
};

// ── transport ─────────────────────────────────────────────────────────────

let token = localStorage.getItem(TOKEN_KEY) || "";
let identity = null;

async function req(method, path, body) {
  const init = { method, headers: {} };
  // Omitted entirely when there is no token, rather than sent empty: an empty
  // bearer header is a credential that fails, and the server would log a token
  // mismatch for a page that never claimed to have one.
  if (token) init.headers.Authorization = "Bearer " + token;
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    // A refused token is dropped here and nowhere else. No reason shown when
    // there was no token: on first load a 401 only means the tailnet did not
    // vouch for this browser, which is not a failure to report.
    const had = token;
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    showGate(had ? "That token was refused." : "");
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

// showGate does NOT drop a stored token. A refused one is cleared by the caller
// that saw the 401; a network error must not cost the operator their token on
// the way past, because the next thing they will do is reload.
function showGate(reason) {
  identity = null;
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

// Who the console thinks you are, drawn from the status route on every render.
//
// A token-authenticated caller has no identity — the token says somebody holds
// the operator credential, not who — so the chip says that rather than inventing
// a name. "Forget token" is hidden when there is no token to forget: a button
// that does nothing is worse than no button.
function applyIdentity(id) {
  identity = id || null;
  $("#whoami").textContent = identity
    ? identity.name
      ? identity.name + " · " + identity.login
      : identity.login
    : token
      ? "signed in with the operator token"
      : "";
  $("#signout").hidden = !token;
}

// ── views ─────────────────────────────────────────────────────────────────

const VIEWS = {};
let current = "accounts";

// The last minted invite code, held here and nowhere else because it exists
// nowhere else: the server stored only its hash. It survives a re-render of the
// Invites tab and is dropped the moment the operator leaves it or reloads.
let lastMinted = null;

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

// Invites — the closed beta's gate. Mint one, see what is outstanding, revoke
// one that has not been spent.
//
// The minted code is shown ONCE, here, and there is no route that could show it
// again: only its SHA-256 is stored. So the panel puts it in a box of its own
// with a copy button and says plainly that it will not be shown again, and the
// box stays on screen until the operator navigates away rather than fading like
// a toast.
VIEWS.invites = async (view) => {
  const data = await req("GET", "/admin/invites");

  const rows = (data.invites || []).map((iv) => {
    const outstanding = !iv.redeemed_at;
    let state;
    if (outstanding) {
      state = el("span", { class: "pill pill-live", text: "outstanding" });
    } else if (!iv.redeemed_by) {
      // Redeemed, then the account was deleted: ON DELETE SET NULL leaves the
      // row saying a code was spent by nobody in particular. The note is
      // cleared by the same deletion, so this row is genuinely anonymous.
      state = el("span", { class: "pill", text: "redeemed, account deleted" });
    } else {
      state = el("span", { class: "pill", text: "redeemed" });
    }

    // Offered only where it can work. A redeemed code's row is the only record
    // of where an account came from, and the server refuses to delete it —
    // showing a button that is always refused would be a lie about what the
    // console can do.
    let action = el("span", { class: "muted", text: "—" });
    if (outstanding) {
      const b = el("button", {
        class: "btn btn-sm",
        type: "button",
        text: "Revoke",
        title: "Delete this unredeemed code. It can never be spent. Not reversible: mint a new one.",
      });
      b.addEventListener("click", async () => {
        if (
          !confirm(
            "Revoke " +
              iv.hash +
              "?\n\n" +
              (iv.note ? "Note: " + iv.note + "\n\n" : "") +
              "The code is deleted and can never create an account. Whoever is holding it will " +
              "need a new one. This cannot be undone.",
          )
        ) {
          return;
        }
        b.disabled = true;
        try {
          await req("DELETE", "/admin/invites/" + encodeURIComponent(iv.hash));
          toast("Revoked " + iv.hash + ".");
          render();
        } catch (e) {
          b.disabled = false;
          toast(e.message, true);
        }
      });
      action = b;
    }

    return el("tr", {}, [
      el("td", { class: "mono", text: iv.hash }),
      el("td", { class: "num", text: fmtTime(iv.created_at) }),
      el("td", {}, [state]),
      el("td", { class: "num", text: iv.redeemed_at ? fmtTime(iv.redeemed_at) : "—" }),
      el("td", { class: "mono", title: iv.redeemed_by || "", text: short(iv.redeemed_by) || "—" }),
      el("td", { text: iv.note || "—" }),
      el("td", {}, [action]),
    ]);
  });

  const note = el("input", {
    class: "input",
    placeholder: "who this is for",
    spellcheck: "false",
    maxlength: "500",
  });
  const mint = el("button", { class: "btn btn-primary", type: "button", text: "Mint a code" });
  mint.addEventListener("click", async () => {
    mint.disabled = true;
    try {
      const res = await req("POST", "/admin/invites", { note: note.value.trim() });
      note.value = "";
      // Held outside this closure, because render() rebuilds the whole view and
      // would otherwise throw the code away a few milliseconds after showing it.
      lastMinted = res;
      render();
    } catch (e) {
      toast(e.message, true);
    } finally {
      mint.disabled = false;
    }
  });

  // The one-time code box, redrawn on every render of this tab so a refresh or
  // a revoke elsewhere in the table does not destroy the only copy in existence.
  // It is cleared when the operator leaves the tab (see the tab handler).
  if (lastMinted) {
    const code = el("code", { class: "mono code-once", text: lastMinted.code });
    const copy = el("button", { class: "btn btn-sm", type: "button", text: "Copy" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(lastMinted.code);
        copy.textContent = "Copied";
      } catch {
        // Clipboard access can be refused. The code is on screen and
        // selectable either way, so say that rather than failing silently.
        toast("Could not copy. Select the code and copy it by hand.", true);
      }
    });
    const done = el("button", { class: "btn btn-sm", type: "button", text: "I have it" });
    done.addEventListener("click", () => {
      lastMinted = null;
      render();
    });
    view.append(
      section(
        "Copy this code now — it will not be shown again",
        "Only its hash is stored, so nothing here and no backup can show it a second time. " +
          "If you lose it, revoke the row below and mint another.",
        el("div", { class: "row" }, [code, copy, done]),
        el("p", {
          class: "muted",
          text:
            "Listed below as " +
            lastMinted.hash +
            ". Single use, and it creates an account and nothing else.",
        }),
      ),
    );
  }

  view.append(
    section(
      "Mint an invite",
      "The note is your own words about who it is for. It is cleared if that account is ever deleted.",
      el("div", { class: "row" }, [el("div", { class: "field" }, [note]), mint]),
    ),
    section(
      "Invite codes",
      "Hashes, never codes — the code itself is not stored. Revoking deletes an unredeemed row; " +
        "a redeemed one is kept, because it is the only record of where that account came from.",
      table(
        ["Hash", "Minted", "State", "Redeemed", "Account", "Note", ""],
        rows,
        "No invite codes have been minted.",
      ),
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

// ── the disk fuse ─────────────────────────────────────────────────────────

// The box-level headroom fuse, drawn above every tab.
//
// It is the most consequential state this server has and the only one with no
// user-visible explanation: below the floor every durable write is refused —
// including sign-in — while reads keep serving, so to a user the app works and
// nothing saves. It is drawn on every render, in every section, and it names the
// SHORTFALL rather than only the state, because "tripped" alone does not tell an
// operator whether to delete a log file or move the database.
async function renderHeadroom() {
  const box = $("#headroom");
  let h;
  try {
    const status = await req("GET", "/admin/status");
    // The same response carries who the console thinks you are. One route, one
    // round trip, and the chip cannot drift out of step with the fuse.
    applyIdentity(status.identity);
    h = status.headroom;
  } catch (e) {
    if (e.message === "unauthorized") return;
    // Never silent. A strip that vanishes on error looks exactly like a healthy
    // box, which is the one thing this element must never look like when it
    // does not know.
    box.className = "headroom";
    box.hidden = false;
    box.replaceChildren(
      el("span", { class: "label", text: "disk" }),
      el("span", { class: "muted", text: "Headroom could not be read: " + e.message }),
    );
    return;
  }

  box.hidden = false;
  if (!h || !h.configured) {
    box.className = "headroom warn";
    box.replaceChildren(
      el("span", { class: "pill pill-warn", text: "no fuse" }),
      el("span", {
        text:
          "This process is not watching free disk space, so nothing stops a full filesystem " +
          "from stopping writes for every account at once.",
      }),
    );
    return;
  }

  const floor = fmtBytes(h.floor_bytes);
  const known = typeof h.free_bytes === "number";
  const free = known ? fmtBytes(h.free_bytes) : "an unknown amount";
  const margin = known ? h.free_bytes - h.floor_bytes : 0;

  if (h.tripped) {
    box.className = "headroom tripped";
    box.replaceChildren(
      el("span", { class: "pill pill-bad", text: "writes paused" }),
      el("span", {
        class: "tnum",
        text:
          h.deficit_bytes > 0
            ? free + " free on " + h.path + ", " + fmtBytes(h.deficit_bytes) + " BELOW the " + floor + " floor"
            : free + " free on " + h.path + ", against a " + floor + " floor",
      }),
      el("span", {
        class: "muted",
        text:
          "Every durable write is refused, including new sign-ins. Reads keep serving. " +
          (h.deficit_bytes > 0
            ? "Free at least that much and writes resume at the fuse's next sample."
            : "Free space is back above the floor; writes resume at the fuse's next sample."),
      }),
      h.sample_error ? el("span", { class: "bad", text: "statfs: " + h.sample_error }) : null,
    );
    return;
  }

  box.className = "headroom";
  box.replaceChildren(
    el("span", { class: "label", text: "disk" }),
    el("span", {
      class: "tnum muted",
      text:
        known
          ? free + " free on " + h.path + ", " + fmtBytes(margin) + " above the " + floor + " floor"
          : "free space on " + h.path + " could not be measured; the " + floor + " floor is not tripped",
    }),
    h.sample_error ? el("span", { class: "bad", text: "statfs: " + h.sample_error }) : null,
  );
}

// ── render ────────────────────────────────────────────────────────────────

async function render() {
  const view = $("#view");
  view.replaceChildren(el("p", { class: "label", text: "Loading…" }));
  for (const tab of document.querySelectorAll(".tab")) {
    tab.setAttribute("aria-current", String(tab.dataset.view === current));
  }
  // Awaited before the section, and never allowed to fail the render: the fuse
  // strip is the one thing on this page that must be right even when the
  // section below it cannot load.
  await renderHeadroom();
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
  // localStorage, not sessionStorage: once per device beats once per tab, and
  // this is a page one person opens on their own machines on their own tailnet.
  localStorage.setItem(TOKEN_KEY, v);
  openShell();
});
$("#tabs").addEventListener("click", (ev) => {
  const tab = ev.target.closest(".tab");
  if (!tab) return;
  // Leaving the Invites tab drops the one-time code. Carrying it to another tab
  // and back would be a live credential sitting in a page nobody is looking at.
  if (current === "invites" && tab.dataset.view !== "invites") lastMinted = null;
  current = tab.dataset.view;
  render();
});
$("#refresh").addEventListener("click", render);
$("#signout").addEventListener("click", () => {
  // Drops the stored token and asks again. If `tailscale serve` is vouching for
  // this browser the shell simply stays open with no token at all, which is the
  // whole point of the identity path — signing out of a credential you were not
  // using must not lock you out.
  token = "";
  localStorage.removeItem(TOKEN_KEY);
  boot();
});

// Boot: ask one guarded route with whatever credential we have. A 200 opens the
// shell — either the token worked or the tailnet vouched for us — and req()
// turns a 401 into the token gate on its own.
//
// It costs one extra /admin/status call, because openShell renders and the
// render asks again. That is a statfs and a map lookup on a tailnet-only
// listener, and it buys a boot path with no branch that guesses.
async function boot() {
  try {
    await req("GET", "/admin/status");
    openShell();
  } catch (e) {
    if (e.message !== "unauthorized") {
      showGate("Could not reach the console: " + e.message);
    }
  }
}

boot();
