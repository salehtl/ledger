package config

import (
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

// validPushBase is a config that passes every OTHER rail, so a failure in
// these tests is always about push.
func validPushBase() Config {
	c := defaults()
	c.Mail.Domain = "example.test"
	c.Server.DSN = "postgres:///x"
	return c
}

// TestEnablingPushWithoutTheAccessTokenIsRefused.
//
// validate() had no push clause at all, so `enabled = true` with
// LEDGER_EXPO_ACCESS_TOKEN unset started cleanly and pushed unauthenticated.
// Expo's send endpoint accepts unauthenticated POSTs unless the project's
// access token is presented, which means anyone who learns a user's push token
// can write an arbitrary title and body to that user's LOCK SCREEN — "You spent
// AED 5,000 at ..." — through a public endpoint. pushv2's content-free
// guarantee bounds what this server sends and cannot bound what the channel can
// display; the credential is the only thing that does.
func TestEnablingPushWithoutTheAccessTokenIsRefused(t *testing.T) {
	c := validPushBase()
	c.Push.Enabled = true
	err := c.validate()
	if err == nil {
		t.Fatal("validate() accepted push.enabled with no LEDGER_EXPO_ACCESS_TOKEN")
	}
	if !strings.Contains(err.Error(), "LEDGER_EXPO_ACCESS_TOKEN") {
		t.Fatalf("the refusal must name the variable to set, got: %v", err)
	}
	c.Push.AccessToken = "expo-secret"
	if err := c.validate(); err != nil {
		t.Fatalf("validate() with a token: %v", err)
	}
	// Disabled needs no credential: nothing is sent, so there is nothing to
	// authenticate, and demanding one would make turning push OFF harder than
	// leaving it on.
	c.Push.Enabled, c.Push.AccessToken = false, ""
	if err := c.validate(); err != nil {
		t.Fatalf("validate() with push disabled: %v", err)
	}
}

// TestExpoURLIsRailed. It was accepted verbatim from TOML and used as the POST
// target, so `expo_url = "http://collector.example/x"` shipped the deployment's
// Bearer credential AND the precise timestamp of every user's every bank
// transaction, in cleartext, to whoever asked. This config has a hard rail for
// every other deployment assumption; the one OUTBOUND URL in the system had
// none.
func TestExpoURLIsRailed(t *testing.T) {
	cases := []struct {
		name, url, wantIn string
	}{
		{"cleartext", "http://exp.host/--/api/v2/push/send", "https"},
		{"another host over http", "http://collector.example/x", "https"},
		{"another host over https", "https://collector.example/x", "not an Expo host"},
		{"a lookalike host", "https://exp.host.evil.example/x", "not an Expo host"},
		{"no scheme", "exp.host/--/api/v2/push/send", "https"},
		{"not a url", "://", "not a URL"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := validPushBase()
			c.Push.ExpoURL = tc.url
			err := c.validate()
			if err == nil {
				t.Fatalf("validate() accepted push.expo_url = %q", tc.url)
			}
			if !strings.Contains(err.Error(), tc.wantIn) {
				t.Fatalf("refusal should mention %q, got: %v", tc.wantIn, err)
			}
		})
	}

	for _, ok := range []string{
		"",
		"https://exp.host/--/api/v2/push/send",
		"https://api.expo.dev/v2/push/send",
	} {
		c := validPushBase()
		c.Push.ExpoURL = ok
		if err := c.validate(); err != nil {
			t.Fatalf("validate() refused a legitimate expo_url %q: %v", ok, err)
		}
	}
}

// TestTheExpoURLIsCheckedEvenWhilePushIsDisabled. Push is off in Phase 1, so a
// rail that only fired when Enabled was true would leave a bad URL sitting
// inert in a config file until somebody flipped a boolean — and the moment it
// fires is the moment it is carrying a live credential.
func TestTheExpoURLIsCheckedEvenWhilePushIsDisabled(t *testing.T) {
	c := validPushBase()
	c.Push.Enabled = false
	c.Push.ExpoURL = "http://collector.example/x"
	if err := c.validate(); err == nil {
		t.Fatal("a cleartext expo_url was accepted because push happened to be disabled")
	}
}

