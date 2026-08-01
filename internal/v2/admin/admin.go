package admin

// admin.go is the operator's console (spec §3.1, plan Task 32): template
// authoring and publishing, the donated-sample replay that gates a publish,
// diagnostics, the mail-accounting report, the operator's quarantine view, and
// the bank waitlist. dict.go is the fifth surface, mounted from here.
//
// # The binding is the control
//
// This handler is only ever mounted on cmd/ledgerd's SECOND listener, and
// config.CheckAdminBind refuses to start that listener on anything but loopback
// or 100.64.0.0/10 — enforced twice, at config load and again immediately
// before net.Listen. Read CheckAdminBind's doc for why: what this console can
// do (publish a parser and a merchant mapping to every device in the beta, read
// every user's diagnostics) is not defensible with a shared static token, and
// the token exists to stop an accident INSIDE the tailnet rather than an
// attacker outside it.
//
// # Admin auth shares nothing with user auth
//
// This package does not import internal/v2/auth and has no idea what a session
// is. There is no code path here that resolves a session token, so a user
// session cannot become an admin credential by any composition of middleware —
// it is not a rule that is checked, it is a capability that is absent.
// TestAUserSessionCannotReachAnAdminRoute pins it against the REAL
// auth.Sessions, and internal/v2/api's own test pins the other direction: no
// path under /api/ reaches any of this.
//
// # No rate limiter, stated deliberately
//
// Every other listener in v2 is rate limited and this one is not. The
// difference is who can reach it: the tailnet, which is the operator's own
// enrolled devices. A limiter here would spend its budget on the operator
// paging through diagnostics and would defend against an attacker who, by
// construction, already has tailnet access and a shell. The token is compared
// in constant time against a high-entropy secret, which is what makes guessing
// the wrong attack to worry about.
//
// If that ever changes — in particular if POST /admin/waitlist is ever fed from
// the PUBLIC onboarding flow through a relay, which is the one endpoint the plan
// describes as "called by onboarding" — the limiter belongs on the relay's
// public side, and it must check the PER-CALLER budget BEFORE any global one.
// A global check evaluated first lets one host drain the shared budget and lock
// everybody out; that exact composition shipped once in this codebase already.

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/dict"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/quarantine"
	"ledger/internal/v2/tmpl"
)

// Request-shaping limits.
const (
	// maxDefinitionBytes caps POST /admin/templates. A template definition is
	// hand-authored JSON; the largest seed is a few kilobytes.
	maxDefinitionBytes = 256 << 10

	// defaultPageLimit / maxPageLimit bound the two paged reads.
	defaultPageLimit = 100
	maxPageLimit     = 500

	// maxQuarantineBlobItems bounds an operator page that carries RAW MESSAGES.
	// A quarantine blob is up to blob.MaxColdMail, so a full ordinary page of
	// them would be half a gigabyte in one response.
	maxQuarantineBlobItems = 20

	// defaultWindow is how far back a report reaches when the caller gives no
	// bounds. Unbounded is the wrong default for a table that grows per message.
	defaultWindow = 7 * 24 * time.Hour
)

// Report is the outcome of a reprocess run. It mirrors Task 30's
// ingest.Pipeline Report field for field; see [Reprocessor].
type Report struct {
	Examined   int `json:"examined"`
	Superseded int `json:"superseded"`
	Unchanged  int `json:"unchanged"`
	Failed     int `json:"failed"`
}

// Reprocessor re-runs the parse over already-received mail.
//
// It is an interface, and this package defines its own, because Task 30's
// ingest.Pipeline.Reprocess had not landed when the console was written. The
// adapter in cmd/ledgerd is three lines and is where the two Report types meet;
// that is a deliberate seam rather than an accident, because ingest imports
// half of v2 and an admin console that could not be tested without a whole
// pipeline would be a console nobody tested.
//
// ⚠ PHASE 1 ONLY, inherited from what it calls: server-side reprocessing reads
// cold bodies, which are HPKE-sealed from Phase 3 onward. See Task 30's
// v2-phase1-only-inventory.
type Reprocessor interface {
	Reprocess(ctx context.Context, userID uuid.UUID, ingestIDs [][]byte) (Report, error)
}

// Sample is one donated message the publish gate replays a template over.
//
// Raw is the message as received. In Phase 1 the server holds it in plaintext,
// which is the only reason a server-side replay is possible at all.
type Sample struct {
	ID           uuid.UUID `json:"id"`
	UserID       uuid.UUID `json:"-"`
	SenderDomain string    `json:"sender_domain"`
	StructureSig string    `json:"structure_sig,omitempty"`
	Raw          []byte    `json:"-"`
	ReceivedAt   time.Time `json:"received_at"`
}

