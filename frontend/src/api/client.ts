import type { Account, CategoryUsage, RatesResponse, SweepResult } from "./types";

async function parseOrThrow(res: Response) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(body?.error ?? `request failed: ${res.status}`);
  }
  return body;
}

export async function getJSON<T>(url: string): Promise<T> {
  return parseOrThrow(await fetch(url));
}

export async function postJSON<T = unknown>(url: string, body: unknown, method = "POST"): Promise<T> {
  return parseOrThrow(await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function del(url: string): Promise<void> {
  await parseOrThrow(await fetch(url, { method: "DELETE" }));
}

export function getCategoryUsage(id: number): Promise<CategoryUsage> {
  return getJSON<CategoryUsage>(`/api/categories/${id}/usage`);
}

export function deleteCategory(id: number): Promise<void> {
  return del(`/api/categories/${id}`);
}

export function getRates(): Promise<RatesResponse> {
  return getJSON<RatesResponse>("/api/rates");
}

export async function putRate(currency: string, rate: number): Promise<void> {
  await postJSON(`/api/rates/${currency}`, { rate }, "PUT");
}

export function deleteRate(currency: string): Promise<void> {
  return del(`/api/rates/${currency}`);
}

export function getAccounts(): Promise<Account[]> {
  return getJSON("/api/accounts");
}

export function createAccount(a: { name: string; last4: string; bank?: string }): Promise<{ id: number }> {
  return postJSON("/api/accounts", a);
}

export function deleteAccount(id: number): Promise<void> {
  return del(`/api/accounts/${id}`);
}

export function sweepTransfers(): Promise<SweepResult> {
  return postJSON("/api/transfers/sweep", {});
}
