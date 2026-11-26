/**
 * Facade for the library text index: lifecycle (start/stop), search and
 * leading-chunk reads, and management for the settings pane (overview,
 * clear, rebuild). hooks.ts loads it lazily; its own imports are static, so
 * there is one module instance per dependency, whichever loader resolves it.
 */
import { appLogger } from "../../core/logging";
import { onPdfContextLoaded } from "../paperContent/contextCache";
import { zoteroChangeDispatcher } from "../zoteroChangeDispatcher";
import { INDEX_USER_IDLE_SECONDS } from "./constants";
import { resolveSemanticSearchState } from "../../utils/llmClient";
import type { LibraryIndexSnapshot } from "../libraryIndex/contracts";
import { libraryIndexService } from "../libraryIndexService";
import {
  closeLibraryTextIndexDb,
  deleteLibraryTextIndexDatabaseFiles,
  isLibraryTextIndexClosedError,
  refuseLibraryTextIndexOpensForQuit,
} from "./db";
import { registerAppQuitBlocker } from "../../utils/appQuitBlocker";
import { libraryTextIndexScheduler, type SchedulerEnv } from "./scheduler";
import { createUserIdleTracker, type UserIdleTracker } from "./userIdle";
import {
  getLibraryTextIndexBudgetBytes,
  isLibraryTextIndexEnabled,
} from "./scheduler";
import {
  readLeadingIndexChunks,
  searchLibraryTextIndex,
  type IndexedChunkHit,
  type LibraryTextIndexSearchParams,
  type LibraryTextIndexSearchResult,
} from "./search";
import { getLibraryTextIndexStore, resetLibraryTextIndexStore } from "./store";
import { clearLoadedVectorState, isVectorsPrefOn } from "./vectorIndexer";
import { removeAllVectorNamespaces } from "./vectorStore";

export { libraryTextIndexScheduler, beginRetrievalActivity } from "./scheduler";
export type { IndexedChunkHit, IndexedPaperHit } from "./search";

export type LibraryTextIndexFacade = {
  isEnabled(): boolean;
  /** Null when the index is disabled, cannot be opened, or the search fails. */
  search(
    params: Omit<LibraryTextIndexSearchParams, "store">,
  ): Promise<LibraryTextIndexSearchResult | null>;
  /**
   * A document's first `k` chunks (body first) as zero-score hits. Null when
   * the index is disabled, cannot be opened, or the read fails.
   */
  leadingChunks(
    attachmentId: number,
    k: number,
  ): Promise<IndexedChunkHit[] | null>;
};
export const libraryTextIndex: LibraryTextIndexFacade = {
  isEnabled: () => isLibraryTextIndexEnabled(),
  async search(params) {
    if (!isLibraryTextIndexEnabled()) return null;
    // The facade owns "never throws": an index failure (locked database,
    // disk I/O) degrades to the direct path instead of failing the question.
    try {
      const store = await getLibraryTextIndexStore();
      return store ? await searchLibraryTextIndex({ ...params, store }) : null;
    } catch (error) {
      // Closed under a running search (stop, Clear): not a failure.
      (isLibraryTextIndexClosedError(error) ? appLogger.debug : appLogger.warn)(
        "LLM index: search failed; falling back to the direct path",
        error,
      );
      return null;
    }
  },
  async leadingChunks(attachmentId, k) {
    if (!isLibraryTextIndexEnabled()) return null;
    try {
      const store = await getLibraryTextIndexStore();
      return store
        ? await readLeadingIndexChunks(store, attachmentId, k)
        : null;
    } catch (error) {
      (isLibraryTextIndexClosedError(error) ? appLogger.debug : appLogger.warn)(
        "LLM index: leading-chunk read failed",
        error,
      );
      return null;
    }
  },
};

let unsubscribeChanges: (() => void) | null = null;
let unsubscribeContexts: (() => void) | null = null;
let idleTracker: UserIdleTracker | null = null;
let restoreEnv: Partial<SchedulerEnv> | null = null;
/** The last start's overrides, so a clear restarts the index the same way. */
let lastEnvOverride: Partial<SchedulerEnv> = {};
let unregisterQuitBlocker: (() => void) | null = null;

