package origin

// witness_test.go covers the two questions the ingest pipeline's narrow
// guardrail asks of an Origin: which decoding headers went unsigned, and
// specifically whether the TRANSFER decoding did.

import (
	"context"
	"slices"
	"strings"
	"testing"
)

// UnsignedDecoding is written by one Join and read by one Split. If they ever
// disagree the field becomes unreadable in a way nothing else would notice, so
// the round trip is pinned over every subset rather than over one example.
func TestUnsignedDecodingRoundTrips(t *testing.T) {
	subsets := [][]string{
		nil,
		{"content-type"},
		{"content-transfer-encoding"},
		{"content-type", "content-transfer-encoding"},
	}
	for _, want := range subsets {
		o := Origin{UnsignedDecoding: strings.Join(want, unsignedDecodingSep)}
		if got := o.UnsignedDecodingHeaders(); !slices.Equal(got, want) {
			t.Errorf("round trip of %q gave %q", want, got)
		}
	}
}

// The zero Origin is what a non-pass verdict carries, and what a quarantine
// promote or a reprocess reconstructs from stored facts that do not include
// coverage. Its empty UnsignedDecoding would read as "everything was signed",
// so the verdict is what stops it.
func TestZeroOriginTransferDecodingIsUnsigned(t *testing.T) {
	var zero Origin
	if zero.UnsignedDecoding != "" {
		t.Fatalf("premise: the zero Origin already names %q, so this test is not "+
			"exercising the empty-string reading", zero.UnsignedDecoding)
	}
	if zero.TransferDecodingSigned() {
		t.Error("the zero Origin reports the transfer decoding signed; it attests nothing")
	}
}

// The same hole one field at a time: an Origin whose coverage says "all signed"
// but whose DKIM verdict is anything other than a pass has not been verified,
// and an Origin that passed DKIM but left the transfer encoding uncovered has
// been verified over the wrong thing. Both are refusals, and they are refused
// for different reasons — a fixture with only one of them could not tell an
// implementation that reads both fields from one that reads either.
func TestTransferDecodingSignedNeedsBothAPassAndTheCoverage(t *testing.T) {
	cases := []struct {
		name string
		o    Origin
		want bool
	}{
		{"nothing verified", Origin{}, false},
		{"coverage without a pass", Origin{UnsignedDecoding: ""}, false},
		{"fail with empty coverage", Origin{DKIM: SigFail}, false},
		{"tempfail with empty coverage", Origin{DKIM: SigTempFail}, false},
		{"pass, transfer encoding uncovered", Origin{DKIM: SigPass,
			UnsignedDecoding: "content-transfer-encoding"}, false},
		{"pass, only content-type uncovered", Origin{DKIM: SigPass,
			UnsignedDecoding: "content-type"}, true},
		{"pass, everything covered", Origin{DKIM: SigPass}, true},
	}
	for _, c := range cases {
		if got := c.o.TransferDecodingSigned(); got != c.want {
			t.Errorf("%s: TransferDecodingSigned() = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestTransferDecodingSignedReadsTheHeaderNotTheCount(t *testing.T) {
	cases := []struct {
		unsigned string
		want     bool
	}{
		{"", true},
		{"content-type", true},
		{"content-transfer-encoding", false},
		{"content-type, content-transfer-encoding", false},
		{"Content-Transfer-Encoding", false}, // folding is the writer's job, not the reader's
	}
	for _, c := range cases {
		o := Origin{DKIM: SigPass, UnsignedDecoding: c.unsigned}
		if got := o.TransferDecodingSigned(); got != c.want {
			t.Errorf("UnsignedDecoding %q: TransferDecodingSigned() = %v, want %v",
				c.unsigned, got, c.want)
		}
	}
}

// The zero Origin above is a constructed value. This is the real thing: the two
// bank fixtures, resolved by the real verifier, answering the question the
// pipeline actually asks. It is what makes the guardrail's premise —
// "d=dib.ae signs Content-Transfer-Encoding and omits Content-Type" — a
// measurement rather than a claim in a comment.
func TestRealBankFixturesAnswerTheTransferDecodingQuestion(t *testing.T) {
	dib := ResolveWithEnvelope(context.Background(), mustRead(t, "dib-dkim-unexpired.eml"),
		"", recordedLookup(t))
	if got := dib.UnsignedDecodingHeaders(); !slices.Equal(got, []string{"content-type"}) {
		t.Fatalf("DIB unsigned decoding headers = %q, want [content-type]", got)
	}
	if !dib.TransferDecodingSigned() {
		t.Error("DIB: TransferDecodingSigned() = false; d=dib.ae names " +
			"content-transfer-encoding in its h=, and the whole narrow guardrail rests on it")
	}

	enbd := ResolveWithEnvelope(context.Background(), mustRead(t, "enbd-proofpoint-p.eml"),
		"", recordedLookup(t))
	if got := enbd.UnsignedDecodingHeaders(); len(got) != 0 {
		t.Errorf("ENBD unsigned decoding headers = %q, want none", got)
	}
	if !enbd.TransferDecodingSigned() {
		t.Error("ENBD: TransferDecodingSigned() = false; its signer covers both decoding headers")
	}
}