// SampleSource is Task 31's donated-sample corpus, as much of it as the publish
// gate needs. Same reasoning as [Reprocessor]: an interface here, an adapter in
// cmd/ledgerd when the package lands.
type SampleSource interface {
	ForSender(ctx context.Context, domain string) ([]Sample, error)
}

// Handler is the console.
//
// Templates, Diag and Waitlist are required. Quarantine, Dict, Samples and
// Reprocessor are optional and each has a different consequence when absent —
// see Routes and the handlers.
type Handler struct {
	Templates *tmpl.Store
	Diag      *diag.Diag
	Waitlist  *Waitlist

	// Quarantine serves the operator's held-mail view. Nil means the route is
	// not mounted, matching the public API's rule: a deployment that receives no
	// mail has nothing to show.
	Quarantine *quarantine.Store
	// Dict mounts the merchant-dictionary moderation console (dict.go). Nil
	// means those routes are not mounted.
	Dict *dict.Dict

	// Samples is the corpus a validate/publish replays over. Nil is NOT
	// equivalent to an empty corpus: /validate answers 503, and /publish
	// refuses, because "the gate could not run" must never be reported as "the
	// gate found nothing". See publish.
	Samples SampleSource
	// Reprocessor is Task 30. Nil means /reprocess answers 503.
	Reprocessor Reprocessor

	// Token is the shared operator credential (LEDGER_ADMIN_TOKEN). Routes
	// refuses to mount without it.
	Token string
	// Logf receives the operator-facing reason a request was refused, which the
	// response deliberately does not carry. Defaults to log.Printf.
	Logf func(format string, args ...any)
}

func (h *Handler) logf(format string, args ...any) {
	logfOr(h.Logf, format, args...)
}

// Routes mounts the whole console on mux, including the dictionary half.
//
// It returns an error rather than mounting an unauthenticated route when the
// token is missing, and it mounts NOTHING on the way to that error: a console
// that came up half-open because an environment variable was unset is the
// failure mode worth making impossible.
func (h *Handler) Routes(mux *http.ServeMux) error {
	if h == nil {
		return errors.New("admin: nil handler")
	}
	if h.Token == "" {
		return errors.New("admin: refusing to mount the console with no LEDGER_ADMIN_TOKEN: " +
			"this surface publishes templates and merchant mappings to every device in the beta " +
			"and reads diagnostics across all users")
	}
	if h.Templates == nil || h.Diag == nil || h.Waitlist == nil {
		return errors.New("admin: the console needs a template store, a diagnostics store and a waitlist")
	}

	guard := func(next http.HandlerFunc) http.HandlerFunc {
		return requireToken(h.Token, h.logf, next)
	}
	mux.HandleFunc("GET /admin/templates", guard(h.listTemplates))
	mux.HandleFunc("POST /admin/templates", guard(h.authorTemplate))
	mux.HandleFunc("POST /admin/templates/{id}/{version}/validate", guard(h.validateTemplate))
	mux.HandleFunc("POST /admin/templates/{id}/{version}/publish", guard(h.publishTemplate))
	mux.HandleFunc("POST /admin/templates/{id}/{version}/reprocess", guard(h.reprocessTemplate))
	mux.HandleFunc("GET /admin/diagnostics", guard(h.diagnostics))
	mux.HandleFunc("GET /admin/accounting", guard(h.accounting))
	mux.HandleFunc("GET /admin/waitlist", guard(h.listWaitlist))
	mux.HandleFunc("POST /admin/waitlist", guard(h.recordWaitlist))
	if h.Quarantine != nil {
		mux.HandleFunc("GET /admin/quarantine", guard(h.quarantine))
	}
	if h.Dict != nil {
		d := &DictHandler{Dict: h.Dict, Token: h.Token, Logf: h.Logf}
		if err := d.Routes(mux); err != nil {
			return err
		}
	}

	// Catch-all, for the same reason the public API has one: an unrouted
	// /admin/ path must answer 404 rather than falling through to whatever is
	// mounted at "/". It is GUARDED, so an unauthenticated caller cannot map
	// which routes exist by comparing 404 against 401.
	mux.HandleFunc("/admin/", guard(func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "no such endpoint")
	}))
	return nil
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

