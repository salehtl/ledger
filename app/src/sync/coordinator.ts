import type { SyncOptions, SyncProgress, SyncResult } from "@ledger/client/net/engine.ts";

export type SyncTrigger = "launch" | "foreground" | "refresh" | "notification" | "retry";

export interface CoordinatedEngine {
  readonly progress: SyncProgress;
  sync(options?: SyncOptions): Promise<SyncResult>;
  subscribe(listener: (progress: SyncProgress) => void): () => void;
  halt(reason: string): void;
}

/** The only app-level entry point for synchronization triggers. */
export class SyncCoordinator {
  constructor(private readonly engine: CoordinatedEngine) {}

  get progress(): SyncProgress {
    return this.engine.progress;
  }

  subscribe(listener: (progress: SyncProgress) => void): () => void {
    return this.engine.subscribe(listener);
  }

  run(_trigger: SyncTrigger, options?: SyncOptions): Promise<SyncResult> {
    return options === undefined ? this.engine.sync() : this.engine.sync(options);
  }

  halt(reason: string): void {
    this.engine.halt(reason);
  }
}
