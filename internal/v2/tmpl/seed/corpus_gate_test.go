package seed

// corpus_gate_test.go is spec §3.5's ship condition for Phase 1: "ported
// templates must reproduce the existing three parsers' output over the full
// 3-year corpus".
//
// # What is actually being compared
//
// Two whole implementations of the same job, over the same mail:
//
//	v1  parse.BodyText -> parse.Unwrap -> parse.Cascade{DIB, ENBD, ENBDAlert}
//	v2  norm.Normalize -> tmpl.Execute over every seed whose Match gates pass
//
// Not one line of the v1 side is written here. The cascade is constructed
// exactly as cmd/ledger/main.go:239 constructs it and the posted-at fallback is
// computed exactly as parse/processor.go:70 computes it, because a gate that
// re-implements the thing it is checking cannot see a defect in it — the copy
// does not share the mistake, so it keeps agreeing and the gate goes green.
// internal/v2/norm's corpus gate learned that the expensive way: five one-line
// defects, changing up to 56 messages each, all passed a version of it whose
// shadow re-implemented nine lines of the function under test.
//
// The one thing this file does re-implement is [senderDomain], and it is not
// part of either implementation: v1 gates on the whole From header including
// the local part, v2 gates on a DKIM-VERIFIED signing domain that a three-year
// -old ingest_log row does not carry. Splitting a stored From at its last '@'
// is the harness's own approximation of a fact neither side stores, and getting
// it wrong can only run a template against a message it then fails to match.
//
// # The bar
//
//	mismatches  MUST be 0   v1's template tier produced a result and v2 produced
//	                        a different one on any of the eight compared fields.
//	misses      MUST be 0   v1's template tier produced a result and v2 produced
//	                        none.
//	ambiguous   MUST be 0   two seeds claimed the same message. v1 stops at the
//	                        first parser that matches, so a second claimant means
//	                        the Match blocks are not the partition they look like.
//	new matches ALLOWED     v2 matched where v1's template tier did not. A strict
//	                        improvement, but every one is listed in
//	                        docs/superpowers/specs/v2-seed-validation.md with a
//	                        justification, because "v2 extracted something v1
//	                        did not" and "v2 extracted the wrong thing" look
//	                        identical from inside this test.
//
// # Iterate on the JSON, never on the comparison
//
// Every temptation to widen a field comparison is the template being wrong. The
// one place this file spends any words on tolerance is [samePostedAt], and it
// tolerates nothing — it exists because Go's time.Time carries a monotonic
// reading and a location that == compares and Equal does not.
//
// # What this gate can and cannot see
//
// A gate that passes is worth exactly what it would have caught. 26 plausible
// one-edit template defects were measured against the 7,004-message corpus and
// against the synthetic table in
// [TestSeedReproducesV1OnTheBranchesTheCorpusNeverExercises]. The corpus caught
// 15. It caught NONE of these eleven:
//
//	mutation                                     corpus   synthetic
//	card  last4 capture -> whole line              0         yes
//	acct  last4 capture -> whole line              0         yes
//	acct  DEBIT suffix rule deleted                0         yes
//	acct  CREDIT suffix rule deleted               0         yes
//	acct  suffix rules moved after the cascade     0         yes
//	acct  unconditional default flipped to debit   0         yes
//	acct  من الحساب preposition rule deleted        0         yes
//	acct  deposit-notice rule deleted              0         yes
//	acct  case-insensitive flags removed           0         yes
//	xfer  date-only fallback layout dropped        0         yes
//	alert credit branch deleted                    0         yes
//
// and the fifteen it did catch, it caught hard: the hamza misspelling of the
// payee anchor breaks 4,997 messages, an amt group that swallows "AED " turns
// all 4,997 into misses, dropping DIB's TRNSFER misspelling loses 23
// is_transfer flags and dropping the correctly-spelled TRANSFER loses 339.
//
// The eleven are not gaps in the corpus's SIZE. They are branches real bank
// mail does not take, and each was measured rather than guessed:
//
//   - No account line and no card line in 6,879 DIB messages contains a space,
//     so v1's (\S+) and a whole-line capture cannot differ on any of them.
//   - No amount block in the corpus writes its currency in lower case, on its
//     own line, or with no space before the number, so the ccy group's exact
//     shape is unobservable here.
//   - All 63 ENBD messages carry a time with the date, so v1's
//     strings.Fields(s)[0] fallback never runs.
//   - The corpus holds ONE ENBD alert and it is a debit.
//   - 312 account-layout messages carry a DEBIT/CREDIT description suffix — the
//     branch is well covered — and on all 312 the suffix AGREES with what the
//     four-way cascade already decided. It overrides it ZERO times. That is why
//     deleting either suffix rule, or moving both behind the cascade, changes
//     nothing here: v1's override never overrides on three years of real mail.
//
// That last one matters beyond this file. It means the corpus is structurally
// incapable of distinguishing the entry ORDER this port uses from v1's literal
// override shape, so "the full corpus agrees" is not evidence about the
// override question at all. The synthetic differential table is, and it is why
// that test exists rather than being a nicety.

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	v1 "ledger/internal/parse"
	"ledger/internal/v2/corpus"
	"ledger/internal/v2/norm"
	"ledger/internal/v2/tmpl"
)

// recordedCorpusSize is the message count at the recorded gate pass
// (2026-08-01; docs/superpowers/specs/v2-seed-validation.md).
//
// v1's ingest_log is append-only, so a snapshot holding materially fewer rows
// is truncated, stale, or a different database that happens to have an
// ingest_log. Without this floor the gate is perfectly happy on an EMPTY one:
// it prints "corpus: 0 messages, v1 template hits: 0, mismatches: 0" and goes
// green, which is a gate that proves nothing while looking like the strongest
// check in the repository.
//
// A FLOOR, not an equality: the live instance keeps ingesting. The 10% band
// tolerates an older snapshot while still rejecting an empty or wrong one.
const recordedCorpusSize = 7005

