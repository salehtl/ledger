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

import type { Project } from "../api/types";

/** True when postedAt (RFC3339) falls inside the project's date window.
 *  Bounds are inclusive YYYY-MM-DD dates; an empty bound is open-ended. */
export function projectCoversDate(p: Project, postedAt: string): boolean {
  const day = postedAt.slice(0, 10);
  if (p.starts_on && day < p.starts_on) return false;
  if (p.ends_on && day > p.ends_on) return false;
  return true;
}

export interface RankedProject extends Project {
  /** The transaction's date falls inside this project's window. */
  suggested: boolean;
}

/** Active projects ordered for the review flow: date-window matches first
 *  (marked `suggested`), the rest in their given order, completed dropped. */
export function orderProjectsForReview(projects: Project[], postedAt: string): RankedProject[] {
  const active = projects.filter((p) => p.status === "active");
  const ranked = active.map((p) => ({ ...p, suggested: projectCoversDate(p, postedAt) }));
  return [...ranked.filter((p) => p.suggested), ...ranked.filter((p) => !p.suggested)];
}