/**
 * Starts the background fill. Deferred startup work: it never opens a
 * transaction on `Zotero.DB` (#485), and all index SQL goes through the
 * separate index connection. Reconcile does read the library through the
 * shared library snapshot (`Zotero.Items.getAll`, read-only): for the user
 * library, and for a group library only when Zotero has already loaded it or
 * the index already holds some of its papers.
 */
export async function startLibraryTextIndex(
  envOverride: Partial<SchedulerEnv> = {},
): Promise<void> {
  if (idleTracker) await stopLibraryTextIndex();
  lastEnvOverride = envOverride;
  // Quitting skips onShutdown, and Zotero's exit waits for the index's
  // connection: stop the background work and close it here instead.
  unregisterQuitBlocker = registerAppQuitBlocker(
    "LLM for Zotero: stop the library text index",
    async () => {
      unregisterQuitBlocker = null;
      refuseLibraryTextIndexOpensForQuit();
      await stopLibraryTextIndex();
    },
  );
  const scheduler = libraryTextIndexScheduler as unknown as {
    env: SchedulerEnv;
  };
  const tracker = createUserIdleTracker(INDEX_USER_IDLE_SECONDS);
  idleTracker = tracker;
  const replaced: Partial<SchedulerEnv> = {
    isUserIdle: () => tracker.isIdle(),
    ...envOverride,
  };
  restoreEnv = Object.fromEntries(
    Object.keys(replaced).map((key) => [
      key,
      scheduler.env[key as keyof SchedulerEnv],
    ]),
  ) as Partial<SchedulerEnv>;
  Object.assign(scheduler.env, replaced);
  tracker.onChange((idle) => libraryTextIndexScheduler.onUserIdleChange(idle));
  // Ordered, but never holds up the dispatcher's other listeners.
  let changeTail: Promise<void> = Promise.resolve();
  unsubscribeChanges = zoteroChangeDispatcher.subscribe(
    "library-text-index",
    (change) => {
      changeTail = changeTail
        .then(() => libraryTextIndexScheduler.handleChange(change))
        .catch((error) =>
          appLogger.debug("LLM index: change handling failed", error),
        );
    },
  );
  unsubscribeContexts = onPdfContextLoaded((itemId) =>
    libraryTextIndexScheduler.handleContextLoaded(itemId),
  );
  libraryTextIndexScheduler.start();
  // Disabled: stay subscribed (every handler re-checks the pref) but never
  // open, and so never create, the index database.
  if (!scheduler.env.isEnabled()) return;
  await libraryTextIndexScheduler.reconcileAll();
}

export async function stopLibraryTextIndex(): Promise<void> {
  unregisterQuitBlocker?.();
  unregisterQuitBlocker = null;
  unsubscribeChanges?.();
  unsubscribeChanges = null;
  unsubscribeContexts?.();
  unsubscribeContexts = null;
  idleTracker?.dispose();
  idleTracker = null;
  await libraryTextIndexScheduler.stop();
  if (restoreEnv) {
    Object.assign(
      (libraryTextIndexScheduler as unknown as { env: SchedulerEnv }).env,
      restoreEnv,
    );
    restoreEnv = null;
  }
  // Awaits an open still in flight so its handle cannot leak past shutdown.
  await closeLibraryTextIndexDb();
}

// ── Management (the Customization tab's "Library index" section) ───────────

export type LibraryTextIndexOverview = {
  enabled: boolean;
  vectorsEnabled: boolean;
  semanticAvailable: boolean;
  indexed: number;
  /** Context-eligible PDF attachments in the user library. */
  eligible: number;
  queued: number;
  failed: number;
  building: boolean;
  usedBytes: number;
  budgetBytes: number;
  dbBytes: number;
  vectorBytes: number;
  vectorNamespace: string | null;
};

export type LibraryTextIndexOverviewOptions = {
  getSnapshot?: (libraryID: number) => Promise<LibraryIndexSnapshot>;
};

function managedLibraryID(): number {
  return (
    (globalThis as { Zotero?: { Libraries?: { userLibraryID?: number } } })
      .Zotero?.Libraries?.userLibraryID ?? 1
  );
}

function isSemanticSearchAvailable(): boolean {
  try {
    return resolveSemanticSearchState().enabled;
  } catch {
    return false;
  }
}

