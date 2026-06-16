# Prune Legacy Code & Codebase Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the small set of dead/superseded code, duplication, stale dependency metadata, and unused dependencies found in the `ledger` codebase, leaving behavior identical and the full test suite green.

**Architecture:** This is a **behavior-preserving** cleanup, not a feature. Discovery (`go vet`, `staticcheck`, `deadcode`, `go mod tidy`, frontend dep/export scans) was already run; the codebase is healthy and the prunable surface is small and enumerated below. The safety contract for every task: the existing test suite (`go test ./...` + `cd frontend && bun run test`) must stay green before and after. There is no new feature behavior to TDD — the existing suite is the regression net.

**Tech Stack:** Go 1.25 (stdlib + modernc sqlite), React 18 + TypeScript + Vite (bun), single embedded binary.

**Scope (agreed during brainstorming):** dead/superseded code, duplication, repo hygiene, merge cruft — across both Go and frontend. Risk posture: behavior-preserving only.

---

## Findings inventory (what gets pruned)

| Task | Item | Evidence |
|------|------|----------|
| 1 | `NewProcessorWithCategorizer` constructor + static `categorizer` field | Used only by `processor_test.go`; production uses `NewProcessor` + `SetCategorizerProvider`. `deadcode` flags the constructor as unreachable from `main`. |
| 2 | Categorizer-construction duplication in `cmd/ledger/main.go` | The provider closure (L105–133) and the recategorize closure (L144–170) build a `categorize.Categorizer` from settings near-identically (~30 dup lines). |
| 3 | `go.mod` indirect/direct drift | `go mod tidy` promotes `webpush-go` and `excelize/v2` (both directly imported) out of the `// indirect` block. |
| 4 | Unused frontend deps `@tanstack/react-router`, `@tanstack/react-table` | Declared in `frontend/package.json` but zero imports anywhere in `frontend/src`, `vite.config.ts`, or `index.html`. |
| 5 | Repo hygiene: stray `.claire/` worktree dir untracked; `CLAUDE.md` untracked | `git status` shows `.claire/worktrees/pwa-ux-overhaul/...` and `CLAUDE.md` untracked; `.gitignore` covers neither. |

**Out of scope / deliberately not touched:** frontend source (all exports + module imports verified live; no TODO/FIXME/legacy markers in either stack); the 4 untracked `docs/superpowers/plans/2026-06-14*.md` and `2026-06-15-swipe-categorizer.md` files (may belong to parallel sessions — see Notes).

---

## Setup (orchestrator, before Task 1)

Parallel agents run on `main` (see memory). Do all work on a dedicated branch.

- [ ] **Confirm clean baseline and branch**

```bash
cd /root/Coding/ledger
git stash list            # ensure nothing unexpected
go build ./... && go vet ./...      # expect: no output (clean)
go test ./... 2>&1 | tail -5        # expect: all ok
git checkout -b chore/prune-legacy-2026-06-16
```

Expected: build/vet clean, tests pass, now on branch `chore/prune-legacy-2026-06-16`.

---

### Task 1: Remove superseded `NewProcessorWithCategorizer` constructor and static categorizer field

The production path installs a categorizer via `SetCategorizerProvider`. The static `categorizer` field and its constructor exist only to serve one test. Migrate the test to the provider, then delete the dead surface.

**Files:**
- Modify: `internal/parse/processor.go` (struct field, `NewProcessorWithCategorizer`, `resolveCategorizer`)
- Modify: `internal/parse/processor_test.go:136`

- [ ] **Step 1: Migrate the test off the dead constructor**

In `internal/parse/processor_test.go`, replace the single line:

```go
	p := NewProcessorWithCategorizer(st, dibCascade(), cat)
```

with:

```go
	p := NewProcessor(st, dibCascade())
	p.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) {
		return cat, true
	})
```

(`cat` and `context` are already in scope in this test; the provider returning `(cat, true)` reproduces the old static behavior exactly.)

- [ ] **Step 2: Run the test to confirm it still passes via the provider path**

