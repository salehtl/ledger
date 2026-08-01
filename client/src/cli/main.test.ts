import { describe, expect, test } from "bun:test";

import { parseArgs } from "./main";

describe("parseArgs", () => {
  test("reads the command and its flags", () => {
    const a = parseArgs(["pull", "--stream", "cold", "--limit", "50"]);
    expect(a.command).toBe("pull");
    expect(a.flags.get("stream")).toBe("cold");
    expect(a.flags.get("limit")).toBe("50");
  });

  // The one genuinely ambiguous flag in the contract: the plan spells
  // `emit --type <t> --json '<payload>'` AND `state --json`. Resolving it
  // globally either loses emit's payload or makes `state --json` swallow the
  // next flag, and both failures are silent.
  test("--json is a value on emit and a switch everywhere else", () => {
    const e = parseArgs(["emit", "--type", "rate_set", "--json", '{"currency":"USD"}']);
    expect(e.flags.get("json")).toBe('{"currency":"USD"}');
    expect(e.bools.has("json")).toBe(false);

    const s = parseArgs(["state", "--json"]);
    expect(s.bools.has("json")).toBe(true);
    expect(s.flags.get("json")).toBeUndefined();

    // …and the switch form must not eat a following global flag.
    const s2 = parseArgs(["state", "--json", "--profile", "b"]);
    expect(s2.bools.has("json")).toBe(true);
    expect(s2.flags.get("profile")).toBe("b");
  });

  test("a value flag with no value is refused rather than eating the next flag", () => {
    expect(() => parseArgs(["emit", "--type", "--entity", "txn:1"])).toThrow(/--type needs a value/);
    expect(() => parseArgs(["pull", "--limit"])).toThrow(/--limit needs a value/);
  });

  test("--keygen-only is a switch, and only on enroll", () => {
    expect(parseArgs(["enroll", "--writer", "dev-b", "--keygen-only"]).bools.has("keygen-only")).toBe(true);
    // On another command it is an ordinary value flag, so it consumes the next
    // token — which is exactly why the set is per-command and not global.
    expect(parseArgs(["pull", "--keygen-only", "x"]).flags.get("keygen-only")).toBe("x");
  });

  test("a second positional argument is refused", () => {
    expect(() => parseArgs(["pull", "extra"])).toThrow(/unexpected argument/);
  });

  // The command must be first, because which flags take a value depends on it.
  // Taking "the first token that is not a flag" instead reads the VALUE of a
  // leading flag as the command — `--profile b state` ran `b` — and then parses
  // every following flag under the wrong rules.
  test("a command after a flag is refused, not silently accepted", () => {
    expect(() => parseArgs(["--profile", "b", "state", "--json"])).toThrow(/the command comes first/);
  });

  test("no arguments at all is the help case, not a crash", () => {
    expect(parseArgs([]).command).toBe("");
  });
});
