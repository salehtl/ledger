#!/usr/bin/env bash
# Runs the app end-to-end so a browser can drive it.
#
#   harness/stack.sh up       # build binary if needed, seed scratch DB, start API + vite
#   harness/stack.sh reset    # wipe the DB and re-seed (restores known-good fixture state)
#   harness/stack.sh prod     # build frontend + binary, serve the embedded bundle (release check)
#   harness/stack.sh status
#   harness/stack.sh down
#
# Everything lives in a scratch directory — this NEVER touches the real
# /var/lib/ledger database or binds the production port 8080.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${LEDGER_HARNESS_DIR:-/tmp/ledger-ui-harness}"
API_PORT="${LEDGER_HARNESS_API_PORT:-8099}"
UI_PORT="${LEDGER_HARNESS_UI_PORT:-5199}"
API="http://127.0.0.1:${API_PORT}"
UI="http://127.0.0.1:${UI_PORT}"

mkdir -p "$STATE/db" "$STATE/log"
BIN="$STATE/ledger"
API_PID="$STATE/api.pid"
UI_PID="$STATE/ui.pid"

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Whoever is listening on a port, pidfile or not. A stale pidfile used to let a
# previous server survive `reset`: the DB directory got deleted while that
# process still held the file open, so SQLite kept writing to the unlinked
# inode and the "fresh" seed landed on top of the old data.
port_pids() { ss -lptnH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u; }

kill_port() {
  local pids; pids=$(port_pids "$1")
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  for _ in 1 2 3 4 5 6; do
    sleep 0.5
    [ -z "$(port_pids "$1")" ] && return 0
  done
  # shellcheck disable=SC2086
  kill -9 $(port_pids "$1") 2>/dev/null
  sleep 0.5
}

stop_one() { # pidfile, port
  if alive "$1"; then kill "$(cat "$1")" 2>/dev/null; sleep 0.5; kill -9 "$(cat "$1")" 2>/dev/null; fi
  rm -f "$1"
  [ -n "${2:-}" ] && kill_port "$2"
  return 0
}

write_config() {
  cat > "$STATE/config.toml" <<EOF
[server]
listen = "127.0.0.1:${API_PORT}"
data_dir = "${STATE}/db"
EOF
}

build_bin() {
  echo "building ledger binary..."
  ( cd "$REPO" && CGO_ENABLED=0 go build -o "$BIN" ./cmd/ledger ) || { echo "go build FAILED"; exit 1; }
}

wait_for() { # url, seconds
  local url="$1" secs="${2:-30}" i=0
  while [ $i -lt "$((secs * 2))" ]; do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5; i=$((i + 1))
  done
  return 1
}

start_api() {
  write_config
  [ -x "$BIN" ] || build_bin
  stop_one "$API_PID" "$API_PORT"
  ( cd "$STATE" && LEDGER_AI_API_KEY= nohup "$BIN" -config "$STATE/config.toml" > "$STATE/log/api.log" 2>&1 & echo $! > "$API_PID" )
  wait_for "$API/api/health" 25 || { echo "API failed to start:"; tail -20 "$STATE/log/api.log"; exit 1; }
  echo "API   $API"
}

seed() {
  ( cd "$REPO/frontend" && node harness/seed.mjs "$API" ) || { echo "seed FAILED"; exit 1; }
}

start_ui() {
  stop_one "$UI_PID" "$UI_PORT"
  ( cd "$REPO/frontend" && LEDGER_API="$API" nohup bunx vite --port "$UI_PORT" --strictPort --host 127.0.0.1 \
      > "$STATE/log/ui.log" 2>&1 & echo $! > "$UI_PID" )
  wait_for "$UI" 45 || { echo "vite failed to start:"; tail -20 "$STATE/log/ui.log"; exit 1; }
  echo "UI    $UI"
}

case "${1:-up}" in
  up)
    start_api
    # Seed only an empty database, so `up` is safe to re-run mid-session.
    if [ "$(curl -s "$API/api/transactions?limit=1" | head -c 4)" = "[]" ] || [ ! -s "$STATE/db/ledger.db" ]; then
      seed
    fi
    start_ui
    echo "ready — point the harness at $UI"
    ;;
  reset)
    stop_one "$API_PID" "$API_PORT"
    rm -rf "$STATE/db"; mkdir -p "$STATE/db"
    start_api
    seed
    alive "$UI_PID" || start_ui
    echo "reset — fixture data restored"
    ;;
  rebuild)
    build_bin
    stop_one "$API_PID" "$API_PORT"
    start_api
    ;;
  prod)
    # Release check: real production bundle served by the binary's embed.FS.
    ( cd "$REPO/frontend" && bun run build ) || { echo "frontend build FAILED"; exit 1; }
    build_bin
    stop_one "$UI_PID" "$UI_PORT"
    start_api
    echo "prod bundle served at $API"
    ;;
  down)
    stop_one "$API_PID" "$API_PORT"; stop_one "$UI_PID" "$UI_PORT"
    echo "stopped"
    ;;
  status)
    alive "$API_PID" && echo "API  up   $API" || echo "API  down"
    alive "$UI_PID"  && echo "UI   up   $UI"  || echo "UI   down"
    ;;
  logs)
    tail -n "${2:-40}" "$STATE/log/api.log" "$STATE/log/ui.log"
    ;;
  *)
    echo "usage: stack.sh {up|reset|rebuild|prod|down|status|logs}"; exit 2
    ;;
esac
