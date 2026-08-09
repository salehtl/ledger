package admin

// accounts.go is the console's roster: who is in the beta and is their mail
// flowing. It is the one data path the panel (ui.go) needed that did not
// already exist, and it was added rather than assembled client-side because
// every alternative was worse: the diagnostics feed knows user ids but not
// which of them have an address or a published key, and a panel that paged
// through every diagnostics row to count arrivals per account would read far
// more per render than the counts it wanted.
//
// # What it reads, and what it can never read
//
// users, inbound_addresses, user_keys, writers, quarantine and
// parse_diagnostics. That set is deliberate and it is the whole point of the
// file: none of those tables holds a transaction, an amount, a merchant or a
// balance. op_log is NOT joined and must never be — from Phase 3 the server
// cannot open an op anyway, and a roster built on one would be a roster that
// stops working the day sealing lands.
//
// The mailbox local part IS returned. It is the operator's only handle on a
// forwarding problem ("mail for u-… is arriving, mail for u-… is not"), spec §8
// lists mailbox addresses as permitted operational data, and this listener is
// tailnet-only. It is still a secret in the sense 00005's header describes — it
// is what stops a stranger injecting bank-shaped mail — so it belongs on this
// listener and nowhere else.

import (
	"net/http"
	"time"

	"github.com/google/uuid"
)

// accountRow is one beta account, in operational terms only.
type accountRow struct {
	UserID    uuid.UUID `json:"user_id"`
	CreatedAt time.Time `json:"created_at"`

	// Status is `active` or `suspended` (00030_account_status.sql). It is on the
	// roster rather than on a separate lookup because the console's two new
	// buttons need it to know which one to offer, and an operator scanning the
	// table needs to see a pause they applied last week without clicking
	// anything.
	Status string `json:"status"`

	// LocalPart is the ACTIVE inbound address, or "" for an account that has
	// not been issued one yet. A rotated-away address inside its grace window is
	// deliberately not shown: the question this row answers is "where should
	// this user's bank be sending", which has exactly one answer.
	LocalPart string `json:"local_part"`

	// KeysPublished is whether the account has published its ingest key.
	// KeyVersion is the envelope version the client declared, so "which
	// accounts are on the old envelope" is answerable without opening a blob.
	KeysPublished bool `json:"keys_published"`
	KeyVersion    int  `json:"key_version,omitempty"`

	// Devices counts live device writers. Zero on an account whose only writer
	// was revoked, which is a real state worth seeing.
	Devices int `json:"devices"`
	// Held is the account's quarantine depth, all-time within the retention
	// window the sweep enforces.
	Held int `json:"held"`

	// LastMailAt is the most recent arrival, ever. It is the forwarding-health
	// signal: an account set up three weeks ago with no arrival never finished
	// its bank's forwarding step.
	LastMailAt *time.Time `json:"last_mail_at"`

	// Arrivals and Parsed are counted over the REQUEST WINDOW, not all time, so
	// the ratio describes the recent state of the parsers rather than the
	// account's whole history. The window is echoed on the response.
	Arrivals int `json:"arrivals"`
	Parsed   int `json:"parsed"`
}

// accountsWindow is how far back the arrival counts reach when the caller names
// no bounds. It matches defaultWindow: a week is long enough that a quiet
// weekend does not read as a broken forward.
const accountsWindow = defaultWindow

// accounts serves the roster.
//
// The window bounds only the two COUNTS. The structural facts — an address, a
// published key, a live device, held mail — are not time-scoped, because
// "this account has no key" is not a fact about last week.
func (h *Handler) accounts(w http.ResponseWriter, r *http.Request) {
	from, to, ok := h.window(w, r)
	if !ok {
		return
	}
	if to.IsZero() {
		to = time.Now()
	}
	if from.IsZero() {
		from = to.Add(-accountsWindow)
	}

	const q = `
SELECT u.id,
       u.created_at,
       u.status,
       COALESCE(a.local_part, ''),
       (k.user_id IS NOT NULL),
       COALESCE(k.key_version, 0),
       (SELECT count(*) FROM writers wr
         WHERE wr.user_id = u.id AND wr.kind = 'device' AND wr.revoked_at IS NULL),
       (SELECT count(*) FROM quarantine qq WHERE qq.user_id = u.id),
       (SELECT max(d.received_at) FROM parse_diagnostics d
         WHERE d.user_id = u.id AND d.event = 'arrival'),
       (SELECT count(*) FROM parse_diagnostics d
         WHERE d.user_id = u.id AND d.event = 'arrival'
           AND d.received_at >= $1 AND d.received_at <= $2),
       (SELECT count(*) FROM parse_diagnostics d
         WHERE d.user_id = u.id AND d.event = 'arrival' AND d.matched
           AND d.received_at >= $1 AND d.received_at <= $2)
  FROM users u
  LEFT JOIN inbound_addresses a ON a.user_id = u.id AND a.expires_at IS NULL
  LEFT JOIN user_keys k ON k.user_id = u.id
 ORDER BY u.created_at, u.id`

	rows, err := h.Diag.Pool.Query(r.Context(), q, from, to)
	if err != nil {
		h.logf("admin: roster: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	defer rows.Close()

	out := []accountRow{}
	for rows.Next() {
		var a accountRow
		if err := rows.Scan(&a.UserID, &a.CreatedAt, &a.Status, &a.LocalPart,
			&a.KeysPublished, &a.KeyVersion, &a.Devices, &a.Held,
			&a.LastMailAt, &a.Arrivals, &a.Parsed); err != nil {
			h.logf("admin: roster scan: %v", err)
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		h.logf("admin: roster: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accounts": out, "from": from, "to": to,
	})
}
