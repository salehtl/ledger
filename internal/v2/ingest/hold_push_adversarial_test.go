package ingest

// hold_push_adversarial_test.go is the adversarial pass over the one relaxation
// of "quarantined mail never pushes" (the hold-path confirmation push in
// pipeline.go). It attacks the gate as BUILT and adds coverage the existing
// suite reached only through stubOrigin: every attack below that can be run
// against the REAL DKIM resolver is, because a stub could hide a resolver that
// produces a different origin shape than the one the gate was reasoned about.
//
// Each test carries a POSITIVE CONTROL — a path proven to push — so a green
// "no push" assertion cannot be a fixture that silently never reached the gate.
//
// Proven to bite (temporary source mutations, reverted; net diff is tests only):
//   - Test A: drop condition 4 (HasConfirmedAnySender) in hold → the set-up
//     user is buzzed → the want-0 assertion fails.
//   - Test B: make isProviderConfirmation return true → the unsigned spoofer
//     pushes → fails.
//   - Test C-reflect: add a body/category param to Pusher.Notify → NumIn()!=2 →
//     fails at compile/reflect. Test C-behaviour: n/a (asserts a positive push).
//   - Test D: move the notify() call above p.Quarantine.Hold in hold → a
//     rolled-back store pushes → fails.

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/budget"
	"ledger/internal/v2/origin"
)

// providerSigned is a message the REAL resolver reads as a mail provider's own
// signed mail: From a forwarder domain, DKIM d=<forwarder> verifying against a
// published key, no relay and so no inner origin. It is exactly what a stranger
// with an account at that provider produces — the provider signs their outbound
// mail for real, so the attacker forges nothing. isProviderConfirmation is true
// over it, via the resolver rather than a stub.
func providerSigned(r *rig, forwarder string) []byte {
	r.t.Helper()
	return r.keys.sign(forwarder, "sel",
		message("<stranger@"+forwarder+">", "Hello", "knock knock\n"))
}

// TestARealForwarderSignedStrangerCannotBuzzASetUpUser is attack 1 against the
// real resolver: a stranger who knows the inbound address, sending genuinely
// provider-signed mail, must not be able to buzz a user who has finished setting
// up. HasConfirmedAnySender is the only thing standing between them.
func TestARealForwarderSignedStrangerCannotBuzzASetUpUser(t *testing.T) {
	// Positive control: on a brand-new account the shape DOES push, and it does
	// so through the real DKIM resolver. Without this a green attack below could
	// be a fixture that never reached the gate at all.
	fresh := newRig(t)
	fresh.mustDeliver(providerSigned(fresh, "google.com"), "stranger@google.com")
	if got := fresh.heldCount(); got != 1 {
		t.Fatalf("fresh: held = %d, want 1 (the message must reach the hold path)", got)
	}
	if got := fresh.push.count(); got != 1 {
		t.Fatalf("fresh: pushes = %d, want 1: the real forwarder-signed shape reaches the gate", got)
	}

	// The attack: the identical real message, but the user has already confirmed
	// a sender on some other domain. The onboarding window is shut, so no push.
	setUp := newRig(t)
	setUp.allow("somebank.example", origin.ScopeOuter)
	setUp.mustDeliver(providerSigned(setUp, "google.com"), "stranger@google.com")
	if got := setUp.heldCount(); got != 1 {
		t.Fatalf("set-up: held = %d, want 1: the message still reaches the hold path", got)
	}
	if got := setUp.push.count(); got != 0 {
		t.Fatalf("set-up: pushes = %d, want 0: a confirmed sender closes the window", got)
	}
	if got := setUp.rows(); len(got) != 0 {
		t.Fatalf("set-up: op_log has %d rows; the stranger's mail must never append", len(got))
	}
}

// TestARealUnsignedForwarderSpooferDoesNotPush is attack 2 against the real
// resolver. The spoofer knows the address but cannot sign as the provider, so
// their message names a forwarder only in its envelope. The resolver refuses to
// call it google.com without a signature — the outer origin is UNVERIFIED and
// DKIM is none — which fails isProviderConfirmation's conditions 1 and 2 at
// once. The account is fresh, so only the shape gate can stop the push; the
// contrast with Test A (identical but SIGNED, and it pushed) isolates the
// signature as the load-bearing difference.
func TestARealUnsignedForwarderSpooferDoesNotPush(t *testing.T) {
	r := newRig(t)
	r.mustDeliver(message("<noreply@google.com>", "Confirm forwarding", "Please confirm.\n"),
		"noreply@google.com")
	if got := r.heldCount(); got != 1 {
		t.Fatalf("held = %d, want 1: the unsigned spoof reaches the hold path", got)
	}
	if got := r.push.count(); got != 0 {
		t.Fatalf("pushes = %d, want 0: an unsigned forwarder claim must not buzz a phone", got)
	}
}

