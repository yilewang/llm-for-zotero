import type { LibraryIndexSnapshot } from "./contracts";

export type SnapshotDelta = Readonly<Partial<LibraryIndexSnapshot>>;

/** One unpublished copy-on-write snapshot for a reconciliation batch. */
export class SnapshotDraft {
  readonly base: LibraryIndexSnapshot;
  readonly epoch: number;
  private current: LibraryIndexSnapshot;

  constructor(base: LibraryIndexSnapshot, epoch: number) {
    this.base = base;
    this.epoch = epoch;
    this.current = base;
  }

  get snapshot(): LibraryIndexSnapshot {
    return this.current;
  }

  apply(delta: SnapshotDelta): void {
    if (!Reflect.ownKeys(delta).length) return;
    this.current = Object.freeze({
      ...this.current,
      ...delta,
      epoch: this.epoch,
    });
  }
}
