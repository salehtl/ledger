import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { MonthlyTotalField } from "./MonthlyTotalField";

function Harness({ initial = "", currency = "AED" }: { initial?: string; currency?: string | null }) {
  const [text, setText] = useState(initial);
  return <MonthlyTotalField value={text} onChange={setText} currency={currency} />;
}

describe("MonthlyTotalField", () => {
  it("starts empty and says what leaving it empty means", () => {
    render(<Harness />);
    expect(screen.getByLabelText(/monthly budget/i)).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("No monthly total — ledger will just show what you spend.");
  });

  it("says the amount back in full while it is being typed", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText(/monthly budget/i), { target: { value: "12000" } });
    expect(screen.getByRole("status")).toHaveTextContent("AED 12,000.00 a month.");
  });

  /**
   * The three cases the last round's `NumberField` warning names. In every one
   * the FIELD STILL HOLDS WHAT WAS TYPED — the failure mode being guarded
   * against is a control that quietly stores something else.
   */
  it("keeps a decimal point exactly as typed instead of turning 33.3 into 333", () => {
    render(<Harness />);
    const field = screen.getByLabelText(/monthly budget/i);
    fireEvent.change(field, { target: { value: "33.3" } });
    expect(field).toHaveValue("33.3");
    expect(screen.getByRole("status")).toHaveTextContent("AED 33.30 a month.");
  });

  it("keeps a leading zero, and reads it as the amount it is", () => {
    render(<Harness />);
    const field = screen.getByLabelText(/monthly budget/i);
    fireEvent.change(field, { target: { value: "007" } });
    expect(field).toHaveValue("007");
    expect(screen.getByRole("status")).toHaveTextContent("AED 7.00 a month.");
  });

  it("has no ceiling to clamp to: an amount past 2^53 minor units reads exactly", () => {
    render(<Harness />);
    const field = screen.getByLabelText(/monthly budget/i);
    fireEvent.change(field, { target: { value: "90071992547409.93" } });
    expect(field).toHaveValue("90071992547409.93");
    expect(screen.getByRole("status")).toHaveTextContent("AED 90,071,992,547,409.93 a month.");
  });

  it("refuses too much precision in words, and never shows a rounded version", () => {
    render(<Harness />);
    const field = screen.getByLabelText(/monthly budget/i);
    fireEvent.change(field, { target: { value: "12.345" } });
    expect(field).toHaveValue("12.345");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/two decimal places/i);
    expect(status.textContent ?? "").not.toContain("12.34");
  });

  it("does not blank the field on blur, so nothing is rewritten behind the user", () => {
    render(<Harness />);
    const field = screen.getByLabelText(/monthly budget/i);
    fireEvent.change(field, { target: { value: "12.345" } });
    fireEvent.blur(field);
    expect(field).toHaveValue("12.345");
  });

  it("is a 16px text field with a numeric keypad, so iOS neither zooms nor hides the decimal", () => {
    render(<Harness />);
    const field = screen.getByLabelText(/monthly budget/i);
    expect(field).toHaveAttribute("inputmode", "decimal");
    expect(field).toHaveAttribute("type", "text");
    expect(field.className).toContain("text-base");
  });

  it("prints an unknown home currency bare rather than guessing one", () => {
    render(<Harness initial="500" currency={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("500.00 a month.");
  });
});
