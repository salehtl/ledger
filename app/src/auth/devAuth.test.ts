/**
 * The dev identity's grammar, checked against the server that has to accept it.
 *
 * The interesting assertions here are the two that read
 * `internal/v2/auth/dev.go` off disk. A test that only pinned `"dev:"` against
 * a constant in the file next door would be true by construction — both sides
 * of the comparison would be this repo's client half — and would stay green on
 * the day somebody changed the prefix or dropped the `"|"` rule on the server.
 * Reading the Go source is the independent measurement.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DEV_SIGN_IN_MARKER,
  DEV_SUBJECT_DEFAULT,
  DEV_SUBJECT_MAX,
  DEV_TOKEN_PREFIX,
  DevSubjectError,
  devIdToken,
  devSubjectProblem,
  normalizeDevSubject,
} from "./devAuth.ts";

const DEV_GO = readFileSync(new URL("../../../internal/v2/auth/dev.go", import.meta.url).pathname, "utf8");

describe("the dev token grammar agrees with the server's", () => {
  test("the prefix is the one devVerifier cuts", () => {
    const match = /devTokenPrefix\s*=\s*"([^"]*)"/.exec(DEV_GO);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(DEV_TOKEN_PREFIX);
  });

  test('the server still refuses a subject containing "|", so this client still does', () => {
    // If this stops matching, the server has either dropped the rule (and the
    // client's sentence about it is now a lie) or moved it somewhere this test
    // cannot see (and the pairing has to be re-established deliberately).
    expect(DEV_GO).toContain('strings.Contains(subject, "|")');
    expect(devSubjectProblem("a|b")).not.toBeNull();
  });

  test("the server still refuses an empty subject, so this client still does", () => {
    expect(DEV_GO).toContain('subject == ""');
    expect(devSubjectProblem("")).not.toBeNull();
    expect(devSubjectProblem("   ")).not.toBeNull();
  });
});

describe("devIdToken", () => {
  test("builds exactly prefix + subject", () => {
    expect(devIdToken("alice")).toBe("dev:alice");
    expect(devIdToken(DEV_SUBJECT_DEFAULT)).toBe(`${DEV_TOKEN_PREFIX}${DEV_SUBJECT_DEFAULT}`);
  });

  test("trims, because a trailing space is a different account on the server", () => {
    expect(normalizeDevSubject("  alice \n")).toBe("alice");
    expect(devIdToken("  alice  ")).toBe("dev:alice");
  });

  test("two subjects are two identities — the property a fixed subject could not test", () => {
    expect(devIdToken("alice")).not.toBe(devIdToken("bob"));
  });

  test("throws rather than returning a token the server will 401", () => {
    expect(() => devIdToken("")).toThrow(DevSubjectError);
    expect(() => devIdToken("a|b")).toThrow(DevSubjectError);
    expect(() => devIdToken("x".repeat(DEV_SUBJECT_MAX + 1))).toThrow(DevSubjectError);
  });

  test("accepts exactly the cap", () => {
    const subject = "x".repeat(DEV_SUBJECT_MAX);
    expect(devIdToken(subject)).toBe(DEV_TOKEN_PREFIX + subject);
  });

  test("the default is usable as typed", () => {
    expect(devSubjectProblem(DEV_SUBJECT_DEFAULT)).toBeNull();
  });
});

test("the grep marker is distinctive enough to mean something in a bundle", () => {
  // The production-bundle proof greps for this string. A marker that also
  // occurred in ordinary code would make that grep unfalsifiable.
  expect(DEV_SIGN_IN_MARKER).toMatch(/^[A-Z_]{12,}$/);
});
