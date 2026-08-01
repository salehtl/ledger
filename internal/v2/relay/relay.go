// Package relay is the backup MX: the same binary, on a second VPS, listed at a
// lower MX priority than the primary, whose whole job is to hold mail durably
// while the primary is down and hand it over unchanged when it comes back
// (spec §3.2).
//
// # What it is defending against, precisely
//
// Not "some mail is late". Sending MTAs retry for roughly one to three days and
// then bounce — and, worse, GMAIL SILENTLY DISABLES A FORWARDING RULE after
// sustained failures, with no notification to us and effectively none to the
// user. Gmail forwarding is the primary onboarding path for this product. So an
// outage long enough to exhaust a sender's retry budget does not merely delay a
// user's transactions: it can permanently unhook their account from their bank
// mail, and the symptom they see is "transactions stopped appearing" weeks
// later. A backup MX converts that class of failure into a queue.
//
// Spec §3.2 is emphatic that this must be OUR binary and not a managed relay
// service: a third-party relay reads every message in the clear, which is
// exactly the property the whole design exists to avoid.
//
// # What the relay is allowed to know
//
// One thing: the map from inbound address to the account's public key —
// `{local_part, user_pubkey, expires_at}`, and nothing else. No user ids, no
// op-log rows, no chains, no diagnostics, no database at all. It syncs that
// replica from the primary every few minutes and keeps it in
// `SpoolDir/addresses.json`.
//
// The replica exists so the relay can refuse mail for addresses this system
// does not serve, at RCPT time, without asking anybody. Without it the backup
// MX would be an open spool for the whole internet.
//
// # ⚠ WHAT THE PHASE 1 SPOOL ACTUALLY CONTAINS
//
// PLAINTEXT EMAIL, on the relay's disk, for as long as the primary is
// unreachable. That is the honest statement and spec §2 carries it: the
// unencrypted-surface list in §2 now names this spool, the rejection lane and
// `addresses.json` explicitly, and §2's first bullet no longer claims the relay
// seals before spooling, because it does not. Phase 1 is plaintext end to end
// (blob.PlaintextSealer), and the relay is not an exception to that — every
// spooled `.eml` is the message exactly as the bank sent it, and the `.json`
// beside it records `"sealed": false` so the phase is a fact on disk rather
// than a claim in a document.
//
// Two consequences that belong here rather than in a document nobody greps:
//
//   - NO DATABASE PURGE REACHES THIS DIRECTORY. Account deletion (spec §3.10)
//     runs against Postgres on the primary; a message of that user's sitting in
//     this spool, or in `rejected/`, survives it. That is an open operator
//     decision, recorded in docs/superpowers/NEEDS-SALEH.md §4, and it needs an
//     answer before the relay carries real mail rather than after.
//   - `rejected/` is never emptied by this package, so it accumulates plaintext
//     for as long as the box lives.
//
// # What the relay CANNOT do, and why the spool format is what it is
//
// Spec §3.2 says the relay "seals mail at arrival exactly like the primary and
// spools ciphertext only". Taken literally — as an op-log blob — that is
// impossible, and it is worth writing down why so that Phase 3 does not
// rediscover it in production:
//
//	blob.Envelope binds user_id | stream | writer_id | WRITER_COUNTER
//
// into the AAD of every op-log blob (internal/v2/blob, frozen format). The
// writer counter is a position in a per-writer chain, assigned by the primary
// under a per-user counter lock at append time — that is precisely why
// oplog.AppendIngest takes PLAINTEXT and seals inside the lock. A relay cannot
// know the counter, cannot take the lock, and therefore cannot pre-seal into a
// position. If it guessed, every blob would be unopenable at the position it
// actually landed in, forever, and the failure would be invisible until a
// client tried to read it.
//
// So the relay does not produce op-log blobs and must not. What it can seal to
// in Phase 3 is the ACCOUNT's public key with a standalone envelope carrying no
// position at all — which is why `user_pubkey` is carried in the replica now,
// unused. The spool format below is therefore a message-at-rest format, not an
// op-log format:
//
//	<spool-id>.eml    the message, byte for byte as received
//	<spool-id>.json   {v, id, local_part, envelope_from, remote_ip,
//	                   received_at, bytes, sha256, sealed}
//
// The Phase 3 swap is exactly one thing: `.eml` holds ciphertext sealed to
// `user_pubkey`, `sealed` becomes true, and the primary's deliver endpoint
// learns to accept a sealed body. Nothing about the metadata, the durability
// protocol, the drain, the rejection lane or the wire shape moves.
//
// # The durability protocol
//
// An SMTP 250 is a promise that the message survives a power cut, so
// [Relay.Deliver] returns success only after:
//
//  1. the body is written and fsynced;
//  2. the metadata is written and fsynced;
//  3. the CONTAINING DIRECTORY is fsynced.
//
// Step 3 is not superstition. Without it a crash can lose the directory ENTRY
// while the file's contents are perfectly safe on disk, which is
// indistinguishable from having lost the message.
//
// The metadata is written LAST and is the COMMIT RECORD. A `.eml` with no
// `.json` beside it is a crash between steps 1 and 2 — the sender was never
// told 250, so it still holds the message — and the drain neither forwards it
// (there is nothing saying who it was for) nor deletes it (this package deletes
// nothing it has not confirmed delivered). It is counted and reported instead.
//
// THE ORDER IS NOT AN IMPLEMENTATION DETAIL. Reversed, the same crash leaves a
// commit record with no body: a message the sender WAS told 250 for, that no
// retry can produce and that the drain can only set aside in `rejected/`
// permanently. A correct order turns a crash into a recoverable orphan the
// sender still holds; the wrong one turns it into a lost message. Because none
// of this is observable from userspace after the fact, the two writes and the
// directory fsync go through the [writeSpoolFile] / [syncSpoolDir] seam, and
// durability_test.go asserts the sequence and the failure of each step.
//
// # Nothing is deleted that was not confirmed delivered
//
// [Relay.Drain] removes a spooled message only on a 2xx from the primary. Every
// other outcome keeps the bytes:
//
//   - 5xx, a network failure, 401, 403, 408 and 429 are OUR problem — the
//     primary is down, the token is wrong, we are being throttled — so the
//     message stays in the live spool and the drain stops, because all of those
//     are conditions of the whole primary rather than of one message. The brief
//     for this task said "a 4xx other than 429"; 401 and 403 are carved out for
//     the same reason 429 is, and the reason is not theoretical: a mistyped
//     LEDGER_RELAY_TOKEN would otherwise sweep an entire spool into the
//     rejection lane in one tick, which is a bulk silent drop wearing a 4xx.
//   - 404, 405 and 501 mean the primary IS NOT SERVING these routes, which is a
//     deployment state on the other box (see [VerdictHeader]) and says nothing
//     about the message. Same treatment: keep everything, stop the pass, and say
//     so in words that name the fix.
//   - a per-message rejection — an unknown recipient, an oversize body — must be
//     STATED by the primary in [VerdictHeader], not inferred from a status code.
//     Only then does the pair move to `rejected/`, together with a `.why.txt`
//     recording the status and the primary's answer. Nothing in `rejected/` is
//     ever deleted by this package.
//   - anything else — a 4xx nobody marked, a spool file that cannot be read
//     right now — keeps that one message and carries on with the rest. A single
//     unreadable file is not a reason to stop offering the messages behind it,
//     and it is not evidence about any of them.
//
// # A spool that outlives the sender's retry budget
//
// A message this relay accepted with a 250 has no sender left to retry it. It is
// therefore never deleted to make a number look better — but a queue nobody
// looks at is a silent drop with extra steps, so its age is surfaced three ways:
// [Relay.Stats] reports the backlog and the age of the oldest message, the drain
// logs a `SPOOL ALARM` line once that age passes StaleAfter, and every address
// sync reports the backlog to the primary in the [SpoolHeader] request header —
// which puts it on the box the operator is actually watching.
//
// # Why a stale replica never answers a PERMANENT refusal
//
// The replica goes stale exactly when the primary is unreachable, which is
// exactly when this process matters. Answering 550 out of data we know may be
// out of date is how an address issued since the last sync gets refused forever
// — and a sustained permanent failure is the thing that makes Gmail disable a
// forwarding rule. So [Relay.Resolve] answers a permanent refusal only for a
// recipient that is not shaped like one of ours at all (no amount of syncing
// would make postmaster@example.com an address this system issued) or when the
// replica is FRESH. Otherwise it defers, and the sender retries against the
// primary at MX priority 10.
package relay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/smtpd"
)

