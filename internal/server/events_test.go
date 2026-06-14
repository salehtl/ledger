package server

import (
	"testing"
	"time"
)

func TestHubBroadcast(t *testing.T) {
	h := newHub()
	ch := h.subscribe()
	defer h.unsubscribe(ch)

	h.broadcast("tx")
	select {
	case ev := <-ch:
		if ev != "tx" {
			t.Errorf("event = %q, want tx", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no event received")
	}
}

func TestHubBroadcastDoesNotBlockOnSlowClient(t *testing.T) {
	h := newHub()
	_ = h.subscribe() // never drained
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			h.broadcast("tx")
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("broadcast blocked on a slow client")
	}
}
