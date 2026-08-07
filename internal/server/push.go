package server

import (
	"encoding/json"
	"net/http"

	"ledger/internal/store"
)

type pushSubReq struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

type deletePushReq struct {
	Endpoint string `json:"endpoint"`
}

func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	if s.pushStore == nil {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	var req pushSubReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.Endpoint == "" || req.Keys.P256dh == "" || req.Keys.Auth == "" {
		http.Error(w, "endpoint, keys.p256dh, keys.auth required", http.StatusBadRequest)
		return
	}
	if err := s.pushStore.InsertPushSub(store.PushSubRow{
		Endpoint: req.Endpoint,
		P256dh:   req.Keys.P256dh,
		Auth:     req.Keys.Auth,
	}); err != nil {
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if s.pushStore == nil {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	var req deletePushReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.Endpoint == "" {
		http.Error(w, "endpoint required", http.StatusBadRequest)
		return
	}
	if err := s.pushStore.DeletePushSub(req.Endpoint); err != nil {
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePushTest delivers one notification to every registered subscription.
// Every other push depends on a real budget threshold being crossed or a bill
// falling due, so without this there is no way to tell a broken delivery chain
// (permission, subscription, service worker) from simply having nothing to say.
func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request) {
	if s.pushSender == nil || s.pushStore == nil {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	s.pushAll("ledger", "Test notification — push is working.")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleVapidPublicKey(w http.ResponseWriter, r *http.Request) {
	if s.pushSender == nil {
		http.Error(w, "push not configured", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"public_key": s.pushSender.PublicKey()})
}
