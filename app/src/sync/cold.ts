import type { Client } from "@ledger/client/net/client.ts";
import type { SyncRow } from "@ledger/client/invariants/check.ts";
import { ROW_CHUNK, type RowStore, type WireRow } from "@ledger/client/store/store.ts";
import { STREAM_COLD, openBlob } from "@ledger/client/wire/blob.ts";
import { decodeRawBody } from "@ledger/client/wire/op.ts";
import type { ColdBodyIndex } from "../db/coldIndex.ts";

export const COLD_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

export interface ColdSync {
  pinHashes(cancelled?: () => boolean): Promise<{ pinned: number }>;
  fetchRange(fromSeq: bigint, toSeq: bigint): Promise<number>;
  fetchBody(ingestId: string, cancelled?: () => boolean): Promise<Uint8Array | null>;
  prune(): void;
}

export interface ColdProgress {
  pages: number;
  rows: number;
  fromSeq: bigint;
  toSeq: bigint;
}

interface ColdClient {
  readonly userId: string;
  hashCursor(stream: "cold"): bigint;
  pullColdHashes(opts?: { cancelled?: () => boolean }): Promise<{ pinned: number }>;
  pullColdRange(opts: {
    fromSeq: bigint;
    toSeq: bigint;
    onPage?: (rows: readonly SyncRow[]) => void | Promise<void>;
    onPersisted?: (rows: readonly SyncRow[]) => void | Promise<void>;
    cancelled?: () => boolean;
  }): Promise<{ pages: number; rows: number }>;
}

export interface ColdSyncOptions {
  client: Pick<Client, "userId" | "hashCursor" | "pullColdHashes" | "pullColdRange"> | ColdClient;
  rows: RowStore;
  index: ColdBodyIndex;
  now?: () => number;
  onProgress?: (progress: ColdProgress) => void;
  onUnreadable?: (seq: bigint, error: unknown) => void;
}

/**
 * The app policy around Client's verified cold-range transport.
 *
 * Hash pins are durable evidence and are never pruned. Bodies are only a
 * rolling cache. Every network body read pins first; range pulls themselves
 * deliberately leave both Client cursors untouched.
 */
export class RollingColdSync implements ColdSync {
  private readonly client: ColdClient;
  private readonly rows: RowStore;
  private readonly index: ColdBodyIndex;
  private readonly now: () => number;
  private readonly onProgress: ((progress: ColdProgress) => void) | undefined;
  private readonly onUnreadable: ((seq: bigint, error: unknown) => void) | undefined;

  constructor(opts: ColdSyncOptions) {
    this.client = opts.client;
    this.rows = opts.rows;
    this.index = opts.index;
    this.now = opts.now ?? Date.now;
    this.onProgress = opts.onProgress;
    this.onUnreadable = opts.onUnreadable;
  }

  async pinHashes(cancelled: () => boolean = () => false): Promise<{ pinned: number }> {
    const { pinned } = await this.client.pullColdHashes({ cancelled });
    return { pinned };
  }

  async fetchRange(fromSeq: bigint, toSeq: bigint): Promise<number> {
    await this.pinHashes();
    return this.pullRange(fromSeq, toSeq);
  }

  async fetchBody(ingestId: string, cancelled: () => boolean = () => false): Promise<Uint8Array | null> {
    const cached = this.findBody(ingestId);
    if (cached !== null) return cached;
    // A missing local index entry is rebuilt from the verified cold history.
    // This is intentionally progressive and uses the pinned hash cursor as the
    // upper bound; no server-side plaintext ingest-id index can survive Phase 3.
    if (cancelled()) return null;
    await this.pinHashes(cancelled);
    if (cancelled()) return null;
    const head = this.client.hashCursor(STREAM_COLD);
    if (head === 0n) return null;
    await this.pullRange(1n, head, cancelled);
    return this.findBody(ingestId);
  }

  prune(): void {
    const cutoff = this.now() - COLD_WINDOW_DAYS * DAY_MS;
    let after = 0n;
    let before: bigint | null = null;
    for (;;) {
      const chunk = this.rows.range(STREAM_COLD, after, ROW_CHUNK);
      if (chunk.length === 0) break;
      for (const row of chunk) {
        const received = Date.parse(row.created_at);
        // Pruning is prefix-only. An invalid or in-window timestamp is a safe
        // boundary: retaining too much costs space; deleting it loses evidence.
        if (!Number.isFinite(received) || received >= cutoff) {
          if (before !== null) this.pruneBefore(before);
          return;
        }
        before = BigInt(row.seq) + 1n;
      }
      const last = chunk.at(-1);
      if (last === undefined) break;
      const next = BigInt(last.seq);
      if (next <= after) throw new Error(`cold rows: range() did not advance past seq ${after}`);
      after = next;
      if (chunk.length < ROW_CHUNK) break;
    }
    if (before !== null) this.pruneBefore(before);
  }

  private findBody(ingestId: string): Uint8Array | null {
    const indexed = this.index.get(ingestId);
    if (indexed !== null) {
      const row = this.rows.range(STREAM_COLD, indexed - 1n, 1)[0];
      if (row !== undefined && BigInt(row.seq) === indexed) {
        const record = this.tryOpen(row);
        if (record?.ingest_id === ingestId) return record.raw;
      }
    }
    let after = 0n;
    for (;;) {
      const chunk = this.rows.range(STREAM_COLD, after, ROW_CHUNK);
      if (chunk.length === 0) return null;
      for (const row of chunk) {
        const record = this.tryOpen(row);
        if (record !== null) {
          this.index.put(record.ingest_id, BigInt(row.seq));
          if (record.ingest_id === ingestId) return record.raw;
        }
      }
      const last = chunk.at(-1);
      if (last === undefined) return null;
      const next = BigInt(last.seq);
      if (next <= after) throw new Error(`cold rows: range() did not advance past seq ${after}`);
      after = next;
      if (chunk.length < ROW_CHUNK) return null;
    }
  }

  private open(row: WireRow) {
    const bytes = Uint8Array.from(atob(row.blob), (c) => c.charCodeAt(0));
    const plaintext = openBlob(
      {
        userId: this.client.userId,
        stream: STREAM_COLD,
        writerId: row.writer_id,
        writerCounter: BigInt(row.writer_counter),
      },
      bytes,
    );
    return decodeRawBody(plaintext);
  }

  private tryOpen(row: WireRow) {
    try {
      return this.open(row);
    } catch (error) {
      this.onUnreadable?.(BigInt(row.seq), error);
      return null;
    }
  }

  private indexPage(page: readonly SyncRow[]): void {
    for (const row of page) {
      try {
        const record = decodeRawBody(
          openBlob(
            { userId: this.client.userId, stream: STREAM_COLD, writerId: row.writer_id, writerCounter: row.writer_counter },
            row.blob,
          ),
        );
        this.index.put(record.ingest_id, row.seq);
      } catch (error) {
        this.onUnreadable?.(row.seq, error);
      }
    }
  }

  private async pullRange(fromSeq: bigint, toSeq: bigint, cancelled: () => boolean = () => false): Promise<number> {
    let pages = 0;
    let rows = 0;
    const result = await this.client.pullColdRange({
      fromSeq,
      toSeq,
      cancelled,
      onPage: (page) => {
        pages++;
        rows += page.length;
        this.onProgress?.({ pages, rows, fromSeq, toSeq });
      },
      onPersisted: (page) => this.indexPage(page),
    });
    return result.rows;
  }

  private pruneBefore(before: bigint): void {
    this.rows.prune(STREAM_COLD, before);
    this.index.deleteBefore(before);
  }
}
