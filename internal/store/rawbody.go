package store

import (
	"bytes"
	"compress/gzip"
	"io"
)

var gzipMagic = []byte{0x1f, 0x8b}

// compressBody gzips a raw email body for storage. Bodies are write-once and
// read only by reprocess, so a ~10x size reduction on write is effectively free.
func compressBody(raw []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(raw)
	_ = zw.Close()
	return buf.Bytes()
}

// decodeBody transparently gunzips a stored raw_body. Rows written before
// compression landed are plain and pass through unchanged (magic-byte sniff).
func decodeBody(stored []byte) ([]byte, error) {
	if !bytes.HasPrefix(stored, gzipMagic) {
		return stored, nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(stored))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(zr)
}
