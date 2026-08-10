# Fix round — Tasks 23, 32, 37 (findings from `task-21-23-32-37-critic.md`)

Scope: the review's **Critical** and all five **Importants** for Tasks 32 (admin
console), 23 (diagnostics) and 37 (e2e harness). Task 21's Important
(`internal/v2/tmpl/`) is another round's; nothing here touches that package.

Every RED below was observed before the fix and every mutation below was run by
me at this commit, against a throwaway Postgres cluster
(`internal/v2/pgtest/cmd/boot`).

---

## 1. CRITICAL (Task 32) — the publish gate was blind to value regressions

`admin.go` compared `Matched` booleans only. Both of the reviewer's corrupt
templates were reproduced first, through the real `internal/v2/samples` store
and the real HTTP handlers, and both published clean:

```
publish(direction flipped debit -> credit) -> 200
  {"matched":1,"regressions":[],"samples":1,"status":"published","template_id":"testbank.card","version":2}
publish(amount pattern now reads the AVAILABLE BALANCE) -> 200
  {"matched":1,"regressions":[],"samples":1,"status":"published","template_id":"testbank.card","version":2}
```

The fixture that makes this measurable is `sampleWithBalance` — a body carrying
both the transaction amount and an available balance under it, plus a card
number the live template does not read. `broadAmount` extracts `AED 250.00`;
`balanceAmount` (`balance AED (?P<amt>…)`) matches just as well and extracts
`AED 9999.99`.

### What the gate now does

`replay` keeps each sample's `tmpl.Extraction` in an **unexported, untagged**
field, and publish compares the six template fields (`amount` — which carries
the currency — `date`, `merchant`, `last4`, `direction`, `is_transfer`) between
the live version and the candidate. Three classes, three verdicts:

| class | meaning | verdict |
|---|---|---|
| `regressions` | the live version parsed this message, the candidate does not | refused, absolutely — no flag can pass it |
| `changes` | both parse it and a field's extracted VALUE differs | refused until acknowledged with `{"accept_changes": true}` |
| `gains` | the candidate extracts a field the live version could not | never blocks; reported |

After:

```
publish(direction flipped debit -> credit) -> 409
  {"changes":[{"sample_id":"…","sender_domain":"testbank.test","fields":["direction"]}],
   "error":"value_change","gains":[],"matched":1,"regressions":[],"samples":1,…}
publish(amount pattern now reads the AVAILABLE BALANCE) -> 409
  {"changes":[{…,"fields":["amount"]}],"error":"value_change",…}
publish(adds a last4 capture the live version lacked) -> 200
  {"changes":[],"gains":[{…,"fields":["last4"]}],…,"status":"published"}
```

### The template that legitimately improves extraction

Two different things were conflated in the review's "a previously-wrong field
now correct is a desirable diff", and they get different answers:

- **Extracting something where there was nothing** (`gains`) is additive —
  nothing that was right becomes wrong — so it publishes with no ceremony, and
  is merely reported so the operator sees the improvement they intended.
  `TestATemplateThatExtractsAFieldTheLiveOneCouldNotIsNotARegression`.
- **Extracting something DIFFERENT** is genuinely undecidable from here: a
  widened merchant capture and a rewired amount pattern are the same
  observation. Refusing all of them would make the gate an obstacle to every
  improvement and it would be switched off within a week; ignoring them is the
  Critical. So it is measured, the sample and the field are named, and a human
  says yes. That is not the force flag the regression class deliberately lacks:
  `accept_changes` cannot pass a match regression (pinned by
  `TestAValueChangePublishesOnlyWhenItIsAcknowledged`), and the acknowledgement
  is logged at operator volume like a sample retirement.

### The response reports names, never values

`fieldDelta` carries `sample_id`, `sender_domain` and `fields` — a six-word
vocabulary of template-authored identifiers — for the same reason
`parse_diagnostics.empty_groups` does. `TestNoConsoleRouteReturnsADonatedBody`
now probes the value-change 409 and the acknowledged publish, with `9999.99` and
`4321` added to the forbidden strings.

### Mutations (all newly caught)

| # | mutation | result |
|---|---|---|
| C1a | publish compares `Matched` only (the reviewed code) | caught (4 tests) |
| C1b | value changes are reported but never block | caught (3 tests) |
| C1c | `direction` dropped from the compared fields | caught |
| C1d | amount compared by currency only, not the number | caught |
| C1e | a gain is reported as a change (blocks every improvement) | caught |
| C1f | `accept_changes` also forces past a match regression | caught |