// The two routes the primary mounts for us. They are constants here, in the
// CLIENT, so that internal/v2/api can assert its mux actually routes them —
// a relay pointed at a path the primary does not serve fails as a 404 that the
// drain would classify as a per-message rejection and file the whole spool under
// `rejected/`.
const (
	AddressesPath = "/api/v1/relay/addresses"
	DeliverPath   = "/api/v1/relay/deliver"
)

// VerdictHeader is how the primary says "this MESSAGE is undeliverable" as
// opposed to "I do not know what you are talking about".
//
//	X-Ledger-Relay-Verdict: reject
//
// It exists because a STATUS CODE cannot tell those apart. The primary mounts
// the two relay routes only when it is configured for a relay at all
// (api.relayRoutesMountable: a token, a mail handler and an address resolver,
// every one of them a deployment state) and its catch-all answers 404
// otherwise. Without a marker, that 404 is byte-identical to the 404 that means
// "no such recipient" — so a missing environment variable on the OTHER box
// would file an entire spool of already-accepted mail under rejected/ in one
// tick, permanently, for messages whose senders were told 250 and will never
// retry. That is not hypothetical: it is what this package did until
// 2026-08-01.
//
// So [Relay.Drain] sets a message aside ONLY for an answer carrying this
// header. Anything else keeps the bytes. The cost of the conservative direction
// is a spool that stalls loudly against a misconfigured primary; the cost of the
// other direction is destroyed mail.
const (
	VerdictHeader = "X-Ledger-Relay-Verdict"
	VerdictReject = "reject"
)

// SpoolHeader carries the relay's own backlog on every address sync:
//
//	X-Ledger-Relay-Spool: spooled=3; rejected=1; uncommitted=0; oldest=<RFC3339>
//
// It exists so a stranded spool is visible on the PRIMARY, where the operator
// and the admin console are, rather than only in a log on a $5 box nobody logs
// into. It is advisory: the primary logs it and does nothing else with it.
const SpoolHeader = "X-Ledger-Relay-Spool"

// On-disk names. The metadata suffix is deliberately ".json", the same as the
// replica's, so a single `ls` shows one shape; replicaFile is excluded by name
// everywhere the spool is enumerated.
const (
	replicaFile  = "addresses.json"
	replicaTmp   = "addresses.json.tmp"
	rejectedDir  = "rejected"
	emlSuffix    = ".eml"
	metaSuffix   = ".json"
	rejectSuffix = ".why.txt"

	// spoolVersion versions the metadata record. Phase 3 does not need to
	// change it — `sealed` carries that — but a format that cannot say which
	// version it is cannot be migrated at all.
	spoolVersion = 1

	// spoolDirMode and spoolFileMode: the spool holds other people's bank mail
	// in the clear in Phase 1. Nothing else on the box may read it.
	spoolDirMode  = 0o700
	spoolFileMode = 0o600
)

// Tunables. Each is a field on [Relay] defaulting to the constant, so a test can
// move it without waiting.
const (
	// DefaultSyncInterval is how often the address replica is refreshed. It is
	// three orders of magnitude finer than the 7-day rotation grace window, so
	// a rotation cannot outrun it.
	DefaultSyncInterval = 5 * time.Minute
	// DefaultDrainInterval is how often the spool is offered to the primary. A
	// minute bounds how long a recovered primary waits for the backlog while
	// costing one request a minute during an outage.
	DefaultDrainInterval = time.Minute
	// DefaultMaxReplicaAge is how long a replica may be trusted to answer a
	// PERMANENT refusal. Past it, an unknown recipient is deferred instead —
	// see the package doc.
	DefaultMaxReplicaAge = 24 * time.Hour
	// DefaultStaleAfter is when a spooled message becomes an alarm. It is
	// inside the ~1-3 day window a sending MTA would have retried for, so the
	// operator hears about it while the sender would still have been trying.
	DefaultStaleAfter = 24 * time.Hour
	// DefaultHTTPTimeout bounds one call to the primary. A drain of a
	// megabyte-scale message over a slow link is the long case.
	DefaultHTTPTimeout = 2 * time.Minute

	// maxReplicaBytes bounds what a sync will read. The primary is
	// authenticated, but a compromised or wedged primary must not be able to
	// make the relay allocate without limit.
	maxReplicaBytes = 8 << 20
	// maxRejectBody bounds how much of the primary's answer is recorded beside
	// a rejected message.
	maxRejectBody = 8 << 10
)

