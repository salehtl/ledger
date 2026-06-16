# Category Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user create, rename, re-bucket, and delete budget categories from a dedicated full-screen manager, with delete blocked while any transaction or rule still references the category.

**Architecture:** The backend already supports list/create/update; this plan adds a usage-count query, a block-if-in-use `DELETE`, and friendly duplicate-name handling, then builds a `<CategoryManager>` full-screen overlay (sibling of `ReviewSwipe`) opened from a "Manage categories" row in Settings. Categories stay flat; `kind` is immutable after creation.

**Tech Stack:** Go (stdlib `net/http`, modernc SQLite via `store`), React 18 + TypeScript, TanStack Query, Tailwind v4, vitest. Spec: `docs/superpowers/specs/2026-06-16-category-management-design.md`.

---

## File structure

- `internal/store/categories.go` — add `CategoryUsage` and `DeleteCategory` methods.
- `internal/store/categories_test.go` — add store-level tests.
- `internal/server/categories.go` — add `handleGetCategoryUsage`, `handleDeleteCategory`; map UNIQUE-name violation to 409 in create/update.
- `internal/server/server.go` — register two new routes.
- `internal/server/categories_test.go` — add handler tests.
- `frontend/src/api/types.ts` — add `CategoryUsage` type.
- `frontend/src/api/client.ts` — add `getCategoryUsage`, `deleteCategory`.
- `frontend/src/screens/CategoryManager.tsx` — new full-screen overlay (with internal `CategoryRow`).
- `frontend/src/screens/CategoryManager.test.tsx` — new tests.
- `frontend/src/screens/Settings.tsx` — replace the "Categories → buckets" card with a "Manage categories" row that opens the overlay; remove the now-unused `reassign` fn and `BUCKETS` const.

---

## Task 1: `store.CategoryUsage`

**Files:**
- Modify: `internal/store/categories.go` (add method after `DeleteCategory`/near `UpdateCategory`)
- Test: `internal/store/categories_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/store/categories_test.go`:

```go
func TestCategoryUsage(t *testing.T) {
	st := newTestStore(t)
	ingestID := seedIngestRow(t, st)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatalf("SelectCategories: %v", err)
	}
	var groceriesID int64
	for _, c := range cats {
		if c.Name == "Groceries" {
			groceriesID = c.ID
		}
	}

	// Initially unused.
	txns, rules, err := st.CategoryUsage(groceriesID)
	if err != nil {
		t.Fatalf("CategoryUsage: %v", err)
	}
	if txns != 0 || rules != 0 {
		t.Fatalf("fresh category usage = (%d,%d), want (0,0)", txns, rules)
	}

	// Assign one transaction and one rule.
	row := txnRow()
	row.IngestID = ingestID
	txID, _, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("InsertTransaction: %v", err)
	}
	if err := st.UpdateTransactionCategory(txID, groceriesID, "categorized"); err != nil {
		t.Fatalf("UpdateTransactionCategory: %v", err)
	}
	if err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "spinneys", CategoryID: groceriesID, Priority: 100, Source: "manual"}); err != nil {
		t.Fatalf("InsertRule: %v", err)
	}

	txns, rules, err = st.CategoryUsage(groceriesID)
	if err != nil {
		t.Fatalf("CategoryUsage: %v", err)
	}
	if txns != 1 || rules != 1 {
		t.Fatalf("usage = (%d,%d), want (1,1)", txns, rules)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run TestCategoryUsage`
Expected: FAIL — `st.CategoryUsage undefined`.

- [ ] **Step 3: Write minimal implementation**

Add to `internal/store/categories.go` (e.g. just after `UpdateCategory`):

```go
// CategoryUsage returns how many transactions and rules reference a category.
// Used to enforce block-if-in-use deletes.
func (s *Store) CategoryUsage(id int64) (txns int, rules int, err error) {
	if err = s.DB.QueryRow(`SELECT count(*) FROM transactions WHERE category_id=?`, id).Scan(&txns); err != nil {
		return 0, 0, err
	}
	if err = s.DB.QueryRow(`SELECT count(*) FROM rules WHERE category_id=?`, id).Scan(&rules); err != nil {
		return 0, 0, err
	}
	return txns, rules, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/store/ -run TestCategoryUsage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/categories.go internal/store/categories_test.go
git commit -m "feat(store): add CategoryUsage count query"
```

