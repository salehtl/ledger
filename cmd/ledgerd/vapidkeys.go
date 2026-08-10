package main

// vapidkeys.go — `ledgerd vapid-keys`, minting a Web Push VAPID key pair.
//
// # Why this exists
//
// Before this mode, the operator ran the v1 `ledger` binary's own
// `vapid-keys` subcommand to mint the pair v2 needs (internal/v2/config's
// validateWebPush error said so directly). That is exactly the kind of
// cross-app coupling CLAUDE.md's "two apps" section warns against: v2 and v1
// share a module and a git history and almost nothing else, and a v2
// deployment that has never built the v1 binary — or has decommissioned it —
// had no way to mint its own web push keys. Key generation is one call to
// pushv2.GenerateVAPIDKeys — the same function pushv2's tests mint with, and
// the same library its Web sender signs with — see that function's doc
// comment for why it, and not a second direct call into webpush-go here, is
// the single source of the key format.
//
// # Why it is dispatched before config.Load, not through modeHandlers
//
// Every other mode in modeHandlers receives a validated config.Config: main()
// calls config.Load before it ever looks the mode up in that table. That
// ordering is exactly wrong for this command. validateWebPush refuses to
// load when push.web_enabled is true and LEDGER_VAPID_PUBLIC or
// LEDGER_VAPID_PRIVATE is unset — which is precisely the situation an
// operator reaching for `vapid-keys` is in. A handler-style implementation
// would be unreachable at the one moment it is needed. So cmd/ledgerd's
// main() special-cases this mode immediately after parsing arguments and
// before calling config.Load at all; see the comment there. It needs no
// config, no database and no network to do its job.
//
// modeHandlers still carries an entry for "vapid-keys" — one that ignores
// its config.Config argument — purely so checkModeHandlers' cross-check
// against config.Modes() has something to find for every invocation of the
// binary, not just this one. See modeImplemented's doc comment in
// internal/v2/config/config.go.
//
// # Why the output warns against regenerating
//
// A VAPID key pair is not a rotating secret. The public half is handed to
// every browser that subscribes, baked into that subscription on the push
// service's side for as long as it lives. Minting a second pair and
// deploying it does not rotate anything — it orphans every existing
// subscription at once, silently: the browser still holds the old public
// key, the server now signs with a new private one, and every send is
// rejected by the push service from that moment on, with nothing in this
// codebase that would tell a user their notifications stopped. So the keys
// are minted ONCE, at first deploy, and the warning below says so every
// single time this command runs — including the second time, which is
// exactly the run that would do the damage.
import (
	"fmt"

	"ledger/internal/v2/pushv2"
)

// runVAPIDKeys generates a new VAPID key pair and prints it in the exact
// LEDGER_VAPID_PUBLIC / LEDGER_VAPID_PRIVATE form internal/v2/config reads
// (config.go :457/:460) — the same env-var names v1's `ledger vapid-keys`
// uses, because both binaries' Web Push senders read the same names and
// nothing gains from inventing a v2-specific pair. Key generation itself goes
// through pushv2.GenerateVAPIDKeys rather than a second direct call into
// webpush-go, so this command and the sender that actually uses the keys
// share one source of the key format.
func runVAPIDKeys() error {
	priv, pub, err := pushv2.GenerateVAPIDKeys()
	if err != nil {
		return fmt.Errorf("ledgerd vapid-keys: %w", err)
	}
	fmt.Printf("LEDGER_VAPID_PUBLIC=%s\nLEDGER_VAPID_PRIVATE=%s\n", pub, priv)
	fmt.Println("NEW keys. Replacing keys already in use unsubscribes every device — " +
		"mint once, then never again.")
	return nil
}
