/**
 * `GET /api/v1/address` — this account's inbound address, minted server-side on
 * first read.
 *
 * One place that knows the endpoint, decodes the response and classifies its
 * errors, because a second copy would drift on the error shape and **the error
 * shape is the behaviour**: `boot.ts` keys the local wipe on `410` AND
 * `account_deleted` and the sign-out on a bare `401`, both read off the thrown
 * error. The native port's inline version threw an error with a hard-coded
 * `code: ""`, so a `410 account_deleted` from this endpoint matched neither arm
 * and a device whose account had been deleted elsewhere reported a fatal open
 * with every local row still on disk. {@link ApiError} carries the server's own
 * code, so that path resolves.
 *
 * `Client` does not wrap this route and this does not reach into it: `request`
 * is private, and widening it to make one GET reachable would put every future
 * ad-hoc call on the protocol client's surface. The bearer token is read from
 * the same place `Client` reads it.
 *
 * Deliberately narrow. The response also carries `created_at`, `rotates_from`
 * and `grace_until`; `rotates_from`/`grace_until` are a PAIR with a real
 * subtlety behind them (the server names only ONE predecessor, so a user who
 * rotated twice inside the grace window has an older address still accepting
 * that the response does not mention). Task 7's address screen is what needs
 * them, and it should port `app/src/lib/address.ts`'s decoder rather than
 * widen this.
 */

import { ApiError, NetworkError } from "@ledger/client/net/client";

export interface AddressReader {
  sessionToken: string | null;
}

/**
 * The address string, or null when the server has none to give.
 *
 * Throws {@link ApiError} carrying the server's own `error` code, and
 * {@link NetworkError} when there was no HTTP answer at all.
 */
export async function readAddress(
  client: AddressReader,
  opts: { server?: string; fetch?: typeof fetch } = {},
): Promise<string | null> {
  const token = client.sessionToken;
  if (token === null || token === "") return null;
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const path = `${opts.server ?? ""}/api/v1/address`;

  let res: Response;
  try {
    res = await doFetch(path, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    throw new NetworkError(`GET /api/v1/address: ${err instanceof Error ? err.message : String(err)}`, err);
  }

  const text = await res.text();
  if (!res.ok) {
    let code = "";
    let detail = "";
    try {
      const e = JSON.parse(text) as { error?: string; detail?: string };
      code = e.error ?? "";
      detail = e.detail ?? "";
    } catch {
      detail = text.slice(0, 200);
    }
    throw new ApiError(res.status, code, detail, `GET /api/v1/address: ${res.status} ${code}`);
  }

  let body: { address?: unknown };
  try {
    body = JSON.parse(text) as { address?: unknown };
  } catch {
    throw new ApiError(res.status, "", text.slice(0, 200), "GET /api/v1/address: unreadable response");
  }
  return typeof body.address === "string" && body.address !== "" ? body.address : null;
}
