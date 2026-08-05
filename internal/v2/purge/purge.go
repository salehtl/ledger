// Package purge deletes an account and everything that references it, and
// enforces Phase 1's plaintext-retention deadline by doing the same thing on a
// timer. Spec §3.10.
//
// # What "delete" means, in Phase 1 and after
//
// The spec describes deletion as "crypto-shredding plus purge": destroy the
// wrapped keys and the ciphertext is already gone, then remove the rows. Phase
// 1 has no crypto at all — every blob in op_log and quarantine is plaintext —
// so there is nothing to shred and the purge has to be the whole of it. That is
// stated rather than assumed, because the two failure modes are opposite: a
// Phase 3 purge that missed a table leaves ciphertext nobody can open, while a
// Phase 1 purge that misses one leaves the user's readable financial history in
// the database after they asked for it to be gone.
//
// PHASE 3 CHANGES, concretely: the wrapped-key rows arrive (there are none
// today), destroying them becomes the step that makes backups inert, and the
// row deletion below stays exactly as it is. Backups are NOT rewritten in
// either phase; they age out on their own schedule, and until they do, Phase
// 1's backups contain plaintext. The consent document says so, and
// EnforceRetention is what bounds how long that is true for a live account.
//
// # Why the relation list is discovered and not written down
//
// A purge is only as good as its least-remembered table. This package asks the
// database which relations carry a user_id, and iterates THAT — so a table
// added by a later task is covered the moment it exists, and one that cannot be
// covered automatically has to be classified by hand before any purge will run
// at all (see Classify). The alternative — a hand-written list — fails silently
// and stays wrong until someone notices rows for a deleted account, which is
// exactly the day it matters.
//
// It asks pg_class, NOT information_schema, and that distinction is worth three
// separate holes: information_schema does not list materialized views at all
// (spec §5 plans to create one over op_log), a `table_schema = 'public'` filter
// cannot see `archive.op_log_2026`, and information_schema is privilege-filtered
// so the non-owner runtime role plan D5 mandates would simply not be shown a
// relation it lacks rights on. Each of those was a relation that went unpurged
// AND unreported while Purge returned success. See relationFilter.
//
// A materialized view cannot be deleted from, so the purge REFRESHES it once
// the underlying rows are gone and then re-counts; a view that is still not
// empty, or that the role may not refresh, refuses the whole purge.
//
// Two tables cannot be discovered and are named explicitly:
//
//   - dict_submissions (Task 33) is keyed by a salted HMAC of the user id, so
//     there is no user_id column to find. [dict.Dict.ForgetSubmitter]
//     recomputes the pseudonym and deletes the matches.
//   - smtp_rejections (Task 23) is a per-day COUNT of protocol-level refusals
//     that never resolved a recipient. It is not user-linked and cannot be, so
//     there is nothing to delete — asserted deliberately, in notUserLinked and
//     in a test, rather than left as an omission that looks identical to an
//     oversight.
//
// # Ordering, and why it is not arbitrary
//
// The deletion itself is ONE statement: DELETE FROM users. Everything else
// follows through ON DELETE CASCADE, and that is load bearing rather than
// convenient:
//
//   - quarantine has a BEFORE DELETE trigger refusing any removal that no
//     quarantine_removals record accounts for, with account deletion as its one
//     documented exemption — detected by the users row already being gone.
//   - key_history has an append-only trigger with the same exemption, on the
//     same detection.
//
// Both exemptions are reachable only through the cascade, because only the
// cascade runs after the parent row is invisible to the transaction. A purge
// that issued its own DELETE against those tables first would be refused by the
// triggers, which is the correct answer to that question. The sweep below runs
// AFTER the cascade for the same reason.
//
// op_log is append-only by POLICY, not by constraint, and deleting a user's
// rows tears a permanent hole in the gap-free seq invariant. For a whole-account
// purge that is fine — the account is gone, and there is nobody left the
// invariant is a promise to. It is only fine because the purge is all-or-nothing:
// everything below runs in one transaction, and a purge that cannot complete
// rolls back rather than leaving a live user with a holed log.
package purge

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"slices"
	"time"

	"filippo.io/edwards25519"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/dict"
)

// handledWithoutUserID names the relations that hold per-user rows under some
// key OTHER than a user_id column, and that this package therefore has to purge
// by hand. Being on this list is a claim that Purge deals with it; a test
// asserts the claim for each entry.
//
// Names are SCHEMA-QUALIFIED, here and in notUserLinked. Unqualified names
// would classify `archive.users` as "the account table, handled" — a snapshot
// of every account, waved through by a list that was written about a different
// object with the same last name.
var handledWithoutUserID = []string{
	// Keyed by HMAC-SHA256(server key, pattern || category || user_id).
	// Purge calls dict.Dict.ForgetSubmitter.
	"public.dict_submissions",
	// The account table itself: keyed by `id`, so schema discovery does not see
	// it. It is deleted by name, and that one statement is what cascades
	// everything else.
	"public.users",
}

