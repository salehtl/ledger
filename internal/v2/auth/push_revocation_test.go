package auth

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/pgtest"
)

// The property every test in this file asserts, stated once: disowning a device
// stops its notifications.
//
// It did not, and the gap was not small. push_tokens carried no link to a
// writer or a session, Writers.Revoke and both Sessions revocations left it
// untouched, and the only removal path needed the exact Expo token string —
// which the user of a stolen, signed-out or handed-on phone does not have. So a
// device the user had explicitly disowned kept receiving a real-time "New
// transaction" on its lock screen for the life of the account. The payload
// carries nothing; the TIMING is a live feed of when that person spends.
//
// These run in auth rather than in pushv2 because auth owns the revocation
// transactions, and "the sweep committed with the revocation" is the part that
// cannot be checked from the other side.

// registerPushToken plants a row exactly as api.handleRegisterPushToken does.
func registerPushToken(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, writerID, sessionToken, token string) {
	t.Helper()
	if _, err := pool.Exec(bgctx,
		`INSERT INTO push_tokens (user_id, token, platform, writer_id, session_hash)
		 VALUES ($1,$2,'ios',$3,$4)`,
		u, token, writerID, SessionHash(sessionToken)); err != nil {
		t.Fatal(err)
	}
}

func pushTokenCount(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) int {
	t.Helper()
	return countRows(t, pool, `SELECT count(*) FROM push_tokens WHERE user_id = $1`, u)
}

// TestRevokingAWriterStopsThatDevicesNotifications is the stolen-phone case.
// The user signs in on a replacement and revokes the stolen device's key, which
// is the gesture the whole design offers for "that phone is not mine any more".
func TestRevokingAWriterStopsThatDevicesNotifications(t *testing.T) {
	pool := pgtest.New(t)
	c := newClock()
	w := newWriters(pool, c)
	sessions := newSessions(pool, time.Hour, c)
	u := mustUpsert(t, pool, appleIdentity("sub-push-revoke-writer"))

	stolen, replacement := newDevice(t, "stolen-phone"), newDevice(t, "replacement")
	mustEnroll(t, w, u, stolen, stolen)
	mustEnroll(t, w, u, stolen, replacement)

	sess, err := sessions.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	registerPushToken(t, pool, u, stolen.id, sess, "ExponentPushToken[stolen00000000000000]")
	registerPushToken(t, pool, u, replacement.id, sess, "ExponentPushToken[replacement000000000]")

	n := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, stolen.id, n, replacement.signRevocation(n, stolen.id)); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	if got := countRows(t, pool,
		`SELECT count(*) FROM push_tokens WHERE user_id = $1 AND writer_id = $2`, u, stolen.id); got != 0 {
		t.Fatalf("the revoked device still has %d push token(s): it keeps receiving every transaction", got)
	}
	// And only that device. Revocation is not sign-out-everywhere; a user who
	// retires one phone must not lose notifications on the one in their hand.
	if got := countRows(t, pool,
		`SELECT count(*) FROM push_tokens WHERE user_id = $1 AND writer_id = $2`, u, replacement.id); got != 1 {
		t.Fatalf("revoking one device removed the other's push token (%d left)", got)
	}
}

// TestRevokingAWriterLeavesOtherAccountsAlone. The sweep is scoped by user_id
// as well as writer_id, because a writer id is only unique WITHIN a user and
// two accounts naming their phone the same thing is ordinary.
func TestRevokingAWriterLeavesOtherAccountsAlone(t *testing.T) {
	pool := pgtest.New(t)
	c := newClock()
	w := newWriters(pool, c)
	sessions := newSessions(pool, time.Hour, c)

	a := mustUpsert(t, pool, appleIdentity("sub-push-revoke-a"))
	b := mustUpsert(t, pool, appleIdentity("sub-push-revoke-b"))
	const shared = "iphone"

	da, db := newDevice(t, shared), newDevice(t, shared)
	mustEnroll(t, w, a, da, da)
	mustEnroll(t, w, b, db, db)

	sa, err := sessions.Issue(bgctx, a)
	if err != nil {
		t.Fatal(err)
	}
	sb, err := sessions.Issue(bgctx, b)
	if err != nil {
		t.Fatal(err)
	}
	registerPushToken(t, pool, a, shared, sa, "ExponentPushToken[aaaa0000aaaa0000aaaa]")
	registerPushToken(t, pool, b, shared, sb, "ExponentPushToken[bbbb0000bbbb0000bbbb]")

	n := mustChallenge(t, w, a)
	if err := w.Revoke(bgctx, a, shared, n, da.signRevocation(n, shared)); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if got := pushTokenCount(t, pool, a); got != 0 {
		t.Fatalf("user a kept %d push token(s) after revoking their only device", got)
	}
	if got := pushTokenCount(t, pool, b); got != 1 {
		t.Fatalf("user a's revocation removed user b's push token (%d left)", got)
	}
}

