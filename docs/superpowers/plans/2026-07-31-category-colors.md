# Per-category colours — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every category its own user-picked colour, from a palette grown from 12 to 24 names.

**Architecture:** The palette grows by extending the hue wheel — five existing hues stay put, six new ones fill the largest gaps — so nothing stored migrates. A new contrast test makes the previously hand-measured accessibility floor machine-checked. `categories` gains a nullable `color` column, backfilled deterministically from row id. The frontend swaps `bucketColor` for a new `categoryColor` at the four sites where a *category* is drawn, and `CategoryManager` gains a picker reusing `ProjectForm`'s grid.

**Spec:** `docs/superpowers/specs/2026-07-31-category-colors-design.md` — read it before Task 1.

**Tech Stack:** Go 1.22 (stdlib `net/http`, pure-Go SQLite), React 19 + TypeScript + Vite, Tailwind v4, vitest + jsdom, Playwright harness.

## Global Constraints

- **The palette lives in three files that must agree**: `frontend/src/styles/app.css` (light and dark tables), `frontend/src/components/dither-kit/palette.ts` (RGB seeds), `frontend/src/lib/paletteColor.ts` (names). Two mechanisms already enforce this and must keep passing: the compile-time assertion at `paletteColor.ts:19` pinning `PALETTE_NAMES` to `DitherColor`, and `styles/tokens.test.ts`.
- **Colours are stored as names, never hex.** A stored hex cannot follow the theme — light-mode azure is 2.82:1 on the dark ground. See `lib/paletteColor.ts:26-40`.
- **Never interpolate an unvalidated name into `var()`.** `var(--color-chartreuse)` is valid CSS that resolves to nothing, and the mark silently disappears. Unknown → neutral fallback.
- **Contrast floor is 3:1** against the theme's `--color-bg` (`#f2f1ef` light, `#141416` dark). Palette hues are graphical objects, never text.
- **Form distinguishes projects from categories at identical hue.** `ColorSwatch` is a *hatched* square (see its doc comment); category rows carry *solid* dots. Task 4 changes only the dot's colour source — it must not switch category rows to `ColorSwatch`.
- **44px minimum tap targets.** `ProjectForm.tsx:106` already solves this for swatches with `w-11 h-11 -m-1` — a 44px target wrapping a small visual mark. Reuse it. This codebase has shipped three sub-44px target bugs; the harness is the check that catches them, not the eye.
- Money is `int64` fils. Untouched here.
- Tests use `fireEvent` from `@testing-library/react`, never `userEvent`.
- vitest is pinned to a single non-parallel fork (`fileParallelism: false`, `singleFork`) — deliberate, the sandbox blocks worker spawning.
- `internal/web/dist/` is a committed artifact Go embeds. It goes stale silently; rebuild before measuring anything about it, and rebuild + commit at the end (Task 5).
- `frontend/harness/stack.sh up|reset` **hangs when piped** — redirect to a file instead. Tear the stack down (`stack.sh down`, ports 8099/5199) before finishing.

---

## File Structure

**Created:**
- `frontend/src/lib/categoryColor.ts` + `.test.ts` — the name→CSS helper.
- `frontend/src/lib/categorySeed.ts` + `.test.ts` — the deterministic backfill index, shared shape with Go's implementation.

**Modified:**
- `frontend/src/lib/paletteColor.ts` — `PALETTE_NAMES` 12 → 24.
- `frontend/src/components/dither-kit/palette.ts` — `DitherColor` union, `PALETTE_LIGHT`, `PALETTE_DARK`.
- `frontend/src/styles/app.css` — light and dark palette tables.
- `frontend/src/styles/tokens.test.ts` — extend the mirror assertions; add the contrast test.
- `internal/store/schema.sql`, `internal/store/store.go`, `internal/store/categories.go`
- `internal/server/categories.go`
- `frontend/src/api/types.ts`
- `frontend/src/screens/CategoryManager.tsx` — picker + two dot sites.
- `frontend/src/screens/Home.tsx:163`, `screens/plan/PlanScreen.tsx:126`, `screens/plan/AssignSheet.tsx:80`
- `frontend/harness/probe.mjs` or `shoot.mjs` — picker geometry coverage.

---

### Task 1: Palette to 24, with a contrast test

Do this first. The contrast test may fail on **existing** colours; that is a finding to surface, not a value to change silently (existing hues are already stored on real project rows).

**Files:**
- Modify: `frontend/src/components/dither-kit/palette.ts`, `frontend/src/lib/paletteColor.ts`, `frontend/src/styles/app.css`
- Modify: `frontend/src/styles/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PALETTE_NAMES` with 24 entries, ordered `[12 base..., 12 deep...]`; `DitherColor` union of the same 24; `--color-<name>` declared in both themes.

