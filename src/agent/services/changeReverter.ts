import type {
  LibraryMutationOperation,
  LibraryMutationState,
} from "./libraryMutationService";
import { LibraryMutationService } from "./libraryMutationService";
import type { ZoteroGateway } from "./zoteroGateway";
import type { AgentToolContext } from "../types";
import {
  claimJournalAction,
  claimJournalStep,
  finalizeRevertedJournalAction,
  listJournalActions,
  updateJournalAction,
  updateJournalStep,
  type JournalActionWithSteps,
  type JournalStep,
} from "../store/changeJournal";
import {
  readRecoveryText,
  readRecoveryBytes,
  sha256Bytes,
  sha256Text,
  type RecoveryPayload,
} from "../store/journalRecoveryBlobStore";
import { withActiveJournalAction } from "./mutationCoordinator";
import {
  atomizeMutationOperationFromHandler,
  isRegisteredLibraryMutationOperation,
  mutationPostconditionIsSatisfied,
} from "./libraryMutation/handlerOperations";
import { canonicalJson } from "./libraryMutation/canonicalJson";
import { MutationStateView } from "./libraryMutation/stateView";

type LibraryOperationsInverse = {
  version: number;
  kind: "library_operations";
  operations: LibraryMutationOperation[];
};

type NoteHtmlInverse = {
  version: number;
  kind: "note_html";
  noteId: number;
  html?: string;
  payload?: RecoveryPayload;
};

type FileInverse = {
  version: number;
  kind: "file";
  operation: "delete" | "restore";
  path: string;
  encoding?: string;
  content?: string;
  payload?: RecoveryPayload;
};

type PreferenceInverse = {
  version: number;
  kind: "preference";
  key: string;
  existed?: boolean;
  value?: unknown;
};

type ScriptItemSnapshot = {
  itemId: number;
  fields: Record<string, string>;
  creators: unknown[];
  tags: Array<{ tag: string; type?: number }>;
  collectionIds: number[];
  parentID?: number;
  deleted?: boolean;
  itemTypeID?: number;
  noteHtml?: string;
  json?: unknown;
};

type ScriptSnapshotsInverse = {
  version: number;
  kind: "script_snapshots";
  payload?: RecoveryPayload;
  snapshots?: ScriptItemSnapshot[];
  createdItemIds?: number[];
  declaredInverses?: unknown[];
  progress?: ScriptReplayProgress;
};

type ScriptReplayProgress = {
  version: 1;
  plannerVersion: 1;
} & (
  | {
      phase: "declared";
      declarationIndex: number;
      unitIndex: number;
    }
  | { phase: "created_items"; itemIndex: number }
  | { phase: "snapshots"; snapshotIndex: number }
  | { phase: "done" }
);

type ScriptSnapshotBundle = {
  snapshots: ScriptItemSnapshot[];
  createdItemIds?: number[];
  declaredInverses?: unknown[];
};

export type JournalInverse =
  | LibraryOperationsInverse
  | NoteHtmlInverse
  | FileInverse
  | PreferenceInverse
  | ScriptSnapshotsInverse;

export type RevertConflict = {
  actionId: string;
  stepId?: string;
  reason: string;
};

export type RevertOutcome = {
  /** Actions whose complete durable inverse was replayed. */
  reverted: number;
  /** Actions whose recorded inverse was replayed but may leave residual effects. */
  partiallyReverted: number;
  residuals: Array<{
    actionId: string;
    description: string;
    reason: string;
  }>;
  skipped: Array<{ entryId: string; reason: string }>;
  conflicts: RevertConflict[];
};

const stable = canonicalJson;

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  return JSON.parse(value) as unknown;
}

export function isMutationOperation(
  value: unknown,
): value is LibraryMutationOperation {
  return isRegisteredLibraryMutationOperation(value);
}

function isRecoveryPayload(value: unknown): value is RecoveryPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    (record.storage !== "inline" && record.storage !== "blob") ||
    typeof record.checksum !== "string" ||
    !Number.isFinite(Number(record.sizeBytes)) ||
    (record.storage === "inline" &&
      record.encoding !== undefined &&
      record.encoding !== "utf8" &&
      record.encoding !== "base64")
  ) {
    return false;
  }
  return record.storage === "inline"
    ? typeof record.content === "string"
    : typeof record.blobPath === "string" && Boolean(record.blobPath);
}

