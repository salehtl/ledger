# Phase 0 results

## Phase 0 verdict (summary)

Phase 0 has two independent exit gates (spec §5). Both are resolved:

| Gate | Verdict | One-line reason |
|---|---|---|
| Port 25 (spec §3.2 precondition) | **GO** | 4/5 geographically diverse external probes handshook Hetzner's public :25; the 5th is explained by the probe node's own outbound restriction, not a Hetzner block. |
| On-device replay spike (spec §3.3/§4 trade-off 2) | **PROVISIONAL PASS** | Median cold restore (58.0s) is well over the 10s budget, but `decryptMs` (pure-JS X25519+GCM) is 94.3% of it; the non-crypto remainder (3.3s) fits comfortably — though ~75% of that remainder is `fetchMs`, itself flagged below as inflated and unrepresentative. The measured 13ms figure is a post-mount SQLite read, not first paint — the spec's <2s **first-paint** criterion is unmeasured in Phase 0. The provisional is conditioned on a mandatory early Phase 2 native-crypto benchmark (see below). |

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

**Deviation from spec §3.3, stated up front:** the crypto layer faithfully
models per-op singleton blobs — `openBlob` runs 3,683 times, once per
record, each an independent HPKE-derived AEAD open, exactly as spec §3.3
requires ("every record is individually sealed/opened"). The **transport**
does not model this: the corpus is fetched as one pre-batched `all.bin` HTTP
GET (a single 3.7 MB response), not as 3,683 individual per-blob fetches.
This was a stated, deliberate spike-convenience simplification (Task 2's own
self-review: "`all.bin` is a transport container"), but an earlier draft of
this verdict dropped it. Restating it here because it lands squarely on
`fetchMs` (2.47s median) — one of the stages the plan's FAIL branch
scrutinizes (`fetchMs + insertMs + computeMs`). A production sync of 3,683
individually-transported blobs would plausibly have a different `fetchMs`
shape than one bulk 3.7 MB transfer — likely worse per-request overhead
(TLS/HTTP framing/bridge marshalling ×3,683), partly offset by whatever
batching the real hot-stream sync protocol ends up using. This spike does
not measure that shape; see Caveat 7.

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

Every run: `ops=3683/3683` (full corpus), and `2026-06: MATCH`,
`2026-05: MATCH`, `2026-04: MATCH`.

**Dispersion (n=3):** `totalMs` ranged from 55421.39 ms (Run 2, the minimum)
to 65038.10 ms (Run 1, the maximum) — a spread of ~17% relative to the
minimum. `fetchMs` varied ~11% (2466.58–2738.83 ms) and `decryptMs` ~18%
(52138.37–61331.62 ms) across the same three runs. With only three samples
this is reported as raw variance, not characterized further — no confidence
interval is meaningful at n=3, and it is plausible some of this variance is
thermal (see "Affirmative findings" below). **Gap in the record:** the
protocol's discarded warm-up cold restore (run #0, before Reset DB → the
three runs above, discarded per the brief's cold-start-jank-trap step) was
not itself recorded with a `totalMs` value in what reached this write-up —
so the jank-discard step is not independently auditable from this document.
Flagged as a process gap for any repeat of this protocol, not fixed here.

**Warm start: 13 ms**, identical across all three post-relaunch
measurements. Stating precisely what this covers: it is the wall-clock span
inside the app's warm-start `useEffect` (`App.tsx`) — `SELECT COUNT(*)` plus
`bucketDebits()`'s `GROUP BY` aggregate over the already-populated on-device
SQLite table — timed only *after* process launch, Hermes bundle evaluation,
and React mount have already happened, and ending before any UI re-render.
**It is a SQLite read time, not first paint.** Spec §5's Phase 0 exit
criterion is "cold replay **+ first paint** within an acceptable budget
(target <2s warm...)" — first paint itself was never instrumented in this
spike and is **unmeasured** in Phase 0 (see Caveat 8). Read the 13ms figure
as strong secondary evidence that the on-device query/aggregate layer is not
a bottleneck for a warm relaunch, not as direct evidence the spec's
warm/first-paint budget is met — it doesn't measure that budget's own
gate.

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
- Warm start: **13 ms**, all three runs identical — a SQLite read time, not
  first paint (see the note above and Caveat 8).

