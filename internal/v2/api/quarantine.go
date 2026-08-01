package api

// The quarantine lane: its own sync channel, separate from the op log's.
//
// # Why this is not part of GET /api/v1/sync
//
// Quarantined mail has not been trusted. It is outside the integrity chains by
// construction (see internal/v2/quarantine), so it has no seq to page by, no
// chain to verify, and nothing a client should replay into its ledger. Folding
// it into the sync response would put untrusted blobs on the same channel as
// verified ops and invite exactly one bug: a client that treats what it pulled
// as material to replay.
//
// # What the client renders, and what it must not
//
// The response carries the VERIFIED signing domain, the attested inner origin
// and an explicit attestation state — never the message's subject, its display
// name, or any part of its body. Spec §3.2:55 is specific about this: the
// "trust this sender" sheet shows the verified signing domain or a prominent
// unauthenticated state, "so the decision is never made from attacker-rendered
// content alone". A sheet that rendered the subject line would be asking the
// user to authenticate the sender using text the sender wrote.
//
// The raw message is available, deliberately, at ?include_blob=1 and nowhere
// else. Phase 1 needs it for one thing: Gmail's own forward-verification mail
// arrives from forwarding-noreply@google.com, is not the user's bank, is not
// allowlisted, and therefore quarantines like everything else — so onboarding
// (Task D6) reads the confirmation link out of a quarantined message. That
// dependency is written down here because "the onboarding flow silently depends
// on reading a quarantined message" is the kind of thing that is otherwise
// discovered at 2am with an alpha on the phone.
//
// # Nothing here pushes
//
// There is no notification path from a quarantined arrival, in this file or
// anywhere else (§3.2:56). The client learns about held mail by syncing this
// channel, and `action_needed` is how it knows to say so.
//
// # The expiry notice
//
// Held mail expires after 30 days and spec §2 forbids dropping anything without
// a user-visible notice. Both halves of that notice live in this response:
// `warned_at` and `delete_after` on an item that is inside its warning window,
// and `removed` — the records of messages that have already gone, which outlive
// the messages themselves. A client that has not synced in a month still
// receives the full account of what happened, because nothing is deleted until
// a warning has been on this channel for a whole warning window.

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/quarantine"
)

const (
	defaultQuarantineLimit = 50
	maxQuarantineLimit     = 200

	// quarantineBlobBudget bounds the raw-message bytes one ?include_blob=1
	// page may carry, and it is chosen against PEAK MEMORY rather than
	// bandwidth — the same argument, and the same number, as pullByteBudget.
	//
	// Without it the row limit alone bounds the response, and a held message
	// can be a megabyte: 200 of them is a 200 MB response, base64-expanded and
	// marshalled into one buffer, for one request. The row limit is the wrong
	// instrument the moment a row can be a megabyte.
	quarantineBlobBudget = 4 << 20
)

