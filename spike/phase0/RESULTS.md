# Phase 0 results

## Phase 0 verdict (summary)

Phase 0 has two independent exit gates (spec §5). Both are resolved:

| Gate | Verdict | One-line reason |
|---|---|---|
| Port 25 (spec §3.2 precondition) | **GO** | 4/5 geographically diverse external probes handshook Hetzner's public :25; the 5th is explained by the probe node's own outbound restriction, not a Hetzner block. |
| On-device replay spike (spec §3.3/§4 trade-off 2) | **PROVISIONAL PASS** | Median cold restore (58.0s) is well over the 10s budget, but `decryptMs` (pure-JS X25519+GCM) is 94.3% of it; the non-crypto remainder (3.3s) fits comfortably, and warm start (13ms) is far inside the 2s budget. The provisional is conditioned on a mandatory early Phase 2 native-crypto benchmark (see below). |

Phase 1 planning is unblocked, with the native-crypto benchmark carried forward as a named early Phase 2 task rather than a Phase 0 blocker — see "Replay spike" below for the full reasoning, numbers, and caveats.

## Port 25

**Task:** Spike A — empirically determine whether this server's provider permits
inbound TCP/25, which gates the self-hosted SMTP ingestion design in v2 spec §3.2.

### Host identity

- Public IPv4: `178.104.132.41` (via `curl -4 -s ifconfig.me`)
- Provider (RIPE whois): **Hetzner Online GmbH**, netname `CLOUD-NBG1`
  (Nuremberg, DE datacenter), route `178.104.0.0/15`, origin `AS24940`,
  descr `HETZNER-DC`. Abuse contact `abuse@hetzner.com`.
- This is a Hetzner **Cloud VPS** address block, not a residential/ISP range
  and not CGNAT (`100.64.0.0/10`) — so the near-certain-block heuristic from
  the brief's Step 2 does not apply here. The box is reached day-to-day over
  Tailscale (`tailscale0`), but the probe in this spike targets the *public*
  interface, which is what an inbound SMTP MTA would need to reach.

### Local network state before probing

- `ss -tlnp | grep -E ':25 |:2525 '` → both free before starting listeners.
- `ufw status verbose` (active): default **deny incoming**, with only
  `tailscale0` allowed inbound. No pre-existing rule for 25 or 2525.
- `iptables -L INPUT -n`: policy `DROP`, traffic routed through `ts-input` and
  `ufw-*` chains (Tailscale + ufw stack) — consistent with ufw's reported
  state, no third-party firewall layer found.
- Because ufw defaults to deny-incoming on the public interface, it was
  temporarily opened for this spike: `sudo ufw allow 25/tcp` and
  `sudo ufw allow 2525/tcp` (both added an IPv4 and IPv6 rule, tagged
  `spike-phase0-temp`). This is a **local** firewall consideration, separate
  from any provider/upstream-network block — see verdict below for why this
  matters to the interpretation.

### Listeners

- `sudo python3 -m http.server 25 --bind 0.0.0.0` (root, privileged port) and
  `python3 -m http.server 2525 --bind 0.0.0.0` (control) were started as
  background processes.
- Confirmed both bound via `ss -tlnp` (pids on `0.0.0.0:25` and
  `0.0.0.0:2525`) and both answered locally: `curl 127.0.0.1:25/` and
  `curl 127.0.0.1:2525/` each returned `HTTP 200`.

### External probe (check-host.net, `check-tcp`, `max_nodes=5`)

Port 25 — nodes queried: Iran (Shiraz), Italy (Milan), Netherlands (Meppel),
Sweden (Stockholm), Ukraine (Kyiv).

| Node | Result |
|---|---|
| ir3 (Iran) | connected, 0.090s |
| it2 (Italy) | connected, 0.025s |
| nl2 (Netherlands) | connected, 0.013s |
| se1 (Sweden) | connected, 0.023s |
| ua3 (Ukraine) | **error: Connection timed out** |