// recordedV1TemplateHits is how many messages v1's template tier extracted at
// that same pass. The size floor alone does not stop the other silent failure:
// a corpus of the right size whose mail no longer reaches the template tier —
// a broken senderDomain, a Match block that stopped matching, a normalizer that
// returns empty text — would compare 7,000 non-results to 7,000 non-results and
// report zero mismatches. Requiring the hit count to stay in the same band
// makes "the gate compared nothing" a failure rather than a pass.
const recordedV1TemplateHits = 5719

// maxShown caps how many findings keep their full detail. A template defect
// that breaks every message would otherwise hold the whole corpus in memory on
// the way to reporting the first 20.
const maxShown = 20

// v1Result is what v1's template tier extracted, or hit=false.
type v1Result struct {
	hit bool
	txn v1.ParsedTxn
}

// v2Result is what one seed template extracted.
type v2Result struct {
	id string
	e  tmpl.Extraction
}

// TestSeedTemplatesReproduceV1OverTheFullCorpus is the gate.
func TestSeedTemplatesReproduceV1OverTheFullCorpus(t *testing.T) {
	path := os.Getenv("LEDGER_CORPUS_DB")
	if path == "" {
		// A checkout without the corpus skips; internal/v2/corpus's package doc
		// has the snapshot recipe. This is why scripts/v2-check.sh stays green
		// on a machine that has never seen the v1 database.
		t.Skip("LEDGER_CORPUS_DB is unset; the seed gate needs a scratch .backup of the v1 corpus")
	}
	// A path that is SET but unusable FAILS rather than skips: a typo silently
	// disabling the gate is the one failure mode a gate must not have.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("LEDGER_CORPUS_DB=%s is set but unusable: %v", path, err)
	}
	db, err := corpus.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	available, err := db.Count()
	if err != nil {
		t.Fatal(err)
	}
	if floor := recordedCorpusSize / 10 * 9; available < floor {
		t.Fatalf("corpus at %s holds %d messages; the last recorded gate pass saw %d "+
			"and ingest_log is append-only, so anything below %d is a truncated or "+
			"wrong snapshot rather than the corpus. Re-take it:\n"+
			"  sudo sqlite3 \"file:/var/lib/ledger/ledger.db?mode=ro\" \".backup '<scratch>/corpus.db'\"",
			path, available, recordedCorpusSize, floor)
	}

	g, err := runGate(db, Seed())
	if err != nil {
		t.Fatal(err)
	}
	if g.total != available {
		t.Fatalf("scanned %d messages but ingest_log holds %d", g.total, available)
	}

	t.Logf("corpus: %d messages, v1 template hits: %d, mismatches: %d, v2 misses: %d, new matches: %d",
		g.total, g.v1Hits, g.mismatch, g.misses, g.newMatches)
	t.Logf("detail: v2 hits %d, ambiguous %d, agreed-no-transaction %d, v2 normalizer failures %d",
		g.v2Hits, g.ambiguous, g.agreedNone, g.normErrs)
	t.Logf("per template: %s", counts(g.perTemplate))
	t.Logf("v1 template hits per sender: %s", counts(g.v1PerBank))
	for _, f := range g.findings {
		t.Logf("FINDING %s", f)
	}
	for _, n := range g.newList {
		t.Logf("NEW MATCH %s", n)
	}

	// The gate compared something. A corpus of the right size whose mail no
	// longer reaches the template tier would report zero mismatches while
	// checking nothing at all.
	if floor := recordedV1TemplateHits / 10 * 9; g.v1Hits < floor {
		t.Fatalf("v1's template tier extracted only %d transactions; the recorded pass saw %d, "+
			"so below %d the gate is comparing non-results to non-results rather than measuring anything",
			g.v1Hits, recordedV1TemplateHits, floor)
	}
	if g.mismatch != 0 || g.misses != 0 || g.ambiguous != 0 {
		t.Fatalf("SEED VALIDATION FAILED: %d mismatches, %d misses, %d ambiguous", g.mismatch, g.misses, g.ambiguous)
	}
}

// gateCounts is one full-corpus comparison.
type gateCounts struct {
	total, v1Hits, v2Hits            int
	mismatch, misses, ambiguous      int
	newMatches, agreedNone, normErrs int
	perTemplate, v1PerBank           map[string]int
	findings, newList                []string
}

