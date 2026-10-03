#!/usr/bin/env bash
# Tests deploy/cutover-kakapo.sh against stub ssh/git/curl that play dinosaur
# and kakapo from files in a scratch directory. No host is contacted.
#   bash deploy/cutover-kakapo.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script=${CUTOVER_SCRIPT:-$here/cutover-kakapo.sh}
fail=0

make_stubs() {
  local bin=$1
  mkdir -p "$bin"
  cat > "$bin/ssh" <<'EOF'
#!/usr/bin/env bash
while [[ $1 == -* ]]; do shift; done
host=$1 cmd=$2 s=$STATE
printf '%s\t%s\n' "$host" "$cmd" >> "$s/log"
case $host in *dinosaur*) side=dino ;; *kakapo*) side=kak ;; *) exit 98 ;; esac
case "$side|$cmd" in
  "dino|systemctl is-active --quiet ledger") [ ! -e "$s/dino_stopped" ] ;;
  "dino|command -v sqlite3"*) true ;;
  "dino|systemctl stop ledger") touch "$s/dino_stopped" ;;
  "dino|systemctl start ledger"*) rm -f "$s/dino_stopped" ;;
  "dino|umask 077; sqlite3"*) printf 'DBBYTES' > "$s/snap" ;;
  "dino|sqlite3 "*"integrity_check"*) echo ok ;;
  "dino|cat "*) cat "$s/snap" ;;
  "dino|sha256sum "*) sha256sum "$s/snap" ;;
  "dino|sed -n "*) printf 'LEDGER_A\nLEDGER_B\n' ;;
  "dino|systemctl disable ledger"*) touch "$s/dino_retired" ;;
  "kak|sudo true") true ;;
  "kak|"*"ls -d "*) if [ -e "$s/kak_db" ]; then echo 1; else echo 0; fi ;;
  "kak|ss -Hltn"*) true ;;
  "kak|sudo tailscale serve status"*) echo "No serve config" ;;
  "kak|sudo nixos-rebuild "*) echo "$cmd" >> "$s/rebuilds" ;;
  "kak|id ledger"*) true ;;
  "kak|sudo sed -n "*) printf 'LEDGER_B\nLEDGER_IMAP_USERNAME\nLEDGER_A\n' ;;
  "kak|systemctl is-active --quiet ledger") [ -e "$s/kak_running" ] ;;
  "kak|systemctl is-active --quiet ledger-tailscale-serve") true ;;
  "kak|sudo install "*) cat > "$s/kak_db" ;;
  "kak|sudo sha256sum "*) sha256sum "$s/kak_db" ;;
  "kak|sudo systemctl start ledger") touch "$s/kak_running" ;;
  "kak|for i in "*) [ -z "${FAIL_HEALTH:-}" ] && echo '{"status":"ok","db":"ok"}' ;;
  "kak|sudo readlink "*) echo /nix/store/abc-ledger-1.0-x/bin/ledger ;;
  "kak|systemctl show -p ExecStart"*) echo '{ path=/nix/store/abc-ledger-1.0-x/bin/ledger ; argv[]=/nix/store/abc-ledger-1.0-x/bin/ledger -config /nix/store/c.toml ; }' ;;
  "kak|sudo ls "*) echo before-abc-ledger-1.0-x.db ;;
  "kak|sudo systemctl stop ledger; "*) rm -f "$s/kak_running"; if [ -e "$s/kak_db" ]; then mv "$s/kak_db" "$s/kak_db.failed"; fi ;;
  *) echo "stub ssh: unexpected command for $host: $cmd" >&2; exit 97 ;;
esac
EOF
  cat > "$bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git\t%s\n' "$*" >> "$STATE/log"
EOF
  cat > "$bin/curl" <<'EOF'
#!/usr/bin/env bash
echo '{"status":"ok","db":"ok"}'
EOF
  printf '#!/bin/sh\n' > "$bin/sleep"
  chmod +x "$bin"/*
}

# run <name> [VAR=value ...]: runs the script in a fresh state dir; sets $S and $rc.
# PRESEED=1 puts a database on the stub kakapo first.
run() {
  local name=$1; shift
  S=$(mktemp -d)
  make_stubs "$S/bin"
  case " $* " in *" PRESEED=1 "*) printf 'OLD' > "$S/kak_db" ;; esac
  set +e
  env "$@" PATH="$S/bin:$PATH" STATE="$S" ASSUME_YES=1 bash "$script" > "$S/out" 2>&1
  rc=$?
  set -e
  echo "--- $name (exit $rc)"
}

check() { # check <description> <test command...>
  local what=$1; shift
  if "$@"; then echo "ok    $what"; else echo "FAIL  $what"; fail=1; fi
}
not() { ! "$@"; }
moved_aside() { [ -e "$S/kak_db.failed" ] && [ ! -e "$S/kak_db" ]; }
in_log() { grep -qF -- "$1" "$S/log"; }
order() { # order <first> <second>: first appears in the log before second
  local a b
  a=$(grep -nF -- "$1" "$S/log" | head -n1 | cut -d: -f1)
  b=$(grep -nF -- "$2" "$S/log" | head -n1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}

run "happy path"
check "exits 0" [ "$rc" = 0 ]
check "the database reached kakapo byte for byte" [ "$(cat "$S/kak_db" 2>/dev/null)" = DBBYTES ]
check "dinosaur stops before the copy" order $'root@dinosaur\tsystemctl stop ledger' "sudo install"
check "kakapo starts after the copy" order "sudo install" $'saleh@kakapo\tsudo systemctl start ledger'
check "dinosaur stays stopped" [ -e "$S/dino_stopped" ]
check "dinosaur's unit is retired" [ -e "$S/dino_retired" ]
check "branch test first, master switch last" order "nixos-rebuild test --flake 'github:salehtl/kakapo/ledger#kakapo'" "nixos-rebuild switch --flake github:salehtl/kakapo#kakapo"
check "master is fast-forwarded from the branch" in_log "refs/tmp/b:refs/heads/master"
rm -rf "$S"

run "health fails on kakapo" FAIL_HEALTH=1
check "exits non-zero" [ "$rc" != 0 ]
check "ledger runs on dinosaur again" [ ! -e "$S/dino_stopped" ]
check "kakapo's copy is moved aside" moved_aside
check "kakapo's ledger is stopped" [ ! -e "$S/kak_running" ]
check "dinosaur's unit is not retired" [ ! -e "$S/dino_retired" ]
check "master is not touched" not in_log "refs/heads/master"
rm -rf "$S"

run "kakapo already has a database" PRESEED=1
check "exits non-zero" [ "$rc" != 0 ]
check "nothing stops on dinosaur" not in_log "systemctl stop ledger"
check "nothing is rebuilt on kakapo" [ ! -e "$S/rebuilds" ]
check "the existing file is untouched" [ "$(cat "$S/kak_db")" = OLD ]
rm -rf "$S"

if [ "$fail" = 0 ]; then echo "PASS"; else echo "FAILED"; exit 1; fi
