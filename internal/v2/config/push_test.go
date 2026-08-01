package config

import (
	"strings"
	"testing"
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
