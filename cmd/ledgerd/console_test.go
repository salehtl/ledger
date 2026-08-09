package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ledger/internal/v2/config"
	"ledger/internal/v2/headroom"
)

// The console's status route reports the REAL fuse this process is enforcing.
//
// The floor is 4 EB, so the first synchronous sample trips it on any filesystem
// this could ever run on — no disk has to be filled, and the numbers below are
// the fuse's own rather than a stand-in's.
func TestTheAdminConsoleShowsTheRunningDiskFuse(t *testing.T) {
	dir := t.TempDir()
	fuse := headroom.New(dir, 1<<62, time.Hour)
	fuse.Start()
	defer fuse.Stop()

	cfg := config.Config{Server: config.ServerConfig{
		AdminListen: "127.0.0.1:8079", AdminToken: "operator-token-for-tests",
	}}
	h, err := adminHandler(cfg, nil, nil, fuse)
	if err != nil {
		t.Fatalf("adminHandler: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/admin/status", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Server.AdminToken)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /admin/status: %d, want 200: %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Headroom struct {
			Configured   bool   `json:"configured"`
			Path         string `json:"path"`
			FloorBytes   int64  `json:"floor_bytes"`
			FreeBytes    *int64 `json:"free_bytes"`
			DeficitBytes int64  `json:"deficit_bytes"`
			Tripped      bool   `json:"tripped"`
		} `json:"headroom"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	got := body.Headroom
	if !got.Configured {
		t.Fatal("the console was handed a running fuse and reports none: an operator " +
			"reading this page during an incident is told the box has no fuse")
	}
	if !got.Tripped {
		t.Fatal("the console reports writes flowing while the fuse this process enforces is tripped")
	}
	if got.Path != dir || got.FloorBytes != 1<<62 {
		t.Fatalf("console shows path %q floor %d, the fuse has %q and %d",
			got.Path, got.FloorBytes, dir, int64(1<<62))
	}
	// The whole point of the panel: how far below the floor, not merely that it
	// is below. A sampler that never ran would leave this null and zero.
	if got.FreeBytes == nil {
		t.Fatal("free_bytes is null: the console cannot sample the filesystem the fuse watches, " +
			"so an operator cannot tell a missing megabyte from a missing 30 GB")
	}
	if got.DeficitBytes <= 0 {
		t.Fatalf("deficit_bytes = %d under a 4 EB floor", got.DeficitBytes)
	}
}

// A console built with no fuse at all says so rather than inventing one.
//
// admin.Headroom is an interface, so the mistake available here is storing a
// typed nil in it: the console would then see a non-nil fuse, call it, and
// panic — or worse, report a healthy box.
func TestAConsoleBuiltWithoutAFuseReportsNone(t *testing.T) {
	cfg := config.Config{Server: config.ServerConfig{
		AdminListen: "127.0.0.1:8079", AdminToken: "operator-token-for-tests",
	}}
	h, err := adminHandler(cfg, nil, nil, nil)
	if err != nil {
		t.Fatalf("adminHandler: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/admin/status", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Server.AdminToken)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /admin/status: %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Headroom struct {
			Configured bool `json:"configured"`
		} `json:"headroom"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Headroom.Configured {
		t.Fatal("a console with no fuse reports one; a typed nil in the interface is the way " +
			"that happens and it renders as a healthy box")
	}
}

// runServe must hand the console the SAME fuse it hands the API.
//
// Measured against main.go's syntax tree, like the sweep and fuse wiring tests
// beside it, and for the same recorded reason: the tests above prove the console
// renders whatever fuse it is given, and only this one proves the server gives
// it the running one. A second headroom.New here would compile, serve, and show
// an operator a fuse that refuses nothing.
func TestRunServeGivesTheConsoleTheFuseItGivesTheAPI(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var runServe *ast.FuncDecl
	for _, d := range file.Decls {
		if fn, ok := d.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Name.Name == "runServe" {
			runServe = fn
		}
	}
	if runServe == nil {
		t.Fatal("main.go declares no runServe")
	}

	fuseVar := ""
	adminArgs := []string{}
	ast.Inspect(runServe.Body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.AssignStmt:
			if len(x.Rhs) != 1 {
				return true
			}
			call, ok := x.Rhs[0].(*ast.CallExpr)
			if !ok {
				return true
			}
			id, ok := call.Fun.(*ast.Ident)
			if !ok {
				return true
			}
			switch id.Name {
			case "startHeadroom":
				if lhs, ok := x.Lhs[0].(*ast.Ident); ok {
					fuseVar = lhs.Name
				}
			case "adminServer":
				for _, a := range call.Args {
					if arg, ok := a.(*ast.Ident); ok {
						adminArgs = append(adminArgs, arg.Name)
					}
				}
			}
		}
		return true
	})

	if fuseVar == "" {
		t.Fatal("runServe does not keep startHeadroom's fuse")
	}
	if len(adminArgs) == 0 {
		t.Fatal("runServe never calls adminServer")
	}
	found := false
	for _, a := range adminArgs {
		if a == fuseVar {
			found = true
		}
	}
	if !found {
		t.Errorf("runServe calls adminServer(%v) without the running fuse %q: the console "+
			"would show no fuse, or a second one that refuses nothing", adminArgs, fuseVar)
	}
}
