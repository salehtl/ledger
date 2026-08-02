/**
 * The wall, rendered.
 *
 * `bun test` covers the classification — which stops halt, which one wins when
 * several fire, and what each one says (`client/src/invariants/surface.test.ts`
 * has 24 tests on exactly that). Those are the decisions. What only a render can
 * show is whether the screen *acts* on them, and there are two properties here
 * that no amount of reducer testing reaches:
 *
 *  1. **Nothing on this screen continues.** A user cannot leave it, and the
 *     component exposes no affordance that a later screen could wire to.
 *  2. **The benign and the adversarial `I11` produce different glass.** Phase 1
 *     records the two being collapsed into one message as the defect that
 *     laundered a withholding attack into a notice. A test that only compared
 *     `surface()`'s output could still miss a screen that rendered the id.
 *
 * The fixtures are REAL `surface()` output, not hand-written `Halt` objects: the
 * chain under test is violation → lane → copy → glass, and a literal `Halt`
 * would let the component pass while the classification that feeds it was
 * wrong.
 */

import { cleanup, render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  VIOLATION_CHAIN_WITHHELD,
  VIOLATION_NEWER_VERSION,
  VIOLATION_ROSTER_COVERAGE,
  type Violation,
} from "@ledger/client/invariants/check.ts";
import { surface, type Halt } from "@ledger/client/invariants/surface.ts";

import { ThemeProvider } from "../app/Theme.tsx";
import { HaltBanner } from "./HaltBanner.tsx";

const ROSTER = "I11_roster_checkpoint";

const stop = (id: string, kind?: string, detail = `${id} broke`): Violation => ({
  id,
  severity: "hard_stop",
  detail,
  ...(kind === undefined ? {} : { kind }),
});

async function show(violations: Violation[]): Promise<Halt> {
  const s = surface({ violations });
  if (s.halt === null) throw new Error("fixture produced no halt");
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <ThemeProvider>
        <HaltBanner halt={s.halt} also={s.halts.slice(1)} />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
  return s.halt;
}

/**
 * Every invariant id and condition name that must never reach the glass before
 * the disclosure is opened. The copy is the product; the ids are diagnostics.
 *
 * This is what catches a banner that renders `halt.kind` where `halt.title`
 * belongs — which passed a "the two conditions differ" test, because
 * `not_vouched_for` and `chain_withheld` differ too.
 */
const JARGON = /I1[0-9]?_|roster_coverage|chain_withheld|not_vouched_for|update_required|uncertified|tampered|inconsistent/;

test("it says syncing has stopped, and offers nothing that continues", async () => {
  const halt = await show([stop("I3_chain")]);
  expect(screen.getByText(halt.title)).toBeTruthy();
  expect(screen.getByText(halt.body)).toBeTruthy();
  expect(JSON.stringify(screen.toJSON())).not.toMatch(JARGON);
  expect(screen.getByText("Syncing stopped")).toBeTruthy();
  // Every control on the screen. There is exactly one and it opens the details;
  // nothing dismisses, skips, retries or continues.
  // Every control on the screen, by its accessible name. Asserting over all
  // TEXT instead would be a checker that cries wolf: the copy legitimately says
  // "Try again later", and a test that failed on the word "later" would be
  // rewritten rather than believed.
  const controls = screen.getAllByRole("button");
  expect(controls).toHaveLength(1);
  expect(screen.getByTestId("halt-details-toggle")).toBeTruthy();
  // `toJSON()` on the control itself, not on its props: a Pressable's props
  // carry React context objects and `JSON.stringify` walks straight into a
  // cycle through them.
  const names = controls.map((c) => JSON.stringify(c.toJSON?.() ?? "")).join(" ");
  expect(names).not.toMatch(/continue|dismiss|skip|ignore|not now|later/i);
});

test("the benign I11 and the withholding I11 put different words on the glass", async () => {
  await show([stop(ROSTER, VIOLATION_ROSTER_COVERAGE)]);
  const benignText = JSON.stringify(screen.toJSON());
  // RTL's own teardown, not `screen.unmount()` — unmounting by hand left the
  // library's screen handle pointing at a dead tree and every test after this
  // one found nothing. Measured: they passed in isolation and failed in file
  // order, which is the signature of shared state rather than of a bug in them.
  await cleanup();

  await show([stop(ROSTER, VIOLATION_CHAIN_WITHHELD)]);
  const attackText = JSON.stringify(screen.toJSON());

  expect(benignText).not.toEqual(attackText);
  // The words themselves, not merely "they differ": two DIFFERENT ids would
  // satisfy a difference test while putting jargon on the glass.
  expect(benignText).toMatch(/vouched for/);
  expect(benignText).not.toMatch(JARGON);
  expect(attackText).toMatch(/withholding|withheld/);
  expect(attackText).not.toMatch(JARGON);
  expect(screen.queryByText(ROSTER)).toBeNull();
});

test("when both I11 conditions fire, the withholding one is the headline and the other is still named", async () => {
  await show([stop(ROSTER, VIOLATION_ROSTER_COVERAGE), stop(ROSTER, VIOLATION_CHAIN_WITHHELD)]);
  expect(screen.getByText(/withheld/i)).toBeTruthy();
  expect(screen.getByText(/^Also: /)).toBeTruthy();
});

test("an out-of-date app is told to update, and is never told it was tampered with", async () => {
  await show([stop("I6_schema_version", VIOLATION_NEWER_VERSION)]);
  expect(screen.getAllByText(/update/i).length).toBeGreaterThan(0);
  expect(screen.queryByText(/tamper|match its own record/i)).toBeNull();
});

test("the raw violations are one tap away, verbatim", async () => {
  // The friendly sentence is for the person; the ids are for the operator, who
  // on this product is the same person on a worse day.
  const user = userEvent.setup();
  await show([stop("I2_writer_counters", undefined, "(dev-a|hot) rows entry 3 has counter 5 where 4 is due")]);
  expect(screen.queryByTestId("halt-details")).toBeNull();
  await user.press(screen.getByTestId("halt-details-toggle"));
  expect(screen.getByText(/I2_writer_counters: \(dev-a\|hot\) rows entry 3 has counter 5 where 4 is due/)).toBeTruthy();
});

test("the details toggle is a 44 pt target", async () => {
  await show([stop("I3_chain")]);
  const style = screen.getByTestId("halt-details-toggle").props.style as { minHeight?: number };
  expect(style.minHeight).toBeGreaterThanOrEqual(44);
});
