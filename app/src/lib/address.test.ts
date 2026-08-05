import { describe, expect, test } from "bun:test";

import {
  AddressDecodeError,
  decodeAddress,
  graceNotice,
  GRACE_DAYS,
  PREDECESSOR_SCOPE_NOTE,
  rotationCopy,
} from "./address.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-05T12:00:00Z");
const ok = { address: "abc@in.example", created_at: "2026-08-05T00:00:00Z" };

describe("decodeAddress", () => {
  test("reads the plain response", () => {
    expect(decodeAddress(ok)).toEqual({
      address: "abc@in.example",
      createdAt: "2026-08-05T00:00:00Z",
      rotatesFrom: null,
      graceUntil: null,
    });
  });

  test("reads a predecessor and its deadline", () => {
    const got = decodeAddress({ ...ok, rotates_from: "old@in.example", grace_until: "2026-08-12T00:00:00Z" });
    expect(got.rotatesFrom).toBe("old@in.example");
    expect(got.graceUntil).toBe("2026-08-12T00:00:00Z");
  });

  /**
   * The pair rule, in both directions.
   *
   * It matters because the failure would otherwise be silent and asymmetric: a
   * lone `rotates_from` renders an old address with no deadline (reads as "this
   * still works, indefinitely") and a lone `grace_until` renders a countdown
   * for nothing. It is enforced by the two `str()` calls after the "neither"
   * fast path, and by nothing else - see the comment there for the mutation
   * that removed the redundant explicit branch.
   */
  test("refuses a half pair, whichever half is missing", () => {
    expect(() => decodeAddress({ ...ok, rotates_from: "old@in.example" })).toThrow(AddressDecodeError);
    expect(() => decodeAddress({ ...ok, grace_until: "2026-08-12T00:00:00Z" })).toThrow(AddressDecodeError);
  });

  /**
   * `Predecessor` is ONE HOP server-side. If a later server grew a chain, the
   * honest answer from this build is a refusal, because it has no way to show a
   * second still-accepting address and showing the first as though it were the
   * only one is the bug the brief names.
   */
  test("refuses a chain rather than rendering the first of it", () => {
    expect(() =>
      decodeAddress({ ...ok, rotates_from: ["old@in.example", "older@in.example"], grace_until: "2026-08-12T00:00:00Z" }),
    ).toThrow(/list/);
  });

  test("refuses a response with no address or no created_at", () => {
    expect(() => decodeAddress({ created_at: ok.created_at })).toThrow(AddressDecodeError);
    expect(() => decodeAddress({ address: "" , created_at: ok.created_at })).toThrow(AddressDecodeError);
    expect(() => decodeAddress({ address: ok.address })).toThrow(AddressDecodeError);
    expect(() => decodeAddress(null)).toThrow(AddressDecodeError);
    expect(() => decodeAddress("abc@in.example")).toThrow(AddressDecodeError);
  });
});

describe("graceNotice", () => {
  const withGrace = (until: string) =>
    decodeAddress({ ...ok, rotates_from: "old@in.example", grace_until: until });

  test("is absent when nothing is still accepting", () => {
    expect(graceNotice(decodeAddress(ok), NOW)).toBeNull();
  });

  test("rounds UP, so a part day is still a day", () => {
    // 6 days and 1 hour left. Rounding down would say 6 and the address would
    // stop a day before the screen said it would.
    const notice = graceNotice(withGrace(new Date(NOW + 6 * DAY + 3_600_000).toISOString()), NOW);
    expect(notice?.daysLeft).toBe(7);
    expect(notice?.text).toContain("in 7 days");
  });

  test("says today on the last day", () => {
    const notice = graceNotice(withGrace(new Date(NOW + 3_600_000).toISOString()), NOW);
    expect(notice?.daysLeft).toBe(1);
    expect(notice?.text).toContain("today");
    expect(notice?.expired).toBe(false);
  });

  test("says it has stopped once the deadline has passed", () => {
    const notice = graceNotice(withGrace(new Date(NOW - 1).toISOString()), NOW);
    expect(notice?.expired).toBe(true);
    expect(notice?.text).toContain("stopped accepting");
    expect(notice?.text).not.toContain("still accepts");
  });

  test("says so rather than inventing a date when the deadline is unreadable", () => {
    const notice = graceNotice(withGrace("not-a-date"), NOW);
    expect(notice).not.toBeNull();
    expect(notice?.text).toContain("could not read the deadline");
  });

  /**
   * The whole point: the notice is about the ONE address the server named. A
   * notice that spoke about "your old addresses" would be a claim this build
   * cannot support, because the response only ever carries one.
   */
  test("names exactly the address the server returned, and nothing broader", () => {
    const notice = graceNotice(withGrace(new Date(NOW + 2 * DAY).toISOString()), NOW);
    expect(notice?.address).toBe("old@in.example");
    expect(notice?.text).toContain("old@in.example");
    expect(notice?.text.toLowerCase()).not.toContain("addresses");
    expect(notice?.text.toLowerCase()).not.toContain("all of");
  });

  test("the scope note admits what the response does not cover", () => {
    expect(PREDECESSOR_SCOPE_NOTE).toContain("rotated more than once");
    expect(PREDECESSOR_SCOPE_NOTE).toContain("may still be accepting");
  });
});

describe("rotationCopy", () => {
  const words = rotationCopy();
  const all = words.consequences.join(" ").toLowerCase();

  test("pins the grace window to the server's own default", () => {
    expect(GRACE_DAYS).toBe(7);
    expect(all).toContain("7 days");
  });

  test("names every consequence 3.2 requires", () => {
    expect(all).toContain("forwarding rule");
    expect(all).toContain("bank");
    expect(all).toContain("keeps accepting mail");
    expect(words.reauth.toLowerCase()).toContain("sign in again");
  });

  /**
   * The sentences a well-meaning edit reaches for and which would be lies:
   * ledger cannot re-point anyone's forward, and the old address does not keep
   * working.
   */
  test("never promises ledger will fix the forward for you", () => {
    expect(all).toContain("cannot do this for you");
    expect(all).not.toContain("automatically");
    expect(all).not.toContain("we will update");
    expect(all).not.toContain("keeps working");
  });
});
