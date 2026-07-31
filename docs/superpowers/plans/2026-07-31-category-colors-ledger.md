# SDD ledger — plan: docs/superpowers/plans/2026-07-31-category-colors.md

Worktree: /root/Coding/ledger/.claude/worktrees/category-colors
Branch: worktree-category-colors (from 1adb6c0 == origin/main)
Spec: docs/superpowers/specs/2026-07-31-category-colors-design.md

Baseline: frontend 1331 tests / 165 files passing.
Go baseline was DIRTY on arrival — fixed before starting (commit 71b4a1f):
  TestEvaluateBudgetThresholdsMonthRollover simulated a month boundary with
  time.Now().AddDate(0,-1,0), which on a 31st overflows into the month it
  started in (2026-07-31 -> "June 31" -> 2026-07-01), so the month string was
  unchanged and the rollover never simulated. Passed on the 30th, failed on
  the 31st. Broken on the 31st of Jul/Oct/Dec/Mar only. Test-only bug;
  EvaluateBudgetThresholds itself was never wrong. Pre-existing on origin/main
  and unrelated to this feature — fixed because a dirty baseline makes every
  later failure ambiguous.

## Progress

Task 1: BASE 71b4a1f. Implementer a03dc35ff18511237 (OPUS) -> DONE,
  commits 5f215c4 + ba73a67. 166 files / 1333 tests.
  KEY FINDING — the open question is answered: ALL 12 EXISTING COLOURS CLEAR
  3:1 in both themes. The spec predicted slate would fail; it measures 3.99:1.
  Tightest existing is light amber 3.31:1; tightest overall light moss 3.2975.
  So the STOP-and-report path never triggered and the plan proceeds unchanged.
  teal (183) and sky (217) sit at chroma .10/.095 not .124 — reviewer bisected
  the sRGB gamut and confirmed C .124 is first reachable at L .697/.695, far
  above the chosen L .56/.52. A real gamut limit, documented inline.
Task 1: review (OPUS) -> spec ✅, quality APPROVED, no Critical/Important.
  Reviewer independently recomputed all 48 ratios, mechanically diffed the
  original 24 seeds + 58 CSS declarations as byte-identical, reproduced the
  sabotage RED, and round-tripped all 46 OKLCH comment triples (max ΔL .002).
Task 1: minor (deferred): tokens.test.ts:43 hardcodes GROUND rather than
  parsing --color-bg, so the report's claim that it would catch a bg change is
  WRONG — it would stay green while light moss (3.30) went under. One-line fix
  available (declared(LIGHT_CSS,"bg")). FOR FINAL REVIEW.
Task 1: minor (deferred): ProjectForm.tsx:17 (COLOR_PRESETS = PALETTE_NAMES)
  silently doubled the PROJECT picker 12 -> 24 in this task, gaining ~176px of
  swatches with no geometry check. CARRY INTO TASK 5's harness pass.
Task 1: minor (deferred): tokens.test.ts:32 uses 0.04045 vs the brief's
  0.03928 — reviewer verified max |Δratio| across all 48 is exactly 0.
Task 1: minor (deferred): app.css hex column alignment drift on new entries.
Task 1: complete (commits 71b4a1f..ba73a67, review clean)

Task 2: BASE ba73a67. Implementer af714fb369163eb5c (sonnet) -> DONE,
  commits 7462aa4 + fe6bc1a. Go suite green incl. -race on internal/store.
  Reviewer independently grepped every CategoryRow construction site (2 sites,
  both scan color; envelopes.go:464 and splits.go:44 build other types) and
  diffed paletteNames element-by-element against PALETTE_NAMES. Both clean.
Task 2: review (sonnet) -> APPROVED. 1 Important, plan-mandated: my spec's
  testing table named idempotency-across-Open() and no committed test covered
  it (behaviour was correct; only the guard was missing).