// runGate compares v1 against the given definitions over the whole corpus.
//
// It takes the definitions as an argument rather than calling [Seed] itself so
// that the mutation battery whose results this file's header records can hand it
// a DELIBERATELY BROKEN template and read the counts back. Keep it that way: a
// battery that has to edit the committed JSON instead is editing a shared
// worktree other sessions are compiling, and it measures whether the files can
// be broken rather than whether this comparison notices.
func runGate(db *corpus.DB, defs []tmpl.Definition) (gateCounts, error) {
	// v1, constructed exactly as cmd/ledger/main.go:239 does. AI is nil: the AI
	// tier never produces a template-tier result, and this gate is about the
	// template tier.
	cascade := &v1.Cascade{
		Parsers:   []v1.BankParser{v1.DIBParser{}, v1.ENBDParser{}, v1.ENBDAlertParser{}},
		Heuristic: v1.HeuristicParser{},
		AI:        nil,
	}
	// v2. Compiled once, as the ingest pipeline does.
	compiled := make([]*tmpl.Compiled, len(defs))
	for i, d := range defs {
		c, err := tmpl.Compile(d)
		if err != nil {
			return gateCounts{}, fmt.Errorf("%s: %w", d.ID, err)
		}
		compiled[i] = c
	}

	g := gateCounts{perTemplate: map[string]int{}, v1PerBank: map[string]int{}}
	ctx := context.Background()

	err := db.Each(func(m corpus.Message) error {
		g.total++

		got1 := runV1(ctx, cascade, m)
		if got1.hit {
			g.v1Hits++
			g.v1PerBank[bankOf(m.FromAddr)]++
		}

		// --- v2 ---------------------------------------------------------
		r, nerr := norm.Normalize(norm.CurrentVersion, m.RawBody, m.ReceivedAt)
		if nerr != nil {
			g.normErrs++
			if got1.hit {
				g.mismatch++
				if len(g.findings) < maxShown {
					g.findings = append(g.findings, fmt.Sprintf(
						"id %d: v1's template tier extracted a transaction but the normalizer refused the message: %v",
						m.ID, nerr))
				}
			}
			return nil
		}
		// norm.Result.From, not the ingest_log from_addr: for an inline forward
		// the two are different senders, and v1 gates its parsers on the one
		// parse.Unwrap recovers from the INNER header block. Gating v2 on the
		// outer address instead cost six messages on the first run — five
		// forwarded DIB card purchases and the corpus's only ENBD alert — and
		// every one of them was the harness disagreeing with itself about who
		// sent the mail, not a template failing to extract it. norm's own corpus
		// gate is what makes this a like-for-like swap: it requires
		// norm.Result.From to equal v1's unwrapped From on every message.
		hits := runV2(defs, compiled, r.From, r.Subject, r.Text, r.EmailDate)
		if len(hits) > 0 {
			g.v2Hits++
			g.perTemplate[hits[0].id]++
		}

		// --- compare ----------------------------------------------------
		switch {
		case len(hits) > 1:
			g.ambiguous++
			if len(g.findings) < maxShown {
				ids := make([]string, 0, len(hits))
				for _, h := range hits {
					ids = append(ids, h.id)
				}
				g.findings = append(g.findings, fmt.Sprintf(
					"id %d: %d seed templates claimed the same message (%s); v1 stops at its first matching parser, "+
						"so the Match blocks are not the partition they look like", m.ID, len(hits), strings.Join(ids, ", ")))
			}
		case got1.hit && len(hits) == 0:
			g.misses++
			if len(g.findings) < maxShown {
				g.findings = append(g.findings, fmt.Sprintf("id %d: V2 MISS\n%s\n%s",
					m.ID, describeV1(got1.txn), anchorSnippet(r.Text)))
			}
		case got1.hit:
			if diff := diffFields(got1.txn, hits[0].e); diff != "" {
				g.mismatch++
				if len(g.findings) < maxShown {
					g.findings = append(g.findings, fmt.Sprintf("id %d: MISMATCH (template %s)\n%s\n%s",
						m.ID, hits[0].id, diff, anchorSnippet(r.Text)))
				}
			}
		case len(hits) == 1:
			g.newMatches++
			if len(g.newList) < maxShown {
				g.newList = append(g.newList, fmt.Sprintf("id %d via %s: %s | v1 said: %s",
					m.ID, hits[0].id, describeV2(hits[0].e), v1Excuse(ctx, cascade, m)))
			}
		default:
			g.agreedNone++
		}
		return nil
	})
	return g, err
}

// runV1 is the v1 half, composed exactly as parse/processor.go composes it.
func runV1(ctx context.Context, cascade *v1.Cascade, m corpus.Message) v1Result {
	text, berr := v1.BodyText(m.RawBody)
	if berr != nil {
		// processor.go marks the row unparsed and moves on; the template tier
		// never runs.
		return v1Result{}
	}
	from, subject, fwdDate, text := v1.Unwrap(m.FromAddr, m.Subject, text)
	// processor.go:70: the forwarded Date header when it parses (the
	// transaction time even for a late forward), else the mailbox arrival time.
	// This is what norm.Result.EmailDate folds into one field, and
	// norm's corpus gate is what proves the two agree.
	fallback := m.ReceivedAt
	if fd, err := v1.ParseForwardDate(fwdDate); err == nil {
		fallback = fd
	}
	return runV1Text(ctx, cascade, from, subject, text, fallback)
}

// runV1Text is the tail of [runV1], from already-decoded text onwards. It is
// separate so the synthetic differential test drives the SAME v1 code path with
// a body it composed rather than one it had to wrap in RFC822 first.
func runV1Text(ctx context.Context, cascade *v1.Cascade, from, subject, text string, fallback time.Time) v1Result {
	res := cascade.Run(ctx, from, subject, text, fallback)
	if res.Status != v1.StatusParsed || res.Tier != v1.TierTemplate {
		return v1Result{}
	}
	return v1Result{hit: true, txn: res.Txn}
}

// runV2 runs every seed whose gates pass and returns each one's extraction.
func runV2(defs []tmpl.Definition, compiled []*tmpl.Compiled, from, subject, text string, emailDate time.Time) []v2Result {
	dom := senderDomain(from)
	var hits []v2Result
	for i, c := range compiled {
		if !tmpl.MatchesSenderDomain(defs[i], dom) {
			continue
		}
		e, execErr := c.Execute(subject, text)
		if execErr != nil {
			continue
		}
		if defs[i].DateFrom == tmpl.DateFromEmail {
			// The caller supplies the email date for a template whose format
			// carries none; v1's Cascade does the same thing with fallbackDate.
			// Both sides therefore date these from the message, and a
			// difference here would be a real one.
			e.PostedAt = emailDate
		}
		hits = append(hits, v2Result{id: defs[i].ID, e: e})
	}
	return hits
}

// v1Excuse re-runs v1 for the report only, to say WHY v1's template tier
// produced nothing for a message v2 matched. Every new match has to be
// justified in writing, and "v1 got a heuristic result instead" and "v1's
// parser errored" are different justifications.
func v1Excuse(ctx context.Context, cascade *v1.Cascade, m corpus.Message) string {
	text, berr := v1.BodyText(m.RawBody)
	if berr != nil {
		return "body decode failed: " + berr.Error()
	}
	from, subject, fwdDate, text := v1.Unwrap(m.FromAddr, m.Subject, text)
	fallback := m.ReceivedAt
	if fd, err := v1.ParseForwardDate(fwdDate); err == nil {
		fallback = fd
	}
	res := cascade.Run(ctx, from, subject, text, fallback)
	if res.Err != "" {
		return fmt.Sprintf("status=%s tier=%s err=%s", res.Status, res.Tier, res.Err)
	}
	return fmt.Sprintf("status=%s tier=%s", res.Status, res.Tier)
}

