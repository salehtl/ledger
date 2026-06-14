import { describe, it, expect, vi, afterEach } from "vitest";
import { getJSON, postJSON } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("client", () => {
  it("getJSON parses the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ income: 5 }), { status: 200 })));
    expect(await getJSON<{ income: number }>("/api/summary")).toEqual({ income: 5 });
  });

  it("postJSON throws on non-2xx with the server message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "bad" }), { status: 400 })));
    await expect(postJSON("/api/rules", {})).rejects.toThrow("bad");
  });
});
