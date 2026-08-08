import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { BudgetSplitPicker, completeSplit, splitAdvice, type BudgetSplitDraft } from "./BudgetSplitPicker";

function Harness({ initial }: { initial: BudgetSplitDraft }) {
  const [draft, setDraft] = useState<BudgetSplitDraft>(initial);
  return <BudgetSplitPicker value={draft} onChange={setDraft} />;
}

describe("splitAdvice", () => {
  it("names the sum, and never repairs it", () => {
    // 60/30/20 is the case this exists for: a plausible plan that does not add
    // up. Normalising it to 55/27/18 would change what the user typed without
    // telling them.
    expect(splitAdvice({ need: 60, want: 30, saving: 20 })).toBe("Adds up to 110% — it has to be 100%.");
    expect(splitAdvice({ need: 60, want: 20, saving: 20 })).toBe("Adds up to 100%.");
    expect(splitAdvice({ need: 60, want: null, saving: 20 })).toBe("Fill in all three to save.");
  });
});

describe("completeSplit", () => {
  it("is a plan only when all three are typed and they add up to 100", () => {
    expect(completeSplit({ need: 60, want: 20, saving: 20 })).toEqual({ need: 60, want: 20, saving: 20 });
    expect(completeSplit({ need: 60, want: 30, saving: 20 })).toBeNull();
    expect(completeSplit({ need: 60, want: null, saving: 20 })).toBeNull();
  });
});

describe("BudgetSplitPicker", () => {
  it("can be locked while the plan it shows is not the user's yet", () => {
    // For the window before a screen has read the stored plan: the three
    // percentages on display are a placeholder the seeding is about to replace,
    // and typing into them is work that will be thrown away.
    render(<BudgetSplitPicker value={{ need: 50, want: 30, saving: 20 }} onChange={() => {}} disabled />);
    for (const label of [/Needs/, /Wants/, /Savings/]) expect(screen.getByLabelText(label)).toBeDisabled();
  });

  it("says the sum while it is being typed, not after saving", () => {
    render(<Harness initial={{ need: 50, want: 30, saving: 20 }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Adds up to 100%.");

    fireEvent.change(screen.getByLabelText(/Needs/), { target: { value: "60" } });
    expect(screen.getByRole("status")).toHaveTextContent("Adds up to 110% — it has to be 100%.");
  });

  it("can be emptied to type a fresh figure — no 0 springs back", () => {
    // `Number("") === 0` is the defect `NumberField` exists for; a percentage
    // field that refuses to stay empty cannot be retyped.
    render(<Harness initial={{ need: 50, want: 30, saving: 20 }} />);
    const needs = screen.getByLabelText(/Needs/) as HTMLInputElement;
    fireEvent.change(needs, { target: { value: "" } });
    expect(needs.value).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent("Fill in all three to save.");
  });

  it("takes whole percentages only — a decimal point is not accepted", () => {
    const onChange = vi.fn();
    render(<BudgetSplitPicker value={{ need: 50, want: 30, saving: 20 }} onChange={onChange} />);
    const saving = screen.getByLabelText(/Savings/) as HTMLInputElement;
    fireEvent.change(saving, { target: { value: "20.5" } });
    // The dot is dropped rather than accepted: a plan is three integers, and the
    // fold refuses a fractional percentage outright.
    expect(saving.value).toBe("205");
    expect(onChange).toHaveBeenCalledWith({ need: 50, want: 30, saving: 205 });
  });

  it("clamps to 0..100 on blur, so an over-typed figure cannot be saved", () => {
    render(<Harness initial={{ need: 50, want: 30, saving: 20 }} />);
    const saving = screen.getByLabelText(/Savings/) as HTMLInputElement;
    fireEvent.change(saving, { target: { value: "205" } });
    fireEvent.blur(saving);
    expect(saving.value).toBe("100");
  });
});
