// Package dict owns the global anonymous merchant -> category dictionary
// (spec §3.6): the store, the two gates in front of publication, and the delta
// feed clients pull it through.
//
// # The two gates
//
// A submission becomes a published entry only when BOTH hold:
//
//   - a moderator approved it, which blocks POISONING (`AMAZON -> Charity`
//     shipped to every device on crowd volume alone), and
//   - at least [K] DISTINCT users submitted it, which blocks IDENTIFICATION (a
//     merchant only one beta user transacts with is a name for that user).
//
// The operator's own v1 rules bypass the second gate and only the second:
// `source='operator_seed'` is one identified party's deliberate contribution,
// not a crowd signal that could be a single user's fingerprint. It still needs
// a moderator.
//
// # A merchant pattern is never user-linked
//
// Spec §3.6 says the dictionary is "a bare merchant pattern, never
// user-linked", and §2 promises a breach of this server yields no merchants. A
// table of (user_id, merchant_pattern) would be a per-user merchant ledger —
// strictly worse than parse_diagnostics, which holds no merchant at all — so
// there is no user id in either table, and no column that could be joined into
// one.
//
// What is stored instead is HMAC-SHA256(server key, pattern || category ||
// user_id) with every field length-prefixed. It supports exactly one operation,
// counting distinct submitters for one entry, and nothing else. Two rows for
// the same user under different entries are unrelatable, because the entry is
// inside the HMAC input.
//
// # What that is NOT
//
// At closed-beta scale the operator can enumerate its own three-to-five-user
// list against the HMAC and recover who submitted a pattern, for as long as the
// row exists. This is stated in spec §2 rather than glossed. The HMAC removes
// the STORED linkage — a stolen disk without LEDGER_DICT_HMAC_KEY yields
// nothing — and bounds how long the identifier exists at all, which is the part
// that carries real weight:
//
//   - [Dict.Submit] stores NOTHING when the count can no longer change the
//     outcome: the entry already reached K, was seeded by the operator, or has
//     published.
//   - The rows for an entry are deleted the MOMENT its count reaches K, whether
//     or not a moderator has looked at it yet. Publication is later; the
//     identifiers do not wait for it.
//   - [Dict.ExpireStaleSubmissions] drops identifiers for entries that never
//     reach K at all, which is the only reason `created_at` exists.
//   - [Dict.ForgetSubmitter] is Task 34's purge hook. It cannot find rows by
//     user id — there is none — so it recomputes the HMAC for the purged user
//     against every distinct entry in the table and deletes the matches. A
//     purge that silently misses a table is the exact failure mode Task 34's
//     schema discovery exists to prevent, so there is a test for it here.
//
// # What a client is allowed to learn
//
// [Dict.Since] is the whole distribution surface, and its constraint is that a
// client must never learn of a pattern that has not published — a `removed`
// list is the easiest place to leak one. So only an entry with a non-NULL
// `published_at` (it actually shipped once) can be named in a retraction, and
// the cursor a client gets back is the maximum version over rows VISIBLE TO IT.
// A version taken from the global sequence would advance on every suppressed
// submission and leak the submission rate by itself.
package dict

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// K is the suppression threshold: an entry stays invisible until this many
// DISTINCT users have submitted it (plan Decision 8).
//
// It is also a literal inside 00011_merchant_dictionary.sql, which cannot
// reference a Go constant; TestTheKThresholdMatchesTheSQLLiteralAndTheSpec
// reads the constraint back and fails if they diverge.
const K = 3

// Match types. 'regex' is deliberately absent — see the migration.
const (
	MatchContains = "contains"
	MatchExact    = "exact"
)

// Entry sources.
const (
	SourceCrowd    = "crowd"
	SourceOperator = "operator_seed"
)

