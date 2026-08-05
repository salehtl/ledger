export type RawRow = Record<string, string>;

/** RFC 4180 parser with escaped quotes, embedded commas and embedded newlines. */
export function parseCSV(input: string): { headers: string[]; rows: RawRow[] } {
  const records: string[][] = [];
  let record: string[] = [], field = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { record.push(field); field = ""; }
    else if (ch === "\n") { record.push(field.replace(/\r$/, "")); records.push(record); record = []; field = ""; }
    else field += ch;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field");
  if (field !== "" || record.length > 0) { record.push(field.replace(/\r$/, "")); records.push(record); }
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0]!.map((h) => h.trim());
  if (new Set(headers).size !== headers.length) throw new Error("CSV has duplicate headers");
  return { headers, rows: records.slice(1).map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]))) };
}
