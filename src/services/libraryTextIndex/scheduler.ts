/**
 * Fills the library text index in the background.
 *
 * Two lanes share one queue table:
 * - urgent (priority >= INDEX_URGENT_MIN_PRIORITY): write-through from the
 *   question path, notifier adds/modifies, invalidated text. Runs while the
 *   user works, with a longer gap while a retrieval is in flight.
 * - prefetch: reconcile's backlog. Runs only while the user is idle and no
 *   retrieval is in flight.
 *
 * Nothing here touches `Zotero.DB`; all index SQL goes through the store.
 */
import { config } from "../../../package.json";
import { appLogger } from "../../core/logging";
import { readAttachmentFileState } from "../../utils/attachmentFileState";
import type { LibraryIndexSnapshot } from "../libraryIndex/contracts";
import { libraryIndexService } from "../libraryIndexService";
import { hasCachedMineruMd } from "../mineru/mineruCache";
import { isPdfContextAttachment } from "../paperContent/contextAttachmentSupport";
import type { ZoteroChangeEvent } from "../zoteroChangeDispatcher";
import {
  INDEX_BUDGET_MB_DEFAULT,
  INDEX_BUDGET_MB_MIN,
  INDEX_BUDGET_SOFT_RATIO,
  INDEX_DRAIN_GAP_BUSY_MS,
  INDEX_DRAIN_GAP_MS,
  INDEX_MAX_ATTEMPTS,
  INDEX_PRIORITY,
  INDEX_RECENT_USE_PROTECT_MS,
  INDEX_RECONCILE_STAT_BATCH,
  INDEX_REPOST_SLICE_MS,
  INDEX_RETRY_BACKOFF_MS,
  INDEX_STOP_GRACE_MS,
  INDEX_URGENT_ADD_BATCH_MAX,
  INDEX_URGENT_MIN_PRIORITY,
  isChunkerVersionStale,
} from "./constants";
import { isLibraryTextIndexClosedError } from "./db";
import { indexAttachment } from "./indexer";
import { runTokenizerUpgradeSlice } from "./tokenizerUpgrade";
import {
  getLibraryTextIndexStore,
  type IndexDocumentRow,
  type LibraryTextIndexStore,
} from "./store";
import {
  currentVectorNamespace,
  embedDocumentVectors,
  loadVectorDims,
  pruneVectorNamespaces,
  removeDocumentVectors,
} from "./vectorIndexer";
import { measureVectorBytes } from "./vectorStore";

export type LibraryTextIndexStatus = {
  enabled: boolean;
  libraryID: number;
  indexed: number;
  queued: number;
  failed: number;
  stale: number;
  building: boolean;
  userIdle: boolean;
  dbBytes: number;
  usedBytes: number;
  budgetBytes: number;
  evictedThisSession: number;
  vectorBytes: number;
  vectorNamespace: string | null;
  vectorIndexed: number;
  lastError: string | null;
};

export type SchedulerEnv = {
  now: () => number;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  getStore: () => Promise<LibraryTextIndexStore | null>;
  getItem: (id: number) => Zotero.Item | null;
  getSnapshot: (libraryID: number) => Promise<LibraryIndexSnapshot>;
  /** User library first. */
  listLibraryIds: () => number[];
  /** Zotero has already loaded this library's items (no load is forced). */
  isLibraryDataLoaded: (libraryID: number) => boolean;
  indexOne: typeof indexAttachment;
  isEnabled: () => boolean;
  isUserIdle: () => boolean;
  budgetBytes: () => number;
  readFileState: typeof readAttachmentFileState;
  hasMineruCache: (attachmentId: number) => Promise<boolean>;
  /** A queued attachment is extracted only if this holds (PDF context attachments). */
  isIndexable: (item: Zotero.Item) => boolean;
  /** The active vector namespace; null keeps the vector stage off. */
  currentVectorNamespace: typeof currentVectorNamespace;
  embedOne: typeof embedDocumentVectors;
};

type Reason = keyof typeof INDEX_PRIORITY;
type ReconcileResult = {
  enqueued: number;
  removed: number;
  stale: number;
  skippedForBudget: number;
};

const ENABLED_PREF = `${config.prefsPrefix}.libraryTextIndexEnabled`;
const BUDGET_PREF = `${config.prefsPrefix}.libraryTextIndexBudgetMB`;
const EVICTION_BATCH = 20;
/** Consecutive vector failures that pause the vector stage for the session. */
const VECTOR_MAX_CONSECUTIVE_FAILURES = 3;

