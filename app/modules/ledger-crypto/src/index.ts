/**
 * `ledger-crypto` — the Phase 2 at-rest-crypto **benchmark instrument**.
 *
 * # This is not a product path
 *
 * Phase 2 ships plaintext blobs. Nothing in this module is wired into sync, and
 * the only importer is `app/src/bench/`. It exists so Task 1 can measure the
 * cost of Phase 3's construction — one X25519 scalar multiplication, one
 * HKDF-SHA256 extract/expand and one AES-256-GCM open, per record — natively on
 * the floor device, against Phase 0's pure-JS control of 14.86 ms/blob. If you
 * are reaching for `openOne` from `client/src/wire/`, stop: Phase 3's swap point
 * is the open path in `client/src/wire/blob.ts`, and the framing-version
 * question (Decision 12) is not settled.
 *
 * # What `openOne`/`openBatch` return
 *
 * The **decrypted region, verbatim**: `[4-byte BE payloadLen][gzip payload]
 * [zero padding]`. This module does not gunzip and does not strip the length
 * prefix. Gunzip belongs to the platform seam (`app/src/platform/gzip.ts`),
 * whose entire reason to exist is a decompression cap that a native shortcut
 * here would bypass — and folding it in would make one timing measure two
 * things.
 *
 * # The construction, which `internal/v2/blob/encv2.go` defines
 *
 *	shared = X25519(recipientPriv, enc)
 *	salt   = enc ‖ recipientPub          // recipientPub = X25519(recipientPriv, basepoint)
 *	key    = HKDF-SHA256(ikm: shared, salt: salt, info: info, L: 32)
 *	plain  = AES-256-GCM.open(nonce, ciphertext, tag, key, aad: the EMBEDDED aad)
 *
 * `info` is `"ledger-phase2-encv2"` for this corpus (`blob.EncInfo`). Every
 * offset is derived from the frame's own `aadLen` and length; nothing is
 * hardcoded to the corpus's 1024-byte bucket.
 *
 * # Degradation when the native module is absent
 *
 * `requireOptionalNativeModule` returns `null` under `bun test`, in Expo Go, and
 * in any dev client built before this module existed. In that state
 * {@link isAvailable} returns `false` and **every other export throws
 * {@link LedgerCryptoUnavailable}**. None of them returns a plausible-looking
 * number: a fabricated `thermalState()` of `"nominal"` would make the whole
 * thermal protocol pass vacuously, and a fabricated `rssBytes()` of `0` would
 * turn Caveat 6 into a flat line that reads as a result.
 */

import { requireOptionalNativeModule } from "expo";

/**
 * The native surface, which is deliberately narrower than the exported one.
 *
 * `offsets` crosses as **bytes**, not as a `Uint32Array`. Expo's array
 * marshalling casts through `jsi::Object::getArray`, which requires a real JS
 * `Array`; a `Uint32Array` is not one, and in a Release build the mis-cast is
 * undefined behaviour rather than a clean throw. The wrappers below hand over a
 * zero-copy `Uint8Array` view of the same buffer, so the documented
 * `Uint32Array` signature survives at the API boundary without the measured
 * build resting on an unsupported cast.
 *
 * `OpenParams` is likewise flattened into positional arguments: an Expo `Record`
 * carrying `Data` fields is a less-travelled conversion path than a plain `Data`
 * argument, and this module has to compile correctly the first time on a box
 * that cannot build Swift.
 */
interface NativeLedgerCrypto {
  openOne(record: Uint8Array, recipientPriv: Uint8Array, info: Uint8Array): Uint8Array;
  openBatch(
    records: Uint8Array,
    offsetBytes: Uint8Array,
    recipientPriv: Uint8Array,
    info: Uint8Array,
  ): Promise<Uint8Array[]>;
  noopOne(record: Uint8Array): number;
  noopBatch(records: Uint8Array, offsetBytes: Uint8Array): Promise<Uint8Array[]>;
  rssBytes(): number;
  thermalState(): string;
  launchUptime(): number;
  nowUptime(): number;
}

const native = requireOptionalNativeModule<NativeLedgerCrypto>("LedgerCrypto");

/** The recipient's X25519 identity and the HKDF info string. */
export interface OpenParams {
  /** 32 bytes, X25519 private scalar. */
  recipientPriv: Uint8Array;
  /** HPKE-shaped info string; `"ledger-phase2-encv2"` for the Phase 2 corpus. */
  info: Uint8Array;
}

/**
 * Thrown by every export except {@link isAvailable} when the native module is
 * not in the running binary.
 *
 * It is a *named* error on purpose. The failure it reports is always the same
 * one — a JS-only reload against a dev client that predates the Swift — and a
 * generic `TypeError: null is not an object` sends the reader looking for a
 * bug in the bench screen instead of at the build.
 */
export class LedgerCryptoUnavailable extends Error {
  constructor(fn: string) {
    super(
      `ledger-crypto: the native module is not in this binary, so ${fn}() cannot run. ` +
        "A JS change needs no rebuild; a Swift change does: " +
        "bunx expo prebuild -p ios --clean && bunx eas build --profile development --platform ios",
    );
    this.name = "LedgerCryptoUnavailable";
  }
}

function required(fn: string): NativeLedgerCrypto {
  if (native === null) throw new LedgerCryptoUnavailable(fn);
  return native;
}

/**
 * A zero-copy byte view of the offsets array. See {@link NativeLedgerCrypto}
 * for why the native boundary takes bytes.
 */