// notUserLinked names the relations that hold nothing attributable to one user,
// so a purge correctly touches none of them. Every entry is a decision, not an
// omission.
var notUserLinked = []string{
	// Per-day counts of protocol-level refusals that never resolved a
	// recipient. There is no user to scope a row to; a count is not a record
	// of a person. See 00006_diagnostics.sql.
	"public.smtp_rejections",
	// Operator-published parse templates. Not authored by users and shared by
	// all of them.
	"public.templates",
	// The publish/remove delta channel over public.templates, which devices
	// poll to learn what changed since their cursor. Every column describes an
	// OPERATOR action on a shared template — template id, version, action,
	// timestamp — and none of them names or derives from a user. It survives a
	// purge for the same reason public.templates does: deleting a row here
	// would not erase anything about the deleted account, it would tear a hole
	// in a monotonic sequence every OTHER device reads by. See
	// 00024_template_publication_log.sql.
	"public.template_publication_log",
	// The global merchant dictionary.
	//
	// The justification is NOT k-anonymity, and an earlier version of this
	// comment claimed it was. k gates PUBLICATION, not storage: an entry sits
	// in this table from its first submission with distinct_submitter_count = 1
	// and published_at NULL, so a single user's "dr aisha clinic jumeirah"
	// really is here, unpublished, and survives their deletion. What makes that
	// acceptable is the thing purge actually does — ForgetSubmitter destroys
	// the only link between the pattern and the person, leaving a merchant
	// string attributable to nobody. See the concern in the Task 34 fix report
	// about reaping (distinct_submitter_count = 0 AND published_at IS NULL),
	// which would remove even the unattributable residue.
	"public.dict_entries",
	// Per-bank demand counters from onboarding. A bank name and a count, never
	// linked to who asked. See 00012_waitlist.sql.
	"public.waitlist",
	// Single-use beta invite codes. A row is a code hash, a note in the
	// operator's words, and — once spent — a `redeemed_by` link to the account
	// that spent it.
	//
	// The link is the only user-attributable thing here and it is removed by
	// the schema itself: `redeemed_by uuid REFERENCES users(id) ON DELETE SET
	// NULL`. What survives the purge is "some code was spent, and nobody knows
	// by whom", which is the same unattributable residue dict_entries leaves
	// after ForgetSubmitter.
	//
	// The column is NOT called user_id on purpose. A user_id column here would
	// be discovered as user-scoped, and checkCascades would then correctly
	// refuse the whole purge because SET NULL is exactly the silent survival it
	// guards against — while CASCADE, the action it would demand instead, would
	// DELETE the row and put a spent code back into circulation. Neither
	// outcome is wanted, so the table is not user-scoped and says so here. See
	// 00020_invite_codes.sql.
	"public.invite_codes",
	// The deleted-account tombstone: SHA-256 of the session tokens that were
	// live when an account was deleted, so the devices holding them get a 410
	// instead of a 401 and can safely wipe. It is WRITTEN BY the deletion, so it
	// is the one table that must survive one, and it carries no user id, no
	// subject, no address and nothing derived from them — see
	// 00021_deleted_account_sessions.sql, which argues the privacy case in full.
	"public.deleted_account_sessions",
	// goose's own migration ledger.
	"public.goose_db_version",
}

// Report is what a purge did, per table. It is returned even on the paths that
// deleted nothing, so an operator can tell "no rows" from "never ran".
type Report struct {
	// Users are the accounts actually deleted. Empty when the user did not
	// exist, which is not an error: a purge is idempotent by design, and a
	// retry after a network failure must not look like a fresh disaster.
	Users []uuid.UUID

	// Rows maps table name to the number of rows removed for those users. Every
	// discovered user-scoped table appears, including the ones that held
	// nothing — a table silently absent from this map is indistinguishable from
	// a table silently skipped.
	Rows map[string]int

	// DictSubmissions counts the submitter pseudonyms forgotten. It is separate
	// because the table is not user-scoped in the schema and cannot be counted
	// the same way.
	DictSubmissions int

	// SweptWithoutCascade names tables whose rows survived the cascade and had
	// to be deleted explicitly. It is not decoration: an entry here means the
	// table's user_id foreign key is missing ON DELETE CASCADE, so every OTHER
	// path that deletes a user (a manual DELETE, a future task) leaves those
	// rows behind. The purge fixes its own case and reports the schema defect.
	SweptWithoutCascade []string

	// RefreshedViews names the materialized views the purge had to re-run
	// because they still listed the deleted account. A matview cannot be
	// deleted from, so this is the only way its copy of the user's rows goes
	// away — and an entry here means a stored copy of user data exists that
	// nothing else in the system knows about. Spec §5 contemplates one; it
	// should still be looked at.
	RefreshedViews []string

	// WithoutConsentRecord is populated by EnforceRetention only: accounts with
	// no consent row and therefore no recorded retention deadline. They are
	// NOT purged — see EnforceRetention.
	WithoutConsentRecord []uuid.UUID
}

func newReport() Report { return Report{Rows: map[string]int{}} }

// Total is every row this purge removed, across every table.
func (r Report) Total() int {
	n := r.DictSubmissions
	for _, v := range r.Rows {
		n += v
	}
	return n
}

// ErrIncomplete means the purge could not prove it removed everything, and
// therefore removed nothing. It is deliberately not recoverable by retrying the
// same call: the fix is a schema or configuration change.
//
// # Blast radius, stated because fail-closed has one
//
// The refusal is GLOBAL, not per-account. One unclassified relation — a DBA's
// `users_backup_20260801`, a matview somebody left behind — makes DELETE
// /api/v1/account answer 500 for EVERY user, and that endpoint is required by
// App Review 5.1.1(v). The reason is named only in the operator log; the
// response deliberately does not carry it.
//
// That is still the right direction (the alternative is reporting a deletion
// that did not happen), but it means a schema change nobody thought of as
// risky can break account deletion for everyone, silently from the outside.
// The operator-facing consequences:
//
//   - `ledgerd purge-user --dry-run` runs the same classification and is the
//     cheapest way to find out. Run it after any schema change.
//   - The fix is one line in handledWithoutUserID / notUserLinked, or a
//     user_id column with ON DELETE CASCADE. It is not an emergency to reason
//     about, but it IS an emergency to notice.
var ErrIncomplete = errors.New("purge: refused: cannot account for every relation")

// ---------------------------------------------------------------------------
// Schema discovery
// ---------------------------------------------------------------------------