- [ ] **Step 1: Write the failing contrast test**

Add to `frontend/src/styles/tokens.test.ts`. It parses the same `app.css` source the existing mirror tests read.

```ts
/** Relative luminance per WCAG 2.1, from an #rrggbb string. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("palette contrast", () => {
  // 3:1, not 4.5:1 — palette hues are graphical objects (dots, chart fills,
  // DitherFill backgrounds), never text. WCAG 1.4.11. This is the same
  // threshold app.css already cites when it rules that neither the amber nor
  // the red clears 3:1 on the hero ground.
  const FLOOR = 3;

  it.each([
    ["light", "#f2f1ef"],
    ["dark", "#141416"],
  ])("keeps every palette hue at or above %s 3:1 on the page ground", (theme, ground) => {
    const table = theme === "light" ? PALETTE_LIGHT : PALETTE_DARK;
    const failures: string[] = [];
    for (const name of PALETTE_NAMES) {
      const hex = seedHex(table[name]);
      const ratio = contrast(hex, ground);
      if (ratio < FLOOR) failures.push(`${name} ${hex} = ${ratio.toFixed(2)}:1`);
    }
    expect(failures, `below ${FLOOR}:1 on ${ground}`).toEqual([]);
  });
});
```

`seedHex` converts a `Seed`'s RGB triple to `#rrggbb`; write it beside the test if `palette.ts` exports no equivalent.

- [ ] **Step 2: Run it against the CURRENT 12 and record the result**

Run: `cd frontend && bunx vitest run src/styles/tokens.test.ts`

This is a diagnostic, not a pass/fail gate yet. **Record the exact output in your report.** If any of the existing 12 fails, STOP and report it — do not adjust an existing hue. `slate` (`#76767e`) on paper is the likeliest.

- [ ] **Step 3: Add the six new hues to `palette.ts`**

Extend the `DitherColor` union with `ochre`, `moss`, `teal`, `sky`, `indigo`, `orchid` and their `-deep` variants, and add entries to `PALETTE_LIGHT` and `PALETTE_DARK`.

Target hues (OKLCH, chroma 0.124 to match the existing five): `ochre` 42°, `moss` 110°, `teal` 183°, `sky` 217°, `indigo` 275°, `orchid` 337°.

Lightness is **not** constant across hues in this palette — existing values run L.48 (azure) to L.62 (amber, rose), each tuned to clear contrast on its ground. Choose L per new hue the same way: start near its neighbours' L, then let Step 5 drive it. In the dark table, `-deep` goes *lighter* than its base, matching the existing dark entries.

Keep the comment style: each entry carries its hex and its OKLCH triple.

- [ ] **Step 4: Add all 24 to `app.css` and grow `PALETTE_NAMES`**

`app.css` gets 12 new `--color-*` lines in the light `:root` block and 12 in the `@media (prefers-color-scheme: dark)` block. `PALETTE_NAMES` in `paletteColor.ts` grows to 24, ordered base-then-deep. The compile-time assertion at `paletteColor.ts:19` will fail the build if the two sets diverge — that is the intended safety net.

- [ ] **Step 5: Run the test and nudge until green**

Run: `cd frontend && bunx vitest run src/styles/tokens.test.ts`
Expected: the mirror tests pass (24 in both themes, matching `palette.ts`) and the contrast test passes for the 12 new entries.

Adjust lightness on any new hue that falls short and re-run. Do not touch the existing 12.

- [ ] **Step 6: Full suite + commit**

Run: `cd frontend && bun run test && bunx tsc -b --noEmit`

```bash
git add frontend/src/components/dither-kit/palette.ts frontend/src/lib/paletteColor.ts \
        frontend/src/styles/app.css frontend/src/styles/tokens.test.ts
git commit -m "feat(palette): extend to 24 names and assert the contrast floor

Five existing hues stay put so nothing stored migrates; six new ones fill
the largest gaps on the same chroma. The contrast floor was previously
recorded only in app.css comments — it is now a test."
```

---

### Task 2: `color` column, backfill, store

**Files:**
- Modify: `internal/store/schema.sql`, `internal/store/store.go`, `internal/store/categories.go`
- Modify/create: `internal/store/categories_test.go`

**Interfaces:**
- Consumes: the 24 names from Task 1 (as a Go-side list).
- Produces: `CategoryRow.Color string`; `SeedCategoryColor(id int64) string`.

- [ ] **Step 1: Write the failing store test**

