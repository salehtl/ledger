package api

// The donated-sample intake (spec §3.5), and the one place in this package
// where the DEFAULT behaviour is the one that sends nothing.
//
//	POST /api/v1/samples/report {ingest_id}           -> 204
//	POST /api/v1/samples/donate {ingest_id, consent}  -> 204
//
// # Why there are two endpoints and not one flag
//
// §3.5:114 says the client reports a content-free structural fingerprint by
// default and that a full sample is a separate, explicit act. Two routes make
// that a property of the request rather than of a boolean somebody could get
// backwards: /report has no field capable of carrying content, so no bug in the
// client — and no misreading of a flag on this side — can turn a default report
// into a donation. The consent-bearing route is the one that has to be reached
// deliberately.
//
// Both routes carry the same one identifier and differ in what the server then
// does with it: /report stores a domain and a layout fingerprint it looks up
// for itself, /donate additionally copies the message body out of the caller's
// own cold stream and records the consent identifier that authorised it.
//
// # The donation carries an id, not a body
//
// /donate names one of the caller's OWN messages by ingest id and the server
// copies the bytes out of that user's cold stream (internal/v2/samples). A
// client cannot upload a sample. That is worth more than it looks: a sample
// filed under a bank's domain blocks that bank's template publishes until an
// operator retires it, so an upload endpoint would be a way for any account to
// jam parser development for every user of a bank it does not even use.
//
// ⚠ PHASE 1 ONLY for the server-side body read — item 3 in
// docs/superpowers/specs/v2-phase1-only-inventory.md. From Phase 3 the client
// uploads the decrypted sample itself after showing the redaction preview, and
// this handler changes shape with it.
//
// # ingest_id travels as hex
//
// Not base64, unlike every other binary field on this API. The reason is that
// the client is not converting anything: `ingest_id` is already a lower-case
// hex string inside the cold record the client decoded to find the unparsed
// message in the first place (oplog.RawBody), and asking it to re-encode a
// value it is holding in the right form, for one endpoint, is how a client ends
// up with two spellings of one identifier.

import (
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"ledger/internal/v2/samples"
)

// decodeIngestID reads the one identifier both routes carry, and writes the
// refusal itself when it is not one.
//
// LOWER CASE is required rather than folded. hex.DecodeString accepts either,
// and the two routes both document lower case; quietly accepting the other
// spelling is how a client ends up holding two forms of one identifier and
// comparing them somewhere this server cannot see. The value in the cold record
// the client read it out of is already lower case (oplog.RawBody).
func decodeIngestID(w http.ResponseWriter, s string) ([]byte, bool) {
	id, err := hex.DecodeString(s)
	if err != nil || len(id) != 32 || s != strings.ToLower(s) {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"ingest_id must be a 64-character lower-case hex sha-256")
		return nil, false
	}
	return id, true
}

// reportRequest is the DEFAULT path. Note what it cannot express: there is no
// field here that can carry a byte of mail — and, since 2026-08-01, none that
// can carry a BANK NAME either. It names one of the caller's own messages and
// the server fills in both stored values from its own arrival record; see
// samples.Samples.Report for why a request-supplied domain was a false statement
// in the privacy page rather than merely a missing check.
type reportRequest struct {
	IngestID string `json:"ingest_id"`
}

// handleReport serves POST /api/v1/samples/report.
func (s *Server) handleReport(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.SamplesPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many sample submissions; try again shortly")
		return
	}
	var req reportRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	id, ok := decodeIngestID(w, req.IngestID)
	if !ok {
		return
	}
	err := s.Samples.Report(r.Context(), samples.Sample{UserID: userID, IngestID: id})
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, samples.ErrNotIngested):
		// Same answer as /donate's, for the same reason: telling "not yours"
		// apart from "no such message" would confirm the existence of another
		// account's message to whoever guessed its id.
		writeErr(w, http.StatusNotFound, "not_found",
			"this account received no message with that ingest id")
	case errors.Is(err, samples.ErrUnverifiedOrigin):
		writeErr(w, http.StatusConflict, "unverified_origin",
			"this message's sending domain was never cryptographically verified, "+
				"so it cannot be used to build or gate a parser")
	case errors.Is(err, samples.ErrNoRecordedStructure):
		// Not the caller's fault and not a retry: this server could not read the
		// message well enough to fingerprint its layout, so there is no cluster
		// to report it into. Donating it is the path that still works, and the
		// detail says so because that is the useful next step.
		writeErr(w, http.StatusConflict, "no_structure",
			"this server recorded no layout fingerprint for that message, so there is nothing "+
				"to report; donating it is the way to get this format read")
	case errors.Is(err, samples.ErrInvalidSample),
		errors.Is(err, samples.ErrOriginNotCallerSupplied):
		// The detail describes the caller's OWN submission and names no value,
		// so it is safe to return and useful to a client author.
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	default:
		s.logf("api: POST /api/v1/samples/report: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
	}
}

// donateRequest is the opt-in path. consent is the identifier of the text the
// user was shown, which is what makes "what did they agree to" answerable from
// the row a year later.
type donateRequest struct {
	IngestID string `json:"ingest_id"`
	Consent  string `json:"consent"`
}

// handleDonate serves POST /api/v1/samples/donate.
func (s *Server) handleDonate(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.SamplesPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many sample submissions; try again shortly")
		return
	}
	var req donateRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	id, ok := decodeIngestID(w, req.IngestID)
	if !ok {
		return
	}

	err := s.Samples.Donate(r.Context(), samples.Sample{
		UserID:   userID,
		IngestID: id,
		Consent:  req.Consent,
	})
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, samples.ErrNoConsent):
		writeErr(w, http.StatusBadRequest, "consent_required",
			"a donation must name the consent text the user agreed to")
	case errors.Is(err, samples.ErrUnknownConsent):
		// Distinct from consent_required on purpose: this is a client shipping
		// an identifier the server has no text for, which is a release-ordering
		// bug in the client and not something the user can act on.
		writeErr(w, http.StatusBadRequest, "unknown_consent",
			"that consent identifier names no consent text this server knows; "+
				"a donation may only attest to a text that has been versioned")
	case errors.Is(err, samples.ErrNotIngested):
		// Deliberately the same answer for "that is not your message" and "you
		// have no stored body for it". Telling them apart would confirm the
		// existence of another account's message to whoever guessed its id.
		writeErr(w, http.StatusNotFound, "not_found",
			"this account has no stored message with that ingest id")
	case errors.Is(err, samples.ErrUnverifiedOrigin):
		writeErr(w, http.StatusConflict, "unverified_origin",
			"this message's sending domain was never cryptographically verified, "+
				"so it cannot be used to build or gate a parser")
	case errors.Is(err, samples.ErrInvalidSample),
		errors.Is(err, samples.ErrBodySupplied),
		errors.Is(err, samples.ErrOriginNotCallerSupplied):
		// Unreachable from this handler — the request shape has no field for a
		// body, a domain or a signature — and mapped anyway, because "the
		// request type cannot express it" is a property of THIS file that a
		// later edit can remove, and the alternative is a 500 for a 400.
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	default:
		s.logf("api: POST /api/v1/samples/donate: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
	}
}
