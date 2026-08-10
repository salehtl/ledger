package admin

// invites.go puts the closed beta's gate on the console, so minting a code for
// somebody is a button rather than an SSH session.
//
// # The one property everything here is arranged around
//
// A code is printed ONCE and is not recoverable. Only its SHA-256 is stored
// (00020_invite_codes.sql), so there is nothing to read back — and therefore
// there is deliberately NO route here that returns a code for an existing row.
// [Invites] has no method that could, which is the version of that rule a future
// edit cannot quietly break: it is not a handler that declines to do something,
// it is a capability that is absent.
//
// The mint response carries the code exactly once, and the panel says so beside
// it in as many words. An operator who closes the toast mints another; that is a
// five-second inconvenience, and it is the price of a database backup being a
// bag of digests instead of a bag of live invitations.
//
// # Why an interface, and not auth.MintInvite called from here
//
// Same reason as [Reprocessor] and [SampleSource], and one stronger one: this
// package must not import internal/v2/auth. That is not a style rule — it is
// what makes "a user session cannot become an admin credential" a fact about the
// import graph rather than a rule somebody checks (see admin.go's header, and
// TestAUserSessionCannotReachAnAdminRoute). The adapter lives in cmd/ledgerd,
// beside the one that already backs `ledgerd mint-invite`, so the console and
// the subcommand mint through exactly the same generator: 24 characters of RFC
// 4648 base32, 120 bits from crypto/rand, measured by
// auth.TestMintedInviteCodesAreUnguessable.
//
// # Revocation is a DELETE of an unredeemed row, and needed no migration
//
// The table has no `revoked_at` column and this did not add one. Deleting an
// unredeemed row is the honest operation: the code's only trace is its digest,
// the digest is what redemption matches, and removing it makes the code
// unspendable in exactly the way the row made it spendable. It is reversible
// only by minting a new code, which is the correct amount of reversible for
// "I sent that to the wrong person".
//
// Deleting a REDEEMED row is refused, and this is the part that matters. That
// row is the audit trail — an account exists because of it — and dropping it
// would leave an account nobody can account for while doing nothing at all to
// the account itself. The refusal is a 409 naming the reason, not a silent
// no-op, because an operator who clicked the wrong row needs to know they did.

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Invite is one row of the operator's listing. There is no Code field, because
// there is no code stored to put in one.
type Invite struct {
	// Hash is the short hex prefix of the SHA-256 of the code — the same
	// prefix `ledgerd mint-invite --show` prints. It tells two rows apart and
	// is useless as a credential: it is a truncated digest of 120 bits of
	// randomness, so it is neither the code nor a path to it.
	Hash       string     `json:"hash"`
	Note       string     `json:"note,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	RedeemedAt *time.Time `json:"redeemed_at"`
	// RedeemedBy is null for an outstanding code AND for a code whose account
	// was later deleted (ON DELETE SET NULL). RedeemedAt is what separates
	// those two, which is why both fields are here.
	RedeemedBy *uuid.UUID `json:"redeemed_by"`
}

// ErrInviteRedeemed is a revoke aimed at a code that has already been spent.
var ErrInviteRedeemed = errors.New("admin: that code was already redeemed")

// ErrInviteNotFound is a revoke aimed at a hash prefix no row carries.
var ErrInviteNotFound = errors.New("admin: no invite code has that hash")

// ErrInviteAmbiguous is a revoke whose hash prefix matches more than one row.
// It is refused rather than resolved: guessing which of two codes the operator
// meant to destroy is not a guess worth making.
var ErrInviteAmbiguous = errors.New("admin: that hash prefix matches more than one invite code")

// Minted is a freshly created code: the ONE moment a plaintext code exists
// outside the memory of whoever is about to be handed it.
//
// Hash travels with it so the panel can point at the row the listing will show
// this code under. It is computed by the adapter, from the same digest auth
// stores, rather than recomputed here — this package must not own a second
// definition of "the hash of a code", because a second one is one that can
// drift from the one redemption actually matches.
type Minted struct {
	Code      string
	Hash      string
	CreatedAt time.Time
}

// Invites is the beta gate, as much of it as the console needs.
//
// Note what is NOT on it: any method that returns an existing code. See the
// header.
type Invites interface {
	// Mint creates one code and returns the plaintext, once.
	Mint(ctx context.Context, note string, now time.Time) (Minted, error)
	// List reports every code, newest first, as hashes.
	List(ctx context.Context) ([]Invite, error)
	// Revoke destroys one UNREDEEMED code, addressed by the hash prefix List
	// reported. It returns ErrInviteRedeemed, ErrInviteNotFound or
	// ErrInviteAmbiguous rather than silently doing nothing.
	Revoke(ctx context.Context, hashPrefix string) error
}

func (h *Handler) listInvites(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Invites.List(r.Context())
	if err != nil {
		h.logf("admin: list invites: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	if rows == nil {
		rows = []Invite{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": rows})
}

type mintInviteRequest struct {
	// Note is the operator's own words about who the code is for. Optional: a
	// code minted in a hurry with no note is better than a code not minted.
	Note string `json:"note"`
}

// maxInviteNote caps the operator's free text. The column is unconstrained
// `text`, but a console field is not a place to paste a megabyte.
const maxInviteNote = 500

// mintInvite creates one code and returns it. This is the only response in the
// whole console that carries a live credential, and the only time this one
// exists outside the caller's memory.
func (h *Handler) mintInvite(w http.ResponseWriter, r *http.Request) {
	var req mintInviteRequest
	if !decodeOptionalBodyN(w, r, maxBodyBytes, &req) {
		return
	}
	note := strings.TrimSpace(req.Note)
	if len(note) > maxInviteNote {
		writeErr(w, http.StatusBadRequest, "note is longer than 500 characters")
		return
	}
	minted, err := h.Invites.Mint(r.Context(), note, time.Now().UTC())
	if err != nil {
		h.logf("admin: mint invite: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// Logged at operator volume like a retirement or a suspension, and WITHOUT
	// the code: the process log is the console's only audit trail, and a log
	// line carrying a live invitation would undo the entire point of storing
	// only a digest.
	h.logf("admin: MINTED the invite code %s (note: %q); it is single use and is not recoverable",
		minted.Hash, note)
	writeJSON(w, http.StatusCreated, map[string]any{
		// Named "code" and not "token" so the panel copy and the response agree
		// with `ledgerd mint-invite`, which the operator may still use.
		"code": minted.Code,
		"note": note,
		// The prefix the listing will show it under, so the operator can find
		// the row they just made without a reload guessing game.
		"hash":       minted.Hash,
		"created_at": minted.CreatedAt,
	})
}

// revokeInvite destroys one unredeemed code.
func (h *Handler) revokeInvite(w http.ResponseWriter, r *http.Request) {
	prefix := strings.TrimSpace(r.PathValue("hash"))
	if prefix == "" {
		writeErr(w, http.StatusBadRequest, "hash is required")
		return
	}
	// Checked here rather than in SQL so a typo is a 400 the operator can read,
	// not a query that matches nothing and reads as "already gone". DecodeString
	// rejects an odd length too, which is the other way to mistype a prefix.
	if _, err := hex.DecodeString(prefix); err != nil {
		writeErr(w, http.StatusBadRequest, "hash must be hex, as the listing prints it")
		return
	}
	switch err := h.Invites.Revoke(r.Context(), prefix); {
	case err == nil:
		h.logf("admin: REVOKED the unredeemed invite code %s; it can no longer create an account", prefix)
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, ErrInviteNotFound):
		writeErr(w, http.StatusNotFound, "no invite code has that hash")
	case errors.Is(err, ErrInviteAmbiguous):
		writeErr(w, http.StatusConflict, "that hash matches more than one code; nothing was revoked")
	case errors.Is(err, ErrInviteRedeemed):
		writeErr(w, http.StatusConflict,
			"that code was already redeemed. The account it created still exists, and the row is "+
				"the only record of where it came from, so it is kept. Suspend the account instead.")
	default:
		h.logf("admin: revoke invite %s: %v", prefix, err)
		writeErr(w, http.StatusInternalServerError, "internal")
	}
}