```go
func TestCategoryColorBackfill(t *testing.T) {
	s := openTestStore(t) // follow the existing helper in this package
	// Categories created before the column existed have no colour.
	ids := seedCategories(t, s, "Groceries", "Rent", "Fuel")

	got := map[string]bool{}
	for _, id := range ids {
		c, err := s.Category(id)
		if err != nil {
			t.Fatal(err)
		}
		if c.Color == "" {
			t.Fatalf("category %d has no colour after backfill", id)
		}
		got[c.Color] = true
	}
	if len(got) != len(ids) {
		t.Fatalf("backfill assigned %d distinct colours to %d categories: %v", len(got), len(ids), got)
	}
}

func TestSeedCategoryColorIsStable(t *testing.T) {
	// Depends only on the row's own id, so adding or deleting a category
	// never reshuffles anyone else's colour.
	for id := int64(1); id <= 24; id++ {
		if SeedCategoryColor(id) != SeedCategoryColor(id) {
			t.Fatalf("id %d is not stable", id)
		}
	}
	seen := map[string]int64{}
	for id := int64(1); id <= 24; id++ {
		c := SeedCategoryColor(id)
		if prev, dup := seen[c]; dup {
			t.Fatalf("ids %d and %d both got %s", prev, id, c)
		}
		seen[c] = id
	}
}
```

Match the package's existing test helpers rather than inventing `openTestStore`/`seedCategories` if equivalents already exist.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/store/ -run 'CategoryColor|SeedCategoryColor'`
Expected: FAIL — `Color` is not a field, `SeedCategoryColor` undefined.

- [ ] **Step 3: Add the column and the seed**

In `schema.sql`, add `color TEXT` to the `categories` table definition for fresh databases. For existing ones, add to the migration block beside the other `addColumnIfMissing` calls in `store.go`:

```go
if err := addColumnIfMissing(db, "categories", "color", "TEXT"); err != nil {
	return nil, err
}
```

In `categories.go`, add `Color string` to `CategoryRow`, include `color` in every SELECT/scan that builds one, and add:

```go
// paletteNames mirrors frontend/src/lib/paletteColor.ts, base names first.
var paletteNames = []string{ /* 24 entries */ }

// SeedCategoryColor picks a starting colour for a category that has none.
//
// 7 is coprime to 24, so id -> index is a bijection mod 24: ids 1..24 get
// distinct colours, and consecutive ids land far apart on the hue wheel
// rather than side by side. It depends only on the row's own id, so adding
// or deleting a category never reshuffles anyone else's colour.
func SeedCategoryColor(id int64) string {
	return paletteNames[(id*7)%int64(len(paletteNames))]
}
```

Backfill once, after the column is added, for rows where it is null or empty. Do it in Go rather than SQL so the index arithmetic has one implementation.

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/store/ -run 'CategoryColor|SeedCategoryColor' -v`

- [ ] **Step 5: Full Go suite + commit**

Run: `go test ./...`

```bash
git add internal/store
git commit -m "feat(store): per-category colour column with a deterministic backfill"
```

---

### Task 3: API — read and write the colour

**Files:**
- Modify: `internal/server/categories.go`
- Modify/create: `internal/server/categories_test.go`
- Modify: `frontend/src/api/types.ts`

**Interfaces:**
- Consumes: `CategoryRow.Color`, `SeedCategoryColor` (Task 2); `PALETTE_NAMES` (Task 1).
- Produces: `Color` on the category JSON resource; `PUT /api/categories/{id}` accepts `color`.

- [ ] **Step 1: Write the failing handler test**

```go
func TestPutCategoryRejectsUnknownColour(t *testing.T) {
	// An unknown name must never reach storage: paletteColor.ts interpolates
	// the stored value into var(--color-NAME), and an unknown one is valid
	// CSS that resolves to nothing — the mark silently disappears.
	rr := doPut(t, srv, "/api/categories/1", `{"name":"Rent","kind":"spending","bucket":"need","color":"chartreuse"}`)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rr.Code)
	}
}

