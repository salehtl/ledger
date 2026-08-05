package ingest

// decodewitness_test.go covers the narrow guardrail on unsigned decoding
// headers: the ingest pipeline's decodeWitnessed, wired at the template-hit
// branch of parse.
//
// The rule these tests hold: an UNTAMPERED decode auto-trusts, a TAMPERED one
// still goes to review, and anything with no witness to check goes to review.
// The blunt tests that came before this — TestATemplateHitWhoseDecodingHeader
// IsUnsignedIsNotAutoTrusted and TestAnInPlaceEditOfAnUnsignedDecodingHeader
// ChangesTheAmount, both in pipeline_test.go — are the fail-closed half and
// still pass unchanged; every message they build gates on an ASCII literal or
// leaves Content-Transfer-Encoding unsigned, which is exactly the pair of
// cases this exception does not cover.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/origin"
	"ledger/internal/v2/tmpl"
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// arabicGate is the literal dib.card.v1 actually gates on — "purchase notice".
// The real one, not a stand-in, because the whole argument is about what a
// mis-decode does to these specific bytes.
const arabicGate = "إشعار مشتريات"

// arabicTemplate is bankTemplate with an Arabic gate literal instead of an
// ASCII one. Everything else — the patterns, the required fields — is
// identical, so any difference in outcome between the two is the gate literal
// and nothing else.
func arabicTemplate() tmpl.Definition {
	d := bankTemplate()
	d.ID = "bank.arabic.v1"
	d.Match.BodyContains = []string{arabicGate}
	return d
}

// arabicBody is templateBody with the Arabic gate line on top.
const arabicBody = arabicGate + "\n" +
	"Amount AED 250.00\n" +
	"Date 05-06-2026\n" +
	"Merchant:CARREFOUR HYPERMARKET\n" +
	"Card 3701\n"

// base64Message is the DIB wire shape: a text/plain leaf whose UTF-8 bytes are
// base64-encoded, exactly as internal/v2/origin/testdata/dib-dkim-unexpired.eml
// carries them. The charset is a Content-Type parameter, so it is the field an
// attacker holding this message may rewrite; the transfer encoding is its own
// header and d=dib.ae signs it.
func base64Message(charset, body string) []byte {
	enc := base64.StdEncoding.EncodeToString([]byte(strings.ReplaceAll(body, "\n", "\r\n")))
	var lines []string
	for len(enc) > 76 {
		lines = append(lines, enc[:76])
		enc = enc[76:]
	}
	lines = append(lines, enc)
	return []byte("From: <alerts@bank.example>\r\n" +
		"To: <u-abc@in.example.test>\r\n" +
		"Subject: Transaction Alert\r\n" +
		"Date: Sat, 01 Aug 2026 09:00:00 +0000\r\n" +
		"Content-Type: text/plain; charset=" + charset + "\r\n" +
		"Content-Transfer-Encoding: base64\r\n" +
		"\r\n" + strings.Join(lines, "\r\n") + "\r\n")
}

