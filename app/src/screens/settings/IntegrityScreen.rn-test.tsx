/**
 * The Integrity screen, rendered.
 *
 * The classification is `bun test`'s (`client/src/invariants/surface.test.ts`).
 * What only a render can show is the property Phase 1's exit record names — **a
 * notice list nobody reads is the same as no invariants** — which is a property
 * of the glass, not of the data: eighteen `possible_duplicate` anomalies must
 * arrive as one row saying 18, the routine ones must be below the rest and
 * quiet, and none of them may be missing.
 *
 * The fixtures are real `surface()` output for the same reason as
 * `HaltBanner.rn-test.tsx`: a hand-written `Surface` would let this pass while
 * the grouping that feeds it was wrong.
 */

import { render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  NOTICE_COUNTS,
  NOTICE_OTHER_STREAM,
  NOTICE_SET_ASIDE,
  type Violation,
} from "@ledger/client/invariants/check.ts";
import { surface, type SurfaceInput } from "@ledger/client/invariants/surface.ts";

import { ThemeProvider } from "../../app/Theme.tsx";
import { IntegrityScreen } from "./IntegrityScreen.tsx";

const notice = (id: string, kind: string | undefined, detail: string): Violation => ({
  id,
  severity: "notice",
  detail,
  ...(kind === undefined ? {} : { kind }),
});

const setAside = (n: number) =>
  Array.from({ length: n }, (_, k) => ({
    writer_id: "ingest",
    stream: "hot",
    writer_counter: BigInt(k + 1),
    seq: BigInt(k + 1),
    reason: "not an op blob",
  }));

async function show(input: SurfaceInput): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <ThemeProvider>
        <IntegrityScreen surface={surface(input)} />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

test("a clean account says so rather than showing an empty screen", async () => {
  // Same reason `I14` reports zero forks unconditionally: a blank screen and a
  // broken one look identical.
  await show({ violations: [] });
  expect(screen.getByTestId("integrity-clean")).toBeTruthy();
});

test("many findings of one kind are ONE row with a count, not many rows", async () => {
  const many = Array.from({ length: 18 }, (_, n) => notice("I13_supersede_has_origin", undefined, `orphan ${String(n)}`));
  await show({ violations: many });
  expect(screen.getByTestId("integrity-count-I13_supersede_has_origin|")).toHaveTextContent("18");
});

test("routine notices are present, quiet, and last", async () => {
  // Collapsed, never dropped — suppressing them re-creates the blind spot
  // `I14`'s unconditional line exists to remove.
  await show({
    violations: [
      notice("I11_roster_checkpoint", NOTICE_OTHER_STREAM, "cold head not cross-checked"),
      notice("I14_forks_surfaced", NOTICE_COUNTS, "0 forks, 18 anomalies (possible_duplicate 18)"),
      notice("I13_supersede_has_origin", undefined, "op-9 supersedes an ingest nothing introduced"),
    ],
  });
  const rows = screen.getAllByRole("button");
  // The non-routine one leads; both routine ones are still on the screen.
  expect(rows).toHaveLength(3);
  expect(screen.getByTestId("integrity-notice-I13_supersede_has_origin|")).toBeTruthy();
  expect(screen.getByTestId(`integrity-notice-I11_roster_checkpoint|${NOTICE_OTHER_STREAM}`)).toBeTruthy();
  expect(screen.getByTestId(`integrity-notice-I14_forks_surfaced|${NOTICE_COUNTS}`)).toBeTruthy();
});

test("a row expands to the detail behind it", async () => {
  const user = userEvent.setup();
  await show({ violations: [notice("I13_supersede_has_origin", undefined, "op-9 supersedes ingest 4f2a…")] });
  expect(screen.queryByText(/op-9 supersedes/)).toBeNull();
  await user.press(screen.getByRole("button"));
  expect(screen.getByText(/op-9 supersedes ingest 4f2a…/)).toBeTruthy();
});

test("an unreadable blob is a warning row, and never a wall", async () => {
  // Spec §3.3:74: the cursor advanced and nothing was lost. Conflating this
  // with a hard stop is the failure mode Task 12 names in its first sentence.
  await show({
    violations: [notice("I15_unreadable_set_aside", NOTICE_SET_ASIDE, "2 blob(s) set aside and not folded: …")],
    unreadable: setAside(2),
  });
  expect(screen.getByTestId("integrity-unreadable")).toHaveTextContent(/2 entries ledger couldn't read/);
  expect(screen.queryByText(/Syncing stopped/)).toBeNull();
});

test("a halt is recorded here too, so the details survive the wall being dismissed by a relaunch", async () => {
  await show({ violations: [{ id: "I3_chain", severity: "hard_stop", detail: "hash mismatch" }] });
  expect(screen.getByTestId("integrity-halt-tampered")).toBeTruthy();
  expect(screen.getByText("Syncing stopped")).toBeTruthy();
});

test("every notice row is a 44 pt target", async () => {
  await show({ violations: [notice("I13_supersede_has_origin", undefined, "x")] });
  const style = screen.getByRole("button").props.style as { minHeight?: number };
  expect(style.minHeight).toBeGreaterThanOrEqual(44);
});
