export type RateFormResult =
  | { ok: true; currency: string; rate: number }
  | { ok: false; error: string };

/** Validate the Settings add/edit-rate form: 3-letter code (not AED), positive rate. */
export function parseRateForm(code: string, rate: string): RateFormResult {
  const currency = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, error: "Currency must be a 3-letter code." };
  }
  if (currency === "AED") {
    return { ok: false, error: "AED is the base currency." };
  }
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    return { ok: false, error: "Enter a rate greater than zero." };
  }
  return { ok: true, currency, rate: r };
}
