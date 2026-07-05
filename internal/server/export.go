package server

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// exportHeader is the CSV column order for GET /api/transactions/export.
var exportHeader = []string{
	"id", "posted_at", "amount", "currency", "amount_aed", "direction",
	"merchant", "category", "bucket", "status", "source",
}

// filsToDecimal renders integer minor units as a plain decimal string
// ("215.00") without ever touching floats.
func filsToDecimal(fils int64) string {
	sign := ""
	if fils < 0 {
		sign = "-"
		fils = -fils
	}
	return fmt.Sprintf("%s%d.%02d", sign, fils/100, fils%100)
}

// handleExportTransactions streams the transaction list as a CSV attachment.
// It honors the same status/from/to/q filters as GET /api/transactions, so a
// spot-audit export matches exactly what the list shows server-side.
func (s *Server) handleExportTransactions(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"transactions unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	qp := r.URL.Query()
	items, err := s.catStore.SelectTransactions(qp.Get("status"), qp.Get("from"), qp.Get("to"), qp.Get("q"))
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	filename := fmt.Sprintf("ledger-export-%s.csv", time.Now().UTC().Format("2006-01-02"))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	cw := csv.NewWriter(w)
	_ = cw.Write(exportHeader)
	for _, t := range items {
		aed := ""
		if t.AmountAedFils != nil {
			aed = filsToDecimal(*t.AmountAedFils)
		}
		_ = cw.Write([]string{
			strconv.FormatInt(t.ID, 10), t.PostedAt, filsToDecimal(t.AmountFils), t.Currency, aed,
			t.Direction, t.MerchantRaw, t.CategoryName, t.Bucket, t.Status, t.Source,
		})
	}
	cw.Flush()
}