// Relation is one object the purge has to account for: which schema it is in,
// what it is called, and what KIND of thing it is.
//
// It is a struct rather than a "schema.name" string because the two are used
// differently and mixing them up is a real bug: the display form goes into
// messages and report keys, while the SQL form has to be quoted as TWO
// identifiers. `pgx.Identifier{"archive.op_log"}.Sanitize()` produces
// `"archive.op_log"` — one identifier with a dot in its name, which does not
// exist — and the count that followed would silently fail rather than protect
// anything.
type Relation struct {
	Schema string
	Name   string
	// Kind is pg_class.relkind: 'r' ordinary table, 'p' partitioned table,
	// 'm' materialized view, 'f' foreign table.
	Kind byte
}

// String is the display form, and the key Report.Rows uses.
func (r Relation) String() string { return r.Schema + "." + r.Name }

// SQL is the correctly quoted two-part identifier.
func (r Relation) SQL() string { return pgx.Identifier{r.Schema, r.Name}.Sanitize() }

// KindName spells relkind for an error message; an operator reading "relkind m"
// learns nothing.
func (r Relation) KindName() string {
	switch r.Kind {
	case 'r':
		return "table"
	case 'p':
		return "partitioned table"
	case 'm':
		return "materialized view"
	case 'f':
		return "foreign table"
	default:
		return fmt.Sprintf("relkind %q", string(r.Kind))
	}
}

// relationFilter is the WHERE clause both discovery queries share, and every
// clause in it is load bearing. It replaced an information_schema query that
// was blind in three separate ways, each of which let a relation holding a
// deleted user's rows go unpurged AND unreported:
//
//   - information_schema.tables does not list MATERIALIZED VIEWS at all. Spec
//     §5 explicitly contemplates one ("the existing PWA may additionally serve
//     alphas via a temporary server-side materialized view"), so this is not a
//     hypothetical object: a matview over op_log holds a COPY of the user's
//     plaintext blobs, and the old query could not see it.
//   - it was scoped to `public`, so a table in any other schema — an
//     `archive.op_log_2026`, the obvious thing a DBA creates — was invisible.
//   - information_schema is PRIVILEGE-FILTERED: it shows only relations the
//     current role has some privilege on. Plan D5 runs ledgerd as a non-owner
//     `ledger_runtime`, and `ledgerd purge-user` opens the same DSN, so a
//     relation that role cannot touch was simply absent from a list whose whole
//     job is to be exhaustive. pg_class is not filtered; a relation the role
//     cannot read is now DISCOVERED, and the count against it fails loudly
//     instead of being skipped silently.
//
// 'i', 'S', 'v', 'c', 't' are excluded because none of them stores rows a purge
// could delete: indexes and sequences hold no user columns, a plain view is a
// query over relations already in this list, and composite/TOAST types are not
// relations a DELETE addresses. A partition (relispartition) is excluded too —
// it IS storage, but deleting from its parent covers it, and listing both would
// demand a classification for every partition anyone ever adds.
const relationFilter = `
	  cl.relkind IN ('r','p','m','f')
	  AND NOT cl.relispartition
	  AND ns.nspname NOT IN ('pg_catalog','information_schema')
	  AND ns.nspname !~ '^pg_'`

// UserScopedTables returns every relation carrying a user_id column, in any
// schema, sorted. This is the list Purge iterates.
//
// The name says "Tables" and the return says Relation: a materialized view with
// a user_id is exactly the case this function exists to stop being invisible,
// and pretending it is a table in the return type would reintroduce the blind
// spot at the type level.
func UserScopedTables(ctx context.Context, pool *pgxpool.Pool) ([]Relation, error) {
	if pool == nil {
		return nil, errors.New("purge: pool is nil")
	}
	return scanRelations(ctx, pool, `
		SELECT ns.nspname, cl.relname, cl.relkind::text
		  FROM pg_class cl
		  JOIN pg_namespace ns ON ns.oid = cl.relnamespace
		  JOIN pg_attribute a ON a.attrelid = cl.oid
		 WHERE`+relationFilter+`
		   AND a.attname = 'user_id'
		   AND a.attnum > 0
		   AND NOT a.attisdropped
		 ORDER BY ns.nspname, cl.relname`, "discover user-scoped relations")
}

// allRelations returns every relation a purge has to have an opinion about.
func allRelations(ctx context.Context, pool *pgxpool.Pool) ([]Relation, error) {
	return scanRelations(ctx, pool, `
		SELECT ns.nspname, cl.relname, cl.relkind::text
		  FROM pg_class cl
		  JOIN pg_namespace ns ON ns.oid = cl.relnamespace
		 WHERE`+relationFilter+`
		 ORDER BY ns.nspname, cl.relname`, "list relations")
}

func scanRelations(ctx context.Context, pool *pgxpool.Pool, sql, what string) ([]Relation, error) {
	rows, err := pool.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("purge: %s: %w", what, err)
	}
	defer rows.Close()
	var out []Relation
	for rows.Next() {
		var r Relation
		var kind string
		if err := rows.Scan(&r.Schema, &r.Name, &kind); err != nil {
			return nil, fmt.Errorf("purge: %s: %w", what, err)
		}
		if kind == "" {
			return nil, fmt.Errorf("purge: %s: %s.%s has an empty relkind", what, r.Schema, r.Name)
		}
		r.Kind = kind[0]
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("purge: %s: %w", what, err)
	}
	// A name is never validated against a pattern and never interpolated raw;
	// Relation.SQL quotes both parts, which is correct for every name Postgres
	// permits — including one with a quote or a dot in it. A regex screen here
	// would refuse legal names while adding nothing Sanitize does not already
	// guarantee.
	return out, nil
}

