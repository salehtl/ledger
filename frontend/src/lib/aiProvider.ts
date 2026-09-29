/** Display name and key env var for the server's categorization provider. */
export function aiProviderInfo(p?: string): { name: string; envVar: string } {
  return p === "typesafe"
    ? { name: "TypeSafe", envVar: "LEDGER_TYPESAFE_API_KEY" }
    : { name: "Anthropic", envVar: "LEDGER_AI_API_KEY" };
}
