package importer

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// MapConfig declares how to map source file columns to ledger fields.
// It is loaded from a map.toml file provided by the user.
type MapConfig struct {
	Columns         ColumnMap         `toml:"columns"`
	Categories      map[string]string `toml:"categories"`
	Budget          *BudgetSeed       `toml:"budget"`
	DateFormat      string            `toml:"date_format"`
	Currency        string            `toml:"currency"`
	DirectionMode   string            `toml:"direction_mode"` // "sign" | "columns"
	DirectionValues DirectionValues   `toml:"direction_values"`
	SkipZeroAmounts bool              `toml:"skip_zero_amounts"`
}

// ColumnMap declares which header in the source file maps to each ledger field.
type ColumnMap struct {
	Date        string `toml:"date"`        // required
	Description string `toml:"description"` // required
	Amount      string `toml:"amount"`      // required when direction_mode="sign"
	Debit       string `toml:"debit"`       // required when direction_mode="columns"
	Credit      string `toml:"credit"`      // required when direction_mode="columns"
	Category    string `toml:"category"`    // optional
}

// DirectionValues declares what the Debit/Credit columns contain (direction_mode="columns").
type DirectionValues struct {
	Debit  string `toml:"debit"`
	Credit string `toml:"credit"`
}

// BudgetSeed optionally seeds budget_config from the map file.
type BudgetSeed struct {
	MonthlyIncome float64 `toml:"monthly_income"` // AED decimal
	NeedPct       float64 `toml:"need_pct"`
	WantPct       float64 `toml:"want_pct"`
	SavingPct     float64 `toml:"saving_pct"`
}

// LoadMap reads and validates a map.toml file, applying defaults.
func LoadMap(path string) (MapConfig, error) {
	m := MapConfig{
		Currency:      "AED",
		DateFormat:    "02/01/2006",
		DirectionMode: "sign",
		DirectionValues: DirectionValues{
			Debit:  "Debit",
			Credit: "Credit",
		},
	}
	md, err := toml.DecodeFile(path, &m)
	if err != nil {
		return MapConfig{}, fmt.Errorf("decode map %q: %w", path, err)
	}
	if keys := md.Undecoded(); len(keys) > 0 {
		return MapConfig{}, fmt.Errorf("unknown key(s) in %s: %v", path, keys)
	}
	if m.Columns.Date == "" {
		return MapConfig{}, fmt.Errorf("columns.date is required in %s", path)
	}
	if m.Columns.Description == "" {
		return MapConfig{}, fmt.Errorf("columns.description is required in %s", path)
	}
	switch m.DirectionMode {
	case "sign":
		if m.Columns.Amount == "" {
			return MapConfig{}, fmt.Errorf("columns.amount is required when direction_mode=sign")
		}
	case "columns":
		if m.Columns.Debit == "" || m.Columns.Credit == "" {
			return MapConfig{}, fmt.Errorf("columns.debit and columns.credit are required when direction_mode=columns")
		}
	default:
		return MapConfig{}, fmt.Errorf("direction_mode must be \"sign\" or \"columns\", got %q", m.DirectionMode)
	}
	return m, nil
}

// ResolveCategory maps a source category name to a canonical ledger category name.
// Returns the source name unchanged if no mapping exists.
func (m MapConfig) ResolveCategory(sourceName string) string {
	if canonical, ok := m.Categories[sourceName]; ok {
		return canonical
	}
	return sourceName
}

// ParseDate parses a date string using the configured date_format.
func (m MapConfig) ParseDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	t, err := time.Parse(m.DateFormat, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse date %q with format %q: %w", s, m.DateFormat, err)
	}
	return t.UTC(), nil
}

// ParseAmount parses the amount and direction from a raw row.
// Returns (amountFils int64, direction string, error). amountFils is always positive.
func (m MapConfig) ParseAmount(raw map[string]string) (int64, string, error) {
	clean := func(s string) string {
		return strings.ReplaceAll(strings.TrimSpace(s), ",", "")
	}
	// Round float → fils: multiply by 100, round half-up.
	toFils := func(f float64) int64 {
		if f < 0 {
			return int64(-f*100 + 0.5)
		}
		return int64(f*100 + 0.5)
	}

	switch m.DirectionMode {
	case "sign":
		v := clean(raw[m.Columns.Amount])
		if v == "" {
			return 0, "", fmt.Errorf("amount column %q is empty", m.Columns.Amount)
		}
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, "", fmt.Errorf("parse amount %q: %w", v, err)
		}
		if f < 0 {
			return toFils(f), "debit", nil
		}
		return toFils(f), "credit", nil

	case "columns":
		dv := clean(raw[m.Columns.Debit])
		cv := clean(raw[m.Columns.Credit])
		if dv != "" && dv != "0" && dv != "0.00" {
			f, err := strconv.ParseFloat(dv, 64)
			if err != nil {
				return 0, "", fmt.Errorf("parse debit column %q: %w", dv, err)
			}
			return toFils(f), "debit", nil
		}
		if cv != "" && cv != "0" && cv != "0.00" {
			f, err := strconv.ParseFloat(cv, 64)
			if err != nil {
				return 0, "", fmt.Errorf("parse credit column %q: %w", cv, err)
			}
			return toFils(f), "credit", nil
		}
		return 0, "", fmt.Errorf("both debit (%q) and credit (%q) columns are empty or zero", m.Columns.Debit, m.Columns.Credit)

	default:
		return 0, "", fmt.Errorf("unknown direction_mode %q", m.DirectionMode)
	}
}