Run: `go test ./internal/parse/ -run TestProcessor -v 2>&1 | tail -20`
Expected: PASS (transaction categorized `confirmed`, category = shoppingID).

- [ ] **Step 3: Delete the dead constructor**

In `internal/parse/processor.go`, remove the whole block:

```go
// NewProcessorWithCategorizer builds a Processor that also categorizes each
// extracted transaction and auto-confirms rule hits.
func NewProcessorWithCategorizer(st *store.Store, c *Cascade, cat *categorize.Categorizer) *Processor {
	return &Processor{store: st, cascade: c, categorizer: cat}
}
```

- [ ] **Step 4: Remove the now-unused static field**

In the `Processor` struct in `internal/parse/processor.go`, delete the line:

```go
	categorizer *categorize.Categorizer
```

- [ ] **Step 5: Simplify `resolveCategorizer` (the static branch is now unreachable)**

Replace:

```go
func (p *Processor) resolveCategorizer(ctx context.Context) (*categorize.Categorizer, bool) {
	if p.provider != nil {
		return p.provider(ctx)
	}
	if p.categorizer != nil {
		return p.categorizer, true
	}
	return nil, false
}
```

with:

```go
func (p *Processor) resolveCategorizer(ctx context.Context) (*categorize.Categorizer, bool) {
	if p.provider != nil {
		return p.provider(ctx)
	}
	return nil, false
}
```

- [ ] **Step 6: Verify build, dead-code, and full suite**

Run:
```bash
go build ./... && go vet ./...
go run golang.org/x/tools/cmd/deadcode@latest ./... ; echo "deadcode-exit=$?"
go test ./... 2>&1 | tail -5
```
Expected: build/vet clean; `deadcode` prints nothing (the previously-reported `NewProcessorWithCategorizer` is gone); all tests pass.

- [ ] **Step 7: Commit**

```bash
git add internal/parse/processor.go internal/parse/processor_test.go
git commit -m "refactor(parse): drop superseded NewProcessorWithCategorizer in favor of provider

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: De-duplicate categorizer construction in `cmd/ledger/main.go`

Two closures build a `categorize.Categorizer` from app settings the same way. Extract one package-level helper and call it from both.

**Files:**
- Modify: `cmd/ledger/main.go` (add helper func; replace bodies of the provider closure and recategorize closure)

- [ ] **Step 1: Add the shared helper**

Add this function to `cmd/ledger/main.go` (package `main`), e.g. directly above `func main()`:

```go
// buildCategorizer reads live app settings and returns a categorizer plus
// whether auto-categorization is enabled. It returns (nil, false) when settings
// can't be read, auto_categorize is off, or rules can't be read — callers skip
// categorization in that case. cats is the static category list; aiCat is the
// AI categorizer used only when settings.AIEnabled.
func buildCategorizer(st *store.Store, cats []categorize.Category, aiCat categorize.AICategorizer) (*categorize.Categorizer, bool) {
	settings, err := st.SelectAppSettings()
	if err != nil {
		log.Printf("categorizer: settings read failed, skipping categorization: %v", err)
		return nil, false
	}
	if !settings.AutoCategorize {
		return nil, false
	}
	ruleRows, err := st.SelectActiveRules()
	if err != nil {
		log.Printf("categorizer: active rules read failed: %v", err)
		return nil, false
	}
	rules := make([]categorize.Rule, 0, len(ruleRows))
	for _, r := range ruleRows {
		rules = append(rules, categorize.Rule{
			MatchType: r.MatchType, Pattern: r.Pattern, CategoryID: r.CategoryID, Priority: r.Priority,
		})
	}
	ai := categorize.AICategorizer(categorize.DisabledAI{})
	threshold := math.MaxFloat64 // AI suggests but never auto-confirms
	if settings.AIEnabled {
		ai = aiCat
		if settings.AIAutoAccept {
			threshold = settings.AIThreshold
		}
	}
	return categorize.New(rules, cats, ai, threshold, settings.AIAutoAccept), true
}
```

- [ ] **Step 2: Replace the provider closure body**

In `main()`, replace the entire `processor.SetCategorizerProvider(func(...) {...})` call (currently ~L105–134) with:

```go
	processor.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) {
		return buildCategorizer(st, domainCats, aiCat)
	})
