package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"ledger/internal/budget"
	"ledger/internal/store"
)

// ReportsStore is the store surface the reports endpoints need.
type ReportsStore interface {
	NetWorthSeries(months int, now time.Time) ([]store.NetWorthPoint, error)
	IncomeExpenseMatrix(fromMonth, toMonth string) ([]store.CategoryMonthNet, error)
	SelectCashflowForAge() ([]store.CashflowTxn, error)
}

// SetReportsStore wires the reports store. Required for /api/reports/*.
func (s *Server) SetReportsStore(rs ReportsStore) { s.reportsStore = rs }

// reportMonths parses ?months= with a default and cap. ok=false after writing
// a 400.
func reportMonths(w http.ResponseWriter, r *http.Request, def, maxM int) (int, bool) {
	months := def
	if raw := r.URL.Query().Get("months"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxM {
			errJSON(w, http.StatusBadRequest, "months must be 1.."+strconv.Itoa(maxM))
			return 0, false
		}
		months = n
	}
	return months, true
}

// netWorthPointDTO is one month of GET /api/reports/networth.
type netWorthPointDTO struct {
	Month        string `json:"month"`
	BudgetFils   int64  `json:"budget_fils"`
	TrackingFils int64  `json:"tracking_fils"`
	NetWorthFils int64  `json:"networth_fils"`
}

func (s *Server) handleReportNetWorth(w http.ResponseWriter, r *http.Request) {
	if s.reportsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "reports unavailable")
		return
	}
	months, ok := reportMonths(w, r, 12, 60)
	if !ok {
		return
	}
	points, err := s.reportsStore.NetWorthSeries(months, time.Now().UTC())
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	out := make([]netWorthPointDTO, 0, len(points))
	for _, p := range points {
		out = append(out, netWorthPointDTO{
			Month: p.Month, BudgetFils: p.BudgetFils,
			TrackingFils: p.TrackingFils, NetWorthFils: p.NetWorthFils,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"months": out})
}

// incomeExpenseRowDTO is one category row of the income-v-expense matrix.
// ByMonth is index-aligned with the response's months array. Amounts are
// display-positive: income rows carry income received, expense rows carry net
// spend.
type incomeExpenseRowDTO struct {
	CategoryID int64   `json:"category_id"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"` // income | spending
	ByMonth    []int64 `json:"by_month_fils"`
	TotalFils  int64   `json:"total_fils"`
	AvgFils    int64   `json:"avg_fils"`
}

// incomeExpenseResp is the GET /api/reports/income-expense payload.
// net_by_month_fils = income − expense per month (savings when positive).
type incomeExpenseResp struct {
	Months     []string              `json:"months"`
	Rows       []incomeExpenseRowDTO `json:"rows"`
	NetByMonth []int64               `json:"net_by_month_fils"`
}

func (s *Server) handleReportIncomeExpense(w http.ResponseWriter, r *http.Request) {
	if s.reportsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "reports unavailable")
		return
	}
	months, ok := reportMonths(w, r, 12, 24)
	if !ok {
		return
	}
	now := time.Now().UTC()
	cur := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	start := cur.AddDate(0, -(months - 1), 0)
	labels := make([]string, 0, months)
	monthIdx := make(map[string]int, months)
	for m := start; !m.After(cur); m = m.AddDate(0, 1, 0) {
		monthIdx[m.Format("2006-01")] = len(labels)
		labels = append(labels, m.Format("2006-01"))
	}
	cells, err := s.reportsStore.IncomeExpenseMatrix(labels[0], labels[len(labels)-1])
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}

	// Store rows arrive ordered (income block, then spending, then name, then
	// month); fold months into one row per category preserving that order.
	rows := make([]incomeExpenseRowDTO, 0)
	rowIdx := make(map[int64]int)
	netByMonth := make([]int64, len(labels))
	for _, c := range cells {
		mi, ok := monthIdx[c.Month]
		if !ok {
			continue
		}
		// NetFils is debit − credit: positive spend for spending categories,
		// negative for income. Flip income for display; net accumulates
		// income − expense either way.
		display := c.NetFils
		if c.Kind == "income" {
			display = -c.NetFils
		}
		netByMonth[mi] -= c.NetFils
		i, seen := rowIdx[c.CategoryID]
		if !seen {
			i = len(rows)
			rowIdx[c.CategoryID] = i
			rows = append(rows, incomeExpenseRowDTO{
				CategoryID: c.CategoryID, Name: c.Name, Kind: c.Kind,
				ByMonth: make([]int64, len(labels)),
			})
		}
		rows[i].ByMonth[mi] += display
		rows[i].TotalFils += display
	}
	for i := range rows {
		rows[i].AvgFils = rows[i].TotalFils / int64(len(labels))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(incomeExpenseResp{Months: labels, Rows: rows, NetByMonth: netByMonth})
}

// ageOfMoneyResp is the GET /api/reports/age-of-money payload. sample_size is
// how many recent funded spends the average covers (0 = not computable yet).
type ageOfMoneyResp struct {
	AgeDays    int64 `json:"age_days"`
	SampleSize int   `json:"sample_size"`
}

func (s *Server) handleReportAgeOfMoney(w http.ResponseWriter, r *http.Request) {
	if s.reportsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "reports unavailable")
		return
	}
	flows, err := s.reportsStore.SelectCashflowForAge()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	days, sample := budget.AgeOfMoney(flows)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ageOfMoneyResp{AgeDays: days, SampleSize: sample})
}
