/**
 * The device's dictionary: the delta feed, the local match, and the pass that
 * applies both to rows that have no category yet.
 *
 * # It owns no storage rules of its own
 *
 * Every decoding, validation, cursor and candidate rule lives in
 * `client/src/categorize/` — `decodeDictionaryDelta`, `applyDictionaryDelta`,
 * `dictionaryCursor`, `prepareFromStore`, `proposeCategories` — and this module
 * is the thing that calls them over HTTP and over the outbox. An earlier
 * version of this file carried a second schema (`merchant_dictionary`), a second
 * cursor and a second matcher beside them, none of which anything applied; the
 * shared module was left with no importer at all. Two implementations of a rule
 * are two things that can disagree, and the one that ran was the one with no
 * candidate pass behind it.
 *
 * # Re-categorization never rewrites a decision
 *
 * {@link DictionarySource.recategorize} scans `category IS NULL AND unparsed = 0
 * AND superseded_by IS NULL` (in SQL, in `proposeCategories`) and emits
 * `txn_categorized` for what a rule or the dictionary resolves. It carries the
 * row's CURRENT `needs_review` through unchanged: a category the crowd proposed
 * is not the user confirming the row, so a row waiting in review keeps waiting.
 *
 * # The sync error carries its status
 *
 * `bootstrap.ts` classifies a launch failure by `error.status`. A dictionary
 * refresh that threw a bare `Error` was invisible to that classification, so an
 * expired token surfaced as "Ledger could not safely open this account" instead
 * of a sign-out. The status is attached here so the one policy applies.
 */

import type { SqlDriver } from "@ledger/client/store/driver.ts";
import type { Op } from "@ledger/client/wire/op.ts";
import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import {
  applyDictionaryDelta,
  decodeDictionaryDelta,
  dictionaryCursor,
  ensureDictionary,
  prepareFromStore,
  proposeCategories,
  type ProposeOptions,
  type ProposeReport,
} from "@ledger/client/categorize/dictionary.ts";
import { categorize, type PreparedRules } from "@ledger/client/categorize/rules.ts";
import { projectionIsUsable } from "@ledger/client/replay/projection.ts";

import { nextParentVersion } from "../lib/review.ts";
import type { DictionarySubmitter, ReviewDictionary } from "../screens/review/deps.ts";

/**
 * The part of `Outbox` a re-categorization pass uses. `Outbox` satisfies it
 * structurally, so the pass is testable without a client or a network.
 */
export interface DictionaryWriter {
  readonly pending: readonly Op[];
  enqueueMany(specs: readonly OpSpec[]): unknown;
}

export interface DictionarySource extends ReviewDictionary {
  sync(): Promise<void>;
  categoryFor(merchant: string): string | null;
  /** Applies rules + dictionary to still-uncategorized rows. Returns what it did. */
  recategorize(opts?: ProposeOptions): Promise<ProposeReport>;
}

/** One real turn of the event loop. Never `await undefined`, which is not one. */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export type DictionaryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function sqliteDictionarySource(options: {
  db: SqlDriver;
  server: string;
  token(): string | null;
  submitter: DictionarySubmitter;
  writer?: DictionaryWriter;
  fetch?: DictionaryFetch;
}): DictionarySource {
  const { db } = options;
  ensureDictionary(db);

  /**
   * `prepare()` validates, canonicalizes, compiles and sorts both tiers, and
   * its own doc says it is called once per pass and never per row. Memoized
   * here for the same reason, and dropped whenever either input can have
   * changed: after a delta lands, and at the start of every pass.
   */
  let prepared: PreparedRules | null = null;
  const rules = (): PreparedRules => (prepared ??= prepareFromStore(db));

  /**
   * Prepared lazily, and only inside a pass that has already checked
   * `projectionIsUsable`: `txn` is the projection's table, and a runtime built
   * before this device's first fold has none. Preparing it at construction made
   * the dictionary unusable on exactly the launch it matters most on.
   */
  let head: ReturnType<SqlDriver["prepare"]> | null = null;

  return {
    submit: (entry) => options.submitter.submit(entry),

    async sync() {
      const token = options.token();
      if (token === null) throw new Error("sign in before syncing the dictionary");
      const since = dictionaryCursor(db);
      const response = await (options.fetch ?? fetch)(
        new URL(`/api/v1/dictionary?since=${since}`, options.server),
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        throw Object.assign(new Error(`dictionary sync failed: ${response.status}`), { status: response.status });
      }
      applyDictionaryDelta(db, decodeDictionaryDelta(await response.json()));
      prepared = null;
    },

    categoryFor(merchant) {
      return categorize(merchant, rules()).category;
    },

    async recategorize(opts = {}) {
      // Not an error, and not silent either: a device that has not finished its
      // first fold has no candidate table to walk, and re-running the pass on
      // the next launch costs nothing.
      if (!projectionIsUsable(db)) return { scanned: 0, proposed: 0, chunks: 0 };
      prepared = null;
      const writer = options.writer;
      if (writer === undefined) return { scanned: 0, proposed: 0, chunks: 0 };
      head ??= db.prepare("SELECT version, needs_review FROM txn WHERE id = ?");
      // Ops are handed to the outbox at every page boundary rather than
      // collected into one array and enqueued at the end: 3,683 proposals held
      // in memory before anything could act on one of them is the
      // read-everything shape the rest of this codebase is written against.
      const specs: OpSpec[] = [];
      const drain = (): void => {
        if (specs.length > 0) writer.enqueueMany(specs.splice(0, specs.length));
      };
      const report = await proposeCategories(
        db,
        rules(),
        (p) => {
          const row = head!.all(p.txn_id)[0] as Record<string, unknown> | undefined;
          if (row === undefined) return;
          const version = Number(row["version"]);
          const needsReview = Number(row["needs_review"]) !== 0;
          specs.push({
            type: "txn_categorized",
            entity: { kind: "txn", id: p.txn_id },
            // The head is re-read at emit time and combined with anything this
            // device has already queued for the row: a parent version carried
            // from the scan is a fork against yourself.
            parentVersion: nextParentVersion(p.txn_id, version, writer.pending),
            payload: { category: p.decision.category, needs_review: needsReview },
          });
        },
        {
          ...opts,
          // The yield, not the chunking, is what gives the UI a turn — Phase
          // 0's freeze post-mortem is explicit that chunking without one
          // restores nothing, and `await undefined` is a microtask, which the
          // render loop never gets between. A caller may substitute its own.
          between: async (chunk) => {
            drain();
            await (opts.between ?? macrotask)(chunk);
          },
        },
      );
      drain();
      return report;
    },
  };
}