// quotaNamespace domain-separates the pseudonymous per-address keys [Relay.Resolve]
// hands smtpd. See resolveKey: this is NOT a user id and the relay never learns
// one.
var quotaNamespace = uuid.MustParse("7a1f4b2c-0e8d-4f3a-9c61-2b5d8e0a7f14")

// Errors Resolve returns for the two "I cannot answer" cases. Neither is
// addresses.ErrUnknownRecipient, which is exactly the point: smtpd answers that
// sentinel with a permanent 550 and everything else with a temporary 451.
var (
	ErrNoReplica    = errors.New("relay: no address replica has ever been synced")
	ErrStaleReplica = errors.New("relay: the address replica is too old to answer authoritatively")
)

// Relay is the backup MX. It implements both [smtpd.Resolver] and
// [smtpd.Handler]: the receiver asks it whether a recipient is one of ours, and
// hands it the accepted message to spool.
type Relay struct {
	// SpoolDir is the durable local spool. Required.
	SpoolDir string
	// PrimaryURL is the primary's base URL. Required. Cleartext is refused
	// unless it names a loopback or Tailscale host — see Init.
	PrimaryURL string
	// Token authenticates this relay to the primary (LEDGER_RELAY_TOKEN).
	// Required.
	Token string
	// Suffix is "@in.<domain>", from config.InboundSuffix(). Required: the
	// relay decides what is one of our addresses from it, and a guessed suffix
	// is a relay that accepts nothing or everything.
	Suffix string

	// HTTP defaults to a client with DefaultHTTPTimeout that refuses redirects
	// (a redirect would hand the bearer token to whoever the primary's answer
	// named). A caller-supplied client is the caller's business.
	HTTP *http.Client
	// Now defaults to time.Now.
	Now func() time.Time
	// MaxReplicaAge defaults to DefaultMaxReplicaAge.
	MaxReplicaAge time.Duration
	// StaleAfter defaults to DefaultStaleAfter.
	StaleAfter time.Duration
	// Logf receives operator-facing detail. Defaults to log.Printf.
	Logf func(format string, args ...any)

	// mu guards the in-memory replica only.
	mu      sync.RWMutex
	replica *replica
	// drainMu serialises Drain, so a slow drain overlapping the next tick does
	// not offer the same message twice concurrently.
	drainMu sync.Mutex
}

var (
	_ smtpd.Handler  = (*Relay)(nil)
	_ smtpd.Resolver = (*Relay)(nil)
)

func (r *Relay) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Relay) logf(format string, args ...any) {
	if r.Logf != nil {
		r.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

func (r *Relay) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return defaultClient
}

var defaultClient = &http.Client{
	Timeout: DefaultHTTPTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("relay: the primary answered with a redirect; refusing to follow it with a bearer token")
	},
}

func (r *Relay) maxReplicaAge() time.Duration {
	if r.MaxReplicaAge > 0 {
		return r.MaxReplicaAge
	}
	return DefaultMaxReplicaAge
}

func (r *Relay) staleAfter() time.Duration {
	if r.StaleAfter > 0 {
		return r.StaleAfter
	}
	return DefaultStaleAfter
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// Init validates the configuration, creates the spool directories and loads
// whatever replica the last run left behind.
//
// It is separate from serving so that a misconfiguration is a startup error the
// operator sees immediately, rather than a relay that binds port 25 and then
// discovers it cannot write anything.
func (r *Relay) Init() error {
	switch {
	case r == nil:
		return errors.New("relay: nil relay")
	case r.SpoolDir == "":
		return errors.New("relay: spool_dir is required (relay.spool_dir)")
	case r.PrimaryURL == "":
		return errors.New("relay: primary_url is required (relay.primary_url / LEDGER_RELAY_PRIMARY_URL)")
	case r.Token == "":
		return errors.New("relay: a relay token is required (LEDGER_RELAY_TOKEN)")
	case r.Suffix == "":
		return errors.New("relay: Suffix is empty (config.InboundSuffix)")
	}
	if err := CheckPrimaryURL(r.PrimaryURL); err != nil {
		return err
	}
	if err := os.MkdirAll(r.SpoolDir, spoolDirMode); err != nil {
		return fmt.Errorf("relay: create spool %s: %w", r.SpoolDir, err)
	}
	// MkdirAll honours the process umask, so the mode above is a ceiling rather
	// than a guarantee. Chmod is the guarantee.
	if err := os.Chmod(r.SpoolDir, spoolDirMode); err != nil {
		return fmt.Errorf("relay: set spool permissions on %s: %w", r.SpoolDir, err)
	}
	rej := filepath.Join(r.SpoolDir, rejectedDir)
	if err := os.MkdirAll(rej, spoolDirMode); err != nil {
		return fmt.Errorf("relay: create %s: %w", rej, err)
	}
	if err := os.Chmod(rej, spoolDirMode); err != nil {
		return fmt.Errorf("relay: set permissions on %s: %w", rej, err)
	}
	r.loadReplica()
	return nil
}

// CheckPrimaryURL refuses a primary URL that would put a bearer token and other
// people's bank mail on the public internet in the clear.
//
// Cleartext is allowed only to loopback (development, and the end-to-end tests)
// or to a Tailscale address in 100.64.0.0/10 — which is the RIGHT production
// shape for this link and the same rule config.CheckAdminBind applies to the
// admin console: put both boxes on the tailnet and the relay→primary hop never
// touches the public internet at all. Deployment task D3 provisions the relay
// before D4 terminates TLS, so without this carve-out the relay would either be
// undeployable or deployed in the clear; with it, the only cleartext deployment
// that starts is one that is not routable from outside.
func CheckPrimaryURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("relay: primary_url %q is not a URL: %w", raw, err)
	}
	if u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("relay: primary_url %q must be an absolute http(s) URL", raw)
	}
	if u.Scheme == "https" {
		return nil
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip, err := netip.ParseAddr(host)
	if err == nil && (ip.IsLoopback() || tailnetV4.Contains(ip.Unmap())) {
		return nil
	}
	return fmt.Errorf(
		"relay: refusing a cleartext primary_url %q: every forwarded message and the relay "+
			"bearer token would travel in the clear. Use https, or point it at the primary's "+
			"Tailscale address (100.64.0.0/10) so the hop never leaves the tailnet",
		raw)
}