4/5 nodes completed a TCP handshake against `178.104.132.41:25`. A
provider-level inbound block on port 25 would fail *every* external probe
uniformly, regardless of which node originates it — a single successful
handshake is already sufficient to rule that out, and here four independent,
geographically diverse nodes succeeded. That makes the outcome dispositive
for the question this spike asks (does Hetzner/this host block inbound 25),
independent of what happened with the fifth node.

The ua3 (Kyiv) timeout is therefore not evidence of a Hetzner-side block; the
most plausible explanation is that ua3 itself — a check-host.net probe node
running on its own commodity hosting — has outbound TCP/25 blocked by *its*
provider, which is the single most common cause of exactly this signature
(one node fails to originate a connection to 25 from anywhere) and is a
well-known limitation of public TCP-checker services, not a property of the
target. This is a plausible explanation, not a confirmed one — it was not
independently verified (e.g. by asking ua3 to probe a known-open port 25
elsewhere) — but no re-probing was required to reach the verdict, since the
four successes already answer the question.

Port 2525 (control) — nodes queried: Switzerland (Zurich), Cyprus (Larnaca),
Spain (Madrid), Spain (Barcelona), India (Delhi).

| Node | Result |
|---|---|
| ch2 (Switzerland) | connected, 0.010s |
| cy1 (Cyprus) | connected, 0.062s |
| es1 (Spain/Madrid) | connected, 0.037s |
| es2 (Spain/Barcelona) | connected, 0.031s |
| in2 (India) | connected, 0.181s |

5/5 nodes connected. Note that check-host.net assigns a fresh, randomly
selected node set per request — the control's five nodes (ch2, cy1, es1, es2,
in2) are entirely disjoint from port 25's five (ir3, it2, nl2, se1, ua3); ua3
was never asked to probe 2525, so this control says nothing about whether ua3
specifically can reach this host at all, and it cannot be used to argue that
ua3's port-25 timeout is anomalous relative to "the same node on the control."
What the control *does* establish is that the probe method itself works end
to end (public routing, the temporary ufw hole, the listener) — a clean 5/5
here confirms the harness is capable of producing all-success results, which
matters mainly as a sanity check and would become the load-bearing evidence
only in the scenario where port 25 saw zero connections (i.e. it disambiguates
"nothing reached us because the harness is broken" from "nothing reached us
because 25 is blocked" — the case that didn't occur here).

Raw JSON for both requests is preserved in the check-host.net permanent
report links captured during the run (`check-report/45fca7a8k2db` for :25,
`check-report/45fca869kcf` for :2525) and was also saved locally to the
session scratchpad during execution.

### Verdict: **GO**

Hetzner does **not** block inbound TCP/25 on this host. The verdict rests on
the four successful external handshakes to port 25 (Iran, Italy, Netherlands,
Sweden): a provider-level inbound-25 block would produce failures across the
board, so even one success would be dispositive, and four independent,
geographically diverse successes make the case solidly. The fifth node's
(ua3, Kyiv) timeout does not weigh against this — it is most plausibly that
probe node's own outbound-25 restriction (a common limitation of TCP-checker
services), not a signal about this host or Hetzner. The control port (2525,
5/5) is not being used here to explain away the ua3 timeout — its nodes were
disjoint from port 25's and it says nothing about ua3 specifically — it
served only to confirm the probe harness itself is capable of reaching this
host end to end, which was not otherwise in doubt given four raw successes on
25. Self-hosted SMTP ingestion per spec §3.2 is viable on this host's public
interface at the provider level: no provider outreach or unblock request is
needed.

### Cleanup performed

- `sudo pkill -f "http.server 25"` and `pkill -f "http.server 2525"` — both
  processes terminated.
- Confirmed via `ss -tlnp | grep -E ':25 |:2525 '` → no output (both free).
- Confirmed via `ps aux | grep http.server` → no matching processes.
- Reverted the temporary ufw rules: `sudo ufw delete allow 25/tcp` and
  `sudo ufw delete allow 2525/tcp` (each removed both the v4 and v6 rule).
- Final `ufw status verbose` matches the pre-spike state: default deny
  incoming, only `tailscale0` allowed. `iptables -L INPUT -n -v` shows no
  leftover rule referencing 25 or 2525.

### Next steps

