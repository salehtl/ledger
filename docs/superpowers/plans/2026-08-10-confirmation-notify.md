# Confirmation Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a mail provider's forwarding-confirmation email lands during onboarding, the user is told — in-app within seconds if the app is open, and by a content-free push if it is closed — instead of having to know to open Held mail.

**Architecture:** Two layers. Layer 1 (safe, no principle touched): the app polls held mail on a short interval while the user is still setting up, so the existing one-tap "Open the confirmation" card surfaces on arrival. Layer 2 (a narrow, deliberate relaxation of "quarantined mail never pushes"): the ingest `hold` path fires the existing content-free push for **exactly one shape** — a verified-provider confirmation for a user who has not yet confirmed any sender — and the push opt-in moves into onboarding so there is a subscription to receive it.

**Tech Stack:** Go (internal/v2), React 19 + TS (web/), vitest, the existing pure-module conventions.

## Global Constraints

- The push payload stays **content-free**. `Pusher.Notify(ctx, userID)` takes a user and nothing else; do not add content, a category, or a "this is a confirmation" flag to the wire. The client's service worker renders the same fixed string it renders for any activity.
- Onboarding never blocks. The push opt-in is skippable; an unsupported environment (no service worker, iOS not installed to Home Screen) shows nothing to act on, never a nag.
- Copy plain and short. Motion from `lib/motion`; no `opacity: 0` initial on first-paint content.
- Every test proven to bite: mutate, watch it fail, revert, report how.
- Shared git index: never `git add -A`/`commit -a`; explicit pathspecs on `git commit` itself; check `git diff --cached --name-only` first.
- `go build ./...`, `go vet ./...`, `gofmt -l` clean; `cd web && bunx tsc -b` clean and `bun run test` green before each commit. Do NOT run `bun run build` (coordinator rebuilds the bundle).

---

### Task 1: The abuse gate — a store predicate for "still setting up mail"

**Files:**
- Modify: `internal/v2/quarantine/quarantine.go` (add a method near `Allowlisted`, ~:1029)
- Test: `internal/v2/quarantine/quarantine_test.go` (or the file holding allowlist tests)

**Interfaces:**
- Produces: `func (s *Store) HasConfirmedAnySender(ctx context.Context, userID uuid.UUID) (bool, error)` — true iff the user has at least one `sender_allowlist` row of any scope. Task 2 consumes it.

Why this is the gate: a user who has confirmed a sender has finished setting up the mail path; from then on, held mail must never push (the original principle stands in full). The confirmation push is allowed only in the window before that first confirmation — which is exactly the onboarding window the feature exists for, and which bounds the abuse surface to brand-new accounts.

- [ ] **Step 1: Failing test.**

```go
func TestHasConfirmedAnySender(t *testing.T) {
	pool := pgtest.New(t)
	s := quarantine.NewStore(pool) // match the existing constructor in this file
	u := insertUser(t, pool)       // match the helper used by other tests here

	got, err := s.HasConfirmedAnySender(bg, u)
	if err != nil { t.Fatal(err) }
	if got { t.Fatal("a brand-new account reports a confirmed sender") }

	// Insert one allowlist row the way the store's own Allowlist path would.
	if _, err := pool.Exec(bg, `INSERT INTO sender_allowlist (user_id, domain, scope, created_at) VALUES ($1,'dib.ae','inner',now())`, u); err != nil {
		t.Fatal(err)
	}
	got, err = s.HasConfirmedAnySender(bg, u)
	if err != nil { t.Fatal(err) }
	if !got { t.Fatal("a user with an allowlist row reports none") }
}
```

- [ ] **Step 2: Run, watch it fail** (method undefined).
- [ ] **Step 3: Implement**, mirroring the existing `Allowlisted` EXISTS query:

