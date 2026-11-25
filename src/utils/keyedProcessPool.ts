/**
 * A cache of long-lived child processes, one per key, that stops them all
 * when Zotero quits.
 *
 * A key names everything that makes two processes different (the binary,
 * its data folder, the working directory, launch flags), so a caller that
 * changes any of them gets a fresh process. A process leaves the pool when it
 * closes, when its spawn fails, or when the caller destroys or detaches it.
 */

import { registerAppQuitBlocker } from "./appQuitBlocker";

export type PooledProcess = {
  onClose(listener: (reason?: string) => void): () => void;
  destroy(): void;
  destroyAndWait(timeoutMs?: number): Promise<boolean>;
};

export class KeyedProcessPool<P extends PooledProcess> {
  private readonly entries = new Map<string, Promise<P>>();
  /** The process each settled spawn produced, so removal can be synchronous. */
  private readonly spawned = new WeakMap<Promise<P>, P>();
  private unregisterQuitBlocker: (() => void) | null = null;

  /** `quitBlockerLabel` names the pool in Zotero's quit sequence. */
  constructor(private readonly quitBlockerLabel: string) {}

  /** The pooled process for `key`, spawning it on first use. */
  get(key: string, spawn: () => Promise<P>): Promise<P> {
    const existing = this.entries.get(key);
    if (existing) return existing;
    // Quitting skips the plugin's shutdown hook, so the pool stops its
    // processes from the quit sequence too; otherwise they outlive Zotero.
    this.unregisterQuitBlocker ??= registerAppQuitBlocker(
      this.quitBlockerLabel,
      async () => {
        this.unregisterQuitBlocker = null;
        await this.destroyAll();
      },
    );
    const promise = spawn();
    this.entries.set(key, promise);
    promise.then(
      (proc) => {
        this.spawned.set(promise, proc);
        proc.onClose(() => {
          if (this.entries.get(key) === promise) this.entries.delete(key);
        });
      },
      () => {
        if (this.entries.get(key) === promise) this.entries.delete(key);
      },
    );
    return promise;
  }

  /**
   * Without `proc`, removes the process pooled under `key` and destroys it.
   * With `proc`, destroys that process and removes it from the pool if it is
   * the one pooled there; a newer process pooled under the key stays.
   */
  destroy(key: string, proc?: P): void {
    const existing = this.entries.get(key);
    if (proc) {
      if (existing && this.spawned.get(existing) === proc) {
        this.entries.delete(key);
      }
      proc.destroy();
      return;
    }
    if (!existing) return;
    this.entries.delete(key);
    existing.then(
      (pooled) => pooled.destroy(),
      () => undefined,
    );
  }

  /**
   * Removes `proc` from the pool without destroying it, so new work starts
   * on a fresh process while the work already on this one finishes.
   */
  detach(key: string, proc: P): void {
    const existing = this.entries.get(key);
    if (existing && this.spawned.get(existing) === proc) {
      this.entries.delete(key);
    }
  }

  /**
   * Removes and destroys the started processes `shouldDestroy` picks. A
   * process whose spawn is still in flight stays.
   */
  destroyWhere(shouldDestroy: (key: string) => boolean): void {
    for (const [key, promise] of [...this.entries]) {
      const proc = this.spawned.get(promise);
      if (!proc || !shouldDestroy(key)) continue;
      this.entries.delete(key);
      proc.destroy();
    }
  }

  /** Stops every pooled process and waits for them to exit. */
  async destroyAll(): Promise<void> {
    this.unregisterQuitBlocker?.();
    this.unregisterQuitBlocker = null;
    const pending = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      pending.map((promise) =>
        promise.then(
          (proc) => proc.destroyAndWait().catch(() => undefined),
          () => undefined,
        ),
      ),
    );
  }

  /** The keys with a process (or a spawn in flight). */
  keys(): string[] {
    return [...this.entries.keys()];
  }
}