// QuarantineItem is one held message, as the client sees it.
//
// The origin fields are NOT omitempty. An absent `attested_by` and an
// `attested_by` the client forgot to read are the same JSON, and this is the
// one screen in the product where the difference between "verified" and
// "unauthenticated" is the whole decision.
type QuarantineItem struct {
	ID         string    `json:"id"`
	IngestID   string    `json:"ingest_id"` // hex sha256, joins to the op after promotion
	ReceivedAt time.Time `json:"received_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	// WarnedAt is set once the client has been told this item is due to expire.
	WarnedAt *time.Time `json:"warned_at,omitempty"`
	// DeleteAfter is the instant the item actually becomes deletable, which is
	// never before ExpiresAt and never less than a full warning window after
	// WarnedAt. It is absent until the warning has gone out, because until then
	// there is no deletion to count down to.
	DeleteAfter *time.Time `json:"delete_after,omitempty"`

	OuterDomain string `json:"outer_domain"`
	InnerDomain string `json:"inner_domain"`
	Attested    bool   `json:"attested"`
	AttestedBy  string `json:"attested_by"`
	DKIM        string `json:"dkim"`
	ARC         string `json:"arc"`
	SizeBucket  int    `json:"size_bucket"`

	// Blob is the raw message, base64, and is present ONLY with
	// ?include_blob=1.
	Blob string `json:"blob,omitempty"`
}

// QuarantineRemoval is the record of a message that has left quarantine. It
// outlives the message, carries no content, and is what makes "nothing is
// dropped without a notice" answerable after the fact.
type QuarantineRemoval struct {
	IngestID    string     `json:"ingest_id"`
	ReceivedAt  time.Time  `json:"received_at"`
	ExpiresAt   time.Time  `json:"expires_at"`
	WarnedAt    *time.Time `json:"warned_at,omitempty"`
	RemovedAt   time.Time  `json:"removed_at"`
	Reason      string     `json:"reason"` // "expired" | "promoted"
	OuterDomain string     `json:"outer_domain"`
	InnerDomain string     `json:"inner_domain"`
	Attested    bool       `json:"attested"`
	SizeBucket  int        `json:"size_bucket"`
}

// QuarantineResponse is GET /api/v1/quarantine.
//
// The two cursors are separate because the two lists are ordered by different
// instants — arrival for held mail, removal for the records — and one cursor
// driving both would either re-send records forever or skip them.
//
// Each cursor is a PAIR: an instant plus the id of the last row at that
// instant. Mail arrives in batches, so a cursor that is a timestamp alone loses
// every item sharing the last one's microsecond. A client that sends only
// `after` is answered safely (the instant's items are re-sent, not skipped).
type QuarantineResponse struct {
	Items   []QuarantineItem    `json:"items"`
	Removed []QuarantineRemoval `json:"removed"`

	// ActionNeeded is every held message: a quarantined arrival is a decision
	// the user has not made yet (§3.2:56). ExpiringSoon is the subset that has
	// been warned and therefore has a deadline.
	ActionNeeded int `json:"action_needed"`
	ExpiringSoon int `json:"expiring_soon"`

	Next          string `json:"next,omitempty"`
	NextID        string `json:"next_id,omitempty"`
	RemovedNext   string `json:"removed_next,omitempty"`
	RemovedNextID string `json:"removed_next_id,omitempty"`
	// Complete is true when both lists were exhausted by this page.
	Complete bool `json:"complete"`
}

// ConfirmSenderRequest is POST /api/v1/quarantine/confirm.
type ConfirmSenderRequest struct {
	Domain string `json:"domain"`
	Scope  string `json:"scope"` // "outer" | "inner"
}

// ConfirmSenderResponse names the messages now eligible for re-ingest. The
// re-ingest itself (Task 30) is what appends them to the op log; confirming
// changes no chain.
type ConfirmSenderResponse struct {
	Domain    string   `json:"domain"`
	Scope     string   `json:"scope"`
	IngestIDs []string `json:"ingest_ids"` // hex sha256
}

// handleQuarantine serves the lane.
func (s *Server) handleQuarantine(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	limit, err := parseLimit(r, defaultQuarantineLimit, maxQuarantineLimit)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	items, err := parseTimeCursor(r, "after", "after_id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	removed, err := parseTimeCursor(r, "removed_after", "removed_after_id")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	// The blob is opt-in per request rather than a separate endpoint, so the
	// cheap listing is what a client gets by accident and the expensive one is
	// what it asks for.
	withBlob := r.URL.Query().Get("include_blob") == "1"

	held, err := s.Quarantine.List(r.Context(), userID, items, limit, withBlob)
	if err != nil {
		s.logf("api: quarantine list for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	removals, err := s.Quarantine.Removals(r.Context(), userID, removed, limit)
	if err != nil {
		s.logf("api: quarantine removals for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	action, warned, err := s.Quarantine.Counts(r.Context(), userID)
	if err != nil {
		s.logf("api: quarantine counts for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}

	out := QuarantineResponse{
		Items:        make([]QuarantineItem, 0, len(held)),
		Removed:      make([]QuarantineRemoval, 0, len(removals)),
		ActionNeeded: action,
		ExpiringSoon: warned,
	}
	// The page may end short of what the store returned, on bytes rather than
	// rows. The cursor below is taken from the LAST ITEM ACTUALLY RENDERED, so
	// a truncated page resumes exactly where it stopped and nothing is skipped
	// — a page boundary is not a place mail is allowed to disappear.
	budget := s.quarantineByteBudget()
	spent := 0
	for _, it := range held {
		if withBlob && len(out.Items) > 0 && spent+len(it.Blob) > budget {
			break
		}
		spent += len(it.Blob)
		out.Items = append(out.Items, s.renderQuarantineItem(it, withBlob))
	}
	if n := len(out.Items); n > 0 {
		last := held[n-1]
		out.Next = last.ReceivedAt.UTC().Format(time.RFC3339Nano)
		out.NextID = last.ID.String()
	}
	out.Complete = len(out.Items) == len(held) && len(held) < limit && len(removals) < limit
	for _, rem := range removals {
		out.Removed = append(out.Removed, QuarantineRemoval{
			IngestID:    hex.EncodeToString(rem.IngestID),
			ReceivedAt:  rem.ReceivedAt,
			ExpiresAt:   rem.ExpiresAt,
			WarnedAt:    rem.WarnedAt,
			RemovedAt:   rem.RemovedAt,
			Reason:      rem.Reason,
			OuterDomain: rem.OuterDomain,
			InnerDomain: rem.InnerDomain,
			Attested:    rem.Attested,
			SizeBucket:  rem.SizeBucket,
		})
	}
	if n := len(removals); n > 0 {
		out.RemovedNext = removals[n-1].RemovedAt.UTC().Format(time.RFC3339Nano)
		out.RemovedNextID = removals[n-1].ID.String()
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) renderQuarantineItem(it quarantine.Item, withBlob bool) QuarantineItem {
	out := QuarantineItem{
		ID:          it.ID.String(),
		IngestID:    hex.EncodeToString(it.IngestID),
		ReceivedAt:  it.ReceivedAt,
		ExpiresAt:   it.ExpiresAt,
		WarnedAt:    it.WarnedAt,
		OuterDomain: it.OuterDomain,
		InnerDomain: it.InnerDomain,
		Attested:    it.Attested,
		AttestedBy:  it.AttestedBy,
		DKIM:        it.DKIM,
		ARC:         it.ARC,
		SizeBucket:  it.SizeBucket,
	}
	// Computed by the store, not here: the deadline the client counts down to
	// must be the one the sweep enforces, and a second copy of that arithmetic
	// in the HTTP layer is how a UI ends up promising a date the server does
	// not honour.
	if at, ok := s.Quarantine.DeletableAt(it.ExpiresAt, it.WarnedAt); ok {
		out.DeleteAfter = &at
	}
	if withBlob {
		out.Blob = base64.StdEncoding.EncodeToString(it.Blob)
	}
	return out
}

// handleConfirmSender allowlists a verified origin and reports what is now
// eligible for re-ingest.
//
// The refusals are deliberately DISTINGUISHABLE, unlike this package's
// authorization failures. Each one names something the caller can already see
// in their own quarantine lane, so there is no oracle — and a user being told
// "you cannot trust your mail provider as a sender; trust the bank behind it"
// is the difference between a flow that teaches and a flow that dead-ends on
// the screen where they are trying to onboard.
func (s *Server) handleConfirmSender(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	var req ConfirmSenderRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	ids, err := s.Quarantine.Confirm(r.Context(), userID, req.Domain, req.Scope)
	switch {
	case err == nil:
	case errors.Is(err, quarantine.ErrForwarderDomain):
		// 409, not 400: the request is well formed and the domain is real. What
		// is refused is the RELATIONSHIP being asserted.
		writeErr(w, http.StatusConflict, "forwarder_domain",
			"that domain is a mail provider, not a sender. Allowlisting it as an outer origin would trust "+
				"every message that passes through your mailbox. Confirm the inner origin — the bank's own "+
				"verified domain — instead.")
		return
	case errors.Is(err, quarantine.ErrOriginUnproven):
		writeErr(w, http.StatusConflict, "origin_unproven",
			"no message held for this account carries a verified signature from that origin, so there is "+
				"nothing to trust yet. Mail that cannot be verified stays quarantined.")
		return
	case errors.Is(err, quarantine.ErrUnknownScope):
		writeErr(w, http.StatusBadRequest, "bad_request", "scope must be \"outer\" or \"inner\"")
		return
	case errors.Is(err, quarantine.ErrInvalidDomain):
		writeErr(w, http.StatusBadRequest, "bad_request", "domain must be a plain hostname")
		return
	default:
		s.logf("api: confirm sender for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}

	out := ConfirmSenderResponse{Domain: req.Domain, Scope: req.Scope, IngestIDs: make([]string, 0, len(ids))}
	for _, id := range ids {
		out.IngestIDs = append(out.IngestIDs, hex.EncodeToString(id))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) quarantineByteBudget() int {
	if s.QuarantineByteBudget > 0 {
		return s.QuarantineByteBudget
	}
	return quarantineBlobBudget
}

// parseTimeCursor reads a keyset cursor from two query parameters.
//
// The id half is optional. Without it the cursor addresses the instant itself,
// and the store re-delivers that instant's rows rather than skipping them: a
// duplicate is idempotent for every consumer of this channel, and a skip is a
// message the user never hears about again.
func parseTimeCursor(r *http.Request, atParam, idParam string) (quarantine.Cursor, error) {
	var cur quarantine.Cursor
	raw := r.URL.Query().Get(atParam)
	rawID := r.URL.Query().Get(idParam)
	if raw == "" {
		if rawID != "" {
			return cur, errors.New(idParam + " needs " + atParam)
		}
		return cur, nil
	}
	at, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return cur, errors.New(atParam + " must be an RFC 3339 timestamp")
	}
	cur.At = at
	if rawID != "" {
		id, err := uuid.Parse(rawID)
		if err != nil {
			return cur, errors.New(idParam + " must be a uuid")
		}
		cur.ID = id
	}
	return cur, nil
}