---

## 2. Important (Task 32) — the nil-corpus refusal was untested

`TestPublishRefusesWhenTheCorpusIsNotConfiguredAtAll`: a console with `Samples`
nil, a live version, and a candidate that regresses against the real corpus.
Both `/publish` and `/validate` must answer 503 and nothing may be published.

| # | mutation | before | after |
|---|---|---|---|
| A9 | `if h.Samples != nil { … }` — nil corpus becomes an empty one | NOT-CAUGHT | **caught** |

---

## 3. Important (Task 32) — the no-token test passed for the wrong reason

`TestTheConsoleRoutesRefuseToMountWithoutAToken` built a handler with a nil
`Waitlist`, so `Routes` refused for a different reason. It now builds a
**fully-populated** handler (real `Dict`, `Quarantine`, `Samples`,
`Reprocessor`, `Waitlist`) whose only fault is `Token: ""`, asserts the error
names `LEDGER_ADMIN_TOKEN`, and mounts **the same handler with a token** as a
positive control so the refusal cannot come from anywhere else.

| # | mutation | before | after |
|---|---|---|---|
| A12 | delete the token guard from `Routes` entirely | NOT-CAUGHT | **caught** |

Also closed, since it is one line and the same shape: **A3** — `adminRoutes()`
now includes an unrouted `/admin/no-such-route`, so removing `guard(...)` from
the `/admin/` catch-all is caught by three tests instead of none.

---

## 4. Important (Task 32) — `/admin/accounting`'s `balanced` was a tautology

`ArrivalSum() + Unaccounted == InboundTotal` is true by construction inside
`verify.Accounting` (all three increment in the same branches), so the field
reduced to `unaccounted == 0`.

The field is **kept and made an equation** rather than deleted: `exit.test.ts`
(Task 38) and `v2-phase1-exit-record.md` both read it, and deleting it would
break another round's file. It is now checked against a **second, independent
measurement** — `diag.ArrivalTally`, a plain count with the outcome test in SQL
over `diag`'s own copy of the arrival vocabulary, sharing only the
`diag.Outcome*` constants with `verify`'s classifier:

```go
"balanced": rep.ArrivalSum()+rep.Unaccounted == rep.InboundTotal &&
    rep.Unaccounted == 0 &&
    tally.Rows == rep.InboundTotal &&
    tally.Named == rep.ArrivalSum(),
```

**On the seam.** A cross-check between two correct implementations cannot be
made false by any DATA — which is exactly how the tautology survived review, so
shipping another unfalsifiable conjunct would have repeated the crime. The
second measurement is therefore reached through one unexported package-level
`arrivalTally` variable, documented as existing so a test can make the two sides
disagree, and
`TestBalancedIsMeasuredAgainstASecondCountAndNotDerivedFromTheFirst` does that
in both directions while asserting the report itself does not move (so the old
expression is still satisfied and must no longer be enough).
`TestAccountingIsUnbalancedWhenAnArrivalCannotBeClassified` falsifies it by data
as well, planting an arrival past the dropped CHECK.

| # | mutation | result |
|---|---|---|
| A11 | `balanced` reverts to the reviewed expression | caught (both directions) |
| A11b | only the row count is cross-checked | caught |
| A11c | the second count is taken over an unbounded window | caught |
| A11d | `ArrivalTally` forgets to filter by event | caught (admin + diag) |
| A11e | `ArrivalTally` names every row (FILTER dropped) | caught |

---

## 5. Important (Task 23) — nothing pinned the 19-column INSERT mapping

`TestEveryDisclosedColumnRoundTripsThroughTheInsert` writes three records that
between them exercise every column and every mutually exclusive combination
(scoped/unscoped, arrival/reprocess, refusal/appended), reads them back through
`Query`, and compares **all nineteen** columns through `roundTripAssertions` —
a map keyed by column, so a new column with no assertion fails the test.

`dkim_result` differs from `arc_result` in each fixture while staying legal in
both enums, so a transposition is visible as a wrong VALUE rather than as a
constraint violation (which is the case a test can accidentally pass).

| # | mutation | before | after |
|---|---|---|---|
| D11 | `dkim_result` / `arc_result` swapped on the INSERT | NOT-CAUGHT | **caught** |
| D11b | `sender_domain` / `inner_origin_domain` swapped | — | caught |
| D11c | `normalizer_version` / `template_version` swapped | — | caught |
| D11d | `tier` / `outcome` swapped | — | caught |

---

