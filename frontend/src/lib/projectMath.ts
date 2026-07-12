/** Pure helpers for project budget display. All money is integer fils. */
export function projectRemaining(budgetFils: number | null, netFils: number): number | null {
  return budgetFils == null ? null : budgetFils - netFils;
}
export function projectPctUsed(budgetFils: number | null, netFils: number): number | null {
  if (budgetFils == null || budgetFils <= 0) return null;
  return netFils / budgetFils;
}
export function isOverBudget(budgetFils: number | null, netFils: number): boolean {
  return budgetFils != null && netFils > budgetFils;
}