// diffFields compares the eight fields, and returns "" when they agree.
//
// It compares every field on every message rather than stopping at the first
// difference: a template that got the direction AND the merchant wrong should
// say so once, not twice on two runs.
func diffFields(a v1.ParsedTxn, b tmpl.Extraction) string {
	var out []string
	add := func(field string, v1v, v2v any) {
		out = append(out, fmt.Sprintf("  %-11s v1=%v  v2=%v", field, v1v, v2v))
	}
	if a.AmountFils != b.AmountMinor {
		add("amount", a.AmountFils, b.AmountMinor)
	}
	if a.Currency != b.Currency {
		add("currency", q(a.Currency), q(b.Currency))
	}
	if a.Direction != b.Direction {
		add("direction", q(a.Direction), q(b.Direction))
	}
	if !samePostedAt(a.PostedAt, b.PostedAt) {
		add("posted_at", a.PostedAt.UTC().Format(time.RFC3339), b.PostedAt.UTC().Format(time.RFC3339))
	}
	if a.MerchantRaw != b.Merchant {
		add("merchant", q(a.MerchantRaw), q(b.Merchant))
	}
	if a.Last4 != b.Last4 {
		add("last4", q(a.Last4), q(b.Last4))
	}
	if a.IsTransfer != b.IsTransfer {
		add("is_transfer", a.IsTransfer, b.IsTransfer)
	}
	return strings.Join(out, "\n")
}

// samePostedAt compares two instants, not two time.Time values.
//
// == on time.Time compares the wall clock, the monotonic reading and the
// *Location POINTER, so two values naming the same instant in the same zone
// can compare unequal. Equal compares the instant, which is the only thing
// either implementation is claiming.
func samePostedAt(a, b time.Time) bool { return a.Equal(b) }

func q(s string) string { return fmt.Sprintf("%q", s) }

func describeV1(p v1.ParsedTxn) string {
	return fmt.Sprintf("  v1: amount=%d %s %s posted=%s merchant=%q last4=%q transfer=%v",
		p.AmountFils, p.Currency, p.Direction, p.PostedAt.UTC().Format(time.RFC3339),
		p.MerchantRaw, p.Last4, p.IsTransfer)
}

func describeV2(e tmpl.Extraction) string {
	return fmt.Sprintf("amount=%d %s %s posted=%s merchant=%q last4=%q transfer=%v",
		e.AmountMinor, e.Currency, e.Direction, e.PostedAt.UTC().Format(time.RFC3339),
		e.Merchant, e.Last4, e.IsTransfer)
}

// anchorLines are the lines worth seeing when a message disagrees: every v1
// anchor, plus the line after it, which is where every DIB value lives.
var anchorLines = regexp.MustCompile(
	`(?m)^.*(المبلغ|بتاريخ|الدفع الى|المعاملة|رقم البطاقة|من حساب|من الحساب|إشعار|Debit Amount|Transaction Date|Beneficiary Name|has been).*$`)

// anchorSnippet prints the anchor-bearing lines of a message and the line after
// each, bounded. A field diff says WHAT disagreed; adjudicating it needs the
// bytes, and paging through a 400-line Arabic HTML-stripped body in a test log
// is not adjudication.
func anchorSnippet(text string) string {
	lines := strings.Split(text, "\n")
	keep := map[int]bool{}
	for i, l := range lines {
		if anchorLines.MatchString(l) {
			keep[i] = true
			if i+1 < len(lines) {
				keep[i+1] = true
			}
		}
	}
	idx := make([]int, 0, len(keep))
	for i := range keep {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	var b strings.Builder
	b.WriteString("  --- anchors ---")
	shown := 0
	for _, i := range idx {
		if shown >= 24 {
			b.WriteString("\n  ...")
			break
		}
		fmt.Fprintf(&b, "\n  %3d| %q", i, lines[i])
		shown++
	}
	return b.String()
}

// senderDomain pulls the domain out of a v1 ingest_log from_addr. See the file
// comment: this is the harness's approximation of a fact neither implementation
// stores, not part of either one.
func senderDomain(fromAddr string) string {
	at := strings.LastIndex(fromAddr, "@")
	if at < 0 {
		return ""
	}
	d := strings.TrimSpace(fromAddr[at+1:])
	d = strings.TrimSuffix(strings.Trim(d, "<>"), ".")
	return strings.ToLower(d)
}

// bankOf labels a v1 hit by sender for the per-sender log line.
func bankOf(fromAddr string) string {
	f := strings.ToLower(fromAddr)
	switch {
	case strings.Contains(f, "dib.notification@dib.ae"):
		return "dib.notification@dib.ae"
	case strings.Contains(f, "onlinebanking@emiratesnbd.com"):
		return "onlinebanking@emiratesnbd.com"
	case strings.Contains(f, "alert@emiratesnbd.com"):
		return "alert@emiratesnbd.com"
	default:
		return "other"
	}
}

func counts(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", k, m[k]))
	}
	if len(parts) == 0 {
		return "(none)"
	}
	return strings.Join(parts, " ")
}

// ---------------------------------------------------------------------------
// Guards that need no corpus
// ---------------------------------------------------------------------------

// TestSeedDefinitionsArePublishable is what makes [Seed]'s panic unreachable.
func TestSeedDefinitionsArePublishable(t *testing.T) {
	defs := Seed()
	if len(defs) != len(IDs) {
		t.Fatalf("Seed returned %d definitions, IDs names %d", len(defs), len(IDs))
	}
	for i, d := range defs {
		if d.ID != IDs[i] {
			t.Errorf("Seed()[%d] is %q, want %q", i, d.ID, IDs[i])
		}
		if err := tmpl.ValidateForPublish(d); err != nil {
			t.Errorf("%s: %v", d.ID, err)
		}
		if d.NormalizerVersion != norm.CurrentVersion {
			t.Errorf("%s targets normalizer v%d; this build's normalizer is v%d, and a template "+
				"matching against text a different algorithm produced is not the template that was validated",
				d.ID, d.NormalizerVersion, norm.CurrentVersion)
		}
	}
	if len(Raw()) != len(IDs) {
		t.Errorf("Raw returned %d entries, want %d", len(Raw()), len(IDs))
	}
}

