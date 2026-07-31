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
		    WHERE substr(posted_at,1,7) < strftime('%Y-%m','now')
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