```

- [ ] **Step 3: Replace the recategorize closure's construction block**

In the `srv.SetRecategorizeFn(func(...) {...})` call, replace the settings-read + rules-build + `cat := categorize.New(...)` prefix (currently ~L145–170) so the closure begins:

```go
	srv.SetRecategorizeFn(func(ctx context.Context, merchantRaw string) (int64, string, bool) {
		cat, ok := buildCategorizer(st, domainCats, aiCat)
		if !ok {
			return 0, "", false
		}
		result, ok := cat.Categorize(ctx, merchantRaw)
		if !ok {
			return 0, "", false
		}
		status := "needs_review"
		if result.AboveThreshold {
			status = "confirmed"
		}
		if result.ProposedRule != nil {
			_ = st.InsertRule(store.RuleRow{
				MatchType:  result.ProposedRule.MatchType,
				Pattern:    result.ProposedRule.Pattern,
				CategoryID: result.ProposedRule.CategoryID,
				Priority:   result.ProposedRule.Priority,
				Source:     "ai_confirmed",
			})
		}
		return result.CategoryID, status, true
	})
```

Keep the rest of the closure (the `InsertRule` / `result` handling shown above) intact.

- [ ] **Step 4: Verify imports still used**

`math` is still referenced (inside `buildCategorizer`). Confirm no now-unused imports:

Run: `go build ./... && go vet ./...`
Expected: no output. (If `goimports`/vet complains about an unused import, remove only the flagged one.)

- [ ] **Step 5: Run the full suite (server recategorize + processor categorization cover this glue)**

Run: `go test ./... 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add cmd/ledger/main.go
git commit -m "refactor(main): extract buildCategorizer helper to remove duplication

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Correct module dependency metadata with `go mod tidy`

`webpush-go` and `excelize/v2` are imported directly but recorded as `// indirect`. Tidy fixes this; no code changes.

**Files:**
- Modify: `go.mod`, `go.sum`

- [ ] **Step 1: Run tidy**

Run:
```bash
cd /root/Coding/ledger
go mod tidy
git diff --stat go.mod go.sum
```
Expected: `webpush-go` and `excelize/v2` move into the direct `require` block; minor `go.sum` adjustment. No other deps added.

- [ ] **Step 2: Verify build + tests after tidy**

Run: `go build ./... && go test ./... 2>&1 | tail -5`
Expected: build clean, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore: go mod tidy (mark webpush-go, excelize as direct deps)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Remove unused frontend dependencies

`@tanstack/react-router` and `@tanstack/react-table` are declared but never imported (the app uses `app/nav.ts` + `BottomNav` and custom transaction rows instead).

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/bun.lock` (regenerated by `bun install`)

- [ ] **Step 1: Re-confirm zero references (guard before deleting)**

Run:
```bash
cd /root/Coding/ledger/frontend
grep -rn "react-router\|react-table" src index.html vite.config.ts ; echo "grep-exit=$?"
```
Expected: no matches (`grep-exit=1`). If anything matches, STOP and do not remove that dep.

- [ ] **Step 2: Remove the two dependency lines from `frontend/package.json`**

Delete these lines from the `"dependencies"` object:

```json
    "@tanstack/react-router": "^1.45.0",
    "@tanstack/react-table": "^8.19.0",
