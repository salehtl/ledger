/** Plain label for an AI usage row's call path. Unknown paths pass through. */
export function usagePathLabel(path: string): string {
  return path === "txn_check" ? "email check" : path;
}