The **provider-level** precondition of spec §3.2 is satisfied — no Hetzner
outreach or unblock request is needed. But this spike's cleanup step
(correctly) deleted the temporary ufw rules and restored the host's firewall
to its normal default-deny-incoming state with only `tailscale0` allowed. As
recorded above, that means **port 25 is currently unreachable from the
public internet on this host**, by the host's own firewall rather than by
the provider. Anyone implementing the SMTP receiver from spec §3.2 must not
read this GO verdict as "port 25 already works" — before the receiver ships:

1. Add a permanent `sudo ufw allow 25/tcp` (and the matching v6 rule) when
   the SMTP receiver is ready to bind, scoped as tightly as the design
   allows (e.g. restrict source if the sending MTAs are known, though
   inbound mail generally requires open access).
2. Check the Hetzner Cloud **Firewall** feature at the project/panel level
   (a separate layer from the host's own `ufw`/`iptables`, not inspected in
   this spike) — if a Cloud Firewall is attached to this server, it can
   independently block 25 upstream of the host and must be opened too.

Remaining Phase 0 spikes (B: blob generator, device measurement, etc.) are
independent of this result and can proceed regardless.

## Replay spike

**Task:** Spikes B/C — measure cold-restore and warm-start latency for the
local-first client replaying a real transaction history as **per-op singleton
encrypted blobs** (spec §3.3's honest ingest-writer workload: the ingest
writer cannot batch, so each email is its own sealed 1 KB-bucket blob), on a
real iPhone over the real transport (Expo Go + Tailscale). This is the
workload spec §4 trade-off 2 names explicitly: "~4 MB of hot blobs and ~3,700
HPKE opens on restore."

### Setup

- **Device:** the user's **daily-driver iPhone** — not the oldest available
  device. The plan's protocol preferred the oldest device on hand (worst-case
  hardware); that request was not met here, so this result is an **upper
  bound** — a slower device is expected to measure worse, not better (see
  Caveat 1 below).
- **Client:** Expo Go, SDK 54 (`expo ~54.0.36`, `react-native 0.81.5`,
  `expo-sqlite ~16.0.10` — pinned to match the installed Expo Go build, see
  commit `36421a0`).
- **Transport:** Tailscale, **DERP-relayed** (not a direct peer-to-peer
  connection) — see Caveat 2.