function countEligible(snapshot: LibraryIndexSnapshot): number {
  let eligible = 0;
  for (const attachmentIds of snapshot.pdfAttachmentIdsByItemId.values()) {
    for (const attachmentId of attachmentIds) {
      if (snapshot.attachmentById.get(attachmentId)?.isContextEligiblePdf)
        eligible += 1;
    }
  }
  return eligible;
}

/**
 * What the settings pane shows for the user library. Never throws (a failed
 * part reads as zero) and, with the index off, never opens the database.
 */
export async function getLibraryTextIndexOverview(
  options: LibraryTextIndexOverviewOptions = {},
): Promise<LibraryTextIndexOverview> {
  const enabled = isLibraryTextIndexEnabled();
  const overview: LibraryTextIndexOverview = {
    enabled,
    vectorsEnabled: isVectorsPrefOn(),
    semanticAvailable: isSemanticSearchAvailable(),
    indexed: 0,
    eligible: 0,
    queued: 0,
    failed: 0,
    building: false,
    usedBytes: 0,
    budgetBytes: getLibraryTextIndexBudgetBytes(),
    dbBytes: 0,
    vectorBytes: 0,
    vectorNamespace: null,
  };
  if (!enabled) return overview;
  const libraryID = managedLibraryID();
  const getSnapshot =
    options.getSnapshot ||
    ((id: number) => libraryIndexService.getSnapshot(id));
  try {
    overview.eligible = countEligible(await getSnapshot(libraryID));
  } catch (error) {
    appLogger.debug("LLM index: overview could not read the library", error);
  }
  try {
    const status = await libraryTextIndexScheduler.getStatus(libraryID);
    Object.assign(overview, {
      indexed: status.indexed,
      queued: status.queued,
      failed: status.failed,
      building: status.building,
      usedBytes: status.usedBytes,
      budgetBytes: status.budgetBytes,
      dbBytes: status.dbBytes,
      vectorBytes: status.vectorBytes,
      vectorNamespace: status.vectorNamespace,
    });
  } catch (error) {
    appLogger.debug("LLM index: overview could not read the index", error);
  }
  return overview;
}

let managementTail: Promise<void> = Promise.resolve();
let clearFailureLogged = false;

/** Runs management actions one at a time: a second call awaits the first. */
function serialized(action: () => Promise<void>): Promise<void> {
  const run = managementTail.then(action, action);
  managementTail = run.catch(() => undefined);
  return run;
}

async function clearNow(): Promise<void> {
  // Every step is attempted; the first failure is rethrown once at the end,
  // so the settings pane can say that Clear did not fully work.
  let failure: unknown = null;
  const note = (error: unknown) => {
    failure ??= error;
    if (!clearFailureLogged) {
      clearFailureLogged = true;
      appLogger.warn("LLM index: could not clear the index", error);
    }
  };
  // Stop first: stop() lets a job mid-write finish (bounded by the grace
  // period) and closes the connection, so nothing races the delete.
  try {
    await stopLibraryTextIndex();
  } catch (error) {
    note(error);
  }
  // Best effort, each independently: a locked file must not keep the other.
  for (const remove of [
    deleteLibraryTextIndexDatabaseFiles,
    removeAllVectorNamespaces,
  ]) {
    try {
      await remove();
    } catch (error) {
      note(error);
    }
  }
  resetLibraryTextIndexStore();
  clearLoadedVectorState();
  try {
    if (isLibraryTextIndexEnabled())
      await startLibraryTextIndex(lastEnvOverride);
  } catch (error) {
    note(error);
  }
  if (failure !== null) throw failure;
  appLogger.info("LLM index: cleared");
}

/**
 * Deletes the index database and every embedding file, then (when the index
 * is enabled) starts it again, which reconciles the library and refills.
 * Idempotent and safe when the index was never created. Rejects with the
 * first failure (a file in use, a failed restart) after trying every step.
 */
export function clearLibraryTextIndex(): Promise<void> {
  return serialized(clearNow);
}

/**
 * Starts the index over. A fresh start reconciles every eligible paper, and
 * write-through from questions plus idle prefetch refill it.
 */
export function rebuildLibraryTextIndex(): Promise<void> {
  return serialized(clearNow);
}
