import {
  zoteroChangeDispatcher,
  type ZoteroChangeEvent,
} from "./zoteroChangeDispatcher";
import { patchMap, patchSet } from "./libraryIndex/readonlyCollections";
import { SnapshotDraft } from "./libraryIndex/snapshotDraft";
import { reconcileItems } from "./libraryIndex/itemReconciler";
import { reconcileCollections } from "./libraryIndex/collectionReconciler";
import type {
  LibraryIndexAttachment,
  LibraryIndexChildNote,
  LibraryIndexCollection,
  LibraryIndexItem,
  LibraryIndexMetrics,
  LibraryIndexSearchableFields,
  LibraryIndexSnapshot,
  LibraryIndexTag,
} from "./libraryIndex/contracts";
import {
  normalizeLibraryIndexTagIdentity,
  positiveIds,
  projectItem,
  rebuildDerived,
  resolveLibraryName,
  sameNumberMembers,
  sameStringMembers,
  searchable,
  text,
} from "./libraryIndex/projection";

export * from "./libraryIndex/contracts";
export {
  normalizeLibraryIndexTagIdentity,
  normalizeLibraryIndexText,
} from "./libraryIndex/projection";

type MutableMetrics = {
  -readonly [K in keyof LibraryIndexMetrics]: number;
};

type PendingIndexChanges = {
  itemIds: Set<number>;
  collectionIds: Set<number>;
  libraryName: boolean;
  fullRebuild: boolean;
  completions: Set<PendingCompletion>;
};

type PendingCompletion = {
  promise: Promise<void>;
  resolve: () => void;
};

type LibraryState = {
  epoch: number;
  snapshot?: LibraryIndexSnapshot;
  loadTask?: Promise<LibraryIndexSnapshot>;
  backgroundRefreshTask?: Promise<void>;
  pendingChanges?: PendingIndexChanges;
  reconciling?: boolean;
  reconciliationTask?: Promise<void>;
  rebuildTimer?: ReturnType<typeof setTimeout>;
};

