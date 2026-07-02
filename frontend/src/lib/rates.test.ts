import { describe, expect, it } from "vitest";
import { parseRateForm } from "./rates";

describe("parseRateForm", () => {
  it("accepts a valid code and rate, normalizing case/whitespace", () => {
    expect(parseRateForm(" eur ", "4.30")).toEqual({ ok: true, currency: "EUR", rate: 4.3 });
  });
  it("rejects non-3-letter codes", () => {
    expect(parseRateForm("EURO", "4.3")).toEqual({ ok: false, error: "Currency must be a 3-letter code." });
    expect(parseRateForm("E1R", "4.3")).toEqual({ ok: false, error: "Currency must be a 3-letter code." });
  });
  it("rejects AED", () => {
    expect(parseRateForm("AED", "1")).toEqual({ ok: false, error: "AED is the base currency." });
  });
  it("rejects non-positive or non-numeric rates", () => {
    expect(parseRateForm("EUR", "0")).toEqual({ ok: false, error: "Enter a rate greater than zero." });
    expect(parseRateForm("EUR", "abc")).toEqual({ ok: false, error: "Enter a rate greater than zero." });
    expect(parseRateForm("EUR", "-1")).toEqual({ ok: false, error: "Enter a rate greater than zero." });
  });
});