function offsetBytes(offsets: Uint32Array): Uint8Array {
  return new Uint8Array(offsets.buffer, offsets.byteOffset, offsets.byteLength);
}

/**
 * Whether the native module is present. `false` means the dev client has not
 * been rebuilt since the Swift landed — nothing else in this module will work,
 * and it will say so rather than guess.
 */
export function isAvailable(): boolean {
  return native !== null;
}

/**
 * One framed v2 blob, **synchronously, on the JS thread**. Measurement arm
 * only — the production candidate is {@link openBatch}, and the contrast
 * between the two is the point.
 */
export function openOne(record: Uint8Array, p: OpenParams): Uint8Array {
  return required("openOne").openOne(record, p.recipientPriv, p.info);
}

/**
 * Many framed v2 blobs, on `DispatchQueue.global(qos: .userInitiated)`,
 * resolving on the main queue.
 *
 * `offsets` is a `Uint32Array` of length **N+1**: record `i` is
 * `records[offsets[i] .. offsets[i+1])`. Explicit offsets rather than a fixed
 * record width, because real blobs are bucketed at seven sizes — a
 * `(records, recordSize)` signature is one production could never call, which
 * would make "the production candidate" arm a measurement of an API that does
 * not exist.
 *
 * The native side validates that `offsets` is strictly increasing, that
 * `offsets[0] === 0` and that `offsets[N] === records.length`, and rejects with
 * a message naming the failing index. The check lives there and not here for
 * two reasons: these offsets index a raw buffer, so an unchecked one is a
 * memory-safety bug rather than a wrong answer; and both batch arms then pay
 * the identical validation cost, so it cancels out of the comparison instead of
 * landing on the JS thread of one arm only.
 */
export function openBatch(
  records: Uint8Array,
  offsets: Uint32Array,
  p: OpenParams,
): Promise<Uint8Array[]> {
  return required("openBatch").openBatch(records, offsetBytes(offsets), p.recipientPriv, p.info);
}

/**
 * A native call that does no crypto, per record. Isolates the JSI crossing and
 * argument marshalling from the cost of opening a blob: without it, `openOne`
 * conflates the two and a slow result is unattributable.
 *
 * Returns `record.length + record[0]`, because the native side has to *touch*
 * the argument for the marshalling to have actually happened.
 */
export function noopOne(record: Uint8Array): number {
  return required("noopOne").noopOne(record);
}

/**
 * {@link openBatch}'s marshalling twin: same call shape, same number of
 * returned arrays, same byte length each, no crypto.
 *
 * **Return marshalling is itself an unmeasured cost and this is the only arm
 * that measures it.** A `Promise<Uint8Array[]>` at N = 3,683 is 3,683
 * `ArrayBuffer` constructions and 3,683 memcpys on the JS thread, none of which
 * appear in a timing that stops at the native boundary.
 */
export function noopBatch(records: Uint8Array, offsets: Uint32Array): Promise<Uint8Array[]> {
  return required("noopBatch").noopBatch(records, offsetBytes(offsets));
}

/**
 * The process's `phys_footprint` in bytes, via `task_info(TASK_VM_INFO)`.
 *
 * `phys_footprint`, **not** `resident_size`: the footprint is the metric jetsam
 * actually kills on, and `resident_size` can sit well under it while the
 * process is one allocation from death. This is the real instrument for
 * `RESULTS.md` Caveat 6, and Bun's `process.memoryUsage().rss` must never be
 * substituted for it — that number has a ~270 MB floor which swamps the ~32 MB
 * this corpus is expected to move.
 */
export function rssBytes(): number {
  return required("rssBytes").rssBytes();
}

/**
 * `ProcessInfo.thermalState` as one of `"nominal" | "fair" | "serious" |
 * "critical"`, or `"unknown"` for an OS enum case newer than this build.
 *
 * Typed as `string` rather than a union because the `"unknown"` case is real:
 * narrowing it away would invite a caller to assume the four known values are
 * exhaustive. The thermal protocol discards any pass that does not *start* at
 * `"nominal"`, so an unrecognised state fails closed.
 */
export function thermalState(): string {
  return required("thermalState").thermalState();
}

/**
 * `ProcessInfo.systemUptime` captured as early as the Expo module system
 * allows — in this module's `OnCreate`.
 *
 * **It under-reads, and by how much matters.** `OnCreate` runs when the module
 * registry instantiates the module, which is after `exec`, after dyld has
 * mapped and bound every framework, after
 * `application(_:didFinishLaunchingWithOptions:)` has begun, and after the
 * springboard's launch animation has started. On the far side the paired
 * `nowUptime()` reading is taken at a React commit, before the GPU has painted
 * a pixel.
 *
 * So this is **not** the `T_paint` criterion. `T_paint` is defined against a
 * 240 fps screen recording measured tap-to-first-legible-number; this
 * instrument is reported alongside it as a decomposition, and the delta between
 * the two is the launch-and-present overhead — a finding, not a sign that the
 * instrument is broken.
 */
export function launchUptime(): number {
  return required("launchUptime").launchUptime();
}

/**
 * The current reading of the same monotonic clock as {@link launchUptime}. It
 * does not advance while the device is asleep, which is right for a launch
 * measurement and wrong for anything spanning a backgrounding.
 */
export function nowUptime(): number {
  return required("nowUptime").nowUptime();
}