```

Leave `@tanstack/react-query` (used in 17 files) untouched.

- [ ] **Step 3: Reinstall to update the lockfile**

Run: `cd /root/Coding/ledger/frontend && bun install`
Expected: lockfile updated, the two packages dropped, no errors.

- [ ] **Step 4: Verify the frontend still builds and tests pass**

Run:
```bash
cd /root/Coding/ledger/frontend
bun run build 2>&1 | tail -10
bun run test 2>&1 | tail -15
```
Expected: `tsc -b && vite build` succeeds (no missing-module errors), vitest all green.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/package.json frontend/bun.lock
git commit -m "chore(frontend): drop unused @tanstack/react-router and react-table deps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> Note: `vite build` writes into `internal/web/dist/` (committed). Whether to commit the rebuilt dist is handled in Task 6, not here — do not `git add internal/web/dist` in this task.

---

### Task 5: Repo hygiene — ignore `.claire/`, track `CLAUDE.md`

**Files:**
- Modify: `.gitignore`
- Add: `CLAUDE.md` (already exists in the working tree, untracked)

- [ ] **Step 1: Add `.claire/` to `.gitignore`**

Append under the build-artifacts section of `.gitignore`:

```
# Agent worktree scratch space (never commit)
.claire/
```

Do NOT `rm -rf .claire/` — a parallel session may be using that worktree. Ignoring it is sufficient.

- [ ] **Step 2: Stage and commit gitignore + the project guide**

```bash
cd /root/Coding/ledger
git add .gitignore CLAUDE.md
git status --short      # confirm .claire/ no longer listed as untracked
git commit -m "chore: ignore .claire worktree dir; track CLAUDE.md

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Expected: `.claire/` disappears from `git status`; `CLAUDE.md` committed.

---

### Task 6: Final verification, dist rebuild, branch finish

Per project memory: re-check `main` and rebuild the combined dist before finishing a branch.

**Files:** none (verification + possible dist commit)

- [ ] **Step 1: Full green-suite verification**

Run:
```bash
cd /root/Coding/ledger
go build ./... && go vet ./...
go test ./... 2>&1 | tail -5
cd frontend && bun run test 2>&1 | tail -5 && cd ..
```
Expected: everything clean and green.

- [ ] **Step 2: Rebuild the embedded frontend bundle and check for drift**

Run:
```bash
cd /root/Coding/ledger/frontend && bun run build && cd ..
git status --short internal/web/dist
```
If `internal/web/dist` shows changes, the embedded bundle drifted — stage and commit it:
```bash
git add internal/web/dist
git commit -m "build: rebuild embedded dist after dependency pruning

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
If there are no changes, skip the commit (dependency removal alone shouldn't change built output).

- [ ] **Step 3: Confirm the static binary builds clean**

Run: `CGO_ENABLED=0 go build -o /tmp/ledger ./cmd/ledger && echo "BINARY OK" && rm /tmp/ledger`
Expected: `BINARY OK`.

- [ ] **Step 4: Hand off to finishing-a-development-branch**

Invoke the `superpowers:finishing-a-development-branch` skill to choose merge/PR/cleanup for `chore/prune-legacy-2026-06-16`. Before merging, re-check `main` for new commits from parallel sessions (rebase if needed) since this branch touches `go.mod`, `main.go`, and `package.json`.

---

## Notes / deferred

- The 4 untracked plan docs in `git status` (`2026-06-14-milestone-4/6/8-*.md`, `2026-06-15-swipe-categorizer.md`) are left untouched — they may be in-flight from parallel sessions. The executor may commit them separately if confirmed to belong to this project, but that is outside this pruning plan.
- The codebase passed `go vet`, `staticcheck` (zero findings), and a frontend export/import scan cleanly. No further dead code was found; resist the urge to "find more" by deleting code the analyzers consider live.

## Self-review

- **Spec coverage:** All five inventory items map to Tasks 1–5; Task 6 enforces the verification + dist contract from brainstorming. Scope categories (dead code → T1; duplication → T2; dependency hygiene → T3/T4; repo hygiene → T5) all covered.
- **Placeholder scan:** No TBD/TODO; every code step shows exact before/after content and exact commands with expected output.
- **Type consistency:** `buildCategorizer(st *store.Store, cats []categorize.Category, aiCat categorize.AICategorizer) (*categorize.Categorizer, bool)` is defined once (T2 Step 1) and called with the same signature in T2 Steps 2–3 using in-scope `st`, `domainCats`, `aiCat`. Test migration in T1 uses the real `NewProcessor` + `SetCategorizerProvider` signatures from `processor.go`.
