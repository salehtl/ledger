#!/usr/bin/env bash
# One-time cutover: move ledger's live database from dinosaur to kakapo.
# Run it from a machine that reaches both hosts over SSH as an admin (the Mac):
#
#   bash cutover-kakapo.sh
#
# Overrides: DINO (root@dinosaur), KAKAPO (saleh@kakapo), BRANCH (ledger),
# URL (https://kakapo.marmoset-paradise.ts.net),
# KAKAPO_GIT (git@github.com:salehtl/kakapo.git), ASSUME_YES=1 (no prompts).
#
# ledger is down from step 2 to step 5: a few minutes. If anything fails in
# that window, the script starts ledger on dinosaur again by itself.
# dinosaur's database is only ever read.
# Test: bash deploy/cutover-kakapo.test.sh
# Every remote command is built on this side on purpose.
# shellcheck disable=SC2029
set -euo pipefail

DINO=${DINO:-root@dinosaur}
KAKAPO=${KAKAPO:-saleh@kakapo}
BRANCH=${BRANCH:-ledger}
URL=${URL:-https://kakapo.marmoset-paradise.ts.net}
KAKAPO_GIT=${KAKAPO_GIT:-git@github.com:salehtl/kakapo.git}
PORT=8090
DATA=/var/lib/ledger
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SNAP=/var/backups/ledger-$STAMP-to-kakapo.db
ARMED=0

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*" >&2; exit 1; }
dino() { ssh -n "$DINO" "$1"; }
kak() { ssh -n "$KAKAPO" "$1"; }
ask() {
  [ "${ASSUME_YES:-0}" = 1 ] && return 0
  local a
  read -r -p "$1 [y/N] " a </dev/tty || return 1
  [ "$a" = y ] || [ "$a" = Y ]
}

rollback() {
  printf '\n\033[31mFailed while ledger was down. Starting it on dinosaur again.\033[0m\n' >&2
  kak "sudo systemctl stop ledger; for f in $DATA/ledger.db $DATA/ledger.db-wal $DATA/ledger.db-shm; do sudo test -e \$f && sudo mv \$f \$f.failed-$STAMP; done; true" || true
  if dino "systemctl start ledger && systemctl is-active ledger"; then
    printf 'ledger runs on dinosaur again; its database was never changed.\n' >&2
    printf 'kakapo: ledger stopped, its copy moved to %s/ledger.db*.failed-%s.\n' "$DATA" "$STAMP" >&2
  else
    printf '\033[31mledger did not start on dinosaur. Run there: systemctl start ledger\033[0m\n' >&2
  fi
}
on_exit() {
  local rc=$?
  if [ "$ARMED" = 1 ]; then
    ARMED=0
    rollback
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

say "0/7 Pre-flight"
dino "systemctl is-active --quiet ledger" || die "ledger is not running on dinosaur."
dino "command -v sqlite3 >/dev/null" || die "sqlite3 is missing on dinosaur."
kak "sudo true" || die "cannot run sudo on $KAKAPO."
[ "$(kak "sudo sh -c 'ls -d $DATA/ledger.db* 2>/dev/null | wc -l'")" = 0 ] ||
  die "kakapo already has $DATA/ledger.db*. Did a cutover run before? Move those files aside first."
[ -z "$(kak "ss -Hltn 'sport = :$PORT'")" ] || die "port $PORT is in use on kakapo."
serve=$(kak "sudo tailscale serve status 2>&1" || true)
case $serve in
  *"No serve config"* | *"127.0.0.1:$PORT"*) ;;
  *)
    printf '%s\n' "$serve"
    ask "kakapo already serves the above. Point https://kakapo.../ at ledger instead?" ||
      die "nothing changed."
    ;;
esac
echo "ok"

say "1/7 Activate branch '$BRANCH' on kakapo (nixos-rebuild test: not the boot default)"
ssh "$KAKAPO" "sudo nixos-rebuild test --flake 'github:salehtl/kakapo/$BRANCH#kakapo' --refresh" </dev/null
kak "id ledger >/dev/null && sudo test -d $DATA" || die "the ledger user or $DATA is missing after the rebuild."
want=$({
  echo LEDGER_IMAP_USERNAME
  dino "sed -n 's/^\(LEDGER_[A-Z0-9_]*\)=.*/\1/p' /etc/ledger/ledger.env"
} | sort | tr '\n' ' ')
got=$(kak "sudo sed -n 's/^\(LEDGER_[A-Z0-9_]*\)=.*/\1/p' /run/secrets/ledger/env" | sort | tr '\n' ' ')
[ "$want" = "$got" ] || die "secret names differ. dinosaur: $want/ kakapo: $got"
echo "secrets: $got"
if kak "systemctl is-active --quiet ledger"; then
  die "ledger already runs on kakapo without a database: requireDatabase did not hold."
