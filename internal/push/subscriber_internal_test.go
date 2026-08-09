package push

import "testing"

// webpush-go prepends "mailto:" to any subscriber that is not an https URL, so
// handing it a mailto: URI yields sub="mailto:mailto:you@example.com". Apple
// rejects that JWT outright with 403 {"reason":"BadJwtToken"} — every push to
// an iPhone fails — while Chrome/FCM accepts it, so the bug hides until iOS.
func TestNew_StripsMailtoSchemeFromSubscriber(t *testing.T) {
	priv, pub, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ in, want string }{
		{"mailto:you@example.com", "you@example.com"},
		{"MAILTO:you@example.com", "you@example.com"},
		{"you@example.com", "you@example.com"},
		{"https://example.com/contact", "https://example.com/contact"},
		{"", "admin@localhost"},
	} {
		s, err := New(priv, pub, tc.in)
		if err != nil {
			t.Fatalf("New(%q): %v", tc.in, err)
		}
		if s.subscriber != tc.want {
			t.Errorf("New(%q).subscriber = %q, want %q", tc.in, s.subscriber, tc.want)
		}
	}
}
