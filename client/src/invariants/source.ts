/**
 * The store-backed {@link Chunks} sources — what makes a whole-log check O(1) in
 * blobs held rather than O(log).
 *
 * # Why this file exists
 *
 * `Client.check()` re-verifies from genesis, so its inputs are the WHOLE log:
 * every row and every op. Until now it built both as arrays, and its own comment
 * said so —
 *
 * > "the chunking bounds what the STORE holds, not what the checker does, and
 * > the honest statement is that `check` is O(log) in memory until the checker
 * > itself streams. That is Task 12's job."
 *
 * At up to 1 MiB per blob ({@link BUCKETS}) over the operator's 3,683-message
 * history, that array is the >500 MB shape the Phase 0 device build froze on.
 * The fix has two halves and BOTH are needed: the checker taking chunks
 * (`check.ts`), and a source that produces them without an array behind it
 * (here).
 *
 * # Re-iterable, not a generator
 *
 * {@link Chunks.each} is called once per invariant that needs its own pass, so
 * every source here re-reads from the store rather than caching. `RowStore.range`
 * is the only read path there is; a source that memoized what it read would have
 * moved the array from the caller into itself, which is exactly what
 * `RowStore.all()` was deleted for.
 *
 * # Nothing here decodes twice as much as it must
 *
 * {@link storedOps} opens and decodes each blob and yields ITS ops, then drops
 * the plaintext. The op chunk it hands over is bounded by one blob's worth of
 * ops plus whatever partial chunk is in hand — never by the log.
 */

import { type LogEntry } from "../replay/replay";
import { openBlob, type Stream } from "../wire/blob";
import { UnknownNewerVersionError, decodeBlobOps, type Op } from "../wire/op";
import { eachRowChunk, type RowStore, type WireRow } from "../store/store";
import { CHECK_CHUNK, type Chunks, type SyncRow } from "./check";

/** Turns one stored wire row into a {@link SyncRow}. `Client.decodeWireRow` is the one. */
export type RowDecoder = (r: WireRow) => SyncRow;

/**
 * Every stored row of a stream, in ascending seq order, a chunk at a time.
 *
 * Decoding happens per chunk and nothing is retained between chunks, so the
 * bytes in flight are `chunk × size_bucket` rather than the whole log.
 */
export function storedRows(rows: RowStore, stream: Stream, decode: RowDecoder, limit: number = CHECK_CHUNK): Chunks<SyncRow> {
  return {
    each(fn) {
      eachRowChunk(
        rows,
        stream,
        (chunk) => {
          fn(chunk.map(decode));
        },
        limit,
      );
    },
  };
}

/**
 * Every op in the HOT stream, in fold order, a chunk at a time.
 *
 * # It must agree with the fold, exactly
 *
 * The ops the checker re-folds have to be the ops the client folded, or I9 and
 * I10 compare a state against a different log and report a disagreement that is
 * their own. So the rules here are lifted from `Client`'s `applyRows` and are
 * the same three:
 *
 *   - **cold rows contribute nothing** (I16: a cold blob is a raw body),
 *   - **a blob that will not OPEN contributes nothing** — it is set aside, and
 *   - **a blob that will not DECODE contributes nothing** — likewise.
 *
 * An {@link UnknownNewerVersionError} is the one thing that propagates, because
 * it is a hard stop rather than a set-aside: the client must demand an upgrade,
 * not fold a half-understood log into money. `checkAllStream` turns the throw
 * into a named hard stop rather than losing it.
 *
 * `stream.test.ts` pins the agreement by folding the store both ways and
 * comparing the two states, rather than by trusting this list of rules.
 */
export function storedOps(rows: RowStore, userId: string, decode: RowDecoder, limit: number = CHECK_CHUNK): Chunks<LogEntry> {
  return {
    each(fn) {
      let pending: LogEntry[] = [];
      eachRowChunk(
        rows,
        "hot",
        (chunk) => {
          for (const w of chunk) {
            const r = decode(w);
            if (r.stream !== "hot") continue;
            let body: Uint8Array;
            try {
              body = openBlob(
                { userId, stream: r.stream, writerId: r.writer_id, writerCounter: r.writer_counter },
                r.blob,
              );
            } catch {
              continue; // set aside; it contributed no ops to the fold either
            }
            let ops: Op[];
            try {
              ops = decodeBlobOps(body);
            } catch (err) {
              // An unknown NEWER version is a hard stop and never a set-aside.
              if (err instanceof UnknownNewerVersionError) throw err;
              continue;
            }
            for (const op of ops) pending.push({ op, seq: r.seq, writer_id: r.writer_id });
          }
          // Emitted per stored chunk, so what is held is one chunk of rows'
          // worth of ops. A caller that wanted them all would have to build the
          // array itself, which is the point.
          if (pending.length > 0) {
            fn(pending);
            pending = [];
          }
        },
        limit,
      );
    },
  };
}

/**
 * An op sink for a fold that wants the state and not the ops.
 *
 * `Client`'s `applyRows` appends every op it folds, which is O(log) in decoded
 * *payload* — the biggest thing a blob carries, and the shape Phase 0's device
 * build froze on at >500 MB. A whole-log `check()` re-derives the ops
 * separately and lazily ({@link storedOps}), so a second copy accumulating in
 * the fold would undo the streaming it exists for.
 *
 * # Why a sink and not `ops.length = 0` between chunks
 *
 * They hold the same amount at any instant. The difference is what a test can
 * see: a truncation inside a synchronous method is a LINE, deletable, and
 * invisible to every instrument — the array dies when the method returns, so a
 * post-run measurement reads zero either way, and nothing can sample a sync
 * function's locals mid-run. That mutation (removing the truncation) was this
 * task's one surviving mutant.
 *
 * Naming the sink moves the property somewhere a test can hold it directly:
 * `push` keeps nothing, and `stream.test.ts` asserts exactly that. The mutant is
 * now "make `push` keep things", which fails a two-line unit test.
 *
 * A fresh instance per call rather than a shared singleton: it is cheap, and a
 * shared mutable array reachable from two folds is a hazard that buys nothing.
 */
class DiscardingOps extends Array<LogEntry> {
  override push(): number {
    return 0;
  }
}

/** A {@link LogEntry} sink that discards everything pushed into it. */
export function discardingOps(): LogEntry[] {
  return new DiscardingOps();
}
