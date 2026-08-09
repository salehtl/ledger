#!/usr/bin/env bash
# v2stack.sh — the scratch v2 stack `recovery.mjs` needs, in one command.
#
# `stack.sh` next door builds the V1 stack: the single-user Go binary and a
# scratch SQLite file. This is the v2 one, and it is a different set of moving
# parts entirely — a throwaway Postgres cluster, `ledgerd`, and a vite dev
# server proxied at it — which is why `recovery.mjs` went unrun by its own code
# reviewer until this existed.
#
#   harness/v2stack.sh up      # cluster + database + ledgerd + vite, then print an invite
#   harness/v2stack.sh invite  # another single-use invite code
#   harness/v2stack.sh down    # stop everything and delete the cluster
#
# NEVER PRODUCTION. Ports 8123 (API) and 5177 (UI) — deliberately not 8080,
# not 8099 (v1's harness) and not 5199 (v1's harness) — against a throwaway
# cluster under /tmp. It touches neither /var/lib/ledger nor /etc/ledger-v2 nor
# the running `ledgerd` service.
#
# `localhost` and not `127.0.0.1` for the UI: WebAuthn needs a secure context,
# and `localhost` is one over plain HTTP while a bare IP is not.
#
# # Ports, the run directory and the database are all overridable
#
# Parallel sessions on this repo are normal, and the defaults are FIXED values —
# two agents running this script at once meant the second one's `--strictPort`
# vite died on the first one's port while its ledgerd wrote into the first one's
# run directory. Every collidable name is an env var with the old value as its
# default, so an unqualified `v2stack.sh up` behaves exactly as it did:
#
#   LEDGER_V2_HARNESS_DIR=/tmp/ledger-v2-ux \
#   LEDGER_V2_API_PORT=8133 LEDGER_V2_UI_PORT=5187 \
#   LEDGER_V2_SMTP_PORT=2536 LEDGER_V2_DB=ledger_v2_ux harness/v2stack.sh up
#
# The SMTP port is in the list because it is a listener like the others: the
# default 2526 is as collidable as 8123, and a second stack that failed to bind
# it would take the mail path — the only way past the verification step — down
# with it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="${LEDGER_V2_HARNESS_DIR:-/tmp/ledger-v2-harness}"
API_PORT="${LEDGER_V2_API_PORT:-8123}"
UI_PORT="${LEDGER_V2_UI_PORT:-5177}"
SMTP_PORT="${LEDGER_V2_SMTP_PORT:-2526}"
DB="${LEDGER_V2_DB:-ledger_v2_harness}"

api_dsn() { echo "postgres://postgres@/$DB?host=$(cat "$RUN/socket")&port=$(cat "$RUN/port")&sslmode=disable"; }

up() {
	down >/dev/null 2>&1 || true
	mkdir -p "$RUN"

	echo "==> booting a throwaway postgres cluster"
	# BootStandalone detaches the cluster from this shell (Setsid), which is what
	# lets ledgerd outlive this script. It prints the DSN and the stop script.
	(cd "$REPO" && go run ./internal/v2/pgtest/cmd/boot) > "$RUN/boot.env"
	# shellcheck disable=SC1090
	eval "$(cat "$RUN/boot.env")"
	echo "$PG_STOP" > "$RUN/pg_stop"
	# The DSN's socket directory and port, pulled apart so the harness database
	# can be addressed on the same cluster.
	sed -n 's/.*host=\([^&"]*\).*/\1/p' "$RUN/boot.env" | head -1 > "$RUN/socket"
	sed -n 's/.*port=\([0-9]*\).*/\1/p' "$RUN/boot.env" | head -1 > "$RUN/port"

	psql "$LEDGER_TEST_POSTGRES_URL" -qc "CREATE DATABASE $DB" >/dev/null

	echo "==> building ledgerd"
	(cd "$REPO" && go build -o "$RUN/ledgerd" ./cmd/ledgerd)

	cat > "$RUN/config.toml" <<-TOML
		[mail]
		domain      = "sirdab.ae"
		smtp_listen = "127.0.0.1:$SMTP_PORT"

		[server]
		http_listen = "127.0.0.1:$API_PORT"

		[auth]
		rp_id           = "localhost"
		rp_display_name = "Ledger harness"
		rp_origins      = ["http://localhost:$UI_PORT"]
	TOML

	echo "==> starting ledgerd on 127.0.0.1:$API_PORT"
	# `--dns-fixtures` serves the recorded TXT map as the DKIM/ARC resolver, so
	# the corpus's signed bank mail verifies offline. Without it every message a
	# harness sends is `unauthenticated`, the verification step never clears, and
	# NO SCRIPT CAN REACH THE PRODUCT AT ALL — which is why `v2settings.mjs` could
	# not exist before this line did. It is refused off loopback by `ledgerd`
	# itself, and this stack is loopback only.
	LEDGER_PG_DSN="$(api_dsn)" LEDGER_DATA_DIR="$RUN/data" \
		nohup "$RUN/ledgerd" serve -config "$RUN/config.toml" \
			--dns-fixtures "$REPO/internal/v2/origin/testdata/dns.json" > "$RUN/ledgerd.log" 2>&1 &
	echo $! > "$RUN/ledgerd.pid"
	wait_for "http://127.0.0.1:$API_PORT/api/v1/healthz" "ledgerd"

	echo "==> starting vite on 127.0.0.1:$UI_PORT"
	(cd "$REPO/web" && LEDGER_V2_API="http://127.0.0.1:$API_PORT" \
		nohup bunx vite --port "$UI_PORT" --strictPort --host 127.0.0.1 > "$RUN/vite.log" 2>&1 &
		echo $! > "$RUN/vite.pid")
	wait_for "http://localhost:$UI_PORT/" "vite"

	echo
	echo "stack up.  UI http://localhost:$UI_PORT   API http://127.0.0.1:$API_PORT"
	echo "run:  node harness/recovery.mjs $(invite)"
}

# A single-use invite. Minted through ledgerd itself rather than by an INSERT,
# so the code really is hashed the way a real one is.
invite() {
	LEDGER_PG_DSN="$(api_dsn)" LEDGER_DATA_DIR="$RUN/data" \
		"$RUN/ledgerd" mint-invite --note "harness" -config "$RUN/config.toml" 2>/dev/null | sed -n '1p'
}

down() {
	[[ -f "$RUN/vite.pid" ]] && kill "$(cat "$RUN/vite.pid")" 2>/dev/null || true
	[[ -f "$RUN/ledgerd.pid" ]] && kill "$(cat "$RUN/ledgerd.pid")" 2>/dev/null || true
	# The stop script deletes the cluster directory including itself, so it runs
	# exactly once and only if it is still there.
	[[ -f "$RUN/pg_stop" ]] && [[ -x "$(cat "$RUN/pg_stop")" ]] && "$(cat "$RUN/pg_stop")" 2>/dev/null || true
	rm -rf "$RUN"
	echo "stack down."
}

wait_for() {
	local url=$1 what=$2
	for _ in $(seq 1 60); do
		if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
		sleep 0.5
	done
	echo "$what did not come up; see $RUN/*.log" >&2
	exit 1
}

case "${1:-up}" in
	up) up ;;
	invite) invite ;;
	down) down ;;
	*) echo "usage: $0 [up|invite|down]" >&2; exit 2 ;;
esac
