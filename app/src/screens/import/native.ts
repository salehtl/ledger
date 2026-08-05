import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

export interface PickedCSV { name: string; text: string }

/** Native file boundary kept outside the pure workflow and render tests. */
export async function pickCSVDocument(): Promise<PickedCSV | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: ["text/csv", "text/comma-separated-values"], copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset === undefined) return null;
  return { name: asset.name, text: await new File(asset.uri).text() };
}