// TestTheConfirmationPushWireIsContentFree is attack 4. The wire is Notify(user)
// and nothing else; there must be no channel for a body, a category, or a "this
// is a confirmation" flag. Two independent readings: the interface signature by
// reflection (a body/category parameter changes NumIn), and the recorded call
// itself (only a user id, and it is the delivery's own).
func TestTheConfirmationPushWireIsContentFree(t *testing.T) {
	// (1) The signature. Notify takes a context and a user id, returns an error,
	// and has no other parameter through which content could pass.
	it := reflect.TypeOf((*Pusher)(nil)).Elem()
	if it.Kind() != reflect.Interface || it.NumMethod() != 1 {
		t.Fatalf("Pusher is %s with %d methods, want a single-method interface", it.Kind(), it.NumMethod())
	}
	m, ok := it.MethodByName("Notify")
	if !ok {
		t.Fatal("Pusher has no Notify method")
	}
	ft := m.Type
	if ft.IsVariadic() {
		t.Fatal("Notify is variadic; content could ride in the tail")
	}
	if ft.NumIn() != 2 || ft.NumOut() != 1 {
		t.Fatalf("Notify has %d in / %d out, want 2 in (context, user) / 1 out (error)", ft.NumIn(), ft.NumOut())
	}
	if ft.In(0) != reflect.TypeOf((*context.Context)(nil)).Elem() {
		t.Fatalf("Notify's first arg is %s, want context.Context", ft.In(0))
	}
	if ft.In(1) != reflect.TypeOf(uuid.UUID{}) {
		t.Fatalf("Notify's second arg is %s, want uuid.UUID and nothing richer", ft.In(1))
	}
	if ft.Out(0) != reflect.TypeOf((*error)(nil)).Elem() {
		t.Fatalf("Notify returns %s, want error", ft.Out(0))
	}

	// (2) The call. A real confirmation fires exactly one push, carrying the
	// delivery's user id and — because the recorder can hold nothing else —
	// nothing more.
	r := newRig(t)
	r.mustDeliver(providerSigned(r, "google.com"), "stranger@google.com")
	r.push.mu.Lock()
	calls := append([]uuid.UUID(nil), r.push.calls...)
	r.push.mu.Unlock()
	if len(calls) != 1 {
		t.Fatalf("recorded %d pushes, want exactly 1", len(calls))
	}
	if calls[0] != r.user {
		t.Fatalf("push carried user %s, want the delivery's own %s", calls[0], r.user)
	}
}

// TestAHeldMessageThatFailedToStoreDoesNotPush is attack 5: the push is after
// the durable hold, like the append path's own ordering. The quarantine lane is
// slammed to its count ceiling so the hold rolls back, then the one shape that
// WOULD push (Test A proved the identical fixture pushes when the store succeeds)
// is delivered. A rolled-back store must leave no push behind.
func TestAHeldMessageThatFailedToStoreDoesNotPush(t *testing.T) {
	r := newRig(t)
	// Zero the default count ceiling: the first hold's count admission refuses,
	// rolling the whole hold transaction back (the byte charge with it).
	if _, err := r.pool.Exec(bg,
		`UPDATE account_limits SET quarantine_count = 0 WHERE user_id IS NULL`); err != nil {
		t.Fatal(err)
	}
	raw := providerSigned(r, "google.com")

	err := r.deliver(raw, "stranger@google.com")
	if !errors.Is(err, budget.ErrRefused) {
		t.Fatalf("deliver = %v, want budget.ErrRefused: the hold must roll back", err)
	}
	if got := r.heldCount(); got != 0 {
		t.Fatalf("held = %d, want 0: nothing was durably stored", got)
	}
	if got := r.push.count(); got != 0 {
		t.Fatalf("pushes = %d, want 0: a message whose store rolled back must not push", got)
	}
	if got := r.rows(); len(got) != 0 {
		t.Fatalf("op_log has %d rows; a rolled-back hold appends nothing", len(got))
	}
}