type ZoteroLike = {
  Prefs?: { get?: (key: string, global?: boolean) => unknown };
  Libraries?: {
    userLibraryID?: number;
    getAll?: () => Array<{ libraryID: number; libraryType?: string }>;
    get?: (
      libraryID: number,
    ) => { getDataLoaded?: (objectType: string) => boolean | null } | false;
  };
  Items?: { get?: (id: number) => Zotero.Item | false | undefined };
};
function zotero(): ZoteroLike | undefined {
  return (globalThis as { Zotero?: ZoteroLike }).Zotero;
}

let retrievalActivity = 0;
const runningSchedulers = new Set<LibraryTextIndexScheduler>();

/**
 * Marks a retrieval in flight: the urgent lane slows down and the prefetch
 * lane stops until the returned function is called.
 */
export function beginRetrievalActivity(): () => void {
  retrievalActivity += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    retrievalActivity = Math.max(0, retrievalActivity - 1);
    if (retrievalActivity === 0) {
      for (const scheduler of runningSchedulers) scheduler.kick();
    }
  };
}

export function isLibraryTextIndexEnabled(): boolean {
  const value = zotero()?.Prefs?.get?.(ENABLED_PREF, true);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "false") return false;
  }
  return true;
}

export function getLibraryTextIndexBudgetBytes(): number {
  const raw = Number(zotero()?.Prefs?.get?.(BUDGET_PREF, true));
  // Same floor as the settings pane: a smaller stored value is not honoured.
  const mb =
    Number.isFinite(raw) && raw >= INDEX_BUDGET_MB_MIN
      ? raw
      : INDEX_BUDGET_MB_DEFAULT;
  return Math.floor(mb * 1024 * 1024);
}

function userLibraryID(): number {
  return zotero()?.Libraries?.userLibraryID ?? 1;
}