// Classification is every relation in the database, sorted into what a purge
// does with it.
type Classification struct {
	// UserScoped carry a user_id column and are emptied by the cascade (or,
	// for the kinds nothing cascades into, by the explicit sweep).
	UserScoped []Relation
	// HandledWithoutUserID are purged by a hand-written step.
	HandledWithoutUserID []string
	// NotUserLinked hold nothing attributable to one user.
	NotUserLinked []string
	// Unclassified is the failure case: a relation nobody has decided about.
	// Purge refuses while this is non-empty, because the only honest thing to
	// say about such a relation is that a deleted user's rows might survive
	// in it.
	Unclassified []string
}

// Classify sorts every relation in every non-system schema.
func Classify(ctx context.Context, pool *pgxpool.Pool) (Classification, error) {
	if pool == nil {
		return Classification{}, errors.New("purge: pool is nil")
	}
	scoped, err := UserScopedTables(ctx, pool)
	if err != nil {
		return Classification{}, err
	}
	all, err := allRelations(ctx, pool)
	if err != nil {
		return Classification{}, err
	}
	c := Classification{UserScoped: scoped}
	for _, r := range all {
		name := r.String()
		switch {
		case slices.ContainsFunc(scoped, func(s Relation) bool { return s.String() == name }):
		case slices.Contains(handledWithoutUserID, name):
			c.HandledWithoutUserID = append(c.HandledWithoutUserID, name)
		case slices.Contains(notUserLinked, name):
			c.NotUserLinked = append(c.NotUserLinked, name)
		default:
			// The kind is named because it changes what the operator has to do:
			// a stray TABLE gets a user_id or a line in notUserLinked, while a
			// materialized VIEW usually wants dropping.
			c.Unclassified = append(c.Unclassified, name+" ("+r.KindName()+")")
		}
	}
	return c, nil
}

// cascadeActions maps a user-scoped relation to EVERY ON DELETE action of its
// foreign keys into users, as pg_constraint spells them: 'c' cascade, 'a' no
// action, 'r' restrict, 'n' set null, 'd' set default. A relation with a
// user_id column and no foreign key at all is absent from the map.
//
// It is a slice per relation, not one action, because a relation may carry more
// than one foreign key naming a user_id column (a composite key, or a second
// column also called user_id in a later revision). Keeping only the last row
// the scan happened to see would let a SET NULL hide behind a CASCADE — a
// silent hole in a check that exists to close a silent hole.
//
// The schema is no longer pinned to `public`: a relation in any schema may
// reference public.users.
func cascadeActions(ctx context.Context, pool *pgxpool.Pool) (map[string][]byte, error) {
	rows, err := pool.Query(ctx, `
		-- confdeltype is Postgres's internal "char" type, which pgx will not
		-- scan into a string; the cast is not cosmetic.
		SELECT ns.nspname, cl.relname, con.confdeltype::text
		  FROM pg_constraint con
		  JOIN pg_class cl ON cl.oid = con.conrelid
		  JOIN pg_namespace ns ON ns.oid = cl.relnamespace
		 WHERE con.contype = 'f'
		   AND con.confrelid = 'public.users'::regclass
		   AND EXISTS (
		       SELECT 1 FROM pg_attribute a
		        WHERE a.attrelid = con.conrelid
		          AND a.attnum = ANY (con.conkey)
		          AND a.attname = 'user_id')`)
	if err != nil {
		return nil, fmt.Errorf("purge: read foreign-key actions: %w", err)
	}
	defer rows.Close()
	out := map[string][]byte{}
	for rows.Next() {
		var schema, name, action string
		if err := rows.Scan(&schema, &name, &action); err != nil {
			return nil, fmt.Errorf("purge: read foreign-key actions: %w", err)
		}
		if action != "" {
			key := schema + "." + name
			out[key] = append(out[key], action[0])
		}
	}
	return out, rows.Err()
}

// deleteActionNames is for the error message; an operator reading "confdeltype
// n" learns nothing.
var deleteActionNames = map[byte]string{
	'a': "NO ACTION", 'r': "RESTRICT", 'c': "CASCADE", 'n': "SET NULL", 'd': "SET DEFAULT",
}

