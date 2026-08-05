import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApiError } from "@ledger/client/net/client.ts";
import { CONFLICT_COPY, deletionNotice, trustBasis, trustRequest, type QuarantineCursor, type QuarantineItem, type ReingestReport } from "../../lib/quarantine.ts";
import type { QuarantineSource } from "./source.ts";

export interface QuarantineScreenProps {
  source: QuarantineSource;
  now?: () => number;
}

export function QuarantineScreen({ source, now = Date.now }: QuarantineScreenProps) {
  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [cursor, setCursor] = useState<QuarantineCursor>({});
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async (next: QuarantineCursor = {}) => {
    setBusy(true);
    try {
      const page = await source.list(next);
      const firstPage = next.after === undefined && next.afterId === undefined && next.removedAfter === undefined && next.removedAfterId === undefined;
      setItems((before) => firstPage ? page.items : [...before, ...page.items]);
      setCursor(page.next);
      setComplete(page.complete);
    } catch {
      setMessage("Could not load held mail. Try again.");
    } finally {
      setBusy(false);
    }
  }, [source]);

  useEffect(() => { void load(); }, [load]);

  const confirm = async (item: QuarantineItem) => {
    const request = trustRequest(item);
    if (request === null) return;
    setBusy(true);
    setMessage("");
    let latest: ReingestReport | null = null;
    try {
      const result = await source.confirm(request.domain, request.scope, (report) => {
        latest = report;
        setMessage(`Re-reading mail: ${report.examined} checked, ${report.appended} added${report.incomplete ? "; continuing…" : ""}`);
      });
      const report = result.reingest ?? latest;
      setMessage(report === null ? "Sender trusted. Re-ingest is unavailable." : `${report.appended} transaction${report.appended === 1 ? "" : "s"} added; ${report.failed} failed.`);
      await load();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "";
      setMessage(code === "forwarder_domain" || code === "origin_unproven" ? CONFLICT_COPY[code] : "Could not trust this sender. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return <ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.title}>Held mail</Text>
    <Text style={styles.intro}>These messages stay outside your ledger until you trust a verified sender.</Text>
    {message !== "" && <Text accessibilityRole="alert" style={styles.message}>{message}</Text>}
    {items.map((item) => {
      const basis = trustBasis(item);
      const expiry = deletionNotice(item, now());
      return <View key={item.id} style={styles.card}>
        <Text style={basis.authenticated ? styles.domain : styles.unauthenticated}>{basis.label}</Text>
        <Text style={styles.meta}>Verification: {basis.source}</Text>
        <Text style={styles.meta}>DKIM: {item.dkim} · ARC: {item.arc}</Text>
        <Text style={styles.meta}>Arrived {item.receivedAt}</Text>
        {expiry !== null && <Text style={styles.warning}>{expiry}</Text>}
        <Pressable accessibilityRole="button" disabled={!basis.authenticated || busy} onPress={() => void confirm(item)} style={styles.button}>
          <Text style={styles.buttonText}>{basis.authenticated ? "Trust this sender" : "Cannot trust unauthenticated mail"}</Text>
        </Pressable>
      </View>;
    })}
    {!complete && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void load(cursor)} style={styles.button}><Text style={styles.buttonText}>Load more</Text></Pressable>}
    {busy && <ActivityIndicator accessibilityLabel="Loading held mail" />}
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 14 }, title: { fontSize: 28, fontWeight: "700" }, intro: { fontSize: 16, lineHeight: 22 },
  message: { fontSize: 16, padding: 12, backgroundColor: "#f0eadc" }, card: { gap: 8, padding: 16, borderWidth: 1, borderColor: "#b8b0a0" },
  domain: { fontSize: 18, fontWeight: "700" }, unauthenticated: { fontSize: 18, fontWeight: "800", color: "#9b1c1c" },
  meta: { fontSize: 14 }, warning: { fontSize: 15, fontWeight: "700", color: "#9b1c1c" },
  button: { minHeight: 44, paddingHorizontal: 14, justifyContent: "center", backgroundColor: "#181818" }, buttonText: { color: "white", textAlign: "center", fontWeight: "700" },
});