// unmarshalPayload decodes one op payload. rig.onlyPayload does the same for
// the single-op case; these tests also have to look at deliveries that produced
// an op of some other shape, where "exactly one" is not the assertion.
func unmarshalPayload(t *testing.T, b []byte) payload {
	t.Helper()
	var p payload
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

// ---------------------------------------------------------------------------
// The exception: an untampered decode auto-trusts
// ---------------------------------------------------------------------------

// The whole point of the change, on the shape it was built for: Dubai Islamic
// Bank's h= omits Content-Type, and its template gates on an Arabic literal
// that only the intended decode produces. The transaction is auto-trusted.
func TestADIBShapedHitWhoseArabicGateSurvivedTheDecodeIsAutoTrusted(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(arabicTemplate())
	raw := r.keys.signOmitting("bank.example", "sel",
		base64Message("utf-8", arabicBody), "Content-Type")
	r.mustDeliver(raw, "alerts@bank.example")

	if got := r.heldCount(); got != 0 {
		t.Fatalf("quarantine holds %d items; this message is trusted and must be appended", got)
	}
	p := r.onlyPayload()
	if p.Tier != diag.TierTemplate || p.Unparsed {
		t.Fatalf("payload = %+v, want a template hit", p)
	}
	if p.AmountMinor != "25000" || p.MerchantRaw != "CARREFOUR HYPERMARKET" {
		t.Fatalf("extraction = %s / %q, want 25000 / CARREFOUR HYPERMARKET", p.AmountMinor, p.MerchantRaw)
	}
	if p.NeedsReview {
		t.Error("needs_review = true; the decoded text still carries the Arabic gate literal, " +
			"the transfer encoding was signed, and that is the whole condition for auto-trust")
	}
}

// The same message with every decoding header signed. This is the control: if
// it did NOT auto-trust, the test above would be measuring the signature rather
// than the witness.
func TestTheSameArabicMessageFullySignedIsAlsoAutoTrusted(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(arabicTemplate())
	r.mustDeliver(r.keys.sign("bank.example", "sel", base64Message("utf-8", arabicBody)),
		"alerts@bank.example")

	if p := r.onlyPayload(); p.Tier != diag.TierTemplate || p.NeedsReview || p.Unparsed {
		t.Fatalf("payload = %+v, want a trusted template hit", p)
	}
}

// ---------------------------------------------------------------------------
// Tampering: the witness is destroyed, and the message goes to review
// ---------------------------------------------------------------------------

// Rewrite the one unsigned decoding header IN PLACE — the charset parameter,
// one occurrence, nothing duplicated — and the signature still verifies. The
// base64 body now decodes as Latin-1, the Arabic literal is mojibake, and the
// template that gated on it no longer matches at all.
//
// This is the measurement item 0 of NEEDS-SALEH.md rests on, reproduced here as
// a test rather than inherited as a claim: the rewrites that change the decode
// destroy the witness, and what is left falls to a tier that is always
// reviewed. The tier assertion is the sharp one — it says the gate literal was
// genuinely destroyed, not merely that something downstream set a flag.
func TestRewritingTheUnsignedCharsetDestroysTheWitnessAndForcesReview(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(arabicTemplate())
	raw := r.keys.signOmitting("bank.example", "sel",
		base64Message("utf-8", arabicBody), "Content-Type")
	edited := bytes.Replace(raw, []byte("charset=utf-8"), []byte("charset=iso-8859-1"), 1)
	if bytes.Equal(edited, raw) {
		t.Fatal("the header parameter this test rewrites is not in the message")
	}
	r.mustDeliver(edited, "alerts@bank.example")

	if n := r.heldCount(); n != 0 {
		t.Fatalf("the edited message was quarantined (%d held); the premise is that editing an "+
			"UNSIGNED field leaves the signature verifying, so it must still be appended", n)
	}
	// onlyPayload rather than a loop: a loop over an empty op set asserts
	// nothing, and "nothing was appended" would be its own defect (§2's drop
	// policy) rather than a pass.
	p := r.onlyPayload()
	if p.Tier == diag.TierTemplate {
		t.Errorf("tier = template after a charset rewrite; the Arabic gate literal cannot have "+
			"survived the decode, so this test is no longer measuring what it claims (%+v)", p)
	}
	if !p.NeedsReview {
		t.Errorf("payload = %+v is auto-trusted; the charset that produced this text was "+
			"chosen by whoever handed us the message, not by the signer", p)
	}
}

// ---------------------------------------------------------------------------
// The construction the guardrail must NOT let through
// ---------------------------------------------------------------------------

// witnessedQPAmbiguousBody is qpAmbiguousBody with the Arabic gate literal on
// top: one sequence of bytes carrying two different amounts depending on the
// transfer decoding, and a WITNESS that survives both.
//
//	quoted-printable: "=31=30=30" is "100", so the first Amount line reads 100.00
//	7bit:             "=31=30=30" is literal, no amount parses there, and the
//	                  template's regex walks on to the next Amount line, 900.00
//
// Raw UTF-8 is invisible to a quoted-printable decoder — it consumes '=' and
// copies everything else — so the Arabic reads identically under both. That is
// precisely why a witness literal cannot be the only condition, and why
// decodeWitnessed also requires the transfer encoding to have been signed.
const witnessedQPAmbiguousBody = arabicGate + "\n" +
	"Amount =31=30=30.00\n" +
	"Amount 900.00\n" +
	"Date 05-06-2026\n" +
	"Merchant:CARREFOUR HYPERMARKET\n" +
	"Card 3701\n"

func witnessedQPMessage(cte string) []byte {
	return []byte("From: <alerts@bank.example>\r\n" +
		"To: <u-abc@in.example.test>\r\n" +
		"Subject: Transaction Alert\r\n" +
		"Date: Sat, 01 Aug 2026 09:00:00 +0000\r\n" +
		"Content-Type: text/plain; charset=utf-8\r\n" +
		"Content-Transfer-Encoding: " + cte + "\r\n" +
		"\r\n" + strings.ReplaceAll(witnessedQPAmbiguousBody, "\n", "\r\n"))
}

// The construction from item 0 of NEEDS-SALEH.md, run against the guardrail
// with the witness PRESENT — the hardest case the exception has to refuse.
//
// The template matches both readings, the Arabic literal survives both, only
// the amount differs, and the header that decides which amount is recorded is
// unsigned. Both messages must land in review: the tampered one because it is
// tampered, and the honest one because at the point of decision it is
// byte-indistinguishable from the tampered one.
func TestTheQuotedPrintableConstructionStaysInReviewEvenWithAWitnessPresent(t *testing.T) {
	signed := func(r *rig) []byte {
		return r.keys.signOmitting("bank.example", "sel", witnessedQPMessage("7bit"),
			"Content-Transfer-Encoding")
	}

	honest := newRig(t)
	honest.allow("bank.example", origin.ScopeOuter)
	honest.publish(arabicTemplate())
	honest.mustDeliver(signed(honest), "alerts@bank.example")
	got := honest.onlyPayload()

	attacked := newRig(t)
	attacked.allow("bank.example", origin.ScopeOuter)
	attacked.publish(arabicTemplate())
	raw := signed(attacked)
	edited := bytes.Replace(raw,
		[]byte("Content-Transfer-Encoding: 7bit"),
		[]byte("Content-Transfer-Encoding: quoted-printable"), 1)
	if bytes.Equal(edited, raw) {
		t.Fatal("the header this test rewrites is not in the message")
	}
	attacked.mustDeliver(edited, "alerts@bank.example")
	if n := attacked.heldCount(); n != 0 {
		t.Fatalf("the edited message was quarantined (%d held); the premise is that editing an "+
			"UNSIGNED field leaves the signature verifying", n)
	}
	tampered := attacked.onlyPayload()

	// The premise: the witness survived the edit, so the exception's literal
	// check is genuinely satisfied on BOTH and cannot be what saves this.
	if got.Tier != diag.TierTemplate || tampered.Tier != diag.TierTemplate {
		t.Fatalf("tiers = %s / %s; this test only means something while the Arabic-gated "+
			"template WINS on both readings", got.Tier, tampered.Tier)
	}
	if got.AmountMinor != "90000" {
		t.Errorf("honest amount = %s, want 90000 (the 7bit reading)", got.AmountMinor)
	}
	if tampered.AmountMinor != "10000" {
		t.Errorf("tampered amount = %s, want 10000 (the quoted-printable reading)", tampered.AmountMinor)
	}
	if got.AmountMinor == tampered.AmountMinor {
		t.Fatal("the edit changed nothing; this test proves nothing")
	}
	if !tampered.NeedsReview {
		t.Error("the tampered message is auto-trusted: a wrong amount entered the ledger silently")
	}
	if !got.NeedsReview {
		t.Error("the honest message is auto-trusted, which cannot be right when the tampered one " +
			"is byte-indistinguishable from it at the point of decision")
	}
}

// ---------------------------------------------------------------------------
// Fail closed: no witness means no exception
// ---------------------------------------------------------------------------

// A template with an ASCII-only gate literal gets no exception, because an
// ASCII literal reads identically under every charset a decoder will accept and
// so witnesses nothing. Same signer, same body shape, same unsigned header as
// TestADIBShapedHitWhoseArabicGateSurvivedTheDecodeIsAutoTrusted — the ONLY
// difference is that the gate literal is "Purchase alert".
func TestAnASCIIGateLiteralBuysNoAutoTrust(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(bankTemplate())
	raw := r.keys.signOmitting("bank.example", "sel",
		base64Message("utf-8", templateBody), "Content-Type")
	r.mustDeliver(raw, "alerts@bank.example")

	p := r.onlyPayload()
	if p.Tier != diag.TierTemplate || p.AmountMinor != "25000" {
		t.Fatalf("payload = %+v, want the same template hit as the Arabic case", p)
	}
	if !p.NeedsReview {
		t.Error("needs_review = false on an ASCII-gated template; \"Purchase alert\" survives a " +
			"charset rewrite unchanged, so it is not evidence of anything")
	}
}

// A template whose only content gate is an EXCLUSION gets no exception either.
// This is dib.account.v1's shape — body_not_contains and nothing else — and it
// matters because an absence is exactly what a mis-decode manufactures.
func TestABodyNotContainsGateBuysNoAutoTrust(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	d := bankTemplate()
	d.ID = "bank.exclusion.v1"
	d.Match.BodyContains = nil
	d.Match.BodyNotContains = []string{arabicGate}
	r.publish(d)
	raw := r.keys.signOmitting("bank.example", "sel",
		base64Message("utf-8", templateBody), "Content-Type")
	r.mustDeliver(raw, "alerts@bank.example")

	p := r.onlyPayload()
	if p.Tier != diag.TierTemplate {
		t.Fatalf("payload = %+v, want a template hit", p)
	}
	if !p.NeedsReview {
		t.Error("needs_review = false; the template declares no positive literal, so there is " +
			"nothing about this decode that was measured")
	}
}

// Reprocess re-derives needs_review and supersedes when it differs, so the
// exception has to survive a reprocess or the first republish would flip an
// auto-trusted transaction back to review (and, run the other way, would clear
// the flag on a message that still deserves it). parse is the only place the
// decision is made, and all three callers go through it; this asserts the
// outcome rather than the plumbing.
func TestReprocessKeepsTheWitnessedExceptionStable(t *testing.T) {
	r := newRig(t)
	r.allow("bank.example", origin.ScopeOuter)
	r.publish(arabicTemplate())
	raw := r.keys.signOmitting("bank.example", "sel",
		base64Message("utf-8", arabicBody), "Content-Type")
	r.mustDeliver(raw, "alerts@bank.example")
	if p := r.onlyPayload(); p.NeedsReview {
		t.Fatalf("premise: the first delivery was not auto-trusted: %+v", p)
	}

	rep, err := r.p.Reprocess(bg, r.user, [][]byte{idOf(raw)})
	if err != nil {
		t.Fatalf("reprocess: %v", err)
	}
	if rep.Superseded != 0 {
		t.Errorf("reprocess superseded %d ops; nothing about this message changed", rep.Superseded)
	}
	for _, op := range r.hotOps() {
		if p := unmarshalPayload(t, op.Payload); p.NeedsReview {
			t.Errorf("op %s carries needs_review = true after a reprocess", op.Type)
		}
	}
}

// ---------------------------------------------------------------------------
// decodeWitnessed as a unit
//
// The pipeline tests above cannot reach the case where a definition declares a
// witness the decoded text does NOT contain, because tmpl's own gate refuses to
// match such a message — which is exactly why decodeWitnessed states that
// condition itself instead of inheriting it. These pin it directly.
// ---------------------------------------------------------------------------

func TestDecodeWitnessedChecksTheTextItWasGiven(t *testing.T) {
	def := arabicTemplate()
	signedCTE := origin.Origin{DKIM: origin.SigPass, UnsignedDecoding: "content-type"}

	if decodeWitnessed(signedCTE, def, "Amount AED 250.00\n") {
		t.Error("witnessed a text that does not contain the literal at all")
	}
	// The undecoded form of the same message. If this function ever read the
	// raw bytes instead of the text the extraction used, this is what it would
	// be looking at, and it must not find a witness in it.
	undecoded := base64.StdEncoding.EncodeToString([]byte(arabicBody))
	if decodeWitnessed(signedCTE, def, undecoded) {
		t.Error("witnessed the base64 source; the literal is only in the DECODED text")
	}
	if !decodeWitnessed(signedCTE, def, arabicBody) {
		t.Error("did not witness the decoded text, which contains the literal")
	}
}

func TestDecodeWitnessedRequiresEveryDeclaredWitness(t *testing.T) {
	def := arabicTemplate()
	def.Match.BodyContains = []string{arabicGate, "إشعار إيداع"}
	o := origin.Origin{DKIM: origin.SigPass, UnsignedDecoding: "content-type"}
	if decodeWitnessed(o, def, arabicBody) {
		t.Error("one witness of two is enough; a partial decode would pass")
	}
}

func TestDecodeWitnessedRefusesWhenTheTransferEncodingIsUnsigned(t *testing.T) {
	def := arabicTemplate()
	for _, unsigned := range []string{
		"content-transfer-encoding",
		"content-type, content-transfer-encoding",
	} {
		o := origin.Origin{DKIM: origin.SigPass, UnsignedDecoding: unsigned}
		if decodeWitnessed(o, def, arabicBody) {
			t.Errorf("UnsignedDecoding = %q witnessed; the transfer decoding rewrites ASCII, "+
				"which no literal can witness", unsigned)
		}
	}
}

// An Origin nothing verified cannot witness anything, whatever its coverage
// field happens to say. This is the shape a quarantine promote or a reprocess
// reconstructs when it cannot re-derive coverage, and its empty
// UnsignedDecoding would otherwise read as "every decoding header was signed".
func TestDecodeWitnessedRefusesAnUnverifiedOrigin(t *testing.T) {
	def := arabicTemplate()
	for _, o := range []origin.Origin{
		{},
		{DKIM: origin.SigNone},
		{DKIM: origin.SigFail},
		{DKIM: origin.SigTempFail, UnsignedDecoding: "content-type"},
	} {
		if decodeWitnessed(o, def, arabicBody) {
			t.Errorf("origin %+v witnessed the decode; no signature verified over it", o)
		}
	}
}

func TestDecodeWitnessedRefusesADefinitionWithNoWitness(t *testing.T) {
	o := origin.Origin{DKIM: origin.SigPass, UnsignedDecoding: "content-type"}
	if decodeWitnessed(o, bankTemplate(), templateBody) {
		t.Error("an ASCII-only gate literal witnessed the decode")
	}
	naked := bankTemplate()
	naked.Match.BodyContains = nil
	if decodeWitnessed(o, naked, templateBody) {
		t.Error("a template with no body gate at all witnessed the decode")
	}
}
