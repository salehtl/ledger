/**
 * The transaction list.
 *
 * # It reads a window, and it re-reads it rather than accumulating one
 *
 * `FlatList` over pages of {@link TxnSource.list}. Two rules from Phase 0's
 * post-mortem are structural here rather than advisory:
 *
 *   - **One load at a time.** `loading` is a ref, not state, and it is checked
 *     *before* the query rather than in a `useEffect` guard. The ~39-request /
 *     144 MB fetch storm came from a user re-pressing a control on a blocked JS
 *     thread; `onEndReached` fires the same way when a list settles.
 *   - **Never the whole table.** The query is bound to the window by a keyset
 *     cursor. There is no code path here that asks for every row.
 *
 * # Filters are inline, and there is no bottom sheet
 *
 * The v1 UX record is explicit: the operator dislikes bottom-sheet-everything
 * and prefers swipe plus inline filters with calm rows. So the chips live in a
 * horizontal strip under the search field, filtering happens in SQL, and the
 * only navigation is a push to the detail screen.
 *
 * # No source is a state, not a crash
 *
 * `source === null` renders the reason on the glass. It is the convention the
 * sign-in screen established for a dependency this build does not have, and it
 * is the honest rendering of today's app: the projection is written by Task 8's
 * sync engine, which does not exist yet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Txn } from "@ledger/client/replay/state.ts";

import { INPUT_FONT_MIN, TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import {
  EMPTY_FILTERS,
  cursorOf,
  filtersActive,
  txnTotals,
  withFilterToggled,
  MAX_RETAINED_TXNS,
  prependTxnWindow,
  retainTxnWindow,
  TXN_PAGE_SIZE,
  type ChipDimension,
  type TxnCursor,
  type TxnFilters,
} from "../../lib/transactions.ts";
import type { TxnSource } from "./source.ts";
import { TransactionRow } from "./TransactionRow.tsx";

/** Rows per page. Small enough to paint fast, large enough to fill a screen. */
export const PAGE_SIZE = TXN_PAGE_SIZE;
/** Three pages is a UI window, not an account-sized cache. */
export const MAX_RETAINED_ROWS = MAX_RETAINED_TXNS;

export interface TransactionsScreenProps {
  source: TxnSource | null;
  onOpen: (id: string) => void;
  /** RFC3339 "now" for the date labels. The screen reads no clock of its own. */
  nowIso: string;
  onReview?: () => void;
  onQuarantine?: () => void;
  onCurrencies?: () => void;
  onImport?: () => void;
  onReprocess?: () => void;
  onBudget?: () => void;
  onExport?: () => void;
  onDeleteAccount?: () => void;
  onSecurity?: () => void;
  /** Settings -> Inbound address: shows the address, and rotates it. */
  onAddress?: () => void;
}

