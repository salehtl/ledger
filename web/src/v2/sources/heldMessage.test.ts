/**
 * Reading a held message on the device, and the promise this lane must not make.
 *
 * The parse runs through the real `client/src/norm` normalizer and the real
 * `client/src/tmpl` executor — the two that are conformance-locked to their Go
 * twins — over real RFC822 bytes. Nothing is stubbed, because a stub here would
 * assert this file's idea of what a template does rather than what one does.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";
import { fold, INGEST_WRITER_ID, type LogEntry } from "@ledger/client/replay/replay";
import type { Definition } from "@ledger/client/tmpl/exec";
import { validateOp, type Op } from "@ledger/client/wire/op";
import type { OpSpec } from "@ledger/client/outbox/outbox";

import type { QuarantineItem } from "../onboardingIO";
import { candidateTemplates, claimedDomains, decodeBlob, MAX_BLOB_BYTES, prefillFromHeld, REVIEWED_ENTRY_METHOD } from "./heldMessage";
import { manualTxnOps, newIngestID } from "./transactions";

const DEVICE = "11111111-1111-4111-8111-111111111111";

/**
 * A template shaped like a real one, written here rather than borrowed.
 *
 * `date_from: "email"` because a template that names a body date must carry a
 * date entry (`compileDefinition` refuses the other pairing), and the point of
 * these tests is the prefill, not date layouts.
 */
const TEMPLATE: Definition = {
  id: "example.card.v1",
  version: 1,
  bank: "example",
  normalizer_version: 1,
  match: { sender_domain: ["example.com"], subject_contains: ["Transaction"] },
  default_currency: "AED",
  date_from: "email",
  extract: [
    { field: "amount", type: "amount", source: "body", patterns: ["AED (?P<amt>[0-9,]+\\.[0-9]{2})"] },
    { field: "merchant", type: "text", source: "body", patterns: ["at (?P<v>[A-Z ]+) on"] },
    { field: "direction", type: "const", source: "body", value: "debit" },
  ],
  required: ["amount", "merchant"],
};

const ITEM: QuarantineItem = {
  id: "q1",
  ingestId: "a".repeat(64),
  receivedAt: "2026-08-03T10:00:00Z",
  expiresAt: "2026-09-02T10:00:00Z",
  warnedAt: null,
  deleteAfter: null,
  // The shape a Gmail forward actually has: the forwarder outside, the bank's
  // own domain only recoverable from inside the message.
  outerDomain: "gmail.com",
  innerDomain: "",
  attested: false,
  attestedBy: "",
  dkim: "pass",
  arc: "none",
  sizeBucket: 2,
};

