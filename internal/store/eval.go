package store

// MerchantLabel is a normalized merchant and the category most often
// confirmed for it. Used only by the offline categorize-eval command.
type MerchantLabel struct {
	Merchant string
	Category string
	N        int
}

// SelectMerchantLabels returns one row per normalized merchant with its
// most-confirmed category. Read-only.
func (s *Store) SelectMerchantLabels() ([]MerchantLabel, error) {
	rows, err := s.DB.Query(`
		SELECT lower(trim(t.merchant_raw)) AS m, c.name, COUNT(*) AS n
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
		if err := rows.Scan(&l.Merchant, &l.Category, &l.N); err != nil {
			return nil, err
		}
		if len(out) > 0 && out[len(out)-1].Merchant == l.Merchant {
			continue // keep only the top category per merchant
		}
		out = append(out, l)
	}
	return out, rows.Err()
}