// TestSeedAnchorsAreByteIdenticalToV1 re-derives every anchor from
// internal/parse's own source and requires the seed JSON to contain it.
//
// This is the guard the plan's transcription warning asks for, and it is worth
// more than review: `الدفع إلى` and `الدفع الى` differ by one code point, DIB
// writes the second, and the first produces a template that compiles,
// validates, publishes and matches none of the 6,864 DIB messages in the
// corpus. A reviewer reading right-to-left Arabic in a JSON string does not
// reliably catch that. A byte comparison does.
func TestSeedAnchorsAreByteIdenticalToV1(t *testing.T) {
	a := readV1Anchors(t)
	raw := Raw()
	card, account := string(raw["dib.card.v1"]), string(raw["dib.account.v1"])

	for _, tc := range []struct {
		name   string
		anchor string
		in     []string
	}{
		{"amount", a.amount, []string{card, account}},
		{"date", a.date, []string{card, account}},
		{"payee", a.payee, []string{card}},
		{"txn", a.txn, []string{account}},
		{"card", a.card, []string{card}},
		{"acct", a.acct, []string{account}},
		{"card layout", a.cardLayout, []string{card, account}},
		{"deposit notice", a.deposit, []string{account}},
		{"debit notice", a.debitNotice, []string{account}},
		{"withdrawal notice", a.withdrawal, []string{account}},
		{"from account", a.fromAccount, []string{account}},
	} {
		if tc.anchor == "" {
			t.Fatalf("%s: located an EMPTY anchor, which every seed trivially contains", tc.name)
		}
		for i, doc := range tc.in {
			if !strings.Contains(doc, tc.anchor) {
				t.Errorf("%s: seed %d does not contain v1's anchor %q (% x)", tc.name, i, tc.anchor, tc.anchor)
			}
		}
	}

	// The wrong spelling must NOT appear. `الدفع إلى` (with the hamza) is what a
	// well-meaning correction produces, and it is the exact failure this test
	// exists for; it is the ONLY Arabic literal in this file, and it is here to
	// be rejected.
	const withHamza = "الدفع إلى"
	if withHamza == a.payee {
		t.Fatal("v1's payee anchor now IS the hamza spelling; this guard is asserting the opposite of what dib.go says")
	}
	for id, b := range raw {
		if strings.Contains(string(b), withHamza) {
			t.Errorf("%s contains the hamza spelling of the payee anchor; DIB writes it without", id)
		}
	}
}

// v1Anchors is every anchor literal v1's DIB parser matches on, read out of
// internal/parse's own SOURCE rather than copied. A copy would be the same
// transcription risk one level up.
type v1Anchors struct {
	amount, date, payee, txn, card, acct          string
	cardLayout                                    string
	deposit, debitNotice, withdrawal, fromAccount string
}

// readV1Anchors locates each anchor by the ASCII context around it in dib.go,
// so no Arabic is typed anywhere in this file except the one misspelling
// TestSeedAnchorsAreByteIdenticalToV1 exists to reject.
func readV1Anchors(t *testing.T) v1Anchors {
	t.Helper()
	b, err := os.ReadFile("../../../parse/dib.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	get := func(name, before, after string) string {
		s, ok := between(src, before, after)
		if !ok || s == "" {
			t.Fatalf("%s: could not locate the anchor in dib.go between %q and %q; "+
				"v1's source changed shape and this guard is no longer reading it", name, before, after)
		}
		return s
	}
	return v1Anchors{
		amount:     get("amount", "dibAmountRe = regexp.MustCompile(`", `\s*\n`),
		date:       get("date", "dibDateRe   = regexp.MustCompile(`", `\s*(`),
		payee:      get("payee", "dibPayeeRe  = regexp.MustCompile(`", `\s*\n`),
		txn:        get("txn", "dibTxnRe    = regexp.MustCompile(`", `\s*\n`),
		card:       get("card", "dibCardRe   = regexp.MustCompile(`", `\s*\n`),
		acct:       get("acct", "dibAcctRe   = regexp.MustCompile(`", `\s*\n`),
		cardLayout: get("card layout", `isCard := strings.Contains(textBody, "`, `")`),
		deposit:    get("deposit notice", `case strings.Contains(textBody, "`, `"):`),
		// The cascade's second case names two anchors on one line, so each needs
		// its own surrounding context rather than the shared line shape.
		debitNotice: get("debit notice", "DirectionCredit\n\tcase strings.Contains(textBody, \"", `"), strings.Contains`),
		withdrawal:  get("withdrawal notice", `"), strings.Contains(textBody, "`, `"):`),
		fromAccount: get("from account", `if strings.Contains(textBody, "`, `") {`),
	}
}

// between returns the text between the first occurrence of before and the next
// occurrence of after.
func between(s, before, after string) (string, bool) {
	i := strings.Index(s, before)
	if i < 0 {
		return "", false
	}
	rest := s[i+len(before):]
	j := strings.Index(rest, after)
	if j < 0 {
		return "", false
	}
	return rest[:j], true
}