### Memory (Hermes `HermesInternal.getInstrumentedStats()`, JS-heap only)

**Correction to the instrument attribution.** The field names below
(`js_heapSize`, `js_totalAllocatedBytes`, `js_numGCs`, `js_externalBytes`)
are `HermesInternal.getInstrumentedStats()`'s own key names, not
`performance.memory`'s (which would report `usedJSHeapSize`/
`totalJSHeapSize`). `sampleMemory()` (`App.tsx`) tries `performance.memory`
first and only falls back to `HermesInternal.getInstrumentedStats()` if
`performance.memory` is absent — the fact that these are the shape actually
captured means **`performance.memory` was not available** in this Expo
Go/SDK 54/iOS runtime, contradicting the code comment's expectation (based
on RN 0.81's documented Hermes mapping) that this fallback branch would be
dead code here.

This has a real consequence beyond the label: `sampleHeapMB()` (`App.tsx`),
which the per-chunk peak-sampling added in `6de466a` depends on, reads
*only* `performance.memory` — deliberately with no `HermesInternal`
fallback, since `getInstrumentedStats()` doesn't guarantee a stable numeric
field to max-track. If `performance.memory` is unavailable on this device
the way it evidently was for this run, `sampleHeapMB()` returns `null` on
every chunk, `memPeak` reports `unavailable`, and `6de466a`'s per-chunk peak
sampling produces **no data at all** here. **Re-running this measurement on
`6de466a` does not, by itself, close the mid-run-peak gap** — that
instrument would need a `HermesInternal` fallback path (or another
per-chunk-capable source) before it could measure a peak on this specific
device. Caveat 4 is corrected accordingly.

Sampling was point-in-time (before/after-compute/end per run in this
build), so the sequences below have different sample counts per metric;
transcribed as captured rather than forced into a uniform per-run table:

- **`js_heapSize`:** 8,388,608 bytes (8 MB) before run 1 → 16,777,216 bytes
  (16 MB) → 20,971,520 bytes (20 MB). Did not exceed 20 MB at these three
  sampled points, and was still rising run-over-run rather than
  plateauing — see the softened framing below.
- **`js_totalAllocatedBytes`** (cumulative across the session): 6,687,455,472
  → 13,361,724,032 → 20,039,266,568 — i.e. **~6.7 GB allocated per run**
  (consistent ~6.7 GB deltas between samples).
- **`js_numGCs`** (cumulative across the session, 4 samples: a baseline
  reading plus one after each of the three runs): 4 → 1,648 → 3,291 → 4,934
  — i.e. **~1,643 GCs per run** (deltas: 1,644, 1,643, 1,643).
- **`js_externalBytes`**: ~12.5 MB, stable.

Reading these together, stated carefully: the heap did **not exceed 20 MB
at the three sampled points** (before/after-compute/end — not a within-run
peak, per the correction above), nowhere near the >500 MB RSS the pre-fix
build hit (see "Pre-fix catastrophic run" below) — but see Caveat 6, this is
JS heap, not RSS, and the two must not be equated. With n=3 monotonically
*rising* samples, no within-run peak, and no RSS correlate, this is
"no growth beyond 20 MB observed at these sample points, still climbing
run-over-run" — not proof of a bounded ceiling; see Caveat 4. The
**allocated/GC** figures — ~6.7 GB allocated and ~1,643 GCs, per single cold
restore, to process 3.7 MB of input — do confirm that pure-JS X25519
(BigInt arithmetic) and the pure-JS `TextDecoder` polyfill are both heavily
allocation-churning per record, ×3,683 records; see "Pre-fix catastrophic
run" below for what this does and does not explain about the earlier
incident.