type templateRow struct {
	ID                string          `json:"id"`
	Version           int             `json:"version"`
	Bank              string          `json:"bank"`
	NormalizerVersion int             `json:"normalizer_version"`
	Status            string          `json:"status"`
	CreatedAt         time.Time       `json:"created_at"`
	PublishedAt       *time.Time      `json:"published_at"`
	Definition        tmpl.Definition `json:"definition"`
}

func (h *Handler) listTemplates(w http.ResponseWriter, r *http.Request) {
	all, err := h.Templates.All(r.Context())
	if err != nil {
		h.logf("admin: list templates: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	rows := make([]templateRow, 0, len(all))
	for _, t := range all {
		rows = append(rows, templateRow{
			ID: t.ID, Version: t.Version, Bank: t.Bank,
			NormalizerVersion: t.NormalizerVersion, Status: t.Status,
			CreatedAt: t.CreatedAt, PublishedAt: t.PublishedAt, Definition: t.Definition,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": rows})
}

type authorRequest struct {
	// Definition is the raw JSON, handed to tmpl.ParseDefinition rather than
	// decoded here, so the STRICT reader — the one that refuses an unknown key —
	// is the only thing that ever turns bytes into a Definition. A struct field
	// of type tmpl.Definition would use encoding/json's lenient default and a
	// misspelled key would be silently dropped, which is exactly how a template
	// "publishes and matches nothing".
	Definition json.RawMessage `json:"definition"`
}

// authorTemplate stores a new DRAFT version.
//
// The full publish gate — dialect, definition validator, executor compile —
// runs HERE, at the API, and the reason is the response: the operator gets a
// 400 naming the dialect reason code they can act on, in the same second they
// pasted the template. A console that deferred the check to the store would
// answer 500 for a fixable mistake.
func (h *Handler) authorTemplate(w http.ResponseWriter, r *http.Request) {
	var req authorRequest
	if !decodeBodyN(w, r, maxDefinitionBytes, &req) {
		return
	}
	if len(req.Definition) == 0 {
		writeErr(w, http.StatusBadRequest, "definition is required")
		return
	}
	d, err := tmpl.ParseDefinition(req.Definition)
	if err != nil {
		// The detail is the operator's OWN submission, so returning it is safe
		// here in a way it never is on the public API.
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.Templates.SaveDraft(r.Context(), d); err != nil {
		switch {
		case errors.Is(err, tmpl.ErrInvalidDefinition):
			writeErr(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, tmpl.ErrVersionExists):
			writeErr(w, http.StatusConflict, err.Error())
		default:
			h.logf("admin: save draft: %v", err)
			writeErr(w, http.StatusInternalServerError, "internal")
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": d.ID, "version": d.Version, "status": tmpl.StatusDraft,
	})
}

// sampleResult is one replayed message.
type sampleResult struct {
	SampleID     uuid.UUID `json:"sample_id"`
	SenderDomain string    `json:"sender_domain"`
	Matched      bool      `json:"matched"`
	// Reason is why it did not match: an executor error, never message content.
	Reason string `json:"reason,omitempty"`
	// EmptyGroups names the capture groups that matched but captured nothing —
	// the drift signal, and the field an operator fixes a pattern from.
	EmptyGroups []string `json:"empty_groups,omitempty"`
}

type validateResponse struct {
	TemplateID string `json:"template_id"`
	Version    int    `json:"version"`
	// NormalizerMismatch is true when the definition declares a normalizer
	// version other than the one ingest actually runs. The replay uses the
	// PRODUCTION version either way, because a validation that predicted
	// something other than production would be worse than none.
	NormalizerVersion  int            `json:"normalizer_version"`
	ReplayedWith       int            `json:"replayed_with"`
	NormalizerMismatch bool           `json:"normalizer_mismatch"`
	Samples            int            `json:"samples"`
	Matched            int            `json:"matched"`
	Results            []sampleResult `json:"results"`
}

func (h *Handler) validateTemplate(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.lookup(w, r)
	if !ok {
		return
	}
	if h.Samples == nil {
		writeErr(w, http.StatusServiceUnavailable,
			"the donated-sample corpus is not configured, so a replay cannot run")
		return
	}
	samples, err := h.samplesFor(r.Context(), rec.Definition.Match.SenderDomain)
	if err != nil {
		h.logf("admin: read donated samples: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	results, matched, err := replay(rec.Definition, samples)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, validateResponse{
		TemplateID:         rec.ID,
		Version:            rec.Version,
		NormalizerVersion:  rec.Definition.NormalizerVersion,
		ReplayedWith:       norm.CurrentVersion,
		NormalizerMismatch: rec.Definition.NormalizerVersion != norm.CurrentVersion,
		Samples:            len(samples),
		Matched:            matched,
		Results:            results,
	})
}

// publishTemplate promotes a stored version to live, refusing a REGRESSION.
//
// A regression is a donated sample the currently live version parses and the
// candidate does not. That comparison — rather than "the candidate parses
// everything" — is the honest one: a corpus always contains messages no
// template was ever meant to handle, and a gate that demanded 100% would be
// switched off within a week.
//
// The refusal is absolute; there is no force flag. A template version that
// stops parsing real mail somebody actually received is a bug essentially every
// time, and a flag to skip the check is a flag that becomes the habit. An
// operator who genuinely means to drop a format retires the sample.
func (h *Handler) publishTemplate(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.lookup(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	// The baseline. ErrNoLiveVersion is not an error condition: a bank's first
	// template has nothing to regress against.
	//
	// Re-publishing the version that is ALREADY live is not special-cased: the
	// baseline is then the candidate itself, nothing can regress against itself,
	// and tmpl.SetStatus is a no-op. Short-circuiting it would mean reporting
	// "0 samples" for a call that did in fact have a corpus, and a report that
	// varies with a path the operator cannot see is worse than a redundant
	// replay of a few dozen messages.
	var live *tmpl.Definition
	switch cur, err := h.Templates.Live(ctx, rec.ID); {
	case err == nil:
		live = &cur.Definition
	case errors.Is(err, tmpl.ErrNoLiveVersion):
	default:
		h.logf("admin: read the live version of %s: %v", rec.ID, err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	// The domains are the UNION of the candidate's and the outgoing version's.
	// A candidate that DROPPED a sender domain regresses every message from it,
	// and looking only at the candidate's own list is precisely how that change
	// would sail through.
	domains := slices.Clone(rec.Definition.Match.SenderDomain)
	if live != nil {
		domains = append(domains, live.Match.SenderDomain...)
	}

	var samples []Sample
	if h.Samples == nil {
		// NOT treated as an empty corpus. "The gate could not run" reported as
		// "the gate found nothing" is how a gate stops being one.
		writeErr(w, http.StatusServiceUnavailable,
			"the donated-sample corpus is not configured, so the regression gate cannot run")
		return
	}
	var err error
	if samples, err = h.samplesFor(ctx, domains); err != nil {
		h.logf("admin: read donated samples: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	candidate, matched, err := replay(rec.Definition, samples)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	regressions := []sampleResult{}
	if live != nil {
		baseline, _, err := replay(*live, samples)
		if err != nil {
			h.logf("admin: the LIVE version of %s cannot be replayed: %v", rec.ID, err)
			writeErr(w, http.StatusInternalServerError, "internal")
			return
		}
		for i := range candidate {
			if baseline[i].Matched && !candidate[i].Matched {
				regressions = append(regressions, candidate[i])
			}
		}
	}
	if len(regressions) > 0 {
		h.logf("admin: refusing to publish %s v%d: %d of %d donated samples regress",
			rec.ID, rec.Version, len(regressions), len(samples))
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":       "regression",
			"template_id": rec.ID, "version": rec.Version,
			"samples": len(samples), "matched": matched,
			"regressions": regressions,
		})
		return
	}

	if err := h.Templates.SetStatus(ctx, rec.ID, rec.Version, tmpl.StatusPublished); err != nil {
		switch {
		case errors.Is(err, tmpl.ErrInvalidDefinition):
			writeErr(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, tmpl.ErrPublishConflict):
			writeErr(w, http.StatusConflict, err.Error())
		case errors.Is(err, tmpl.ErrNotFound):
			writeErr(w, http.StatusNotFound, err.Error())
		default:
			h.logf("admin: publish %s v%d: %v", rec.ID, rec.Version, err)
			writeErr(w, http.StatusInternalServerError, "internal")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"template_id": rec.ID, "version": rec.Version, "status": tmpl.StatusPublished,
		"samples": len(samples), "matched": matched, "regressions": regressions,
	})
}

type reprocessResponse struct {
	TemplateID string `json:"template_id"`
	Version    int    `json:"version"`
	Users      int    `json:"users"`
	Messages   int    `json:"messages"`
	Report
	// Errors names the users whose reprocess failed. The run CONTINUES past a
	// failure: one user's unreadable cold blob must not silently abandon
	// everybody else's backfill, and a partial result the operator can see beats
	// a 500 that says nothing about what did happen.
	Errors []string `json:"errors,omitempty"`
}

// reprocessTemplate re-runs the parse over the mail this template's change
// could alter: the messages it parsed or was tried on, and the messages from
// its sender domains that no tier resolved.
func (h *Handler) reprocessTemplate(w http.ResponseWriter, r *http.Request) {
	rec, ok := h.lookup(w, r)
	if !ok {
		return
	}
	if h.Reprocessor == nil {
		writeErr(w, http.StatusServiceUnavailable, "server-side reprocessing is not configured")
		return
	}
	ctx := r.Context()
	from, to, ok := h.window(w, r)
	if !ok {
		return
	}

	// The sender-domain expansion goes through tmpl.MatchesSenderDomain over the
	// domains that actually appear, rather than a LIKE in SQL. That rule —
	// "dib.ae covers alerts.dib.ae and not evildib.ae" — has exactly one
	// implementation by design, and this is a caller of it, not a second one.
	seen, err := h.Diag.SenderDomains(ctx, from, to)
	if err != nil {
		h.logf("admin: read sender domains: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	var domains []string
	for _, dom := range seen {
		if tmpl.MatchesSenderDomain(rec.Definition, dom) {
			domains = append(domains, dom)
		}
	}

	affected, err := h.Diag.Affected(ctx, diag.AffectedFilter{
		TemplateID: rec.ID, SenderDomains: domains, From: from, To: to,
	})
	if err != nil {
		h.logf("admin: affected set for %s: %v", rec.ID, err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	byUser := map[uuid.UUID][][]byte{}
	order := []uuid.UUID{}
	for _, a := range affected {
		if _, ok := byUser[a.UserID]; !ok {
			order = append(order, a.UserID)
		}
		byUser[a.UserID] = append(byUser[a.UserID], a.IngestID)
	}

	out := reprocessResponse{
		TemplateID: rec.ID, Version: rec.Version,
		Users: len(order), Messages: len(affected),
	}
	for _, u := range order {
		rep, err := h.Reprocessor.Reprocess(ctx, u, byUser[u])
		if err != nil {
			h.logf("admin: reprocess for %s: %v", u, err)
			out.Errors = append(out.Errors, u.String())
			out.Failed += len(byUser[u])
			continue
		}
		out.Examined += rep.Examined
		out.Superseded += rep.Superseded
		out.Unchanged += rep.Unchanged
		out.Failed += rep.Failed
	}
	writeJSON(w, http.StatusOK, out)
}

// lookup resolves {id}/{version} to a stored record, answering 404 or 400
// itself. It reports whether the caller should continue.
func (h *Handler) lookup(w http.ResponseWriter, r *http.Request) (tmpl.Record, bool) {
	id := r.PathValue("id")
	version, err := strconv.Atoi(r.PathValue("version"))
	if err != nil || version < 1 {
		writeErr(w, http.StatusBadRequest, "version must be a positive integer")
		return tmpl.Record{}, false
	}
	rec, err := h.Templates.Get(r.Context(), id, version)
	if errors.Is(err, tmpl.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no such template version")
		return tmpl.Record{}, false
	}
	if err != nil {
		h.logf("admin: read template %s v%d: %v", id, version, err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return tmpl.Record{}, false
	}
	return rec, true
}

// samplesFor collects the donated corpus for a set of sender domains,
// deduplicated by sample id: one message can be donated under a domain and its
// parent, and replaying it twice would double-count a regression.
func (h *Handler) samplesFor(ctx context.Context, domains []string) ([]Sample, error) {
	var (
		out  []Sample
		seen = map[uuid.UUID]bool{}
	)
	for _, dom := range domains {
		got, err := h.Samples.ForSender(ctx, dom)
		if err != nil {
			return nil, fmt.Errorf("sender %s: %w", dom, err)
		}
		for _, s := range got {
			if seen[s.ID] {
				continue
			}
			seen[s.ID] = true
			out = append(out, s)
		}
	}
	return out, nil
}

// replay runs one definition over every sample, in order, and returns a result
// per sample plus the number that matched.
//
// The normalizer version used is norm.CurrentVersion — what ingest actually
// runs — and NOT the version the definition declares. A validation that
// predicted anything other than production behaviour would be worse than no
// validation, so the mismatch is REPORTED (validateResponse.NormalizerMismatch)
// rather than silently honoured.
func replay(d tmpl.Definition, samples []Sample) ([]sampleResult, int, error) {
	c, err := tmpl.Compile(d)
	if err != nil {
		return nil, 0, fmt.Errorf("this definition does not compile: %w", err)
	}
	results := make([]sampleResult, 0, len(samples))
	matched := 0
	for _, s := range samples {
		res := sampleResult{SampleID: s.ID, SenderDomain: s.SenderDomain}
		nr, nerr := norm.Normalize(norm.CurrentVersion, s.Raw, s.ReceivedAt)
		if nerr != nil {
			// The normalizer's error names a structural fact about the message
			// (no text part, unsupported charset), never its content.
			res.Reason = "normalize: " + nerr.Error()
			results = append(results, res)
			continue
		}
		ext, xerr := c.Execute(nr.Subject, nr.Text)
		res.EmptyGroups = ext.EmptyGroups
		if xerr != nil {
			res.Reason = xerr.Error()
			results = append(results, res)
			continue
		}
		res.Matched = true
		matched++
		results = append(results, res)
	}
	return results, matched, nil
}

// ---------------------------------------------------------------------------
// diagnostics and accounting
// ---------------------------------------------------------------------------

// diagRow is the wire form of a diagnostics record. ingest_id travels as hex
// for the same reason oplog's chain hashes do, and user_id is nullable because
// a protocol-layer refusal never resolved one.
type diagRowJSON struct {
	ID                uuid.UUID  `json:"id"`
	UserID            *uuid.UUID `json:"user_id"`
	Event             string     `json:"event"`
	IngestID          string     `json:"ingest_id"`
	ReceivedAt        time.Time  `json:"received_at"`
	SenderDomain      string     `json:"sender_domain"`
	DKIMResult        string     `json:"dkim_result"`
	ARCResult         string     `json:"arc_result"`
	InnerOriginDomain string     `json:"inner_origin_domain,omitempty"`
	TemplateID        string     `json:"template_id,omitempty"`
	TemplateVersion   int        `json:"template_version,omitempty"`
	NormalizerVersion int        `json:"normalizer_version"`
	Matched           bool       `json:"matched"`
	EmptyGroups       []string   `json:"empty_groups"`
	Tier              string     `json:"tier"`
	BodySizeBucket    int        `json:"body_size_bucket"`
	StructureSig      string     `json:"structure_sig,omitempty"`
	Outcome           string     `json:"outcome"`
	RejectReason      string     `json:"reject_reason,omitempty"`
}

func (h *Handler) diagnostics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, to, ok := h.window(w, r)
	if !ok {
		return
	}
	f := diag.Filter{
		From:    from,
		To:      to,
		Event:   q.Get("event"),
		Outcome: q.Get("outcome"),
	}
	if raw := q.Get("user"); raw != "" {
		u, err := uuid.Parse(raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "user must be a uuid")
			return
		}
		f.UserID = uuid.NullUUID{UUID: u, Valid: true}
	}
	limit, ok := parseLimit(w, r, defaultPageLimit, maxPageLimit)
	if !ok {
		return
	}
	f.Limit = limit
	if raw := q.Get("after"); raw != "" {
		at, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "after must be an RFC3339 instant")
			return
		}
		id, err := uuid.Parse(q.Get("after_id"))
		if err != nil {
			writeErr(w, http.StatusBadRequest, "after_id must be a uuid and travels with after")
			return
		}
		f.After = diag.Cursor{ReceivedAt: at, ID: id}
	}

	rows, err := h.Diag.Query(r.Context(), f)
	if err != nil {
		if errors.Is(err, diag.ErrInvalidRecord) {
			// The filter is out of the closed set. The detail is the operator's
			// own query string, so it is safe to return.
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		h.logf("admin: query diagnostics: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	out := make([]diagRowJSON, 0, len(rows))
	for _, d := range rows {
		row := diagRowJSON{
			ID: d.ID, Event: d.Event, IngestID: hex.EncodeToString(d.IngestID),
			ReceivedAt: d.ReceivedAt, SenderDomain: d.SenderDomain,
			DKIMResult: d.DKIMResult, ARCResult: d.ARCResult,
			InnerOriginDomain: d.InnerOriginDomain, TemplateID: d.TemplateID,
			TemplateVersion: d.TemplateVersion, NormalizerVersion: d.NormalizerVersion,
			Matched: d.Matched, EmptyGroups: d.EmptyGroups, Tier: d.Tier,
			BodySizeBucket: d.BodySizeBucket, StructureSig: d.StructureSig,
			Outcome: d.Outcome, RejectReason: d.RejectReason,
		}
		if row.EmptyGroups == nil {
			row.EmptyGroups = []string{}
		}
		if d.UserID.Valid {
			u := d.UserID.UUID
			row.UserID = &u
		}
		out = append(out, row)
	}
	body := map[string]any{"rows": out, "complete": len(rows) < limit}
	if len(rows) == limit {
		last := rows[len(rows)-1]
		body["next"] = map[string]any{"received_at": last.ReceivedAt, "id": last.ID}
	}
	writeJSON(w, http.StatusOK, body)
}

// accounting is spec §2's "every email accounted for" report.
func (h *Handler) accounting(w http.ResponseWriter, r *http.Request) {
	from, to, ok := h.window(w, r)
	if !ok {
		return
	}
	// Accounting ECHOES its window in the report, so unbounded is not an option
	// here: a report that says "from 0001-01-01" is a report nobody can compare
	// against another one.
	if to.IsZero() {
		to = time.Now()
	}
	if from.IsZero() {
		from = to.Add(-defaultWindow)
	}
	acc, err := h.Diag.Accounting(r.Context(), from, to)
	if err != nil {
		h.logf("admin: accounting: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from": acc.From, "to": acc.To,
		"inbound_total": acc.InboundTotal,
		"arrival":       acc.Arrival,
		"reprocess":     acc.Reprocess,
		"rejections":    acc.Rejections,
		"unaccounted":   acc.Unaccounted,
	})
}

// ---------------------------------------------------------------------------
// quarantine
// ---------------------------------------------------------------------------

type quarantineItem struct {
	ID          uuid.UUID  `json:"id"`
	IngestID    string     `json:"ingest_id"`
	ReceivedAt  time.Time  `json:"received_at"`
	ExpiresAt   time.Time  `json:"expires_at"`
	WarnedAt    *time.Time `json:"warned_at"`
	OuterDomain string     `json:"outer_domain"`
	InnerDomain string     `json:"inner_domain,omitempty"`
	Attested    bool       `json:"attested"`
	AttestedBy  string     `json:"attested_by,omitempty"`
	DKIM        string     `json:"dkim"`
	ARC         string     `json:"arc"`
	SizeBucket  int        `json:"size_bucket"`
	// Blob is the raw message, present only when include_blob=1.
	Blob []byte `json:"blob,omitempty"`
}

// quarantine is the OPERATOR's view of held mail.
//
// It differs from the user-facing lane in exactly one way that matters: it can
// return the raw message. That exists for a concrete Phase 1 need — Gmail's
// forward-verification mail quarantines like everything else and the operator
// reads the confirmation link out of it during onboarding (§3.2:47) — and it is
// opt-in per request, page-capped hard, and LOGGED, because it is the one route
// in this system that hands a user's mail to somebody who is not that user.
func (h *Handler) quarantine(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	user, err := uuid.Parse(q.Get("user"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "user must be a uuid (the operator's view is per account)")
		return
	}
	withBlob := q.Get("include_blob") == "1"
	max := maxPageLimit
	if withBlob {
		max = maxQuarantineBlobItems
	}
	limit, ok := parseLimit(w, r, min(defaultPageLimit, max), max)
	if !ok {
		return
	}
	var after quarantine.Cursor
	if raw := q.Get("after"); raw != "" {
		at, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "after must be an RFC3339 instant")
			return
		}
		after.At = at
		if rawID := q.Get("after_id"); rawID != "" {
			id, err := uuid.Parse(rawID)
			if err != nil {
				writeErr(w, http.StatusBadRequest, "after_id must be a uuid")
				return
			}
			after.ID = id
		}
	}

	items, err := h.Quarantine.List(r.Context(), user, after, limit, withBlob)
	if err != nil {
		h.logf("admin: list quarantine for %s: %v", user, err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if withBlob {
		h.logf("admin: OPERATOR READ %d raw quarantined message(s) for user %s", len(items), user)
	}
	out := make([]quarantineItem, 0, len(items))
	for _, it := range items {
		out = append(out, quarantineItem{
			ID: it.ID, IngestID: hex.EncodeToString(it.IngestID),
			ReceivedAt: it.ReceivedAt, ExpiresAt: it.ExpiresAt, WarnedAt: it.WarnedAt,
			OuterDomain: it.OuterDomain, InnerDomain: it.InnerDomain,
			Attested: it.Attested, AttestedBy: it.AttestedBy,
			DKIM: it.DKIM, ARC: it.ARC, SizeBucket: it.SizeBucket, Blob: it.Blob,
		})
	}
	body := map[string]any{"items": out, "complete": len(items) < limit}
	if len(items) == limit {
		last := items[len(items)-1]
		body["next"] = map[string]any{"received_at": last.ReceivedAt, "id": last.ID}
	}
	writeJSON(w, http.StatusOK, body)
}

// ---------------------------------------------------------------------------
// waitlist
// ---------------------------------------------------------------------------

func (h *Handler) listWaitlist(w http.ResponseWriter, r *http.Request) {
	entries, err := h.Waitlist.List(r.Context())
	if err != nil {
		h.logf("admin: list waitlist: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"banks": entries})
}

type waitlistRequest struct {
	Bank string `json:"bank"`
}

func (h *Handler) recordWaitlist(w http.ResponseWriter, r *http.Request) {
	var req waitlistRequest
	if !decodeBodyN(w, r, maxBodyBytes, &req) {
		return
	}
	err := h.Waitlist.Record(r.Context(), req.Bank)
	switch {
	case errors.Is(err, ErrInvalidBank):
		writeErr(w, http.StatusBadRequest, err.Error())
	case err != nil:
		h.logf("admin: record waitlist demand: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

// window reads the ?from and ?to bounds. Either being absent means UNBOUNDED in
// that direction.
//
// An absent `to` is deliberately NOT defaulted to time.Now(). It reads as the
// same thing for real data — nothing arrives in the future — but it makes every
// read depend on the wall clock at the instant the request lands, which is how
// a report becomes irreproducible and how a test that seeds a row "one minute
// from now" silently sees fewer rows than it wrote. The one caller that needs
// concrete endpoints (accounting, whose report ECHOES them) fills them in
// itself, visibly.
func (h *Handler) window(w http.ResponseWriter, r *http.Request) (from, to time.Time, ok bool) {
	q := r.URL.Query()
	if raw := q.Get("from"); raw != "" {
		t, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "from must be an RFC3339 instant")
			return time.Time{}, time.Time{}, false
		}
		from = t
	}
	if raw := q.Get("to"); raw != "" {
		t, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "to must be an RFC3339 instant")
			return time.Time{}, time.Time{}, false
		}
		to = t
	}
	if !from.IsZero() && !to.IsZero() && !to.After(from) {
		writeErr(w, http.StatusBadRequest, "from must be before to")
		return time.Time{}, time.Time{}, false
	}
	return from, to, true
}

// parseLimit reads ?limit. An over-large value is CAPPED rather than refused —
// the response says whether the page was complete either way — but a
// non-numeric or non-positive one is a mistake worth reporting.
func parseLimit(w http.ResponseWriter, r *http.Request, def, max int) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return def, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		writeErr(w, http.StatusBadRequest, "limit must be a positive integer")
		return 0, false
	}
	if n > max {
		n = max
	}
	return n, true
}

// requireToken compares the bearer credential in constant time and is the ONE
// gate on this listener. Both handlers in this package go through it.
//
// Every rejection is the identical 401 — no header, wrong scheme, wrong token,
// a valid USER SESSION token — because a response that distinguishes them is an
// oracle. The reason goes to the operator log.
//
// Note what is NOT here: there is no fallback to any other credential, and no
// import of internal/v2/auth. A session token reaching this function is simply
// a string that does not equal the operator token.
func requireToken(token string, logf func(string, ...any), next http.HandlerFunc) http.HandlerFunc {
	want := []byte(token)
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		const scheme = "bearer "
		if len(auth) <= len(scheme) || !strings.EqualFold(auth[:len(scheme)], scheme) {
			logfOr(logf, "admin: %s %s: no bearer token", r.Method, r.URL.Path)
			unauthorized(w)
			return
		}
		got := []byte(strings.TrimSpace(auth[len(scheme):]))
		// ConstantTimeCompare returns 0 for differing lengths without comparing,
		// so the length check is not itself the timing signal — but it is why the
		// call cannot be relied on to hide the length. That is acceptable for a
		// fixed operator token and worth writing down.
		if subtle.ConstantTimeCompare(got, want) != 1 {
			logfOr(logf, "admin: %s %s: token mismatch", r.Method, r.URL.Path)
			unauthorized(w)
			return
		}
		next(w, r)
	}
}

func logfOr(logf func(string, ...any), format string, args ...any) {
	if logf != nil {
		logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

// decodeBodyN reads a JSON request body under a byte cap, refusing unknown
// fields so an operator's typo is a loud 400 rather than a silently ignored
// value. It reports whether it already answered.
func decodeBodyN(w http.ResponseWriter, r *http.Request, max int64, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeErr(w, http.StatusRequestEntityTooLarge,
				"request body exceeds "+strconv.FormatInt(max, 10)+" bytes")
			return false
		}
		writeErr(w, http.StatusBadRequest, "body is not valid JSON for this endpoint")
		return false
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeErr(w, http.StatusBadRequest, "body carries more than one JSON value")
		return false
	}
	return true
}