// TestDIBSeedsPartitionEveryDIBMessage pins the property that makes two
// templates equivalent to v1's one `isCard` branch: the Match blocks are
// complements, so no DIB message can reach both and none can reach neither.
//
// The gate's `ambiguous` counter would catch a real message hitting both, but
// only if the corpus happens to contain one. This holds with no corpus at all.
func TestDIBSeedsPartitionEveryDIBMessage(t *testing.T) {
	defs := Seed()
	var card, account tmpl.Definition
	for _, d := range defs {
		switch d.ID {
		case "dib.card.v1":
			card = d
		case "dib.account.v1":
			account = d
		}
	}
	if len(card.Match.BodyContains) != 1 || len(account.Match.BodyNotContains) != 1 {
		t.Fatalf("the DIB pair is no longer one body_contains against one body_not_contains: %+v / %+v",
			card.Match, account.Match)
	}
	if card.Match.BodyContains[0] != account.Match.BodyNotContains[0] {
		t.Errorf("the DIB pair no longer partitions: card requires %q, account excludes %q",
			card.Match.BodyContains[0], account.Match.BodyNotContains[0])
	}
	if len(card.Match.BodyNotContains) != 0 || len(account.Match.BodyContains) != 0 {
		t.Error("a second content gate on either DIB template breaks the partition")
	}
}

// TestSeedDirectionCascadeNeedsNoOverride records the resolution of the
// override-budget problem, so a later edit cannot quietly reintroduce it.
//
// v1's dib.go computes direction in two steps: a total four-way cascade, and
// then a re-derivation from the uppercased description suffix that WINS over
// whatever the cascade decided (dib.go:79-88). Written that way the port needs
// `override` twice — once for the DEBIT suffix and once for CREDIT — and
// ValidateDefinition permits it once, on purpose.
//
// But "later entry wins" and "earlier entry wins" are the same relation read
// from opposite ends. The suffix rules are unconditional winners, so placing
// them FIRST and letting rule 3 (first entry to produce a value wins) skip the
// cascade behind them is not an approximation of v1's shape — it is the same
// function. The template therefore needs no override at all, and the format
// needs no bounded-multi-override extension.
func TestSeedDirectionCascadeNeedsNoOverride(t *testing.T) {
	var account tmpl.Definition
	for _, d := range Seed() {
		if d.ID == "dib.account.v1" {
			account = d
		}
	}
	order := make([]string, 0, len(account.Extract))
	for _, x := range account.Extract {
		if x.Override {
			t.Errorf("dib.account.v1 still carries an override on %s; the suffix rules are "+
				"expressed by ORDER instead, and one override could only ever reproduce half of "+
				"v1's two-sided suffix re-derivation", x.Field)
		}
		if x.Field == tmpl.FieldDirection {
			order = append(order, x.Value+":"+strings.Join(x.Patterns, "|"))
		}
	}
	// Six direction entries: DEBIT suffix, CREDIT suffix, then v1's four-way
	// cascade with its unconditional default last.
	if len(order) != 6 {
		t.Fatalf("dib.account.v1 has %d direction entries, want 6: %v", len(order), order)
	}
	if !strings.HasPrefix(order[0], "debit:") || !strings.Contains(order[0], "DEBIT") {
		t.Errorf("direction entry 0 is %q, want the DEBIT suffix rule", order[0])
	}
	if !strings.HasPrefix(order[1], "credit:") || !strings.Contains(order[1], "CREDIT") {
		t.Errorf("direction entry 1 is %q, want the CREDIT suffix rule", order[1])
	}
	if last := account.Extract[len(account.Extract)-2]; last.Field != tmpl.FieldDirection ||
		len(last.Patterns) != 0 || last.Value != "credit" {
		t.Errorf("the last direction entry is %+v, want v1's unconditional credit default", last)
	}
}

// TestSeedReproducesV1OnTheBranchesTheCorpusNeverExercises is the corpus gate's
// complement, and the reason it exists is measured rather than assumed.
//
// The mutation battery recorded in this file's header found NINE plausible
// one-edit defects the full 7,004-message corpus cannot see, because the branch
// each one breaks is never taken by real DIB or ENBD mail: both description
// -suffix rules, the entry ORDER that makes them work without `override`, the
// `من الحساب` preposition rule, the deposit-notice rule, the unconditional
// default, the case-insensitive flags, the ENBD date-only fallback layout, and
// the alert template's whole credit branch. A gate that green-lights all nine
// is not a gate over those branches.
//
// So this test hands BOTH implementations the same synthetic body and demands
// the same eight fields, exactly as the corpus gate does with real mail. It is
// a differential test, not an expectation table: v1's parser computes the
// expected value on every run, so a case whose comment is wrong is harmless and
// a case whose expectation drifts from v1 is impossible. That is what makes it
// worth more than a hand-written `want` — this task is not "extract sensibly",
// it is "extract what v1 extracts, including where v1 is odd".
func TestSeedReproducesV1OnTheBranchesTheCorpusNeverExercises(t *testing.T) {
	defs := Seed()
	compiled := make([]*tmpl.Compiled, len(defs))
	for i, d := range defs {
		c, err := tmpl.Compile(d)
		if err != nil {
			t.Fatal(err)
		}
		compiled[i] = c
	}
	for _, tc := range syntheticCases(readV1Anchors(t)) {
		t.Run(tc.name, func(t *testing.T) {
			if bad := compareSynthetic(defs, compiled, tc); bad != "" {
				t.Fatalf("%s\n%s", tc.why, bad)
			}
		})
	}
}

// syntheticCase is one hand-built message both implementations are handed.
type syntheticCase struct {
	name    string
	why     string
	from    string
	subject string
	text    string
}

// syntheticEmailDate is the instant supplied to both sides for the
// date_from=email templates, so a posted_at difference is a real one.
var syntheticEmailDate = time.Date(2026, 6, 18, 15, 4, 5, 0, time.UTC)

