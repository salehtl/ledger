package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Hub maintains a set of SSE subscriber channels and fan-outs JSON payloads.
type Hub struct {
	mu      sync.RWMutex
	clients map[chan []byte]struct{}
}

// NewHub creates an empty Hub.
func NewHub() *Hub { return &Hub{clients: make(map[chan []byte]struct{})} }

// Subscribe registers a new client. Returns the event channel and an unsubscribe
// function the caller must invoke (typically via defer) when done.
func (h *Hub) Subscribe() (chan []byte, func()) {
	ch := make(chan []byte, 16)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.clients, ch)
		close(ch)
		h.mu.Unlock()
	}
}

// Broadcast sends data to all connected clients. Slow clients that haven't
// drained their channel are silently skipped rather than blocking the sender.
func (h *Hub) Broadcast(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.clients {
		select {
		case ch <- data:
		default:
		}
	}
}

// BroadcastEvent serialises {type, data} and broadcasts it to all subscribers.
func (h *Hub) BroadcastEvent(eventType string, data any) {
	payload, err := json.Marshal(map[string]any{"type": eventType, "data": data})
	if err != nil {
		return
	}
	h.Broadcast(payload)
}

// handleEvents serves GET /api/events as a Server-Sent Events stream.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if s.hub == nil {
		http.Error(w, "events not configured", http.StatusServiceUnavailable)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch, unsub := s.hub.Subscribe()
	defer unsub()

	fmt.Fprintf(w, "event: heartbeat\ndata: {}\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprintf(w, "event: heartbeat\ndata: {}\n\n")
			flusher.Flush()
		case data, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}