A 4th press (attempted beyond the 3-run protocol) failed with
`TypeError: Network request timed out`. This is *plausibly* the
DERP-relayed 3.7 MB fetch being flaky under repeated load rather than an
app defect, but that is not independently confirmed for this specific
session: the only server-log evidence of request-storm-shaped behavior in
this document (the ~39-fetch burst, below) comes from the earlier,
different, pre-fix build/session — no server-log check was made for this
particular 4th-press timeout. Treat "not an app defect" as a hypothesis,
not a finding (see Caveat 2).

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
- Warm start (13 ms) is a strong secondary signal, not a direct pass against
  the spec's warm/first-paint budget: it measures a post-mount SQLite read,
  not first paint, which is unmeasured in Phase 0 (see the note above and
  Caveat 8). It is not scored against the 2s target here.
- Correctness is unconditional: `ops=3683/3683` and all three month checks
  `MATCH` on every one of the three runs.

**Verdict: PROVISIONAL PASS**, resting on the cold-restore decomposition
(decrypt dominant, non-crypto remainder small) and unconditional
correctness — not on the warm-start figure, which doesn't measure the
budget it would need to measure to count as evidence either way.

### Why the provisional is defensible (projection, not measurement)

Pure-JS X25519 + AES-GCM (via `@noble`'s BigInt-based scalar arithmetic) is
the plan's acknowledged known-slow stand-in for the production design, which
uses native JSI-bound crypto. At the measured **14.86 ms/blob**, applying the
plan's cited 10–100× native-JSI speedup range, and decomposing the flat
"+3.3s non-crypto" addend into its two components so the disclaimed one is
visible rather than hidden inside a lump sum:

| Assumed native-JSI factor | Projected decrypt | + fetchMs (2.47s, disclaimed — Caveat 2) | + other non-crypto (0.84s) | Projected cold |
|---|---|---|---|---|
| 10× (conservative) | ~5.5s | 2.47s | 0.84s | **~8.8s** — inside the 10s gate |
| 50× | ~1.1s | 2.47s | 0.84s | **~4.4s** — comfortably inside |
| 100× | ~0.5s | 2.47s | 0.84s | **~3.9s** — comfortably inside |

These are **projections, clearly labeled as such — not measurements.** No
native-JSI crypto benchmark has been run on-device. They exist only to show
that the provisional's central bet (that decrypt, not architecture, is the
bottleneck) is arithmetically plausible under the plan's own stated speedup
range, not to substitute for actually measuring it.

**The margin is thin, and it is not free.** At 10×, the projected ~8.8s
clears the 10s gate by only **~12%** — and roughly 75% of the "+3.3s"
addend it relies on is `fetchMs`, the same figure Caveat 2 says is inflated
by the DERP relay and not representative of production networking. This
projection also does not include the unmeasured first-paint cost (Caveat
8) or Caveat 1's expectation that an older device measures worse across the
board, not only at crypto. Stack those three — a less favorable real-world
`fetchMs`, a nonzero first-paint cost on top, and a slower (non-daily,
non-current) device — and the 10× row's margin can plausibly evaporate. The
50× and 100× rows have enough headroom to absorb this; the 10× row does
not. **This projection shows the provisional's central bet is plausible,
not that the 10× case is safely proven** — it survives only if real-world
fetch and first paint stay roughly where (or better than) they were
measured here.

