package push

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// testSubscription builds a structurally valid subscription so webpush-go's
// payload encryption succeeds and the request actually reaches the endpoint.
func testSubscription(t *testing.T) (p256dh, auth string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub := elliptic.Marshal(elliptic.P256(), key.PublicKey.X, key.PublicKey.Y)
	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(pub), base64.RawURLEncoding.EncodeToString(secret)
}

func senderForTest(t *testing.T) *Sender {
	t.Helper()
	priv, pub, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(priv, pub, "you@example.com")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// A push service answers 404/410 when the subscription no longer exists — the
// device reinstalled the PWA, or the user revoked permission. That is
// permanent, so the caller must be able to tell it apart from a transient
// failure and delete the row instead of retrying it forever.
func TestSend_GoneStatusesAreDistinguishable(t *testing.T) {
	for _, code := range []int{http.StatusNotFound, http.StatusGone} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		}))
		p256dh, auth := testSubscription(t)
		err := senderForTest(t).Send(context.Background(), srv.URL, p256dh, auth, []byte(`{"title":"x"}`))
		srv.Close()

		if err == nil {
			t.Fatalf("status %d: got nil error, want ErrSubscriptionGone", code)
		}
		if !errors.Is(err, ErrSubscriptionGone) {
			t.Errorf("status %d: err = %v, want it to wrap ErrSubscriptionGone", code, err)
		}
	}
}

// A 403 is the bad-JWT case: the subscription is fine, our credentials are
// not. Pruning on it would silently delete every device.
func TestSend_OtherFailuresAreNotGone(t *testing.T) {
	for _, code := range []int{http.StatusForbidden, http.StatusInternalServerError, http.StatusTooManyRequests} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
		}))
		p256dh, auth := testSubscription(t)
		err := senderForTest(t).Send(context.Background(), srv.URL, p256dh, auth, []byte(`{"title":"x"}`))
		srv.Close()

		if err == nil {
			t.Fatalf("status %d: got nil error, want a failure", code)
		}
		if errors.Is(err, ErrSubscriptionGone) {
			t.Errorf("status %d: treated as gone; only 404/410 may prune a subscription", code)
		}
	}
}

func TestSend_SuccessIsNotAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	p256dh, auth := testSubscription(t)
	if err := senderForTest(t).Send(context.Background(), srv.URL, p256dh, auth, []byte(`{"title":"x"}`)); err != nil {
		t.Errorf("Send on 201 = %v, want nil", err)
	}
}