export function TransactionsScreen({ source, onOpen, nowIso, onReview, onQuarantine, onCurrencies, onImport, onReprocess, onBudget, onExport, onDeleteAccount, onSecurity, onAddress }: TransactionsScreenProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [filters, setFilters] = useState<TxnFilters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<Txn[]>([]);
  const [cursor, setCursor] = useState<TxnCursor | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A ref rather than state: a second `onEndReached` arriving in the same frame
   * must see the flag the first one set, and a state update is not visible until
   * the next render.
   */
  const loading = useRef(false);

  const facets = useMemo(() => source?.facets() ?? { categories: [], currencies: [] }, [source]);

  const load = useCallback(
    (from: TxnCursor | null, mode: "replace" | "append" | "prepend") => {
      if (source === null || loading.current) return;
      loading.current = true;
      try {
        const page = source.list(filters, { limit: PAGE_SIZE, after: from, direction: mode === "prepend" ? "newer" : "older" });
        if (mode === "prepend") {
          // The recovery path: `from` was the cursor of the row currently at
          // the top of `rows`, so this re-fetches whatever `retainTxnWindow`
          // evicted from the front — see `lib/transactions.ts`'s module doc.
          // The bottom cursor/exhausted state is untouched; this direction
          // never affects "is there more below".
          setRows((prev) => prependTxnWindow(prev, page.rows));
        } else {
          setRows((prev) => retainTxnWindow(prev, page.rows, mode === "replace"));
          setCursor(page.next);
          setExhausted(page.next === null);
        }
        setError(null);
      } catch (e) {
        // A projection written by an older build, or a column that will not
        // decode. It is a state, not a white screen.
        setError(String(e));
      } finally {
        loading.current = false;
      }
    },
    [source, filters],
  );

  // Re-run from the top whenever the query changes. `load` closes over
  // `filters`, so this fires exactly when the SQL would be different.
  useEffect(() => {
    setRows([]);
    setCursor(null);
    setExhausted(false);
    load(null, "replace");
  }, [load]);

  const totals = useMemo(() => txnTotals(rows), [rows]);
  const active = filtersActive(filters);
  const toggle = useCallback(
    <D extends ChipDimension>(dimension: D, value: TxnFilters[D][number]) => {
      setFilters((f) => withFilterToggled(f, dimension, value));
    },
    [],
  );

  if (source === null) {
    return (
      <View
        testID="txns-no-source"
        style={{ flex: 1, backgroundColor: t.colors.bg, padding: t.space.lg, paddingTop: insets.top + t.space.xl, gap: t.space.md }}
      >
        <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}>
          Transactions
        </Text>
        <Text style={[t.type.body, { color: t.colors.text }]}>
          This build has no synced database yet, so there is nothing to list. Nothing is broken on your phone — the
          sync engine that fills it is not wired into this build.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <View style={{ paddingTop: insets.top + t.space.md, gap: t.space.sm }}>
        <View style={{ paddingHorizontal: t.space.lg, gap: t.space.sm }}>
          <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}> 
            Transactions
          </Text>
          {onReview !== undefined && <Pressable accessibilityRole="button" testID="open-review" onPress={onReview}><Text style={[t.type.label, { color: t.colors.accent }]}>Review</Text></Pressable>}
          {onQuarantine !== undefined && <Pressable accessibilityRole="button" testID="open-quarantine" onPress={onQuarantine}><Text style={[t.type.label, { color: t.colors.accent }]}>Held mail</Text></Pressable>}
          {onCurrencies !== undefined && <Pressable accessibilityRole="button" testID="open-currencies" onPress={onCurrencies}><Text style={[t.type.label, { color: t.colors.accent }]}>Exchange rates</Text></Pressable>}
          {onImport !== undefined && <Pressable accessibilityRole="button" testID="open-import" onPress={onImport}><Text style={[t.type.label, { color: t.colors.accent }]}>Import statement</Text></Pressable>}
          {onReprocess !== undefined && <Pressable accessibilityRole="button" testID="open-reprocess" onPress={onReprocess}><Text style={[t.type.label, { color: t.colors.accent }]}>Re-check past mail</Text></Pressable>}
          {onBudget !== undefined && <Pressable accessibilityRole="button" testID="open-budget" onPress={onBudget}><Text style={[t.type.label, { color: t.colors.accent }]}>50 / 30 / 20</Text></Pressable>}
          {onAddress !== undefined && <Pressable accessibilityRole="button" testID="open-address" onPress={onAddress}><Text style={[t.type.label, { color: t.colors.accent }]}>Inbound address</Text></Pressable>}
          {onExport !== undefined && <Pressable accessibilityRole="button" testID="open-export" onPress={onExport}><Text style={[t.type.label, { color: t.colors.accent }]}>Export</Text></Pressable>}
          {onSecurity !== undefined && <Pressable accessibilityRole="button" testID="open-security" onPress={onSecurity}><Text style={[t.type.label, { color: t.colors.accent }]}>Security</Text></Pressable>}
          {onDeleteAccount !== undefined && <Pressable accessibilityRole="button" testID="open-delete-account" onPress={onDeleteAccount}><Text style={[t.type.label, { color: t.colors.danger }]}>Delete account</Text></Pressable>}
          <TextInput
            testID="txn-search"
            accessibilityLabel="Search merchants"
            placeholder="Search merchants"
            placeholderTextColor={t.colors.textMuted}
            value={filters.query}
            onChangeText={(query) => setFilters((f) => ({ ...f, query }))}
            autoCapitalize="none"
            autoCorrect={false}
            style={{
              minHeight: TOUCH_TARGET_MIN,
              fontSize: INPUT_FONT_MIN,
              color: t.colors.text,
              backgroundColor: t.colors.surface,
              borderRadius: t.radius.md,
              paddingHorizontal: t.space.md,
            }}
          />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: t.space.lg, gap: t.space.sm }}
        >
          <Chip testID="chip-needs-review" label="Needs review" on={filters.flags.includes("needs_review")} onPress={() => toggle("flags", "needs_review")} />
          <Chip testID="chip-unparsed" label="Couldn't read" on={filters.flags.includes("unparsed")} onPress={() => toggle("flags", "unparsed")} />
          <Chip testID="chip-duplicate" label="Duplicates" on={filters.flags.includes("possible_duplicate")} onPress={() => toggle("flags", "possible_duplicate")} />
          <Chip testID="chip-out" label="Money out" on={filters.directions.includes("debit")} onPress={() => toggle("directions", "debit")} />
          <Chip testID="chip-in" label="Money in" on={filters.directions.includes("credit")} onPress={() => toggle("directions", "credit")} />
          {facets.currencies.length > 1 &&
            facets.currencies.map((c) => (
              <Chip key={c} testID={`chip-currency-${c}`} label={c} on={filters.currencies.includes(c)} onPress={() => toggle("currencies", c)} />
            ))}
          {facets.categories.map((c) => (
            <Chip
              key={c ?? "__none__"}
              testID={`chip-category-${c ?? "none"}`}
              label={c ?? "Uncategorized"}
              on={filters.categories.includes(c)}
              onPress={() => toggle("categories", c)}
            />
          ))}
        </ScrollView>

        <View style={{ paddingHorizontal: t.space.lg, flexDirection: "row", alignItems: "center", gap: t.space.md }}>
          <Text testID="txn-summary" style={[t.type.label, { color: t.colors.textMuted }]}>
            {summaryLine(totals.rows, totals.needsReview, totals.unreadable, exhausted)}
          </Text>
          {active > 0 && (
            <Pressable
              testID="clear-filters"
              accessibilityRole="button"
              onPress={() => setFilters(EMPTY_FILTERS)}
              hitSlop={t.space.md}
              style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
            >
              <Text style={[t.type.label, { color: t.colors.accent }]}>Clear {active}</Text>
            </Pressable>
          )}
        </View>
      </View>

      {error !== null && (
        <Text testID="txn-error" accessibilityRole="alert" style={[t.type.body, { color: t.colors.danger, padding: t.space.lg }]}>
          {error}
        </Text>
      )}

      <FlatList
        testID="txn-list"
        data={rows}
        keyExtractor={(row) => row.id}
        renderItem={({ item }) => (
          <TransactionRow txn={item} homeCurrency={source.homeCurrency()} nowIso={nowIso} onPress={onOpen} />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.colors.hairline, marginLeft: t.space.lg }} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (cursor !== null) load(cursor, "append");
        }}
        onStartReachedThreshold={0.5}
        onStartReached={() => {
          // Scrolling back up toward rows `retainTxnWindow` evicted from the
          // front. `rows[0]`'s own cursor is the boundary to recover above —
          // recomputed fresh from state every time, so this is correct
          // whether zero rows were evicted (the fetch just returns none) or
          // many pages were.
          const top = rows[0];
          if (top !== undefined) load(cursorOf(top), "prepend");
        }}
        ListEmptyComponent={
          <Text testID="txn-empty" style={[t.type.body, { color: t.colors.textMuted, padding: t.space.lg }]}>
            {active > 0 ? "Nothing matches those filters." : "No transactions yet."}
          </Text>
        }
        ListFooterComponent={
          cursor !== null ? <ActivityIndicator testID="txn-loading" style={{ margin: t.space.lg }} /> : null
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + t.space.xl }}
      />
    </View>
  );
}

function summaryLine(rows: number, needsReview: number, unreadable: number, exhausted: boolean): string {
  const shown = `${rows} ${rows === 1 ? "transaction" : "transactions"}${exhausted ? "" : " so far"}`;
  const parts = [shown];
  if (needsReview > 0) parts.push(`${needsReview} need review`);
  if (unreadable > 0) parts.push(`${unreadable} couldn't be read`);
  return parts.join(" · ");
}

function Chip({ testID, label, on, onPress }: { testID: string; label: string; on: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      hitSlop={t.space.sm}
      style={{
        minHeight: TOUCH_TARGET_MIN,
        justifyContent: "center",
        paddingHorizontal: t.space.md,
        borderRadius: t.radius.pill,
        borderWidth: 1,
        borderColor: on ? t.colors.accent : t.colors.hairline,
        backgroundColor: on ? t.colors.accent : t.colors.surface,
      }}
    >
      <Text style={[t.type.label, { color: on ? t.colors.bg : t.colors.text }]}>{label}</Text>
    </Pressable>
  );
}