// tailnetV4 is Tailscale's CGNAT allocation, the same prefix
// config.CheckAdminBind accepts. Duplicated as a parsed prefix rather than
// imported because config imports nothing from here and this package must not
// import config: the relay is configured by fields, not by a Config.
var tailnetV4 = netip.MustParsePrefix("100.64.0.0/10")

// ---------------------------------------------------------------------------
// The address replica
// ---------------------------------------------------------------------------

// replica is the synced address map. Its JSON is the on-disk file, so its shape
// is the disclosure: TestRelayHoldsNoOpLogData asserts that these are the only
// keys that ever appear.
type replica struct {
	AsOf      time.Time        `json:"as_of"`
	Addresses []ReplicaAddress `json:"addresses"`

	// index is built on load and is not serialised.
	index map[string]ReplicaAddress
}

// ReplicaAddress is one row of the map the relay is allowed to hold.
type ReplicaAddress struct {
	LocalPart string `json:"local_part"`
	// UserPubKey is the account's public key. It is EMPTY in Phase 1 and is
	// carried anyway: Phase 3 seals at arrival by filling it in, with no schema
	// and no protocol change. See the package doc for why sealing to an op-log
	// position is impossible here.
	UserPubKey string `json:"user_pubkey"`
	// ExpiresAt is nil for an active address; otherwise the instant its
	// rotation grace window closes.
	ExpiresAt *time.Time `json:"expires_at"`
}

func (rep *replica) build() {
	rep.index = make(map[string]ReplicaAddress, len(rep.Addresses))
	for _, a := range rep.Addresses {
		rep.index[a.LocalPart] = a
	}
}

func (r *Relay) snapshot() *replica {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.replica
}

// loadReplica reads the replica the previous run left behind. A missing file is
// normal on a fresh relay; an unreadable one is loud and treated as missing,
// which defers every recipient rather than refusing them.
func (r *Relay) loadReplica() {
	path := filepath.Join(r.SpoolDir, replicaFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			r.logf("relay: reading the address replica %s: %v; every recipient will be "+
				"DEFERRED until a sync succeeds", path, err)
		}
		return
	}
	var rep replica
	if err := json.Unmarshal(raw, &rep); err != nil {
		r.logf("relay: the address replica %s is unreadable (%v); every recipient will be "+
			"DEFERRED until a sync succeeds", path, err)
		return
	}
	rep.build()
	r.mu.Lock()
	r.replica = &rep
	r.mu.Unlock()
	r.logf("relay: loaded %d address(es) from %s, synced %s", len(rep.Addresses), path,
		rep.AsOf.UTC().Format(time.RFC3339))
}