**Mandatory Phase 2 follow-up (per the decision rule):** a native-crypto
(JSI) benchmark of X25519 + AES-GCM open, on-device, over this same corpus
shape, is a **mandatory early Phase 2 task** before this provisional is
trusted for the production cold-restore budget (now also recorded in spec
§5's Phase 2 entry).

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

**Root cause — corrected here a second time.** The write-up this section
originally drew on already ruled out whole-corpus retention (the two-pass
decrypt-then-decode structure held ~3,683 decrypted plaintexts and ~3,683
parsed `Op` objects live at once, which quantified out to only **~5–8 MB of
actual retained data** at peak — nowhere near 500 MB) and then named
**allocation churn outrunning Hermes' garbage collector** as "the more
plausible driver." Re-reading that claim against this same document's own
evidence, it does not hold up as stated, and is corrected here.

The server log above already supplies a **sufficient** explanation without
invoking churn at all: a burst of ~39 `all.bin` fetches within ~2 seconds is
~144 MB of concurrently- or rapidly-sequentially-live 3.7 MB response
bodies (plus RN bridge-marshalling copies of each), which is on the order
of hundreds of MB by itself — before adding the second, independently
confirmed bug: `expo-sqlite`'s `openDatabaseSync` opening a brand-new native
connection on every "Cold Restore" press with nothing closing the previous
one (native-side page cache/journal/WAL state, entirely outside the JS
heap). **Together, the request storm and the connection leak are
arithmetically sufficient to explain >500 MB RSS on their own** — two
confirmed instrument bugs, not an architectural property of pure-JS crypto.

Allocation churn, by contrast, is **not shown to be sufficient**, and this
document's own post-fix data argues against it being the dominant driver:
the fixed build allocates ~6.7 GB and triggers ~1,643 GCs *per single cold
restore* (see the memory section above), yet the heap ceiling stays at
20 MB. Large allocation churn coexisting with a small, non-growing live set
is the signature of a collector doing its job — rapid allocate-and-reclaim —
not of churn driving sustained high RSS. If churn were the dominant pre-fix
driver, a rising or elevated retained/heap figure would be the more natural
signature to expect; that isn't what the post-fix numbers show.
**Allocation churn is therefore demoted from "the more plausible driver" to,
at most, a plausible contributing factor** — the request storm plus the
connection leak are the better-evidenced explanation.

One plausible (not confirmed) mechanism for how 39 fetches could cluster
into a 2-second window: the pre-fix build had no `isRunning` guard against
overlapping presses (that guard was added later, in the same fix pass,
`27ba7c6`), and a JS thread reporting FPS 0 gives no visual feedback that a
restore is already in progress — a user re-pressing what looks like an
unresponsive button, with each press starting its own full `coldRestore()`
including its own `fetch(all.bin)`, is one route to a burst of
near-simultaneous fetches. There is no client-side interaction log for that
session to confirm this, but the guard's later, independent addition is at
least consistent with the failure mode this theory describes.

**The fix that shipped addressed both confirmed bugs, not just one:**
chunking the corpus into groups of `CHUNK_SIZE = 250` records with an
`await new Promise(r => setTimeout(r, 0))` between chunks (which also gives
the collector repeated opportunities to run, whatever churn's actual share
of the pre-fix figure was), plus a separate fix reusing/closing a single
SQLite connection instead of leaking one per press, plus (in the same pass)
the `isRunning` guard against overlapping presses that the request-storm
theory above depends on. Post-fix, the exact same server log shows a clean
session (18:41–18:44): precisely 3 `all.bin` fetches (18:41:36, 18:43:01,
18:44:01), no burst — these are the three runs in the measurement table
above, and the ~60–85s spacing between them is confirmed as genuine
per-restore duration (consistent with the ~58s median measured), not user
pacing.

This remains worth recording for a reason independent of the root-cause
debate above: regardless of which factor(s) explain the pre-fix >500 MB
figure, the post-fix data separately confirms that pure-JS X25519 (BigInt
arithmetic) and the pure-JS `TextDecoder` polyfill do produce real,
substantial allocation/GC pressure on Hermes (~6.7 GB allocated, ~1,643 GCs,
per single cold restore, per the memory section above) — cost a native
implementation would avoid by construction. That is presented here as a
secondary data point supporting the Phase 2 native-crypto benchmark, not as
the explanation for the pre-fix crash.

### Affirmative findings

This document has been scrupulous about weaknesses above; it should be
equally precise about strengths.

- **`computeMs` = 0.65 ms is the strongest single result in this spike.** A
  full 3,683-row `GROUP BY`/`substr`/`CASE`/`SUM` budget aggregate over
  SQLite in 0.65 ms is ~0.18 µs/transaction. Combined with `insertMs`
  (271.03 ms for 3,683 rows) and the warm-start SQLite read (13 ms — see
  above for what that figure does and doesn't cover), the entire on-device
  data layer — the actual local-first thesis — is effectively free. Nothing
  about *this* architecture is slow; one library (`@noble`'s pure-JS
  X25519/GCM) is. `computeMs` was previously used only as an input to the
  FAIL-branch check; it deserves to be read affirmatively as validating the
  local-first bet, independent of the crypto question.
- **Cold restore is a once-per-device-install cost**, not a recurring one.
  Every subsequent app open pays the warm-start cost, not the cold-restore
  cost. This frequency framing matters: "58s, once, at onboarding" and "58s
  every time" are different problems even though today's `totalMs` number
  is the same either way, and the spec's <10s target treats it as the
  former.
- **Per-chunk commits mean usable rows exist in SQLite well before the
  restore finishes** — chunk 1 (250 records) commits roughly 3.7–3.9s into
  the run (≈250 × the ~14.9ms/blob decrypt cost, plus decode/insert), and
  under a 50–100× native-crypto speedup that would drop to well under a
  second. The data layer's chunked-commit design already supports a
  progressive "first useful paint" that doesn't wait for the full corpus —
  this instrument doesn't render one, but the underlying mechanism (rows
  land in SQLite as you go) is already there for Phase 2 to build on.
- **More damning, in the same breath: the UI is still frozen in ~3.7–3.9s
  slabs today**, not responsive. The chunk yield (`await setTimeout(0)`)
  restores GC breathing room between chunks — that's what fixed the
  pre-fix freeze/crash — but it is not the same thing as restoring
  responsiveness: total `yieldMs` across an entire ~58s restore is only
  1.9–4.2 ms (see the per-run table), meaning almost none of that 58s is
  actually spent yielded to the event loop. Each chunk is still one long
  synchronous block from the device's perspective. Fixing perceived
  responsiveness, not just crash-safety, is contingent on the same
  unmeasured native-crypto speedup as the cold-restore budget itself: at
  10×, each ~3.8s chunk slab drops to ~380ms (still a visible stall); at
  50–100×, it drops to ~40–80ms, closer to imperceptible.
- **~6.7 GB allocated and ~55s of continuous BigInt math per cold restore is
  plausibly a thermal/battery event, not only a GC story.** Sustained CPU
  load at that volume is a reasonable candidate for driving performance-core
  throttling, and older/cheaper devices throttle sooner and harder than a
  current daily-driver iPhone — meaning Caveat 1's "expected to measure
  worse on an older device" may compound non-linearly (thermal throttling
  partway through a run), not just linearly with raw clock-speed
  differences. Not measured here (no thermal-state API was read), offered as
  a reasoned expectation to carry into the oldest-device follow-up.

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
   direction. The 4th-press timeout is *plausibly* transport flakiness
   rather than an app defect, but this is a hypothesis, not a confirmed
   finding — no server-log check was made for that specific press (the only
   request-storm evidence in this document is from a different, earlier,
   pre-fix session — see the "Pre-fix catastrophic run" section).
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
4. **Build caveat: these runs predate `6de466a`, and re-running on `6de466a`
   would not by itself fix the memory gap.** The build under test
   (`27ba7c6`) is one commit before the fix that split `dbOpenMs` cleanly
   from `keyDeriveMs`/`resetMs`. Concretely, `dbOpenMs` here still silently
   includes one X25519 `derivePub` call and the `DELETE FROM transactions`
   reset — immaterial in magnitude (44ms) but worth stating precisely. Also
   — and this is a correction from an earlier draft of this write-up — the
   memory figures above are `HermesInternal.getInstrumentedStats()` readings
   (not `performance.memory`, see the Memory section's instrument
   correction), which means `performance.memory` is unavailable on this
   device, which in turn means `6de466a`'s per-chunk peak-sampling
   (`sampleHeapMB()`, `performance.memory`-only, no fallback) would return
   **no data** if re-run on this same device. The true **mid-run peak** heap
   usage remains uncaptured, and simply moving to `6de466a` does not close
   that gap here — the instrument needs a `HermesInternal` fallback for
   per-chunk sampling first. The reported 8→16→20 MB progression is "no
   growth beyond 20 MB observed at three point-in-time samples, still
   rising run-over-run" — not proof of a peak or a ceiling; see Caveat 6 and
   the Memory section above.
