// Command extract-fixtures turns the v1 mail corpus into committed test
// fixtures for v2's origin verification.
//
// It selects a handful of real, signed messages, writes each as a byte-exact
// .eml, resolves every DKIM/ARC public key those messages reference and records
// the answers in dns.json, and describes the set in manifest.json. After that,
// no test needs the corpus, the network, or the live database.
//
// Usage:
//
//	LEDGER_CORPUS_DB=/scratch/corpus.db go run ./internal/v2/corpus/cmd/extract-fixtures \
//	    --out internal/v2/origin/testdata
//
// # DKIM fixtures decay in three different ways
//
// A message's bytes never change, but everything a DKIM signature depends on
// outside those bytes does. Selection defends against all three, because each
// one is invisible to the checks that catch the others:
//
//  1. Expiry. DIB signs with a roughly one-year x= tag and 4,702 corpus
//     signatures have already passed it. Verifiers reject an expired signature
//     before they even look up the key. The manifest records has_x_tag and
//     x_expires_at so this failure arrives as a dated warning rather than a
//     mystery.
//
//  2. Retirement. DIB removed selector1 from DNS: 6,389 of the corpus's 6,998
//     signatures name a key that is now NXDOMAIN and can never be checked
//     again. dkim_key_in_dns records which fixtures survived that.
//
//  3. Rotation — the quiet one. emiratesnbd.com publishes selector1 as a CNAME
//     into Microsoft 365, which replaces the key behind that unchanged name.
//     48 of the 62 ENBD messages have an unexpired signature, a resolving
//     selector, a parseable key record and an intact body hash, and still fail:
//     the key that signed them is simply gone. No metadata check catches this.
//     Only verifying the signature does.
//
// So selection verifies every candidate with go-msgauth — the same library the
// consuming code uses — against the DNS answers being recorded, and refuses to
// emit a fixture that does not pass. dkim_verifies records the result.
//
// Once written, a fixture is immune to all three: dns.json pins the key bytes
// that were correct at extraction time, so the fixture keeps verifying against
// recorded DNS no matter what the real DNS does afterwards. The exception is
// expiry, which a verifier evaluates against the wall clock rather than DNS.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-msgauth/dkim"

	"ledger/internal/v2/arc"
	"ledger/internal/v2/corpus"
)

// candidate is a corpus message with the signature facts selection needs.
type candidate struct {
	id       int64
	received time.Time
	from     string
	subject  string
	raw      []byte

	dkimD       string
	dkimS       string
	hasX        bool
	xExpires    int64
	arcInsts    int
	sealDoms    []string
	sealCVs     []string
	arcComplete bool
}

type manifestEntry struct {
	File           string   `json:"file"`
	Kind           string   `json:"kind"`
	SourceID       int64    `json:"source_id"`
	ReceivedAt     string   `json:"received_at"`
	SHA256         string   `json:"sha256"`
	DKIMDomain     string   `json:"dkim_d"`
	DKIMSelector   string   `json:"dkim_selector"`
	DKIMKeyInDNS   bool     `json:"dkim_key_in_dns"`
	DKIMVerifies   bool     `json:"dkim_verifies"`
	HasXTag        bool     `json:"has_x_tag"`
	XExpiresAt     string   `json:"x_expires_at,omitempty"`
	ARCInstances   int      `json:"arc_instances"`
	ARCSealDomains []string `json:"arc_seal_domains"`
	ARCSealCVs     []string `json:"arc_seal_cv"`
	Note           string   `json:"note,omitempty"`
}

type manifest struct {
	Generated  string          `json:"generated_at"`
	CorpusSize int             `json:"corpus_size"`
	Fixtures   []manifestEntry `json:"fixtures"`
}

func main() {
	out := flag.String("out", "internal/v2/origin/testdata", "directory to write fixtures into")
	dbPath := flag.String("db", corpus.DefaultPath(), "corpus .backup snapshot (default $LEDGER_CORPUS_DB)")
	flag.Parse()

	if *dbPath == "" {
		log.Fatal("no corpus snapshot: set LEDGER_CORPUS_DB or pass --db")
	}
	if err := run(*dbPath, *out); err != nil {
		log.Fatal(err)
	}
}