## 6. Important (Task 23) — `sender_domain` had no attestation coupling

The unprefixed spelling means "a signature we verified names this domain", and
nothing enforced it — while `admin.reprocessTemplate` reads the column back
through `tmpl.MatchesSenderDomain` to decide whose mail a republish re-parses.

Closed in both layers, exactly as `inner_origin_domain` already was:

- `Record.validate` refuses an unprefixed `sender_domain` unless `dkim_result`
  or `arc_result` is `pass` (naming the field, never the value).
- `00006_diagnostics.sql` gains
  `parse_diagnostics_verified_sender_needs_an_attestation`.

`TestAVerifiedSenderDomainRequiresAnAttestation` covers four unattested verdict
pairs (each refused, and each accepted once marked), both single attestations,
the null-sender case, and the SQL backstop with Go bypassed.

The invariant is one `origin.Resolve` already maintains — `Origin.Outer` is
prefixed unless DKIM passed, an ARC chain sealed the message, or a proved relay
handed it over, all of which set one of the two verdicts — which is why the
whole `internal/v2/...` suite stays green under it.

---

## 7. Important (Task 37) — the `:25` rail was untested and unbacked

`assertScratchListeners(env)` refuses to spawn unless **every** listener
(`LEDGER_HTTP_LISTEN`, `LEDGER_SMTP_LISTEN`, `LEDGER_ADMIN_LISTEN`) is
`127.0.0.1:<18000–18999>`. It runs in `startStack` on the **merged** environment
— after `opts.env`, so a caller cannot override past it — and **before** the
scratch directory and database exist.

It is a positive rule (address and range) rather than a blocklist, so an **unset**
variable fails it for the same reason a wrong one does: that is what makes
"someone deletes the `LEDGER_SMTP_LISTEN` line" a caught mutation rather than a
`:25` bind. The forbidden-port table (25, 8080, 8443, 8079) exists only so the
error names what was nearly hit.

Mutations, all run on this box **without ever binding `:25`** (`ss -ltn`
confirmed `:25` still free after each):

| # | mutation | result |
|---|---|---|
| M-25a | delete the `LEDGER_SMTP_LISTEN` line from the spawn env | **caught** — 6 failures, refusal before spawn |
| M-25b | delete the `assertScratchListeners(env)` call | **caught** |
| M-25c | make `assertScratchListeners` a no-op | **caught** — 3 failures |

M-25b is runnable safely only because the assertion was split into two tests:
the MTA case (`0.0.0.0:25`) is never run against a build with no rail, while the
`127.0.0.1:8080` case is safe — v1 holds that port, so the kernel refuses the
bind. That split found a real defect in the first draft of the test: with the
rail deleted, `startStack` still rejected with a message containing "8080"
(`config: refusing to bind "127.0.0.1:8080": :8080 belongs to the running v1
instance`), so a test matching `/8080/` **passed with the guard removed**. Both
tests now match the rail's own wording.

Note the config-side backstop the reviewer also suggested (`mail.smtp_listen` in
`config.validate()`) was **not** added: `internal/v2/config/config.go` is being
edited by a concurrent session and is outside this round's lane. Recorded below.

---

## 8. Verification

```
go clean -testcache && bash scripts/v2-check.sh
```

Run in a clean worktree checked out at this commit, because the shared tree is
red from concurrent sessions (`internal/v2/samples` does not compile mid-edit,
and `cmd/ledgerd`'s `TestTheReprocessAdapterCarriesEveryField` fails because
another round has added a sixth field to `ingest.Report`).

---

## 9. Not closed, recorded

- **A8 is deeper than diagnosed.** The review says a candidate that DROPS a
  sender domain publishes clean and that the union-of-domains rule is the
  untested guard. It is untested, but the union is not what would catch it:
  `replay` calls `Compiled.Execute(subject, text)` and never applies
  `Match.SenderDomain` at all, so a dropped domain leaves the sample in the
  corpus (via the union) and still MATCHING it textually. Catching it needs the
  replay to gate on `tmpl.MatchesSenderDomain(def, sample.SenderDomain)` — a
  behaviour change to `validate`'s reported counts that was out of scope for a
  fix round, and one that wants a decision about samples donated under an
  `unverified:` domain.
- **`mail.smtp_listen` has no server-side rail** (§7). The harness cannot bind
  `:25` any more; a hand-started `ledgerd` with no config still can.
- **`LEDGER_ADMIN_TOKEN` has no entropy floor** and `requireToken` trims
  whitespace (review §4.5, minors) — untouched.