// Bounds on the two user-supplied strings. Runes, not bytes: a bound in bytes
// would silently be three times tighter for an Arabic merchant name.
const (
	maxPatternRunes  = 64
	minPatternRunes  = 2
	maxCategoryRunes = 32
	maxNoteBytes     = 500
	// minKeyBytes is 128 bits. Below that a key is brute-forcible offline
	// against a table of pseudonyms whose inputs the operator already knows.
	minKeyBytes = 16
)

var (
	// ErrInvalidEntry rejects a pattern or category that does not fit the
	// bounded shape both tables enforce.
	ErrInvalidEntry = errors.New("dict: invalid entry")
	// ErrNoKey is returned when HMACKey is missing or too short. It is an
	// error rather than a fallback to an empty key, which would make every
	// stored identifier recomputable by anyone holding the dump.
	ErrNoKey = errors.New("dict: no submitter hmac key")
	// ErrNotFound is returned by Moderate for an entry that does not exist.
	ErrNotFound = errors.New("dict: no such entry")
)

// Entry is one published mapping: the whole of what a client receives.
type Entry struct {
	Pattern  string `json:"pattern"`
	Match    string `json:"match"`
	Category string `json:"category"`
}

// Status is one entry as the operator's moderation queue sees it. It carries
// the two gate inputs and is never served to a client.
type Status struct {
	Entry
	Source string `json:"source"`
	// Approved is nil when nobody has moderated the entry yet, which is not
	// the same as a rejection.
	Approved           *bool  `json:"approved"`
	DistinctSubmitters int    `json:"distinct_submitters"`
	Note               string `json:"note,omitempty"`
	Version            int64  `json:"version,string"`
	Published          bool   `json:"published"`
}

// Delta is one page of the client-facing feed. Version is the cursor to send
// back next time; it is the maximum version over rows this client can see, not
// the global sequence position.
type Delta struct {
	Version int64
	Entries []Entry
	// Removed names entries that were published once and are not publishable
	// now. It is empty for a client starting from scratch (since == 0), which
	// has nothing to remove.
	Removed []Entry
}

// Dict is the store. It holds no state beyond its pool, key and clock.
type Dict struct {
	Pool *pgxpool.Pool
	// HMACKey keys the submitter pseudonym. Env-only
	// (LEDGER_DICT_HMAC_KEY); see [ParseKey].
	HMACKey []byte
	// Now defaults to time.Now, and is only used to stamp published_at.
	Now func() time.Time
}

func (d *Dict) now() time.Time {
	if d != nil && d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d *Dict) check() error {
	if d == nil || d.Pool == nil {
		return errors.New("dict: no pool")
	}
	return nil
}

func (d *Dict) checkKey() error {
	if err := d.check(); err != nil {
		return err
	}
	if len(d.HMACKey) < minKeyBytes {
		return fmt.Errorf("%w: LEDGER_DICT_HMAC_KEY must be at least %d bytes",
			ErrNoKey, minKeyBytes)
	}
	return nil
}

// ParseKey decodes LEDGER_DICT_HMAC_KEY, which is hex — `openssl rand -hex 32`.
//
// Hex ONLY, deliberately. Accepting "either hex or raw bytes" makes a 64-
// character key ambiguous: it is both a valid 32-byte hex string and a valid
// 64-byte passphrase, and the two decode to different keys. A deployment that
// resolved that ambiguity differently from the one that wrote the rows would
// silently stop matching its own stored pseudonyms, and ForgetSubmitter would
// quietly purge nothing.
func ParseKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("%w: LEDGER_DICT_HMAC_KEY is empty", ErrNoKey)
	}
	key, err := hex.DecodeString(s)
	if err != nil {
		// No %q, and not the decoder's own error: hex.DecodeString reports the
		// offending byte, and this argument is a secret.
		return nil, fmt.Errorf("%w: LEDGER_DICT_HMAC_KEY is not hex (generate one with "+
			"`openssl rand -hex 32`)", ErrNoKey)
	}
	if len(key) < minKeyBytes {
		return nil, fmt.Errorf("%w: LEDGER_DICT_HMAC_KEY decodes to %d bytes, need at least %d",
			ErrNoKey, len(key), minKeyBytes)
	}
	return key, nil
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

