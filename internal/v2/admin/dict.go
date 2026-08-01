// Package admin is the operator's console API. It is TAILNET-BOUND and is
// never mounted on the listener users reach.
//
// This file is the merchant-dictionary half (Task 33). Task 32 adds admin.go
// with the rest of the console — templates, diagnostics, accounting, waitlist —
// plus the second listener and the binding rule spec §3.1 requires (loopback or
// 100.64.0.0/10, refused otherwise). Until then nothing mounts [DictHandler],
// which is why [DictHandler.Routes] refuses to mount at all without a token
// rather than defaulting to an open one.
//
// # Why moderation is here and not on the public API
//
// Moderation is the anti-poisoning gate. An approval publishes a merchant
// mapping to every device in the beta, so the ability to approve is the ability
// to ship `AMAZON -> Charity` to everyone. It is therefore reachable only from
// a listener that is not on the internet, and the binding restriction — not the
// bearer token — is the real control; the token stops an accident inside the
// tailnet, not an attacker outside it.
//
// internal/v2/api's TestThePublicAPIExposesNoModerationRoute asserts the other
// half of that: no path under /api/ and no /admin/ path reaches any of this.
//
// # What the operator sees here that a user never does
//
// [DictHandler] serves entries the k threshold is SUPPRESSING — patterns one or
// two beta users submitted, which are exactly the entries a moderator has to be
// able to see and exactly the ones a client must not. That asymmetry is the
// reason this handler exists separately rather than as a query parameter on the
// public feed.
package admin

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"ledger/internal/v2/dict"
)

// maxBodyBytes caps every request body here. Nothing this handler accepts
// carries more than a merchant pattern and a short note.
const maxBodyBytes = 16 << 10

// DictHandler serves the dictionary moderation queue.
type DictHandler struct {
	Dict *dict.Dict
	// Token is the shared operator credential (LEDGER_ADMIN_TOKEN). Routes
	// refuses to mount without it.
	Token string
	// Logf receives the operator-facing reason a request was refused, which
	// the response deliberately does not carry. Defaults to log.Printf.
	Logf func(format string, args ...any)
}

func (h *DictHandler) logf(format string, args ...any) {
	if h.Logf != nil {
		h.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

// Routes mounts the dictionary console on mux.
//
// It returns an error rather than mounting an unauthenticated route when the
// token is missing. A console that silently comes up open because an
// environment variable was not set is the failure mode worth making impossible:
// the operator sees a startup error instead of a working, unprotected approval
// endpoint.
func (h *DictHandler) Routes(mux *http.ServeMux) error {
	if h == nil || h.Dict == nil {
		return errors.New("admin: dictionary routes need a dict store")
	}
	if h.Token == "" {
		return errors.New("admin: refusing to mount the dictionary console with no " +
			"LEDGER_ADMIN_TOKEN: an unauthenticated approval endpoint publishes a merchant " +
			"mapping to every device in the beta")
	}
	mux.HandleFunc("GET /admin/dictionary", h.requireToken(h.list))
	mux.HandleFunc("POST /admin/dictionary/moderate", h.requireToken(h.moderate))
	mux.HandleFunc("POST /admin/dictionary/approve-seed", h.requireToken(h.approveSeed))
	return nil
}

// requireToken compares the bearer credential in constant time.
//
// Every rejection is the identical 401 — no header, wrong scheme, wrong token —
// because a response that distinguishes them is an oracle. The reason goes to
// the operator log.
func (h *DictHandler) requireToken(next http.HandlerFunc) http.HandlerFunc {
	want := []byte(h.Token)
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		const scheme = "bearer "
		if len(auth) <= len(scheme) || !strings.EqualFold(auth[:len(scheme)], scheme) {
			h.logf("admin: %s %s: no bearer token", r.Method, r.URL.Path)
			unauthorized(w)
			return
		}
		got := []byte(strings.TrimSpace(auth[len(scheme):]))
		// ConstantTimeCompare returns 0 for differing lengths without
		// comparing, so the length check is not itself the timing signal —
		// but it is why the call cannot be relied on to hide the length. That
		// is acceptable for a fixed operator token and worth writing down.
		if subtle.ConstantTimeCompare(got, want) != 1 {
			h.logf("admin: %s %s: token mismatch", r.Method, r.URL.Path)
			unauthorized(w)
			return
		}
		next(w, r)
	}
}

// ---------------------------------------------------------------------------

// listResponse is the moderation queue. Unmoderated entries sort first, because
// they are the only ones that need an action.
type listResponse struct {
	Entries []dict.Status `json:"entries"`
	// K is echoed so the console can render "2 of 3 submitters" without
	// hard-coding a threshold that lives in one place in Go and one in SQL.
	K int `json:"k"`
}

func (h *DictHandler) list(w http.ResponseWriter, r *http.Request) {
	entries, err := h.Dict.List(r.Context())
	if err != nil {
		h.logf("admin: list dictionary: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if entries == nil {
		entries = []dict.Status{}
	}
	writeJSON(w, http.StatusOK, listResponse{Entries: entries, K: dict.K})
}

type moderateRequest struct {
	Pattern  string `json:"pattern"`
	Category string `json:"category"`
	Approved bool   `json:"approved"`
	Note     string `json:"note"`
}

func (h *DictHandler) moderate(w http.ResponseWriter, r *http.Request) {
	var req moderateRequest
	if !decodeBody(w, r, &req) {
		return
	}
	err := h.Dict.Moderate(r.Context(), req.Pattern, req.Category, req.Approved, req.Note)
	switch {
	case errors.Is(err, dict.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found")
	case errors.Is(err, dict.ErrInvalidEntry):
		// The detail is the operator's own submission, so it is safe to
		// return — unlike on the user-facing API, where it would be an oracle.
		writeErr(w, http.StatusBadRequest, err.Error())
	case err != nil:
		h.logf("admin: moderate: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

type approveSeedRequest struct {
	Note string `json:"note"`
}

// approveSeed approves every unmoderated entry the operator's own v1 import
// created, and NOTHING else.
//
// `ledgerd seed-dictionary` imports a few hundred rules at once; moderating
// them one at a time is not a review, it is a formality performed several
// hundred times, and a formality performed several hundred times is how a
// moderation gate stops being read. It is scoped in SQL to
// source='operator_seed', so it cannot approve a single crowd submission — the
// poisoning gate is untouched by it.
func (h *DictHandler) approveSeed(w http.ResponseWriter, r *http.Request) {
	var req approveSeedRequest
	if !decodeBody(w, r, &req) {
		return
	}
	n, err := h.Dict.ApproveOperatorSeed(r.Context(), req.Note)
	if err != nil {
		h.logf("admin: approve seed: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"approved": n})
}

// ---------------------------------------------------------------------------

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "body is not valid JSON for this endpoint")
		return false
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeErr(w, http.StatusBadRequest, "body carries more than one JSON value")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	buf, err := json.Marshal(v)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(buf)
}

func writeErr(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, map[string]string{"error": detail})
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}
