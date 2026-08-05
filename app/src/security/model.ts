import type { ClientState } from "@ledger/client/store/store.ts";
import { fromBase64, toHex } from "../platform/bytes.ts";
import { sha256 } from "../platform/hash.ts";

export const PLAINTEXT_DISCLOSURE =
  "This beta stores your ledger unencrypted. The operator can read it. What happens to existing beta history at the encrypted Phase 3 cutover has not been decided; this build must not promise migration or deletion.";

export const DORMANT_NOTICE = "Not yet active — your data is not encrypted at rest in this beta.";

export interface DeviceIdentity { writerId: string; fingerprint: string; }

function base64urlBytes(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(standard + "=".repeat((4 - standard.length % 4) % 4));
}

/** The real Ed25519 public-key fingerprint for this install, never private material. */
export function deviceIdentity(state: Pick<ClientState, "writerId" | "writers">): DeviceIdentity | null {
  if (state.writerId === null) return null;
  const key = state.writers.get(state.writerId); if (key === undefined) return null;
  const pub = base64urlBytes(key.x); if (pub.length !== 32) throw new Error(`writer public key is ${pub.length} bytes, want 32`);
  const hex = toHex(sha256(pub));
  return { writerId: state.writerId, fingerprint: hex.match(/.{1,4}/g)!.join(" ") };
}

export interface SecuritySlot { id: "phrase" | "passphrase" | "verify"; title: string; explanation: string; }
export const SECURITY_SLOTS: readonly SecuritySlot[] = [
  { id: "phrase", title: "Recovery phrase", explanation: "Phase 3 will let a recovery phrase restore encryption keys. No phrase exists in this beta, so there is nothing safe to display or save yet." },
  { id: "passphrase", title: "Recovery passphrase (optional)", explanation: "Phase 3 may let you protect a recovery copy with a passphrase. It is unavailable now, and no passphrase entered here would protect this plaintext ledger." },
  { id: "verify", title: "Verify another device", explanation: "Phase 3 will derive a comparison code on each device from key history and writer checkpoints. This beta does not derive that code, so it cannot honestly verify another device yet." },
] as const;