function normalizeIds(ids: readonly (string | number)[]): number[] {
  return ids
    .map((id) => (typeof id === "string" ? parseInt(id, 10) : id))
    .filter((id): id is number => Number.isFinite(id) && id > 0);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

type ItemShape = {
  libraryID?: number;
  isAttachment?: () => boolean;
  isRegularItem?: () => boolean;
  getAttachments?: () => number[];
};

export class LibraryTextIndexScheduler {
  private readonly env: SchedulerEnv;
  private timer: unknown = null;
  /** When the armed timer fires; an earlier kick replaces it. */
  private timerDueAt = 0;
  /** The drain in progress, so stop() can let its write finish. */
  private inflight: Promise<void> | null = null;
  private running = false;
  private draining = false;
  /** A kick arrived mid-drain; re-check the queue once the drain ends. */
  private rekick = false;
  private generation = 0;
  private lastError: string | null = null;
  private evictedThisSession = 0;
  private sessionSummaryLogged = false;
  private budgetNoticeLogged = false;
  private idleWaiters: Array<() => void> = [];
  /** Documents whose vectors failed or were skipped this session. */
  private vectorSkipped = new Set<number>();
  private vectorFailuresInARow = 0;
  private vectorPaused = false;
  private tokenizerUpgradeFailureLogged = false;
  /** Re-post failures per attachment this session; see `INDEX_MAX_ATTEMPTS`. */
  private repostFailures = new Map<number, number>();
  /** No re-posting before this time after a failed slice (ms, env clock). */
  private repostRetryAt = 0;
  private repostedThisSession = 0;

  constructor(env: Partial<SchedulerEnv> = {}) {
    this.env = {
      now: Date.now,
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      getStore: getLibraryTextIndexStore,
      getItem: (id) => zotero()?.Items?.get?.(id) || null,
      getSnapshot: (libraryID) => libraryIndexService.getSnapshot(libraryID),
      listLibraryIds: () => {
        const user = userLibraryID();
        const all = zotero()?.Libraries?.getAll?.() || [];
        const groups = all
          .filter((l) => l.libraryType === "group")
          .map((l) => l.libraryID)
          .filter((id) => id !== user);
        return [user, ...groups];
      },
      isLibraryDataLoaded: (libraryID) => {
        try {
          const library = zotero()?.Libraries?.get?.(libraryID);
          return Boolean(library && library.getDataLoaded?.("item"));
        } catch {
          return false;
        }
      },
      indexOne: indexAttachment,
      isEnabled: isLibraryTextIndexEnabled,
      isUserIdle: () => true, // replaced by the idle tracker in index.ts
      budgetBytes: getLibraryTextIndexBudgetBytes,
      readFileState: readAttachmentFileState,
      hasMineruCache: hasCachedMineruMd,
      isIndexable: (item) => isPdfContextAttachment(item),
      currentVectorNamespace,
      embedOne: embedDocumentVectors,
      ...env,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    runningSchedulers.add(this);
    this.kick();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    runningSchedulers.delete(this);
    if (this.timer !== null) {
      this.env.clearTimer(this.timer);
      this.timer = null;
    }
    this.rekick = false;
    this.resolveIdle();
    // Let a running job finish its write before the caller closes the
    // database, but never hold shutdown longer than the grace period.
    const inflight = this.inflight;
    if (!inflight) return;
    let grace: unknown = null;
    const expired = await Promise.race([
      inflight.then(() => false),
      new Promise<boolean>((resolve) => {
        grace = this.env.setTimer(() => resolve(true), INDEX_STOP_GRACE_MS);
      }),
    ]);
    if (grace !== null) this.env.clearTimer(grace);
    if (expired) {
      if (this.inflight === inflight) this.inflight = null; // abandoned
      appLogger.debug("LLM index: stopped without waiting for a stuck job");
    }
  }

  kick(delayMs = 0): void {
    if (!this.running) return;
    if (this.draining) {
      if (delayMs === 0) this.rekick = true;
      return;
    }
    const dueAt = this.env.now() + delayMs;
    if (this.timer !== null) {
      // A parked loop may be waiting on a long backoff; newer work must not.
      if (dueAt >= this.timerDueAt) return;
      this.env.clearTimer(this.timer);
      this.timer = null;
    }
    const generation = this.generation;
    this.timerDueAt = dueAt;
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      const drain = this.drainOne();
      this.inflight = drain;
      void drain.finally(() => {
        if (this.inflight === drain) this.inflight = null;
      });
    }, delayMs);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  onUserIdleChange(idle: boolean): void {
    if (idle) this.kick();
  }

  handleContextLoaded(attachmentId: number): void {
    // Write-through: the question path already paid for this context. Never await here.
    void this.enqueue([attachmentId], "writeThrough").catch((error) =>
      appLogger.debug("LLM index: write-through enqueue failed", error),
    );
  }

  async enqueue(attachmentIds: number[], reason: Reason): Promise<void> {
    if (!this.env.isEnabled()) return;
    // Notes and non-PDF attachments never reach the queue. Unresolvable ids
    // (not loaded yet) pass; the drain re-checks before extracting.
    const ids = attachmentIds.filter((id) => {
      const item = this.env.getItem(id);
      return !item || this.env.isIndexable(item);
    });
    if (!ids.length) return;
    const store = await this.env.getStore();
    if (!store) return;
    const priority = INDEX_PRIORITY[reason];
    await store.enqueue(
      ids.map((attachmentId) => ({
        attachmentId,
        libraryID: this.libraryFor(attachmentId),
        priority,
        reason,
      })),
    );
    this.kick();
  }

  async remove(attachmentIds: number[]): Promise<void> {
    if (!attachmentIds.length || !this.env.isEnabled()) return;
    const store = await this.env.getStore();
    if (store) await this.deleteDocuments(store, attachmentIds);
  }

  /**
   * The one way documents leave the index: rows first, then (best effort)
   * their vector shard files and loaded-matrix rows, so a deleted or evicted
   * paper leaks neither disk nor memory.
   */
  private async deleteDocuments(
    store: LibraryTextIndexStore,
    attachmentIds: number[],
  ): Promise<void> {
    if (!attachmentIds.length) return;
    const vectorRows =
      await store.listVectorDocumentsForAttachments(attachmentIds);
    await store.deleteDocuments(attachmentIds);
    if (vectorRows.length) await removeDocumentVectors(vectorRows);
  }

  private libraryFor(attachmentId: number): number {
    const item = this.env.getItem(attachmentId) as ItemShape | null;
    return typeof item?.libraryID === "number"
      ? item.libraryID
      : userLibraryID();
  }

  /**
   * Startup reconcile. The user library always; a group library only when
   * Zotero has already loaded it or the index already holds some of its
   * papers, because reading a group's snapshot would otherwise load every
   * item of every group at startup. Write-through still indexes any group
   * paper a question reads.
   */
  async reconcileAll(): Promise<void> {
    if (!this.env.isEnabled()) return;
    const [userLibrary, ...groups] = this.env.listLibraryIds();
    const libraries = userLibrary === undefined ? [] : [userLibrary];
    for (const libraryID of groups) {
      try {
        if (
          this.env.isLibraryDataLoaded(libraryID) ||
          (await this.hasIndexedDocuments(libraryID))
        )
          libraries.push(libraryID);
      } catch (error) {
        appLogger.debug(
          `LLM index: could not check library ${libraryID} for reconcile`,
          error,
        );
      }
    }
    for (const libraryID of libraries) {
      try {
        await this.reconcile(libraryID);
      } catch (error) {
        // Closed under the reconcile (stop, Clear): the rest would fail too.
        if (isLibraryTextIndexClosedError(error)) {
          appLogger.debug("LLM index: reconcile stopped; index closed");
          return;
        }
        appLogger.warn(
          `LLM index: reconcile failed for library ${libraryID}`,
          error,
        );
      }
    }
    // A lowered budget takes effect at startup, not at the next prefetch.
    try {
      await this.enforceBudget();
    } catch (error) {
      appLogger.debug("LLM index: budget check failed", error);
    }
  }

  private async hasIndexedDocuments(libraryID: number): Promise<boolean> {
    const store = await this.env.getStore();
    return Boolean(store && (await store.listDocuments(libraryID)).length);
  }

  async reconcile(libraryID: number): Promise<ReconcileResult> {
    const empty = { enqueued: 0, removed: 0, stale: 0, skippedForBudget: 0 };
    if (!this.env.isEnabled()) return empty;
    const store = await this.env.getStore();
    if (!store) return empty;
    await this.pruneVectorNamespaces(store);
    const snapshot = await this.env.getSnapshot(libraryID);
    const eligible = new Set<number>();
    for (const attachmentIds of snapshot.pdfAttachmentIdsByItemId.values()) {
      for (const attachmentId of attachmentIds) {
        if (snapshot.attachmentById.get(attachmentId)?.isContextEligiblePdf)
          eligible.add(attachmentId);
      }
    }
    const documents = await store.listDocuments(libraryID);
    const removed = documents
      .filter((d) => !eligible.has(d.attachmentId))
      .map((d) => d.attachmentId);
    await this.deleteDocuments(store, removed);
    const indexed = new Map(
      documents
        .filter((d) => eligible.has(d.attachmentId))
        .map((d) => [d.attachmentId, d]),
    );

    // Stale detection: chunker version, MinerU cache gained since a
    // pdf.js/full-text-cache index, file stat (size/mtime).
    const staleRows: Array<{ attachmentId: number; reason: Reason }> = [];
    const rows = [...indexed.values()];
    for (let i = 0; i < rows.length; i += INDEX_RECONCILE_STAT_BATCH) {
      const batch = rows.slice(i, i + INDEX_RECONCILE_STAT_BATCH);
      await Promise.all(
        batch.map(async (row) => {
          const reason = await this.staleReason(row);
          if (reason)
            staleRows.push({ attachmentId: row.attachmentId, reason });
        }),
      );
      // Yield between batches so a 5k-paper reconcile never monopolises the event loop.
      if (i + INDEX_RECONCILE_STAT_BATCH < rows.length)
        await yieldToEventLoop();
    }
    const staleIds = staleRows.map((r) => r.attachmentId);
    await store.enqueue(
      staleRows.map((r) => ({
        attachmentId: r.attachmentId,
        libraryID,
        priority: INDEX_PRIORITY[r.reason],
        reason: r.reason,
      })),
    );
    // A changed source earns a parked row a fresh set of attempts.
    await store.resetAttempts(staleIds);

    // Prefetch: everything eligible, not indexed and not already queued, unless
    // the budget is (nearly) spent. Re-enqueueing a queued row would reset its
    // attempts and resurrect every permanently failing PDF at each startup.
    const queued = await store.listQueuedAttachmentIds(libraryID);
    const missing = [...eligible].filter(
      (id) => !indexed.has(id) && !queued.has(id),
    );
    const used = await store.sumByteEstimates();
    const softLimit = this.env.budgetBytes() * INDEX_BUDGET_SOFT_RATIO;
    let skippedForBudget = 0;
    let toQueue = missing;
    if (used >= softLimit) {
      skippedForBudget = missing.length;
      toQueue = [];
      if (!this.budgetNoticeLogged && missing.length) {
        this.budgetNoticeLogged = true;
        appLogger.info(
          `LLM index: budget reached (${Math.round(used / 1048576)} MB); prefetch paused, write-through continues`,
        );
      }
    }
    await store.enqueue(
      toQueue.map((attachmentId) => ({
        attachmentId,
        libraryID,
        priority: INDEX_PRIORITY.prefetch,
        reason: "prefetch",
      })),
    );
    if (toQueue.length || staleRows.length) this.kick();
    return {
      enqueued: toQueue.length,
      removed: removed.length,
      stale: staleRows.length,
      skippedForBudget,
    };
  }

  /**
   * A provider or model switch starts a new, empty namespace; the old
   * namespaces' rows and shard files go. Nothing is pruned while vectors are off.
   */
  private async pruneVectorNamespaces(
    store: LibraryTextIndexStore,
  ): Promise<void> {
    try {
      // Hydrate the recorded dimensions first: an `:auto` namespace must not
      // be mistaken for a switch away from this provider's own namespace.
      await loadVectorDims(store);
      const current = this.env.currentVectorNamespace();
      if (!current) return;
      const removed = await pruneVectorNamespaces(store, current.namespace);
      if (removed.length)
        appLogger.info(
          `LLM index: removed ${removed.length} stale vector namespace(s)`,
        );
    } catch (error) {
      appLogger.debug("LLM index: vector namespace pruning failed", error);
    }
  }

  private async staleReason(row: IndexDocumentRow): Promise<Reason | null> {
    // Version 2 has the current chunk boundaries: the re-posting pass handles it.
    if (isChunkerVersionStale(row.chunkerVersion)) return "chunkerVersion";
    if (
      row.sourceType !== "mineru" &&
      (await this.env.hasMineruCache(row.attachmentId))
    )
      return "mineruUpgrade";
    const state = await this.env.readFileState(
      this.env.getItem(row.attachmentId),
    );
    if (!state) return null; // no local file: leave the row alone
    // Recorded without a stat (written before the file was on disk): the file
    // exists now, so what was indexed may not be its text.
    const statRecorded = row.sourceSize !== null || row.sourceMtime !== null;
    const statNow = state.size !== null || state.mtime !== null;
    if (!statRecorded && statNow) return "stale";
    const sizeChanged =
      row.sourceSize !== null &&
      state.size !== null &&
      state.size !== row.sourceSize;
    const mtimeChanged =
      row.sourceMtime !== null &&
      state.mtime !== null &&
      state.mtime !== row.sourceMtime;
    return sizeChanged || mtimeChanged ? "stale" : null;
  }

  async handleChange(change: ZoteroChangeEvent): Promise<void> {
    if (change.type !== "item" && change.type !== "file") return;
    const ids = normalizeIds(change.ids);
    if (!ids.length || !this.env.isEnabled()) return;
    if (
      change.event === "delete" ||
      change.event === "trash" ||
      change.event === "remove"
    ) {
      // A trashed parent still resolves; take its attachments with it. Erased
      // items no longer resolve, but Zotero reports their children too.
      await this.remove(this.expandToAttachments(ids, true));
      return;
    }
    if (change.event !== "add" && change.event !== "modify") return;
    const attachmentIds = this.expandToAttachments(ids, false);
    if (change.event === "add") {
      await this.enqueueNotifierBatch(attachmentIds, "added");
      return;
    }
    // Metadata edits and sync touches fire `modify` on every item. Re-extract
    // only when the file really changed, or when the paper is neither indexed
    // nor queued: re-enqueueing a queued row would promote a prefetch row to
    // urgent and give a parked row fresh attempts.
    const store = await this.env.getStore();
    if (!store) return;
    const queuedByLibrary = new Map<number, Set<number>>();
    const changed: number[] = [];
    const unseen: number[] = [];
    for (const attachmentId of attachmentIds) {
      const row = await store.getDocument(attachmentId);
      if (row) {
        if (await this.staleReason(row)) changed.push(attachmentId);
        continue;
      }
      const libraryID = this.libraryFor(attachmentId);
      let queued = queuedByLibrary.get(libraryID);
      if (!queued) {
        queued = await store.listQueuedAttachmentIds(libraryID);
        queuedByLibrary.set(libraryID, queued);
      }
      if (!queued.has(attachmentId)) unseen.push(attachmentId);
    }
    await this.enqueue(changed, "modified");
    // Never indexed and never queued: a sync touching many such papers is
    // routed like a large add.
    await this.enqueueNotifierBatch(unseen, "modified");
  }

  /**
   * An initial sync adds (or touches) thousands of items at once: a batch
   * over INDEX_URGENT_ADD_BATCH_MAX waits for idle in the prefetch lane, and
   * at or above the soft budget it is not queued at all (reconcile picks it
   * up, as it does for every other prefetch candidate).
   */
  private async enqueueNotifierBatch(
    attachmentIds: number[],
    urgentReason: "added" | "modified",
  ): Promise<void> {
    if (!attachmentIds.length) return;
    if (attachmentIds.length <= INDEX_URGENT_ADD_BATCH_MAX) {
      await this.enqueue(attachmentIds, urgentReason);
      return;
    }
    const store = await this.env.getStore();
    if (!store) return;
    const softLimit = this.env.budgetBytes() * INDEX_BUDGET_SOFT_RATIO;
    if ((await store.sumByteEstimates()) >= softLimit) return;
    await this.enqueue(attachmentIds, "prefetch");
  }

  private expandToAttachments(
    ids: number[],
    keepUnresolved: boolean,
  ): number[] {
    const out: number[] = [];
    for (const id of ids) {
      const item = this.env.getItem(id) as ItemShape | null;
      if (!item) {
        // Deleted: remove by id. Not loaded yet: let the drain validate.
        out.push(id);
        continue;
      }
      if (item.isAttachment?.()) out.push(id);
      else if (item.isRegularItem?.()) {
        out.push(...(item.getAttachments?.() || []));
        if (keepUnresolved) out.push(id);
      }
    }
    return [...new Set(out)];
  }

  async enforceBudget(): Promise<number> {
    if (!this.env.isEnabled()) return 0;
    const store = await this.env.getStore();
    if (!store) return 0;
    const budget = this.env.budgetBytes();
    let used = await store.sumByteEstimates();
    let evicted = 0;
    while (used > budget) {
      const victims = await store.listLeastRecentlyUsed(
        EVICTION_BATCH,
        this.env.now() - INDEX_RECENT_USE_PROTECT_MS,
      );
      if (!victims.length) break;
      let freed = 0;
      const ids: number[] = [];
      for (const victim of victims) {
        ids.push(victim.attachmentId);
        freed += victim.byteEstimate;
        if (used - freed <= budget) break;
      }
      await this.deleteDocuments(store, ids);
      evicted += ids.length;
      used -= freed;
    }
    if (evicted) {
      this.evictedThisSession += evicted;
      appLogger.info(
        `LLM index: evicted ${evicted} least-recently-searched paper(s) to stay under ${Math.round(budget / 1048576)} MB`,
      );
    }
    return evicted;
  }

  private async drainOne(): Promise<void> {
    if (!this.running || this.draining) return;
    if (!this.env.isEnabled()) {
      this.resolveIdle();
      return;
    }
    this.draining = true;
    this.rekick = false;
    const generation = this.generation;
    let next: number | null = null; // ms until the next drain; null = park
    try {
      const store = await this.env.getStore();
      if (!store) return;
      const now = this.env.now();
      let job = await store.dequeueNext({
        now,
        minPriority: INDEX_URGENT_MIN_PRIORITY,
      });
      if (
        !job &&
        this.env.now() >= this.repostRetryAt &&
        (await this.isTokenizerUpgradePending(store))
      ) {
        // Between the urgent and prefetch lanes: it never waits for idle,
        // and an urgent job still goes first at every step. Once done, this
        // drain goes on to the lanes below.
        const step = await this.runTokenizerUpgradeStep(store);
        if (step !== "done") {
          next = step;
          return;
        }
      }
      let lane: "urgent" | "prefetch" = "urgent";
      const prefetchAllowed =
        !job &&
        this.env.isUserIdle() &&
        retrievalActivity === 0 &&
        (await store.sumByteEstimates()) <
          this.env.budgetBytes() * INDEX_BUDGET_SOFT_RATIO;
      if (prefetchAllowed) {
        // Above the soft budget, prefetch would only index-then-evict.
        job = await store.dequeueNext({ now });
        lane = "prefetch";
      }
      if (!job) {
        // Both text lanes are empty. The vector stage is prefetch work too.
        if (prefetchAllowed && (await this.embedNextVector(store))) {
          if (generation !== this.generation) return;
          next =
            retrievalActivity > 0
              ? INDEX_DRAIN_GAP_BUSY_MS
              : INDEX_DRAIN_GAP_MS;
          return;
        }
        next = await this.onQueueQuiet(store, now);
        return;
      }
      const item = this.env.getItem(job.attachmentId);
      if (!item || !this.env.isIndexable(item)) {
        await store.removeFromQueue([job.attachmentId]);
        next = 0;
        return;
      }
      try {
        const result = await this.env.indexOne({
          item,
          libraryID: job.libraryID,
          store,
          lane,
        });
        if (generation !== this.generation) return; // stopped while extracting: no reschedule
        if (result.status === "no_text")
          appLogger.debug(`LLM index: no text for ${job.attachmentId}`);
        await store.removeFromQueue([job.attachmentId]);
        // Write-through grows the index too; keep every lane under the budget.
        if (result.status === "indexed") await this.enforceBudget();
      } catch (error) {
        if (generation !== this.generation) return;
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        await store.markQueueAttempt(job.attachmentId, message, now);
        if (job.attempts + 1 >= INDEX_MAX_ATTEMPTS)
          appLogger.debug(
            `LLM index: parked attachment ${job.attachmentId}: ${message}`,
          );
      }
      next =
        retrievalActivity > 0 ? INDEX_DRAIN_GAP_BUSY_MS : INDEX_DRAIN_GAP_MS;
    } catch (error) {
      appLogger.debug("LLM index: drain failed", error);
    } finally {
      this.draining = false;
      if (next === null && this.rekick) next = 0;
      // A failed re-post waits for its backoff; wake then instead of parking.
      const repostWake = this.repostRetryAt - this.env.now();
      if (next === null && repostWake > 0) next = repostWake;
      this.rekick = false;
      if (generation === this.generation && this.running && next !== null)
        this.kick(next);
    }
  }

  /** The store caches a true answer, so this costs a query only until the pass ends. */
  private async isTokenizerUpgradePending(
    store: LibraryTextIndexStore,
  ): Promise<boolean> {
    return !(await store.isTokenizerVersionCurrent());
  }

  /**
   * One slice of the re-posting pass (tokenizerUpgrade.ts). Returns "done"
   * once every document is re-posted, else the delay until the next drain:
   * the usual gap while documents remain, a retry backoff after a failure.
   */
  private async runTokenizerUpgradeStep(
    store: LibraryTextIndexStore,
  ): Promise<number | "done"> {
    try {
      const slice = await runTokenizerUpgradeSlice(store, {
        sliceMs: INDEX_REPOST_SLICE_MS,
        now: this.env.now,
        failures: this.repostFailures,
        maxAttempts: INDEX_MAX_ATTEMPTS,
        onSkipped: (attachmentId, message) =>
          appLogger.warn(
            `LLM index: re-posting attachment ${attachmentId} failed ${INDEX_MAX_ATTEMPTS} times; leaving it with its old postings for this session. ${message}`,
          ),
      });
      this.repostedThisSession += slice.reposted;
      if (slice.failure) {
        // A failed slice must not block the lanes below: back off, then go on.
        this.lastError = slice.failure;
        this.repostRetryAt = this.env.now() + INDEX_RETRY_BACKOFF_MS[0];
        return "done";
      }
      if (slice.done) {
        if (this.repostedThisSession)
          appLogger.debug(
            `LLM index: re-posted ${this.repostedThisSession} document(s) for the current tokenizer`,
          );
        return "done";
      }
      return retrievalActivity > 0
        ? INDEX_DRAIN_GAP_BUSY_MS
        : INDEX_DRAIN_GAP_MS;
    } catch (error) {
      if (isLibraryTextIndexClosedError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      if (!this.tokenizerUpgradeFailureLogged) {
        this.tokenizerUpgradeFailureLogged = true;
        appLogger.warn(
          `LLM index: re-posting for the new tokenizer failed; retrying later. ${message}`,
        );
      }
      return INDEX_RETRY_BACKOFF_MS[0];
    }
  }

  /**
   * Embeds one document missing vectors in the active namespace. Returns
   * false when there is nothing to embed (or the stage is off or paused).
   * A failure never propagates: it is recorded and the document is skipped
   * for the rest of the session.
   */
  private async embedNextVector(
    store: LibraryTextIndexStore,
  ): Promise<boolean> {
    if (this.vectorPaused) return false;
    await loadVectorDims(store);
    const current = this.env.currentVectorNamespace();
    if (!current) return false;
    let attachmentId: number | null = null;
    for (const libraryID of this.env.listLibraryIds()) {
      const missing = await store.listDocumentsMissingVectors(
        libraryID,
        current.namespace,
      );
      attachmentId = missing.find((id) => !this.vectorSkipped.has(id)) ?? null;
      if (attachmentId !== null) break;
    }
    if (attachmentId === null) return false;
    // The text lanes are empty: nobody else is waiting on this drain.
    this.resolveIdle();
    try {
      const result = await this.env.embedOne({
        store,
        attachmentId,
        namespace: current.namespace,
      });
      this.vectorFailuresInARow = 0;
      // A skipped document would otherwise be listed as missing forever.
      if (result.status === "skipped") this.vectorSkipped.add(attachmentId);
      else
        appLogger.debug(
          `LLM index: vectors ${result.status} for ${attachmentId} (${result.chunkCount} chunks)`,
        );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.vectorSkipped.add(attachmentId);
      this.vectorFailuresInARow += 1;
      appLogger.debug(
        `LLM index: vectors failed for ${attachmentId}: ${message}`,
      );
      if (this.vectorFailuresInARow >= VECTOR_MAX_CONSECUTIVE_FAILURES) {
        this.vectorPaused = true;
        appLogger.warn(
          `LLM index: vector indexing paused for this session after ${this.vectorFailuresInARow} consecutive failures. Last error: ${message}`,
        );
      }
    }
    return true;
  }

  /**
   * Nothing runnable right now: resolve waiters, log the one-per-session
   * failure summary, and return the delay until the earliest backoff expires
   * (null = park until something kicks).
   */
  private async onQueueQuiet(
    store: LibraryTextIndexStore,
    now: number,
  ): Promise<number | null> {
    this.resolveIdle();
    if (!this.sessionSummaryLogged) {
      let failed = 0;
      for (const libraryID of this.env.listLibraryIds())
        failed += (await store.countQueue(libraryID)).failed;
      if (failed > 0) {
        this.sessionSummaryLogged = true;
        appLogger.warn(
          `LLM index: ${failed} attachment(s) could not be indexed after ${INDEX_MAX_ATTEMPTS} attempts; they are reported as unindexed when searched. Last error: ${this.lastError || "n/a"}`,
        );
      }
    }
    const backingOff = await store.dequeueNext({
      now: Number.MAX_SAFE_INTEGER,
    });
    return backingOff && backingOff.nextAttemptAt > now
      ? backingOff.nextAttemptAt - now
      : null;
  }

  async getStatus(libraryID: number): Promise<LibraryTextIndexStatus> {
    const enabled = this.env.isEnabled();
    const store = enabled ? await this.env.getStore() : null;
    const base: LibraryTextIndexStatus = {
      enabled,
      libraryID,
      indexed: 0,
      queued: 0,
      failed: 0,
      stale: 0,
      building: false,
      userIdle: this.env.isUserIdle(),
      dbBytes: 0,
      usedBytes: 0,
      budgetBytes: this.env.budgetBytes(),
      evictedThisSession: this.evictedThisSession,
      vectorBytes: 0,
      vectorNamespace: null,
      vectorIndexed: 0,
      lastError: this.lastError,
    };
    if (!store) return base;
    const documents = await store.listDocuments(libraryID);
    const counts = await store.countQueue(libraryID);
    return {
      ...base,
      indexed: documents.length,
      stale: documents.filter((d) => isChunkerVersionStale(d.chunkerVersion))
        .length,
      queued: counts.queued,
      failed: counts.failed,
      building: this.draining || counts.queued > 0,
      dbBytes: await store.getDbBytes(),
      usedBytes: await store.sumByteEstimates(),
      ...(await this.vectorStatus(store)),
    };
  }

  private async vectorStatus(
    store: LibraryTextIndexStore,
  ): Promise<
    Pick<
      LibraryTextIndexStatus,
      "vectorNamespace" | "vectorIndexed" | "vectorBytes"
    >
  > {
    await loadVectorDims(store);
    const current = this.env.currentVectorNamespace();
    if (!current)
      return { vectorNamespace: null, vectorIndexed: 0, vectorBytes: 0 };
    let vectorBytes = 0;
    try {
      vectorBytes = await measureVectorBytes(current.namespace);
    } catch {
      // No data directory (tests, early startup): report zero.
    }
    return {
      vectorNamespace: current.namespace,
      vectorIndexed: (await store.listVectorDocuments(current.namespace))
        .length,
      vectorBytes,
    };
  }

  /** Resolves true once nothing is runnable now, false on timeout. */
  waitForIdle(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = this.env.setTimer(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      const done = () => {
        if (settled) return;
        settled = true;
        this.env.clearTimer(timer);
        resolve(true);
      };
      this.idleWaiters.push(done);
      if (!this.env.isEnabled()) return done();
      void this.env
        .getStore()
        .then(async (store) => {
          if (!store) return done();
          const runnable =
            (await store.dequeueNext({ now: this.env.now() })) ||
            (await this.isTokenizerUpgradePending(store));
          if (!runnable && !this.draining) done();
          // Otherwise the drain resolves the waiter when it next finds nothing to do.
          else this.kick();
        })
        .catch(() => done());
    });
  }

  private resolveIdle(): void {
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }
}

export const libraryTextIndexScheduler = new LibraryTextIndexScheduler();
