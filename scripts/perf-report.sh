#!/usr/bin/env bash
# perf-report.sh — what a phone actually downloads to load the app.
#
# Usage: scripts/perf-report.sh [BASE_URL]
#   Static sections read internal/web/dist directly (no server needed).
#   With BASE_URL (e.g. http://127.0.0.1:8099) it also measures on-the-wire
#   transfer sizes with and without gzip.
set -euo pipefail
cd "$(dirname "$0")/.."
DIST=internal/web/dist

secs_at_1mbit() { awk -v b="$1" 'BEGIN { printf "%.1f", b * 8 / 1000000 }'; }

echo "== Critical path (index.html references) =="
total=0
for f in index.html $(grep -oE '/assets/[^"]+\.(js|css)' "$DIST/index.html" | sed 's|^/||') registerSW.js sw.js; do
  size=$(stat -c%s "$DIST/$f")
  printf "%10d  %s\n" "$size" "$f"
  total=$((total + size))
done
printf "%10d  TOTAL uncompressed (~%ss at 1 Mbit/s)\n" "$total" "$(secs_at_1mbit "$total")"

echo
echo "== Service-worker precache manifest =="
total=0
count=0
while read -r url; do
  f="${url%%\?*}"
  [ -f "$DIST/$f" ] || continue
  size=$(stat -c%s "$DIST/$f")
  printf "%10d  %s\n" "$size" "$f"
  total=$((total + size)); count=$((count + 1))
done < <(grep -oE 'url:"[^"]*"' "$DIST/sw.js" | cut -d'"' -f2 | sort)
printf "%10d  TOTAL precache: %d files (~%ss at 1 Mbit/s)\n" "$total" "$count" "$(secs_at_1mbit "$total")"

if [ $# -ge 1 ]; then
  BASE="$1"
  echo
  echo "== On-the-wire transfer ($BASE) =="
  printf "%10s %10s  %s\n" "identity" "gzip" "path"
  paths=(/ $(grep -oE '/assets/[^"]+\.(js|css)' "$DIST/index.html") /api/summary /api/transactions)
  for p in "${paths[@]}"; do
    id=$(curl -so /dev/null -H 'Accept-Encoding: identity' -w '%{size_download}' "$BASE$p")
    gz=$(curl -so /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download}' "$BASE$p")
    printf "%10d %10d  %s\n" "$id" "$gz" "$p"
  done
fi
