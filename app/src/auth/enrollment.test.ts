/**
 * Device enrolment: idempotency, the failures, and the sentences.
 *
 * The mounted proof that any of this is REACHED lives in
 * `app/Enrollment.rn-test.tsx` — this file only pins the behaviour once it is.
 * That division is deliberate: this defect existed because `Client.enroll` was
 * correct, tested and called by nothing.
 */

import { describe, expect, test } from "bun:test";

import { SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import type { SecretStore } from "@ledger/client/store/store.ts";

import {
  EnrollmentError,
  ensureDeviceWriter,
  enrollmentCopy,
  enrollmentFailureCopy,
  isEnrollmentError,
  type EnrollmentKind,
  type RosterEntry,
} from "./enrollment.ts";
import { SECRET_WRITER_ID } from "./keys.ts";

const PUB_A = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // 32 bytes, base64url

/** Standard base64 of the same bytes `PUB_A` names, as the API returns it. */
const PUB_A_STD = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const PUB_B_STD = "f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/f38=";

function secrets(initial: Iterable<readonly [string, string]> = []): SecretStore & { dump(): Map<string, string> } {
  const map = new Map<string, string>(initial);
  return {
    get: (name) => map.get(name) ?? null,
    set: (name, value) => {
      if (value === null) map.delete(name);
      else map.set(name, value);
    },
    dump: () => map,
  };
}

interface Rig {
  rosterCalls: number;
  enrolled: string[];
  selected: string[];
}

function rig(
  roster: readonly RosterEntry[],
  over: { enroll?: (id: string) => Promise<void>; roster?: () => Promise<readonly RosterEntry[]> } = {},
) {
  const log: Rig = { rosterCalls: 0, enrolled: [], selected: [] };
  const client = {
    roster: async () => {
      log.rosterCalls++;
      return over.roster === undefined ? roster : await over.roster();
    },
    enroll: async (id: string) => {
      if (over.enroll !== undefined) {
        await over.enroll(id);
        return;
      }
      log.enrolled.push(id);
    },
    useWriter: (id: string) => {
      log.selected.push(id);
    },
  };
  return { log, client };
}

const entry = (writer_id: string, pubkey?: string, revoked_at: string | null = null): RosterEntry => ({
  writer_id,
  kind: "device",
  revoked_at,
  ...(pubkey === undefined ? {} : { pubkey }),
});

describe("first enrolment", () => {
  test("mints one id, persists it before use, and registers it", async () => {
    const s = secrets();
    const { log, client } = rig([]);
    const out = await ensureDeviceWriter({
      secrets: s,
      state: () => ({ writerId: null, writers: new Map() }),
      client,
      mint: () => "phone-1",
    });
    expect(out).toEqual({ status: "enrolled", writerId: "phone-1" });
    expect(log.enrolled).toEqual(["phone-1"]);
    // The id lands where `account/deletion.ts` and `account/address.ts` read it.
    expect(s.get(SECRET_WRITER_ID)).toBe("phone-1");
  });

  test("a device already authoring as its writer makes no network call at all", async () => {
    const s = secrets([
      [SECRET_WRITER_ID, "phone-1"],
      [`${SECRET_WRITER}phone-1`, "seed"],
    ]);
    const { log, client } = rig([entry("phone-1", PUB_A_STD)]);
    const out = await ensureDeviceWriter({
      secrets: s,
      state: () => ({ writerId: "phone-1", writers: new Map([["phone-1", { x: PUB_A }]]) }),
      client,
      mint: () => {
        throw new Error("must not mint over a held id");
      },
    });
    expect(out).toEqual({ status: "already", writerId: "phone-1" });
    expect(log.rosterCalls).toBe(0);
    expect(log.enrolled).toEqual([]);
  });

  /**
   * The property the whole module exists for. Two of whatever partitions —
   * here, two full runs — because one run cannot distinguish "enrols once"
   * from "enrols".
   */
  test("running it four times over one device enrols exactly one writer", async () => {
    const s = secrets();
    const registry: RosterEntry[] = [];
    let minted = 0;
    const client = {
      roster: async () => registry,
      enroll: async (id: string) => {
        if (registry.some((w) => w.writer_id === id)) throw Object.assign(new Error("exists"), { status: 403, code: "registration_rejected" });
        registry.push(entry(id, PUB_A_STD));
      },
      useWriter: () => {},
    };
    // Local state follows the client's: it holds the key once generated, and
    // `writerId` is set by a successful `enroll`.
    let writerId: string | null = null;
    const writers = new Map<string, { x: string }>();
    const deps = {
      secrets: s,
      state: () => ({ writerId, writers }),
      client: {
        ...client,
        enroll: async (id: string) => {
          await client.enroll(id);
          writers.set(id, { x: PUB_A });
          s.set(`${SECRET_WRITER}${id}`, "seed");
          writerId = id;
        },
      },
      mint: () => `phone-${String(++minted)}`,
    };
    for (let i = 0; i < 4; i++) await ensureDeviceWriter(deps);
    expect(registry.map((w) => w.writer_id)).toEqual(["phone-1"]);
    expect(minted).toBe(1);
  });
});

describe("a retry that the server already accepted", () => {
  /**
   * The window between the server's `204` and `Client.enroll`'s `commit()`.
   * Re-registering would be a permanent `403 registration_rejected`
   * (`auth.ErrWriterExists`), so the roster is consulted and the writer
   * adopted instead.
   */
  test("adopts a writer the roster already names rather than registering again", async () => {
    const s = secrets([
      [SECRET_WRITER_ID, "phone-1"],
      [`${SECRET_WRITER}phone-1`, "seed"],
    ]);
    const { log, client } = rig([entry("phone-1", PUB_A_STD)]);
    const out = await ensureDeviceWriter({
      secrets: s,
      state: () => ({ writerId: null, writers: new Map([["phone-1", { x: PUB_A }]]) }),
      client,
      mint: () => "must-not-mint",
    });
    expect(out).toEqual({ status: "adopted", writerId: "phone-1" });
    expect(log.selected).toEqual(["phone-1"]);
    expect(log.enrolled).toEqual([]);
  });

  test("another device's writers in the roster are not adopted", async () => {
    const s = secrets([[SECRET_WRITER_ID, "phone-1"]]);
    const { log, client } = rig([entry("laptop", PUB_B_STD), entry("ingest")]);
    await ensureDeviceWriter({
      secrets: s,
      state: () => ({ writerId: null, writers: new Map() }),
      client,
      mint: () => "must-not-mint",
    });
    expect(log.selected).toEqual([]);
    expect(log.enrolled).toEqual(["phone-1"]);
  });

  test("a roster row whose public key is not this device's is refused, not adopted", async () => {
    const s = secrets([[SECRET_WRITER_ID, "phone-1"]]);
    const { log, client } = rig([entry("phone-1", PUB_B_STD)]);
    const err = await ensureDeviceWriter({
      secrets: s,
      state: () => ({ writerId: null, writers: new Map([["phone-1", { x: PUB_A }]]) }),
      client,
      mint: () => "must-not-mint",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isEnrollmentError(err)).toBe(true);
    expect((err as EnrollmentError).enrollmentKind).toBe("key_lost");
    expect(log.selected).toEqual([]);
    expect(log.enrolled).toEqual([]);
  });

  test("a roster row for a writer whose key this device has lost is refused", async () => {
    const s = secrets([[SECRET_WRITER_ID, "phone-1"]]);
    const { log, client } = rig([entry("phone-1", PUB_A_STD)]);
    const err = await ensureDeviceWriter({
      secrets: s,
      state: () => ({ writerId: null, writers: new Map() }),
      client,
      mint: () => "must-not-mint",
    }).catch((e: unknown) => e);
    expect((err as EnrollmentError).enrollmentKind).toBe("key_lost");
    expect(log.enrolled).toEqual([]);
  });

  test("a revoked writer is not re-enrolled under the same id", async () => {
    const s = secrets([[SECRET_WRITER_ID, "phone-1"]]);
    const { log, client } = rig([entry("phone-1", PUB_A_STD, "2026-08-01T00:00:00Z")]);
    const err = await ensureDeviceWriter({
      secrets: s,
      state: () => ({ writerId: null, writers: new Map([["phone-1", { x: PUB_A }]]) }),
      client,
      mint: () => "must-not-mint",
    }).catch((e: unknown) => e);
    expect((err as EnrollmentError).enrollmentKind).toBe("revoked");
    expect(log.enrolled).toEqual([]);
    expect(log.selected).toEqual([]);
  });
});

describe("failures", () => {
  const failing = (thrown: unknown) => {
    const s = secrets([[SECRET_WRITER_ID, "phone-1"]]);
    return ensureDeviceWriter({
      secrets: s,
      state: () => ({ writerId: null, writers: new Map() }),
      client: {
        roster: async () => [],
        enroll: async () => {
          throw thrown;
        },
        useWriter: () => {},
      },
      mint: () => "phone-1",
    });
  };

  test.each([
    [Object.assign(new Error("nope"), { status: 403, code: "registration_rejected" }), "rejected"],
    [Object.assign(new Error("slow down"), { status: 429, code: "rate_limited" }), "rate_limited"],
    [Object.assign(new Error("boom"), { status: 500, code: "internal" }), "unavailable"],
    [new TypeError("Network request failed"), "offline"],
  ])("%p becomes an EnrollmentError", async (thrown, kind) => {
    const err = await failing(thrown).catch((e: unknown) => e);
    expect(isEnrollmentError(err)).toBe(true);
    expect((err as EnrollmentError).enrollmentKind).toBe(kind as EnrollmentKind);
  });

  /**
   * 401 and 410 travel UNWRAPPED, so `bootstrap.ts`'s `classify` and
   * `session.ts`'s `mayWipeLocalData` still see them. Wrapping them would
   * silently turn an expired session into a permanent "this phone was not
   * accepted" wall, and a deleted account into one that never wipes.
   */
  test.each([
    [401, ""],
    [410, "account_deleted"],
  ])("a %p passes through untouched", async (status, code) => {
    const thrown = Object.assign(new Error("session"), { status, code });
    const err = await failing(thrown).catch((e: unknown) => e);
    expect(err).toBe(thrown);
    expect(isEnrollmentError(err)).toBe(false);
  });

  test("an EnrollmentError carries its cause's status so the session rules still match", () => {
    const err = new EnrollmentError("rejected", "refused", { status: 403, code: "registration_rejected" });
    expect(err.status).toBe(403);
    expect(err.code).toBe("registration_rejected");
  });

  test("a roster failure fails enrolment rather than falling through to a blind register", async () => {
    const s = secrets([[SECRET_WRITER_ID, "phone-1"]]);
    const enrolled: string[] = [];
    const err = await ensureDeviceWriter({
      secrets: s,
      state: () => ({ writerId: null, writers: new Map() }),
      client: {
        roster: async () => {
          throw new TypeError("Network request failed");
        },
        enroll: async (id: string) => {
          enrolled.push(id);
        },
        useWriter: () => {},
      },
      mint: () => "phone-1",
    }).catch((e: unknown) => e);
    expect((err as EnrollmentError).enrollmentKind).toBe("offline");
    expect(enrolled).toEqual([]);
  });
});

describe("what a person is told", () => {
  const KINDS: EnrollmentKind[] = ["offline", "unavailable", "rate_limited", "rejected", "revoked", "key_lost"];

  test("no sentence anywhere names a command line", () => {
    for (const kind of KINDS) {
      const copy = enrollmentCopy(kind);
      const text = `${copy.title} ${copy.body}`;
      expect(text).not.toMatch(/\bcli\b|--writer|`|terminal|command line|enroll/i);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });

  /**
   * A "try again" that could only ever fail is a lie in button form. These
   * three cannot change on a second press: the server refuses identically, a
   * revocation is a decision, and a lost key does not come back.
   */
  test("only the transient failures offer a retry", () => {
    expect(KINDS.filter((k) => enrollmentCopy(k).retry)).toEqual(["offline", "unavailable", "rate_limited"]);
  });

  test("the refusal copy does not invent a reason the server did not give", () => {
    const body = enrollmentCopy("rejected").body;
    expect(body).toContain("does not say why");
    expect(body).toContain("will not change the answer");
  });

  test("an unknown error still gets a true, retryable sentence", () => {
    expect(enrollmentFailureCopy(new Error("something else")).retry).toBe(true);
    expect(enrollmentFailureCopy(new EnrollmentError("rejected", "x")).retry).toBe(false);
  });
});