```go
// HasConfirmedAnySender reports whether the user has ever confirmed a sender.
// It gates the onboarding confirmation push: once true, held mail never pushes
// again, restoring "quarantined mail never pushes" in full. Before the first
// confirmation it is the narrow window a provider's forwarding confirmation is
// allowed to buzz the phone.
func (s *Store) HasConfirmedAnySender(ctx context.Context, userID uuid.UUID) (bool, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM sender_allowlist WHERE user_id = $1)`, userID).Scan(&exists); err != nil {
		return false, fmt.Errorf("quarantine: has-confirmed-any-sender: %w", err)
	}
	return exists, nil
}
```

(Use the same receiver field the file already uses for the pool — read `Allowlisted` at ~:1029 and match it, `s.pool` or `s.db`.)

- [ ] **Step 4: Run, green.**
- [ ] **Step 5: Bite.** Change the SQL to `SELECT false` → both halves fail. Restore.
- [ ] **Step 6: Commit**, `feat(quarantine): a predicate for the pre-first-confirmation window`.

---

### Task 2: The gated confirmation push in the hold path

**Files:**
- Modify: `internal/v2/ingest/pipeline.go` (`hold`, ~:484; it currently never pushes)
- Test: `internal/v2/ingest/pipeline_test.go`

**Interfaces:**
- Consumes: `origin.IsForwarderDomain` (`internal/v2/origin/trust.go:244`), `Store.HasConfirmedAnySender` (Task 1), the pipeline's existing `notify` (~:1055) and `Pusher`.
- Produces: nothing new exported.

The predicate — a message may push from the hold path **only if all hold**:
1. `origin.IsForwarderDomain(o.Outer)` — it came from a mail provider, not a bank.
2. `o.DKIM == origin.SigPass || o.ARC == origin.SigPass` — a signature verified it; an envelope claim never qualifies. (Read the exact `SigPass` constant name in `internal/v2/origin`.)
3. `o.Inner == "" && !o.Attested` — it is the provider's OWN mail (a confirmation), not a bank seen behind the provider.
4. `!HasConfirmedAnySender(user)` — the user is still setting up the mail path.

Extract the signature/shape half (1–3) as a pure function so it is tested without a database; the DB gate (4) wraps it in `hold`.

- [ ] **Step 1: Failing tests.**

```go
func TestHoldPushesOnlyForAConfirmationDuringOnboarding(t *testing.T) {
	// Table over origin shapes × prior-confirmation state; assert Notify called
	// exactly for {forwarder outer, dkim OR arc pass, no inner, no prior confirm}.
	cases := []struct {
		name          string
		outer         string
		dkim, arc     origin.SigResult // use the real type/constants
		inner         string
		attested      bool
		alreadyConfirmed bool
		wantPush      bool
	}{
		{"gmail confirmation, fresh account", "google.com", origin.SigPass, origin.SigNone, "", false, false, true},
		{"icloud confirmation via ARC, fresh", "icloud.com", origin.SigNone, origin.SigPass, "", false, false, true},
		{"same confirmation, but user already confirmed a sender", "google.com", origin.SigPass, origin.SigNone, "", false, true, false},
		{"a bank behind the forwarder (has inner)", "google.com", origin.SigPass, origin.SigPass, "dib.ae", true, false, false},
		{"a bare bank domain, not a forwarder", "dib.ae", origin.SigPass, origin.SigNone, "", false, false, false},
		{"an unsigned envelope claim from a forwarder", "google.com", origin.SigNone, origin.SigNone, "", false, false, false},
	}
	// For each: build a Delivery + Origin, a fake Pusher recording Notify calls,
	// a store seam answering HasConfirmedAnySender per alreadyConfirmed, run hold,
	// assert len(pushes)==wantPush?1:0.
}
```

- [ ] **Step 2: Run, fail** (hold never pushes → every `wantPush:true` row fails).
- [ ] **Step 3: Implement.** A pure `func isProviderConfirmation(o origin.Origin) bool` for 1–3 (its own unit test), then in `hold`, after the row is durably stored and the arrival recorded, add: if `isProviderConfirmation(o)` and `HasConfirmedAnySender` is false, call `p.notify(ctx, d.UserID)`. Update the function's doc comment: it no longer *never* pushes — it pushes for exactly this one shape, and say why the abuse argument still holds (verified provider signature + pre-first-confirmation window + content-free + one message).
- [ ] **Step 4: Green**, and the whole `pipeline_test.go` suite green (the existing "quarantined mail never pushes" test must be reconciled — a *bank* held message, an *unsigned* held message, and a *post-confirmation* held message all still must not push; keep those assertions, they are the abuse guard).
- [ ] **Step 5: Bite.** Drop condition 4 (push regardless of prior confirmation) → "already confirmed" row fails. Drop condition 2 (push on unsigned) → the envelope-claim row fails. Drop condition 1 → the bank-domain row fails. Restore each.
- [ ] **Step 6: Commit**, `feat(ingest): tell an onboarding user their forwarding confirmation arrived`.

---

### Task 3: Layer 1 — the app surfaces the confirmation live

**Files:**
- Modify: `web/src/app/AppShell.tsx` (the held-mail `useQuery`, ~:147-150)
- Test: `web/src/app/AppShell.test.tsx`

**Interfaces:**
- Consumes: `mailStatus` (`web/src/v2/onboarding.ts`), the existing `readQuarantine` query.

The confirmation card already exists (`confirmationTask` → SetupStatus). What is missing is freshness: the query has no `refetchInterval`, so the card appears only on refocus. Add a short interval, **on only while it matters** — `mailStatus(v2.facts).kind !== "arrived"` — so a fully set-up account does not poll forever.

- [ ] **Step 1: Failing test.** Assert the held-mail query is configured with a `refetchInterval` (a function of the facts) that is a positive number while mail has not arrived and `false` once it has. If the query options are not readable from the test, assert the observable behaviour: advancing fake timers by the interval triggers a second `readQuarantine` fetch while waiting, and does not once `firstMailConfirmedAt` is set.

```ts
it("polls held mail while waiting, and stops once mail has arrived", async () => {
  vi.useFakeTimers();
  const reads = vi.fn(/* ...returns an empty page... */);
  renderShell({ facts: waitingFacts(), readQuarantine: reads });
  const before = reads.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(reads.mock.calls.length).toBeGreaterThan(before); // polled
  // ...rerender with arrivedFacts()...
  const after = reads.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(reads.mock.calls.length).toBe(after); // stopped
});
```

- [ ] **Step 2: Run, fail** (no interval today).
- [ ] **Step 3: Implement.** `refetchInterval: mailStatus(v2.facts).kind === "arrived" ? false : 5000` on the held-mail query (confirm the exact `mailStatus` return shape — earlier code uses `.kind`). Keep `enabled` as-is.
- [ ] **Step 4: Green**, whole AppShell suite.
- [ ] **Step 5: Bite.** Hard-code `refetchInterval: false` → the "polls while waiting" assertion fails. Restore.
- [ ] **Step 6: Commit**, `feat(web): the confirmation card appears as the mail lands, not on refocus`.

---

### Task 4: Layer 2b — the push opt-in moves into onboarding

**Files:**
- Modify: `web/src/screens/onboarding/Address.tsx` (the forwarding screen) or `web/src/screens/onboarding/SetupStatus.tsx` — whichever the confirmation task already lives beside; add an opt-in there
- Test: the corresponding `.test.tsx`

**Interfaces:**
- Consumes: `enablePush` (`web/src/v2/webpush.ts:179`), `pushUnsupportedReason`/`pushPermission` (same file) to decide whether to offer it at all, `isPushSubscribed` to avoid re-asking.

On the forwarding/waiting screen, offer one optional control: "Get a notification when it arrives." Tapping it runs `enablePush`. It is shown **only** when push is supported and not already subscribed (`pushUnsupportedReason(env) === null && !(await isPushSubscribed())`), and its copy is honest about iOS ("Add ledger to your Home Screen first" when that is the unsupported reason — reuse the existing reason strings). It never blocks; skipping it is the default.

- [ ] **Step 1: Failing tests.** (a) When push is supported and unsubscribed, the control renders and tapping it calls an injected `enablePush` seam. (b) When `pushUnsupportedReason` is non-null, the control is absent (or shows the honest reason, matching the existing Settings panel's behaviour — read `PushNotificationsPanel.tsx` and mirror it). (c) When already subscribed, absent.

- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement**, injecting the same test seams the Settings panel uses (`enablePush`, `subscribed`, env) so it is testable without a real service worker.
- [ ] **Step 4: Green**, including the 12 qualifications suite and `notAGate.test.tsx` (this adds an optional control, blocks nothing).
- [ ] **Step 5: Bite.** Remove the `pushUnsupportedReason === null` guard → the "hidden when unsupported" test fails. Restore.
- [ ] **Step 6: Commit**, `feat(onboarding): offer a notification for the forwarding confirmation`.

---

### Task 5: Verify — adversarial pass on the abuse gate

The relaxation of "quarantined mail never pushes" is the one security-sensitive change. A reviewer attacks the gate in Task 2:

- Can a stranger who knows an address make an already-set-up user's phone buzz? (Must be no — `HasConfirmedAnySender` blocks it.)
- Can an unsigned/envelope-only message push? (No — condition 2.)
- Can a bank message, or a bank-behind-forwarder, push? (No — conditions 1 and 3.)
- Does the push stay content-free on the wire? (Yes — `Notify(userID)` only.)
- Does a message that fails to store (rolled back) still push? (Must not — push is after durable store, like the append path's own ordering.)

Findings become failing tests; if the gate holds, report HOLDS with the attacks tried.

---

## Execution notes (coordinator)

- Order: Task 1 → Task 2 (Task 2 needs Task 1). Tasks 3 and 4 are frontend, disjoint files, parallel with each other and with Task 2. Task 5 after Task 2.
- After all: rebuild the bundle, `scripts/v2-check.sh`, merge, deploy per `deploy/README-v2.md` (no migration here; the hash check still applies).
- Note the timing reality for the operator: push during first onboarding only helps a user who took the opt-in; Layer 1 is what catches everyone else. Both were asked for.
