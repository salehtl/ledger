package server

import (
	"fmt"
	"net/http"
	"sync"
)

// hub is a minimal in-process SSE fan-out. Each subscriber gets a buffered
// channel; broadcast never blocks (a full buffer drops the event — clients
// re-fetch on the next event anyway).
type hub struct {
	mu   sync.Mutex
	subs map[chan string]struct{}
}

func newHub() *hub {
	return &hub{subs: make(map[chan string]struct{})}
}

func (h *hub) subscribe() chan string {
	ch := make(chan string, 8)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan string) {
	h.mu.Lock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
	h.mu.Unlock()
}

func (h *hub) broadcast(event string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- event:
		default: // slow client; drop
		}
	}
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, `{"error":"streaming unsupported"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := s.hub.subscribe()
	defer s.hub.unsubscribe(ch)

	// Initial comment so EventSource fires `open`.
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "event: %s\ndata: {}\n\n", ev)
			flusher.Flush()
		}
	}
}

// Broadcast sends a named SSE event to all connected clients. Safe to call from
// any goroutine (e.g. the ingest worker after parsing new transactions).
func (s *Server) Broadcast(event string) {
	if s.hub != nil {
		s.hub.broadcast(event)
	}
}