// checkCascades refuses a purge whose schema cannot deliver one.
//
// Three shapes a later task can produce, and they fail differently:
//
//   - ON DELETE CASCADE — correct, and the only one accepted here.
//   - NO ACTION or RESTRICT — the DELETE FROM users errors with a foreign-key
//     violation. Loud, but mid-transaction and in the database's words rather
//     than ours, and it arrives AFTER the dictionary pseudonyms are already
//     forgotten. Caught here instead, before anything is touched.
//   - SET NULL or SET DEFAULT — the silent one, and the reason this check
//     exists at all. The rows SURVIVE with their user_id blanked, so every
//     count in this file goes to zero and the purge would report complete
//     success over a table that still holds the deleted user's data.
func checkCascades(ctx context.Context, pool *pgxpool.Pool, rels []Relation) error {
	actions, err := cascadeActions(ctx, pool)
	if err != nil {
		return err
	}
	for _, r := range rels {
		for _, a := range actions[r.String()] {
			// No foreign key at all leaves the loop body unentered; it is
			// handled by the explicit sweep, which reports it. Cascade is the
			// correct case.
			if a == 'c' {
				continue
			}
			name, known := deleteActionNames[a]
			if !known {
				name = fmt.Sprintf("confdeltype %q", string(a))
			}
			return fmt.Errorf("%w: %s.user_id references users ON DELETE %s, not CASCADE — "+
				"deleting the account would %s", ErrIncomplete, r, name,
				map[bool]string{true: "leave the rows behind with a blanked user_id",
					false: "be refused by the foreign key"}[a == 'n' || a == 'd'])
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// The purge
// ---------------------------------------------------------------------------

// Purge deletes one account and everything that references it.
//
// It is idempotent: purging a user that does not exist reports zero rows and no
// error, so a client that lost the response to a successful deletion can retry
// without being told something went wrong.
//
// It is all-or-nothing: every row deletion happens in one transaction, and any
// failure — including "a table exists that this package cannot account for" —
// rolls the whole thing back. A partial purge is worse than none: it leaves a
// live account whose op log has holes in its gap-free seq, which is a corruption
// the invariant checker will report forever, in exchange for deleting some of
// the data the user asked to have deleted.
//
// d may be nil, or may carry no HMAC key. Without one, the submitter pseudonyms
// in dict_submissions cannot be recomputed and therefore cannot be proven gone;
// the purge then proceeds only if that table is empty, and otherwise refuses
// while naming the missing secret. Silently skipping it would leave an
// identifier behind that outlives the account it belonged to.
func Purge(ctx context.Context, pool *pgxpool.Pool, d *dict.Dict, userID uuid.UUID) (Report, error) {
	if pool == nil {
		return Report{}, errors.New("purge: pool is nil")
	}
	if userID == uuid.Nil {
		return Report{}, errors.New("purge: user id is zero")
	}
	return purgeUsers(ctx, pool, d, []uuid.UUID{userID})
}

func purgeUsers(ctx context.Context, pool *pgxpool.Pool, d *dict.Dict, users []uuid.UUID) (Report, error) {
	rep := newReport()
	if len(users) == 0 {
		return rep, nil
	}

	// Before anything is deleted: does this package know about every relation?
	c, err := Classify(ctx, pool)
	if err != nil {
		return rep, err
	}
	if len(c.Unclassified) != 0 {
		return rep, fmt.Errorf("%w: unclassified relations %v — give them a user_id column, "+
			"or classify them in internal/v2/purge", ErrIncomplete, c.Unclassified)
	}

	// Second pre-flight, and still before anything is written: does every
	// discovered table's user_id foreign key actually CASCADE? A user_id column
	// is not the same as a column that goes away with its user, and the three
	// non-cascade shapes fail in three different ways — one of which is silent.
	// See cascadeActions.
	if err := checkCascades(ctx, pool, c.UserScoped); err != nil {
		return rep, err
	}

	// The dictionary is the FIRST thing deleted, and the ordering is the whole
	// argument.
	//
	// ForgetSubmitter runs in its own transaction (it recounts each entry it
	// touches), so it cannot join the one below. One of the two orders has to
	// be chosen and they fail differently: run it LAST and a failure leaves a
	// pseudonym for an account that no longer exists — the exact row that
	// outlives a purge. Run it FIRST and a failure leaves a live user who has
	// lost some dictionary votes, which is recoverable and costs them nothing
	// they can see. The second is the smaller wrong. Both pre-flights run above
	// it so that the common refusals cost nothing at all.
	for _, u := range users {
		n, err := forgetSubmitter(ctx, pool, d, u)
		if err != nil {
			return rep, err
		}
		rep.DictSubmissions += n
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return rep, fmt.Errorf("purge: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Counted BEFORE the delete, because after it there is nothing to count.
	for _, r := range c.UserScoped {
		n, err := countFor(ctx, tx, r, users)
		if err != nil {
			return rep, err
		}
		rep.Rows[r.String()] = n
	}

	// The one statement that matters. Everything else cascades from it, which
	// is what satisfies the quarantine and key_history triggers — see the
	// package comment.
	//
	// RETURNING, so the report names the accounts that were actually deleted
	// rather than the ones that were asked for. Purging a user that no longer
	// exists is not an error — a client retrying after a lost response must not
	// be told something went wrong — and reporting it as a deletion would make
	// the retry indistinguishable from a second disaster.
	deleted, err := scanUUIDRows(ctx, tx, `DELETE FROM users WHERE id = ANY($1) RETURNING id`, users)
	if err != nil {
		return rep, fmt.Errorf("purge: delete users: %w", err)
	}

	// The sweep: everything the cascade did not reach.
	//
	// Two shapes get here. A TABLE with a user_id and no foreign key at all —
	// nothing cascades into it, so its rows are still present and are deleted
	// explicitly, with the schema defect reported rather than quietly covered
	// for. And a MATERIALIZED VIEW, which cannot be deleted from at all: it is
	// a stored copy of a query, so the only way to make the deleted user's rows
	// go away is to re-run the query now that the underlying rows are gone.
	// Both are then re-counted; a relation that is still not empty refuses the
	// whole purge.
	for _, r := range c.UserScoped {
		n, err := countFor(ctx, tx, r, users)
		if err != nil {
			return rep, err
		}
		if n == 0 {
			continue
		}
		if r.Kind == 'm' {
			// REFRESH takes an ACCESS EXCLUSIVE lock and is refused to a
			// non-owner, so this is where a matview a later task created
			// without thinking becomes a loud failure instead of a copy of a
			// deleted user's plaintext. That is the right direction: spec §5
			// contemplates exactly one such view, and whoever creates it owns
			// the obligation to let the purge reach it.
			if _, err := tx.Exec(ctx, `REFRESH MATERIALIZED VIEW `+r.SQL()); err != nil {
				return rep, fmt.Errorf("%w: materialized view %s holds %d rows for the purged "+
					"accounts and could not be refreshed (%v) — a matview is a stored COPY, so "+
					"the rows survive the cascade; drop it, or grant the purge role ownership",
					ErrIncomplete, r, n, err)
			}
			rep.RefreshedViews = append(rep.RefreshedViews, r.String())
		} else if _, err := tx.Exec(ctx,
			`DELETE FROM `+r.SQL()+` WHERE user_id = ANY($1)`, users); err != nil {
			return rep, fmt.Errorf("purge: sweep %s: %w", r, err)
		} else {
			rep.SweptWithoutCascade = append(rep.SweptWithoutCascade, r.String())
		}
		left, err := countFor(ctx, tx, r, users)
		if err != nil {
			return rep, err
		}
		if left != 0 {
			return rep, fmt.Errorf("%w: %s %s still holds %d rows after an explicit %s",
				ErrIncomplete, r.KindName(), r, left,
				map[bool]string{true: "refresh", false: "delete"}[r.Kind == 'm'])
		}
	}

	// The proof, inside the transaction that would otherwise commit. Every
	// discovered relation, re-counted against the same rows that were just
	// deleted. It cannot pass by omission: the list is the discovered one.
	for _, r := range c.UserScoped {
		n, err := countFor(ctx, tx, r, users)
		if err != nil {
			return rep, err
		}
		if n != 0 {
			return rep, fmt.Errorf("%w: %s %s still holds %d rows for the purged accounts",
				ErrIncomplete, r.KindName(), r, n)
		}
	}
	var left int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = ANY($1)`, users).Scan(&left); err != nil {
		return rep, fmt.Errorf("purge: verify users: %w", err)
	}
	if left != 0 {
		return rep, fmt.Errorf("%w: %d of the accounts survived their own deletion", ErrIncomplete, left)
	}

	if err := tx.Commit(ctx); err != nil {
		return rep, fmt.Errorf("purge: commit: %w", err)
	}
	rep.Users = deleted
	return rep, nil
}

// scanUUIDRows runs a statement inside the purge transaction and collects the
// uuids it returns.
func scanUUIDRows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var u uuid.UUID
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func countFor(ctx context.Context, tx pgx.Tx, r Relation, users []uuid.UUID) (int, error) {
	var n int
	err := tx.QueryRow(ctx,
		`SELECT count(*) FROM `+r.SQL()+` WHERE user_id = ANY($1)`, users).Scan(&n)
	if err != nil {
		// A relation the role cannot read reaches here rather than being
		// filtered out of discovery, which is the point of reading pg_class
		// instead of information_schema: "I am not allowed to look" is an
		// answer this package has to give out loud.
		return 0, fmt.Errorf("purge: count %s: %w", r, err)
	}
	return n, nil
}

// forgetSubmitter removes the user's dictionary pseudonyms, or explains why it
// cannot. See Purge's doc comment for why a missing key is a refusal rather
// than a skip.
func forgetSubmitter(ctx context.Context, pool *pgxpool.Pool, d *dict.Dict, userID uuid.UUID) (int, error) {
	if d != nil && len(d.HMACKey) > 0 {
		n, err := d.ForgetSubmitter(ctx, userID)
		if err != nil {
			return 0, fmt.Errorf("purge: forget dictionary submitter: %w", err)
		}
		return n, nil
	}
	// GLOBAL, not per-user, and it cannot be otherwise: without the key there is
	// no way to ask "does this account have rows here" — that question IS the
	// HMAC. So the only sound check is "nobody has any", and the consequence,
	// stated rather than discovered: a deployment that LOST the key can delete
	// no account at all while a single submission from anyone remains. That is
	// fail-closed in the right direction (the alternative is a pseudonym
	// outliving the account it belongs to) but it is a real operational trap,
	// and the error names both ways out of it.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM dict_submissions`).Scan(&n); err != nil {
		return 0, fmt.Errorf("purge: count dict_submissions: %w", err)
	}
	if n != 0 {
		return 0, fmt.Errorf("%w: dict_submissions holds %d submitter identifiers and no "+
			"LEDGER_DICT_HMAC_KEY is configured, so none of them can be matched to this account "+
			"— note this count is GLOBAL, because without the key one account's rows are "+
			"indistinguishable from another's. Restore the key and retry; if it is lost for good, "+
			"every identifier in that table is already unrecoverable and clearing it (or waiting "+
			"for dict.ExpireStaleSubmissions) is the only way any account can be deleted again",
			ErrIncomplete, n)
	}
	return 0, nil
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// RecordConsent writes (or replaces) a user's signed-consent record: which
// document, when they signed it, and the instant their plaintext must be gone.
//
// One row per user by design — see 00014_account_deletion.sql. Re-consenting
// under a new document replaces the deadline rather than adding a second one.
func RecordConsent(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, document string, signedAt, retentionUntil time.Time) error {
	if pool == nil {
		return errors.New("purge: pool is nil")
	}
	if userID == uuid.Nil {
		return errors.New("purge: consent: user id is zero")
	}
	if !retentionUntil.After(signedAt) {
		return fmt.Errorf("purge: consent: retention deadline %s is not after the signature %s",
			retentionUntil.UTC(), signedAt.UTC())
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO user_consent (user_id, document, signed_at, retention_until)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE
		   SET document = EXCLUDED.document,
		       signed_at = EXCLUDED.signed_at,
		       retention_until = EXCLUDED.retention_until`,
		userID, document, signedAt, retentionUntil)
	if err != nil {
		return fmt.Errorf("purge: record consent for %s: %w", userID, err)
	}
	return nil
}

// DueForRetention lists the accounts whose retention deadline is at or before
// cutoff. It is exported so an operator can SEE the list before acting on it —
// `ledgerd purge-user --retention-due --dry-run` is the same query the real
// sweep runs, which is what makes the preview trustworthy.
func DueForRetention(ctx context.Context, pool *pgxpool.Pool, cutoff time.Time) ([]uuid.UUID, error) {
	if pool == nil {
		return nil, errors.New("purge: pool is nil")
	}
	due, err := scanUUIDs(ctx, pool,
		`SELECT user_id FROM user_consent WHERE retention_until <= $1 ORDER BY user_id`, cutoff)
	if err != nil {
		return nil, fmt.Errorf("purge: scan retention deadlines: %w", err)
	}
	return due, nil
}

// EnforceRetention purges every account whose consent record's retention
// deadline is at or before cutoff. It is Phase 1's plaintext-retention
// commitment (spec §5) made operational: the alpha consent document promises
// the data is gone by a date, and this is what makes the promise true without
// depending on anyone remembering.
//
// Accounts with NO consent record are reported (Report.WithoutConsentRecord)
// and NOT purged. There are two ways to read a missing row — "this user never
// agreed to anything, so their data should not be here" and "the row failed to
// write" — and only one of them survives being wrong. A sweep that deleted on a
// missing row would convert any bug in the consent-recording path into the
// destruction of every account it touched; a sweep that reports it costs the
// operator a look at a list.
//
// Each account is purged in its own transaction. One user whose purge fails
// must not prevent every other overdue account from being deleted, and the
// error is returned once the sweep has done everything it can — loudly, with
// the report of what DID happen attached.
func EnforceRetention(ctx context.Context, pool *pgxpool.Pool, d *dict.Dict, cutoff time.Time) (Report, error) {
	rep := newReport()
	if pool == nil {
		return rep, errors.New("purge: pool is nil")
	}

	due, err := DueForRetention(ctx, pool, cutoff)
	if err != nil {
		return rep, err
	}
	rep.WithoutConsentRecord, err = scanUUIDs(ctx, pool, `
		SELECT u.id FROM users u
		  LEFT JOIN user_consent c ON c.user_id = u.id
		 WHERE c.user_id IS NULL
		 ORDER BY u.id`)
	if err != nil {
		return rep, fmt.Errorf("purge: scan accounts with no consent record: %w", err)
	}

	var failures []error
	for _, u := range due {
		one, err := purgeUsers(ctx, pool, d, []uuid.UUID{u})
		rep.Users = append(rep.Users, one.Users...)
		rep.DictSubmissions += one.DictSubmissions
		for tb, n := range one.Rows {
			rep.Rows[tb] += n
		}
		for _, tb := range one.SweptWithoutCascade {
			if !slices.Contains(rep.SweptWithoutCascade, tb) {
				rep.SweptWithoutCascade = append(rep.SweptWithoutCascade, tb)
			}
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("user %s: %w", u, err))
		}
	}
	if len(failures) > 0 {
		return rep, fmt.Errorf("purge: retention sweep purged %d of %d overdue accounts: %w",
			len(rep.Users), len(due), errors.Join(failures...))
	}
	return rep, nil
}

func scanUUIDs(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) ([]uuid.UUID, error) {
	rows, err := pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var u uuid.UUID
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// The deletion challenge: spec §3.4's key-possession factor
// ---------------------------------------------------------------------------

const (
	// ChallengeNonceBytes is the nonce width, pinned by a CHECK constraint.
	ChallengeNonceBytes = 32
	// ChallengeTTL is how long a deletion nonce is worth anything. Short: the
	// client obtains one and signs it in the same user gesture.
	ChallengeTTL = 5 * time.Minute
	// challengeRetention is how long past expiry a spent nonce is kept before
	// the opportunistic sweep removes it. What refuses a replay is used_at on
	// the row, not the row's absence, so this only bounds table size.
	challengeRetention = 24 * time.Hour

	// deletionDomain separates this signature from every other one a device key
	// makes. auth.RegistrationMessage and addresses.RotationMessage carry their
	// own prefixes for the same reason: a signature captured from one flow must
	// be worthless in another, and this is the flow where being wrong is
	// unrecoverable.
	deletionDomain = "ledger/v2 account-delete\x00"
)

// ErrDeletionRejected is every authorization failure this package produces:
// unknown nonce, spent nonce, expired nonce, a nonce belonging to another
// account, a signature from an unenrolled or revoked key. They are one error on
// purpose — the HTTP layer answers all of them identically, and a caller that
// could tell them apart would learn whether a nonce exists and which factor it
// still needs.
var ErrDeletionRejected = errors.New("purge: deletion not authorized")

// DeletionMessage is what a device key signs to authorize deleting an account:
// a domain prefix, the nonce, and the account id.
//
// The encoding is unambiguous by construction: the prefix is fixed, the nonce
// is always ChallengeNonceBytes (checked before this is ever called), and the
// user id is a 36-character UUID string. Nothing here has a variable-length
// tail that could be re-split.
func DeletionMessage(nonce []byte, userID uuid.UUID) []byte {
	msg := make([]byte, 0, len(deletionDomain)+len(nonce)+1+36)
	msg = append(msg, deletionDomain...)
	msg = append(msg, nonce...)
	msg = append(msg, 0x00)
	msg = append(msg, userID.String()...)
	return msg
}

// Challenges mints and spends the single-use nonces that authorize a deletion.
type Challenges struct {
	Pool *pgxpool.Pool
	// Now defaults to time.Now. One clock decides both minting and expiry, so
	// the boundary is testable.
	Now func() time.Time
}

func (c *Challenges) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Issue mints a nonce. Obtaining one is exactly what a session token
// authorizes and nothing more: the nonce is worthless without a signature from
// an enrolled device key, and worthless again once spent.
func (c *Challenges) Issue(ctx context.Context, userID uuid.UUID) ([]byte, error) {
	if c.Pool == nil {
		return nil, errors.New("purge: challenges: pool is nil")
	}
	if userID == uuid.Nil {
		return nil, errors.New("purge: challenges: user id is zero")
	}
	nonce := make([]byte, ChallengeNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("purge: challenge: read random: %w", err)
	}
	now := c.now()
	if _, err := c.Pool.Exec(ctx,
		`INSERT INTO account_deletion_challenges (nonce, user_id, issued_at, expires_at)
		 VALUES ($1,$2,$3,$4)`, nonce, userID, now, now.Add(ChallengeTTL)); err != nil {
		return nil, fmt.Errorf("purge: challenge for user %s: %w", userID, err)
	}
	// Opportunistic, and a failure here is a housekeeping miss rather than a
	// security event.
	_, _ = c.Pool.Exec(ctx,
		`DELETE FROM account_deletion_challenges WHERE expires_at < $1`, now.Add(-challengeRetention))
	return nonce, nil
}

// Authorize spends a nonce and verifies the signature over
// DeletionMessage(nonce, userID) under one of the account's enrolled, live
// device keys.
//
// The nonce is spent by the ATTEMPT, not by the success, and before the
// signature is looked at: otherwise one challenge would buy unlimited signature
// guesses.
//
// There is no bootstrap path, by the same argument addresses.RotateAuthorized
// makes: an account with no live device key cannot delete itself through this
// endpoint. That is a locked door rather than a bug — the alternative is that a
// stolen session token destroys a life's financial history — and the operator
// path (ledgerd purge-user) exists for the user who has genuinely lost every
// device.
func (c *Challenges) Authorize(ctx context.Context, userID uuid.UUID, nonce, sig []byte) error {
	if c.Pool == nil {
		return errors.New("purge: challenges: pool is nil")
	}
	switch {
	case userID == uuid.Nil:
		return fmt.Errorf("%w: user id is zero", ErrDeletionRejected)
	case len(nonce) != ChallengeNonceBytes:
		return fmt.Errorf("%w: nonce is %d bytes, want %d", ErrDeletionRejected, len(nonce), ChallengeNonceBytes)
	case len(sig) != ed25519.SignatureSize:
		return fmt.Errorf("%w: signature is %d bytes, want %d", ErrDeletionRejected, len(sig), ed25519.SignatureSize)
	}
	if err := c.consume(ctx, userID, nonce); err != nil {
		return err
	}
	keys, err := liveDeviceKeys(ctx, c.Pool, userID)
	if err != nil {
		return err
	}
	if !verifiedByAny(keys, DeletionMessage(nonce, userID), sig) {
		return fmt.Errorf("%w: no enrolled device key verifies this signature", ErrDeletionRejected)
	}
	return nil
}

// consume spends a challenge atomically and exactly once. Same single UPDATE as
// auth.Writers.consumeChallenge and addresses.consumeChallenge: a test-and-set
// on one row identified by primary key, so two concurrent attempts on the same
// nonce serialize on that row's lock and the loser matches nothing.
func (c *Challenges) consume(ctx context.Context, userID uuid.UUID, nonce []byte) error {
	var expires time.Time
	err := c.Pool.QueryRow(ctx,
		`UPDATE account_deletion_challenges SET used_at = $3
		  WHERE nonce = $1 AND user_id = $2 AND used_at IS NULL
		 RETURNING expires_at`, nonce, userID, c.now()).Scan(&expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: no unspent challenge for this account matches that nonce", ErrDeletionRejected)
	}
	if err != nil {
		return fmt.Errorf("purge: consume deletion challenge: %w", err)
	}
	// Expiry in Go against the injected clock, so an expired challenge is still
	// CONSUMED rather than left on the table for unlimited retries.
	if !c.now().Before(expires) {
		return fmt.Errorf("%w: challenge expired", ErrDeletionRejected)
	}
	return nil
}

// liveDeviceKeys returns the keys that may authorize a deletion today: enrolled
// device writers that have not been revoked. A revoked device must not be able
// to delete the account, or revocation would mean nothing.
func liveDeviceKeys(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID) ([]ed25519.PublicKey, error) {
	roster, err := (&auth.Writers{Pool: pool}).Roster(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("purge: read writer roster for user %s: %w", userID, err)
	}
	var keys []ed25519.PublicKey
	for _, w := range roster {
		if w.Kind == auth.KindDevice && w.Live() && w.PubKey != nil {
			keys = append(keys, w.PubKey)
		}
	}
	return keys, nil
}

// usableKey rejects a public key under which a valid signature would prove
// possession of nothing.
//
// A length check is not enough. The Ed25519 identity point and the other
// small-order points are valid encodings under which crypto/ed25519 accepts a
// fixed 64-byte forgery for EVERY message — nobody needs a private key to write
// those bytes down. A writer enrolled with one would be a writer whose account
// any session holder could delete.
//
// auth.checkPublicKey screens keys at enrollment, so a roster key reaching here
// has already passed this. It is repeated for the same reason
// addresses.usableKey repeats it: those helpers are unexported, and a key read
// back OUT of the roster — planted by a repair script, or enrolled before that
// screen existed — must not authorize anything either. The three copies cannot
// drift into disagreement because the test is a fixed mathematical fact rather
// than a policy: multiply by the cofactor, reject the identity.
func usableKey(pub ed25519.PublicKey) bool {
	if len(pub) != ed25519.PublicKeySize {
		return false
	}
	p, err := new(edwards25519.Point).SetBytes(pub)
	if err != nil {
		return false
	}
	return new(edwards25519.Point).MultByCofactor(p).Equal(edwards25519.NewIdentityPoint()) != 1
}

func verifiedByAny(keys []ed25519.PublicKey, msg, sig []byte) bool {
	for _, k := range keys {
		if usableKey(k) && ed25519.Verify(k, msg, sig) {
			return true
		}
	}
	return false
}