5. **The pre-fix catastrophic run is part of this record**, not a separate,
   discarded incident — see the dedicated section above, which has itself
   been corrected here: the request-log burst (~39 `all.bin` fetches, ~144
   MB, in ~2s) plus the independently-confirmed SQLite connection leak are
   **sufficient by themselves** to explain the >500 MB RSS figure, and are
   the better-evidenced explanation. Allocation churn is demoted to a
   plausible contributing factor at most — this document's own post-fix
   data (6.7 GB allocated against a 20 MB heap ceiling) argues against churn
   being the dominant driver. Not whole-corpus retention either way (actual
   retention was ~5–8 MB). The GC-pressure figures remain real evidence
   about pure-JS crypto's cost on Hermes and still feed the native-crypto
   Phase 2 task, independent of which factor(s) caused the pre-fix crash.
6. **JS-heap figures are not RSS.** The 8/16/20 MB `js_heapSize` figures in
   the memory table measure the Hermes JS heap only; they must never be
   equated with the pre-fix build's >500 MB RSS figure, which included
   native allocations (SQLite connections, engine overhead, image/font
   caches) entirely outside the JS heap.
7. **Only the crypto shape was modeled faithfully; the transport shape was
   not.** `openBlob` ran 3,683 times (genuine per-op singleton HPKE opens,
   per spec §3.3), but the corpus was fetched as a single pre-batched 3.7 MB
   `all.bin` response, not as 3,683 individual per-blob HTTP fetches. This
   was a stated spike-convenience simplification that a prior draft of this
   verdict dropped; restated in the Setup section above and here because it
   lands on `fetchMs`, a FAIL-branch input. A production per-blob transport
   shape is not measured by this spike.
