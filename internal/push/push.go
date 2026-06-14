package push

import (
	"context"
	"fmt"

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
	if subscriber == "" {
		subscriber = "mailto:admin@localhost"
	}
	return &Sender{privateKey: privateKey, publicKey: publicKey, subscriber: subscriber}, nil
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