- **Build under test:** commit **`27ba7c6`** ("reuse sqlite connection across
  runs"). This predates `6de466a` ("fix reopen wedge, surface partial-corpus,
  label decode stand-in") — see Caveat 4 for what that means for `dbOpenMs`
  and the memory figures.
- **Corpus:** the real, measured 3,683-transaction corpus generated in Task 2
  (`spike/phase0/blobgen`) — `manifest.json` reports `count: 3683`; `all.bin`
  is 3,741,928 bytes = 3,683 × 1,016-byte fixed records (32B header + 968B
  padded/gzipped payload + 16B GCM tag), i.e. **~3.7 MB**, matching spec
  §3.3's "~4 MB" estimate for a multi-year, two-bank history. Three full
  months of confirmed-debit bucket totals (2026-06, 2026-05, 2026-04) are
  checked against `manifest.json` on every restore as a correctness gate,
  independent of timing.
- **Protocol:** per the brief — one cold restore discarded (JIT/cache
  warm-up), then Reset DB → Cold Restore ×3 with the full breakdown recorded
  each time, then force-quit + relaunch ×3 for warm start. Every run's month
  checks were verified `MATCH` before any timing was trusted.

### Per-run measurements (ms, full precision as captured)

| Run | dbOpenMs | fetchMs | decryptMs | decodeMs | insertMs | computeMs | yieldMs | totalMs |
|---|---|---|---|---|---|---|---|---|
| 1 | 37.951083064079285 | 2738.8313339948654 | 61331.62491559982 | 612.2390429973602 | 314.85349917411804 | 0.6539579629898071 | 1.9453752040863037 | 65038.09920799732 |
| 2 | 44.441583037376404 | 2469.831041932106 | 52138.37249994278 | 501.5009980201721 | 265.0840848684311 | 0.6283340454101562 | 1.535750150680542 | 55421.394291996956 |
| 3 | 46.168707966804504 | 2466.583792090416 | 54712.961748838425 | 526.5069608688354 | 271.0302052497864 | 0.7506250143051147 | 4.198752045631409 | 58028.2007920742 |

Every run: `ops=3683/3683` (no partial corpus, no `VOID` banner), and
`2026-06: MATCH`, `2026-05: MATCH`, `2026-04: MATCH`. Warm start: **13ms**,
identical across all three post-relaunch measurements.

### Medians and derived figures

| Field | Median (ms) |
|---|---|
| totalMs | 58028.20 |
| decryptMs | 54712.96 |
| fetchMs | 2469.83 |
| decodeMs | 526.51 |
| insertMs | 271.03 |
| dbOpenMs | 44.44 |
| computeMs | 0.654 |
| yieldMs | 1.945 |

- `decryptMs` is **94.3%** of median `totalMs`.
- Median `totalMs` − median `decryptMs` = **3315.24 ms**.
- Non-crypto stages excluding fetch (`dbOpenMs + decodeMs + insertMs +
  computeMs + yieldMs`, medians) = **844.6 ms**.
- Per-blob decrypt cost: 54712.96 / 3683 = **14.86 ms/blob**.
- Warm start: **13 ms**, all three runs identical.

### Memory (Hermes `performance.memory`, JS-heap only)

Sampling was point-in-time (before/after-compute/end per run — see Caveat 4
for why this build doesn't have per-chunk peak sampling), so the sequences
below have different sample counts per metric; transcribed as captured
rather than forced into a uniform per-run table:

- **`js_heapSize`:** 8,388,608 bytes (8 MB) before run 1 → 16,777,216 bytes
  (16 MB) → 20,971,520 bytes (20 MB). **Bounded** across the three runs.
- **`js_totalAllocatedBytes`** (cumulative across the session): 6,687,455,472
  → 13,361,724,032 → 20,039,266,568 — i.e. **~6.7 GB allocated per run**
  (consistent ~6.7 GB deltas between samples).
- **`js_numGCs`** (cumulative across the session, 4 samples: a baseline
  reading plus one after each of the three runs): 4 → 1,648 → 3,291 → 4,934
  — i.e. **~1,643 GCs per run** (deltas: 1,644, 1,643, 1,643).
- **`js_externalBytes`**: ~12.5 MB, stable.

Reading these together: the heap **ceiling** is bounded (8 → 16 → 20 MB),
nowhere near the >500 MB RSS the pre-fix build hit (see "Pre-fix catastrophic
run" below) — but see Caveat 6, this is JS heap, not RSS, and the two must
not be equated. The **allocated/GC** figures — ~6.7 GB allocated and ~1,643
GCs, per single cold restore, to process 3.7 MB of input — are strong
empirical confirmation of the allocation-churn theory from the pre-fix
incident (see below): pure-JS X25519 (BigInt arithmetic) and the pure-JS
`TextDecoder` polyfill are both allocation-heavy per record, ×3,683 records.

A 4th press (attempted beyond the 3-run protocol) failed with
`TypeError: Network request timed out` — the DERP-relayed 3.7 MB fetch
timing out, not an app defect (see Caveat 2).

### Decision rule applied

Per the plan's rule (`task-4-brief.md` Step 4):

> Cold over budget but `decryptMs` is the dominant stage and (totalMs −
> decryptMs) fits comfortably → **PROVISIONAL PASS**.

- Median cold (58.03s) is far over the 10s target — the strict PASS branch
  does not apply.
- `decryptMs` is 94.3% of total — dominant by a wide margin.
- `totalMs − decryptMs` = 3.3s — comfortably under the 10s budget on its own,
  and would remain so even with generous slack for a slower device.
- `fetchMs + insertMs + computeMs` alone (2469.83 + 271.03 + 0.654 = 2741.5
  ms) is nowhere near the budget — the FAIL branch ("these alone approach the
  budget") does not apply either.
- Warm start (13 ms) is far inside the 2s budget.
- Correctness is unconditional: `ops=3683/3683` and all three month checks
  `MATCH` on every one of the three runs.

**Verdict: PROVISIONAL PASS.**

### Why the provisional is defensible (projection, not measurement)

Pure-JS X25519 + AES-GCM (via `@noble`'s BigInt-based scalar arithmetic) is
the plan's acknowledged known-slow stand-in for the production design, which
uses native JSI-bound crypto. At the measured **14.86 ms/blob**, applying the
plan's cited 10–100× native-JSI speedup range:

| Assumed native-JSI factor | Projected decrypt | Projected cold (+3.3s non-crypto) |
|---|---|---|
| 10× (conservative) | ~5.5s | **~8.8s** — inside the 10s gate |
| 50× | ~1.1s | **~4.4s** — comfortably inside |

These are **projections, clearly labeled as such — not measurements.** No
native-JSI crypto benchmark has been run on-device. They exist only to show
that the provisional's central bet (that decrypt, not architecture, is the
bottleneck) is arithmetically plausible under the plan's own stated speedup
range, not to substitute for actually measuring it.

**Mandatory Phase 2 follow-up (per the decision rule):** a native-crypto
(JSI) benchmark of X25519 + AES-GCM open, on-device, over this same corpus
shape, is a **mandatory early Phase 2 task** before this provisional is
trusted for the production cold-restore budget.

### Pre-fix catastrophic run (historical context, real finding)

Before the build measured above, an earlier device attempt on a pre-`ccc9350`
build (no chunking, no yielding, unbounded connection reuse) hit **>500 MB
RSS** on the Expo perf monitor, **JS FPS 0** (JS thread fully blocked), and
**froze after the 2nd cold restore** — a 3rd press was impossible, so the
measurement protocol could not complete at all on that build.

Server-log evidence (`blobserver.log`, phone `100.100.215.38`) for that
pre-fix session (18:12–18:16): individual restore presses at 18:12:01,
18:13:08, 18:14:04, 18:15:31, then a **burst of ~39 `all.bin` fetches within
18:16:28–18:16:29** — roughly 144 MB of 3.7 MB bodies requested in ~2 seconds.
Only 2 `manifest.json` fetches occurred across the whole session versus 47
`all.bin` fetches total, so the storm re-fetched the blob body specifically,
not the manifest. No broken-pipe or error output appeared in the server log.
This burst timing coincides exactly with the reported RAM explosion and
freeze.

**Root cause, per review — NOT whole-corpus retention.** The two-pass
decrypt-then-decode structure held ~3,683 decrypted plaintexts and ~3,683
parsed `Op` objects live at once, which looked like an obvious culprit, but
quantified out to only **~5–8 MB of actual retained data** at peak (small
transaction records) — nowhere near 500 MB. The more plausible driver:
**allocation churn outrunning Hermes' garbage collector inside a loop that
never yields** — 3,683 X25519 scalar multiplications through `@noble`'s
BigInt arithmetic, plus 3,683 calls into Expo's pure-JS `TextDecoder`
polyfill (each allocating multiple intermediate arrays), all running
back-to-back synchronously with no `await` between them and therefore no
opportunity for the collector to reclaim short-lived garbage as it went. A
second, independent contributor was confirmed separately: `expo-sqlite`'s
`openDatabaseSync` opened a brand-new native connection on every "Cold
Restore" press with nothing closing the previous one — native-side memory
entirely outside the JS heap and outside anything JS-side chunking or GC
pressure could reclaim.

**The fix that mattered was yielding between chunks**, not merely bounding
the retained working set: chunking the corpus into groups of `CHUNK_SIZE =
250` records with an `await new Promise(r => setTimeout(r, 0))` between
chunks gives Hermes' collector repeated opportunities to run at all.
`CHUNK_SIZE` is the tuning knob if a slower/older device's RAM climbs again.
The connection leak was fixed separately (a single reused/reopened
connection). Post-fix, the exact same server log shows a clean session
(18:41–18:44): precisely 3 `all.bin` fetches (18:41:36, 18:43:01, 18:44:01),
no burst — these are the three runs in the measurement table above, and the
~60–85s spacing between them is confirmed as genuine per-restore duration
(consistent with the ~58s median measured), not user pacing.

This is recorded here because it is a genuine finding about pure-JS crypto's
allocation behavior on Hermes under a naive (non-yielding) implementation,
independent of the raw `decryptMs` timing, and it directly informs the
native-crypto decision above: even setting aside the raw wall-clock cost,
pure-JS crypto at this volume produces GC pressure (~6.7 GB allocated, ~1,643
GCs per restore, per the memory table above) that a native implementation
would avoid by construction.

### Caveats

1. **Daily iPhone, not oldest.** The user's daily-driver device was used, not
   the oldest available one the plan's protocol preferred. This is an
   **upper-bound** result — the oldest-device case remains unverified and is
   expected to measure worse.
2. **`fetchMs` is inflated and not representative.** The phone reached the
   server over a Tailscale **DERP relay**, not a direct connection, and a 4th
   press timed out entirely (`Network request timed out`) fetching the same
   3.7 MB body. Do not treat the measured 2.47s median `fetchMs` as
   representative of real-world fetch cost; a direct connection or a
   production server path would very likely measure differently in either
   direction.
3. **`decodeMs` is also a stand-in, not real work.** On Expo SDK 54 / RN
   0.81, `global.TextDecoder` is Expo's winter-runtime polyfill (a fork of
   the `text-encoding` package) — per record it converts the `Uint8Array` to
   a plain `number[]` via slice+reverse, pops byte-by-byte through a handler
   loop, and builds the string via per-code-point concatenation. This is in
   the same known-slow class as `decryptMs`, not a measurement of production
   decode cost. This matters because the plan's decision rule has no
   explicit branch for a dominant `decodeMs` — it is folded into the "3.3s
   non-crypto remainder" above, which is fine at its current small share
   (526.51ms of 3315.24ms) but would need separate handling if it ever grew
   to dominate.
4. **Build caveat: these runs predate `6de466a`.** The build under test
   (`27ba7c6`) is one commit before the fix that split `dbOpenMs` cleanly
   from `keyDeriveMs`/`resetMs`. Concretely, `dbOpenMs` here still silently
   includes one X25519 `derivePub` call and the `DELETE FROM transactions`
   reset — immaterial in magnitude (44ms) but worth stating precisely. Also,
   the memory figures above are three point-in-time before/after samples,
   not the per-chunk running-maximum sampling added in `6de466a` — so the
   true **mid-run peak** heap usage was not captured here; the reported 8→16
   →20 MB progression is evidence of a bounded ceiling across runs, not proof
   of the peak within any single run. The heap-ceiling and GC-count evidence
   above is still strong evidence of boundedness even so.
5. **The pre-fix catastrophic run is part of this record**, not a separate,
   discarded incident — see the dedicated section above. Root cause was
   allocation churn outrunning the collector in a never-yielding loop (plus
   an independent SQLite connection leak), **not** whole-corpus retention
   (actual retention was ~5–8 MB). This is real evidence about pure-JS
   crypto's behavior on Hermes and feeds directly into the native-crypto
   Phase 2 task above.
6. **JS-heap figures are not RSS.** The 8/16/20 MB `js_heapSize` figures in
   the memory table measure the Hermes JS heap only; they must never be
   equated with the pre-fix build's >500 MB RSS figure, which included
   native allocations (SQLite connections, engine overhead, image/font
   caches) entirely outside the JS heap.

### Verdict: **PROVISIONAL PASS**

The replay spike passes provisionally: correctness is unconditional (3/3
runs, full corpus, all month checks `MATCH`), warm start is far inside
budget, and cold restore's overage is concentrated almost entirely (94.3%) in
a stage the architecture already expects to replace with native crypto before
production. The provisional is not free — it is conditioned on the
**mandatory early Phase 2 native-crypto (JSI) benchmark** actually landing in
the 10–100× range the projection above assumes; if it doesn't, this verdict
must be revisited before Phase 3 turns crypto on for real users (spec §5
Phase 3). Phase 1 planning (plaintext backend, per spec §5) is unblocked in
the meantime, since Phase 1 does not depend on the crypto path being fast.
