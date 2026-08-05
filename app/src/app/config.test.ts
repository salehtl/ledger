import { describe, expect, test } from "bun:test";

import { serverURL } from "./config.ts";

describe("serverURL", () => {
  test("returns a normalized HTTPS origin", () => {
    expect(serverURL("https://ledger.example:8444/")).toBe("https://ledger.example:8444");
  });

  for (const value of [undefined, "", "http://ledger.example", "https://u:p@ledger.example", "https://ledger.example/a", "https://ledger.example?q=1", "https://ledger.example/#x", "not a url"]) {
    test(`rejects ${JSON.stringify(value)}`, () => expect(() => serverURL(value)).toThrow());
  }
});
