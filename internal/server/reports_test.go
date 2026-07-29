package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"ledger/internal/store"
)

func newReportsTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st := newTestServerStore(t)
	srv := New(st, testFS())
	srv.SetReportsStore(st)
	return srv, st
}

// thisMonthDay returns the current month's day d as a full RFC3339 timestamp.
func thisMonthDay(d int) string {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), d, 9, 0, 0, 0, time.UTC).Format(time.RFC3339)
}

func TestReportNetWorth(t *testing.T) {
	srv, st := newReportsTestServer(t)
	acctID, err := st.InsertAccount("Main", "DIB", "1234")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertAccountBalance(store.AccountBalanceRow{
		AccountID: acctID, AsOf: thisMonthDay(1), BalanceFils: 2000_00,
	}); err != nil {
		t.Fatal(err)
	}

	w := doJSON(t, srv, "GET", "/api/reports/networth?months=2", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp struct {
		Months []struct {
			Month        string `json:"month"`
			BudgetFils   int64  `json:"budget_fils"`
			TrackingFils int64  `json:"tracking_fils"`
			NetWorthFils int64  `json:"networth_fils"`
		} `json:"months"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Months) != 2 {
		t.Fatalf("months = %d, want 2", len(resp.Months))
	}
	last := resp.Months[1]
	if last.Month != time.Now().UTC().Format("2006-01") || last.BudgetFils != 2000_00 || last.NetWorthFils != 2000_00 {
		t.Errorf("current month = %+v, want budget 2000_00", last)
	}

	if w := doJSON(t, srv, "GET", "/api/reports/networth?months=0", nil); w.Code != http.StatusBadRequest {
		t.Errorf("months=0 status = %d, want 400", w.Code)
	}
}

func TestReportIncomeExpense(t *testing.T) {
	srv, st := newReportsTestServer(t)
	salary := projInsertCategory(t, st, "RptSalary", "income", "")
	food := projInsertCategory(t, st, "RptFood", "spending", "need")

	// Current-month income and spend (projInsertTxn confirms via category).
	now := time.Now().UTC()
	day5 := time.Date(now.Year(), now.Month(), 5, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
	projInsertTxn(t, st, salary, "credit", 3000_00, day5, "confirmed")
	projInsertTxn(t, st, food, "debit", 450_00, day5, "confirmed")

	w := doJSON(t, srv, "GET", "/api/reports/income-expense?months=2", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp struct {
		Months []string `json:"months"`
		Rows   []struct {
			CategoryID int64   `json:"category_id"`
			Name       string  `json:"name"`
			Kind       string  `json:"kind"`
			ByMonth    []int64 `json:"by_month_fils"`
			TotalFils  int64   `json:"total_fils"`
			AvgFils    int64   `json:"avg_fils"`
		} `json:"rows"`
		NetByMonth []int64 `json:"net_by_month_fils"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Months) != 2 || len(resp.Rows) != 2 {
		t.Fatalf("months=%d rows=%d, want 2/2; body: %s", len(resp.Months), len(resp.Rows), w.Body)
	}
	// Income sorts first, amounts display-positive, current month is index 1.
	if resp.Rows[0].Kind != "income" || resp.Rows[0].ByMonth[1] != 3000_00 || resp.Rows[0].TotalFils != 3000_00 {
		t.Errorf("income row = %+v", resp.Rows[0])
	}
	if resp.Rows[1].Name != "RptFood" || resp.Rows[1].ByMonth[1] != 450_00 {
		t.Errorf("expense row = %+v", resp.Rows[1])
	}
	if resp.NetByMonth[1] != 3000_00-450_00 {
		t.Errorf("net = %d, want %d", resp.NetByMonth[1], 3000_00-450_00)
	}
	if resp.Rows[1].AvgFils != 450_00/2 {
		t.Errorf("avg = %d, want %d", resp.Rows[1].AvgFils, 450_00/2)
	}
}

func TestReportAgeOfMoney(t *testing.T) {
	srv, st := newReportsTestServer(t)
	salary := projInsertCategory(t, st, "RptSalary", "income", "")
	food := projInsertCategory(t, st, "RptFood", "spending", "need")

	now := time.Now().UTC()
	incomeDay := now.AddDate(0, 0, -30).Format("2006-01-02")
	spendDay := now.Format("2006-01-02")
	projInsertTxn(t, st, salary, "credit", 1000_00, incomeDay, "confirmed")
	projInsertTxn(t, st, food, "debit", 100_00, spendDay, "confirmed")

	w := doJSON(t, srv, "GET", "/api/reports/age-of-money", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp struct {
		AgeDays    int64 `json:"age_days"`
		SampleSize int   `json:"sample_size"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.AgeDays != 30 || resp.SampleSize != 1 {
		t.Errorf("age = %+v, want 30 days over 1 spend", resp)
	}
}
