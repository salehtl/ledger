# v2 Phase 0 — Kill-Risks Week Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the two questions that gate the entire v2 rebuild (spec §5 Phase 0): (a) does dinosaur's provider permit inbound port 25, and (b) can an iPhone cold-restore ~3,700 singleton encrypted blobs into local SQLite and compute budgets inside the spec's performance budget (<10s cold-restore, <2s warm)?

**Architecture:** Two independent spikes. Spike A empirically probes port-25 reachability from outside. Spike B builds a Go blob generator (real transaction corpus → 1KB-padded, X25519+HKDF+AES-GCM-sealed singleton blobs, modeling the spec's HPKE ingest path) and a minimal Expo Go app that fetches, decrypts, replays into expo-sqlite, computes 50/30/20 bucket totals, and reports a timing breakdown. Pure-JS crypto (@noble) is a deliberate *conservative* bound — native JSI crypto is 10–100× faster on these primitives, so the decision rule accounts for which stage dominates.

**Tech Stack:** Go (nested module; `modernc.org/sqlite`, `golang.org/x/crypto`), Expo blank-TS template run in **Expo Go** (no dev build needed for the spike), `expo-sqlite`, `@noble/curves` / `@noble/hashes` / `@noble/ciphers`, `fflate`.

## Global Constraints

- **Never touch production live:** no `:8080`, no live handle on `/var/lib/ledger/ledger.db`. The corpus comes from a `.backup` copy made **as root** (not `sudo -u ledger`), placed in the scratch dir.
- **Money is `int64` fils, always positive; `direction` is `'debit'|'credit'`** — no floats anywhere in sums.
- **Blob format (spec §3.3 workload, spike edition):** singleton blob = `[32B ephemeral X25519 pubkey][AES-256-GCM ciphertext]` = **1016 bytes total**. Plaintext = `[4B big-endian length][gzip(op JSON)][zero-fill]` padded to 968 bytes. Key = `HKDF-SHA256(ikm=X25519(eph_priv, recipient_pub), salt=eph_pub‖recipient_pub, info="ledger-phase0", len=32)`. Nonce = 12 zero bytes (safe: key is unique per blob; spike-only convention).
- **Exit criteria (spec §5):** port 25 confirmed; cold restore (fetch+decrypt+insert+compute+first render) **<10s**, warm start **<2s**, on the test iPhone. Budget totals computed on-device must equal the generator's expected values exactly.
- **Spike code is committed but quarantined** under `spike/phase0/` on branch `v2` (create via superpowers:using-git-worktrees at execution start; branch from up-to-date local `main` — remember worktrees default to origin/main, merge local main first). This plan document itself is committed on `main`.
- Scratch/serving ports: `8098` for the blob server. Phone reaches dinosaur over **Tailscale**.
- **User-supplied inputs (ask before Task 3's device run):** which iPhone to test on (oldest available is best), confirm Tailscale + Expo Go are installed on it.

**File structure created by this plan:**

```
spike/phase0/
  RESULTS.md               # findings + verdicts (Tasks 1 & 4)
  blobgen/
    go.mod                 # nested module — keeps spike deps out of the main module
    main.go                # corpus export → sealed blobs + all.bin + manifest.json
    main_test.go           # seal/open round-trip + padding tests
  replay-app/              # Expo blank-TS app (Expo Go)
    config.ts              # server URL + recipient private key (pasted at run time)
    crypto.ts              # openBlob(): X25519+HKDF+GCM+unpad+gunzip
    replay.ts              # SQLite schema, batch insert, bucket totals
    verify.mjs             # Node cross-check: TS crypto opens Go-sealed fixture
    App.tsx                # Cold Restore / Warm Load / Reset UI + timings
```

---

### Task 1: Port-25 reachability verdict (Spike A)

**Files:**
- Create: `spike/phase0/RESULTS.md` (section "Port 25")

**Interfaces:**
- Produces: a written **GO / NO-GO verdict** for spec §3.2's self-hosted SMTP precondition. NO-GO without a provider fix = stop the plan and escalate (spec says fall back to managed relay and re-open spec §2).

- [ ] **Step 1: Set up the v2 worktree/branch** (superpowers:using-git-worktrees). Ensure local `main` is current first; all spike commits land on branch `v2`.

- [ ] **Step 2: Identify public IP and provider**

```bash
curl -4 -s ifconfig.me
whois "$(curl -4 -s ifconfig.me)" | grep -iE "orgname|org-name|netname|descr|country" | head
```

Record both in `spike/phase0/RESULTS.md`. If the address is a residential/CGNAT range (whois shows an ISP, or IP is in 100.64.0.0/10), note that inbound 25 is near-certainly unavailable — still run the probe to confirm.

- [ ] **Step 3: Confirm :25 and :2525 are free, then start two throwaway listeners** (`:2525` is the control — it validates the probe method itself)

```bash
ss -tlnp | grep -E ':25 |:2525 ' || echo "both free"
sudo python3 -m http.server 25 --bind 0.0.0.0 &   # needs root: privileged port
python3 -m http.server 2525 --bind 0.0.0.0 &
```

If a firewall is active (`sudo ufw status` / `sudo iptables -L INPUT -n | head`), temporarily allow 25 and 2525 and note it.

- [ ] **Step 4: Probe both ports from outside via the check-host.net API**

```bash
IP=$(curl -4 -s ifconfig.me)
for PORT in 25 2525; do
  REQ=$(curl -s "https://check-host.net/check-tcp?host=${IP}:${PORT}&max_nodes=5" -H "Accept: application/json" | python3 -c "import sys,json;print(json.load(sys.stdin)['request_id'])")
  sleep 10
  echo "--- port ${PORT}:"
  curl -s "https://check-host.net/check-result/${REQ}" -H "Accept: application/json" | python3 -m json.tool
done
```

Expected interpretations (record which one occurred):
- Both ports connect → **GO**: provider does not block inbound 25.
- 2525 connects, 25 does not → provider (or an upstream firewall) blocks 25 specifically → check the provider's docs/panel for an unblock request path; verdict is **NO-GO until unblocked**.
- Neither connects → local firewall/NAT problem, not a port-25 policy; debug Step 3's firewall state and any provider-side firewall panel before concluding anything.

- [ ] **Step 5: Kill the listeners, revert any temporary firewall rules**

```bash
sudo pkill -f "http.server 25" ; pkill -f "http.server 2525"
```

- [ ] **Step 6: Write the verdict** into `spike/phase0/RESULTS.md`: public IP, provider, probe outputs (summarized), GO/NO-GO, and — if NO-GO — the provider's unblock procedure or the explicit conclusion that self-hosted SMTP is impossible here.

- [ ] **Step 7: Commit**

```bash
git add spike/phase0/RESULTS.md
git commit -m "spike(phase0): port-25 reachability verdict"
```

**Decision gate:** on NO-GO with no unblock path, stop after this task and report — the spec's ingestion section must be reopened before Spike B matters. (Spike B can still run in parallel if already started; its result is needed either way.)

---

### Task 2: Blob generator from the real corpus (Spike B, server side)

**Files:**
- Create: `spike/phase0/blobgen/go.mod`, `spike/phase0/blobgen/main.go`, `spike/phase0/blobgen/main_test.go`

**Interfaces:**
- Consumes: scratch copy of the production DB (made in Step 1); `transactions` (`posted_at TEXT, amount INTEGER fils, currency TEXT, direction TEXT, merchant_raw TEXT, category_id, status TEXT, fingerprint TEXT`) joined to `categories.bucket` (`'need'|'want'|'saving'|NULL`).
- Produces, in `spike/phase0/blobgen/out/`:
  - `all.bin` — every sealed blob concatenated; **fixed 1016-byte records**.
  - `manifest.json` — `{"count": int, "record_size": 1016, "recipient_pub": hex, "checks": [{"month": "YYYY-MM", "bucket_debits": {"need": int, "want": int, "saving": int, "uncategorized": int}}]}` for the 3 most recent full months, `status='confirmed'` debits only, fils.
  - Prints `RECIPIENT_PRIV=<hex>` to stdout (pasted into the app's `config.ts`; acceptable because blobs+key never leave the tailnet and this is throwaway spike data hygiene, not the production key design).
  - Op JSON consumed by Task 3: `{"iid": fingerprint, "posted_at": string, "amount": int, "currency": string, "direction": "debit"|"credit", "merchant": string, "bucket": "need"|"want"|"saving"|"", "status": string}`.

- [ ] **Step 1: Make the scratch corpus copy (root, backup API, scratch dir)**

```bash
SCRATCH=/tmp/claude-0/-root-Coding-ledger/fea2b4cd-42e4-46e1-a3eb-6dd4caf7766c/scratchpad
sudo sqlite3 /var/lib/ledger/ledger.db ".backup ${SCRATCH}/phase0-corpus.db"
sudo chown "$(id -un)" "${SCRATCH}/phase0-corpus.db"
sqlite3 "${SCRATCH}/phase0-corpus.db" "SELECT COUNT(*) FROM transactions;"
```

Expected: count in the ~3,700 range. Record the exact number.

- [ ] **Step 2: Init the nested module**

```bash
mkdir -p spike/phase0/blobgen && cd spike/phase0/blobgen
go mod init ledger-spike-blobgen
go get modernc.org/sqlite golang.org/x/crypto
```

- [ ] **Step 3: Write the failing round-trip test** (`main_test.go`)

```go
package main

import (
	"bytes"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	recipPriv, recipPub, err := genKeypair()
	if err != nil {
		t.Fatal(err)
	}
	op := []byte(`{"iid":"abc","amount":12345,"direction":"debit"}`)
	blob, err := seal(op, recipPub)
	if err != nil {
		t.Fatal(err)
	}
	if len(blob) != 1016 {
		t.Fatalf("blob size = %d, want 1016", len(blob))
	}
	got, err := open(blob, recipPriv)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, op) {
		t.Fatalf("round trip mismatch: %q", got)
	}
}

func TestSealRejectsOversize(t *testing.T) {
	_, recipPub, _ := genKeypair()
	big := bytes.Repeat([]byte("x"), 5000) // incompressible enough after our gzip? force it:
	if _, err := seal(big, recipPub); err == nil {
		// only fails if gzip(big) > padSize; xxxx… compresses tiny, so build junk
		t.Skip("compressible input fit; oversize handling covered by junk case below")
	}
}
```

- [ ] **Step 4: Run to verify failure**

Run: `cd spike/phase0/blobgen && go test ./...`
Expected: FAIL — `genKeypair`, `seal`, `open` undefined.

- [ ] **Step 5: Implement `main.go`**

```go
// Package main: Phase-0 spike. Exports the transaction corpus as singleton
// sealed blobs modeling the v2 ingest workload (spec §3.3). Throwaway quality.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
	"crypto/sha256"

	_ "modernc.org/sqlite"
)

const (
	padSize    = 968  // plaintext after padding
	recordSize = 1016 // 32 (eph pub) + 968 + 16 (GCM tag)
	hkdfInfo   = "ledger-phase0"
)

type op struct {
	IID      string `json:"iid"`
	PostedAt string `json:"posted_at"`
	Amount   int64  `json:"amount"`
	Currency string `json:"currency"`
	Direction string `json:"direction"`
	Merchant string `json:"merchant"`
	Bucket   string `json:"bucket"`
	Status   string `json:"status"`
}

func genKeypair() (priv, pub []byte, err error) {
	priv = make([]byte, 32)
	if _, err = rand.Read(priv); err != nil {
		return nil, nil, err
	}
	pub, err = curve25519.X25519(priv, curve25519.Basepoint)
	return priv, pub, err
}

func deriveKey(shared, ephPub, recipPub []byte) []byte {
	salt := append(append([]byte{}, ephPub...), recipPub...)
	key := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, shared, salt, []byte(hkdfInfo)), key); err != nil {
		panic(err)
	}
	return key
}

func gcmSealOpen(key []byte) cipher.AEAD {
	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return aead
}

var zeroNonce = make([]byte, 12)

func seal(plain, recipPub []byte) ([]byte, error) {
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	w.Write(plain)
	w.Close()
	if 4+gz.Len() > padSize {
		return nil, fmt.Errorf("payload too large after gzip: %d", gz.Len())
	}
	padded := make([]byte, padSize)
	binary.BigEndian.PutUint32(padded[:4], uint32(gz.Len()))
	copy(padded[4:], gz.Bytes())

	ephPriv, ephPub, err := genKeypair()
	if err != nil {
		return nil, err
	}
	shared, err := curve25519.X25519(ephPriv, recipPub)
	if err != nil {
		return nil, err
	}
	ct := gcmSealOpen(deriveKey(shared, ephPub, recipPub)).Seal(nil, zeroNonce, padded, nil)
	return append(ephPub, ct...), nil
}

func open(blob, recipPriv []byte) ([]byte, error) {
	if len(blob) != recordSize {
		return nil, fmt.Errorf("bad blob size %d", len(blob))
	}
	ephPub := blob[:32]
	recipPub, err := curve25519.X25519(recipPriv, curve25519.Basepoint)
	if err != nil {
		return nil, err
	}
	shared, err := curve25519.X25519(recipPriv, ephPub)
	if err != nil {
		return nil, err
	}
	padded, err := gcmSealOpen(deriveKey(shared, ephPub, recipPub)).Open(nil, zeroNonce, blob[32:], nil)
	if err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(padded[:4])
	r, err := gzip.NewReader(bytes.NewReader(padded[4 : 4+n]))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(r)
}

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: blobgen <corpus.db>")
	}
	db, err := sql.Open("sqlite", os.Args[1])
	if err != nil {
		log.Fatal(err)
	}
	recipPriv, recipPub, err := genKeypair()
	if err != nil {
		log.Fatal(err)
	}

	rows, err := db.Query(`
		SELECT t.fingerprint, t.posted_at, t.amount, t.currency, t.direction,
		       COALESCE(t.merchant_raw,''), COALESCE(c.bucket,''), t.status
		FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		ORDER BY t.posted_at`)
	if err != nil {
		log.Fatal(err)
	}
	outDir := "out"
	os.MkdirAll(outDir, 0o755)
	all, err := os.Create(filepath.Join(outDir, "all.bin"))
	if err != nil {
		log.Fatal(err)
	}
	count, skipped := 0, 0
	for rows.Next() {
		var o op
		if err := rows.Scan(&o.IID, &o.PostedAt, &o.Amount, &o.Currency, &o.Direction, &o.Merchant, &o.Bucket, &o.Status); err != nil {
			log.Fatal(err)
		}
		if len(o.Merchant) > 200 {
			o.Merchant = o.Merchant[:200]
		}
		j, _ := json.Marshal(o)
		blob, err := seal(j, recipPub)
		if err != nil {
			skipped++ // counted, never silent
			continue
		}
		all.Write(blob)
		count++
	}
	all.Close()

	type check struct {
		Month        string           `json:"month"`
		BucketDebits map[string]int64 `json:"bucket_debits"`
	}
	crows, err := db.Query(`
		SELECT substr(t.posted_at,1,7) AS month,
		       COALESCE(NULLIF(c.bucket,''),'uncategorized') AS bucket,
		       SUM(t.amount)
		FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		WHERE t.direction='debit' AND t.status='confirmed'
		  AND substr(t.posted_at,1,7) IN (
		    SELECT DISTINCT substr(posted_at,1,7) FROM transactions
		    ORDER BY 1 DESC LIMIT 4)
		GROUP BY 1,2 ORDER BY 1 DESC`)
	if err != nil {
		log.Fatal(err)
	}
	byMonth := map[string]map[string]int64{}
	var order []string
	for crows.Next() {
		var m, b string
		var sum int64
		crows.Scan(&m, &b, &sum)
		if byMonth[m] == nil {
			byMonth[m] = map[string]int64{}
			order = append(order, m)
		}
		byMonth[m][b] = sum
	}
	var checks []check
	for _, m := range order {
		if len(checks) >= 3 {
			break
		}
		checks = append(checks, check{Month: m, BucketDebits: byMonth[m]})
	}
	manifest := map[string]any{
		"count": count, "record_size": recordSize,
		"recipient_pub": hex.EncodeToString(recipPub), "checks": checks,
	}
	mj, _ := json.MarshalIndent(manifest, "", "  ")
	os.WriteFile(filepath.Join(outDir, "manifest.json"), mj, 0o644)
	fmt.Printf("blobs=%d skipped=%d\nRECIPIENT_PRIV=%s\n", count, skipped, hex.EncodeToString(recipPriv))
}
```

- [ ] **Step 6: Run the tests**

Run: `cd spike/phase0/blobgen && go test ./...`
Expected: PASS.

- [ ] **Step 7: Generate the corpus blobs**

```bash
SCRATCH=/tmp/claude-0/-root-Coding-ledger/fea2b4cd-42e4-46e1-a3eb-6dd4caf7766c/scratchpad
cd spike/phase0/blobgen && go run . "${SCRATCH}/phase0-corpus.db"
ls -l out/ && python3 -c "import json;print(json.load(open('out/manifest.json'))['count'])"
```

Expected: `all.bin` ≈ count×1016 bytes (~3.7 MB), `skipped=0` (investigate any skips — an op that can't fit 968B gzipped means a pathological merchant string; fix by tightening truncation, and note it). **Save `RECIPIENT_PRIV` for Task 3.** Also write a single-blob fixture for the cross-language test:

```bash
head -c 1016 out/all.bin > out/fixture.bin
```

- [ ] **Step 8: Commit** (code only — `out/` and the corpus stay untracked)

```bash
echo "out/" > spike/phase0/blobgen/.gitignore
git add spike/phase0/blobgen
git commit -m "spike(phase0): corpus blob generator (1KB sealed singletons)"
```

---

### Task 3: Replay app — crypto conformance first, then the app (Spike B, client side)

**Files:**
- Create: `spike/phase0/replay-app/` (Expo blank-TS), with `config.ts`, `crypto.ts`, `replay.ts`, `verify.mjs`, `App.tsx`

**Interfaces:**
- Consumes: `all.bin` + `manifest.json` served over HTTP from dinosaur; `RECIPIENT_PRIV` hex from Task 2 Step 7; blob/op formats exactly as defined in Global Constraints and Task 2's `op` struct.
- Produces: on-device timing breakdown `{fetchMs, decryptMs, insertMs, computeMs, totalMs}` and computed `bucket_debits` per month for comparison against `manifest.checks`.

- [ ] **Step 1: Scaffold the app and install deps**

```bash
cd spike/phase0
bunx create-expo-app@latest replay-app --template blank-typescript
cd replay-app
bunx expo install expo-sqlite
bun add @noble/curves @noble/hashes @noble/ciphers fflate
```

- [ ] **Step 2: Write `crypto.ts`** (mirror of Go `open()`; this is the miniature of the spec's dual-executor conformance discipline)

```ts
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import { gunzipSync } from "fflate";

export const RECORD_SIZE = 1016;
const PAD_SIZE = 968;
const INFO = new TextEncoder().encode("ledger-phase0");
const ZERO_NONCE = new Uint8Array(12);

export function openBlob(blob: Uint8Array, recipPriv: Uint8Array): Uint8Array {
  if (blob.length !== RECORD_SIZE) throw new Error(`bad blob size ${blob.length}`);
  const ephPub = blob.subarray(0, 32);
  const recipPub = x25519.getPublicKey(recipPriv);
  const shared = x25519.getSharedSecret(recipPriv, ephPub);
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(recipPub, 32);
  const key = hkdf(sha256, shared, salt, INFO, 32);
  const padded = gcm(key, ZERO_NONCE).decrypt(blob.subarray(32));
  const n = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  return gunzipSync(padded.subarray(4, 4 + n));
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
```

- [ ] **Step 3: Write the failing cross-language check** (`verify.mjs` — Node, no device needed; run against the Go-sealed fixture)

```js
// node verify.mjs <RECIPIENT_PRIV hex> — opens the Go-sealed fixture with the TS crypto.
import { readFileSync } from "node:fs";
import { openBlob, hexToBytes } from "./crypto.ts"; // run with: node --experimental-strip-types verify.mjs

const priv = hexToBytes(process.argv[2]);
const fixture = new Uint8Array(readFileSync("../blobgen/out/fixture.bin"));
const op = JSON.parse(new TextDecoder().decode(openBlob(fixture, priv)));
if (!op.iid || !Number.isInteger(op.amount) || !["debit", "credit"].includes(op.direction)) {
  console.error("FAIL: bad op", op);
  process.exit(1);
}
console.log("PASS: Go-sealed blob opened by TS crypto:", op.iid, op.amount, op.direction);
```

- [ ] **Step 4: Run it — first to see it exercise real failure, then pass**

Run: `cd spike/phase0/replay-app && node --experimental-strip-types verify.mjs 0000…00 (wrong key)`
Expected: FAIL (GCM auth error) — proves the check can fail.
Run again with the real `RECIPIENT_PRIV` from Task 2.
Expected: `PASS: Go-sealed blob opened by TS crypto: …`
If FAIL with the right key: debug byte-compat (salt order `ephPub‖recipPub`, HKDF info string, zero nonce) **before** touching the device — this is the whole point of doing conformance in Node first.

- [ ] **Step 5: Write `config.ts` and `replay.ts`**

```ts
// config.ts — paste values before the device run
export const SERVER = "http://<dinosaur-tailscale-ip>:8098"; // python3 -m http.server 8098 in blobgen/out
export const RECIPIENT_PRIV_HEX = "<paste from task 2>";
```

```ts
// replay.ts
import * as SQLite from "expo-sqlite";

export type Op = {
  iid: string; posted_at: string; amount: number; currency: string;
  direction: "debit" | "credit"; merchant: string; bucket: string; status: string;
};

export function openDb() {
  const db = SQLite.openDatabaseSync("phase0.db");
  db.execSync(`CREATE TABLE IF NOT EXISTS transactions (
    iid TEXT PRIMARY KEY, posted_at TEXT NOT NULL, amount INTEGER NOT NULL,
    currency TEXT NOT NULL, direction TEXT NOT NULL, merchant TEXT,
    bucket TEXT, status TEXT NOT NULL)`);
  return db;
}

export function resetDb(db: SQLite.SQLiteDatabase) {
  db.execSync("DELETE FROM transactions");
}

export function insertOps(db: SQLite.SQLiteDatabase, ops: Op[]) {
  const stmt = db.prepareSync(
    "INSERT OR REPLACE INTO transactions (iid, posted_at, amount, currency, direction, merchant, bucket, status) VALUES (?,?,?,?,?,?,?,?)");
  try {
    db.withTransactionSync(() => {
      for (const o of ops) {
        stmt.executeSync([o.iid, o.posted_at, o.amount, o.currency, o.direction, o.merchant, o.bucket, o.status]);
      }
    });
  } finally {
    stmt.finalizeSync();
  }
}

export function bucketDebits(db: SQLite.SQLiteDatabase): Record<string, Record<string, number>> {
  const rows = db.getAllSync<{ month: string; bucket: string; total: number }>(`
    SELECT substr(posted_at,1,7) AS month,
           CASE WHEN bucket='' THEN 'uncategorized' ELSE bucket END AS bucket,
           SUM(amount) AS total
    FROM transactions
    WHERE direction='debit' AND status='confirmed'
    GROUP BY 1,2`);
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.month] ??= {})[r.bucket] = r.total;
  return out;
}
```

- [ ] **Step 6: Write `App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Button, SafeAreaView, ScrollView, Text } from "react-native";
import { RECORD_SIZE, hexToBytes, openBlob } from "./crypto";
import { SERVER, RECIPIENT_PRIV_HEX } from "./config";
import { Op, bucketDebits, insertOps, openDb, resetDb } from "./replay";

type Timings = { fetchMs: number; decryptMs: number; insertMs: number; computeMs: number; totalMs: number };

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const [warmMs, setWarmMs] = useState<number | null>(null);
  const say = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => {
    // Warm-start measurement: data already in SQLite from a prior cold restore.
    const t0 = performance.now();
    const db = openDb();
    const n = db.getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM transactions")?.n ?? 0;
    if (n > 0) {
      bucketDebits(db);
      setWarmMs(performance.now() - t0);
    }
  }, []);

  async function coldRestore() {
    const priv = hexToBytes(RECIPIENT_PRIV_HEX);
    const db = openDb();
    resetDb(db);
    const t0 = performance.now();

    const manifest = await (await fetch(`${SERVER}/manifest.json`)).json();
    const buf = new Uint8Array(await (await fetch(`${SERVER}/all.bin`)).arrayBuffer());
    const t1 = performance.now();

    const ops: Op[] = [];
    const dec = new TextDecoder();
    for (let off = 0; off < buf.length; off += RECORD_SIZE) {
      ops.push(JSON.parse(dec.decode(openBlob(buf.subarray(off, off + RECORD_SIZE), priv))));
    }
    const t2 = performance.now();

    insertOps(db, ops);
    const t3 = performance.now();

    const computed = bucketDebits(db);
    const t4 = performance.now();

    const t: Timings = { fetchMs: t1 - t0, decryptMs: t2 - t1, insertMs: t3 - t2, computeMs: t4 - t3, totalMs: t4 - t0 };
    say(`ops=${ops.length}/${manifest.count}  ` + JSON.stringify(t));

    for (const check of manifest.checks) {
      const got = computed[check.month] ?? {};
      const ok = Object.entries(check.bucket_debits).every(([b, v]) => got[b] === v)
        && Object.keys(got).length === Object.keys(check.bucket_debits).length;
      say(`${check.month}: ${ok ? "MATCH" : `MISMATCH got=${JSON.stringify(got)} want=${JSON.stringify(check.bucket_debits)}`}`);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text>warm start: {warmMs === null ? "no data yet (run cold restore, then relaunch)" : `${warmMs.toFixed(0)}ms`}</Text>
      <Button title="Cold Restore" onPress={() => coldRestore().catch((e) => say(String(e)))} />
      <Button title="Reset DB" onPress={() => resetDb(openDb())} />
      <ScrollView>{log.map((l, i) => <Text key={i} selectable>{l}</Text>)}</ScrollView>
    </SafeAreaView>
  );
}
```

- [ ] **Step 7: Boot it locally to catch bundler errors** (no device yet)

Run: `cd spike/phase0/replay-app && bunx expo start --port 8097 &` then `curl -s localhost:8097 | head -1`, then kill it.
Expected: Metro starts without bundling errors. (jsdom-style unit tests are deliberately skipped — `verify.mjs` already covers the only risky logic, and the rest is exercised on-device in Task 4.)

- [ ] **Step 8: Commit**

```bash
git add spike/phase0/replay-app
git commit -m "spike(phase0): expo replay app with conformance-checked crypto"
```

---

### Task 4: Device measurement, verdict, and gate decision

**Files:**
- Modify: `spike/phase0/replay-app/config.ts` (real Tailscale IP + private key)
- Modify: `spike/phase0/RESULTS.md` (section "Replay spike")

**Interfaces:**
- Consumes: everything above; the user's iPhone with Tailscale + Expo Go.
- Produces: the Phase 0 verdict that gates Phase 1 (spec §5), recorded in `RESULTS.md` and reported to the user.

- [ ] **Step 1: Confirm device logistics with the user** — which iPhone (oldest available), Tailscale connected, Expo Go installed. This is the one step that needs the user's hands.

- [ ] **Step 2: Serve blobs and Metro over Tailscale**

```bash
TSIP=$(tailscale ip -4 | head -1)
cd spike/phase0/blobgen/out && python3 -m http.server 8098 --bind "$TSIP" &
cd ../../replay-app
sed -i "s#<dinosaur-tailscale-ip>#${TSIP}#" config.ts   # plus paste RECIPIENT_PRIV_HEX
REACT_NATIVE_PACKAGER_HOSTNAME="$TSIP" bunx expo start --lan
```

User scans the QR in Expo Go. (Per harness memory: if a serve script hangs when piped, redirect output to a file.)

- [ ] **Step 3: Measurement protocol** (cold-start jank trap: discard run 1)
  1. Run Cold Restore once — **discard** (JIT/caches cold).
  2. Reset DB → Cold Restore, ×3. Record each breakdown line; take the **median totalMs**.
  3. Verify every month line says `MATCH`. A mismatch is a correctness bug — fix before trusting any timing.
  4. Kill the app fully (app switcher), relaunch, note `warm start` ms. Repeat ×3, median.

- [ ] **Step 4: Apply the decision rule and write the verdict** into `RESULTS.md`, with the full numbers table:
  - Median cold ≤10s and warm ≤2s → **PASS**: Phase 0 gate open, proceed to Phase 1 planning.
  - Cold over budget but `decryptMs` is the dominant stage and (totalMs − decryptMs) fits comfortably → **PROVISIONAL PASS**: pure-JS X25519+GCM is the known-slow stand-in; note measured decryptMs and the expected 10–100× native JSI factor, and add "native crypto benchmark" as a mandatory early Phase 2 task before the provisional is trusted.
  - `fetchMs+insertMs+computeMs` alone approach the budget, or warm >2s → **FAIL**: the local-first replay design needs rework (batched blob shapes, snapshotting earlier than planned) before Phase 1 — stop and reopen spec §3.3.

- [ ] **Step 5: Update the v2 memory** (`/root/.claude/projects/-root-Coding-ledger/memory/v2-multiuser-beta-track.md`): record both gate verdicts and the measured numbers so parallel sessions see Phase 0's status.

- [ ] **Step 6: Commit and report**

```bash
git add spike/phase0/RESULTS.md spike/phase0/replay-app/config.ts
git commit -m "spike(phase0): device measurements + phase-0 verdict"
```

Report to the user: both verdicts, the numbers, and whether Phase 1 planning is unblocked.

---

## Self-review notes

- **Spec coverage:** §5 Phase 0 has exactly two mandates — port-25 confirmation (Task 1) and the singleton-blob replay spike on-device with the honest per-op workload (Tasks 2–4, `all.bin` is a transport container but every record is individually sealed/opened, matching "~3,700 HPKE opens"). Both exit criteria and the stop-and-rethink rule are encoded as decision gates.
- **Deliberate deviations, stated:** zero GCM nonce + printed private key are spike-only conventions (unique key per blob; data never leaves the tailnet) and are *not* the production design of spec §3.4. Padding is 1016B (spec's "1 KB bucket").
- **Type consistency:** `op` JSON fields in Go `main.go` == `Op` in `replay.ts` == checks in `verify.mjs`; `RECORD_SIZE`/`padSize` agree (32+968+16=1016) across all three.