8. **First paint is unmeasured in Phase 0.** The measured "warm start" 13ms
   figure is the wall-clock span of a `SELECT COUNT(*)` + `bucketDebits()`
   aggregate inside a post-mount `useEffect` — after process launch, Hermes
   bundle evaluation, and React mount have already happened, and before any
   UI re-render. It is a SQLite read time, not time-to-first-paint. Spec
   §5's Phase 0 exit criterion names "first paint" explicitly (target <2s
   warm); this spike never instrumented that, so the criterion, as
   literally written, has **not** been directly measured — only a fast,
   suggestive proxy for one part of it.

### Verdict: **PROVISIONAL PASS**

The replay spike passes provisionally: correctness is unconditional (3/3
runs, full corpus, all month checks `MATCH`), the on-device data layer
itself is effectively free (`computeMs` 0.65ms for a full 3,683-row budget
aggregate; `insertMs` 271ms; a 13ms post-mount SQLite read — see
"Affirmative findings"), and cold restore's overage is concentrated almost
entirely (94.3%) in one pure-JS crypto library the architecture already
expects to replace with native crypto before production. Cold restore is
also a once-per-install cost, not a recurring one. **What this verdict does
not rest on:** the warm-start figure is a SQLite read time, not first paint,
and the spec's first-paint criterion is unmeasured in Phase 0 (Caveat 8);
and the 10× native-crypto projection that makes the provisional's central
bet plausible clears the 10s gate by only ~12% while depending partly on a
`fetchMs` this document itself disclaims as unrepresentative (Caveat 2,
"Why the provisional is defensible"). The provisional is not free — it is
conditioned on the **mandatory early Phase 2 native-crypto (JSI) benchmark**
actually landing in the 10–100× range the projection above assumes (now
also written into spec §5's Phase 2 entry); if it doesn't, this verdict must
be revisited before Phase 3 turns crypto on for real users (spec §5 Phase
3). Phase 1 planning (plaintext backend, per spec §5) is unblocked in the
meantime, since Phase 1 does not depend on the crypto path being fast.