// TestWebPushIsRefusedWhenItIsOnlyHalfConfigured.
//
// Every shape below fails SILENTLY at runtime, which is the whole reason the
// rail exists. Nothing about a missing key produces an error a user sees: the
// browser subscribes against whatever public key it was served, the row lands
// in push_subscriptions, and every send is then rejected by the push service in
// a code path that logs and swallows (correctly — a push is a courtesy). "On"
// and "working" would differ with nothing in the product able to tell them
// apart.
func TestWebPushIsRefusedWhenItIsOnlyHalfConfigured(t *testing.T) {
	const pub, priv = "BPublicKey", "PrivateKey"

	for _, c := range []struct {
		name string
		mut  func(*Config)
		want string
	}{
		{"no keys at all", func(*Config) {}, "LEDGER_VAPID_PUBLIC"},
		{"only the public half", func(c *Config) { c.Push.VAPIDPublic = pub }, "LEDGER_VAPID_PRIVATE"},
		{"only the private half", func(c *Config) { c.Push.VAPIDPrivate = priv }, "LEDGER_VAPID_PUBLIC"},
		{"no subject", func(c *Config) {
			c.Push.VAPIDPublic, c.Push.VAPIDPrivate = pub, priv
			c.Push.VAPIDSubject = ""
		}, "vapid_subject"},
		{"a subject that is neither mailto: nor https:", func(c *Config) {
			c.Push.VAPIDPublic, c.Push.VAPIDPrivate = pub, priv
			c.Push.VAPIDSubject = "ops@example.test"
		}, "mailto:"},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg := validPushBase()
			cfg.Push.WebEnabled = true
			cfg.Push.VAPIDSubject = "mailto:ops@example.test"
			c.mut(&cfg)
			err := cfg.validate()
			if err == nil {
				t.Fatal("validate() accepted a half-configured web push")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("the refusal must name %q, got: %v", c.want, err)
			}
		})
	}

	// The complete shape starts, and so does the OFF shape with keys sitting in
	// the environment — a deployment that keeps one env file across two
	// services must not be refused over a variable it is not using.
	full := validPushBase()
	full.Push.WebEnabled = true
	full.Push.VAPIDPublic, full.Push.VAPIDPrivate = pub, priv
	full.Push.VAPIDSubject = "mailto:ops@example.test"
	if err := full.validate(); err != nil {
		t.Fatalf("validate() with a complete web push config: %v", err)
	}
	off := validPushBase()
	off.Push.VAPIDPublic = pub
	if err := off.validate(); err != nil {
		t.Fatalf("validate() with keys present and web push off: %v", err)
	}
}

// TestTheVAPIDKeysAreEnvOnly. Both halves are a PAIR, and a deployment that
// keeps one in a file and the other in the environment is one where the two can
// drift — which does not fail loudly, it just means every send is rejected by
// the push service with the operator believing notifications are on.
func TestTheVAPIDKeysAreEnvOnly(t *testing.T) {
	var c Config
	if _, err := toml.Decode(`
[push]
web_enabled = true
vapid_subject = "mailto:ops@example.test"
vapid_public = "FROM-TOML"
vapid_private = "FROM-TOML"
`, &c); err != nil {
		t.Fatal(err)
	}
	if c.Push.VAPIDPublic != "" || c.Push.VAPIDPrivate != "" {
		t.Fatalf("TOML set the VAPID keys: public=%q private=%q", c.Push.VAPIDPublic, c.Push.VAPIDPrivate)
	}
	if c.Push.VAPIDSubject != "mailto:ops@example.test" {
		t.Fatalf("vapid_subject is not readable from TOML: %q", c.Push.VAPIDSubject)
	}
}