fi
kak "systemctl is-active --quiet ledger-tailscale-serve" ||
  die "the tailscale serve unit failed. See: journalctl -u ledger-tailscale-serve"

say "2/7 Stop ledger on dinosaur. Downtime starts."
ARMED=1
dino "systemctl stop ledger"

say "3/7 Snapshot the database on dinosaur"
dino "umask 077; sqlite3 $DATA/ledger.db \".backup '$SNAP'\""
[ "$(dino "sqlite3 '$SNAP' 'PRAGMA integrity_check;'")" = ok ] || die "integrity check failed on $SNAP."
echo "$SNAP: integrity ok"

say "4/7 Copy it to kakapo"
dino "cat '$SNAP'" | ssh "$KAKAPO" "sudo install -o ledger -g ledger -m 0600 /dev/stdin $DATA/ledger.db"
a=$(dino "sha256sum '$SNAP'" | cut -d' ' -f1)
b=$(kak "sudo sha256sum $DATA/ledger.db" | cut -d' ' -f1)
[ -n "$a" ] && [ "$a" = "$b" ] || die "checksum mismatch: dinosaur $a, kakapo $b."
echo "sha256 $a on both ends"

say "5/7 Start ledger on kakapo"
kak "sudo systemctl start ledger"
kak "for i in \$(seq 30); do curl -fsS http://127.0.0.1:$PORT/api/health && exit 0; sleep 2; done; exit 1" ||
  die "ledger did not answer on kakapo. See: journalctl -u ledger"
echo
exe=$(kak "sudo readlink /proc/\$(systemctl show -p MainPID --value ledger)/exe")
unit=$(kak "systemctl show -p ExecStart --value ledger" | grep -o '/nix/store/[^ ;]*/bin/ledger' | head -n1)
[ -n "$exe" ] && [ "$exe" = "$unit" ] || die "the running binary ($exe) is not the unit's ($unit)."
echo "running $exe"
kak "sudo ls $DATA/backups" | grep -q '^before-' || die "no before-build copy in $DATA/backups."
ok=0
for _ in $(seq 30); do
  if curl -fsS "$URL/api/health"; then
    ok=1
    break
  fi
  sleep 2
done
[ "$ok" = 1 ] || die "$URL does not answer from this machine."
echo

# kakapo is live from here. A failure below must not roll back.
ARMED=0

say "6/7 Retire ledger on dinosaur"
dino "systemctl disable ledger && mkdir -p /etc/systemd/system/ledger.service.d && printf '[Unit]\n# ledger moved to kakapo at $STAMP. Remove this file and the marker to run it here again.\nConditionPathExists=!$DATA/MOVED-TO-KAKAPO\n' > /etc/systemd/system/ledger.service.d/moved-to-kakapo.conf && touch $DATA/MOVED-TO-KAKAPO && systemctl daemon-reload" ||
  die "kakapo is live, but dinosaur's unit is not retired. A reboot there would start a second ledger. Run on dinosaur: systemctl disable ledger"

say "7/7 Make it permanent on kakapo"
echo "kakapo runs branch '$BRANCH' with nixos-rebuild test. The 04:00 upgrade switches to master, which has no ledger yet."
if ask "Fast-forward kakapo master to '$BRANCH' and switch to it now?"; then
  tmp=$(mktemp -d)
  git -C "$tmp" init -q
  git -C "$tmp" fetch -q "$KAKAPO_GIT" "refs/heads/$BRANCH:refs/tmp/b" "refs/heads/master:refs/tmp/m"
  git -C "$tmp" merge-base --is-ancestor refs/tmp/m refs/tmp/b ||
    die "master moved since '$BRANCH' was cut. Merge it into master by hand before 04:00 Asia/Dubai."
  git -C "$tmp" push -q "$KAKAPO_GIT" "refs/tmp/b:refs/heads/master"
  rm -rf "$tmp"
  ssh "$KAKAPO" "sudo nixos-rebuild switch --flake github:salehtl/kakapo#kakapo --refresh" </dev/null
  kak "systemctl is-active --quiet ledger" || die "ledger stopped after the switch. See: journalctl -u ledger"
else
  echo "Not merged. Before 04:00 Asia/Dubai, merge '$BRANCH' into kakapo master, or ledger stops at the nightly upgrade."
fi

say "Done. ledger runs on kakapo: $URL"
cat <<EOF
On the phone:
  1. Delete the old ledger app (the dinosaur one) from the Home Screen.
  2. Open $URL in Safari. Share, then Add to Home Screen.
  3. In the new app: Settings, Notifications, Enable on this device, then Send test.
dinosaur keeps its last copy at $SNAP. Its $DATA is no longer used.
EOF