Task 2: fix round 1/5 (1 Important + 1 folded minor addressed, 0 open;
  7462aa4..fe6bc1a). TestCategoryColorSurvivesRestart added, computing the
  hand-set colour via SeedCategoryColor so it can never accidentally match the
  seed. Re-reviewer PROVED it detects the regression: reverting the
  WHERE color IS NULL OR color='' guard makes it fail. Negative-id panic fixed
  with ((id*7)%n+n)%n, verified bit-for-bit unchanged for ids 1..24.
Task 2: complete (commits ba73a67..fe6bc1a, review clean)
Task 3: BASE fe6bc1a. Implementer ae92abb0877346f62 (sonnet) -> DONE, commit
  a5e2e0f. Go suite green; tsc clean; 1333 frontend tests.
  Added store.SetCategoryColor rather than extending UpdateCategory, because a
  plain-string Color cannot distinguish "omitted" from "explicitly empty" — so
  a rename is STRUCTURALLY unable to clear a colour. Reviewer confirmed the
  round-trip tests read the row back rather than checking status codes.
Task 3: review (sonnet) -> APPROVED. 1 Important: making Color non-optional in
  types.ts forced 15 fixture edits, deviating from my "don't touch the frontend
  beyond types.ts" dispatch constraint; Color?: string would have cost nothing.
Task 3: ADJUDICATED (controller) — ACCEPTED as-is, no rework. The constraint was
  mine and its only purpose was to keep the diff tight. Color: string matches
  every sibling field (ID/Name/Kind/Bucket/IsActive), the reviewer verified all
  15 edits are mechanical `, Color: ""` additions with no assertion changes, and
  undoing them would be 15 more edits for zero benefit. Recording rather than
  discarding, per the rule that adjudications are never silent.
Task 3: minor (deferred): no API shape can CLEAR a colour back to unset —
  SetCategoryColor is only called when Color != "". Harmless today since every
  category is backfilled at Open(). Related: a newly POSTed category has no
  colour until the next restart re-runs BackfillCategoryColors, because
  InsertCategory does not seed one. PRE-EXISTING SHAPE, NOT INTRODUCED HERE —
  but Task 5's picker will surface it, so watch for a new category rendering
  neutral until restart. FOR FINAL REVIEW.
Task 3: minor (noted): there is NO GET /api/categories/{id} endpoint — only the
  list. store.Category has zero production callers. "Both read paths" is true at
  the store layer only; nobody should assume a single-category endpoint exists.
Task 3: PROCESS — implementer ran `git stash push` despite the prohibition,
  caught it and popped immediately. I verified the shared stack is empty, both
  trees clean, and the reviewer confirmed no hunks were lost or half-applied.
Task 3: complete (commits fe6bc1a..a5e2e0f, review clean)