---

## Task 2: `store.DeleteCategory`

**Files:**
- Modify: `internal/store/categories.go`
- Test: `internal/store/categories_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/store/categories_test.go`:

```go
func TestDeleteCategory(t *testing.T) {
	st := newTestStore(t)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	id, err := st.InsertCategory(CategoryRow{Name: "Temp", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory: %v", err)
	}

	if err := st.DeleteCategory(id); err != nil {
		t.Fatalf("DeleteCategory: %v", err)
	}

	var count int
	if err := st.DB.QueryRow(`SELECT count(*) FROM categories WHERE id=?`, id).Scan(&count); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if count != 0 {
		t.Fatalf("category still present after delete (count=%d)", count)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run TestDeleteCategory`
Expected: FAIL — `st.DeleteCategory undefined`.

- [ ] **Step 3: Write minimal implementation**

Add to `internal/store/categories.go` (next to `CategoryUsage`):

```go
// DeleteCategory hard-deletes a category row. Callers MUST verify the category
// is unused (see CategoryUsage) first — foreign_keys=ON would otherwise reject
// the delete if any transaction or rule still references it.
func (s *Store) DeleteCategory(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM categories WHERE id=?`, id)
	return err
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/store/ -run TestDeleteCategory`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/categories.go internal/store/categories_test.go
git commit -m "feat(store): add DeleteCategory"
```

---

## Task 3: `GET /api/categories/{id}/usage` handler

**Files:**
- Modify: `internal/server/categories.go` (add handler), `internal/server/server.go` (route)
- Test: `internal/server/categories_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/server/categories_test.go`:

```go
func TestGetCategoryUsage(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	id, err := st.InsertCategory(store.CategoryRow{Name: "Temp", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory: %v", err)
	}

	r := httptest.NewRequest("GET", "/api/categories/"+strconv.FormatInt(id, 10)+"/usage", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var resp map[string]int
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["transactions"] != 0 || resp["rules"] != 0 {
		t.Fatalf("usage = %+v, want zeros", resp)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run TestGetCategoryUsage`
Expected: FAIL — route returns 404 (not registered).

- [ ] **Step 3: Add the handler**

Append to `internal/server/categories.go`:

```go
func (s *Server) handleGetCategoryUsage(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	txns, rules, err := s.catStore.CategoryUsage(id)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"transactions": txns, "rules": rules})
}
```

- [ ] **Step 4: Register the route**

In `internal/server/server.go`, just after the `PUT /api/categories/{id}` line (~138-139):

```go
	s.mux.HandleFunc("GET /api/categories/{id}/usage", s.handleGetCategoryUsage)
```

**Required interface change:** `s.catStore` is typed against the `CategoryStore` interface (`internal/server/server.go:38-50`), not `*store.Store` directly, so the new methods must be added to it or the handlers won't compile. Add both lines inside the `CategoryStore` interface block (e.g. after `SnapshotBucketForCategory`):

```go
	CategoryUsage(id int64) (txns int, rules int, err error)
	DeleteCategory(id int64) error
```

(Add both now, in this step — `DeleteCategory` is used in Task 4 and adding it here keeps the interface change in one commit.)

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/server/ -run TestGetCategoryUsage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/server/categories.go internal/server/server.go internal/server/categories_test.go
git commit -m "feat(server): add GET /api/categories/{id}/usage"
```

---

## Task 4: `DELETE /api/categories/{id}` (block-if-in-use)

**Files:**
- Modify: `internal/server/categories.go` (handler), `internal/server/server.go` (route)
- Test: `internal/server/categories_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `internal/server/categories_test.go`:

```go
func TestDeleteCategoryClean(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	id, err := st.InsertCategory(store.CategoryRow{Name: "Temp", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory: %v", err)
	}

	r := httptest.NewRequest("DELETE", "/api/categories/"+strconv.FormatInt(id, 10), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var count int
	st.DB.QueryRow(`SELECT count(*) FROM categories WHERE id=?`, id).Scan(&count)
	if count != 0 {
		t.Fatalf("category not deleted (count=%d)", count)
	}
}

func TestDeleteCategoryInUse(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	id, err := st.InsertCategory(store.CategoryRow{Name: "Temp", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory: %v", err)
	}
	// Reference it from a rule so it is "in use".
	if err := st.InsertRule(store.RuleRow{MatchType: "contains", Pattern: "x", CategoryID: id, Priority: 100, Source: "manual"}); err != nil {
		t.Fatalf("InsertRule: %v", err)
	}

	r := httptest.NewRequest("DELETE", "/api/categories/"+strconv.FormatInt(id, 10), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["rules"] == nil || resp["error"] != "in use" {
		t.Fatalf("unexpected 409 body: %+v", resp)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/ -run TestDeleteCategory`