// Canonicalize returns the storable form of an entry, or ErrInvalidEntry.
//
// Canonicalization is a k-gate concern, not tidiness. Without it "CARREFOUR",
// "Carrefour" and "  carrefour  " are three entries with one submitter each
// rather than one entry with three, and the threshold splits into pieces no
// single one of which ever reaches it — while the merchant is just as
// identifying as before.
//
// Errors name the FIELD and never echo the VALUE, following internal/v2/diag:
// the value here is the merchant string itself, and an error that quoted it
// would route the content straight into an operator log.
func Canonicalize(e Entry) (Entry, error) {
	// Checked on the RAW input, before collapsing. A merchant name is one
	// line, and collapse() below squeezes every run of Unicode whitespace —
	// including a newline — to a single space, so without this a two-line
	// paste would be silently JOINED into a valid-looking pattern rather than
	// refused. Silently accepting a caller's structural mistake is how text
	// that was never meant to be a merchant name ends up stored as one.
	if hasLineBreak(e.Pattern) || hasLineBreak(e.Category) {
		return Entry{}, fmt.Errorf("%w: a pattern and a category are each a single line", ErrInvalidEntry)
	}
	out := Entry{
		Pattern:  collapse(e.Pattern),
		Match:    strings.ToLower(strings.TrimSpace(e.Match)),
		Category: collapse(e.Category),
	}
	if out.Match == "" {
		out.Match = MatchContains
	}
	if !slices.Contains([]string{MatchContains, MatchExact}, out.Match) {
		return Entry{}, fmt.Errorf("%w: match must be one of %v (a regex published to every "+
			"client is a fleet-wide execution surface)", ErrInvalidEntry,
			[]string{MatchContains, MatchExact})
	}
	if n := len([]rune(out.Pattern)); n < minPatternRunes || n > maxPatternRunes {
		return Entry{}, fmt.Errorf("%w: pattern must be %d..%d characters, got %d",
			ErrInvalidEntry, minPatternRunes, maxPatternRunes, n)
	}
	if !hasAlnum(out.Pattern) {
		return Entry{}, fmt.Errorf("%w: pattern must contain a letter or a digit; a pattern of "+
			"pure punctuation matches merchants it has nothing to do with", ErrInvalidEntry)
	}
	if hasUnprintable(out.Pattern) {
		return Entry{}, fmt.Errorf("%w: pattern must be a single line of printable text", ErrInvalidEntry)
	}
	if n := len([]rune(out.Category)); n < 2 || n > maxCategoryRunes {
		return Entry{}, fmt.Errorf("%w: category must be 2..%d characters, got %d",
			ErrInvalidEntry, maxCategoryRunes, n)
	}
	if !isCategoryLabel(out.Category) {
		return Entry{}, fmt.Errorf("%w: category must be a short label of letters, digits, "+
			"spaces and -_/&, not free text", ErrInvalidEntry)
	}
	return out, nil
}

