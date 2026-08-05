import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { ImportMap } from "@ledger/client/importer/map.ts";
import { useTheme } from "../../app/Theme.tsx";
import { commitImport, planImport, previewCSV, type ImportIO } from "./workflow.ts";
import type { PickedCSV } from "./native.ts";

export interface ImportScreenProps { pick: () => Promise<PickedCSV | null>; io: ImportIO; onDone?: () => void }

export function ImportScreen({ pick, io, onDone }: ImportScreenProps) {
  const t = useTheme();
  const [file, setFile] = useState<PickedCSV | null>(null);
  const [map, setMap] = useState<ImportMap | null>(null);
  const [message, setMessage] = useState("");
  const [aliases, setAliases] = useState("");
  const preview = useMemo(() => file && map ? previewCSV(file.text, map) : null, [file, map]);
  const mappingFields: readonly ("date" | "description" | "amount" | "debit" | "credit" | "category")[] =
    map?.directionMode === "columns" ? ["date", "description", "debit", "credit", "category"] : ["date", "description", "amount", "category"];
  const choose = async () => {
    const selected = await pick(); if (!selected) return;
    const headers = previewCSV(selected.text, { columns: { date: "", description: "", amount: "" }, dateFormat: "2006-01-02", currency: "AED", directionMode: "sign" }).headers;
    const find = (names: string[]) => headers.find((h) => names.includes(h.toLowerCase())) ?? headers[0] ?? "";
    const category = headers.find((h) => h.toLowerCase() === "category");
    setFile(selected); setMap({ columns: { date: find(["date", "posted date"]), description: find(["description", "merchant", "memo"]), amount: find(["amount"]), ...(category === undefined ? {} : { category }) }, dateFormat: "2006-01-02", currency: "AED", directionMode: "sign" });
  };
  const cycle = (field: "date" | "description" | "amount" | "debit" | "credit" | "category") => {
    if (!preview || !map || preview.headers.length === 0) return;
    const current = map.columns[field] ?? ""; const index = preview.headers.indexOf(current);
    setMap({ ...map, columns: { ...map.columns, [field]: preview.headers[(index + 1) % preview.headers.length] } });
  };
  const run = async () => {
    if (!file || !map) return; const plan = planImport(file.text, map, io.newId);
    if (plan.specs.length === 0) { setMessage("No valid rows to import."); return; }
    setMessage(`Importing 0 of ${plan.specs.length} rows…`);
    await commitImport(plan, {
      ...io,
      onProgress: (completed, total) => {
        io.onProgress?.(completed, total);
        setMessage(`Importing ${completed} of ${total} rows…`);
      },
    });
    setMessage(`${plan.specs.length} rows queued${plan.errors.length ? `; ${plan.errors.length} skipped` : ""}.`); onDone?.();
  };
  return <ScrollView style={{ flex: 1, backgroundColor: t.colors.bg }} contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }}>
    <Text style={[t.type.title, { color: t.colors.text }]}>Import statement</Text>
    <Pressable accessibilityRole="button" onPress={() => void choose()}><Text style={[t.type.body, { color: t.colors.accent }]}>{file ? file.name : "Choose CSV file"}</Text></Pressable>
    {preview && map ? <>
      <Text style={[t.type.heading, { color: t.colors.text }]}>Map columns</Text>
      {mappingFields.map((field) => <Pressable key={field} accessibilityRole="button" onPress={() => cycle(field)} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[t.type.body, { color: t.colors.text }]}>{field}: {map.columns[field] || "Not mapped"}</Text></Pressable>)}
      <Pressable accessibilityRole="button" onPress={() => setMap({ ...map, dateFormat: map.dateFormat === "2006-01-02" ? "02/01/2006" : map.dateFormat === "02/01/2006" ? "01/02/2006" : "2006-01-02" })}><Text style={[t.type.body, { color: t.colors.accent }]}>Date format: {map.dateFormat}</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => setMap({ ...map, directionMode: map.directionMode === "sign" ? "columns" : "sign", columns: { ...map.columns, debit: map.columns.debit ?? preview.headers[0] ?? "", credit: map.columns.credit ?? preview.headers[0] ?? "" } })}><Text style={[t.type.body, { color: t.colors.accent }]}>Direction: {map.directionMode === "sign" ? "signed amount" : "debit and credit columns"}</Text></Pressable>
      <TextInput accessibilityLabel="Import currency" autoCapitalize="characters" value={map.currency} onChangeText={(currency) => setMap({ ...map, currency: currency.toUpperCase() })} style={[t.type.input, { color: t.colors.text, backgroundColor: t.colors.surface, minHeight: 44, paddingHorizontal: t.space.md }]} />
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: map.skipZeroAmounts === true }} onPress={() => setMap({ ...map, skipZeroAmounts: map.skipZeroAmounts !== true })}><Text style={[t.type.body, { color: t.colors.text }]}>Skip zero amounts: {map.skipZeroAmounts === true ? "Yes" : "No"}</Text></Pressable>
      <TextInput accessibilityLabel="Category aliases" placeholder="Food=Groceries, Fuel=Transport" value={aliases} onChangeText={(value) => { setAliases(value); const categories = Object.fromEntries(value.split(",").map((p) => p.split("=").map((x) => x.trim())).filter((p) => p.length === 2 && p[0] !== "") as [string,string][]); setMap({ ...map, categories }); }} style={[t.type.input, { color: t.colors.text, backgroundColor: t.colors.surface, minHeight: 44, paddingHorizontal: t.space.md }]} />
      <Text style={[t.type.heading, { color: t.colors.text }]}>Preview ({preview.raw.length} rows)</Text>
      {preview.results.map((result, i) => <View key={i} style={{ paddingVertical: t.space.sm }}><Text style={[t.type.label, { color: result.ok ? t.colors.text : t.colors.danger }]}>{result.ok ? `${result.row.postedAt.slice(0, 10)} · ${result.row.merchantRaw} · ${result.row.amountMinor} ${result.row.currency}` : `Row ${result.rowIndex}: ${result.error}`}</Text></View>)}
      <Pressable accessibilityRole="button" onPress={() => void run()} style={{ minHeight: 44, justifyContent: "center", backgroundColor: t.colors.accent, paddingHorizontal: t.space.md }}><Text style={[t.type.body, { color: t.colors.bg }]}>Import</Text></Pressable>
    </> : null}
    {message ? <Text accessibilityRole="alert" style={[t.type.body, { color: t.colors.textMuted }]}>{message}</Text> : null}
  </ScrollView>;
}