func run(dbPath, outDir string) error {
	db, err := corpus.Open(dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	total, err := db.Count()
	if err != nil {
		return err
	}
	log.Printf("corpus %s: %d messages", dbPath, total)

	var (
		dibDKIM []candidate // DIB, unexpired x=, key still in DNS
		enbd    []candidate // ENBD, no x= at all — permanently stable
		arc2    []candidate // complete two-hop cv=none -> cv=pass chains
	)
	now := time.Now()
	stats := map[string]int{}

	err = db.Each(func(m corpus.Message) error {
		c, ok := classify(m, now)
		if !ok {
			return nil
		}
		stats["classified"]++
		if c.arcComplete && c.arcInsts == 2 && len(c.sealCVs) == 2 &&
			c.sealCVs[0] == "none" && c.sealCVs[1] == "pass" {
			stats["arc2hop"]++
			arc2 = append(arc2, c)
		}
		if strings.Contains(strings.ToLower(c.from), "emiratesnbd") && !c.hasX && c.dkimD != "" {
			stats["enbd_no_x"]++
			enbd = append(enbd, c)
		}
		if c.dkimD == "dib.ae" && c.hasX && c.xExpires > now.Unix() {
			stats["dib_unexpired"]++
			dibDKIM = append(dibDKIM, c)
		}
		return nil
	})
	if err != nil {
		return err
	}
	log.Printf("scan: %v", stats)

	// Resolve keys once, memoised, so selection can prefer signatures whose key
	// still exists.
	resolver := newTXTCache()
	live := func(c candidate) bool {
		if c.dkimD == "" || c.dkimS == "" {
			return false
		}
		recs, err := resolver.lookup(c.dkimS + "._domainkey." + c.dkimD)
		return err == nil && len(recs) > 0
	}

	// A resolvable key is not a usable key. Emiratesnbd.com publishes
	// selector1 as a CNAME into Microsoft 365, which rotates the key behind
	// that stable name: 48 of the corpus's 62 ENBD messages have an intact body
	// hash and a resolvable selector, and still fail, because the key that
	// signed them is gone. Rotation is invisible to every check except actually
	// verifying the signature — so selection verifies, using the same library
	// the consuming code will.
	verifies := func(c candidate) bool {
		if c.dkimD == "" {
			return false
		}
		vs, err := dkim.VerifyWithOptions(bytes.NewReader(c.raw), &dkim.VerifyOptions{
			LookupTXT: func(name string) ([]string, error) { return resolver.lookup(name) },
		})
		if err != nil {
			return false
		}
		for _, v := range vs {
			if v.Err == nil && strings.EqualFold(v.Domain, c.dkimD) {
				return true
			}
		}
		return false
	}
	usable := func(c candidate) bool { return live(c) && verifies(c) }

	var chosen []manifestEntry
	var files = map[string][]byte{}

	add := func(file, kind, note string, c candidate) {
		files[file] = c.raw
		sum := sha256.Sum256(c.raw)
		e := manifestEntry{
			File:           file,
			Kind:           kind,
			SourceID:       c.id,
			ReceivedAt:     c.received.UTC().Format(time.RFC3339),
			SHA256:         hex.EncodeToString(sum[:]),
			DKIMDomain:     c.dkimD,
			DKIMSelector:   c.dkimS,
			DKIMKeyInDNS:   live(c),
			DKIMVerifies:   verifies(c),
			HasXTag:        c.hasX,
			ARCInstances:   c.arcInsts,
			ARCSealDomains: c.sealDoms,
			ARCSealCVs:     c.sealCVs,
			Note:           note,
		}
		if e.ARCSealDomains == nil {
			e.ARCSealDomains = []string{}
		}
		if e.ARCSealCVs == nil {
			e.ARCSealCVs = []string{}
		}
		if c.hasX {
			e.XExpiresAt = time.Unix(c.xExpires, 0).UTC().Format(time.RFC3339)
		}
		chosen = append(chosen, e)
	}

	// 1. One DIB message whose DKIM signature is still unexpired and whose key
	//    still resolves. Newest first, so the fixture has the most life left,
	//    and preferring a message with no ARC headers so this fixture exercises
	//    plain DKIM rather than duplicating one of the ARC fixtures below.
	sort.Slice(dibDKIM, func(i, j int) bool { return dibDKIM[i].xExpires > dibDKIM[j].xExpires })
	var dibPick *candidate
	for pass := 0; pass < 2 && dibPick == nil; pass++ {
		for i := range dibDKIM {
			if pass == 0 && dibDKIM[i].arcInsts != 0 {
				continue
			}
			if usable(dibDKIM[i]) {
				dibPick = &dibDKIM[i]
				break
			}
		}
	}
	if dibPick == nil {
		return fmt.Errorf("no DIB message with an unexpired DKIM signature whose key is still in DNS (scanned %d)", len(dibDKIM))
	}
	add("dib-dkim-unexpired.eml", "dib-dkim",
		"DIB signs with a ~1-year x=; this fixture stops verifying at x_expires_at.", *dibPick)

	// 2. Two ENBD messages carrying no x= tag, so nothing about them expires.
	//
	//    Diversity here is by signing configuration, not by subject line. ENBD
	//    signs from two different infrastructures — Microsoft 365 under
	//    selector1 and Proofpoint under proofpoint-p — and a fixture pair that
	//    covers both key setups exercises more than a pair that differs only in
	//    what the mail says. Only 14 of the 62 ENBD messages still verify at
	//    all, and they are all recent, so subject variety is not on offer.
	var enbdUsable []candidate
	for _, c := range enbd {
		if usable(c) {
			enbdUsable = append(enbdUsable, c)
		}
	}
	sort.Slice(enbdUsable, func(i, j int) bool { return enbdUsable[i].received.After(enbdUsable[j].received) })
	var enbdPicks []candidate
	seenSel := map[string]bool{}
	for _, c := range enbdUsable {
		if !seenSel[c.dkimS] {
			seenSel[c.dkimS] = true
			enbdPicks = append(enbdPicks, c)
		}
	}
	for _, c := range enbdUsable { // top up if there is only one selector
		if len(enbdPicks) >= 2 {
			break
		}
		if enbdPicks[0].id != c.id {
			enbdPicks = append(enbdPicks, c)
		}
	}
	if len(enbdPicks) < 2 {
		return fmt.Errorf("want 2 ENBD messages with no x= tag whose signature still verifies, got %d of %d", len(enbdPicks), len(enbd))
	}
	for _, c := range enbdPicks[:2] {
		// Named by selector, because that is the axis these two differ on.
		add("enbd-"+slug(c.dkimS)+".eml", "enbd-dkim-noexpiry",
			fmt.Sprintf("subject %q, signed by %s; no x= tag, so nothing here expires", c.subject, c.dkimS), c)
	}

	// 3. Three Gmail-forwarded messages carrying complete two-hop ARC sets.
	//    Newest first: the seal keys of recent hops are the ones still in DNS.
	sort.Slice(arc2, func(i, j int) bool { return arc2[i].received.After(arc2[j].received) })
	if len(arc2) < 4 {
		return fmt.Errorf("want at least 4 two-hop ARC messages, got %d", len(arc2))
	}
	for i := 0; i < 3; i++ {
		if !usable(arc2[i]) {
			return fmt.Errorf("two-hop fixture %d (id %d) has an inner DKIM signature that no longer verifies", i+1, arc2[i].id)
		}
		add(fmt.Sprintf("gmail-forward-%d.eml", i+1), "arc-2hop",
			"cv=none -> cv=pass; no AMS carries an x= tag, so ARC fixtures cannot expire", arc2[i])
	}

	// 4. One forwarded message whose inner d=dib.ae DKIM signature survived the
	//    forward intact. This is the path that does not need ARC at all.
	var innerPick *candidate
	for i := range arc2 {
		if arc2[i].dkimD == "dib.ae" && arc2[i].hasX && arc2[i].xExpires > now.Unix() && usable(arc2[i]) {
			// Do not reuse one of the three above; a distinct message proves
			// the property holds beyond the ones already picked.
			if i < 3 {
				continue
			}
			innerPick = &arc2[i]
			break
		}
	}
	if innerPick == nil {
		return fmt.Errorf("no forwarded message with a surviving, unexpired, resolvable inner dib.ae DKIM signature")
	}
	add("gmail-forward-inner-dkim.eml", "arc-2hop-inner-dkim",
		"the original d=dib.ae signature survives the forward; Task 26's direct-DKIM path", *innerPick)

	// Resolve every key any chosen fixture references, ARC seals included, so
	// no test ever touches DNS.
	names := map[string]bool{}
	for _, e := range chosen {
		raw := files[e.File]
		for _, n := range keyNames(raw) {
			names[n] = true
		}
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)

	dns := map[string][]string{}
	var missing []string
	for _, n := range sorted {
		recs, err := resolver.lookup(n)
		if err != nil || len(recs) == 0 {
			missing = append(missing, n)
			continue
		}
		dns[n] = recs
	}
	for _, n := range missing {
		log.Printf("WARNING: no TXT record for %s (key retired); fixtures needing it cannot verify", n)
	}

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(outDir, name), body, 0o644); err != nil {
			return err
		}
	}
	if err := writeJSON(filepath.Join(outDir, "dns.json"), dns); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(outDir, "manifest.json"), manifest{
		Generated:  now.UTC().Format(time.RFC3339),
		CorpusSize: total,
		Fixtures:   chosen,
	}); err != nil {
		return err
	}

	for _, e := range chosen {
		log.Printf("%-32s %-20s id=%-5d arc=%d key_in_dns=%v x=%s",
			e.File, e.Kind, e.SourceID, e.ARCInstances, e.DKIMKeyInDNS, e.XExpiresAt)
	}
	log.Printf("wrote %d fixtures + %d DNS records to %s", len(files), len(dns), outDir)
	return nil
}