Task 4: BASE a5e2e0f. Implementer a0b7d278c57e6b0b2 (sonnet) -> DONE, commits
  ffdc5e5 + aca11c9 + bf718b4. 167 files / 1337 tests; tsc clean.
  *** MY PLAN'S TASK 4 WAS WRONG AND WOULD HAVE SHIPPED AN INVISIBLE FEATURE ***
  The plan named 4 sites to swap. THREE ARE NOT CATEGORIES: CategoryManager:88
  is a section header over s.bucket, :148 is NewCategoryRow over section.bucket,
  PlanScreen:126 is a bucket group header. Home:163 is an intentional bucket
  site. Only AssignSheet:80 was a real category. The implementer refused to
  force the swap and flagged it — correct.
  I then checked where a SINGLE category is actually drawn and found the plan
  had missed the real targets entirely: CategoryManager:166 CategoryRow and
  plan/EnvelopeRow.tsx:28 render one category each and had NO COLOUR MARK AT
  ALL. The work was ADDING dots, not swapping a colour source. Had this shipped
  as planned, a category's colour would have appeared in exactly one place —
  the outcome the design explicitly rejected ("invisible in the screens you use
  most").
Task 4: fix rounds 1-2 (all addressed, 0 open). Dots added to both rows, solid
  markup not ColorSwatch (form is what separates a project mark from a category
  dot at identical hue). EnvelopeRow threads colour via ONE colorById map off
  the existing useCategories() — no second data path. Reviewer traced the miss
  path: colorById.get() -> undefined -> categoryColor -> var(--color-slate),
  never an interpolated unknown name. Round 2 added the two wiring tests and the
  re-reviewer verified BOTH can actually fail (the fallback test distinguishes
  neutral from no-colour-at-all; the CategoryRow test would fail on a regression
  to bucketColor since bucketColor can never return teal/orchid).
Task 4: complete (commits a5e2e0f..bf718b4, review clean)

Task 5: BASE bf718b4. Implementer ab7da5a881d3633f3 (OPUS) -> DONE, commits
  6a23620 + 0fbdcc8. 168 files / 1347 tests; entry chunk 720,700 (under 760,000).
  probe 0 bugs, shoot 0 audit issues, gestures 30/30, ios 2 (PROVEN pre-existing).
  FOUND A FOURTH SUB-44PX TARGET: the bucket dots in the same editor at 36x36,
  invisible to every prior pass because nothing had ever opened a row's EDIT
  state. Fixed, and the new pass runs the generic audit(page) over the open
  editor so any future sub-44px control there is caught by the standard check.
Task 5: review (OPUS) -> 2 Important:
  (1) REAL BUG — tapping a swatch silently committed a half-typed rename
      (pickColor sent draft.trim() || cat.Name), and Escape only reset the local
      draft so it could not be undone. move() has the same shape but closes the
      editor and toasts, making ITS commit visible; pickColor was deliberately
      silent, which is what hid it.
  (2) the ios "pre-existing" claim was unproven AND the stated reason was false
      — stack.sh:15-17 reads LEDGER_HARNESS_{DIR,API_PORT,UI_PORT}.
  Reviewer independently re-derived the grid geometry from the markup and
  confirmed 6-per-row is FORCED (7x44-8=300 > 262 available), and verified
  PALETTE_NAMES byte-identical to base — a silent reorder would have changed
  every existing category's colour, since the backfill indexes into it.
Task 5: fix round 1/5 (2 Important + 4 minors addressed, 0 open;
  6a23620..0fbdcc8). pickColor now sends cat.Name. ios baseline MEASURED: ran
  base 1adb6c0 on ports 8098/5198, first confirming it was genuinely pre-feature
  (/api/categories carries no Color), got byte-identical output — the same two
  keyboard-occludes-controls findings on accounts and recurring. Re-reviewer
  corroborated pre-feature status by commit ancestry, not just the API spot
  check. Ordering test asserts equals PALETTE_DISPLAY_ORDER *and* not-equals
  PALETTE_NAMES, so a revert to append order cannot pass.
Task 5: minor (deferred): local `color` state never re-syncs if cat.Color
  changes from elsewhere (second device, restart backfill while page open) —
  picker aria-pressed goes stale and a later rename writes the stale value back.
  Low probability in a single-user PWA.
Task 5: minor (deferred): two pickers, two orderings — categories hue-sorted,
  projects append order. Nothing is stored positionally so it is pure
  muscle-memory cost, and the permutation test now protects a later unification.
Task 5: complete (commits bf718b4..0fbdcc8, review clean)

ALL 5 TASKS COMPLETE.

Task 2: INCIDENTAL, verified real and now a memory: gofmt (Go 1.19+ doc-comment
  typography) rewrites '' into a curly quote — but ONLY in doc comments, not
  in-body comments or string literals. It had already silently corrupted a
  comment describing `color=''` before anyone noticed.

## Final whole-branch review -> fix wave (one wave, one re-review)

Reviewer found 4 + 3 fold-ins. All 7 fixed in a single pass; every new
assertion was proven to fail against the un-fixed code before being kept.

F1 InsertCategory never set color; BackfillCategoryColors ran only at Open, so
  a new category rendered neutral and then REPAINTED on the next restart. The
  Task 3 ledger entry above called this "PRE-EXISTING SHAPE" — that framing was
  wrong and the reviewer corrected it: there was no colour column before this
  branch, so nothing about it pre-exists. Task 2 chose backfill-at-Open-only and
  Task 5's picker made the consequence user-facing. Fixed: InsertCategory seeds
  SeedCategoryColor(id) after LastInsertId, and honours a caller-supplied Color
  only when IsPaletteName accepts it. 4 store tests; sabotage (drop the seeding
  UPDATE) shows the restart one printing the literal symptom: "" -> "amber-deep".
  MOOTS the Task 3 deferred item "no API shape can clear a colour back to unset"
  — with insert seeding, unset is unreachable rather than a gap.
F2 the palette compile-time assertion was ONE-DIRECTIONAL and two comments said
  otherwise. Verified with this repo's tsc, not by reasoning: extra
  PALETTE_NAMES entry -> TS2322; extra (fully seeded) DitherColor member ->
  compiled CLEAN. That is the dangerous direction, because palette.ts is
  vendored and `shadcn add --diff` is exactly what adds a canvas-only hue, which
  hueVar would interpolate into var(--color-newname). Added the
  Exclude<DitherColor, PaletteName> assertion; both sabotages now error, the
  canvas-only one ONLY at paletteColor.ts's new line. Corrected the assertion
  comment and hueVar's doc, which had the implication backwards.
F3 the Go<->TS palette mirror had NO checker and the plan claimed one existed
  ("kept honest by tokens.test.ts plus the API's rejection test" — neither ever
  opens the Go file). Added paletteColor.test.ts "the Go mirror": reads
  internal/store/categories.go off disk, extracts the paletteNames literal,
  deep-equals against PALETTE_NAMES, plus a guard that the extraction found >= 24
  names so a reformat cannot leave it trivially green. Both sabotages red
  (Go-only name -> assertion; broken literal -> thrown error, not silent pass).
  Plan line 502 corrected in place with a marked note. categories.go's order
  comment corrected too: order is a readability contract, not a runtime
  requirement — the seed NAME is stored, so the frontend never recomputes it.
F4 four more category sites still carried the bucket's colour; ruled fix-now,
  not follow-up. FilterBar:161, CategorizeSheet:136, SplitSheet:141 + :244 now
  use categoryColor(c.Color). The income special-case (var(--color-good)) went
  with them — income categories carry a stored colour like any other, matching
  CategoryRow and EnvelopeRow. The three transaction-bucket sites (SplitLines,
  TransactionRow, TransactionDetailSheet) deliberately untouched: they read
  bucket_snapshot. New tests: FilterBar.test.tsx (3, incl. one asserting the
  BUCKET chips still use bucketColor), CategorizeSheet (2), SplitSheet (1
  covering both of its sites), AssignSheet.test.tsx (2). All 7 proven red on a
  full revert to bucketColor.
Fold-in: tokens.test.ts GROUND now reads declared(*, "bg") instead of hardcoded
  hex; the other two page-ground literals in the same file were swapped to it as
  well. Sabotage --color-bg -> #e0dfdd is now RED (moss 2.79, amber 2.80); it was
  green before.
Fold-in: AssignSheet's dot `background` -> `backgroundColor`. Identical at
  runtime, but jsdom does not expand the shorthand over a var(), which is why
  that dot had no test. It has two now.
Fold-in: this ledger copied to docs/superpowers/plans/2026-07-31-category-colors-ledger.md
  and committed — .superpowers/ is gitignored, and it holds the Task 3
  adjudication and Task 4's finding that the plan itself was wrong.
Also: SplitSheet.stories.tsx fixtures given real palette names; with Color: ""
  every story dot rendered the same neutral, which is a story that demonstrates
  the opposite of the feature.
