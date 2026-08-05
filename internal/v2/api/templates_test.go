package api

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"ledger/internal/v2/tmpl"
)

func apiTemplate(t *testing.T) tmpl.Definition {
	t.Helper()
	raw, err := os.ReadFile("../tmpl/testdata/dib.card.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	d, err := tmpl.ParseDefinition(raw)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestTemplatesRouteIsAuthenticatedAndReturnsPublicationCursor(t *testing.T) {
	h := newHarness(t)
	user := h.user("template-reader")
	token := h.session(user)
	if err := h.srv.Templates.Publish(bg, apiTemplate(t)); err != nil {
		t.Fatal(err)
	}

	w := h.req(http.MethodGet, "/api/v1/templates", "", nil)
	wantStatus(t, w, http.StatusUnauthorized)
	w = h.req(http.MethodGet, "/api/v1/templates?since=-1", token, nil)
	wantStatus(t, w, http.StatusBadRequest)
	w = h.req(http.MethodGet, "/api/v1/templates?since=0", token, nil)
	wantStatus(t, w, http.StatusOK)
	var body TemplateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Version == "0" || len(body.Templates) != 1 || body.Templates[0].Status != tmpl.StatusPublished || len(body.Removed) != 0 {
		t.Fatalf("response = %+v", body)
	}
}

func TestTemplatesRouteRefusesInvalidStoredOutgoingDefinition(t *testing.T) {
	h := newHarness(t)
	user := h.user("invalid-template-reader")
	token := h.session(user)
	d := apiTemplate(t)
	if err := h.srv.Templates.Publish(bg, d); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(bg, `UPDATE templates SET definition=definition || '{"surprise":true}'::jsonb WHERE id=$1`, d.ID); err != nil {
		t.Fatal(err)
	}
	w := h.req(http.MethodGet, "/api/v1/templates", token, nil)
	wantStatus(t, w, http.StatusInternalServerError)
}
