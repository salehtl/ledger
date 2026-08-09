import { describe, expect, it } from "vitest";

import { notificationFor, PUSH_TAG, PUSH_TITLE } from "./pushNotification";

describe("notificationFor", () => {
  // The client-side half of the content-free guarantee. The server's payload is
  // pinned byte-for-byte in Go (pushv2.TestTheWebPushPayloadIsContentFree);
  // this pins that the SERVICE WORKER would not render spending detail even if
  // a future server sent some.
  it("renders a constant and ignores whatever the push carried", () => {
    const hostile = {
      json: () => ({ title: "AED 240 at Spinneys", body: "Groceries · 3 new" }),
      text: () => "AED 240 at Spinneys",
    };
    const got = notificationFor(hostile);
    expect(got.title).toBe(PUSH_TITLE);
    expect(got.options.body).toBe("");
    const serialised = JSON.stringify(got);
    for (const leak of ["240", "Spinneys", "Groceries", "AED", "3 new"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it("says the same thing for no payload at all", () => {
    expect(notificationFor()).toEqual(notificationFor({ json: () => ({}) }));
  });

  // A constant tag collapses a burst into ONE notification. A per-push tag
  // would let the operating system stack them, and a stack of five IS the count
  // this design refuses to send — reassembled by the OS.
  it("uses one tag so a burst cannot become a count", () => {
    expect(notificationFor().options.tag).toBe(PUSH_TAG);
    expect(notificationFor({ a: 1 }).options.tag).toBe(notificationFor({ a: 2 }).options.tag);
    expect(notificationFor().options.renotify).toBe(false);
  });

  it("says nothing about money in its own constants", () => {
    expect(PUSH_TITLE).toBe("New activity");
  });
});