function message(from: string, subject: string, body: string): Uint8Array {
  return new TextEncoder().encode(
    `From: ${from}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
  );
}

const ALERT = message(
  "alerts@example.com",
  "Transaction alert",
  "You spent AED 125.00 at CARREFOUR MALL on 03/08/2026.",
);

beforeAll(() => {
  setPlatform(webPlatform);
});

describe("a message a published template can read", () => {
  it("prefills the amount, the merchant and the direction, and names why", () => {
    const got = prefillFromHeld({ item: ITEM, raw: ALERT, templates: [TEMPLATE] });

    expect(got.templateId).toBe("example.card.v1");
    expect(got.draft).not.toBeNull();
    expect(got.draft).toMatchObject({
      amount: "125.00",
      currency: "AED",
      direction: "debit",
      merchant: "CARREFOUR MALL",
      // `date_from: "email"`, so the day is the message's own date, not today.
      date: "2026-08-03",
      // Never guessed. An uncategorised row goes to Review, which is correct.
      category: null,
    });
    expect(got.reason).toContain("Check every field");
  });

  it("carries the message text for the screen to show", () => {
    const got = prefillFromHeld({ item: ITEM, raw: ALERT, templates: [TEMPLATE] });
    expect(got.body).toContain("CARREFOUR MALL");
    expect(got.subject).toBe("Transaction alert");
    expect(got.claimedFrom).toContain("example.com");
  });
});

describe("a message no template can read", () => {
  it("prefills NOTHING and says so — there is no heuristic tier on this side", () => {
    // A real bank, a real alert, and no published template for it. This is the
    // common case, and the UI must not advertise autofill it cannot deliver.
    const got = prefillFromHeld({ item: ITEM, raw: ALERT, templates: [] });

    expect(got.draft).toBeNull();
    expect(got.templateId).toBeNull();
    expect(got.reason).toContain("no reader for this sender");
    expect(got.reason).toContain("nothing was filled in");
    // The text is still there: degrading to manual entry means the user can
    // read the message and copy the numbers across.
    expect(got.body).toContain("AED 125.00");
  });

  it("prefills nothing when the sender matches but the body does not", () => {
    const other = message("alerts@example.com", "Transaction alert", "Your statement is ready.");
    const got = prefillFromHeld({ item: ITEM, raw: other, templates: [TEMPLATE] });
    expect(got.draft).toBeNull();
    expect(got.reason).toContain("could not read the details");
  });

  it("does not try a template belonging to a different sender", () => {
    const elsewhere = message("alerts@other-bank.test", "Transaction alert", "You spent AED 125.00 at SHOP NAME on 03/08/2026.");
    const got = prefillFromHeld({ item: ITEM, raw: elsewhere, templates: [TEMPLATE] });
    // The body would match the patterns perfectly. It is not used, because a
    // template is picked by the domain the message claims — a wrong template
    // prefilling a plausible wrong number is worse than an empty form.
    expect(got.draft).toBeNull();
  });

  it("survives bytes that are not a message at all, rather than throwing at the screen", () => {
    // The normalizer's raw fallback reads these as a body with no headers, so
    // nothing claims a domain and nothing matches. Either way the contract is
    // the same: no draft, a sentence, no exception — because the fallback for
    // this whole lane is manual entry, and a crash would take that away too.
    const got = prefillFromHeld({ item: ITEM, raw: new Uint8Array([0xff, 0xfe, 0x00]), templates: [TEMPLATE] });
    expect(got.draft).toBeNull();
    expect(got.reason).toContain("nothing was filled in");
  });
});

describe("which domains a message claims", () => {
  it("includes the envelope's and the forwarded From's, and strips the unverified prefix for MATCHING only", () => {
    const claimed = claimedDomains({ ...ITEM, outerDomain: "unverified:example.com" }, "Bank <alerts@ALERTS.example.com>");
    expect(claimed).toContain("example.com");
    expect(claimed).toContain("alerts.example.com");
    // A subdomain of a template's domain is a candidate, as the pipeline treats
    // a verified one — but candidacy is not belief.
    expect(candidateTemplates([TEMPLATE], claimed)).toHaveLength(1);
  });

  it("matches no template when nothing claims a known domain", () => {
    expect(candidateTemplates([TEMPLATE], ["not-example.com"])).toHaveLength(0);
  });
});

describe("the blob", () => {
  it("refuses one larger than the server ever stores", () => {
    const big = webPlatform.toBase64(new Uint8Array(MAX_BLOB_BYTES + 1));
    expect(() => decodeBlob(big)).toThrow(/larger/);
  });
});

describe("the op a review authors", () => {
  function opOf(spec: OpSpec, n: number): Op {
    const op: Op = {
      v: 1,
      type: spec.type as Op["type"],
      op_id: `op-${n}`,
      authored_at: "2026-08-09T12:00:00.000Z",
      parent_version: spec.parentVersion ?? null,
      payload: spec.payload,
      ...(spec.entity === undefined ? {} : { entity: spec.entity }),
      ...(spec.ingestId === undefined ? {} : { ingest_id: spec.ingestId }),
    };
    validateOp(op);
    return op;
  }

  function built() {
    const prefill = prefillFromHeld({ item: ITEM, raw: ALERT, templates: [TEMPLATE] });
    const result = manualTxnOps({
      draft: prefill.draft!,
      ingestID: newIngestID(),
      newID: () => "reviewed-1",
      entryMethod: REVIEWED_ENTRY_METHOD,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.specs;
  }

  it("is a txn_ingested carrying the reviewed marker, and nothing that claims verification", () => {
    const specs = built();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.type).toBe("txn_ingested");
    const payload = specs[0]!.payload as Record<string, unknown>;
    expect(payload["entry_method"]).toBe("reviewed_forward");
    expect(payload["amount_minor"]).toBe("12500");
    expect(payload["tier"]).toBe("none");
    expect(payload).not.toHaveProperty("verified_origin_domain");
  });

  it("folds as a user row, and the same payload under the ingest writer folds as ingest", () => {
    const specs = built();
    const foldWith = (writer: string) =>
      fold([
        { op: opOf({ type: "home_currency_set", payload: { currency: "AED" }, parentVersion: null }, 0), seq: 1n, writer_id: INGEST_WRITER_ID },
        ...specs.map((s, i) => ({ op: opOf(s, i + 1), seq: BigInt(i + 2), writer_id: writer })),
      ] as LogEntry[]);

    // `entry_method: "reviewed_forward"` buys nothing. The writer decides, and
    // a device cannot be the ingest writer.
    expect([...foldWith(DEVICE).txns.values()][0]?.provenance).toBe("user");
    expect([...foldWith(INGEST_WRITER_ID).txns.values()][0]?.provenance).toBe("ingest");
    expect([...foldWith(DEVICE).txns.values()][0]?.verified_origin_domain).toBeNull();
  });
});
