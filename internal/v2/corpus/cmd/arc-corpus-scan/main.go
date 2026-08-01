// Command arc-corpus-scan reproduces the evidence behind the ARC GO verdict.
//
// The verdict in docs/superpowers/specs/v2-arc-spike.md rests on two numbers:
// every ARC chain in the v1 corpus verifies, and every one of them fails when a
// single body byte is flipped. Prose is not a reproducer — the second number is
// the one that distinguishes a working verifier from one that short-circuits,
// and a reader who cannot re-run it has to take the claim on trust.
//
// Usage:
//
//	LEDGER_CORPUS_DB=/scratch/corpus.db go run ./internal/v2/corpus/cmd/arc-corpus-scan
//
// It needs the corpus snapshot and live DNS, which is why it is a command and
// not a test: every committed test in this repo runs offline.
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"sort"
	"sync"
	"time"

	"ledger/internal/v2/arc"
	"ledger/internal/v2/corpus"
)

func main() {
	dbPath := flag.String("db", corpus.DefaultPath(), "corpus .backup snapshot (default $LEDGER_CORPUS_DB)")
	offline := flag.String("dns", "", "optional recorded-DNS JSON file to use instead of a live resolver")
	flag.Parse()

	if *dbPath == "" {
		log.Fatal("no corpus snapshot: set LEDGER_CORPUS_DB or pass --db")
	}
	if err := run(*dbPath, *offline); err != nil {
		log.Fatal(err)
	}
}

func run(dbPath, dnsFile string) error {
	db, err := corpus.Open(dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	total, err := db.Count()
	if err != nil {
		return err
	}

	lookup, keyCount := resolver(dnsFile)

	var (
		status     = map[string]int{}
		byShape    = map[string]int{}
		sealers    = map[string]int{}
		negControl = map[string]int{}
		reasons    = map[string]int{}
		scanned    int
	)
	start := time.Now()

	err = db.Each(func(m corpus.Message) error {
		scanned++
		res, err := arc.Verify(context.Background(), m.RawBody, lookup)
		if err != nil && res.Status != arc.StatusFail {
			status["error"]++
			reasons["unparseable: "+err.Error()]++
			return nil
		}
		status[res.Status]++
		if res.Status == arc.StatusNone {
			return nil
		}
		byShape[fmt.Sprintf("%d-instance %s", res.Instances, res.Status)]++
		if res.Status == arc.StatusFail {
			reasons[truncate(res.Reason, 90)]++
			return nil
		}

		for _, f := range res.Header.Get("ARC-Seal") {
			tg := arc.ParseTags(f.Value)
			sealers[tg["d"]+"/"+tg["s"]]++
		}

		// The negative control. A verifier that never reaches the crypto would
		// report the same passes as one that does; only this distinguishes
		// them. Mutate mid-body, clear of trailing whitespace that
		// canonicalization legitimately discards, and require the mutation to
		// have landed before drawing any conclusion from the result.
		bad, ok := flipMidBodyByte(m.RawBody)
		if !ok {
			negControl["no-mutation-possible"]++
			return nil
		}
		neg, _ := arc.Verify(context.Background(), bad, lookup)
		negControl[neg.Status]++
		return nil
	})
	if err != nil {
		return err
	}

	fmt.Printf("corpus:      %s (%d rows)\n", dbPath, total)
	fmt.Printf("scanned:     %d messages in %s\n", scanned, time.Since(start).Round(time.Millisecond))
	fmt.Printf("keys:        %d distinct DNS lookups\n\n", keyCount())

	fmt.Println("chain status:")
	printMap(status)
	fmt.Println("\nby shape:")
	printMap(byShape)
	fmt.Println("\nsealers (one count per seal, not per message):")
	printMap(sealers)
	fmt.Println("\nNEGATIVE CONTROL — same passing messages, one mid-body byte flipped:")
	printMap(negControl)
	if len(reasons) > 0 {
		fmt.Println("\nfailure reasons:")
		printMap(reasons)
	} else {
		fmt.Println("\nfailure reasons: none")
	}

	// The verdict's two claims, asserted rather than left to the reader.
	pass, fail := status[arc.StatusPass], status[arc.StatusFail]
	fmt.Println()
	if fail != 0 || status["error"] != 0 {
		return fmt.Errorf("VERDICT EVIDENCE BROKEN: %d chains fail, %d unparseable (expected 0)", fail, status["error"])
	}
	if negControl[arc.StatusPass] != 0 {
		return fmt.Errorf("VERDICT EVIDENCE BROKEN: %d tampered messages still pass — the verifier is short-circuiting", negControl[arc.StatusPass])
	}
	if negControl[arc.StatusFail] != pass {
		return fmt.Errorf("VERDICT EVIDENCE BROKEN: %d passing chains but only %d rejected when tampered", pass, negControl[arc.StatusFail])
	}
	fmt.Printf("OK: %d/%d ARC chains verify, and all %d fail when one body byte is flipped.\n", pass, pass, pass)
	return nil
}

// flipMidBodyByte changes one lowercase letter in the middle of the body and
// reports whether it found one to change.
func flipMidBodyByte(raw []byte) ([]byte, bool) {
	i := bytes.Index(raw, []byte("\r\n\r\n"))
	if i < 0 {
		return nil, false
	}
	out := append([]byte(nil), raw...)
	for j := i + 4 + (len(out)-i-4)/2; j < len(out); j++ {
		if out[j] >= 'a' && out[j] <= 'y' {
			out[j]++
			return out, true
		}
	}
	return nil, false
}

// resolver returns a memoised TXT lookup, either live or from a recorded file.
func resolver(dnsFile string) (arc.LookupTXT, func() int) {
	var mu sync.Mutex
	cache := map[string][]string{}

	if dnsFile != "" {
		// arc.FixtureLookup, not a second reader of the same file: `ledgerd
		// serve --dns-fixtures` loads the identical recording, and two loaders
		// would be two chances to disagree about what "not recorded" means.
		lookup, n, err := arc.FixtureLookup(dnsFile)
		if err != nil {
			log.Fatal(err)
		}
		return lookup, func() int { return n }
	}

	lookup := func(ctx context.Context, name string) ([]string, error) {
		mu.Lock()
		v, seen := cache[name]
		mu.Unlock()
		if !seen {
			c, cancel := context.WithTimeout(ctx, 10*time.Second)
			recs, _ := net.DefaultResolver.LookupTXT(c, name)
			cancel()
			mu.Lock()
			cache[name] = recs
			mu.Unlock()
			v = recs
		}
		if len(v) == 0 {
			return nil, arc.ErrNoKey
		}
		return v, nil
	}
	return lookup, func() int {
		mu.Lock()
		defer mu.Unlock()
		return len(cache)
	}
}

func printMap(m map[string]int) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if m[keys[i]] != m[keys[j]] {
			return m[keys[i]] > m[keys[j]]
		}
		return keys[i] < keys[j]
	})
	for _, k := range keys {
		fmt.Printf("  %6d  %s\n", m[k], k)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
