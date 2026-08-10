package pushv2

import (
	"context"
	"crypto/rand"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/pgtest"
)

// The fixtures every test in this package builds on. They lived in push_test.go
// until the Expo notifier was removed on 2026-08-10; TestMain in particular is
// package-wide, so leaving it in a file that was about to be deleted would have
// taken the throwaway-cluster boot with it and every test here would have run
// against no database.
func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

func newUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	u, err := auth.UpsertUser(bg, pool, auth.Identity{IdP: auth.IdPApple, Subject: "sub-" + uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// newDeviceRow creates the writer and the session a push subscription has to
// name. A subscription that names neither is what made a stolen phone's
// notifications unstoppable, so the schema no longer admits one and neither
// does this helper.
func newDeviceRow(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) (writerID string, sessionHash []byte) {
	t.Helper()
	writerID = "dev-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	pub := make([]byte, 32)
	if _, err := rand.Read(pub); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bg,
		`INSERT INTO writers (user_id, writer_id, kind, pubkey, registered_at)
		 VALUES ($1,$2,'device',$3,now())`, u, writerID, pub); err != nil {
		t.Fatal(err)
	}
	tok, err := (&auth.Sessions{Pool: pool, TTL: time.Hour}).Issue(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	return writerID, auth.SessionHash(tok)
}