func TestPutCategoryAcceptsPaletteName(t *testing.T) {
	rr := doPut(t, srv, "/api/categories/1", `{"name":"Rent","kind":"spending","bucket":"need","color":"teal"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rr.Code)
	}
	// and it round-trips on read
}

func TestPutCategoryAllowsEmptyColour(t *testing.T) {
	// Empty means "unset" and is legal — the frontend falls back to neutral.
}
```

Use the package's existing request helper rather than inventing `doPut` if one exists.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/server/ -run TestPutCategory`
Expected: FAIL — `color` is ignored, so the unknown-name case returns 200.

- [ ] **Step 3: Implement**

Add `Color string \`json:"color"\`` to `updateCategoryReq`. Validate after the existing name/kind/bucket checks in `handlePutCategory` (around `categories.go:161-168`):

```go
if req.Color != "" && !isPaletteName(req.Color) {
	http.Error(w, `{"error":"unknown colour"}`, http.StatusBadRequest)
	return
}
```

`isPaletteName` checks against the same `paletteNames` slice Task 2 added. Include `Color` in the response marshalling for both the list and single-category reads.

In `frontend/src/api/types.ts`, add `Color: string` to the `Category` type.

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./internal/server/ -run TestPutCategory -v`

- [ ] **Step 5: Full suite + commit**

Run: `go test ./... && cd frontend && bunx tsc -b --noEmit`

```bash
git add internal/server frontend/src/api/types.ts
git commit -m "feat(api): read and write a category's colour, rejecting unknown names"
```

---

### Task 4: `categoryColor` and the four call sites

**Files:**
- Create: `frontend/src/lib/categoryColor.ts`, `frontend/src/lib/categoryColor.test.ts`
- Modify: `frontend/src/screens/CategoryManager.tsx` (lines 88, 148), `screens/Home.tsx:163`, `screens/plan/PlanScreen.tsx:126`, `screens/plan/AssignSheet.tsx:80`

**Interfaces:**
- Consumes: `PALETTE_NAMES`/`isPaletteName` (Task 1), `Category.Color` (Task 3).
- Produces: `categoryColor(color: string | null | undefined): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { categoryColor } from "./categoryColor";

describe("categoryColor", () => {
  it("resolves a palette name to its themed variable", () => {
    expect(categoryColor("teal")).toBe("var(--color-teal)");
    expect(categoryColor("azure-deep")).toBe("var(--color-azure-deep)");
  });

  it("falls back to the neutral for anything it does not know", () => {
    // Never interpolate an unvalidated name: var(--color-chartreuse) is valid
    // CSS that resolves to nothing, so the mark would silently vanish rather
    // than degrade.
    for (const v of [null, undefined, "", "chartreuse", "#ff0000"]) {
      expect(categoryColor(v)).toBe("var(--color-slate)");
    }
  });
});
```

Note this differs from `projectColor`, which passes a legacy `#hex` through. Categories have no legacy hex — the column is new — so a hex is as unknown as any other bad value.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/categoryColor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { isPaletteName } from "./paletteColor";

/**
 * CSS colour for a category's stored colour.
 *
 * A name rather than a hex, for the same reason projects store names: the
 * cascade re-resolves `var(--color-…)` per theme, so a colour that clears
 * contrast on paper also clears it on the dark ground without any consumer
 * subscribing to the theme.
 *
 * Unlike `projectColor` there is no legacy-hex branch — this column is new,
 * so a hex here is as unknown as any other bad value and takes the neutral.
 */
export function categoryColor(color: string | null | undefined): string {
  return isPaletteName(color) ? `var(--color-${color})` : "var(--color-slate)";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && bunx vitest run src/lib/categoryColor.test.ts`

- [ ] **Step 5: Swap the four call sites**

Replace `bucketColor(...)` with `categoryColor(cat.Color)` at:
- `screens/CategoryManager.tsx:88` and `:148`
- `screens/Home.tsx:163`
- `screens/plan/PlanScreen.tsx:126`
- `screens/plan/AssignSheet.tsx:80`

**Keep the existing solid-dot markup.** Do not switch these to `ColorSwatch` — that component is deliberately *hatched*, and its doc comment explains that form is what distinguishes a project mark from a category dot when the two share a hue.

Leave `bucketColor` in place; Home's bucket rows still colour actual buckets.

Each site's surrounding data may need the category's `Color` threaded through — check what each already has in scope and report anything that needs a prop or query change.

- [ ] **Step 6: Full suite + commit**

Run: `cd frontend && bun run test && bunx tsc -b --noEmit`

```bash
git add frontend/src/lib/categoryColor.ts frontend/src/lib/categoryColor.test.ts \
        frontend/src/screens
git commit -m "feat(ui): colour category rows by their own colour, not their bucket"
```

---

### Task 5: The picker, harness verification, rebuild

**Files:**
- Modify: `frontend/src/screens/CategoryManager.tsx`
- Modify: `frontend/harness/probe.mjs` (or `shoot.mjs`, whichever owns per-screen interaction coverage)
- Rebuild: `internal/web/dist/`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: no new exports.

- [ ] **Step 1: Add the picker**

In `CategoryManager`'s row editor, beside the existing bucket control, add a swatch grid over all 24 `PALETTE_NAMES`. Reuse the pattern from `ProjectForm.tsx:99-110`:

```tsx
<div className="flex flex-wrap gap-2">
  {PALETTE_NAMES.map((c) => (
    <Pressable
      key={c}
      aria-label={c}
      aria-pressed={color === c}
      onClick={() => void setColor(c)}
      // w-11 h-11 -m-1: a 44px target around a small visual mark. The
      // negative margin keeps the grid visually tight without shrinking
      // the target — this codebase has shipped three sub-44px target bugs.
      className="w-11 h-11 -m-1 inline-flex items-center justify-center"
    >
      <span
        aria-hidden
        className="w-4 h-4 rounded-[var(--radius)]"
        style={{ background: categoryColor(c) }}
      />
    </Pressable>
  ))}
</div>
```

A **solid** mark, not a hatched `ColorSwatch` — a picker shows the colour itself, and the hatch is the project mark's identity.

Persist through the existing category PUT, alongside name and bucket.

- [ ] **Step 2: Add harness coverage**

Extend the harness so the picker's geometry is measured, not eyeballed: open a category's editor, and assert every swatch is at least 44×44 and that nothing on the screen extends past the viewport at 320px.

Verify the check has teeth: shrink a swatch to `w-9 h-9`, confirm the check fails, then revert. A check that cannot fail is worse than none — this repo has shipped three of those.

- [ ] **Step 3: Run the harness**

```bash
cd frontend
harness/stack.sh reset > /tmp/stack.log 2>&1   # never pipe — it hangs
node harness/probe.mjs
node harness/shoot.mjs
node harness/gestures.mjs
harness/stack.sh down > /tmp/down.log 2>&1
```

Baseline before this plan: probe 0 bugs, shoot 0 audit issues, gestures 30/30. Explain any delta.

Open the CategoryManager screenshot and check the picker does not dominate the row editor — 24 swatches wrap to roughly six per row across four rows at 320px.

- [ ] **Step 4: Full verification and rebuild**

```bash
cd frontend && bun run test && bunx tsc -b --noEmit && bun run build
cd .. && CGO_ENABLED=0 go build -o /tmp/ledger-check ./cmd/ledger && go test ./...
```

`bun run build` regenerates `internal/web/dist/`, which Go embeds. Report the entry chunk size; the motion budget ceiling of 760,000 bytes still applies.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/CategoryManager.tsx frontend/harness internal/web/dist
git commit -m "feat(ui): pick a category's colour from the 24-name palette"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: palette + contrast → Task 1; storage and backfill → Task 2; API → Task 3; `categoryColor` and the four call sites → Task 4; picker, geometry and rebuild → Task 5. The design's non-goals (uniqueness, free hex, subcategory colours, changing `bucketColor`) are stated in Global Constraints or the relevant task.

**Placeholders.** None. Every step carries real code or a real command with its expected output. Where the plan cannot know a repo detail — the store package's test helpers, which harness script owns interaction coverage, whether a call site already has `Color` in scope — it says so explicitly and asks the implementer to check and report, rather than inventing a name.

**Type consistency.** `Color string` on both `CategoryRow` (Go) and `Category` (TS). `SeedCategoryColor(int64) string` used only in Task 2. `categoryColor(string|null|undefined) string` defined in Task 4 and used in Task 5. `isPaletteName` already exists in `paletteColor.ts` and is reused rather than redefined; the Go side gets its own `paletteNames` slice.

> **Corrected at final review.** This paragraph originally claimed the two lists were "kept honest by `tokens.test.ts` plus the API's rejection test". That was false: neither test ever opens the Go file — `tokens.test.ts` reads `app.css` and `palette.ts`, and the rejection test only asserts that *some* unknown name 400s. A merged plan asserting a checker that does not exist is worse than one admitting the mirror is convention-only, because it stops anyone from adding the checker. The gap mattered asymmetrically: a name only TS knows is loud (pick → 400), while a name only Go knows is silent (backfill assigns it → `categoryColor` doesn't recognise it → permanent neutral, indistinguishable from a chosen grey). The checker now exists — `paletteColor.test.ts`'s "the Go mirror" describe reads `internal/store/categories.go` off disk, extracts the `paletteNames` literal and deep-equals it against `PALETTE_NAMES`, in the same read-the-other-source shape `tokens.test.ts` uses for `app.css`. Order is compared too, but only as a readability contract: the seed colour is *stored* as a name, so nothing at runtime needs Go and TS to predict the same index.

**Known risk.** Task 1 Step 2 may reveal that an existing palette entry fails the new 3:1 floor. The plan deliberately stops there rather than adjusting a hue that is already stored on real project rows. If that happens it needs a decision, not a fix.