// classify extracts the DKIM and ARC facts selection depends on.
func classify(m corpus.Message, now time.Time) (candidate, bool) {
	h, _, err := arc.ReadHeader(m.RawBody)
	if err != nil {
		return candidate{}, false
	}
	c := candidate{
		id:       m.ID,
		received: m.ReceivedAt,
		from:     m.FromAddr,
		subject:  m.Subject,
		raw:      append([]byte(nil), m.RawBody...),
	}

	// The originating signature is the bottom-most DKIM-Signature: later hops
	// prepend theirs.
	dk := h.Get("DKIM-Signature")
	if len(dk) > 0 {
		t := arc.ParseTags(dk[len(dk)-1].Value)
		c.dkimD, c.dkimS = t["d"], t["s"]
		if x, ok := t["x"]; ok {
			if n, err := strconv.ParseInt(x, 10, 64); err == nil {
				c.hasX, c.xExpires = true, n
			}
		}
	}

	seals := h.Get("ARC-Seal")
	amss := h.Get("ARC-Message-Signature")
	aars := h.Get("ARC-Authentication-Results")
	c.arcInsts = len(seals)
	c.arcComplete = len(seals) > 0 && len(seals) == len(amss) && len(seals) == len(aars)

	type sealInfo struct {
		i  int
		d  string
		cv string
	}
	var infos []sealInfo
	for _, f := range seals {
		t := arc.ParseTags(f.Value)
		n, _ := strconv.Atoi(t["i"])
		infos = append(infos, sealInfo{i: n, d: t["d"], cv: t["cv"]})
	}
	sort.Slice(infos, func(a, b int) bool { return infos[a].i < infos[b].i })
	for _, s := range infos {
		c.sealDoms = append(c.sealDoms, s.d)
		c.sealCVs = append(c.sealCVs, s.cv)
	}
	return c, true
}

