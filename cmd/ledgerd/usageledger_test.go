package main

// Tests for `ledgerd verify`'s usage-ledger half: the reconciliation of
// account_usage against the stored bytes, and the operator's deploy-window
// repair. See verify.go and internal/v2/verify/usage.go.

import (
	"bytes"
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/pgtest"
	"ledger/internal/v2/verify"
)

// The --repair-usage switch is parsed, and it is OFF unless it is typed.
//
// The default matters more than the flag. `verify` is what a cron runs; a
// default-on repair would rewrite the ledger every night and erase the evidence
// of the accounting bug the check exists to find, and a self-healing ledger
// reads exactly like a correct one.
func TestParseArgsCarriesTheRepairUsageSwitch(t *testing.T) {
	if _, err := parseArgs([]string{"verify"}); err != nil {
		t.Fatal(err)
	}
	if verifyRepairUsage {
		t.Fatal("verify repairs the usage ledger without being asked to")
	}
	if _, err := parseArgs([]string{"verify", "--repair-usage"}); err != nil {
		t.Fatalf("--repair-usage is not a flag: %v", err)
	}
	if !verifyRepairUsage {
		t.Fatal("--repair-usage was accepted and does nothing")
	}
	// Left as the operator's next invocation would find it.
	if _, err := parseArgs([]string{"verify"}); err != nil {
		t.Fatal(err)
	}
}

// The command reports the drift, and repairs it only when asked.
//
// The two halves are one test because the pair is the decision: an unattended
// run must leave the ledger exactly as it found it, and the operator's run must
// close the design's §7 deploy window — the drift the OLD binary wrote between
// 00031's backfill and the restart.
func TestVerifyReportsUsageDriftAndRepairsOnlyWhenAsked(t *testing.T) {
	pool := pgtest.New(t)
	ctx := context.Background()

	var user uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (idp, idp_sub_hash, created_at) VALUES ('apple', $1, now()) RETURNING id`,
		bytes.Repeat([]byte{7}, 32)).Scan(&user); err != nil {
		t.Fatal(err)
	}
	// A ledger that claims 4 KiB against an account with no op log at all: the
	// shape a decrement path that never ran leaves behind.
	if _, err := pool.Exec(ctx,
		`INSERT INTO account_usage (user_id, resource, amount) VALUES ($1, 'oplog_hot_bytes', 4096)`,
		user); err != nil {
		t.Fatal(err)
	}

	findings, repairs, err := usageLedgerHalf(ctx, pool, []uuid.UUID{user}, false)
	if err != nil {
		t.Fatalf("usageLedgerHalf: %v", err)
	}
	if len(repairs) != 0 {
		t.Fatalf("a report repaired %d row(s)", len(repairs))
	}
	if len(findings) != 1 || findings[0].ID != verify.U1UsageDrift {
		t.Fatalf("findings = %+v, want one %s", findings, verify.U1UsageDrift)
	}
	var still int64
	if err := pool.QueryRow(ctx,
		`SELECT amount FROM account_usage WHERE user_id = $1 AND resource = 'oplog_hot_bytes'`,
		user).Scan(&still); err != nil {
		t.Fatal(err)
	}
	if still != 4096 {
		t.Fatalf("the report wrote to the ledger: amount is %d, want the drifting 4096", still)
	}

	findings, repairs, err = usageLedgerHalf(ctx, pool, []uuid.UUID{user}, true)
	if err != nil {
		t.Fatalf("usageLedgerHalf --repair-usage: %v", err)
	}
	if len(repairs) != 1 || repairs[0].From != 4096 || repairs[0].To != 0 {
		t.Fatalf("repairs = %+v, want one 4096 -> 0", repairs)
	}
	if len(findings) != 0 {
		t.Fatalf("the report after the repair still finds %+v; the repair runs FIRST so that "+
			"what is printed is what is left", findings)
	}
}

// runVerify must actually RUN the reconciliation and count its findings.
//
// Read out of verify.go's syntax tree, like the wiring tests in main_test.go and
// for the same recorded reason: everything above proves the reconciliation
// works, and only this proves the command invokes it and lets its findings reach
// the exit status. A run that computed them and dropped them would print a clean
// report and exit 0 over a ledger that had become fiction.
func TestRunVerifyRunsTheReconciliationAndCountsItsFindings(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "verify.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var fn *ast.FuncDecl
	for _, d := range file.Decls {
		if f, ok := d.(*ast.FuncDecl); ok && f.Recv == nil && f.Name.Name == "runVerify" {
			fn = f
		}
	}
	if fn == nil {
		t.Fatal("verify.go declares no runVerify")
	}

	called, appended := false, false
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		id, ok := call.Fun.(*ast.Ident)
		if !ok {
			return true
		}
		switch id.Name {
		case "usageLedgerHalf":
			called = true
		case "append":
			// append(findings, usage...) — the findings slice grows by the
			// reconciliation's own result.
			if len(call.Args) == 2 {
				dst, _ := call.Args[0].(*ast.Ident)
				src, _ := call.Args[1].(*ast.Ident)
				if dst != nil && src != nil && dst.Name == "findings" && src.Name == "usage" {
					appended = true
				}
			}
		}
		return true
	})
	if !called {
		t.Error("runVerify never calls usageLedgerHalf: the usage ledger is reconciled nowhere, " +
			"and a ledger nobody checks is the one that becomes fiction")
	}
	if !appended {
		t.Error("runVerify does not append the reconciliation's findings: they would be computed, " +
			"printed nowhere and unable to fail the command")
	}
}

// The repair is printed row by row, with both numbers.
//
// A count alone would leave an operator unable to tell "the deploy window cost
// this account 4 KiB of unrecorded writes" from "the ledger was off by a factor
// of a thousand", which are the same line and different incidents.
func TestPrintCorrectionsNamesEachRowAndBothNumbers(t *testing.T) {
	u := uuid.New()
	out := captureStdout(t, func() {
		printCorrections([]verify.Correction{
			{UserID: u, Resource: "oplog_hot_bytes", From: 4096, To: 8192},
		})
	})
	for _, want := range []string{u.String(), "oplog_hot_bytes", "4096", "8192", "REPAIRED 1"} {
		if !strings.Contains(out, want) {
			t.Errorf("printCorrections output %q does not contain %q", out, want)
		}
	}
	if quiet := captureStdout(t, func() { printCorrections(nil) }); quiet != "" {
		t.Errorf("a run that repaired nothing printed %q", quiet)
	}
}