export function parseInverseValue(parsed: unknown): JournalInverse | null {
  if (Array.isArray(parsed) && parsed.every(isMutationOperation)) {
    return { version: 0, kind: "library_operations", operations: parsed };
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (!Number.isFinite(Number(record.version))) return null;
  const kind = record.kind;
  if (
    kind === "library_operations" &&
    Array.isArray(record.operations) &&
    record.operations.every(isMutationOperation)
  ) {
    return parsed as LibraryOperationsInverse;
  }
  if (
    kind === "note_html" &&
    Number(record.noteId) > 0 &&
    (typeof record.html === "string" || isRecoveryPayload(record.payload))
  ) {
    return parsed as NoteHtmlInverse;
  }
  if (
    kind === "file" &&
    (record.operation === "delete" || record.operation === "restore") &&
    typeof record.path === "string" &&
    Boolean(record.path) &&
    (record.operation === "delete" ||
      typeof record.content === "string" ||
      isRecoveryPayload(record.payload))
  ) {
    return parsed as FileInverse;
  }
  if (
    kind === "preference" &&
    typeof record.key === "string" &&
    Boolean(record.key)
  ) {
    return parsed as PreferenceInverse;
  }
  if (
    kind === "script_snapshots" &&
    (isRecoveryPayload(record.payload) || Array.isArray(record.snapshots)) &&
    (!record.snapshots ||
      (Array.isArray(record.snapshots) &&
        record.snapshots.every((snapshot) =>
          Boolean(
            snapshot &&
            typeof snapshot === "object" &&
            Number((snapshot as { itemId?: unknown }).itemId) > 0 &&
            typeof (snapshot as { fields?: unknown }).fields === "object" &&
            Array.isArray((snapshot as { creators?: unknown }).creators) &&
            Array.isArray((snapshot as { tags?: unknown }).tags) &&
            Array.isArray(
              (snapshot as { collectionIds?: unknown }).collectionIds,
            ),
          ),
        ))) &&
    (!record.createdItemIds || Array.isArray(record.createdItemIds)) &&
    (!record.declaredInverses || Array.isArray(record.declaredInverses))
  ) {
    return parsed as ScriptSnapshotsInverse;
  }
  return null;
}

function parseInverse(step: JournalStep): JournalInverse | null {
  if (!step.inverseJson) return null;
  return parseInverseValue(parseJson(step.inverseJson));
}

function captureCurrentScriptItems(
  expectedItems: unknown[],
  service: LibraryMutationService,
): unknown[] {
  return expectedItems.map((entry) => {
    const itemId = Number(
      entry && typeof entry === "object"
        ? (entry as { itemId?: unknown }).itemId
        : 0,
    );
    const item = service.getGateway().getItem(itemId) as any;
    if (!item) return { itemId, exists: false };
    let json: unknown;
    try {
      json = item.toJSON?.();
    } catch {
      json = undefined;
    }
    let noteHtml: string | undefined;
    try {
      if (item.isNote?.()) noteHtml = String(item.getNote?.() ?? "");
    } catch {
      noteHtml = undefined;
    }
    return {
      itemId,
      exists: true,
      ...(json === undefined ? {} : { json }),
      parentID: Number(item.parentID) || null,
      deleted: item.deleted === true,
      tags: item.getTags?.() || [],
      collectionIds: item.getCollections?.() || [],
      ...(noteHtml === undefined ? {} : { noteHtml }),
    };
  });
}

async function captureCurrentScriptDeclaredGuard(params: {
  expected: unknown;
  service: LibraryMutationService;
  context: AgentToolContext;
}): Promise<unknown> {
  if (!params.expected || typeof params.expected !== "object") {
    throw new Error("The script declaration guard is invalid");
  }
  const guard = params.expected as Record<string, unknown>;
  if (guard.kind === "library_operation") {
    if (!isMutationOperation(guard.operation)) {
      throw new Error("The script library-operation guard is invalid");
    }
    return {
      kind: "library_operation",
      operation: guard.operation,
      state: await params.service.captureOperationState(
        guard.operation,
        params.context,
      ),
    };
  }
  if (guard.kind === "note_html") {
    const noteId = Number(guard.noteId);
    const item = params.service.getGateway().getItem(noteId);
    return {
      kind: "note_html",
      noteId,
      checksum: await sha256Text(item?.getNote?.() || ""),
    };
  }
  if (guard.kind === "file") {
    const path = String(guard.path || "");
    const bytes = await readFileBytes(path);
    return {
      kind: "file",
      path,
      exists: bytes !== null,
      checksum: bytes === null ? null : await sha256Bytes(bytes),
    };
  }
  if (guard.kind === "preference") {
    const key = String(guard.key || "");
    const setting = params.service
      .getGateway()
      .listSettings()
      .find((entry) => entry.key === key);
    return {
      kind: "preference",
      key,
      existed: setting?.value !== undefined,
      value: setting?.value,
    };
  }
  throw new Error("The script declaration guard type is unsupported");
}

async function currentStepPostcondition(params: {
  step: JournalStep;
  service: LibraryMutationService;
  context: AgentToolContext;
}): Promise<unknown> {
  const expected = parseJson(params.step.expectedPostconditionJson);
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { version?: unknown }).version === 1 &&
    typeof (expected as { operation?: unknown }).operation === "string"
  ) {
    const operation = parseJson(params.step.forwardJson);
    if (!isMutationOperation(operation)) return undefined;
    return params.service.captureOperationState(
      operation,
      params.context,
      parseJson(params.step.resultJson),
    );
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "script_items"
  ) {
    const expectedItems = (expected as { items?: unknown }).items;
    if (!Array.isArray(expectedItems)) return undefined;
    const items = captureCurrentScriptItems(expectedItems, params.service);
    return { kind: "script_items", items };
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "script_effects"
  ) {
    const expectedItems = (expected as { items?: unknown }).items;
    const expectedDeclared = (expected as { declared?: unknown }).declared;
    if (!Array.isArray(expectedItems) || !Array.isArray(expectedDeclared)) {
      return undefined;
    }
    const declared = [];
    for (const guard of expectedDeclared) {
      declared.push(
        await captureCurrentScriptDeclaredGuard({
          expected: guard,
          service: params.service,
          context: params.context,
        }),
      );
    }
    return {
      kind: "script_effects",
      items: captureCurrentScriptItems(expectedItems, params.service),
      declared,
    };
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "created_item"
  ) {
    const record = expected as Record<string, unknown>;
    const itemId = Number(record.itemId);
    const item = params.service.getGateway().getItem(itemId);
    const current: Record<string, unknown> = {
      kind: "created_item",
      itemId,
      exists: Boolean(item),
    };
    if (Object.prototype.hasOwnProperty.call(record, "parentItemId")) {
      current.parentItemId = item
        ? Number((item as Zotero.Item & { parentID?: unknown }).parentID) ||
          null
        : null;
    }
    if (Object.prototype.hasOwnProperty.call(record, "html")) {
      current.html = item?.getNote?.() || "";
    }
    if (Object.prototype.hasOwnProperty.call(record, "htmlChecksum")) {
      current.htmlChecksum = await sha256Text(item?.getNote?.() || "");
    }
    if (Object.prototype.hasOwnProperty.call(record, "collections")) {
      current.collections = item?.getCollections?.() || [];
    }
    return current;
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "note_html"
  ) {
    const noteId = Number((expected as { noteId?: unknown }).noteId);
    const item = params.service.getGateway().getItem(noteId);
    const html = item?.getNote?.() || "";
    const current: Record<string, unknown> = {
      kind: "note_html",
      noteId,
    };
    if (Object.prototype.hasOwnProperty.call(expected, "checksum")) {
      current.checksum = await sha256Text(html);
    } else {
      current.html = html;
    }
    return current;
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "path"
  ) {
    const record = expected as Record<string, unknown>;
    const path = String(record.path || "");
    const io = (globalThis as { IOUtils?: any }).IOUtils;
    const exists = Boolean(await io?.exists?.(path));
    let pathKind: string | null = null;
    if (exists && typeof io?.stat === "function") {
      const stat = await io.stat(path);
      pathKind =
        stat?.type === "directory"
          ? "directory"
          : stat?.type === "regular" || stat?.type === "file"
            ? "file"
            : null;
    }
    return {
      kind: "path",
      path,
      pathKind,
      exists,
    };
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "file"
  ) {
    const path = String((expected as { path?: unknown }).path || "");
    const bytes = await readFileBytes(path);
    return {
      kind: "file",
      path,
      exists: bytes !== null,
      checksum: bytes === null ? null : await sha256Bytes(bytes),
    };
  }
  if (
    expected &&
    typeof expected === "object" &&
    (expected as { kind?: unknown }).kind === "preference"
  ) {
    const key = String((expected as { key?: unknown }).key || "");
    const value = params.service
      .getGateway()
      .listSettings()
      .find((setting) => setting.key === key)?.value;
    return { kind: "preference", key, existed: value !== undefined, value };
  }
  return undefined;
}

