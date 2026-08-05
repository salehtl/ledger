package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"ledger/internal/v2/tmpl"
)

type TemplateEntry struct {
	ID                string          `json:"id"`
	Bank              string          `json:"bank"`
	Version           int             `json:"version"`
	NormalizerVersion int             `json:"normalizer_version"`
	Definition        tmpl.Definition `json:"definition"`
	Status            string          `json:"status"`
}
type TemplateResponse struct {
	Version   string          `json:"version"`
	Templates []TemplateEntry `json:"templates"`
	Removed   []string        `json:"removed"`
}

func (s *Server) handleTemplates(w http.ResponseWriter, r *http.Request, _ uuid.UUID) {
	var since int64
	if raw := r.URL.Query().Get("since"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "since must be a non-negative decimal version")
			return
		}
		since = n
	}
	delta, err := s.Templates.PublicationSince(r.Context(), since)
	if err != nil {
		if errors.Is(err, tmpl.ErrPublicationCursor) {
			writeErr(w, http.StatusBadRequest, "bad_request", "since is ahead of the current publication version")
			return
		}
		s.logf("api: GET /api/v1/templates: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	entries := make([]TemplateEntry, 0, len(delta.Templates))
	for _, d := range delta.Templates {
		if err := tmpl.ValidateForPublish(d); err != nil {
			s.logf("api: invalid outgoing template %s: %v", d.ID, err)
			writeErr(w, 500, "internal", "")
			return
		}
		entries = append(entries, TemplateEntry{ID: d.ID, Bank: d.Bank, Version: d.Version, NormalizerVersion: d.NormalizerVersion, Definition: d, Status: tmpl.StatusPublished})
	}
	writeJSON(w, 200, TemplateResponse{Version: strconv.FormatInt(delta.Version, 10), Templates: entries, Removed: delta.Removed})
}
