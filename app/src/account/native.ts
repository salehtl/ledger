import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { ExportFileIO } from "./export.ts";

export function nativeExportIO(): ExportFileIO {
  return {
    open(name) { const file = new File(Paths.cache, name); file.create({ overwrite: true, intermediates: true }); const handle = file.open(); return { uri: file.uri, write: (bytes) => handle.writeBytes(bytes), close: () => handle.close() }; },
    async share(uri, format) { if (!await Sharing.isAvailableAsync()) throw new Error("sharing is not available on this device"); await Sharing.shareAsync(uri, { mimeType: format === "csv" ? "text/csv" : "application/json", UTI: format === "csv" ? "public.comma-separated-values-text" : "public.json", dialogTitle: "Export ledger" }); },
  };
}
