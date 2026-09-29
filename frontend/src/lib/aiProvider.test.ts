import { describe, expect, it } from "vitest";
import { aiProviderInfo } from "./aiProvider";

describe("aiProviderInfo", () => {
  it("names TypeSafe and its env var", () => {
    expect(aiProviderInfo("typesafe")).toEqual({ name: "TypeSafe", envVar: "LEDGER_TYPESAFE_API_KEY" });
  });
  it("defaults to Anthropic for an old server with no field", () => {
    expect(aiProviderInfo(undefined)).toEqual({ name: "Anthropic", envVar: "LEDGER_AI_API_KEY" });
    expect(aiProviderInfo("anthropic")).toEqual({ name: "Anthropic", envVar: "LEDGER_AI_API_KEY" });
  });
});
