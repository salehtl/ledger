# Archived plans

Implementation plans whose work has shipped to `main`. Kept as historical records
of how each milestone/feature was built — not active work. New plans go in the
parent `plans/` directory; move them here once their work is merged.

| Plan | Shipped as |
|------|-----------|
| `2026-06-07-milestone-1-skeleton-deploy-loop.md` | M1 — Go skeleton, `/api/health`, systemd + Tailscale deploy |
| `2026-06-14-milestone-2-imap-ingest.md` | M2 — read-only IMAP ingest worker (`internal/ingest`) |
| `2026-06-14-milestone-3-parse-cascade.md` | M3 — template→heuristic→AI parse cascade (`internal/parse`) |
| `2026-06-14-milestone-4-categorizer.md` | M4 — rules-first categorizer + AI fallback (`internal/categorize`) |
| `2026-06-14-milestone-6-historical-import.md` | M6 — CSV/XLSX `ledger import` (`internal/importer`) |
| `2026-06-14-milestone-7-pwa.md` | M7 — React/Vite PWA embedded via `embed.FS` |
| `2026-06-14-milestone-8-hardening-monitoring.md` | M8 — drift monitor, SSE, self-transfer detection, web push |
| `2026-06-14-pwa-ux-overhaul.md` | Early PWA UX pass (superseded by the spending-first overhaul) |
| `2026-06-15-ui-overhaul-spending-first.md` | Spending-first UI rebuild (dropped xp.css → Tailwind + Recharts) |
| `2026-06-15-categorization-toggle.md` | Global + per-rule categorization toggles, AI opt-in |
| `2026-06-15-swipe-categorizer.md` | Swipe-deck review categorizer |
| `2026-06-16-prune-legacy-code.md` | Legacy-code prune & codebase-health pass |

Note: M3's cascade is implemented; real-bank-email sample validation is tracked
separately (see project memory), not in the plan.