// SyncAddresses pulls the full address map from the primary and replaces the
// replica, returning how many addresses it now holds.
//
// It is a FULL snapshot every time, not an incremental one keyed on a `since`
// cursor. That is a deliberate deviation from this task's brief, for a reason
// the incremental shape cannot express: an address that DISAPPEARS — a purged
// account (spec §3.10), or a rotation whose grace window has closed — produces
// no row to send, so an incremental protocol would leave it in the relay's
// replica forever and the relay would keep accepting mail for an account that no
// longer exists. The population this serves is a closed beta; the whole map is a
// few kilobytes.
//
// A failed sync leaves the previous replica completely untouched, on disk and in
// memory. The relay's ability to accept mail is precisely what an outage would
// otherwise take away.
func (r *Relay) SyncAddresses(ctx context.Context) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.endpoint(AddressesPath), nil)
	if err != nil {
		return 0, fmt.Errorf("relay: build address sync request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+r.Token)
	req.Header.Set("Accept", "application/json")
	if h := r.spoolHeader(); h != "" {
		req.Header.Set(SpoolHeader, h)
	}
	resp, err := r.client().Do(req)
	if err != nil {
		return 0, fmt.Errorf("relay: address sync: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxRejectBody))
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxRejectBody))
		return 0, fmt.Errorf("relay: address sync: primary answered %d: %s",
			resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var got struct {
		Addresses []ReplicaAddress `json:"addresses"`
		AsOf      time.Time        `json:"as_of"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxReplicaBytes)).Decode(&got); err != nil {
		return 0, fmt.Errorf("relay: address sync: decode: %w", err)
	}

	// Every local part is re-validated HERE, against the same rule the SMTP
	// path applies, rather than trusted because it came from the primary. A
	// replica row is what the relay later asks the primary to resolve, so a
	// replica that accepts arbitrary strings is one an attacker who reaches the
	// endpoint can steer.
	kept := make([]ReplicaAddress, 0, len(got.Addresses))
	dropped := 0
	for _, a := range got.Addresses {
		if norm, ok := addresses.LocalPartOf(a.LocalPart+r.Suffix, r.Suffix); !ok || norm != a.LocalPart {
			dropped++
			continue
		}
		kept = append(kept, a)
	}
	if dropped > 0 {
		// No %q: the value is attacker-influenced text and this line goes
		// straight to the operator's log.
		r.logf("relay: address sync dropped %d malformed address row(s) from the primary", dropped)
	}
	// An EMPTY map never replaces a working one. The staleness rule exists so
	// that a replica we know may be out of date never answers a permanent 550 —
	// but an empty map installed with a FRESH as_of walks straight past it and
	// refuses every live address permanently, which is the failure that makes
	// Gmail disable a forwarding rule. A primary can produce one without being
	// compromised: an empty inbound_addresses, a half-applied migration, a
	// restore from backup, a bad expires_at comparison. A first sync that is
	// empty is a different thing entirely — there is nothing to lose and nobody
	// to refuse — so only the replacement is refused.
	if len(kept) == 0 {
		if prev := r.snapshot(); prev != nil && len(prev.Addresses) > 0 {
			r.logf("relay: the primary returned an EMPTY address map while this relay holds %d "+
				"address(es). REFUSING it: installing it would answer a permanent 550 for every "+
				"address this relay serves. The previous replica is untouched.",
				len(prev.Addresses))
			return 0, fmt.Errorf("relay: address sync: the primary returned an EMPTY address map "+
				"and this relay holds %d address(es); the replica is unchanged",
				len(prev.Addresses))
		}
	}
	asOf := got.AsOf
	if asOf.IsZero() {
		asOf = r.now()
	}
	rep := &replica{AsOf: asOf, Addresses: kept}
	if err := r.writeReplica(rep); err != nil {
		return 0, err
	}
	rep.build()
	r.mu.Lock()
	r.replica = rep
	r.mu.Unlock()
	return len(kept), nil
}

// writeReplica replaces the on-disk replica atomically: a temp file, fsynced,
// renamed over the old one, then the directory fsynced. A half-written replica
// would be read on the next boot as "no addresses at all", which is a relay that
// defers every message.
func (r *Relay) writeReplica(rep *replica) error {
	raw, err := json.Marshal(rep)
	if err != nil {
		return fmt.Errorf("relay: encode replica: %w", err)
	}
	tmp := filepath.Join(r.SpoolDir, replicaTmp)
	if err := writeSynced(tmp, raw); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(r.SpoolDir, replicaFile)); err != nil {
		return fmt.Errorf("relay: install replica: %w", err)
	}
	return syncDir(r.SpoolDir)
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

// Resolve implements [smtpd.Resolver] against the replica.
//
// The uuid it returns is NOT a user id — the relay never learns one, and the
// replica deliberately carries none. It is a stable pseudonym derived from the
// normalized local part, and it exists because smtpd keys its per-address daily
// allowance on the resolved identity: a random value per call would give every
// message its own quota, and the nil uuid would give every address on the relay
// one shared quota.
//
// See the package doc for why a stale replica defers rather than refuses.
func (r *Relay) Resolve(ctx context.Context, rcpt string) (uuid.UUID, bool, error) {
	local, ok := addresses.LocalPartOf(rcpt, r.Suffix)
	if !ok {
		// Not shaped like one of our addresses at all. This answer does not
		// depend on the replica — no sync would ever make it otherwise — so it
		// is permanent whatever the replica's age, and it is what sheds the junk
		// a public backup MX attracts.
		return uuid.Nil, false, addresses.ErrUnknownRecipient
	}
	rep := r.snapshot()
	if rep == nil {
		return uuid.Nil, false, ErrNoReplica
	}
	now := r.now()
	if a, found := rep.index[local]; found {
		// The grace-window predicate is addresses.Address's own, so the relay
		// and the primary cannot disagree about when a rotated address stops
		// accepting mail.
		if a.ExpiresAt == nil {
			return resolveKey(local), false, nil
		}
		known := addresses.Address{LocalPart: local, ExpiresAt: *a.ExpiresAt}
		if known.InGraceAt(now) {
			return resolveKey(local), true, nil
		}
	}
	if now.Sub(rep.AsOf) > r.maxReplicaAge() {
		return uuid.Nil, false, fmt.Errorf("%w (synced %s)", ErrStaleReplica,
			rep.AsOf.UTC().Format(time.RFC3339))
	}
	return uuid.Nil, false, addresses.ErrUnknownRecipient
}

// resolveKey is the pseudonymous per-address quota key. A v5 UUID over a fixed
// namespace and the normalized local part: deterministic, so one mailbox has one
// budget however it is spelled, and carrying no account identity because the
// relay holds none to carry.
func resolveKey(localPart string) uuid.UUID {
	return uuid.NewSHA1(quotaNamespace, []byte(localPart))
}

// ---------------------------------------------------------------------------
// Deliver — the spool
// ---------------------------------------------------------------------------

// spoolMeta is the commit record beside each spooled message.
//
// It carries what the primary needs to run the ordinary ingest path and nothing
// else. In particular it does NOT carry d.UserID: that value is the pseudonym
// above, and writing it down under a name like "user_id" would turn a quota key
// into something a reader could mistake for an account identifier.
type spoolMeta struct {
	V            int       `json:"v"`
	ID           string    `json:"id"`
	LocalPart    string    `json:"local_part"`
	EnvelopeFrom string    `json:"envelope_from"`
	RemoteIP     string    `json:"remote_ip"`
	ReceivedAt   time.Time `json:"received_at"`
	Bytes        int       `json:"bytes"`
	// SHA256 is the digest of the .eml, hex. It is checked before the message
	// is forwarded, so a body truncated by a power cut is detected rather than
	// delivered as though it were the message. It is also, not by coincidence,
	// the primary's ingest id for these bytes.
	SHA256 string `json:"sha256"`
	// Sealed is FALSE in Phase 1 and says so on disk: this spool holds
	// plaintext email. Phase 3 sets it true. See the package doc.
	Sealed bool `json:"sealed"`
}

// Deliver implements [smtpd.Handler]. It returns only once the message is
// durable — see the package doc's durability protocol — so an SMTP 250 means
// "this survives a power cut", and any failure here becomes a temporary SMTP
// error that leaves the message with the sender.
func (r *Relay) Deliver(ctx context.Context, d smtpd.Delivery) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(d.Raw) == 0 {
		return errors.New("relay: delivery has no message")
	}
	local, ok := addresses.LocalPartOf(d.Rcpt, r.Suffix)
	if !ok {
		// Unreachable: Resolve accepted this recipient moments ago. Refused
		// rather than defaulted, because a spooled message with no recipient is
		// one the primary can never place.
		return errors.New("relay: accepted a recipient that is not one of ours")
	}
	id, err := newSpoolID()
	if err != nil {
		return err
	}
	sum := sha256.Sum256(d.Raw)
	meta := spoolMeta{
		V:            spoolVersion,
		ID:           id,
		LocalPart:    local,
		EnvelopeFrom: d.EnvelopeFrom,
		ReceivedAt:   d.ReceivedAt,
		Bytes:        len(d.Raw),
		SHA256:       hex.EncodeToString(sum[:]),
		Sealed:       false,
	}
	if meta.ReceivedAt.IsZero() {
		meta.ReceivedAt = r.now()
	}
	if d.RemoteIP.IsValid() {
		meta.RemoteIP = d.RemoteIP.String()
	}
	rawMeta, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("relay: encode spool metadata: %w", err)
	}

	// The body first, then the commit record, then the directory. See the
	// package doc: reversing the first two would leave a crash looking like a
	// message whose body was lost, rather than like one that never arrived.
	// TestDeliverWritesTheBodyThenTheCommitRecordThenFsyncsTheDirectory pins the
	// order itself, which is why these go through the seam.
	if err := writeSpoolFile(filepath.Join(r.SpoolDir, id+emlSuffix), d.Raw); err != nil {
		return err
	}
	if err := writeSpoolFile(filepath.Join(r.SpoolDir, id+metaSuffix), rawMeta); err != nil {
		return err
	}
	return syncSpoolDir(r.SpoolDir)
}

// newSpoolID mints a time-ordered spool id.
//
// It is a UUIDv7: google/uuid's implementation guarantees each call returns a
// value strictly greater than the last, and the timestamp occupies the leading
// bytes, so the hex rendering sorts in arrival order. That is what makes the
// drain deliver a backlog in the order it was received rather than in readdir
// order, which matters because a user reading a recovered burst should see their
// morning before their afternoon.
func newSpoolID() (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("relay: mint a spool id: %w", err)
	}
	return id.String(), nil
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

// deliverRequest is the wire shape of POST /api/v1/relay/deliver. The primary
// re-resolves local_part itself, so the relay never sends — and never holds — a
// user id.
type deliverRequest struct {
	LocalPart    string    `json:"local_part"`
	EnvelopeFrom string    `json:"envelope_from"`
	RemoteIP     string    `json:"remote_ip"`
	ReceivedAt   time.Time `json:"received_at"`
	Raw          string    `json:"raw"` // base64
}

// Drain offers every spooled message to the primary, oldest first.
//
// sent counts messages the primary accepted (and which are now gone from the
// spool); failed counts per-message rejections moved to `rejected/`.
//
// A non-nil error means something went wrong, and it comes in two shapes that
// the message count distinguishes:
//
//   - A WHOLE-PRIMARY condition — unreachable, 5xx, our token refused, throttled,
//     or the relay routes simply not served — stops the pass at that point with
//     everything still spooled. Replaying the same failure once per message
//     would achieve nothing but load.
//   - A LOCAL, per-message condition — this one file cannot be read right now —
//     keeps that message and CONTINUES with the rest. It used to stop the whole
//     pass, so one unreadable commit record blocked every message behind it
//     indefinitely; the messages behind it are not implicated by it.
//
// Either way nothing is deleted and nothing is set aside: those need either a
// 2xx or an explicit verdict from the primary ([VerdictHeader]).
func (r *Relay) Drain(ctx context.Context) (sent int, failed int, err error) {
	r.drainMu.Lock()
	defer r.drainMu.Unlock()

	ids, uncommitted, lerr := r.list()
	if lerr != nil {
		return 0, 0, lerr
	}
	if uncommitted > 0 {
		r.logf("relay: %d spooled message(s) have no commit record beside them "+
			"(a crash mid-write; the sender was never told 250, so it still holds them). "+
			"They are neither forwarded nor deleted.", uncommitted)
	}
	for _, id := range ids {
		if cerr := ctx.Err(); cerr != nil {
			err = cerr
			break
		}
		out, oerr := r.drainOne(ctx, id)
		switch out {
		case outcomeSent:
			sent++
		case outcomeRejected:
			failed++
		case outcomeGone:
			// Drained by something else between the listing and now.
		case outcomeSkip:
			// One file this pass could not handle. Report it, keep it, and go
			// on to the messages behind it, which it says nothing about.
			r.logf("relay: %s could not be read this pass and stays spooled: %v. "+
				"Nothing has been discarded; the messages behind it are being offered normally.",
				id, oerr)
			if err == nil {
				err = oerr
			}
		default: // outcomeRetry
			err = oerr
			// A whole-primary condition. Stop rather than replay the same
			// failure once per spooled message.
			r.alarm()
			return sent, failed, err
		}
	}
	r.alarm()
	return sent, failed, err
}

type outcome int

const (
	// outcomeRetry is the zero value on purpose: a path that forgets to set an
	// outcome keeps the message rather than losing it.
	// TestTheDefaultOutcomeKeepsTheMessage pins it.
	outcomeRetry outcome = iota
	outcomeSent
	outcomeRejected
	outcomeGone
	// outcomeSkip also keeps the message, but says so about THIS message rather
	// than about the primary, so the pass continues past it.
	outcomeSkip
)

func (r *Relay) drainOne(ctx context.Context, id string) (outcome, error) {
	metaPath := filepath.Join(r.SpoolDir, id+metaSuffix)
	emlPath := filepath.Join(r.SpoolDir, id+emlSuffix)

	rawMeta, err := os.ReadFile(metaPath)
	if err != nil {
		// It may simply have been drained by a concurrent process; treat a
		// vanished commit record as nothing to do rather than as a failure.
		if os.IsNotExist(err) {
			return outcomeGone, nil
		}
		// Any other read error is about THIS FILE — not about the primary and
		// not about the messages behind it, which is what stopping the pass here
		// used to say.
		return outcomeSkip, fmt.Errorf("relay: read %s: %w", metaPath, err)
	}
	var meta spoolMeta
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		// A commit record that cannot be PARSED is different from one that
		// cannot be read: the bytes are here and they do not say who the message
		// was for, so no retry will ever place it.
		return r.reject(id, 0, fmt.Sprintf("unreadable spool metadata: %v", err))
	}
	raw, err := os.ReadFile(emlPath)
	switch {
	case os.IsNotExist(err):
		// The promise exists and the message does not. Nothing can deliver this,
		// so it is set aside loudly rather than retried for ever. (The write
		// order in Deliver is chosen so that a crash cannot produce this state —
		// see the package doc.)
		return r.reject(id, 0, "the spooled body is missing; only its commit record is on disk")
	case err != nil:
		// EIO, EACCES, a full descriptor table: the bytes may be perfectly fine
		// and nothing has proved otherwise. The commit record above is retried on
		// exactly this class of error and the two halves of one pair must not be
		// handled asymmetrically.
		return outcomeSkip, fmt.Errorf("relay: read %s: %w", emlPath, err)
	}
	if sum := sha256.Sum256(raw); hex.EncodeToString(sum[:]) != meta.SHA256 {
		// A body that does not match its recorded digest is not this message.
		// Forwarding it would enter corrupted bank mail into a stranger's
		// ledger; deleting it would destroy the only copy.
		return r.reject(id, 0, "the spooled body does not match the digest recorded at arrival")
	}

	body, err := json.Marshal(deliverRequest{
		LocalPart:    meta.LocalPart,
		EnvelopeFrom: meta.EnvelopeFrom,
		RemoteIP:     meta.RemoteIP,
		ReceivedAt:   meta.ReceivedAt,
		Raw:          base64.StdEncoding.EncodeToString(raw),
	})
	if err != nil {
		return outcomeRetry, fmt.Errorf("relay: encode delivery %s: %w", id, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint(DeliverPath), bytes.NewReader(body))
	if err != nil {
		return outcomeRetry, fmt.Errorf("relay: build delivery request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+r.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client().Do(req)
	if err != nil {
		return outcomeRetry, fmt.Errorf("relay: forward %s: %w", id, err)
	}
	answer, _ := io.ReadAll(io.LimitReader(resp.Body, maxRejectBody))
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		// The commit record goes first: once it is gone the message is no
		// longer spooled, and a crash before the body is removed leaves a
		// harmless uncommitted file rather than a metadata row pointing at
		// nothing.
		if err := os.Remove(metaPath); err != nil {
			return outcomeRetry, fmt.Errorf("relay: remove %s after delivery: %w", metaPath, err)
		}
		if err := os.Remove(emlPath); err != nil {
			r.logf("relay: delivered %s but could not remove its body: %v", id, err)
		}
		return outcomeSent, nil
	case rejectedByThePrimary(resp):
		return r.reject(id, resp.StatusCode, strings.TrimSpace(string(answer)))
	case retryableStatus(resp.StatusCode):
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			r.logf("relay: the primary REFUSED OUR TOKEN (%d). Nothing is being forwarded and "+
				"nothing has been discarded; check LEDGER_RELAY_TOKEN on both hosts.", resp.StatusCode)
		}
		return outcomeRetry, fmt.Errorf("relay: forward %s: primary answered %d: %s",
			id, resp.StatusCode, strings.TrimSpace(string(answer)))
	case notServingTheRelay(resp.StatusCode):
		// The route is not there. That is a state of the PRIMARY's deployment —
		// no LEDGER_RELAY_TOKEN, no mail handler, no address resolver, a
		// half-configured reverse proxy — and it says nothing whatever about the
		// message being offered. Stop the pass and say so in the words the
		// operator has to act on.
		r.logf("relay: THE PRIMARY DOES NOT SERVE THE RELAY ENDPOINTS (%d from %s). Nothing is "+
			"being forwarded and NOTHING HAS BEEN DISCARDED — every message stays spooled. "+
			"Check LEDGER_RELAY_TOKEN and relay.enabled on the primary.",
			resp.StatusCode, r.endpoint(DeliverPath))
		return outcomeRetry, fmt.Errorf("relay: forward %s: the primary does not serve %s (%d)",
			id, DeliverPath, resp.StatusCode)
	default:
		// A 4xx with no verdict on it. It may well be this message's fault, but
		// nothing has SAID so, and the cost of guessing wrong is a message no
		// sender will retry. Keep it and move on to the ones behind it.
		r.logf("relay: the primary answered %d for %s with no %s: %s. The message is KEPT — a "+
			"rejection has to be stated, not inferred.",
			resp.StatusCode, id, VerdictHeader, strings.TrimSpace(string(answer)))
		return outcomeSkip, fmt.Errorf("relay: forward %s: primary answered %d without a verdict",
			id, resp.StatusCode)
	}
}

// rejectedByThePrimary reports whether this answer is an explicit per-message
// rejection: the primary said so in [VerdictHeader], on a status that describes
// the message rather than itself.
//
// Both halves are required. The header alone cannot promote a 503 into a
// verdict (a primary in trouble is not a primary making judgements), and the
// status alone is exactly the inference that used to destroy spools.
func rejectedByThePrimary(resp *http.Response) bool {
	if resp.StatusCode < 400 || resp.StatusCode >= 500 || retryableStatus(resp.StatusCode) {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(resp.Header.Get(VerdictHeader)), VerdictReject)
}

// retryableStatus reports whether a status describes the PRIMARY rather than the
// message. See the package doc: 401/403 are here on purpose, because a mistyped
// token would otherwise reject an entire spool in one tick.
func retryableStatus(code int) bool {
	switch code {
	case http.StatusUnauthorized, http.StatusForbidden,
		http.StatusRequestTimeout, http.StatusTooManyRequests:
		return true
	}
	return code >= 500
}

// notServingTheRelay reports the statuses that mean "there is no such endpoint
// here": an unmounted route, a method the mux does not route, a proxy that does
// not know about this path. An ABSENT token produces 404 rather than the 401 an
// empty one would, which is why the token carve-out above never covered this.
func notServingTheRelay(code int) bool {
	switch code {
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return true
	}
	return false
}

// reject moves a message out of the live spool and into `rejected/`, together
// with a record of why. Nothing is deleted, ever: this is a lane, not a bin.
func (r *Relay) reject(id string, status int, why string) (outcome, error) {
	dst := filepath.Join(r.SpoolDir, rejectedDir)
	for _, suffix := range []string{emlSuffix, metaSuffix} {
		src := filepath.Join(r.SpoolDir, id+suffix)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		if err := os.Rename(src, filepath.Join(dst, id+suffix)); err != nil {
			return outcomeRetry, fmt.Errorf("relay: set aside %s: %w", src, err)
		}
	}
	record := fmt.Sprintf("spool id: %s\nat: %s\nprimary status: %d\nprimary said: %s\n",
		id, r.now().UTC().Format(time.RFC3339), status, why)
	if err := writeSynced(filepath.Join(dst, id+rejectSuffix), []byte(record)); err != nil {
		return outcomeRetry, err
	}
	if err := syncDir(dst); err != nil {
		return outcomeRetry, err
	}
	if err := syncDir(r.SpoolDir); err != nil {
		return outcomeRetry, err
	}
	// Loud, and unconditionally: this is a message the sender was already told
	// 250 for, so nothing else will ever retry it. It is the exact shape spec
	// §2's drop policy is about.
	r.logf("relay: REJECTED BY THE PRIMARY: %s was accepted from a sender and the primary "+
		"then refused it (%d: %s). It is kept in %s and will NOT be retried; nothing else "+
		"will deliver it.", id, status, why, dst)
	return outcomeRejected, nil
}

// alarm surfaces a spool that has outlived the retry budget a sending MTA would
// have had. It never deletes anything — see the package doc.
func (r *Relay) alarm() {
	st, err := r.Stats()
	if err != nil {
		r.logf("relay: reading the spool: %v", err)
		return
	}
	now := r.now()
	if st.Stale(now, r.staleAfter()) {
		r.logf("relay: SPOOL ALARM: %d message(s) have been waiting for the primary, the "+
			"oldest for %s. These were ACCEPTED from their senders, so no MTA will retry "+
			"them: they exist only in %s.", st.Spooled, st.OldestAge(now).Round(time.Minute), r.SpoolDir)
	}
	if st.Rejected > 0 {
		r.logf("relay: %d file(s) in %s were refused by the primary and will never be "+
			"delivered without operator action.", st.Rejected, filepath.Join(r.SpoolDir, rejectedDir))
	}
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

// Stats is the relay's backlog, which is the only thing standing between a
// spooled message and a silent drop.
type Stats struct {
	// Spooled is the number of committed messages waiting for the primary.
	Spooled int
	// Uncommitted is the number of message bodies with no commit record beside
	// them: a crash mid-write, never acknowledged to the sender.
	Uncommitted int
	// Rejected is the number of messages in the rejection lane.
	//
	// It counts the `.why.txt` records rather than the `.eml` bodies, because
	// [Relay.reject] writes exactly one of those per rejection and a message can
	// be set aside precisely BECAUSE its body is missing or unreadable — which
	// is the case an .eml count cannot see, in the lane the operator is watching
	// for messages nothing will ever retry.
	Rejected int
	// Oldest is the arrival instant of the oldest spooled message, zero when
	// there are none.
	Oldest time.Time
}

// OldestAge is how long the oldest spooled message has been waiting, or 0.
func (s Stats) OldestAge(now time.Time) time.Duration {
	if s.Oldest.IsZero() {
		return 0
	}
	if d := now.Sub(s.Oldest); d > 0 {
		return d
	}
	return 0
}

// Stale reports whether the backlog has outlived a sending MTA's retry budget.
func (s Stats) Stale(now time.Time, after time.Duration) bool {
	return s.Spooled > 0 && s.OldestAge(now) >= after
}

// Stats reads the spool directory.
func (r *Relay) Stats() (Stats, error) {
	ids, uncommitted, err := r.list()
	if err != nil {
		return Stats{}, err
	}
	st := Stats{Spooled: len(ids), Uncommitted: uncommitted}
	if len(ids) > 0 {
		// ids are time-ordered, so the first is the oldest.
		if raw, err := os.ReadFile(filepath.Join(r.SpoolDir, ids[0]+metaSuffix)); err == nil {
			var meta spoolMeta
			if json.Unmarshal(raw, &meta) == nil {
				st.Oldest = meta.ReceivedAt
			}
		}
		if st.Oldest.IsZero() {
			if fi, err := os.Stat(filepath.Join(r.SpoolDir, ids[0]+metaSuffix)); err == nil {
				st.Oldest = fi.ModTime()
			}
		}
	}
	ents, err := os.ReadDir(filepath.Join(r.SpoolDir, rejectedDir))
	if err != nil && !os.IsNotExist(err) {
		return Stats{}, fmt.Errorf("relay: read %s: %w", rejectedDir, err)
	}
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), rejectSuffix) {
			st.Rejected++
		}
	}
	return st, nil
}

// spoolHeader renders the backlog for [SpoolHeader], or "" when there is
// nothing to report.
func (r *Relay) spoolHeader() string {
	st, err := r.Stats()
	if err != nil {
		return ""
	}
	if st.Spooled == 0 && st.Rejected == 0 && st.Uncommitted == 0 {
		return ""
	}
	h := fmt.Sprintf("spooled=%d; rejected=%d; uncommitted=%d", st.Spooled, st.Rejected, st.Uncommitted)
	if !st.Oldest.IsZero() {
		h += "; oldest=" + st.Oldest.UTC().Format(time.RFC3339)
	}
	return h
}

// list returns the ids of committed spooled messages in arrival order, plus the
// count of bodies with no commit record.
func (r *Relay) list() ([]string, int, error) {
	ents, err := os.ReadDir(r.SpoolDir)
	if err != nil {
		return nil, 0, fmt.Errorf("relay: read spool %s: %w", r.SpoolDir, err)
	}
	metas := map[string]bool{}
	bodies := map[string]bool{}
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		switch {
		case name == replicaFile || name == replicaTmp:
		case strings.HasSuffix(name, metaSuffix):
			metas[strings.TrimSuffix(name, metaSuffix)] = true
		case strings.HasSuffix(name, emlSuffix):
			bodies[strings.TrimSuffix(name, emlSuffix)] = true
		}
	}
	// SPOOLED means "has a commit record". A commit record whose body is
	// missing is still spooled and is still listed — drainOne sets it aside on
	// sight, which is what stops it being retried forever.
	ids := make([]string, 0, len(metas))
	for id := range metas {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	uncommitted := 0
	for id := range bodies {
		if !metas[id] {
			uncommitted++
		}
	}
	return ids, uncommitted, nil
}

func (r *Relay) endpoint(path string) string {
	return strings.TrimRight(r.PrimaryURL, "/") + path
}

// ---------------------------------------------------------------------------
// Durable writes
// ---------------------------------------------------------------------------

// writeSpoolFile and syncSpoolDir are the durable-write seam, and they are
// package variables for exactly one reason: the durability protocol is
// otherwise unobservable from userspace, so no test could tell a correct
// implementation from one that had dropped an fsync or swapped the order of the
// two writes — and a mutation battery proved all three of those pass a suite
// that only checks the files exist afterwards.
//
// Nothing in production reassigns them. durability_test.go substitutes them to
// record the ORDER of the steps and to simulate a crash between them.
var (
	writeSpoolFile = writeSynced
	syncSpoolDir   = syncDir
)

// writeSynced writes a file and fsyncs it before returning. The error is
// reported rather than logged: every caller here is on the path that decides
// whether an SMTP 250 is honest.
func writeSynced(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, spoolFileMode)
	if err != nil {
		return fmt.Errorf("relay: create %s: %w", path, err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return fmt.Errorf("relay: write %s: %w", path, err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("relay: fsync %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("relay: close %s: %w", path, err)
	}
	return nil
}

// syncDir fsyncs a directory, which is what makes a file's NAME durable. A file
// whose contents are safe and whose directory entry is not is a lost message.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("relay: open %s to fsync it: %w", dir, err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("relay: fsync %s: %w", dir, err)
	}
	return nil
}