// keyNames returns every <selector>._domainkey.<domain> a message references,
// across DKIM-Signature, ARC-Message-Signature and ARC-Seal.
func keyNames(raw []byte) []string {
	h, _, err := arc.ReadHeader(raw)
	if err != nil {
		return nil
	}
	var out []string
	for _, name := range []string{"DKIM-Signature", "ARC-Message-Signature", "ARC-Seal"} {
		for _, f := range h.Get(name) {
			t := arc.ParseTags(f.Value)
			if t["s"] != "" && t["d"] != "" {
				out = append(out, t["s"]+"._domainkey."+t["d"])
			}
		}
	}
	return out
}

// txtCache memoises DNS TXT lookups; selection queries the same names many
// times over a 7,000-message scan.
type txtCache struct {
	r    *net.Resolver
	seen map[string][]string
	errs map[string]error
}

func newTXTCache() *txtCache {
	return &txtCache{r: net.DefaultResolver, seen: map[string][]string{}, errs: map[string]error{}}
}

func (c *txtCache) lookup(name string) ([]string, error) {
	if v, ok := c.seen[name]; ok {
		return v, c.errs[name]
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	recs, err := c.r.LookupTXT(ctx, name)
	c.seen[name], c.errs[name] = recs, err
	return recs, err
}

// slug turns a subject line into a filename fragment.
func slug(s string) string {
	var b strings.Builder
	prevDash := true
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}
