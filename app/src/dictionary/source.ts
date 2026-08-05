import type { SqlDriver } from "@ledger/client/store/driver.ts";
import type { DictionarySubmitter } from "../screens/review/deps.ts";

export interface DictionaryEntry { pattern: string; match: "exact" | "contains"; category: string }
export interface DictionarySource extends DictionarySubmitter {
  sync(): Promise<void>;
  categoryFor(merchant: string): string | null;
  version(): bigint;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_dictionary_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version TEXT NOT NULL);
INSERT OR IGNORE INTO merchant_dictionary_meta(singleton, version) VALUES(1, '0');
CREATE TABLE IF NOT EXISTS merchant_dictionary (pattern TEXT NOT NULL, match TEXT NOT NULL, category TEXT NOT NULL, PRIMARY KEY(pattern, match, category));`;

export type DictionaryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export function sqliteDictionarySource(options: { db: SqlDriver; server: string; token(): string | null; submitter: DictionarySubmitter; fetch?: DictionaryFetch }): DictionarySource {
  options.db.exec(SCHEMA);
  const getVersion = options.db.prepare("SELECT version FROM merchant_dictionary_meta WHERE singleton = 1");
  const setVersion = options.db.prepare("UPDATE merchant_dictionary_meta SET version = ? WHERE singleton = 1");
  const insert = options.db.prepare("INSERT OR REPLACE INTO merchant_dictionary(pattern, match, category) VALUES(?, ?, ?)");
  const remove = options.db.prepare("DELETE FROM merchant_dictionary WHERE pattern = ? AND match = ? AND category = ?");
  const rows = options.db.prepare("SELECT pattern, match, category FROM merchant_dictionary ORDER BY CASE match WHEN 'exact' THEN 0 ELSE 1 END, length(pattern) DESC, pattern");
  const version = () => {
    const raw = (getVersion.all()[0] as { version?: unknown } | undefined)?.version;
    if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error("dictionary cursor is invalid");
    return BigInt(raw);
  };
  return {
    version,
    submit: (entry) => options.submitter.submit(entry),
    async sync() {
      const token = options.token(); if (token === null) throw new Error("sign in before syncing the dictionary");
      const response = await (options.fetch ?? fetch)(new URL(`/api/v1/dictionary?since=${version()}`, options.server), { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`dictionary sync failed: ${response.status}`);
      const body = await response.json() as { version?: unknown; entries?: unknown; removed?: unknown };
      if (typeof body.version !== "string" || !/^(0|[1-9][0-9]*)$/.test(body.version) || !Array.isArray(body.entries) || !Array.isArray(body.removed)) throw new Error("dictionary response is invalid");
      const decode = (value: unknown): DictionaryEntry => {
        const e = value as Partial<DictionaryEntry>;
        if (typeof e.pattern !== "string" || (e.match !== "exact" && e.match !== "contains") || typeof e.category !== "string") throw new Error("dictionary entry is invalid");
        return { pattern: e.pattern, match: e.match, category: e.category };
      };
      options.db.transaction(() => { for (const value of body.removed as unknown[]) { const e = decode(value); remove.run(e.pattern, e.match, e.category); } for (const value of body.entries as unknown[]) { const e = decode(value); insert.run(e.pattern, e.match, e.category); } setVersion.run(body.version); });
    },
    categoryFor(merchant) {
      const candidate = merchant.trim().toLocaleLowerCase("en-US");
      for (const raw of rows.all() as Record<string, unknown>[]) {
        const pattern = String(raw.pattern); const match = String(raw.match);
        if ((match === "exact" && candidate === pattern) || (match === "contains" && candidate.includes(pattern))) return String(raw.category);
      }
      return null;
    },
  };
}
