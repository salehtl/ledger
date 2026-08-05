package seed

import (
	"testing"

	"ledger/internal/v2/tmpl"
)

// Which published templates can actually claim the narrow auto-trust exception
// on a signer that leaves Content-Type unsigned (ingest.decodeWitnessed).
//
// This is here rather than left implicit because the answer is uneven and the
// unevenness is a product fact, not an accident to be discovered later from a
// user saying "half my DIB mail still asks me to confirm":
//
//   - dib.card.v1 gates on "إشعار مشتريات". Non-ASCII, so it witnesses the
//     decode, and DIB card mail auto-trusts.
//   - dib.account.v1 gates only by EXCLUSION (body_not_contains, the complement
//     that makes the pair a partition — see TestDIBSeedsPartitionEveryDIBMessage).
//     An absence cannot witness a decode, so DIB account mail still needs
//     review on every message.
//   - The ENBD pair needs no exception: its Proofpoint signer covers both
//     decoding headers, so those messages were never flagged in the first place.
//
// Closing the dib.account.v1 gap means adding a positive Arabic literal to a
// PUBLISHED template, which is a version bump and a corpus-gate re-run, so it
// is an operator decision rather than something to slip in here. Until it is
// made, this test is the record that the gap exists and is known.
func TestWhichSeedTemplatesCanWitnessTheirOwnDecode(t *testing.T) {
	want := map[string]bool{
		"dib.card.v1":      true,
		"dib.account.v1":   false,
		"enbd.alert.v1":    false,
		"enbd.transfer.v1": false,
	}
	seen := map[string]bool{}
	for _, d := range Seed() {
		w, ok := want[d.ID]
		if !ok {
			t.Errorf("published template %s is not in this table; decide whether its gate "+
				"literal witnesses its decode and record the answer here", d.ID)
			continue
		}
		seen[d.ID] = true
		got := len(d.DecodeWitnesses()) > 0
		if got != w {
			t.Errorf("%s: DecodeWitnesses() non-empty = %v, want %v (body_contains = %q)",
				d.ID, got, w, d.Match.BodyContains)
		}
	}
	for id := range want {
		if !seen[id] {
			t.Errorf("%s is in this table but is no longer published", id)
		}
	}
}

// The one that carries the exception, pinned specifically: dib.card.v1's
// witness must be its own gate literal, verbatim, because ingest checks that
// exact string against the decoded text the extraction read.
func TestDIBCardWitnessIsItsOwnGateLiteral(t *testing.T) {
	var card tmpl.Definition
	for _, d := range Seed() {
		if d.ID == "dib.card.v1" {
			card = d
		}
	}
	if card.ID == "" {
		t.Fatal("dib.card.v1 is no longer published")
	}
	ws := card.DecodeWitnesses()
	if len(ws) != 1 || len(card.Match.BodyContains) != 1 || ws[0] != card.Match.BodyContains[0] {
		t.Fatalf("witnesses = %q, body_contains = %q; they must be the same single literal",
			ws, card.Match.BodyContains)
	}
	if ws[0] != "إشعار مشتريات" {
		t.Errorf("dib.card.v1 gates on %q; the auto-trust exception for DIB rests on this "+
			"literal being the Arabic one a mis-decode destroys", ws[0])
	}
}