// collapse lower-cases, trims, and squeezes every run of whitespace to one
// space. strings.Fields splits on all Unicode space, so a non-breaking space
// pasted out of a bank statement collapses like an ordinary one.
func collapse(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

// hasLineBreak reports whether s contains any rune that ends a line. The list
// is every one Unicode defines, not just \n: U+0085, U+2028 and U+2029 break a
// line in a rendered console exactly as \n does.
func hasLineBreak(s string) bool {
	return strings.ContainsAny(s, "\n\r\v\f  ")
}

func hasAlnum(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// hasUnprintable rejects control, format, surrogate and private-use runes.
// unicode.IsPrint is not enough on its own: it accepts the ASCII space but
// rejects other space runes that collapse() has already removed, and it does
// not consider bidi format characters, which can reorder a rendered merchant
// name in an operator console.
func hasUnprintable(s string) bool {
	for _, r := range s {
		if r == ' ' {
			continue
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Co, r) ||
			unicode.Is(unicode.Cs, r) || !unicode.IsPrint(r) {
			return true
		}
	}
	return false
}

// isCategoryLabel mirrors dict_entries_category_is_a_bounded_label. Keeping the
// two in step is the same argument diag makes: the Go check is the guard, the
// CHECK constraint is the guarantee, because a guarantee that only holds when
// callers behave is not one.
func isCategoryLabel(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case i > 0 && (r == ' ' || r == '_' || r == '/' || r == '&' || r == '-'):
		default:
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// The submitter pseudonym
// ---------------------------------------------------------------------------

// submitterHMAC is the only representation of a user this package stores.
//
// Every field is length-prefixed before hashing. The plan wrote the input as
// `user_id || 0x00 || pattern`; length prefixing is the same idea done so that
// no two different field tuples can produce one byte string, which a separator
// only achieves while the separator is guaranteed absent from every field. It
// costs nothing and removes the need to rely on that guarantee.
//
// The category is part of the input as well as the pattern, so that one user's
// two competing votes for the same merchant ("noon -> shopping" and
// "noon -> dining") are not visibly the same person's.
func (d *Dict) submitterHMAC(userID uuid.UUID, pattern, category string) []byte {
	mac := hmac.New(sha256.New, d.HMACKey)
	write := func(b []byte) {
		var n [8]byte
		binary.BigEndian.PutUint64(n[:], uint64(len(b)))
		mac.Write(n[:])
		mac.Write(b)
	}
	write([]byte(pattern))
	write([]byte(category))
	id := userID
	write(id[:])
	return mac.Sum(nil)
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

// publishable is the predicate that decides whether an entry is served to
// clients. It is written once, here, and mirrored by the CHECK constraint
// dict_entries_publishable_rows_are_published; every query that means "a client
// can see this" interpolates it rather than restating it.
const publishable = `(approved IS TRUE AND (source = 'operator_seed' OR distinct_submitter_count >= 3))`

// upsertAndLock inserts the entry if it is new and locks its row either way.
//
// ON CONFLICT DO UPDATE, not DO NOTHING: under READ COMMITTED a DO NOTHING that
// loses the race returns no row AND takes no lock, so a following SELECT can
// find nothing at all while a concurrent transaction holds an uncommitted
// insert. The DO UPDATE path blocks on that transaction and then returns the
// row, which is what makes every Submit for one entry serialize behind one row
// lock — the property TestConcurrentSubmissionsCountEachUserExactlyOnce checks.
const upsertAndLock = `
INSERT INTO dict_entries (pattern, match_type, category, source)
VALUES ($1, $2, $3, 'crowd')
ON CONFLICT (pattern, category) DO UPDATE SET pattern = dict_entries.pattern
RETURNING source, distinct_submitter_count, approved, published_at IS NOT NULL`

// Submit records that userID confirmed pattern -> category.
//
// It stores an identifier ONLY while the count can still change the outcome.
// Once the entry has reached K, was seeded by the operator, or has published,
// the submission is accepted and nothing at all is written about who made it —
// storing a pseudonym that cannot affect any decision is pure disclosure with
// no purpose.
//
// When the count does reach K the identifiers that produced it are deleted in
// the same transaction, and the count survives as the frozen aggregate.
func (d *Dict) Submit(ctx context.Context, userID uuid.UUID, pattern, category string) error {
	if err := d.checkKey(); err != nil {
		return err
	}
	if userID == uuid.Nil {
		return fmt.Errorf("%w: submitter is the nil uuid", ErrInvalidEntry)
	}
	e, err := Canonicalize(Entry{Pattern: pattern, Category: category})
	if err != nil {
		return err
	}
	return d.tx(ctx, func(tx pgx.Tx) error {
		var (
			source    string
			count     int
			approved  *bool
			published bool
		)
		if err := tx.QueryRow(ctx, upsertAndLock, e.Pattern, e.Match, e.Category).
			Scan(&source, &count, &approved, &published); err != nil {
			return fmt.Errorf("dict: submit: %w", err)
		}
		// Nothing left for a count to decide: store no identifier.
		if published || source == SourceOperator || count >= K {
			return nil
		}
		mac := d.submitterHMAC(userID, e.Pattern, e.Category)
		if _, err := tx.Exec(ctx, `INSERT INTO dict_submissions (pattern, category, submitter_hmac)
		  VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, e.Pattern, e.Category, mac); err != nil {
			return fmt.Errorf("dict: submit: %w", err)
		}
		return d.recount(ctx, tx, e.Pattern, e.Category)
	})
}

// recount refreshes distinct_submitter_count from the surviving identifiers,
// promotes the entry if that made it publishable, and deletes the identifiers
// once the threshold is met.
//
// The version is bumped only when the count actually moved, so a duplicate
// submission is not an observable event.
func (d *Dict) recount(ctx context.Context, tx pgx.Tx, pattern, category string) error {
	var count int
	err := tx.QueryRow(ctx, `
	  UPDATE dict_entries e SET
	    distinct_submitter_count = c.n,
	    version = CASE WHEN c.n <> e.distinct_submitter_count
	                   THEN nextval('dict_entry_version_seq') ELSE e.version END,
	    published_at = CASE
	      WHEN e.published_at IS NOT NULL THEN e.published_at
	      WHEN e.approved IS TRUE AND (e.source = 'operator_seed' OR c.n >= $3) THEN $4
	      ELSE NULL END
	  FROM (SELECT count(*)::int AS n FROM dict_submissions WHERE pattern = $1 AND category = $2) c
	  WHERE e.pattern = $1 AND e.category = $2
	  RETURNING e.distinct_submitter_count`,
		pattern, category, K, d.now().UTC()).Scan(&count)
	if err != nil {
		return fmt.Errorf("dict: recount: %w", err)
	}
	if count >= K {
		// The threshold is met and can only be met harder. The identifiers
		// have no remaining job, so they stop existing — earlier than
		// publication, which may never come if a moderator rejects the entry.
		if _, err := tx.Exec(ctx,
			`DELETE FROM dict_submissions WHERE pattern = $1 AND category = $2`,
			pattern, category); err != nil {
			return fmt.Errorf("dict: forget submitters: %w", err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

// Moderate records the operator's decision on one entry. ADMIN ONLY: nothing on
// the user-facing API reaches it.
//
// approved=false is a rejection, and it is not the same as the NULL an
// unreviewed entry carries — an entry can be rejected, later re-approved, and
// the version bump on each transition is what lets a client retract and
// reinstate it.
func (d *Dict) Moderate(ctx context.Context, pattern, category string, approved bool, note string) error {
	if err := d.check(); err != nil {
		return err
	}
	e, err := Canonicalize(Entry{Pattern: pattern, Category: category})
	if err != nil {
		return err
	}
	if len(note) > maxNoteBytes {
		return fmt.Errorf("%w: moderator note exceeds %d bytes", ErrInvalidEntry, maxNoteBytes)
	}
	tag, err := d.Pool.Exec(ctx, `
	  UPDATE dict_entries SET
	    approved = $3,
	    moderator_note = $4,
	    version = nextval('dict_entry_version_seq'),
	    published_at = CASE
	      WHEN published_at IS NOT NULL THEN published_at
	      WHEN $3 AND (source = 'operator_seed' OR distinct_submitter_count >= $5) THEN $6
	      ELSE NULL END
	  WHERE pattern = $1 AND category = $2`,
		e.Pattern, e.Category, approved, nullText(note), K, d.now().UTC())
	if err != nil {
		return fmt.Errorf("dict: moderate: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ApproveOperatorSeed approves every unmoderated operator-seeded entry in one
// step, and returns how many it approved. ADMIN ONLY.
//
// It exists because `ledgerd seed-dictionary` imports a few hundred of the
// operator's own rules at once and moderating them one at a time is not a
// review, it is a formality performed several hundred times. It is deliberately
// scoped to source='operator_seed': it cannot approve anything that came from
// the crowd, so the poisoning gate is untouched by it.
func (d *Dict) ApproveOperatorSeed(ctx context.Context, note string) (int, error) {
	if err := d.check(); err != nil {
		return 0, err
	}
	if len(note) > maxNoteBytes {
		return 0, fmt.Errorf("%w: moderator note exceeds %d bytes", ErrInvalidEntry, maxNoteBytes)
	}
	tag, err := d.Pool.Exec(ctx, `
	  UPDATE dict_entries SET
	    approved = true,
	    moderator_note = $1,
	    version = nextval('dict_entry_version_seq'),
	    published_at = coalesce(published_at, $2)
	  WHERE source = 'operator_seed' AND approved IS NULL`,
		nullText(note), d.now().UTC())
	if err != nil {
		return 0, fmt.Errorf("dict: approve operator seed: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Published returns every entry that has passed BOTH gates, ordered.
func (d *Dict) Published(ctx context.Context) ([]Entry, error) {
	if err := d.check(); err != nil {
		return nil, err
	}
	rows, err := d.Pool.Query(ctx, `SELECT pattern, match_type, category FROM dict_entries
	  WHERE `+publishable+` ORDER BY pattern, category`)
	if err != nil {
		return nil, fmt.Errorf("dict: published: %w", err)
	}
	defer rows.Close()
	return scanEntries(rows)
}

// Since returns everything a client holding cursor `since` has not seen.
//
// The cursor it returns is the maximum version over rows THIS CLIENT CAN SEE,
// never the global sequence position: every suppressed submission bumps the
// sequence, so echoing it back would publish the rate at which users are
// submitting merchants nobody else has.
func (d *Dict) Since(ctx context.Context, since int64) (Delta, error) {
	if err := d.check(); err != nil {
		return Delta{}, err
	}
	if since < 0 {
		return Delta{}, fmt.Errorf("%w: since must not be negative", ErrInvalidEntry)
	}
	out := Delta{Version: since}

	rows, err := d.Pool.Query(ctx, `SELECT pattern, match_type, category, version
	  FROM dict_entries WHERE `+publishable+` AND version > $1 ORDER BY pattern, category`, since)
	if err != nil {
		return Delta{}, fmt.Errorf("dict: since: %w", err)
	}
	entries, maxVer, err := scanVersioned(rows)
	if err != nil {
		return Delta{}, err
	}
	out.Entries = entries
	out.Version = max64(out.Version, maxVer)

	// A retraction may name ONLY an entry that actually shipped once
	// (published_at is never cleared). Anything else would tell the client
	// about a pattern the k gate or the moderator kept from it.
	//
	// A client starting from scratch is sent none of them: it has nothing to
	// remove, and the list would be pure disclosure.
	if since > 0 {
		rows, err := d.Pool.Query(ctx, `SELECT pattern, match_type, category, version
		  FROM dict_entries WHERE published_at IS NOT NULL AND NOT `+publishable+`
		    AND version > $1 ORDER BY pattern, category`, since)
		if err != nil {
			return Delta{}, fmt.Errorf("dict: since: %w", err)
		}
		removed, maxVer, err := scanVersioned(rows)
		if err != nil {
			return Delta{}, err
		}
		out.Removed = removed
		out.Version = max64(out.Version, maxVer)
	}
	return out, nil
}

// List returns every entry with its moderation state. ADMIN ONLY: it names
// patterns the k gate is suppressing, which is exactly what a moderator has to
// see and exactly what a client must not.
func (d *Dict) List(ctx context.Context) ([]Status, error) {
	if err := d.check(); err != nil {
		return nil, err
	}
	// Published is the LIVE predicate, not published_at: it answers "are
	// clients being served this right now", which is the question a moderator
	// is actually asking. An entry that shipped once and was then retracted
	// has a published_at and answers no.
	rows, err := d.Pool.Query(ctx, `SELECT pattern, match_type, category, source,
	    distinct_submitter_count, approved, coalesce(moderator_note, ''), version,
	    `+publishable+`
	  FROM dict_entries ORDER BY approved IS NOT NULL, pattern, category`)
	if err != nil {
		return nil, fmt.Errorf("dict: list: %w", err)
	}
	defer rows.Close()
	var out []Status
	for rows.Next() {
		var s Status
		if err := rows.Scan(&s.Pattern, &s.Match, &s.Category, &s.Source,
			&s.DistinctSubmitters, &s.Approved, &s.Note, &s.Version,
			&s.Published); err != nil {
			return nil, fmt.Errorf("dict: list: %w", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dict: list: %w", err)
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

// SeedFromV1 imports the operator's own v1 categorization rules, marked
// source='operator_seed'.
//
// The seed bypasses the k gate and ONLY the k gate: entries arrive unmoderated
// (approved IS NULL) and publish nothing until the operator approves them, via
// [Dict.Moderate] or [Dict.ApproveOperatorSeed].
//
// It is idempotent, and re-running it must not undo a decision: an existing
// entry keeps its `approved`, its note and its published_at, and only gains the
// operator source. Any identifiers accumulated against it while it was a crowd
// entry are dropped, because a seeded entry no longer needs a count.
func (d *Dict) SeedFromV1(ctx context.Context, rules []Entry) error {
	if err := d.check(); err != nil {
		return err
	}
	seen := make(map[Entry]bool, len(rules))
	canon := make([]Entry, 0, len(rules))
	for i, r := range rules {
		e, err := Canonicalize(r)
		if err != nil {
			return fmt.Errorf("dict: seed rule %d: %w", i, err)
		}
		key := Entry{Pattern: e.Pattern, Category: e.Category}
		if seen[key] {
			continue
		}
		seen[key] = true
		canon = append(canon, e)
	}
	return d.tx(ctx, func(tx pgx.Tx) error {
		for _, e := range canon {
			if _, err := tx.Exec(ctx, `
			  INSERT INTO dict_entries (pattern, match_type, category, source)
			  VALUES ($1,$2,$3,'operator_seed')
			  ON CONFLICT (pattern, category) DO UPDATE SET
			    source = 'operator_seed',
			    match_type = EXCLUDED.match_type,
			    version = nextval('dict_entry_version_seq'),
			    published_at = CASE
			      WHEN dict_entries.published_at IS NOT NULL THEN dict_entries.published_at
			      WHEN dict_entries.approved IS TRUE THEN $4
			      ELSE NULL END`,
				e.Pattern, e.Match, e.Category, d.now().UTC()); err != nil {
				return fmt.Errorf("dict: seed: %w", err)
			}
			// The entry no longer needs a crowd count, so the identifiers it
			// collected while it did stop existing.
			if _, err := tx.Exec(ctx,
				`DELETE FROM dict_submissions WHERE pattern = $1 AND category = $2`,
				e.Pattern, e.Category); err != nil {
				return fmt.Errorf("dict: seed: %w", err)
			}
			if _, err := tx.Exec(ctx,
				`UPDATE dict_entries SET distinct_submitter_count = 0
				  WHERE pattern = $1 AND category = $2`, e.Pattern, e.Category); err != nil {
				return fmt.Errorf("dict: seed: %w", err)
			}
		}
		return nil
	})
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

// ForgetSubmitter removes every trace of one user from this package's tables
// and returns how many rows it deleted. It is Task 34's purge hook.
//
// There is no user id to delete by — that is the point of the design — so it
// recomputes the pseudonym for the purged user against every distinct entry
// that still holds identifiers and deletes the matches. That is one HMAC per
// entry with an unfrozen count, which is thousands at most and microseconds in
// total.
//
// A purge that silently misses a table is the exact failure mode Task 34's
// schema discovery exists to prevent, so this is not left implicit: entries
// whose count has already frozen at K hold no identifiers at all, which is why
// there is nothing there to miss.
func (d *Dict) ForgetSubmitter(ctx context.Context, userID uuid.UUID) (int, error) {
	if err := d.checkKey(); err != nil {
		return 0, err
	}
	if userID == uuid.Nil {
		return 0, fmt.Errorf("%w: submitter is the nil uuid", ErrInvalidEntry)
	}
	deleted := 0
	err := d.tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT DISTINCT pattern, category FROM dict_submissions ORDER BY pattern, category`)
		if err != nil {
			return fmt.Errorf("dict: forget: %w", err)
		}
		type key struct{ pattern, category string }
		var keys []key
		for rows.Next() {
			var k key
			if err := rows.Scan(&k.pattern, &k.category); err != nil {
				rows.Close()
				return fmt.Errorf("dict: forget: %w", err)
			}
			keys = append(keys, k)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("dict: forget: %w", err)
		}
		for _, k := range keys {
			tag, err := tx.Exec(ctx, `DELETE FROM dict_submissions
			  WHERE pattern = $1 AND category = $2 AND submitter_hmac = $3`,
				k.pattern, k.category, d.submitterHMAC(userID, k.pattern, k.category))
			if err != nil {
				return fmt.Errorf("dict: forget: %w", err)
			}
			if tag.RowsAffected() == 0 {
				continue
			}
			deleted += int(tag.RowsAffected())
			// The count has to follow the rows, or a purged user keeps voting
			// forever. recount cannot re-publish anything here: it only ever
			// lowers a count that had not reached K.
			if err := d.recount(ctx, tx, k.pattern, k.category); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return deleted, nil
}

// ExpireStaleSubmissions deletes identifiers older than maxAge and returns how
// many it removed. It is the only consumer of dict_submissions.created_at, and
// the only reason that column is worth storing: without it, an identifier for
// an entry that never reaches K lives forever.
func (d *Dict) ExpireStaleSubmissions(ctx context.Context, maxAge time.Duration) (int, error) {
	if err := d.check(); err != nil {
		return 0, err
	}
	if maxAge <= 0 {
		return 0, fmt.Errorf("%w: maxAge must be positive", ErrInvalidEntry)
	}
	cutoff := d.now().UTC().Add(-maxAge)
	deleted := 0
	err := d.tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `DELETE FROM dict_submissions WHERE created_at < $1
		  RETURNING pattern, category`, cutoff)
		if err != nil {
			return fmt.Errorf("dict: expire: %w", err)
		}
		type key struct{ pattern, category string }
		seen := map[key]bool{}
		for rows.Next() {
			var k key
			if err := rows.Scan(&k.pattern, &k.category); err != nil {
				rows.Close()
				return fmt.Errorf("dict: expire: %w", err)
			}
			deleted++
			seen[k] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("dict: expire: %w", err)
		}
		for k := range seen {
			if err := d.recount(ctx, tx, k.pattern, k.category); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return deleted, nil
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

func (d *Dict) tx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("dict: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("dict: commit: %w", err)
	}
	return nil
}

func scanEntries(rows pgx.Rows) ([]Entry, error) {
	var out []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.Pattern, &e.Match, &e.Category); err != nil {
			return nil, fmt.Errorf("dict: scan: %w", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dict: scan: %w", err)
	}
	return out, nil
}

func scanVersioned(rows pgx.Rows) ([]Entry, int64, error) {
	defer rows.Close()
	var out []Entry
	var maxVer int64
	for rows.Next() {
		var e Entry
		var v int64
		if err := rows.Scan(&e.Pattern, &e.Match, &e.Category, &v); err != nil {
			return nil, 0, fmt.Errorf("dict: scan: %w", err)
		}
		out = append(out, e)
		maxVer = max64(maxVer, v)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("dict: scan: %w", err)
	}
	return out, maxVer, nil
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func nullText(s string) any {
	if s == "" {
		return nil
	}
	return s
}
