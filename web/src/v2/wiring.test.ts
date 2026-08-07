// Smoke test for Task 2: proves `web/` can import `client/src` through the
// `@ledger/client` alias, and that the ONLY platform reachable from a browser
// build is `platform.web` (never `platform`, never `store/open.ts` — see
// vite.config.ts's build for the real assertion: a `node:`/`bun:` builtin
// dragged into the bundle fails `bun run build`, not this test).
import { describe, expect, it } from "vitest";
import { fold, emptyState } from "@ledger/client/replay/replay";
import { webPlatform } from "@ledger/client/platform.web";

describe("@ledger/client wiring", () => {
  it("folds an empty log to the empty state", () => {
    const state = fold([], emptyState());
    expect(state).toBeDefined();
  });

  it("webPlatform hashes the empty string per the sha256 test vector", () => {
    const digest = webPlatform.sha256(new Uint8Array(0));
    expect(webPlatform.toHex(digest)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