async function conflictForStep(params: {
  actionId: string;
  step: JournalStep;
  service: LibraryMutationService;
  context: AgentToolContext;
}): Promise<RevertConflict | null> {
  if (!params.step.expectedPostconditionJson) {
    return {
      actionId: params.actionId,
      stepId: params.step.stepId,
      reason:
        params.step.status === "uncertain"
          ? "The process stopped before the action's post-image was recorded, so applying its inverse could overwrite a newer change."
          : "This journal step has no expected post-image. Its inverse was skipped because the current object state cannot be verified safely.",
    };
  }
  try {
    const expected = parseJson(params.step.expectedPostconditionJson);
    const current = await currentStepPostcondition(params);
    if (current === undefined) {
      return {
        actionId: params.actionId,
        stepId: params.step.stepId,
        reason:
          "The recorded post-image format cannot be verified by this version, so the inverse was skipped.",
      };
    }
    if (stable(current) !== stable(expected)) {
      return {
        actionId: params.actionId,
        stepId: params.step.stepId,
        reason:
          "The object changed after the agent action; the inverse was skipped to avoid overwriting newer edits.",
      };
    }
    return null;
  } catch (error) {
    return {
      actionId: params.actionId,
      stepId: params.step.stepId,
      reason: `The current state could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function atomizeLibraryOperations(
  operations: LibraryMutationOperation[],
): LibraryMutationOperation[] {
  return operations.flatMap(atomizeMutationOperationFromHandler);
}

const MUTATION_STATE_SECTIONS = [
  "items",
  "collections",
  "savedSearches",
  "libraryTags",
  "relations",
] as const;

type MutationStateSection = (typeof MUTATION_STATE_SECTIONS)[number];
type MutationStateRow = Record<string, unknown>;

function mutationStateIdentity(
  section: MutationStateSection,
  row: MutationStateRow,
): string {
  switch (section) {
    case "items":
      return `item:${Number(row.itemId)}`;
    case "collections":
      return `collection:${Number(row.collectionId)}`;
    case "savedSearches":
      return `search:${Number(row.savedSearchId)}`;
    case "libraryTags":
      return `tag:${Number(row.libraryID)}:${String(row.name || "")}`;
    case "relations":
      return `relation:${Number(row.itemId)}:${Number(row.relatedItemId)}`;
  }
}

function mutationStateMatchesReference(
  current: LibraryMutationState,
  reference: unknown,
): boolean {
  if (!reference || typeof reference !== "object") return false;
  const expected = reference as Record<string, unknown>;
  let comparedRows = 0;
  for (const section of MUTATION_STATE_SECTIONS) {
    const currentRows = current[section] as
      | readonly MutationStateRow[]
      | undefined;
    if (!currentRows?.length) continue;
    const referenceRows = expected[section];
    if (!Array.isArray(referenceRows)) return false;
    const byIdentity = new Map(
      referenceRows
        .filter((row): row is MutationStateRow =>
          Boolean(row && typeof row === "object"),
        )
        .map((row) => [mutationStateIdentity(section, row), row] as const),
    );
    for (const currentRow of currentRows) {
      const referenceRow = byIdentity.get(
        mutationStateIdentity(section, currentRow),
      );
      if (!referenceRow) return false;
      let comparedFields = 0;
      for (const [key, value] of Object.entries(referenceRow)) {
        if (!Object.prototype.hasOwnProperty.call(currentRow, key)) {
          return false;
        }
        if (stable(currentRow[key]) !== stable(value)) return false;
        if (
          key !== "itemId" &&
          key !== "collectionId" &&
          key !== "savedSearchId" &&
          key !== "libraryID" &&
          key !== "name" &&
          key !== "relatedItemId"
        ) {
          comparedFields += 1;
        }
      }
      if (!comparedFields) return false;
      comparedRows += 1;
    }
  }
  return comparedRows > 0;
}

type LibraryReplayClassification =
  | { kind: "pending" }
  | { kind: "completed" }
  | { kind: "conflict"; reason: string };

async function classifyLibraryInverseOperation(params: {
  operation: LibraryMutationOperation;
  step: JournalStep;
  service: LibraryMutationService;
  context: AgentToolContext;
  allowCompleted: boolean;
}): Promise<LibraryReplayClassification> {
  try {
    const current = await params.service.captureOperationState(
      params.operation,
      params.context,
    );
    const currentView = new MutationStateView(current);
    const precondition = parseJson(params.step.preconditionJson);
    if (
      params.allowCompleted &&
      (mutationStateMatchesReference(current, precondition) ||
        mutationPostconditionIsSatisfied(params.operation, currentView))
    ) {
      return { kind: "completed" };
    }
    const expected = parseJson(params.step.expectedPostconditionJson);
    if (
      expected &&
      typeof expected === "object" &&
      (expected as { kind?: unknown }).kind === "created_item"
    ) {
      const customCurrent = await currentStepPostcondition({
        step: params.step,
        service: params.service,
        context: params.context,
      });
      return stable(customCurrent) === stable(expected)
        ? { kind: "pending" }
        : {
            kind: "conflict",
            reason:
              "The inverse target changed after the agent action; replay stopped before overwriting that newer state.",
          };
    }
    if (mutationStateMatchesReference(current, expected)) {
      return { kind: "pending" };
    }
    return {
      kind: "conflict",
      reason: params.step.expectedPostconditionJson
        ? "The inverse target changed after the agent action; replay stopped before overwriting that newer state."
        : "This journal step has no expected post-image for the remaining inverse target.",
    };
  } catch (error) {
    return {
      kind: "conflict",
      reason: `The inverse target could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function collectInverseFailures(value: unknown): string[] {
  const failures: string[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 8 || candidate === null || candidate === undefined) return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof candidate !== "object" || seen.has(candidate as object)) return;
    seen.add(candidate as object);
    const record = candidate as Record<string, unknown>;
    const status = typeof record.status === "string" ? record.status : "";
    if (["error", "failed", "refused", "not_found"].includes(status)) {
      failures.push(
        typeof record.reason === "string" && record.reason
          ? record.reason
          : `inverse target reported ${status}`,
      );
    }
    if (typeof record.failedCount === "number" && record.failedCount > 0) {
      failures.push(`${record.failedCount} inverse target(s) failed`);
    }
    if (typeof record.error === "string" && record.error) {
      failures.push(record.error);
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return [...new Set(failures)];
}

function assertInverseOutcomeSucceeded(value: unknown): void {
  const failures = collectInverseFailures(value);
  if (failures.length) {
    throw new Error(`Inverse operation failed: ${failures.join("; ")}`);
  }
}

class LibraryReplayConflictError extends Error {
  constructor(readonly conflict: RevertConflict) {
    super(conflict.reason);
  }
}

async function conflictForLibraryInverse(params: {
  actionId: string;
  step: JournalStep;
  inverse: LibraryOperationsInverse;
  service: LibraryMutationService;
  context: AgentToolContext;
}): Promise<RevertConflict | null> {
  for (const operation of atomizeLibraryOperations(params.inverse.operations)) {
    const classification = await classifyLibraryInverseOperation({
      operation,
      step: params.step,
      service: params.service,
      context: params.context,
      allowCompleted: params.step.status === "revert_failed",
    });
    if (classification.kind === "conflict") {
      return {
        actionId: params.actionId,
        stepId: params.step.stepId,
        reason: classification.reason,
      };
    }
  }
  return null;
}

async function executeLibraryInverseWithProgress(params: {
  actionId: string;
  step: JournalStep;
  inverse: LibraryOperationsInverse;
  service: LibraryMutationService;
  context: AgentToolContext;
  now: () => number;
}): Promise<void> {
  let remaining = atomizeLibraryOperations(params.inverse.operations);
  const checkpoint = async (): Promise<void> => {
    await updateJournalStep({
      stepId: params.step.stepId,
      status: "reverting",
      inverse: {
        version: params.inverse.version,
        kind: "library_operations",
        operations: remaining,
      },
      now: params.now(),
    });
  };
  // Persist the atomic replay plan before the first independently committed
  // target. A restart can therefore resume from the exact remaining suffix.
  await checkpoint();
  while (remaining.length) {
    const operation = remaining[0];
    const before = await classifyLibraryInverseOperation({
      operation,
      step: params.step,
      service: params.service,
      context: params.context,
      allowCompleted: params.step.status === "revert_failed",
    });
    if (before.kind === "conflict") {
      throw new LibraryReplayConflictError({
        actionId: params.actionId,
        stepId: params.step.stepId,
        reason: before.reason,
      });
    }
    if (before.kind === "pending") {
      const executed = await params.service.executeOperation(
        operation,
        params.context,
      );
      assertInverseOutcomeSucceeded(executed.result);
      const after = await classifyLibraryInverseOperation({
        operation,
        step: params.step,
        service: params.service,
        context: params.context,
        allowCompleted: true,
      });
      if (after.kind !== "completed") {
        throw new Error(
          after.kind === "conflict"
            ? after.reason
            : `Inverse operation ${operation.type} returned without restoring its target`,
        );
      }
    }
    remaining = remaining.slice(1);
    await checkpoint();
  }
}

async function readFile(path: string): Promise<string | null> {
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  try {
    if (!(await io?.exists?.(path))) return null;
    if (typeof io.readUTF8 === "function") return await io.readUTF8(path);
    const bytes = await io.read(path);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  try {
    if (!(await io?.exists?.(path))) return null;
    if (typeof io?.read === "function") {
      return new Uint8Array(await io.read(path));
    }
    if (typeof io?.readUTF8 === "function") {
      return new TextEncoder().encode(await io.readUTF8(path));
    }
    return null;
  } catch {
    return null;
  }
}

async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  if (typeof io?.write !== "function") {
    throw new Error("Binary file writing is unavailable");
  }
  await io.write(path, bytes, { tmpPath: `${path}.journal-tmp` });
}

async function deleteFile(path: string): Promise<void> {
  const io = (globalThis as { IOUtils?: any }).IOUtils;
  if (typeof io?.remove !== "function") {
    throw new Error("File deletion is unavailable");
  }
  await io.remove(path, { ignoreAbsent: true });
}

async function executeScriptSnapshots(
  inverse: ScriptSnapshotsInverse,
  service: LibraryMutationService,
  context: AgentToolContext,
): Promise<void> {
  const bundle = await loadScriptSnapshotBundle(inverse);
  for (const raw of [...(bundle.declaredInverses || [])].reverse()) {
    const declared = parseInverseValue(raw);
    if (!declared || declared.kind === "script_snapshots") {
      throw new Error("A script recorded an unsupported declarative inverse");
    }
    await executeInverse({ inverse: declared, service, context });
  }
  const gateway = service.getGateway();
  if (bundle.createdItemIds?.length) {
    await gateway.trashItems({ itemIds: bundle.createdItemIds });
  }
  for (const snapshot of [...bundle.snapshots].reverse()) {
    await restoreScriptSnapshot(snapshot, gateway);
  }
}

async function loadScriptSnapshotBundle(
  inverse: ScriptSnapshotsInverse,
): Promise<ScriptSnapshotBundle> {
  return inverse.payload
    ? parseScriptSnapshotBundle(await readRecoveryText(inverse.payload))
    : {
        snapshots: inverse.snapshots || [],
        createdItemIds: inverse.createdItemIds,
        declaredInverses: inverse.declaredInverses,
      };
}

async function restoreScriptSnapshot(
  snapshot: ScriptItemSnapshot,
  gateway: ZoteroGateway,
): Promise<void> {
  const item = gateway.getItem(snapshot.itemId);
  if (!item) {
    throw new Error(`Snapshotted item ${snapshot.itemId} no longer exists`);
  }
  try {
    if (
      snapshot.itemTypeID !== undefined &&
      (item as Zotero.Item & { itemTypeID?: number }).itemTypeID !==
        snapshot.itemTypeID
    ) {
      (item as Zotero.Item & { setType?: (id: number) => void }).setType?.(
        snapshot.itemTypeID,
      );
    }
  } catch {
    // Continue with the fields that remain valid for the current type.
  }
  try {
    if (snapshot.json && typeof (item as any).fromJSON === "function") {
      (item as any).fromJSON(snapshot.json);
    }
  } catch {
    // Explicit fields below still provide a useful partial restore.
  }
  if (snapshot.parentID !== undefined) {
    (item as Zotero.Item & { parentID?: number | false }).parentID =
      snapshot.parentID || false;
  }
  if (snapshot.noteHtml !== undefined && typeof item.setNote === "function") {
    item.setNote(snapshot.noteHtml);
  }
  for (const [field, value] of Object.entries(snapshot.fields)) {
    try {
      item.setField(field as _ZoteroTypes.Item.ItemField, value);
    } catch {
      // Snapshot fields unsupported by this item type are intentionally
      // ignored, matching Zotero's own restore semantics.
    }
  }
  if (typeof item.setCreators === "function") {
    item.setCreators(snapshot.creators as _ZoteroTypes.Item.Creator[]);
  }
  const currentTags = (item.getTags?.() || []).map((entry: any) =>
    String(entry?.tag || entry || ""),
  );
  for (const tag of currentTags) item.removeTag?.(tag);
  for (const tag of snapshot.tags) item.addTag?.(tag.tag, tag.type);
  const currentCollections = item.getCollections?.() || [];
  for (const id of currentCollections) item.removeFromCollection?.(id);
  for (const id of snapshot.collectionIds) item.addToCollection?.(id);
  (item as Zotero.Item & { deleted?: boolean }).deleted =
    snapshot.deleted === true;
  await item.saveTx();
}

function parseScriptSnapshotBundle(value: string): ScriptSnapshotBundle {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("The script recovery payload is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const candidate = {
    version: 1,
    kind: "script_snapshots",
    snapshots: record.snapshots,
    createdItemIds: record.createdItemIds,
    declaredInverses: record.declaredInverses,
  };
  const inverse = parseInverseValue(candidate);
  if (!inverse || inverse.kind !== "script_snapshots") {
    throw new Error("The script recovery payload is invalid");
  }
  return {
    snapshots: inverse.snapshots || [],
    createdItemIds: inverse.createdItemIds,
    declaredInverses: inverse.declaredInverses,
  };
}

type ScriptDeclaredReplayUnit = {
  inverse: Exclude<JournalInverse, ScriptSnapshotsInverse>;
  guard: unknown;
  /** Atoms from one operation share coverage; distinct operations may not. */
  coverageGroup: number;
};

type ScriptReplayPlan = {
  bundle: ScriptSnapshotBundle;
  declaredUnits: ScriptDeclaredReplayUnit[][];
  expectedItemById: Map<number, unknown>;
};

type ScriptReplayUnit =
  | { kind: "declared"; value: ScriptDeclaredReplayUnit }
  | { kind: "created_item"; itemId: number; expected: unknown }
  | { kind: "snapshot"; snapshot: ScriptItemSnapshot; expected: unknown };

function libraryReplayResourceKeys(
  operation: LibraryMutationOperation,
): string[] {
  if (operation.type === "relate_items") {
    return operation.relatedItemIds.map((relatedItemId) => {
      const pair = [operation.itemId, relatedItemId].sort(
        (left, right) => left - right,
      );
      return `relation:${pair[0]}:${pair[1]}`;
    });
  }
  const record = operation as unknown as Record<string, unknown>;
  const keys = new Set<string>();
  const addItem = (value: unknown): void => {
    const id = Math.floor(Number(value));
    if (Number.isFinite(id) && id > 0) keys.add(`item:${id}`);
  };
  for (const name of ["itemId", "attachmentId", "noteId"]) {
    addItem(record[name]);
  }
  for (const name of ["itemIds", "otherItemIds"]) {
    const values = record[name];
    if (Array.isArray(values)) values.forEach(addItem);
  }
  for (const name of ["assignments", "notes"]) {
    const values = record[name];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      addItem(
        (value as { itemId?: unknown; targetItemId?: unknown }).itemId ??
          (value as { targetItemId?: unknown }).targetItemId,
      );
    }
  }
  if (![...keys].some((key) => key.startsWith("item:"))) {
    const collectionId = Math.floor(Number(record.collectionId));
    if (Number.isFinite(collectionId) && collectionId > 0) {
      keys.add(`collection:${collectionId}`);
    }
    const collectionIds = record.collectionIds;
    if (Array.isArray(collectionIds)) {
      for (const value of collectionIds) {
        const id = Math.floor(Number(value));
        if (Number.isFinite(id) && id > 0) keys.add(`collection:${id}`);
      }
    }
  }
  const savedSearchId = Math.floor(Number(record.savedSearchId));
  if (Number.isFinite(savedSearchId) && savedSearchId > 0) {
    keys.add(`saved-search:${savedSearchId}`);
  }
  const savedSearchIds = record.savedSearchIds;
  if (Array.isArray(savedSearchIds)) {
    for (const value of savedSearchIds) {
      const id = Math.floor(Number(value));
      if (Number.isFinite(id) && id > 0) keys.add(`saved-search:${id}`);
    }
  }
  if (operation.type === "update_library_tag") {
    const libraryID = Number(operation.libraryID) || 0;
    keys.add(`tag:${libraryID}:${operation.tag}`);
    if (operation.newTag) keys.add(`tag:${libraryID}:${operation.newTag}`);
  }
  return [...keys];
}

function scriptDeclaredReplayResources(
  inverse: Exclude<JournalInverse, ScriptSnapshotsInverse>,
  guard: unknown,
): { exclusiveKeys: string[]; itemCoverage: number[] } {
  if (inverse.kind === "library_operations") {
    const keys = new Set(inverse.operations.flatMap(libraryReplayResourceKeys));
    const itemCoverage = new Set<number>();
    for (const key of keys) {
      const match = /^item:(\d+)$/.exec(key);
      if (match) itemCoverage.add(Number(match[1]));
    }
    const operation = inverse.operations[0];
    const state =
      guard &&
      typeof guard === "object" &&
      (guard as { kind?: unknown }).kind === "library_operation"
        ? ((guard as { state?: unknown }).state as
            | LibraryMutationState
            | undefined)
        : undefined;
    const claimItem = (value: unknown): void => {
      const itemId = Math.floor(Number(value));
      if (Number.isFinite(itemId) && itemId > 0) itemCoverage.add(itemId);
    };
    if (operation?.type === "relate_items") {
      claimItem(operation.itemId);
      operation.relatedItemIds.forEach(claimItem);
    }
    if (operation?.type === "update_library_tag") {
      for (const tagState of state?.libraryTags || []) {
        tagState.itemIds.forEach(claimItem);
      }
    }
    if (operation?.type === "delete_collection" && operation.deleteItems) {
      for (const collection of state?.collections || []) {
        collection.directItemIds?.forEach(claimItem);
      }
    }
    return {
      exclusiveKeys: [...keys],
      itemCoverage: [...itemCoverage],
    };
  }
  if (inverse.kind === "note_html") {
    return {
      exclusiveKeys: [`item:${inverse.noteId}`],
      itemCoverage: [inverse.noteId],
    };
  }
  if (inverse.kind === "file") {
    return { exclusiveKeys: [`file:${inverse.path}`], itemCoverage: [] };
  }
  return {
    exclusiveKeys: [`preference:${inverse.key}`],
    itemCoverage: [],
  };
}

async function buildScriptReplayPlan(
  inverse: ScriptSnapshotsInverse,
  step: JournalStep,
): Promise<ScriptReplayPlan> {
  const bundle = await loadScriptSnapshotBundle(inverse);
  const expected = parseJson(step.expectedPostconditionJson);
  if (
    !expected ||
    typeof expected !== "object" ||
    (expected as { kind?: unknown }).kind !== "script_effects"
  ) {
    throw new Error("The script recovery post-image is invalid");
  }
  const expectedItems = (expected as { items?: unknown }).items;
  const declaredGuards = (expected as { declared?: unknown }).declared;
  if (!Array.isArray(expectedItems) || !Array.isArray(declaredGuards)) {
    throw new Error("The script recovery post-image is incomplete");
  }
  const expectedItemById = new Map<number, unknown>();
  for (const row of expectedItems) {
    if (!row || typeof row !== "object") continue;
    const itemId = Number((row as { itemId?: unknown }).itemId);
    if (Number.isFinite(itemId) && itemId > 0) {
      expectedItemById.set(itemId, row);
    }
  }

  let guardIndex = 0;
  let coverageGroup = 0;
  const declaredUnits: ScriptDeclaredReplayUnit[][] = [];
  for (const raw of bundle.declaredInverses || []) {
    const declared = parseInverseValue(raw);
    if (!declared || declared.kind === "script_snapshots") {
      throw new Error("A script recorded an unsupported declarative inverse");
    }
    if (declared.kind === "library_operations") {
      const units: ScriptDeclaredReplayUnit[] = [];
      for (const operation of declared.operations) {
        const guard = declaredGuards[guardIndex++];
        const operationCoverageGroup = coverageGroup++;
        for (const atom of atomizeMutationOperationFromHandler(operation)) {
          units.push({
            inverse: {
              version: declared.version,
              kind: "library_operations",
              operations: [atom],
            },
            guard,
            coverageGroup: operationCoverageGroup,
          });
        }
      }
      declaredUnits.push(units);
      continue;
    }
    declaredUnits.push([
      {
        inverse: declared,
        guard: declaredGuards[guardIndex++],
        coverageGroup: coverageGroup++,
      },
    ]);
  }
  if (guardIndex !== declaredGuards.length) {
    throw new Error("The script declaration guards do not match its inverses");
  }
  const claimedResources = new Set<string>();
  const declaredItemCoverage = new Map<number, number>();
  const claim = (key: string): void => {
    if (claimedResources.has(key)) {
      throw new Error(
        `The script has overlapping inverse coverage for ${key}; automatic replay cannot prove the intermediate state.`,
      );
    }
    claimedResources.add(key);
  };
  for (const units of declaredUnits) {
    for (const unit of units) {
      const resources = scriptDeclaredReplayResources(unit.inverse, unit.guard);
      if (!resources.exclusiveKeys.length) {
        throw new Error(
          "A script-declared inverse has no deterministic replay target.",
        );
      }
      resources.exclusiveKeys.forEach(claim);
      for (const itemId of resources.itemCoverage) {
        const owner = declaredItemCoverage.get(itemId);
        if (owner !== undefined && owner !== unit.coverageGroup) {
          throw new Error(
            `The script has overlapping inverse coverage for item:${itemId}; automatic replay cannot prove the intermediate state.`,
          );
        }
        declaredItemCoverage.set(itemId, unit.coverageGroup);
      }
    }
  }
  const claimWholeItem = (itemId: number): void => {
    if (declaredItemCoverage.has(itemId)) {
      throw new Error(
        `The script has overlapping inverse coverage for item:${itemId}; automatic replay cannot prove the intermediate state.`,
      );
    }
    claim(`item:${itemId}`);
  };
  for (const itemId of bundle.createdItemIds || []) claimWholeItem(itemId);
  for (const snapshot of bundle.snapshots) claimWholeItem(snapshot.itemId);
  return { bundle, declaredUnits, expectedItemById };
}

function initialScriptReplayProgress(
  plan: ScriptReplayPlan,
): ScriptReplayProgress {
  for (let index = plan.declaredUnits.length - 1; index >= 0; index -= 1) {
    if (plan.declaredUnits[index].length) {
      return {
        version: 1,
        plannerVersion: 1,
        phase: "declared",
        declarationIndex: index,
        unitIndex: 0,
      };
    }
  }
  const createdItemIds = plan.bundle.createdItemIds || [];
  if (createdItemIds.length) {
    return {
      version: 1,
      plannerVersion: 1,
      phase: "created_items",
      itemIndex: createdItemIds.length - 1,
    };
  }
  if (plan.bundle.snapshots.length) {
    return {
      version: 1,
      plannerVersion: 1,
      phase: "snapshots",
      snapshotIndex: plan.bundle.snapshots.length - 1,
    };
  }
  return { version: 1, plannerVersion: 1, phase: "done" };
}

function validatedScriptReplayProgress(
  inverse: ScriptSnapshotsInverse,
  plan: ScriptReplayPlan,
): ScriptReplayProgress {
  const progress = inverse.progress || initialScriptReplayProgress(plan);
  if (progress.version !== 1 || progress.plannerVersion !== 1) {
    throw new Error("The script replay planner version is unsupported");
  }
  if (progress.phase === "done") return progress;
  if (progress.phase === "declared") {
    const units = plan.declaredUnits[progress.declarationIndex];
    if (
      !units ||
      progress.unitIndex < 0 ||
      progress.unitIndex >= units.length
    ) {
      throw new Error("The script declaration replay cursor is invalid");
    }
    return progress;
  }
  if (progress.phase === "created_items") {
    const ids = plan.bundle.createdItemIds || [];
    if (progress.itemIndex < 0 || progress.itemIndex >= ids.length) {
      throw new Error("The script created-item replay cursor is invalid");
    }
    return progress;
  }
  if (
    progress.snapshotIndex < 0 ||
    progress.snapshotIndex >= plan.bundle.snapshots.length
  ) {
    throw new Error("The script snapshot replay cursor is invalid");
  }
  return progress;
}

function scriptReplayUnit(
  plan: ScriptReplayPlan,
  progress: ScriptReplayProgress,
): ScriptReplayUnit | null {
  if (progress.phase === "done") return null;
  if (progress.phase === "declared") {
    return {
      kind: "declared",
      value: plan.declaredUnits[progress.declarationIndex][progress.unitIndex],
    };
  }
  if (progress.phase === "created_items") {
    const itemId = Number(
      (plan.bundle.createdItemIds || [])[progress.itemIndex],
    );
    return {
      kind: "created_item",
      itemId,
      expected: plan.expectedItemById.get(itemId),
    };
  }
  const snapshot = plan.bundle.snapshots[progress.snapshotIndex];
  return {
    kind: "snapshot",
    snapshot,
    expected: plan.expectedItemById.get(snapshot.itemId),
  };
}

function advanceScriptReplayProgress(
  plan: ScriptReplayPlan,
  progress: ScriptReplayProgress,
): ScriptReplayProgress {
  if (progress.phase === "done") return progress;
  if (progress.phase === "declared") {
    const units = plan.declaredUnits[progress.declarationIndex];
    if (progress.unitIndex + 1 < units.length) {
      return { ...progress, unitIndex: progress.unitIndex + 1 };
    }
    for (let index = progress.declarationIndex - 1; index >= 0; index -= 1) {
      if (plan.declaredUnits[index].length) {
        return {
          version: 1,
          plannerVersion: 1,
          phase: "declared",
          declarationIndex: index,
          unitIndex: 0,
        };
      }
    }
    const createdItemIds = plan.bundle.createdItemIds || [];
    if (createdItemIds.length) {
      return {
        version: 1,
        plannerVersion: 1,
        phase: "created_items",
        itemIndex: createdItemIds.length - 1,
      };
    }
    if (plan.bundle.snapshots.length) {
      return {
        version: 1,
        plannerVersion: 1,
        phase: "snapshots",
        snapshotIndex: plan.bundle.snapshots.length - 1,
      };
    }
    return { version: 1, plannerVersion: 1, phase: "done" };
  }
  if (progress.phase === "created_items") {
    if (progress.itemIndex > 0) {
      return { ...progress, itemIndex: progress.itemIndex - 1 };
    }
    if (plan.bundle.snapshots.length) {
      return {
        version: 1,
        plannerVersion: 1,
        phase: "snapshots",
        snapshotIndex: plan.bundle.snapshots.length - 1,
      };
    }
    return { version: 1, plannerVersion: 1, phase: "done" };
  }
  return progress.snapshotIndex > 0
    ? { ...progress, snapshotIndex: progress.snapshotIndex - 1 }
    : { version: 1, plannerVersion: 1, phase: "done" };
}

type NonLibraryInverse = Exclude<
  JournalInverse,
  LibraryOperationsInverse | ScriptSnapshotsInverse
>;

type MaterializedNonLibraryInverse =
  | { kind: "note_html"; noteId: number; html: string }
  | { kind: "file_delete"; path: string }
  | {
      kind: "file_restore";
      path: string;
      bytes: Uint8Array;
      checksum: string;
    }
  | {
      kind: "preference";
      key: string;
      existed: boolean;
      value?: unknown;
    };

async function materializeNonLibraryInverse(
  inverse: NonLibraryInverse,
): Promise<MaterializedNonLibraryInverse> {
  if (inverse.kind === "note_html") {
    const html = inverse.payload
      ? await readRecoveryText(inverse.payload)
      : inverse.html;
    if (typeof html !== "string") {
      throw new Error("The note recovery pre-image is missing");
    }
    return { kind: "note_html", noteId: inverse.noteId, html };
  }
  if (inverse.kind === "file") {
    if (inverse.operation === "delete") {
      return { kind: "file_delete", path: inverse.path };
    }
    const bytes = inverse.payload
      ? await readRecoveryBytes(inverse.payload)
      : new TextEncoder().encode(inverse.content || "");
    return {
      kind: "file_restore",
      path: inverse.path,
      bytes,
      checksum: inverse.payload?.checksum || (await sha256Bytes(bytes)),
    };
  }
  return {
    kind: "preference",
    key: inverse.key,
    existed: inverse.existed !== false,
    value: inverse.value,
  };
}

async function nonLibraryInverseIsSatisfied(params: {
  materialized: MaterializedNonLibraryInverse;
  service: LibraryMutationService;
}): Promise<boolean> {
  const { materialized, service } = params;
  if (materialized.kind === "note_html") {
    const item = service.getGateway().getItem(materialized.noteId);
    return item?.getNote?.() === materialized.html;
  }
  if (materialized.kind === "file_delete") {
    return (await readFileBytes(materialized.path)) === null;
  }
  if (materialized.kind === "file_restore") {
    const current = await readFileBytes(materialized.path);
    return Boolean(
      current && (await sha256Bytes(current)) === materialized.checksum,
    );
  }
  const setting = service
    .getGateway()
    .listSettings()
    .find((entry) => entry.key === materialized.key);
  return !materialized.existed
    ? setting?.value === undefined
    : Boolean(setting && stable(setting.value) === stable(materialized.value));
}

type NonLibraryReplayClassification =
  | { kind: "pending" }
  | { kind: "completed" }
  | { kind: "conflict"; conflict: RevertConflict };

async function classifyNonLibraryInverse(params: {
  actionId: string;
  inverse: NonLibraryInverse;
  step: JournalStep;
  service: LibraryMutationService;
  context: AgentToolContext;
  materialized?: MaterializedNonLibraryInverse;
}): Promise<NonLibraryReplayClassification> {
  let materialized: MaterializedNonLibraryInverse;
  try {
    materialized =
      params.materialized ||
      (await materializeNonLibraryInverse(params.inverse));
  } catch (error) {
    return {
      kind: "conflict",
      conflict: {
        actionId: params.actionId,
        stepId: params.step.stepId,
        reason: `The recovery pre-image could not be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
  if (params.step.status === "revert_failed") {
    try {
      if (
        await nonLibraryInverseIsSatisfied({
          materialized,
          service: params.service,
        })
      ) {
        return { kind: "completed" };
      }
    } catch {
      // Fall through to the forward post-image guard. It returns a specific
      // conflict when the target cannot be read safely.
    }
  }
  const conflict = await conflictForStep(params);
  return conflict ? { kind: "conflict", conflict } : { kind: "pending" };
}

async function conflictForNonLibraryInverse(params: {
  actionId: string;
  step: JournalStep;
  inverse: NonLibraryInverse;
  service: LibraryMutationService;
  context: AgentToolContext;
}): Promise<RevertConflict | null> {
  const classification = await classifyNonLibraryInverse(params);
  return classification.kind === "conflict" ? classification.conflict : null;
}

function currentMatchesScriptSnapshot(
  snapshot: ScriptItemSnapshot,
  service: LibraryMutationService,
): boolean {
  const item = service.getGateway().getItem(snapshot.itemId) as any;
  if (!item) return false;
  if (
    snapshot.itemTypeID !== undefined &&
    Number(item.itemTypeID) !== snapshot.itemTypeID
  ) {
    return false;
  }
  if ((Number(item.parentID) || undefined) !== snapshot.parentID) return false;
  if ((item.deleted === true) !== (snapshot.deleted === true)) return false;
  for (const [field, value] of Object.entries(snapshot.fields)) {
    if (String(item.getField?.(field) ?? "") !== value) return false;
  }
  if (stable(item.getCreatorsJSON?.() || []) !== stable(snapshot.creators)) {
    return false;
  }
  const normalizeTags = (
    entries: ReadonlyArray<{ tag?: unknown; type?: unknown } | string>,
  ) =>
    entries
      .map((entry) => ({
        tag: String(typeof entry === "string" ? entry : entry?.tag || ""),
        type:
          typeof entry === "string" || !Number.isFinite(Number(entry?.type))
            ? 0
            : Number(entry.type),
      }))
      .filter((entry) => Boolean(entry.tag))
      .sort(
        (left, right) =>
          left.tag.localeCompare(right.tag) || left.type - right.type,
      );
  const currentTags = normalizeTags(item.getTags?.() || []);
  const expectedTags = normalizeTags(snapshot.tags);
  if (stable(currentTags) !== stable(expectedTags)) return false;
  const currentCollections = [...(item.getCollections?.() || [])]
    .map(Number)
    .sort((left, right) => left - right);
  const expectedCollections = [...snapshot.collectionIds].sort(
    (left, right) => left - right,
  );
  if (stable(currentCollections) !== stable(expectedCollections)) return false;
  if (
    snapshot.noteHtml !== undefined &&
    String(item.getNote?.() ?? "") !== snapshot.noteHtml
  ) {
    return false;
  }
  return true;
}

async function classifyScriptReplayUnit(params: {
  unit: ScriptReplayUnit;
  step: JournalStep;
  service: LibraryMutationService;
  context: AgentToolContext;
  allowCompleted: boolean;
  materializedNonLibrary?: MaterializedNonLibraryInverse;
}): Promise<LibraryReplayClassification> {
  const { unit, step, service, context, allowCompleted } = params;
  if (unit.kind === "declared") {
    if (unit.value.inverse.kind === "library_operations") {
      const guard = unit.value.guard as
        | { kind?: unknown; state?: unknown }
        | undefined;
      if (guard?.kind !== "library_operation" || !guard.state) {
        return {
          kind: "conflict",
          reason: "The script library-operation guard is missing.",
        };
      }
      return classifyLibraryInverseOperation({
        operation: unit.value.inverse.operations[0],
        step: {
          ...step,
          preconditionJson: undefined,
          expectedPostconditionJson: JSON.stringify(guard.state),
        },
        service,
        context,
        allowCompleted,
      });
    }
    if (allowCompleted) {
      try {
        const materialized =
          params.materializedNonLibrary ||
          (await materializeNonLibraryInverse(unit.value.inverse));
        if (await nonLibraryInverseIsSatisfied({ materialized, service })) {
          return { kind: "completed" };
        }
      } catch (error) {
        return {
          kind: "conflict",
          reason: `The script recovery pre-image could not be verified: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    try {
      const current = await captureCurrentScriptDeclaredGuard({
        expected: unit.value.guard,
        service,
        context,
      });
      return stable(current) === stable(unit.value.guard)
        ? { kind: "pending" }
        : {
            kind: "conflict",
            reason:
              "A script-declared inverse target changed after the agent action.",
          };
    } catch (error) {
      return {
        kind: "conflict",
        reason: `The script-declared inverse target could not be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  if (unit.kind === "created_item") {
    const item = service.getGateway().getItem(unit.itemId) as
      | (Zotero.Item & { deleted?: boolean })
      | null;
    if (allowCompleted && item?.deleted === true) {
      return { kind: "completed" };
    }
    if (!unit.expected) {
      return { kind: "conflict", reason: "The created-item guard is missing." };
    }
    const current = captureCurrentScriptItems([unit.expected], service)[0];
    return stable(current) === stable(unit.expected)
      ? { kind: "pending" }
      : {
          kind: "conflict",
          reason: "A script-created item changed after the agent action.",
        };
  }
  if (allowCompleted && currentMatchesScriptSnapshot(unit.snapshot, service)) {
    return { kind: "completed" };
  }
  if (!unit.expected) {
    return { kind: "conflict", reason: "The script item guard is missing." };
  }
  const current = captureCurrentScriptItems([unit.expected], service)[0];
  return stable(current) === stable(unit.expected)
    ? { kind: "pending" }
    : {
        kind: "conflict",
        reason: "A snapshotted item changed after the agent action.",
      };
}

async function executeScriptReplayUnit(params: {
  unit: ScriptReplayUnit;
  service: LibraryMutationService;
  context: AgentToolContext;
  materializedNonLibrary?: MaterializedNonLibraryInverse;
}): Promise<void> {
  if (params.unit.kind === "declared") {
    if (
      params.unit.value.inverse.kind !== "library_operations" &&
      params.materializedNonLibrary
    ) {
      await executeMaterializedNonLibraryInverse({
        materialized: params.materializedNonLibrary,
        service: params.service,
      });
      return;
    }
    await executeInverse({
      inverse: params.unit.value.inverse,
      service: params.service,
      context: params.context,
    });
    return;
  }
  if (params.unit.kind === "created_item") {
    const result = await params.service.getGateway().trashItems({
      itemIds: [params.unit.itemId],
    });
    assertInverseOutcomeSucceeded(result);
    return;
  }
  await restoreScriptSnapshot(
    params.unit.snapshot,
    params.service.getGateway(),
  );
}

async function conflictForScriptSnapshots(params: {
  actionId: string;
  step: JournalStep;
  inverse: ScriptSnapshotsInverse;
  service: LibraryMutationService;
  context: AgentToolContext;
}): Promise<RevertConflict | null> {
  try {
    if (!params.inverse.progress) {
      const aggregateConflict = await conflictForStep({
        step: params.step,
        service: params.service,
        context: params.context,
        actionId: params.actionId,
      });
      if (aggregateConflict) {
        return params.step.status === "revert_failed"
          ? {
              ...aggregateConflict,
              reason:
                "An older script undo stopped before recording per-target progress, and its aggregate post-image no longer matches. Automatic replay cannot infer which target committed.",
            }
          : aggregateConflict;
      }
    }
    const plan = await buildScriptReplayPlan(params.inverse, params.step);
    const progress = validatedScriptReplayProgress(params.inverse, plan);
    const unit = scriptReplayUnit(plan, progress);
    if (!unit) return null;
    const classification = await classifyScriptReplayUnit({
      unit,
      step: params.step,
      service: params.service,
      context: params.context,
      allowCompleted: params.step.status === "revert_failed",
    });
    return classification.kind === "conflict"
      ? {
          actionId: params.actionId,
          stepId: params.step.stepId,
          reason: classification.reason,
        }
      : null;
  } catch (error) {
    return {
      actionId: params.actionId,
      stepId: params.step.stepId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeScriptSnapshotsWithProgress(params: {
  actionId: string;
  step: JournalStep;
  inverse: ScriptSnapshotsInverse;
  service: LibraryMutationService;
  context: AgentToolContext;
  now: () => number;
}): Promise<void> {
  const plan = await buildScriptReplayPlan(params.inverse, params.step);
  let progress = validatedScriptReplayProgress(params.inverse, plan);
  const checkpoint = async (): Promise<void> => {
    await updateJournalStep({
      stepId: params.step.stepId,
      status: "reverting",
      inverse: { ...params.inverse, progress },
      now: params.now(),
    });
  };
  await checkpoint();
  while (progress.phase !== "done") {
    const unit = scriptReplayUnit(plan, progress);
    if (!unit) throw new Error("The script replay cursor lost its target");
    // Recovery blobs are verified before the last target guard. The executor
    // then uses these exact bytes/text without another awaited payload read.
    const materializedNonLibrary =
      unit.kind === "declared" &&
      unit.value.inverse.kind !== "library_operations"
        ? await materializeNonLibraryInverse(unit.value.inverse)
        : undefined;
    const before = await classifyScriptReplayUnit({
      unit,
      step: params.step,
      service: params.service,
      context: params.context,
      allowCompleted: params.step.status === "revert_failed",
      materializedNonLibrary,
    });
    if (before.kind === "conflict") {
      throw new LibraryReplayConflictError({
        actionId: params.actionId,
        stepId: params.step.stepId,
        reason: before.reason,
      });
    }
    if (before.kind === "pending") {
      await executeScriptReplayUnit({
        unit,
        service: params.service,
        context: params.context,
        materializedNonLibrary,
      });
      const after = await classifyScriptReplayUnit({
        unit,
        step: params.step,
        service: params.service,
        context: params.context,
        allowCompleted: true,
        materializedNonLibrary,
      });
      if (after.kind !== "completed") {
        throw new Error(
          after.kind === "conflict"
            ? after.reason
            : "A script inverse returned without restoring its target",
        );
      }
    }
    progress = advanceScriptReplayProgress(plan, progress);
    await checkpoint();
  }
}

async function executeMaterializedNonLibraryInverse(params: {
  materialized: MaterializedNonLibraryInverse;
  service: LibraryMutationService;
}): Promise<void> {
  const { materialized, service } = params;
  if (materialized.kind === "note_html") {
    await service.getGateway().restoreNoteHtml({
      noteId: materialized.noteId,
      html: materialized.html,
    });
    return;
  }
  if (materialized.kind === "file_delete") {
    await deleteFile(materialized.path);
    return;
  }
  if (materialized.kind === "file_restore") {
    await writeFileBytes(materialized.path, materialized.bytes);
    return;
  }
  service.getGateway().restoreSetting({
    key: materialized.key,
    existed: materialized.existed,
    value: materialized.value,
  });
}

async function executeInverse(params: {
  inverse: JournalInverse;
  service: LibraryMutationService;
  context: AgentToolContext;
}): Promise<void> {
  const { inverse, service, context } = params;
  switch (inverse.kind) {
    case "library_operations":
      if (
        !Array.isArray(inverse.operations) ||
        !inverse.operations.every(isMutationOperation)
      ) {
        throw new Error("The recorded library inverse is invalid");
      }
      for (const operation of atomizeLibraryOperations(inverse.operations)) {
        // Direct execution is deliberate: replaying an inverse must not file
        // another action and create an undo ping-pong.
        const executed = await service.executeOperation(operation, context);
        assertInverseOutcomeSucceeded(executed.result);
      }
      return;
    case "note_html":
    case "file":
    case "preference":
      await executeMaterializedNonLibraryInverse({
        materialized: await materializeNonLibraryInverse(inverse),
        service,
      });
      return;
    case "script_snapshots":
      await executeScriptSnapshots(inverse, service, context);
  }
}

export async function analyzeJournalActions(params: {
  actions: JournalActionWithSteps[];
  zoteroGateway: ZoteroGateway;
  context: AgentToolContext;
}): Promise<RevertConflict[]> {
  const service = new LibraryMutationService(params.zoteroGateway);
  const conflicts: RevertConflict[] = [];
  for (const action of params.actions) {
    if (action.reversibility === "none") continue;
    for (const step of [...action.steps].reverse()) {
      if (
        step.status === "reverted" ||
        step.status === "no_effect" ||
        step.status === "failed" ||
        step.status === "irreversible"
      ) {
        continue;
      }
      const inverse = parseInverse(step);
      const conflict =
        inverse?.kind === "library_operations"
          ? await conflictForLibraryInverse({
              actionId: action.actionId,
              step,
              inverse,
              service,
              context: params.context,
            })
          : inverse?.kind === "script_snapshots"
            ? await conflictForScriptSnapshots({
                actionId: action.actionId,
                step,
                inverse,
                service,
                context: params.context,
              })
            : inverse
              ? await conflictForNonLibraryInverse({
                  actionId: action.actionId,
                  step,
                  inverse,
                  service,
                  context: params.context,
                })
              : await conflictForStep({
                  actionId: action.actionId,
                  step,
                  service,
                  context: params.context,
                });
      if (conflict) conflicts.push(conflict);
    }
  }
  return conflicts;
}

export async function revertActions(params: {
  actions: JournalActionWithSteps[];
  zoteroGateway: ZoteroGateway;
  context: AgentToolContext;
  now?: () => number;
}): Promise<RevertOutcome> {
  const now = params.now ?? (() => Date.now());
  const service = new LibraryMutationService(params.zoteroGateway);
  const skipped: RevertOutcome["skipped"] = [];
  const residuals: RevertOutcome["residuals"] = [];
  const conflicts: RevertConflict[] = [];
  let reverted = 0;
  let partiallyReverted = 0;
  const ordered = [...params.actions].sort(
    (left, right) => right.createdAt - left.createdAt,
  );

  for (const action of ordered) {
    if (action.status === "reverted" || action.status === "no_effect") continue;
    if (action.reversibility === "none") {
      skipped.push({
        entryId: action.actionId,
        reason: action.recovery || action.error || "No inverse was recorded",
      });
      continue;
    }
    const actionClaimed = await claimJournalAction({
      actionId: action.actionId,
      from: ["applied", "partially_applied", "uncertain", "revert_failed"],
      to: "reverting",
      now: now(),
    });
    if (!actionClaimed) {
      skipped.push({
        entryId: action.actionId,
        reason: "The action is already being reverted or changed state.",
      });
      continue;
    }
    let actionFailed = false;
    const actionResidualReasons = new Set<string>();
    if (action.reversibility === "partial" && action.recovery) {
      actionResidualReasons.add(action.recovery);
    }
    await withActiveJournalAction(action.actionId, async () => {
      for (const step of [...action.steps].sort(
        (left, right) => right.sequence - left.sequence,
      )) {
        if (
          step.status === "reverted" ||
          step.status === "no_effect" ||
          step.status === "failed"
        ) {
          continue;
        }
        if (step.status === "irreversible") {
          actionResidualReasons.add(
            step.error ||
              `Step ${step.sequence} had an irreversible effect outside the recorded inverse coverage.`,
          );
          continue;
        }
        const inverse = parseInverse(step);
        if (!inverse) {
          actionFailed = true;
          skipped.push({
            entryId: action.actionId,
            reason: `Step ${step.sequence} has no usable durable inverse`,
          });
          continue;
        }
        const conflict =
          inverse.kind === "library_operations"
            ? await conflictForLibraryInverse({
                actionId: action.actionId,
                step,
                inverse,
                service,
                context: params.context,
              })
            : inverse.kind === "script_snapshots"
              ? await conflictForScriptSnapshots({
                  actionId: action.actionId,
                  step,
                  inverse,
                  service,
                  context: params.context,
                })
              : await conflictForNonLibraryInverse({
                  actionId: action.actionId,
                  step,
                  inverse,
                  service,
                  context: params.context,
                });
        if (conflict) {
          actionFailed = true;
          conflicts.push(conflict);
          skipped.push({ entryId: action.actionId, reason: conflict.reason });
          continue;
        }
        try {
          const stepClaimed = await claimJournalStep({
            stepId: step.stepId,
            from: ["applied", "uncertain", "revert_failed"],
            to: "reverting",
            now: now(),
          });
          if (!stepClaimed) {
            throw new Error(
              `Step ${step.sequence} is already being reverted or changed state`,
            );
          }
          // The journal claim awaits SQLite and does not lock Zotero's UI. A
          // user edit can therefore land after the preflight check but before
          // the inverse starts. Re-read at the last guarded boundary so that
          // edit is treated as a conflict instead of being overwritten.
          let claimedNonLibraryState: "pending" | "completed" = "pending";
          let claimedNonLibraryInverse: MaterializedNonLibraryInverse | null =
            null;
          let claimedConflict: RevertConflict | null;
          if (inverse.kind === "library_operations") {
            claimedConflict = await conflictForLibraryInverse({
              actionId: action.actionId,
              step,
              inverse,
              service,
              context: params.context,
            });
          } else if (inverse.kind === "script_snapshots") {
            claimedConflict = await conflictForScriptSnapshots({
              actionId: action.actionId,
              step,
              inverse,
              service,
              context: params.context,
            });
          } else {
            // Verify and load recovery content before observing the target.
            // Once the guard passes, execution performs no second blob read.
            claimedNonLibraryInverse =
              await materializeNonLibraryInverse(inverse);
            const classification = await classifyNonLibraryInverse({
              actionId: action.actionId,
              step,
              inverse,
              service,
              context: params.context,
              materialized: claimedNonLibraryInverse,
            });
            claimedConflict =
              classification.kind === "conflict"
                ? classification.conflict
                : null;
            if (classification.kind !== "conflict") {
              // Preserve this exact guarded observation through execution.
              // Re-reading only the completion predicate would turn a newer
              // concurrent edit into permission to overwrite it.
              claimedNonLibraryState = classification.kind;
            }
          }
          if (claimedConflict) {
            actionFailed = true;
            conflicts.push(claimedConflict);
            skipped.push({
              entryId: action.actionId,
              reason: claimedConflict.reason,
            });
            await updateJournalStep({
              stepId: step.stepId,
              status: "revert_failed",
              error: claimedConflict.reason,
              now: now(),
            }).catch(() => undefined);
            continue;
          }
          if (inverse.kind === "library_operations") {
            await executeLibraryInverseWithProgress({
              actionId: action.actionId,
              step,
              inverse,
              service,
              context: params.context,
              now,
            });
          } else if (inverse.kind === "script_snapshots") {
            await executeScriptSnapshotsWithProgress({
              actionId: action.actionId,
              step,
              inverse,
              service,
              context: params.context,
              now,
            });
          } else if (claimedNonLibraryState === "pending") {
            if (!claimedNonLibraryInverse) {
              throw new Error("The guarded recovery pre-image was lost");
            }
            await executeMaterializedNonLibraryInverse({
              materialized: claimedNonLibraryInverse,
              service,
            });
          }
          await updateJournalStep({
            stepId: step.stepId,
            status: "reverted",
            now: now(),
          });
        } catch (error) {
          actionFailed = true;
          const reason = error instanceof Error ? error.message : String(error);
          if (error instanceof LibraryReplayConflictError) {
            conflicts.push(error.conflict);
          }
          skipped.push({ entryId: action.actionId, reason });
          await updateJournalStep({
            stepId: step.stepId,
            status: "revert_failed",
            error: reason,
            now: now(),
          }).catch(() => undefined);
        }
      }
      if (actionFailed) {
        await updateJournalAction({
          actionId: action.actionId,
          status: "revert_failed",
          error: "One or more steps could not be reverted",
          now: now(),
        });
        return;
      }
      try {
        const finalized = await finalizeRevertedJournalAction({
          actionId: action.actionId,
          now: now(),
        });
        if (!finalized) {
          throw new Error(
            "The completed inverse could not claim its terminal journal state",
          );
        }
      } catch (error) {
        actionFailed = true;
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push({ entryId: action.actionId, reason });
        await updateJournalAction({
          actionId: action.actionId,
          status: "revert_failed",
          error: reason,
          now: now(),
        }).catch(() => undefined);
      }
    });
    if (!actionFailed) {
      if (
        action.reversibility === "partial" ||
        actionResidualReasons.size > 0
      ) {
        partiallyReverted += 1;
        residuals.push({
          actionId: action.actionId,
          description: action.description,
          reason: actionResidualReasons.size
            ? [...actionResidualReasons].join(" ")
            : "The recorded inverse was replayed, but this action was only partially reversible; effects outside its durable coverage may remain.",
        });
      } else {
        reverted += 1;
      }
    }
  }
  return { reverted, partiallyReverted, residuals, skipped, conflicts };
}

export async function revertRun(params: {
  runId: string;
  zoteroGateway: ZoteroGateway;
  context: AgentToolContext;
  now?: () => number;
}): Promise<RevertOutcome> {
  const actions = await listJournalActions({
    runId: params.runId,
    limit: 10000,
  });
  return revertActions({ ...params, actions });
}
