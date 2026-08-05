/**
 * The picker, rendered.
 *
 * `bun test` covers the ops, the copy and the normalisation — those are the
 * decisions. What only a render can show is whether the *consequence reaches
 * the glass before the tap does*, which is the property this task is judged on
 * and is a property of the screen rather than of a pure function:
 *
 *   - the permanence statement is on screen at first paint, before any
 *     selection, so it cannot be a receipt;
 *   - selecting a currency emits nothing;
 *   - the confirm button is inert until the acknowledgement is made, so "the
 *     copy was rendered" is upgraded to "the user acted on it".
 *
 * A reducer test can prove an op was not authored. Only this can prove nothing
 * put an authoring button under a thumb anyway.
 */

import { render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { INPUT_FONT_MIN, ThemeProvider, TOUCH_TARGET_MIN } from "../../app/Theme.tsx";
import { COMMON_CURRENCIES, homeCurrencyOps, type OpSpec } from "../../lib/onboarding.ts";
import { HomeCurrencyScreen } from "./HomeCurrencyScreen.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

interface Recorder {
  batches: OpSpec[][];
  set: string[];
  commit: (ops: readonly OpSpec[]) => Promise<void>;
}

function recorder(fail?: Error): Recorder {
  const r: Recorder = {
    batches: [],
    set: [],
    commit: async (ops) => {
      r.batches.push([...ops]);
      if (fail !== undefined) throw fail;
    },
  };
  return r;
}

/** `render` is async in RTL 14 — an un-awaited one leaves `screen` unset. */
async function renderPicker(r: Recorder | null, existing: string | null = null) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <HomeCurrencyScreen
          commit={r === null ? null : r.commit}
          onSet={(c) => r?.set.push(c)}
          existing={existing}
        />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

function flatStyle(node: { props: { style?: unknown } }): Record<string, unknown> {
  const s = node.props.style;
  return Array.isArray(s) ? Object.assign({}, ...(s as object[])) : ((s ?? {}) as Record<string, unknown>);
}

describe("before the tap", () => {
  it("says the choice is permanent at first paint, before anything is selected", async () => {
    await renderPicker(recorder());
    const card = screen.getByTestId("home-currency-permanence");
    expect(card).toBeTruthy();
    // And it says the two things §3.7 requires, not a vague "be careful".
    expect(screen.getByText(/no way to change your home currency/i)).toBeTruthy();
    expect(screen.getByText(/delete your account/i)).toBeTruthy();
    // No confirmation surface is up yet: this is a warning, not a receipt.
    expect(screen.queryByTestId("home-currency-confirm")).toBeNull();
  });

  it("never offers the sentence that would be a lie", async () => {
    await renderPicker(recorder());
    await userEvent.press(screen.getByTestId("currency-AED"));
    const text = screen.toJSON();
    const rendered = JSON.stringify(text).toLowerCase();
    expect(rendered).not.toContain("change this later");
    expect(rendered).not.toContain("in settings");
  });

  it("selecting a currency arms the confirmation and authors nothing", async () => {
    const r = recorder();
    await renderPicker(r);
    await userEvent.press(screen.getByTestId("currency-AED"));
    expect(screen.getByTestId("home-currency-consequence")).toBeTruthy();
    expect(r.batches).toEqual([]);
    expect(r.set).toEqual([]);
  });

  it("the confirm button is inert until the acknowledgement is made", async () => {
    const r = recorder();
    await renderPicker(r);
    await userEvent.press(screen.getByTestId("currency-AED"));

    expect(screen.getByTestId("home-currency-confirm").props.accessibilityState.disabled).toBe(true);
    // Pressing it anyway must do nothing — `disabled` on a Pressable is the
    // property under test, and a screen that also wired an onPress guard would
    // pass this while a stray `onPressIn` still fired.
    await userEvent.press(screen.getByTestId("home-currency-confirm"));
    expect(r.batches).toEqual([]);

    await userEvent.press(screen.getByTestId("home-currency-acknowledge"));
    expect(screen.getByTestId("home-currency-confirm").props.accessibilityState.disabled).toBe(false);
  });

  it("echoes the chosen code in the title, the acknowledgement and the button", async () => {
    await renderPicker(recorder());
    await userEvent.press(screen.getByTestId("currency-SAR"));
    const rendered = JSON.stringify(screen.toJSON());
    expect(rendered).toContain("Set SAR as your home currency?");
    expect(rendered).toContain("I understand SAR is permanent.");
    expect(rendered).toContain("Set SAR as my home currency");
  });

  it("going back un-arms the choice, acknowledgement and all", async () => {
    const r = recorder();
    await renderPicker(r);
    await userEvent.press(screen.getByTestId("currency-AED"));
    await userEvent.press(screen.getByTestId("home-currency-acknowledge"));
    await userEvent.press(screen.getByTestId("home-currency-back"));
    expect(screen.getByTestId("home-currency-permanence")).toBeTruthy();

    // Re-arming must not carry the old acknowledgement across: a second choice
    // acknowledged by a tap that was about the first one is not an acknowledgement.
    await userEvent.press(screen.getByTestId("currency-USD"));
    expect(screen.getByTestId("home-currency-confirm").props.accessibilityState.disabled).toBe(true);
  });
});

describe("the tap", () => {
  it("authors exactly the ops the pure module specifies, then reports the choice", async () => {
    const r = recorder();
    await renderPicker(r);
    await userEvent.press(screen.getByTestId("currency-AED"));
    await userEvent.press(screen.getByTestId("home-currency-acknowledge"));
    await userEvent.press(screen.getByTestId("home-currency-confirm"));

    expect(r.batches).toEqual([homeCurrencyOps("AED")]);
    // Named rather than only compared to the helper, so a helper that returned
    // nothing would not make both sides agree.
    expect(r.batches[0]?.map((o) => o.type)).toEqual(["home_currency_set", "rate_set"]);
    expect(r.set).toEqual(["AED"]);
  });

  it("a non-AED choice seeds no peg, and says nothing about one", async () => {
    const r = recorder();
    await renderPicker(r);
    await userEvent.press(screen.getByTestId("currency-GBP"));
    expect(screen.queryByTestId("home-currency-peg")).toBeNull();
    await userEvent.press(screen.getByTestId("home-currency-acknowledge"));
    await userEvent.press(screen.getByTestId("home-currency-confirm"));
    expect(r.batches[0]?.map((o) => o.type)).toEqual(["home_currency_set"]);
  });

  it("AED shows the peg as arithmetic, next to the fact that rates ARE changeable", async () => {
    await renderPicker(recorder());
    await userEvent.press(screen.getByTestId("currency-AED"));
    expect(screen.getByTestId("home-currency-peg")).toBeTruthy();
    expect(screen.getByText("USD 100.00 is recorded as AED 367.25")).toBeTruthy();
    expect(screen.getByText(/change whenever you like/i)).toBeTruthy();
  });

  it("a double press authors one batch, not two", async () => {
    // The op is irreversible; a repeat press is the cheapest way to author a
    // second `home_currency_set`, which replay records as a permanent anomaly.
    const r = recorder();
    await renderPicker(r);
    await userEvent.press(screen.getByTestId("currency-AED"));
    await userEvent.press(screen.getByTestId("home-currency-acknowledge"));
    const button = screen.getByTestId("home-currency-confirm");
    await userEvent.press(button);
    await userEvent.press(button);
    expect(r.batches.length).toBe(1);
  });

  it("a failed commit says nothing was recorded, and offers the same button again", async () => {
    const r = recorder(new Error("offline"));
    await renderPicker(r);
    await userEvent.press(screen.getByTestId("currency-AED"));
    await userEvent.press(screen.getByTestId("home-currency-acknowledge"));
    await userEvent.press(screen.getByTestId("home-currency-confirm"));

    expect(r.set).toEqual([]);
    expect(screen.getByTestId("home-currency-error")).toBeTruthy();
    expect(screen.getByTestId("home-currency-confirm").props.accessibilityState.disabled).toBe(false);
  });
});

describe("the states around it", () => {
  it("with no client wired, the button is disabled with the reason on it", async () => {
    await renderPicker(null);
    await userEvent.press(screen.getByTestId("currency-AED"));
    await userEvent.press(screen.getByTestId("home-currency-acknowledge"));
    expect(screen.getByTestId("home-currency-no-client")).toBeTruthy();
    expect(screen.getByTestId("home-currency-confirm").props.accessibilityState.disabled).toBe(true);
  });

  it("a currency already in the log renders the refusal, and no picker at all", async () => {
    const r = recorder();
    await renderPicker(r, "AED");
    expect(screen.getByTestId("home-currency-already-set")).toBeTruthy();
    expect(screen.queryByTestId("home-currency-search")).toBeNull();
    expect(screen.queryByTestId("currency-USD")).toBeNull();
    await userEvent.press(screen.getByTestId("home-currency-continue"));
    expect(r.batches).toEqual([]);
    expect(r.set).toEqual(["AED"]);
  });
});

describe("search", () => {
  it("filters by code and by name, and offers an unlisted code rather than a dead end", async () => {
    await renderPicker(recorder());
    const field = screen.getByTestId("home-currency-search");

    await userEvent.type(field, "rupee");
    expect(screen.getByTestId("currency-INR")).toBeTruthy();
    expect(screen.queryByTestId("currency-AED")).toBeNull();

    await userEvent.clear(field);
    await userEvent.type(field, "zwl");
    expect(screen.getByTestId("currency-ZWL")).toBeTruthy();
  });

  it("clears to empty and stays empty — no springback", async () => {
    // v1's harness found `Number("") === 0` by clearing every field on every
    // screen. This field is a string draft for the same reason.
    await renderPicker(recorder());
    const field = screen.getByTestId("home-currency-search");
    await userEvent.type(field, "AE");
    await userEvent.clear(field);
    expect(screen.getByTestId("home-currency-search").props.value).toBe("");
    // And an empty query is the whole list back, not an empty screen.
    expect(screen.getByTestId(`currency-${COMMON_CURRENCIES[0]?.code}`)).toBeTruthy();
  });

  it("a query matching nothing says what to do instead", async () => {
    await renderPicker(recorder());
    await userEvent.type(screen.getByTestId("home-currency-search"), "qqqq");
    expect(screen.getByTestId("home-currency-empty")).toBeTruthy();
  });
});

describe("the mobile conventions", () => {
  it("every control clears 44pt and the input clears 16pt", async () => {
    // jsdom reads the style object, not laid-out geometry: this catches a
    // regression in the VALUE and cannot catch a layout that clips. Said here
    // rather than in a report nobody reads at the failure.
    await renderPicker(recorder());
    expect(flatStyle(screen.getByTestId("home-currency-search")).fontSize).toBeGreaterThanOrEqual(INPUT_FONT_MIN);
    expect(flatStyle(screen.getByTestId("home-currency-search")).minHeight).toBeGreaterThanOrEqual(
      TOUCH_TARGET_MIN,
    );
    for (const c of COMMON_CURRENCIES) {
      expect(flatStyle(screen.getByTestId(`currency-${c.code}`)).minHeight).toBeGreaterThanOrEqual(
        TOUCH_TARGET_MIN,
      );
    }

    await userEvent.press(screen.getByTestId("currency-AED"));
    for (const id of ["home-currency-acknowledge", "home-currency-confirm", "home-currency-back"]) {
      expect(flatStyle(screen.getByTestId(id)).minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN);
    }
  });
});
