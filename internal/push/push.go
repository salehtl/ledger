package push

import (
	"context"
	"fmt"
	"strings"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Sender sends web push notifications using VAPID.
type Sender struct {
	privateKey string
	publicKey  string
	subscriber string
}

// New creates a Sender. subscriber is the mailto: contact for VAPID (e.g.
// "mailto:owner@example.com"). Both keys are required; returns an error if empty.
func New(privateKey, publicKey, subscriber string) (*Sender, error) {
	if privateKey == "" || publicKey == "" {
		return nil, fmt.Errorf("LEDGER_VAPID_PRIVATE and LEDGER_VAPID_PUBLIC are required")
	}
	subscriber = normalizeSubscriber(subscriber)
	if subscriber == "" {
		subscriber = "admin@localhost"
	}
	return &Sender{privateKey: privateKey, publicKey: publicKey, subscriber: subscriber}, nil
}

// normalizeSubscriber strips a mailto: scheme, because webpush-go prepends one
// to every subscriber that is not an https URL. Passing it a mailto: URI
// therefore signs the VAPID JWT with sub="mailto:mailto:you@example.com", which
// Apple rejects with 403 {"reason":"BadJwtToken"} — every push to an iPhone
// fails. Chrome/FCM accepts the malformed claim, so callers cannot discover
// this except on iOS. Accept either form here and hand the library what it
// wants.
func normalizeSubscriber(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 7 && strings.EqualFold(s[:7], "mailto:") {
		return s[7:]
	}
	return s
}

// GenerateKeys generates a new VAPID key pair. Call once; store as
// LEDGER_VAPID_PRIVATE and LEDGER_VAPID_PUBLIC environment variables.
func GenerateKeys() (private, public string, err error) {
	return webpush.GenerateVAPIDKeys()
}

// PublicKey returns the VAPID public key for the browser's PushManager.subscribe().
func (s *Sender) PublicKey() string { return s.publicKey }

// Send delivers a push notification to one subscription endpoint.
func (s *Sender) Send(ctx context.Context, endpoint, p256dh, auth string, payload []byte) error {
	sub := &webpush.Subscription{
		Endpoint: endpoint,
		Keys:     webpush.Keys{Auth: auth, P256dh: p256dh},
	}
	resp, err := webpush.SendNotificationWithContext(ctx, payload, sub, &webpush.Options{
		Subscriber:      s.subscriber,
		VAPIDPublicKey:  s.publicKey,
		VAPIDPrivateKey: s.privateKey,
		TTL:             30,
	})
	if err != nil {
		return fmt.Errorf("webpush send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("push service returned %d for %s", resp.StatusCode, endpoint)
	}
	return nil
}
