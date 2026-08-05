# Task 25 remediation — cold-start notification-tap wiring

Date: 2026-08-05
Commit: `99a5fa60bb0b89b2ca060858a58e7b6ae03f47ba` (parent `8582ccf`)

## Finding addressed

Critic (`task-25-critic.md`, initial verdict CHANGES REQUESTED): a notification
tap that cold-starts a terminated app never reached the sync seam, because
`onNotificationTap` only installed a live `addNotificationResponseReceivedListener`
and nothing consumed `getLastNotificationResponseAsync()`.

## Investigation

The critic's own remediation-review history (already present in
`task-25-critic.md`, ending "Final remediation re-review — approved") showed
that `app/src/push/native.ts` (`expoNotificationTaps`) and `app/src/push/service.ts`
(`installNotificationTapHandling`, with promise-keyed de-duplication between the
cold-start response and the live listener, error routing via `onLiveError`, and
13 passing tests) were **already implemented and committed** at HEAD
(`8582ccf`) — identical to HEAD, no working-tree diff. So the logic layer the
critic asked for was done.

But per AGENT-RULES' named failure mode ("written, tested green, never
wired"), I grepped for non-test callers of `installNotificationTapHandling`,
`expoNotificationTaps`, and the older `onNotificationTap` before touching
anything:

```
grep -rn "installNotificationTapHandling\|expoNotificationTaps\|onNotificationTap" app/src --include="*.ts" --include="*.tsx"
```

Result: only their own definitions in `app/src/push/{native,service}.ts` and
their tests in `app/src/push/service.test.ts`. **Zero non-test callers.**
`app/src/app/runtime.native.ts`, `RuntimeProvider.tsx`, `Root.tsx`,
`bootstrap.ts` — the entire native composition/startup path — had no
reference to push at all. This is the exact defect the critic named, just one
layer up from where the critic looked (it reviewed the logic module, not the
startup graph).

I also found that `app/src/sync/coordinator.ts` already declares
`SyncTrigger = "launch" | "foreground" | "refresh" | "notification" | "retry"`
— the `"notification"` trigger existed in the type but, before this change,
was never passed to `coordinator.run(...)` anywhere in the codebase. This is
exactly the seam the wiring needed.

## Fix

`app/src/app/runtime.native.ts` is the native composition root: it already
assembles `productionRuntime()` as the singleton `AppRuntime` from
native-only pieces (`expoDriver`, `keychainSecretStore`, `AppState`), and
`RuntimeProvider`'s default `factory` parameter is `productionRuntime` — so
every real launch (`index.ts` -> `registerRootComponent(Root)` -> `Root.tsx` ->
`RuntimeProvider` with no `runtime` prop -> `factory()`) calls it. Inside the
`if (singleton === null)` guard (so it installs exactly once per process),
added:

```ts
void installNotificationTapHandling(
  expoNotificationTaps(),
  () => runtime.coordinator.run("notification"),
  (error) => { console.warn("push: live notification sync failed", error); },
).then((unsubscribe) => {
  if (singleton === runtime) notificationTapUnsubscribe = unsubscribe;
  else unsubscribe();
}).catch((error: unknown) => {
  console.warn("push: notification tap handling failed to install", error);
});
```

and `disposeProductionRuntime()` now calls `notificationTapUnsubscribe?.()`
before disposing the runtime, so device/dev teardown does not leak the
listener subscription.

This puts the Expo API call behind the existing native seam
(`expoNotificationTaps()`, called only from this native-only file) and keeps
the decision logic (`installNotificationTapHandling`) in the already-tested
pure module — no new logic was added, only the wiring call.

## De-duplication (already implemented, verified, not re-litigated)

`installNotificationTapHandling`'s de-dup is keyed on the notification
response's `id` mapped to the **in-flight promise**
(`Map<string, Promise<void>>`), not a boolean — this is what the critic's
second-round review specifically required, and it is what's at HEAD:

- If the cold-start `lastResponse()` and the live listener race for the same
  tap `id`, the second caller awaits the first's promise rather than starting
  a duplicate sync or clearing the durable response before it settles.
- A rejected startup sync leaves the last-response un-cleared (so it isn't
  silently lost) and propagates the rejection out of
  `installNotificationTapHandling` rather than becoming an unhandled promise
  rejection.
- Live failures after successful installation are routed to the new
  `onLiveError` callback, wired here to `console.warn` (no existing
  app-level error-reporting seam exists in `app/src` to route through
  instead — this is the same class of console-based reporting used nowhere
  else yet, since nothing else in the app logs; a follow-up richer
  observability seam is out of this task's scope and was flagged as
  non-blocking by the critic's final review).

I did not modify `service.ts`/`native.ts`/`service.test.ts` — they already
satisfied the critic's final "approved" state and remain unchanged (confirmed
byte-identical to HEAD before I touched anything).

## Wiring proof — non-test caller

```
$ grep -rn "installNotificationTapHandling" app/src --include="*.ts" --include="*.tsx" | grep -v test
app/src/app/runtime.native.ts:26:    void installNotificationTapHandling(
app/src/push/service.ts:110:export async function installNotificationTapHandling(
```

Call chain to real app startup:
`app/index.ts` (`registerRootComponent(Root)`) -> `app/src/app/Root.tsx`
(`<RuntimeProvider>` with no `runtime` prop, so its default `factory =
productionRuntime` applies) -> `app/src/app/RuntimeProvider.tsx` (`useState(()
=> runtime ?? factory())`) -> `app/src/app/runtime.native.ts`'s
`productionRuntime()`, which now calls `installNotificationTapHandling(...)`
inside its `singleton === null` initialization block.

## Verification

```
cd app && bunx tsc --noEmit         # exit 0
cd app && bun test src/push/        # 9 pass, 0 fail, 28 expect() calls
```

Full gate, at commit `99a5fa60bb0b89b2ca060858a58e7b6ae03f47ba`:

```
go clean -testcache && bash scripts/v2-check.sh > /tmp/w2gate.log 2>&1; echo $?
# 0
```

`tail -5` of the log: `2350 pass, 0 fail, 31139 expect() calls, Ran 2350
tests across 35 files. v2-check: OK (go + client + conformance)`. The
`goose_db_version does not exist` lines earlier in the log are Postgres
notices from the migration-gap tests intentionally probing a fresh schema,
not failures — the script's own exit code is 0.

`git show --stat` on the remediation commit confirms exactly one file changed
(`app/src/app/runtime.native.ts`, 20 lines added).

## Scope note

Push registration itself (`PushRegistration.register()`/`unregister()`) is
still not called from any non-test file — the original task-25-report.md
recorded this as an explicit, deliberate scope boundary ("route-ready
services; runtime/navigation ownership is intentionally left to the
composition task") and the critic's finding was specifically about the tap
*response* seam, not registration. I left registration wiring untouched: it
is a distinct decision (where in onboarding/settings to request permission
and register a token) that the critic did not flag and that is not safely
inferable from this task alone.
