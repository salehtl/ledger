import { describe, expect, it } from "vitest";

import { isDeclarableBankID, normalizeBankName, supportedMatch } from "./bank";

describe("isDeclarableBankID", () => {
  it("accepts the ids the published templates actually use", () => {
    for (const id of ["dib", "enbd", "adcb", "fab", "mashreq", "rakbank"]) {
      expect(isDeclarableBankID(id)).toBe(true);
    }
  });

  it("refuses an id the waitlist grammar cannot store — the one that THREW", () => {
    // `bankDeclaredOps("adib_uae")` throws, and a throw inside an onClick
    // unmounts the tree: there is no error boundary in web/src.
    expect(normalizeBankName("adib_uae").ok).toBe(false);
    expect(isDeclarableBankID("adib_uae")).toBe(false);
  });

  it("refuses an id that only survives by being CHANGED, which is the quiet one", () => {
    // "DIB" folds to "dib", so the declared key stops matching the row it came
    // from: two rows for one bank, and the ticked one cannot be unticked.
    expect(normalizeBankName("DIB")).toEqual({ ok: true, bank: "dib" });
    expect(isDeclarableBankID("DIB")).toBe(false);
    expect(isDeclarableBankID("dubai  islamic")).toBe(false);
  });
});

describe("supportedMatch", () => {
  const supported = ["dib", "enbd"];

  it("matches a typed display name onto the id already on the list", () => {
    expect(supportedMatch("dubai islamic bank", supported)).toBe("dib");
    expect(supportedMatch("dib", supported)).toBe("dib");
  });

  it("is null for a bank that really is not supported", () => {
    expect(supportedMatch("mashreq", supported)).toBeNull();
  });
});