Expected: FAIL — DELETE route not registered (404).

- [ ] **Step 3: Add the handler**

Append to `internal/server/categories.go`:

```go
func (s *Server) handleDeleteCategory(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	txns, rules, err := s.catStore.CategoryUsage(id)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if txns > 0 || rules > 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]any{"error": "in use", "transactions": txns, "rules": rules})
		return
	}
	if err := s.catStore.DeleteCategory(id); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
```

- [ ] **Step 4: Register the route**

In `internal/server/server.go`, after the usage route added in Task 3:

```go
	s.mux.HandleFunc("DELETE /api/categories/{id}", s.handleDeleteCategory)
```

(The `DeleteCategory` interface method was already added to `CategoryStore` in Task 3 step 4.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/server/ -run TestDeleteCategory`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add internal/server/categories.go internal/server/server.go internal/server/categories_test.go
git commit -m "feat(server): add block-if-in-use DELETE /api/categories/{id}"
```

---

## Task 5: Map duplicate-name violation to 409

**Files:**
- Modify: `internal/server/categories.go` (`handlePostCategory`, `handlePutCategory`, imports)
- Test: `internal/server/categories_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/server/categories_test.go`:

```go
func TestPostCategoryDuplicateName(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	body, _ := json.Marshal(map[string]any{"name": "Dupe", "kind": "spending", "bucket": "want"})
	r1 := httptest.NewRequest("POST", "/api/categories", bytes.NewReader(body))
	w1 := httptest.NewRecorder()
	srv.ServeHTTP(w1, r1)
	if w1.Code != http.StatusCreated {
		t.Fatalf("first create status = %d, want 201; body: %s", w1.Code, w1.Body)
	}

	r2 := httptest.NewRequest("POST", "/api/categories", bytes.NewReader(body))
	w2 := httptest.NewRecorder()
	srv.ServeHTTP(w2, r2)
	if w2.Code != http.StatusConflict {
		t.Fatalf("duplicate create status = %d, want 409; body: %s", w2.Code, w2.Body)
	}
	var resp map[string]any
	json.NewDecoder(w2.Body).Decode(&resp)
	if resp["error"] != "name exists" {
		t.Fatalf("unexpected body: %+v", resp)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run TestPostCategoryDuplicateName`
Expected: FAIL — second create returns 500, not 409.

- [ ] **Step 3: Add a helper and use it in both handlers**

In `internal/server/categories.go`, add `"strings"` to the import block, then add this helper:

```go
// writeCategoryDBErr maps a UNIQUE(name) violation to 409, anything else to 500.
func writeCategoryDBErr(w http.ResponseWriter, err error) {
	if strings.Contains(err.Error(), "UNIQUE") {
		http.Error(w, `{"error":"name exists"}`, http.StatusConflict)
		return
	}
	http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
}
```

In `handlePostCategory`, replace the `InsertCategory` error branch:

```go
	id, err := s.catStore.InsertCategory(store.CategoryRow{
		Name:   req.Name,
		Kind:   req.Kind,
		Bucket: req.Bucket,
	})
	if err != nil {
		writeCategoryDBErr(w, err)
		return
	}
```

In `handlePutCategory`, replace the `UpdateCategory` error branch:

```go
	if err := s.catStore.UpdateCategory(store.CategoryRow{ID: id, Name: req.Name, Kind: req.Kind, Bucket: req.Bucket}); err != nil {
		writeCategoryDBErr(w, err)
		return
	}
```

Note: `InsertCategory` currently inserts with `IsActive` from the struct, so new categories created via the API default to `is_active=0` unless set. Verify `handlePostCategory` passes `IsActive: true` (the existing handler does NOT — it omits it). If new categories are not appearing in `GET /api/categories` (which filters `is_active=1`), set `IsActive: true` in the `store.CategoryRow` built by `handlePostCategory`. Add a quick assertion to `TestPostCategory` that the created category appears in a subsequent `GET /api/categories` to lock this in.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/server/ -run 'TestPostCategory'`
Expected: PASS (duplicate → 409; created category visible in list).

- [ ] **Step 5: Commit**

```bash
git add internal/server/categories.go internal/server/categories_test.go
git commit -m "feat(server): return 409 on duplicate category name"
```

---

## Task 6: Frontend API client + types

**Files:**
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/client.ts`

- [ ] **Step 1: Add the type**

Append to `frontend/src/api/types.ts`:

```ts
export interface CategoryUsage { transactions: number; rules: number; }
```

- [ ] **Step 2: Add client helpers**

Append to `frontend/src/api/client.ts`:

```ts
import type { CategoryUsage } from "./types";

export function getCategoryUsage(id: number): Promise<CategoryUsage> {
  return getJSON<CategoryUsage>(`/api/categories/${id}/usage`);
}

export function deleteCategory(id: number): Promise<void> {
  return del(`/api/categories/${id}`);
}
```

(If the file's lint config requires imports at the top, move the `import type` line to the top of the file instead of appending it.)

- [ ] **Step 3: Verify it type-checks**

Run: `cd frontend && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts
git commit -m "feat(frontend): add category usage + delete client helpers"
```

---

## Task 7: `<CategoryManager>` component

**Files:**
- Create: `frontend/src/screens/CategoryManager.tsx`
- Test: `frontend/src/screens/CategoryManager.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/screens/CategoryManager.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { CategoryManager } from "./CategoryManager";

const CATS = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Salary", Kind: "income", Bucket: "", IsActive: true },
];

function mockFetch(usage: Record<number, { transactions: number; rules: number }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const usageMatch = u.match(/\/api\/categories\/(\d+)\/usage$/);
    if (usageMatch) {
      const id = Number(usageMatch[1]);
      return new Response(JSON.stringify(usage[id] ?? { transactions: 0, rules: 0 }));
    }
    if (u === "/api/categories" && (!init || init.method === undefined || init.method === "GET")) {
      return new Response(JSON.stringify(CATS));
    }
    // POST/PUT/DELETE
    return new Response(JSON.stringify({ ok: true }));
  });
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><ToastProvider><CategoryManager onClose={() => {}} /></ToastProvider></QueryClientProvider>,
  );
}

describe("CategoryManager", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch({ 1: { transactions: 3, rules: 0 }, 2: { transactions: 0, rules: 0 } }));
  });

  it("renders categories grouped by kind", async () => {
    wrap();
    expect(await screen.findByText("Spending")).toBeInTheDocument();
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Groceries")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Salary")).toBeInTheDocument();
  });

  it("shows the bucket select on the add form only for spending kind", async () => {
    wrap();
    await screen.findByText("Spending");
    // spending is the default kind -> bucket select present
    expect(screen.getByLabelText(/new category bucket/i)).toBeInTheDocument();
    // switch to income -> bucket select disappears
    fireEvent.change(screen.getByLabelText(/new category kind/i), { target: { value: "income" } });
    expect(screen.queryByLabelText(/new category bucket/i)).not.toBeInTheDocument();
  });

  it("disables delete when the category is in use", async () => {
    wrap();
    // Groceries (id 1) has 3 transactions -> delete disabled
    const btn = await screen.findByRole("button", { name: /groceries in use/i });
    expect(btn).toBeDisabled();
  });

  it("posts a new category", async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal("fetch", fetchMock);
    wrap();
    await screen.findByText("Spending");
    fireEvent.change(screen.getByLabelText(/new category name/i), { target: { value: "Hobbies" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === "/api/categories" && c[1]?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ name: "Hobbies", kind: "spending", bucket: "need" });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/screens/CategoryManager.test.tsx`
Expected: FAIL — module `./CategoryManager` not found.

- [ ] **Step 3: Implement the component**

Create `frontend/src/screens/CategoryManager.tsx`:

```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2 } from "lucide-react";
import { getJSON, postJSON, getCategoryUsage, deleteCategory } from "../api/client";
import type { Category } from "../api/types";
import { useToast } from "../components/Toast";

const BUCKETS = ["need", "want", "saving"] as const;
const KINDS = ["spending", "income", "excluded"] as const;
const KIND_LABELS: Record<string, string> = { spending: "Spending", income: "Income", excluded: "Excluded" };

export function CategoryManager({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("spending");
  const [bucket, setBucket] = useState<(typeof BUCKETS)[number]>("need");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const add = async () => {
    if (!name.trim()) return;
    try {
      await postJSON("/api/categories", { name: name.trim(), kind, bucket: kind === "spending" ? bucket : "" });
      setName("");
      invalidate();
    } catch (e) {
      const dup = e instanceof Error && e.message === "name exists";
      show({ message: dup ? "A category with that name already exists." : "Couldn't add category", tone: "error" });
    }
  };

  const grouped = KINDS.map((k) => ({ kind: k, items: (cats.data ?? []).filter((c) => c.Kind === k) }));

  return (
    <div className="fixed inset-0 z-40 bg-[--bg] flex flex-col">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-[--border]">
        <button onClick={onClose} className="p-2 -ml-2 rounded-xl hover:bg-slate-100 text-[--muted]" aria-label="Close category manager">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-lg font-semibold text-[--fg]">Categories</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6 max-w-screen-sm w-full mx-auto">
        <div className="space-y-2">
          <p className="text-sm font-medium">Add category</p>
          <input
            aria-label="New category name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm"
          />
          <div className="flex gap-2">
            <select
              aria-label="New category kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
              className="flex-1 border border-border rounded-lg px-2 py-2 text-sm bg-surface"
            >
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
            {kind === "spending" && (
              <select
                aria-label="New category bucket"
                value={bucket}
                onChange={(e) => setBucket(e.target.value as (typeof BUCKETS)[number])}
                className="flex-1 border border-border rounded-lg px-2 py-2 text-sm bg-surface"
              >
                {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
          </div>
          <button onClick={add} className="w-full py-2 rounded-lg bg-accent text-white text-sm font-medium">Add</button>
        </div>

        {grouped.map((g) => g.items.length > 0 && (
          <div key={g.kind} className="space-y-2">
            <p className="text-sm font-medium">{KIND_LABELS[g.kind]}</p>
            {g.items.map((c) => <CategoryRow key={c.ID} cat={c} onChanged={invalidate} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryRow({ cat, onChanged }: { cat: Category; onChanged: () => void }) {
  const { show } = useToast();
  const usage = useQuery({ queryKey: ["category-usage", cat.ID], queryFn: () => getCategoryUsage(cat.ID) });
  const inUse = (usage.data?.transactions ?? 0) > 0 || (usage.data?.rules ?? 0) > 0;

  const rename = async (next: string) => {
    const trimmed = next.trim();
    if (!trimmed || trimmed === cat.Name) return;
    try {
      await postJSON(`/api/categories/${cat.ID}`, { name: trimmed, kind: cat.Kind, bucket: cat.Bucket }, "PUT");
      onChanged();
    } catch (e) {
      const dup = e instanceof Error && e.message === "name exists";
      show({ message: dup ? "A category with that name already exists." : "Couldn't rename category", tone: "error" });
    }
  };

  const reBucket = async (b: string) => {
    try {
      await postJSON(`/api/categories/${cat.ID}`, { name: cat.Name, kind: cat.Kind, bucket: b }, "PUT");
      onChanged();
    } catch {
      show({ message: "Couldn't move category", tone: "error" });
    }
  };

  const remove = async () => {
    if (inUse) return;
    try {
      await deleteCategory(cat.ID);
      onChanged();
    } catch {
      show({ message: "Couldn't delete — category is now in use", tone: "error" });
      usage.refetch();
    }
  };

  return (
    <div className="flex items-center justify-between gap-2">
      <input
        aria-label={`Rename ${cat.Name}`}
        defaultValue={cat.Name}
        onBlur={(e) => rename(e.target.value)}
        className="min-w-0 flex-1 px-2 py-1 rounded-lg border border-border bg-surface text-sm"
      />
      {cat.Kind === "spending" && (
        <select
          aria-label={`Bucket for ${cat.Name}`}
          value={cat.Bucket}
          onChange={(e) => reBucket(e.target.value)}
          className="border border-border rounded-lg px-2 py-1 text-sm bg-surface"
        >
          {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      )}
      <button
        aria-label={inUse ? `${cat.Name} in use, can't delete` : `Delete ${cat.Name}`}
        disabled={inUse}
        onClick={remove}
        className="text-muted hover:text-bad disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/screens/CategoryManager.test.tsx`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/CategoryManager.tsx frontend/src/screens/CategoryManager.test.tsx
git commit -m "feat(frontend): add CategoryManager screen"
```

---

## Task 8: Wire the manager into Settings

**Files:**
- Modify: `frontend/src/screens/Settings.tsx`

- [ ] **Step 1: Add the import and open-state**

In `frontend/src/screens/Settings.tsx`, add the import near the other screen imports:

```tsx
import { CategoryManager } from "./CategoryManager";
```

Inside `Settings()`, add state near the other `useState` calls (e.g. beside `swipeCfg`):

```tsx
  const [managerOpen, setManagerOpen] = useState(false);
```

- [ ] **Step 2: Replace the "Categories → buckets" card**

Replace the entire card block (currently lines ~156-168, the `<Card>` containing `Categories → buckets`) with:

```tsx
      <Card>
        <button
          onClick={() => setManagerOpen(true)}
          className="w-full flex items-center justify-between text-sm font-medium"
        >
          <span>Manage categories</span>
          <span className="text-muted" aria-hidden>→</span>
        </button>
      </Card>
```

- [ ] **Step 3: Render the overlay and remove dead code**

Just before the final closing `</div>` of the returned JSX (after the About card), add:

```tsx
      {managerOpen && <CategoryManager onClose={() => setManagerOpen(false)} />}
```

Then delete the now-unused `reassign` function (the `const reassign = async (c: Category, bucket: string) => { ... };` block) and the `const BUCKETS = ["need", "want", "saving"] as const;` line — both are no longer referenced. (`Category` type, `cats` query, `catName`, `del`, and `postJSON` are still used elsewhere — keep them.)

- [ ] **Step 4: Verify type-check and existing Settings tests still pass**

Run: `cd frontend && bunx tsc --noEmit && bunx vitest run src/screens/Settings.test.tsx src/screens/Settings.categorization.test.tsx`
Expected: no type errors; both test files PASS. (Neither asserts on the old "Categories → buckets" card, so removing it is safe.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/Settings.tsx
git commit -m "feat(frontend): open CategoryManager from Settings"
```

---

## Task 9: Full verification + rebuild embedded bundle

**Files:**
- Modify: `internal/web/dist/*` (regenerated build artifact)

- [ ] **Step 1: Run the full Go test suite**

Run: `go test ./...`
Expected: PASS (all packages).

- [ ] **Step 2: Run the full frontend test suite**

Run: `cd frontend && bun run test`
Expected: PASS (all files).

- [ ] **Step 3: Rebuild the embedded frontend bundle**

Per CLAUDE.md, `internal/web/dist/` is a committed artifact and must match the frontend source before finishing the branch. First re-check `main` for parallel changes, then rebuild:

```bash
git fetch origin main
cd frontend && bun install && bun run build
```

- [ ] **Step 4: Build the binary to confirm embed + compile**

Run: `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`
Expected: builds with no error.

- [ ] **Step 5: Commit the rebuilt bundle**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for category management"
```

---

## Self-review notes (verification of plan against spec)

- **Create** → Task 7 add-form + existing `POST` (Task 5 ensures `is_active=1` + 409 on dup). ✓
- **Rename + re-bucket** → Task 7 `CategoryRow` (rename via PUT, bucket via PUT). ✓
- **Delete block-if-in-use** → Tasks 1-4 (usage query, 409 guard, hard delete). ✓
- **`/usage` endpoint drives pre-delete disable** → Task 3 + Task 7 per-row usage query. ✓
- **Duplicate-name → 409 with friendly UI message** → Task 5 + Task 7 catch. ✓
- **Dedicated full-screen overlay from Settings, no router/nav change** → Tasks 7-8. ✓
- **Kind immutable; flat categories** → Task 7 has no kind editor and no parent_id. ✓
- **Tests (Go + vitest)** → Tasks 1-5, 7-8; full-suite gate in Task 9. ✓
- **Embedded dist rebuilt** → Task 9. ✓
