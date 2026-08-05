/** The one product server origin compiled into an Expo build. */
export function serverURL(value: string | undefined = process.env.EXPO_PUBLIC_LEDGER_SERVER): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("EXPO_PUBLIC_LEDGER_SERVER is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("EXPO_PUBLIC_LEDGER_SERVER must be an absolute HTTPS origin");
  }
  if (parsed.protocol !== "https:") throw new Error("EXPO_PUBLIC_LEDGER_SERVER must use HTTPS");
  if (parsed.username !== "" || parsed.password !== "") throw new Error("EXPO_PUBLIC_LEDGER_SERVER must not contain credentials");
  if (parsed.hash !== "") throw new Error("EXPO_PUBLIC_LEDGER_SERVER must not contain a fragment");
  if (parsed.pathname !== "/" || parsed.search !== "") {
    throw new Error("EXPO_PUBLIC_LEDGER_SERVER must be an origin without a path or query");
  }
  return parsed.origin;
}