// compareSynthetic runs both implementations over one case and describes the
// disagreement, or returns "" when they agree.
func compareSynthetic(defs []tmpl.Definition, compiled []*tmpl.Compiled, tc syntheticCase) string {
	cascade := &v1.Cascade{
		Parsers:   []v1.BankParser{v1.DIBParser{}, v1.ENBDParser{}, v1.ENBDAlertParser{}},
		Heuristic: v1.HeuristicParser{},
		AI:        nil,
	}
	got1 := runV1Text(context.Background(), cascade, tc.from, tc.subject, tc.text, syntheticEmailDate)
	hits := runV2(defs, compiled, tc.from, tc.subject, tc.text, syntheticEmailDate)
	switch {
	case len(hits) > 1:
		ids := make([]string, 0, len(hits))
		for _, h := range hits {
			ids = append(ids, h.id)
		}
		return fmt.Sprintf("%d seed templates claimed the message: %s", len(hits), strings.Join(ids, ", "))
	case got1.hit && len(hits) == 0:
		return fmt.Sprintf("v1 extracted a transaction and no seed matched:\n%s\ntext:\n%s",
			describeV1(got1.txn), tc.text)
	case !got1.hit && len(hits) == 1:
		return fmt.Sprintf("v1's template tier extracted nothing and %s extracted %s\ntext:\n%s",
			hits[0].id, describeV2(hits[0].e), tc.text)
	case got1.hit:
		if diff := diffFields(got1.txn, hits[0].e); diff != "" {
			return fmt.Sprintf("%s produced a different transaction:\n%s\ntext:\n%s",
				hits[0].id, diff, tc.text)
		}
	}
	return ""
}

