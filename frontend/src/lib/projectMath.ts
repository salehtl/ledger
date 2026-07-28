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

/** Today as "YYYY-MM-DD" in local time — the reference point for `projectPace`. */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Fraction of a project's date window elapsed as of `today` (0..1), or null
 * when no linear pace can be measured.
 *
 * Null unless the project has *both* bounds: an end date is what makes a pace
 * line meaningful (without it the project simply runs until it's done), and a
 * start is what the elapsed fraction is measured from. A zero-length or
 * inverted window is also null — there is no ramp to sit on. Callers hand the
 * result to `ProgressBar`'s `pace`, where null means "no marker, and never the
 * over-pace state" rather than 0.
 *
 * Bounds are inclusive days, so a one-day project reads 1 on its only day: the
 * window spans `end - start + 1` days, not `end - start`.
 */
export function projectPace(
  p: Pick<Project, "starts_on" | "ends_on">,
  today: string,
): number | null {
  if (!p.starts_on || !p.ends_on) return null;
  const start = Date.parse(`${p.starts_on}T00:00:00Z`);
  const end = Date.parse(`${p.ends_on}T00:00:00Z`);
  const now = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(now)) return null;
  const DAY = 86_400_000;
  const span = end - start + DAY;
  if (span <= 0) return null;
  return Math.min(1, Math.max(0, (now - start + DAY) / span));
}

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
