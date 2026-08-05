import type { DictionarySubmitter } from "../screens/review/deps.ts";

export const DICTIONARY_CONSENT =
  "If you share this merchant and category, the server keeps a keyed pseudonym while fewer than three different users have shared the same entry. In a small closed beta, the operator can try its short user list against that pseudonym, so it may still be linkable to you while it exists. The identifier is deleted as soon as the entry reaches three users, and stale identifiers expire on the server's retention schedule. Sharing is optional and off by default.";

export type DictionaryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function dictionarySubmitter(server: string, token: () => string | null, request: DictionaryFetch = fetch): DictionarySubmitter {
  return { async submit(entry) {
    const held = token(); if (!held) throw new Error("sign in before sharing a dictionary entry");
    const response = await request(new URL("/api/v1/dictionary/submissions", server), { method: "POST", headers: { authorization: `Bearer ${held}`, "content-type": "application/json" }, body: JSON.stringify(entry) });
    if (response.status === 204) return;
    let detail = ""; try { const body = await response.json() as { detail?: unknown }; if (typeof body.detail === "string") detail = body.detail; } catch { /* optional error body */ }
    throw Object.assign(new Error(detail || `dictionary submission failed: ${response.status}`), { status: response.status });
  } };
}