// syntheticCases builds the table. It takes the anchors so no Arabic literal is
// typed here either.
func syntheticCases(a v1Anchors) []syntheticCase {
	const (
		dibFrom      = "dib.notification@dib.ae"
		enbdFrom     = "onlinebanking@emiratesnbd.com"
		alertFrom    = "alert@emiratesnbd.com"
		alertSubject = "Emirates NBD Transaction advice for account ending with 3701"
	)
	// dibBody composes the account layout: a notice line carrying the date, the
	// amount block, the description block and the account block. Any part may be
	// omitted by passing "".
	dibBody := func(notice, amount, desc, acct string) string {
		var b strings.Builder
		b.WriteString(notice + " " + a.date + " 18-06-2026 18:03\n")
		if amount != "" {
			b.WriteString(a.amount + "\n" + amount + "\n")
		}
		if desc != "" {
			b.WriteString(a.txn + "\n" + desc + "\n")
		}
		if acct != "" {
			b.WriteString(a.acct + "\n" + acct + "\n")
		}
		return b.String()
	}

	return []syntheticCase{
		// --- the description-suffix rules, and the ORDER that expresses them ---
		{"deposit notice with a DEBIT suffix",
			"v1's cascade says credit and its suffix re-derivation then says debit. This is the case " +
				"the whole override question is about: the suffix must WIN.",
			dibFrom, "", dibBody(a.deposit, "AED 500.00", "SOME PAYMENT DEBIT", "0311000123456")},
		{"debit notice with a CREDIT suffix",
			"the mirror image, and the half a single `override` entry cannot express",
			dibFrom, "", dibBody(a.debitNotice, "AED 500.00", "SALARY MAY CREDIT", "0311000123456")},
		{"withdrawal notice with a CREDIT suffix",
			"the second debit anchor against the credit suffix",
			dibFrom, "", dibBody(a.withdrawal, "AED 500.00", "REVERSAL CREDIT", "0311000123456")},
		{"suffix in the middle of the description, not at the end",
			"v1 uses HasSuffix, so a description CONTAINING debit must NOT flip the direction",
			dibFrom, "", dibBody(a.deposit, "AED 500.00", "DEBIT CARD REFUND", "0311000123456")},
		{"lower-case debit suffix",
			"v1 upper-cases the description before testing it; the template carries flags [\"i\"]",
			dibFrom, "", dibBody(a.deposit, "AED 500.00", "some payment debit", "0311000123456")},
		{"suffix on the LAST line of the body",
			"the (?:\\n|$) alternative: v1's (.+) ends at the end of the text just as it does at a newline",
			dibFrom, "", a.deposit + " " + a.date + " 18-06-2026\n" + a.amount + "\nAED 500.00\n" + a.txn + "\nSOME PAYMENT DEBIT"},

		// --- the rest of the four-way cascade ---
		{"deposit notice, no suffix",
			"the first cascade arm on its own",
			dibFrom, "", dibBody(a.deposit, "AED 500.00", "SALARY MAY", "0311000123456")},
		{"debit notice, no suffix",
			"the second arm",
			dibFrom, "", dibBody(a.debitNotice, "AED 500.00", "ATM WITHDRAWAL", "0311000123456")},
		{"withdrawal notice, no suffix",
			"the second arm's other anchor",
			dibFrom, "", dibBody(a.withdrawal, "AED 500.00", "ATM WITHDRAWAL", "0311000123456")},
		{"deposit notice AND the preposition together",
			"the two cascade arms that disagree: v1's switch reaches the deposit arm first and " +
				"never evaluates the preposition. Without a case where they differ, deleting the " +
				"deposit arm is an equivalent mutant — the unconditional default is credit too",
			dibFrom, "", dibBody(a.deposit+" "+a.fromAccount, "AED 500.00", "SALARY MAY", "0311000123456")},
		{"no notice, من الحساب present",
			"the conditional default's debit half — never decisive on the corpus",
			dibFrom, "", dibBody("TRANSFER "+a.fromAccount, "AED 500.00", "OWN ACCOUNT MOVE", "0311000123456")},
		{"no notice, no preposition",
			"the unconditional default: v1 falls through to credit",
			dibFrom, "", dibBody("SOMETHING ELSE", "AED 500.00", "MYSTERY MOVEMENT", "0311000123456")},
		{"no notice, no description at all",
			"the default fires with no description block to re-derive from",
			dibFrom, "", dibBody("SOMETHING ELSE", "AED 500.00", "", "0311000123456")},

		// --- is_transfer ---
		{"transfer, spelled correctly",
			"one half of v1's TRNSFER||TRANSFER test",
			dibFrom, "", dibBody(a.debitNotice, "AED 500.00", "OUTWARD TRANSFER", "0311000123456")},
		{"transfer, DIB's misspelling",
			"the other half; the misspelling is DIB's",
			dibFrom, "", dibBody(a.debitNotice, "AED 500.00", "OUTWARD TRNSFER", "0311000123456")},
		{"transfer, lower case",
			"v1 tests the upper-cased description",
			dibFrom, "", dibBody(a.debitNotice, "AED 500.00", "outward transfer", "0311000123456")},

		// --- last4 capture semantics ---
		{"account line with a trailing token",
			"v1 captures (\\S+), NOT the rest of the line; a whole-line capture would take " +
				"its last four digits from the wrong token",
			dibFrom, "", dibBody(a.debitNotice, "AED 500.00", "SOME PAYMENT", "0311****1234 (Savings 5)")},
		{"card line with a trailing token that carries its own digits",
			"the same, on the card layout. The trailing token has DIGITS on purpose: with a bare " +
				"\"VISA\" both spellings still yield 7502, and the case proves nothing",
			dibFrom, "", a.cardLayout + " " + a.date + " 18-06-2026 18:03\n" + a.card +
				"\n462467XXXXXX7502 (Visa 5)\n" + a.amount + "\nAED 124.00\n" + a.payee +
				"\nNOIRO CAFE\nDIB CUSTOMER CARE 0097146092222\n"},
		{"card merchant followed by another line",
			"v1's (.+) stops at the newline; a capture that ran to the end of the text would " +
				"swallow the footer. The corpus catches this 4,997 times over, but only because " +
				"real DIB mail always has a footer",
			dibFrom, "", a.cardLayout + " " + a.date + " 18-06-2026 18:03\n" + a.card +
				"\n462467XXXXXX7502\n" + a.amount + "\nAED 124.00\n" + a.payee +
				"\nNOIRO CAFE\nDIB CUSTOMER CARE\n"},

		// --- amounts ---
		{"amount with no currency prefix",
			"default_currency applies, as v1's ParseAEDToFils defaults to AED",
			dibFrom, "", dibBody(a.debitNotice, "500.00", "SOME PAYMENT", "0311000123456")},
		{"foreign currency",
			"the ccy group wins over default_currency",
			dibFrom, "", dibBody(a.debitNotice, "USD 99.99", "SOME PAYMENT", "0311000123456")},
		{"thousands separators",
			"commas are stripped before conversion in both",
			dibFrom, "", dibBody(a.debitNotice, "AED 1,234,567.89", "SOME PAYMENT", "0311000123456")},

		// --- ENBD transfer ---
		{"enbd transfer, timed date",
			"the shape all 62 corpus messages have",
			enbdFrom, "Local Bank Transfer",
			"Transaction Date:\n24/Nov/2024 08:03 PM\nFrom Account:\n067***17***01\nDebit Amount:\nAED 108,564.00\nBeneficiary Name:\nSOME BENEFICIARY\n"},
		{"enbd transfer, date only",
			"v1's strings.Fields(s)[0] fallback in ParseENBDDate — never taken on the corpus",
			enbdFrom, "Telegraphic Transfer",
			"Transaction Date:\n24/Nov/2024\nFrom Account:\n067***17***01\nDebit Amount:\nAED 108,564.00\nBeneficiary Name:\nSOME BENEFICIARY\n"},
		{"enbd transfer, date with unparseable trailing text",
			"the fallback again, this time because the whole string does not parse",
			enbdFrom, "Local Bank Transfer",
			"Transaction Date:\n24/Nov/2024 25:99 XX\nFrom Account:\n067***17***01\nDebit Amount:\nAED 108,564.00\nBeneficiary Name:\nSOME BENEFICIARY\n"},
		{"enbd transfer, no beneficiary",
			"merchant is not required; the transaction still extracts",
			enbdFrom, "Local Bank Transfer",
			"Transaction Date:\n24/Nov/2024 08:03 PM\nDebit Amount:\nAED 108,564.00\n"},

		// --- ENBD alert: 1 corpus message, so nearly everything here is new ---
		{"enbd alert, withdrawn",
			"the corpus's single alert is this shape",
			alertFrom, alertSubject,
			"AED 250,000.00 has been withdrawn from your account 067XXX17XXX01.\n"},
		{"enbd alert, debited",
			"the second debit verb",
			alertFrom, alertSubject,
			"AED 12.34 has been debited from your account 067XXX17XXX01.\n"},
		{"enbd alert, credited",
			"the credit branch, which no corpus message takes",
			alertFrom, alertSubject,
			"AED 400.00 has been credited to your account 067XXX17XXX01.\n"},
		{"enbd alert, deposited into",
			"the (?:in)?to alternative",
			alertFrom, alertSubject,
			"AED 400.00 has been deposited into your account 067XXX17XXX01.\n"},
		{"enbd alert, subject without a last4",
			"last4 is read from the subject and is not required",
			alertFrom, "Emirates NBD Transaction advice",
			"AED 400.00 has been credited to your account 067XXX17XXX01.\n"},
		{"enbd alert, neither verb",
			"no amount entry produces a value; both sides extract nothing",
			alertFrom, alertSubject,
			"AED 250.00 has been reserved on your account 067XXX17XXX01.\n"},

		// --- shapes that must extract NOTHING on both sides ---
		{"dib card layout with no amount",
			"v1's parser errors; v2's required-field gate fires",
			dibFrom, "", a.cardLayout + " " + a.date + " 18-06-2026\n" + a.payee + "\nNOIRO CAFE\n"},
		{"dib account layout with no date",
			"same, for the other required field",
			dibFrom, "", a.deposit + "\n" + a.amount + "\nAED 500.00\n" + a.txn + "\nSALARY\n"},
		{"dib amount with one decimal place",
			"a conversion failure in both, never a rounded number",
			dibFrom, "", dibBody(a.debitNotice, "AED 500.0", "SOME PAYMENT", "0311000123456")},
		{"dib date that is not a real day",
			"31 February: Go's time.Parse range-checks, and so must the template",
			dibFrom, "", a.deposit + " " + a.date + " 31-02-2026\n" + a.amount + "\nAED 500.00\n" + a.txn + "\nSALARY\n"},
	}
}