// TestRevokingASessionStopsThatDevicesNotifications is the sign-out case, and
// it is NOT the same gesture as revoking a key: a user signing out of a phone
// they are handing on has not retired their device key, they have ended that
// phone's access. 00010's own comment claimed this case was "recoverable by the
// user"; it was not, and this is what makes it true.
func TestRevokingASessionStopsThatDevicesNotifications(t *testing.T) {
	pool := pgtest.New(t)
	c := newClock()
	w := newWriters(pool, c)
	sessions := newSessions(pool, time.Hour, c)
	u := mustUpsert(t, pool, appleIdentity("sub-push-revoke-session"))

	phone, tablet := newDevice(t, "phone"), newDevice(t, "tablet")
	mustEnroll(t, w, u, phone, phone)
	mustEnroll(t, w, u, phone, tablet)

	phoneSess, err := sessions.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	tabletSess, err := sessions.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	registerPushToken(t, pool, u, phone.id, phoneSess, "ExponentPushToken[phone000phone000phon]")
	registerPushToken(t, pool, u, tablet.id, tabletSess, "ExponentPushToken[tablet00tablet00tabl]")

	if err := sessions.Revoke(bgctx, phoneSess); err != nil {
		t.Fatal(err)
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM push_tokens WHERE user_id = $1 AND writer_id = $2`, u, phone.id); got != 0 {
		t.Fatalf("the signed-out device still has %d push token(s)", got)
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM push_tokens WHERE user_id = $1 AND writer_id = $2`, u, tablet.id); got != 1 {
		t.Fatalf("signing out one device stopped another's notifications (%d left)", got)
	}
	// Idempotent, and the sweep is not gated on the UPDATE having done work:
	// re-revoking must still clear anything that somehow survived, because the
	// failure being closed is "the user believes they stopped it and it did not
	// stop".
	if err := sessions.Revoke(bgctx, phoneSess); err != nil {
		t.Fatalf("re-revoking: %v", err)
	}
}

// TestSignOutEverywhereStopsEveryDevicesNotifications. "Everywhere" has to
// include the notifications, or the one primitive a user reaches for when they
// think they have been compromised leaves the compromised device with a live
// feed of their spending.
func TestSignOutEverywhereStopsEveryDevicesNotifications(t *testing.T) {
	pool := pgtest.New(t)
	c := newClock()
	w := newWriters(pool, c)
	sessions := newSessions(pool, time.Hour, c)

	a := mustUpsert(t, pool, appleIdentity("sub-push-revoke-all-a"))
	b := mustUpsert(t, pool, appleIdentity("sub-push-revoke-all-b"))

	for _, u := range []uuid.UUID{a, b} {
		d := newDevice(t, "only-device")
		mustEnroll(t, w, u, d, d)
		sess, err := sessions.Issue(bgctx, u)
		if err != nil {
			t.Fatal(err)
		}
		registerPushToken(t, pool, u, d.id, sess, "ExponentPushToken["+u.String()[:20]+"]")
	}

	if err := sessions.RevokeAllForUser(bgctx, a); err != nil {
		t.Fatal(err)
	}
	if got := pushTokenCount(t, pool, a); got != 0 {
		t.Fatalf("sign-out-everywhere left %d push token(s) receiving", got)
	}
	if got := pushTokenCount(t, pool, b); got != 1 {
		t.Fatalf("one user's sign-out-everywhere removed another user's push token (%d left)", got)
	}
}

// TestSessionHashIsTheStoredForm. The API stores the HASH of the bearer token
// against a push_tokens row, never the token, so a leaked row names a session
// without being usable as one — and Revoke can only find the row it should if
// both sides derive the same bytes.
func TestSessionHashIsTheStoredForm(t *testing.T) {
	const tok = "a-session-token"
	if got, want := SessionHash(tok), tokenHash(tok); string(got) != string(want) {
		t.Fatalf("SessionHash disagrees with the form Sessions persists")
	}
	if string(SessionHash(tok)) == tok {
		t.Fatal("SessionHash returned the token itself")
	}
}
