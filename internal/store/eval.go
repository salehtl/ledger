package store

// MerchantLabel is a normalized merchant and the category most often
// confirmed for it. Raw is one real (trimmed) spelling from that group: the
// eval sends Raw, because production sends the raw merchant, not the key.
// Used only by the offline categorize-eval command.
type MerchantLabel struct {
	Merchant string
	Raw      string
	Category string
	N        int
}

// SelectMerchantLabels returns one row per normalized merchant with its
// most-confirmed category. Read-only.
func (s *Store) SelectMerchantLabels() ([]MerchantLabel, error) {
	rows, err := s.DB.Query(`
		SELECT lower(trim(t.merchant_raw)) AS m, MAX(trim(t.merchant_raw)), c.name, COUNT(*) AS n
		FROM transactions t JOIN categories c ON c.id = t.category_id
		WHERE t.status = 'confirmed' AND trim(coalesce(t.merchant_raw, '')) <> ''
		GROUP BY m, c.name
		ORDER BY m, n DESC, c.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MerchantLabel
	for rows.Next() {
		var l MerchantLabel
		if err := rows.Scan(&l.Merchant, &l.Raw, &l.Category, &l.N); err != nil {
			return nil, err
		}
		if len(out) > 0 && out[len(out)-1].Merchant == l.Merchant {
			continue // keep only the top category per merchant
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// TxnCheckSample is one labelled email for the offline txncheck-eval command.
type TxnCheckSample struct {
	FromAddr string
	Subject  string
	RawBody  []byte
	IsTxn    bool
}

// SelectTxnCheckSamples returns up to perClass parsed emails (labelled
// transactions) and up to perClass emails a parser rejected as
// non-transactional (labelled not). Rows the AI check set aside are excluded:
// their label came from the classifier being measured. Rows are picked by a
// fixed hash of id, so a rerun picks the same ones. Read-only.
func (s *Store) SelectTxnCheckSamples(perClass int) ([]TxnCheckSample, error) {
	rows, err := s.DB.Query(`
		SELECT COALESCE(from_addr,''), COALESCE(subject,''), raw_body, is_txn FROM (
			SELECT * FROM (SELECT id, from_addr, subject, raw_body, 1 AS is_txn FROM ingest_log
				WHERE parse_status='parsed' ORDER BY (id*2654435761)%4294967296 LIMIT ?)
			UNION ALL
			SELECT * FROM (SELECT id, from_addr, subject, raw_body, 0 AS is_txn FROM ingest_log
				WHERE parse_status='ignored' AND COALESCE(parse_tier,'')<>'ai_check'
				ORDER BY (id*2654435761)%4294967296 LIMIT ?))
		ORDER BY id`, perClass, perClass)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TxnCheckSample
	for rows.Next() {
		var smp TxnCheckSample
		var raw []byte
		if err := rows.Scan(&smp.FromAddr, &smp.Subject, &raw, &smp.IsTxn); err != nil {
			return nil, err
		}
		body, derr := decodeBody(raw)
		if derr != nil {
			body = raw
		}
		smp.RawBody = body
		out = append(out, smp)
	}
	return out, rows.Err()
}