function pendingCompletion(): PendingCompletion {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function pendingIndexChanges(withCompletion = false): PendingIndexChanges {
  return {
    itemIds: new Set<number>(),
    collectionIds: new Set<number>(),
    libraryName: false,
    fullRebuild: false,
    completions: withCompletion ? new Set([pendingCompletion()]) : new Set(),
  };
}

function hasPendingIndexChanges(changes: PendingIndexChanges): boolean {
  return Boolean(
    changes.fullRebuild ||
    changes.libraryName ||
    changes.itemIds.size ||
    changes.collectionIds.size,
  );
}

function numericNotifierIds(ids: readonly (string | number)[]): number[] {
  const out = new Set<number>();
  for (const value of ids) {
    const direct = Math.floor(Number(value));
    if (Number.isFinite(direct) && direct > 0) out.add(direct);
    if (typeof value === "string") {
      for (const token of value.match(/\d+/g) || []) {
        const id = Math.floor(Number(token));
        if (id > 0) out.add(id);
      }
    }
  }
  return [...out];
}

function relationItemNotifierIds(
  type: string,
  ids: readonly (string | number)[],
  extraData: Readonly<Record<string, unknown>>,
): number[] {
  const out = new Set<number>();
  const add = (value: unknown): void => {
    const id = Math.floor(Number(value));
    if (Number.isFinite(id) && id > 0) out.add(id);
  };
  for (const raw of ids) {
    if (typeof raw === "number") {
      add(raw);
      continue;
    }
    const parts = raw.match(/\d+/g) || [];
    if (type === "item-tag") add(parts[0]);
    else if (type === "collection-item") add(parts[1] ?? parts[0]);
  }
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    add(record.itemID ?? record.itemId);
    add(record.subjectItemID ?? record.subjectItemId);
    add(record.objectItemID ?? record.objectItemId);
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(extraData, 0);
  return [...out];
}

export class LibraryIndexService {
  private readonly states = new Map<number, LibraryState>();
  private metrics: MutableMetrics = {
    fullBuilds: 0,
    itemsGetAllCalls: 0,
    projectedTopLevelItems: 0,
    incrementalItemUpdates: 0,
    incrementalCollectionUpdates: 0,
    coalescedRebuilds: 0,
    staleBuildDiscards: 0,
  };

  constructor(
    private readonly yieldEvery = 250,
    private readonly reconciliationDelayMs = 100,
  ) {}

  getMetrics(): LibraryIndexMetrics {
    return Object.freeze({ ...this.metrics });
  }

  resetMetricsForTests(): void {
    for (const key of Object.keys(this.metrics) as Array<
      keyof MutableMetrics
    >) {
      this.metrics[key] = 0;
    }
  }

  peekSnapshot(libraryID: number): LibraryIndexSnapshot | undefined {
    return this.states.get(Math.floor(libraryID))?.snapshot;
  }

  private pendingChanges(state: LibraryState): PendingIndexChanges {
    state.pendingChanges ||= pendingIndexChanges();
    if (!state.pendingChanges.completions.size) {
      state.pendingChanges.completions.add(pendingCompletion());
    }
    return state.pendingChanges;
  }

  private takePendingChanges(state: LibraryState): PendingIndexChanges {
    const changes = state.pendingChanges || pendingIndexChanges();
    state.pendingChanges = undefined;
    return changes;
  }

  private mergeChanges(
    pending: PendingIndexChanges,
    changes: PendingIndexChanges,
  ): void {
    changes.itemIds.forEach((id) => pending.itemIds.add(id));
    changes.collectionIds.forEach((id) => pending.collectionIds.add(id));
    changes.completions.forEach((completion) =>
      pending.completions.add(completion),
    );
    pending.libraryName ||= changes.libraryName;
    pending.fullRebuild ||= changes.fullRebuild;
  }

  private requeueChanges(
    state: LibraryState,
    changes: PendingIndexChanges,
  ): void {
    if (!hasPendingIndexChanges(changes) && !changes.completions.size) return;
    const pending = (state.pendingChanges ||= pendingIndexChanges());
    this.mergeChanges(pending, changes);
  }

  private completeChanges(changes: PendingIndexChanges): void {
    for (const completion of changes.completions) completion.resolve();
  }

  private shouldQueueChanges(state: LibraryState): boolean {
    return Boolean(
      !state.snapshot ||
      state.loadTask ||
      state.reconciling ||
      state.backgroundRefreshTask,
    );
  }

  private queueItemChanges(state: LibraryState, ids: number[]): void {
    const pending = this.pendingChanges(state);
    ids.forEach((id) => pending.itemIds.add(id));
  }

  private queueCollectionChanges(state: LibraryState, ids: number[]): void {
    const pending = this.pendingChanges(state);
    ids.forEach((id) => pending.collectionIds.add(id));
  }

  private queueLibraryNameChange(state: LibraryState): void {
    this.pendingChanges(state).libraryName = true;
  }

  private queueFullRebuild(state: LibraryState): void {
    state.epoch += 1;
    this.pendingChanges(state).fullRebuild = true;
  }

  private publishSnapshot(
    state: LibraryState,
    snapshot: LibraryIndexSnapshot,
  ): void {
    state.snapshot = Object.freeze({ ...snapshot, epoch: state.epoch });
  }

  private async reconcileChanges(
    libraryID: number,
    state: LibraryState,
    changes: PendingIndexChanges,
    baseSnapshotOverride?: LibraryIndexSnapshot,
  ): Promise<void> {
    state.reconciling = true;
    const installedSnapshot = state.snapshot;
    const baseSnapshot = baseSnapshotOverride || installedSnapshot;
    try {
      if (!baseSnapshot) return;
      const draft = new SnapshotDraft(baseSnapshot, state.epoch);
      if (changes.libraryName) {
        const libraryName = resolveLibraryName(libraryID);
        if (libraryName !== draft.snapshot.libraryName) {
          draft.apply(Object.freeze({ libraryName }));
        }
      }
      const affectedItemIds = new Set(changes.itemIds);
      if (changes.collectionIds.size) {
        const collectionPlan = reconcileCollections(draft.snapshot, libraryID, [
          ...changes.collectionIds,
        ]);
        draft.apply(collectionPlan.delta);
        collectionPlan.membershipAffectedItemIds.forEach((id) =>
          affectedItemIds.add(id),
        );
        this.metrics.incrementalCollectionUpdates +=
          collectionPlan.affectedCollectionCount;
      }
      if (affectedItemIds.size) {
        const itemPlan = reconcileItems(draft.snapshot, libraryID, [
          ...affectedItemIds,
        ]);
        draft.apply(itemPlan.delta);
        this.metrics.incrementalItemUpdates += itemPlan.affectedItemCount;
      }
      if (state.snapshot !== installedSnapshot || state.epoch !== draft.epoch) {
        throw new Error("Library index changed during reconciliation");
      }
      this.publishSnapshot(state, draft.snapshot);
      this.completeChanges(changes);
    } finally {
      state.reconciling = false;
    }
  }

  private schedulePendingReconciliation(libraryID: number): void {
    const state = this.states.get(libraryID);
    if (!state?.snapshot) return;
    if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
    state.rebuildTimer = setTimeout(() => {
      state.rebuildTimer = undefined;
      if (
        (state.loadTask && !state.snapshot) ||
        state.backgroundRefreshTask ||
        state.reconciling
      ) {
        this.schedulePendingReconciliation(libraryID);
        return;
      }
      const changes = this.takePendingChanges(state);
      if (!hasPendingIndexChanges(changes)) {
        this.completeChanges(changes);
        return;
      }
      if (changes.fullRebuild) {
        this.startBackgroundRefresh(libraryID, state, changes);
        return;
      }
      let failed = false;
      const task = this.reconcileChanges(libraryID, state, changes)
        .catch((error) => {
          failed = true;
          state.snapshot = undefined;
          this.completeChanges(changes);
          globalThis.Zotero?.debug?.(
            `[llm-for-zotero] Library index reconciliation failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          if (state.reconciliationTask === task) {
            state.reconciliationTask = undefined;
          }
          if (
            !failed &&
            state.snapshot &&
            state.pendingChanges &&
            hasPendingIndexChanges(state.pendingChanges)
          ) {
            this.schedulePendingReconciliation(libraryID);
          }
        });
      state.reconciliationTask = task;
    }, this.reconciliationDelayMs);
  }

  private startBackgroundRefresh(
    libraryID: number,
    state: LibraryState,
    coveredChanges: PendingIndexChanges,
  ): void {
    if (state.backgroundRefreshTask) {
      this.requeueChanges(state, coveredChanges);
      return;
    }
    this.metrics.coalescedRebuilds += 1;
    let failed = false;
    const task = (async () => {
      const buildEpoch = state.epoch;
      const snapshot = await this.buildSnapshot(libraryID, buildEpoch);
      const trailing = this.takePendingChanges(state);
      if (state.epoch !== buildEpoch || trailing.fullRebuild) {
        this.metrics.staleBuildDiscards += 1;
        this.mergeChanges(trailing, coveredChanges);
        trailing.fullRebuild = true;
        this.requeueChanges(state, trailing);
        return;
      }
      if (hasPendingIndexChanges(trailing)) {
        await this.reconcileChanges(libraryID, state, trailing, snapshot);
        this.completeChanges(coveredChanges);
      } else {
        this.publishSnapshot(state, snapshot);
        this.completeChanges(coveredChanges);
      }
      const duringReconciliation = this.takePendingChanges(state);
      if (trailing.fullRebuild) {
        duringReconciliation.fullRebuild = true;
      }
      this.requeueChanges(state, duringReconciliation);
    })()
      .catch((error) => {
        failed = true;
        this.completeChanges(coveredChanges);
        // A snapshot that could not be refreshed must not keep serving
        // peek-only consumers indefinitely: drop it so reads fall back to
        // live Zotero data and the next getSnapshot rebuilds.
        state.snapshot = undefined;
        globalThis.Zotero?.debug?.(
          `[llm-for-zotero] Library index rebuild failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        if (state.backgroundRefreshTask === task) {
          state.backgroundRefreshTask = undefined;
        }
        if (
          !failed &&
          state.pendingChanges &&
          hasPendingIndexChanges(state.pendingChanges)
        ) {
          this.schedulePendingReconciliation(libraryID);
        }
      });
    state.backgroundRefreshTask = task;
  }

  private async loadInitialSnapshot(
    libraryID: number,
    state: LibraryState,
  ): Promise<LibraryIndexSnapshot> {
    let snapshot = await this.buildSnapshot(libraryID, state.epoch);
    let changes = this.takePendingChanges(state);
    if (changes.fullRebuild) {
      this.metrics.staleBuildDiscards += 1;
      const coveredCompletions = [...changes.completions];
      snapshot = await this.buildSnapshot(libraryID, state.epoch);
      changes = this.takePendingChanges(state);
      coveredCompletions.forEach((completion) =>
        changes.completions.add(completion),
      );
    }
    const needsBackgroundRefresh = changes.fullRebuild;
    const appliedChanges = needsBackgroundRefresh
      ? {
          ...changes,
          fullRebuild: false,
          completions: new Set<PendingCompletion>(),
        }
      : changes;
    try {
      if (hasPendingIndexChanges(appliedChanges)) {
        await this.reconcileChanges(libraryID, state, appliedChanges, snapshot);
      } else {
        this.publishSnapshot(state, snapshot);
        this.completeChanges(appliedChanges);
      }
    } catch (error) {
      state.snapshot = undefined;
      throw error;
    }
    const trailing = this.takePendingChanges(state);
    if (needsBackgroundRefresh) {
      trailing.fullRebuild = true;
      changes.completions.forEach((completion) =>
        trailing.completions.add(completion),
      );
    }
    this.requeueChanges(state, trailing);
    if (hasPendingIndexChanges(trailing)) {
      this.schedulePendingReconciliation(libraryID);
    }
    if (needsBackgroundRefresh) {
      await Promise.all(
        [...changes.completions].map((completion) => completion.promise),
      );
      if (!state.snapshot) {
        const recovery = await this.buildSnapshot(libraryID, state.epoch);
        const recoveryChanges = this.takePendingChanges(state);
        if (hasPendingIndexChanges(recoveryChanges)) {
          await this.reconcileChanges(
            libraryID,
            state,
            recoveryChanges,
            recovery,
          );
        } else {
          this.publishSnapshot(state, recovery);
          this.completeChanges(recoveryChanges);
        }
      }
    }
    return state.snapshot!;
  }

  async getSnapshot(libraryID: number): Promise<LibraryIndexSnapshot> {
    const normalized = Math.floor(Number(libraryID));
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new Error("A positive library ID is required");
    }
    let state = this.states.get(normalized);
    if (!state) {
      state = { epoch: 0 };
      this.states.set(normalized, state);
    }
    if (state.snapshot) {
      if (
        state.pendingChanges &&
        hasPendingIndexChanges(state.pendingChanges) &&
        !state.rebuildTimer &&
        !state.backgroundRefreshTask &&
        !state.reconciling
      ) {
        this.schedulePendingReconciliation(normalized);
      }
      const pendingTask = state.pendingChanges?.completions.values().next()
        .value?.promise;
      const activeTask =
        state.reconciliationTask || state.backgroundRefreshTask || pendingTask;
      if (activeTask) {
        await activeTask;
        return this.getSnapshot(normalized);
      }
      return state.snapshot;
    }
    if (state.loadTask) return state.loadTask;
    const task = this.loadInitialSnapshot(normalized, state).finally(() => {
      const current = this.states.get(normalized);
      if (current?.loadTask === task) current.loadTask = undefined;
    });
    state.loadTask = task;
    return task;
  }

  invalidate(libraryID?: number): void {
    if (Number.isFinite(libraryID) && Number(libraryID) > 0) {
      const id = Math.floor(Number(libraryID));
      const state = this.states.get(id) || { epoch: 0 };
      if (state.loadTask || state.backgroundRefreshTask) {
        this.queueFullRebuild(state);
        // The in-flight build may predate this invalidation. Drop the
        // published snapshot so reads fall back to live Zotero data instead
        // of serving pre-invalidation state (read-your-writes for the agent
        // write tools); the queued full rebuild restores the index.
        state.snapshot = undefined;
        this.states.set(id, state);
        return;
      }
      state.epoch += 1;
      state.snapshot = undefined;
      this.states.set(id, state);
      return;
    }
    for (const state of this.states.values()) {
      if (state.loadTask || state.backgroundRefreshTask) {
        this.queueFullRebuild(state);
        state.snapshot = undefined;
        continue;
      }
      state.epoch += 1;
      state.snapshot = undefined;
    }
  }

  clearForTests(): void {
    for (const state of this.states.values()) {
      if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
      if (state.pendingChanges) this.completeChanges(state.pendingChanges);
    }
    this.states.clear();
    this.resetMetricsForTests();
  }

  private async buildSnapshot(
    libraryID: number,
    epoch: number,
  ): Promise<LibraryIndexSnapshot> {
    this.metrics.fullBuilds += 1;
    this.metrics.itemsGetAllCalls += 1;
    const rawItems: Zotero.Item[] = await Zotero.Items.getAll(
      libraryID,
      true,
      true,
      false,
    );
    const itemById = new Map<number, LibraryIndexItem>();
    const topLevelItemOrder: number[] = [];
    const attachmentById = new Map<number, LibraryIndexAttachment>();
    const childAttachmentIdsByItemId = new Map<number, readonly number[]>();
    const pdfAttachmentIdsByItemId = new Map<number, readonly number[]>();
    const childNoteIdsByItemId = new Map<number, readonly number[]>();
    const childNoteById = new Map<number, LibraryIndexChildNote>();
    const parentItemIdByChildId = new Map<number, number>();
    const searchableFieldsByItemId = new Map<
      number,
      LibraryIndexSearchableFields
    >();
    let projectedCount = 0;
    for (const rawItem of rawItems) {
      const projected = projectItem(rawItem);
      if (!projected || projected.item.libraryID !== libraryID) continue;
      const record = projected.item;
      itemById.set(record.itemId, record);
      topLevelItemOrder.push(record.itemId);
      const attachmentIds = projected.attachments.map(
        (attachment) => attachment.attachmentId,
      );
      childAttachmentIdsByItemId.set(
        record.itemId,
        Object.freeze(attachmentIds),
      );
      pdfAttachmentIdsByItemId.set(
        record.itemId,
        Object.freeze(
          projected.attachments
            .filter((attachment) => attachment.isContextEligiblePdf)
            .map((attachment) => attachment.attachmentId),
        ),
      );
      childNoteIdsByItemId.set(
        record.itemId,
        Object.freeze([...projected.childNoteIds]),
      );
      for (const note of projected.childNotes) {
        childNoteById.set(note.noteId, note);
        parentItemIdByChildId.set(note.noteId, record.itemId);
      }
      for (const attachment of projected.attachments) {
        attachmentById.set(attachment.attachmentId, attachment);
        if (attachment.parentItemId) {
          parentItemIdByChildId.set(
            attachment.attachmentId,
            attachment.parentItemId,
          );
        }
      }
      searchableFieldsByItemId.set(
        record.itemId,
        searchable(record, projected.attachmentTitles),
      );
      projectedCount += 1;
      if (projectedCount % this.yieldEvery === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    this.metrics.projectedTopLevelItems += projectedCount;
    const partial = {
      libraryID,
      libraryName: resolveLibraryName(libraryID),
      epoch,
      builtAt: Date.now(),
      itemById,
      topLevelItemOrder: Object.freeze(topLevelItemOrder),
      attachmentById,
      childAttachmentIdsByItemId,
      pdfAttachmentIdsByItemId,
      childNoteIdsByItemId,
      childNoteById,
      parentItemIdByChildId,
      searchableFieldsByItemId,
    };
    return rebuildDerived(partial);
  }

  private libraryIDsForItemIds(ids: number[]): Set<number> {
    const libraryIDs = new Set<number>();
    for (const id of ids) {
      let ownerResolved = false;
      const live = Zotero.Items.get(id) || null;
      if (Number(live?.libraryID) > 0) {
        libraryIDs.add(Number(live?.libraryID));
        ownerResolved = true;
      }
      for (const [libraryID, state] of this.states) {
        if (
          state.snapshot?.itemById.has(id) ||
          state.snapshot?.childNoteById.has(id) ||
          state.snapshot?.attachmentById.has(id)
        ) {
          libraryIDs.add(libraryID);
          ownerResolved = true;
        }
      }
      if (!ownerResolved) {
        // Delete/erase notifications often arrive after Zotero has removed the
        // live object. A cold build has no installed ownership map yet, so any
        // unresolved ID must invalidate every in-flight candidate build. This
        // is deliberately conservative and prevents a projected-but-erased
        // object from being installed when multiple libraries are loading.
        for (const [libraryID, state] of this.states) {
          if (state.loadTask) libraryIDs.add(libraryID);
        }
      }
    }
    return libraryIDs;
  }

  private libraryIDsForCollectionIds(ids: number[]): Set<number> {
    const libraryIDs = new Set<number>();
    for (const id of ids) {
      let ownerResolved = false;
      let live: Zotero.Collection | null = null;
      try {
        live = Zotero.Collections.get(id) || null;
      } catch {
        live = null;
      }
      if (Number(live?.libraryID) > 0) {
        libraryIDs.add(Number(live?.libraryID));
        ownerResolved = true;
      }
      for (const [libraryID, state] of this.states) {
        if (state.snapshot?.collectionById.has(id)) {
          libraryIDs.add(libraryID);
          ownerResolved = true;
        }
      }
      if (!ownerResolved) {
        for (const [libraryID, state] of this.states) {
          if (state.loadTask) libraryIDs.add(libraryID);
        }
      }
    }
    return libraryIDs;
  }

  private libraryIDsForGroupIds(ids: number[]): Set<number> {
    const libraryIDs = new Set<number>();
    const groups = (
      Zotero as unknown as {
        Groups?: {
          get?: (groupID: number) => { libraryID?: unknown } | undefined;
          getLibraryIDFromGroupID?: (
            groupID: number,
          ) => number | false | undefined;
        };
      }
    ).Groups;
    for (const id of ids) {
      try {
        const libraryID = Number(
          groups?.getLibraryIDFromGroupID?.(id) ?? groups?.get?.(id)?.libraryID,
        );
        if (Number.isFinite(libraryID) && libraryID > 0) {
          libraryIDs.add(Math.floor(libraryID));
          continue;
        }
      } catch {
        // A deleted group may already be absent from Zotero's group cache.
      }
      // Some synthetic and legacy notifier producers send the library ID
      // directly. Only accept that interpretation for a state we own.
      if (this.states.has(id)) libraryIDs.add(id);
    }
    return libraryIDs;
  }

  private scheduleRebuild(libraryID: number): void {
    const state = this.states.get(libraryID);
    if (!state) return;
    this.queueFullRebuild(state);
    if (state.snapshot) this.schedulePendingReconciliation(libraryID);
  }

  async handleChange(change: ZoteroChangeEvent): Promise<void> {
    const ids = numericNotifierIds(change.ids);
    const explicitLibraryID = Math.floor(
      Number(
        (change.extraData as { libraryID?: unknown; libraryId?: unknown })
          .libraryID || (change.extraData as { libraryId?: unknown }).libraryId,
      ),
    );
    if (
      change.event === "refresh" ||
      change.event === "redraw" ||
      change.type === "refresh"
    ) {
      const refreshLibraryIDs = new Set<number>();
      if (explicitLibraryID > 0) refreshLibraryIDs.add(explicitLibraryID);
      // Zotero's refresh:trash notification carries library IDs in `ids`,
      // not item IDs. Resolve this shape before ownership lookup so an item
      // whose ID equals a library ID cannot divert the invalidation.
      if (change.event === "refresh" && change.type === "trash") {
        ids.forEach((libraryID) => refreshLibraryIDs.add(libraryID));
      }
      for (const libraryID of refreshLibraryIDs.size
        ? refreshLibraryIDs
        : this.states.keys()) {
        this.scheduleRebuild(libraryID);
      }
      return;
    }
    if (change.type === "group") {
      const groupLibraryIDs = this.libraryIDsForGroupIds(ids);
      if (explicitLibraryID > 0) groupLibraryIDs.add(explicitLibraryID);
      if (!groupLibraryIDs.size && this.states.size === 1) {
        groupLibraryIDs.add(this.states.keys().next().value as number);
      }
      for (const libraryID of groupLibraryIDs) {
        const state = this.states.get(libraryID);
        if (!state) continue;
        this.queueLibraryNameChange(state);
        if (state.snapshot) this.schedulePendingReconciliation(libraryID);
      }
      return;
    }
    const libraryIDs =
      change.type === "collection"
        ? this.libraryIDsForCollectionIds(ids)
        : this.libraryIDsForItemIds(ids);
    if (explicitLibraryID > 0) libraryIDs.add(explicitLibraryID);
    if (!libraryIDs.size && this.states.size === 1) {
      libraryIDs.add(this.states.keys().next().value as number);
    }
    if (change.type === "item" || change.type === "file") {
      for (const libraryID of libraryIDs) {
        const state = this.states.get(libraryID);
        if (!state) continue;
        this.queueItemChanges(state, ids);
        if (state.snapshot) this.schedulePendingReconciliation(libraryID);
      }
      return;
    }
    if (change.type === "collection") {
      for (const libraryID of libraryIDs.size
        ? libraryIDs
        : this.states.keys()) {
        if (!ids.length) {
          this.scheduleRebuild(libraryID);
          continue;
        }
        const state = this.states.get(libraryID);
        if (!state) continue;
        this.queueCollectionChanges(state, ids);
        if (state.snapshot) this.schedulePendingReconciliation(libraryID);
      }
      return;
    }
    if (
      change.type === "collection-item" ||
      change.type === "item-tag" ||
      change.type === "relation"
    ) {
      const itemIds = relationItemNotifierIds(
        change.type,
        change.ids,
        change.extraData,
      );
      if (!itemIds.length && change.type === "relation") {
        const candidates =
          explicitLibraryID > 0 ? [explicitLibraryID] : [...this.states.keys()];
        for (const libraryID of candidates) {
          const state = this.states.get(libraryID);
          if (!state) continue;
          this.queueFullRebuild(state);
          if (state.snapshot) this.schedulePendingReconciliation(libraryID);
        }
        return;
      }
      const relationLibraries = this.libraryIDsForItemIds(itemIds);
      if (explicitLibraryID > 0) relationLibraries.add(explicitLibraryID);
      for (const libraryID of relationLibraries) {
        const state = this.states.get(libraryID);
        if (!state) continue;
        this.queueItemChanges(state, itemIds);
        if (state.snapshot) this.schedulePendingReconciliation(libraryID);
      }
      return;
    }
    if (change.type === "tag") {
      // Resolve only the members of the changed tag. The old reverse mapping
      // covers rename/delete, while Zotero's current membership covers a new
      // or merged tag. No full-library projection is needed.
      for (const [libraryID, state] of this.states) {
        if (this.shouldQueueChanges(state)) {
          this.queueFullRebuild(state);
          if (state.snapshot) this.schedulePendingReconciliation(libraryID);
          continue;
        }
        const snapshot = state.snapshot;
        if (!snapshot) continue;
        const tagNames = Array.isArray(
          (change.extraData as { tagNames?: unknown }).tagNames,
        )
          ? ((change.extraData as { tagNames: unknown[] }).tagNames || [])
              .map(text)
              .filter(Boolean)
          : [];
        if (!ids.length && !tagNames.length) {
          this.scheduleRebuild(libraryID);
          continue;
        }
        const affected = new Set<number>();
        for (const tagId of ids) {
          const oldName = snapshot.normalizedTagNameByTagId.get(tagId);
          if (oldName) {
            const oldTag = snapshot.tagByNormalizedName.get(oldName);
            for (const itemId of oldTag?.manualItemIds || [])
              affected.add(itemId);
            for (const itemId of oldTag?.automaticItemIds || []) {
              affected.add(itemId);
            }
          }
          try {
            for (const itemId of await Zotero.Tags.getTagItems(
              libraryID,
              tagId,
            )) {
              affected.add(itemId);
            }
          } catch {
            // Deleted tags no longer have current members; the old mapping
            // above is sufficient for that case.
          }
        }
        for (const tagName of tagNames) {
          const normalizedName = normalizeLibraryIndexTagIdentity(tagName);
          const oldTag = snapshot.tagByNormalizedName.get(normalizedName);
          for (const itemId of oldTag?.manualItemIds || [])
            affected.add(itemId);
          for (const itemId of oldTag?.automaticItemIds || []) {
            affected.add(itemId);
          }
          // The notifier name is the best source for the current tag ID,
          // while indexed variants cover rename/delete events that report an
          // old spelling. Resolve both: a case-only variant can receive a new
          // Zotero tag ID and introduce members that were not in the old set.
          for (const variant of new Set([
            tagName,
            ...(oldTag?.displayVariants || []),
          ])) {
            try {
              const tagId = Number(Zotero.Tags.getID(variant));
              if (!Number.isFinite(tagId) || tagId <= 0) continue;
              for (const itemId of await Zotero.Tags.getTagItems(
                libraryID,
                tagId,
              )) {
                affected.add(itemId);
              }
            } catch {
              // Deleted/renamed variants may no longer have a current ID.
            }
          }
        }
        if (affected.size) {
          this.queueItemChanges(state, [...affected]);
          this.schedulePendingReconciliation(libraryID);
        } else if (ids.length && !tagNames.length) {
          // An unresolvable tag event is rare and ambiguous. Coalesce it with
          // any sync storm rather than publishing a knowingly stale snapshot.
          this.scheduleRebuild(libraryID);
        }
      }
    }
  }

  orderedItemIds(
    snapshot: LibraryIndexSnapshot,
    candidates?: ReadonlySet<number>,
  ): number[] {
    return candidates
      ? snapshot.topLevelItemOrder.filter((id) => candidates.has(id))
      : [...snapshot.topLevelItemOrder];
  }

  tagItemIds(
    snapshot: LibraryIndexSnapshot,
    name: string,
    includeAutomatic: boolean,
  ): Set<number> {
    const tag = snapshot.tagByNormalizedName.get(
      normalizeLibraryIndexTagIdentity(name),
    );
    if (!tag) return new Set();
    return new Set([
      ...tag.manualItemIds,
      ...(includeAutomatic ? tag.automaticItemIds : []),
    ]);
  }
}

export const libraryIndexService = new LibraryIndexService();

zoteroChangeDispatcher.subscribe("library-index", (change) =>
  libraryIndexService.handleChange(change),
);
