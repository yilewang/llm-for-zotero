/**
 * Shared helpers used by the focused facade tools for building
 * confirmation cards, normalizing inputs, and executing operations.
 */
import type { AgentPendingField, AgentToolContext } from "../../types";
import type {
  ApplyTagsOperation,
  MoveToCollectionOperation,
  UpdateMetadataOperation,
  LibraryMutationOperation,
  LibraryMutationService,
} from "../../services/libraryMutationService";
import type {
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../../services/zoteroGateway";
import { pushUndoEntry } from "../../store/undoStore";
import { normalizePositiveInt, normalizeStringArray, validateObject } from "../shared";

// ── Tag assignment helpers ──────────────────────────────────────────────────

export function getTagAssignmentFieldId(operation: ApplyTagsOperation): string {
  return `tagAssignments:${operation.id || "apply_tags"}`;
}

export function getTagAssignments(
  operation: ApplyTagsOperation,
): Array<{ itemId: number; tags: string[] }> {
  if (operation.assignments?.length) {
    return operation.assignments.map((assignment) => ({
      itemId: assignment.itemId,
      tags: Array.isArray(assignment.tags) ? assignment.tags : [],
    }));
  }
  if (!operation.itemIds?.length) {
    return [];
  }
  return operation.itemIds.map((itemId) => ({
    itemId,
    tags: operation.tags || [],
  }));
}

export function buildTagAssignmentField(
  operation: ApplyTagsOperation,
  zoteroGateway: ZoteroGateway,
) {
  const assignments = getTagAssignments(operation);
  if (!assignments.length) {
    return null;
  }
  const targetByItemId = new Map(
    zoteroGateway
      .getPaperTargetsByItemIds(assignments.map((assignment) => assignment.itemId))
      .map((target) => [target.itemId, target] as const),
  );
  return {
    type: "tag_assignment_table" as const,
    id: getTagAssignmentFieldId(operation),
    label: "Suggested tags to add",
    rows: assignments.map((assignment) => {
      const target = targetByItemId.get(assignment.itemId);
      const details = [target?.firstCreator || "", target?.year || ""].filter(Boolean);
      return {
        id: `${assignment.itemId}`,
        label: target?.title || `Item ${assignment.itemId}`,
        description: details.join(" · ") || undefined,
        value: assignment.tags,
        placeholder: "tag-one, tag-two",
      };
    }),
  };
}

export function normalizeTagAssignmentsFromResolution(
  value: unknown,
): Array<{ itemId: number; tags: string[] }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((entry) => {
      if (!validateObject<Record<string, unknown>>(entry)) {
        return null;
      }
      const itemId = normalizePositiveInt(entry.id);
      const tags = normalizeStringArray(entry.value);
      if (!itemId || !tags?.length) {
        return null;
      }
      return { itemId, tags };
    })
    .filter((entry): entry is { itemId: number; tags: string[] } => Boolean(entry));
}

// ── Move assignment helpers ─────────────────────────────────────────────────

export function getMoveAssignmentFieldId(operation: MoveToCollectionOperation): string {
  return `moveAssignments:${operation.id || "move_to_collection"}`;
}

function normalizeCollectionKey(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function describeCollection(
  collection: ReturnType<ZoteroGateway["getCollectionSummary"]>,
): string {
  return collection ? collection.path || collection.name : "unknown collection";
}

export function getMoveAssignments(
  operation: MoveToCollectionOperation,
): Array<{
  itemId: number;
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
}> {
  if (operation.assignments?.length) {
    return operation.assignments;
  }
  if (!operation.itemIds?.length) {
    return [];
  }
  return operation.itemIds.map((itemId) => ({
    itemId,
    targetCollectionId: operation.targetCollectionId,
    targetCollectionName: operation.targetCollectionName,
    targetCollectionPath: operation.targetCollectionPath,
  }));
}

export function buildCollectionSelectOptions(
  zoteroGateway: ZoteroGateway,
  context: AgentToolContext,
): Array<{
  id: string;
  label: string;
  name: string;
  path: string;
}> {
  const libraryID = zoteroGateway.resolveLibraryID({
    request: context.request,
    item: context.item,
  });
  if (!libraryID) {
    return [];
  }
  const summaries = zoteroGateway.listCollectionSummaries(libraryID);
  return summaries.map((collection) => ({
    id: `${collection.collectionId}`,
    label: collection.path || collection.name,
    name: collection.name,
    path: collection.path || collection.name,
  }));
}

function resolveInitialCollectionSelection(
  assignment: ReturnType<typeof getMoveAssignments>[number],
  options: ReturnType<typeof buildCollectionSelectOptions>,
): string | undefined {
  if (assignment.targetCollectionId) {
    const direct = options.find(
      (option) => option.id === `${assignment.targetCollectionId}`,
    );
    if (direct) return direct.id;
  }
  const pathKey = normalizeCollectionKey(assignment.targetCollectionPath);
  if (pathKey) {
    const pathMatch = options.find(
      (option) => normalizeCollectionKey(option.path) === pathKey,
    );
    if (pathMatch) return pathMatch.id;
  }
  const nameKey = normalizeCollectionKey(assignment.targetCollectionName);
  if (nameKey) {
    const matches = options.filter(
      (option) =>
        normalizeCollectionKey(option.name) === nameKey ||
        normalizeCollectionKey(option.path) === nameKey,
    );
    if (matches.length === 1) {
      return matches[0].id;
    }
  }
  return undefined;
}

export function buildMoveAssignmentField(
  operation: MoveToCollectionOperation,
  zoteroGateway: ZoteroGateway,
  context: AgentToolContext,
) {
  const assignments = getMoveAssignments(operation);
  if (!assignments.length) {
    return null;
  }
  const options = buildCollectionSelectOptions(zoteroGateway, context);
  if (!options.length) {
    return null;
  }
  const itemIds = assignments.map((assignment) => assignment.itemId);
  const targetByItemId = new Map(
    zoteroGateway
      .getPaperTargetsByItemIds(itemIds)
      .map((target) => [target.itemId, target] as const),
  );
  return {
    type: "assignment_table" as const,
    id: getMoveAssignmentFieldId(operation),
    label: assignments.length === 1 ? "Destination folder" : "Destination folders",
    options: [
      { id: "__skip__", label: "Leave untouched" },
      ...options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
    ],
    rows: assignments.map((assignment) => {
      const target = targetByItemId.get(assignment.itemId);
      const currentCollections = (target?.collectionIds || [])
        .map((collectionId) => zoteroGateway.getCollectionSummary(collectionId))
        .filter(Boolean)
        .map((collection) => describeCollection(collection));
      const details = [
        target?.firstCreator || "",
        target?.year || "",
        currentCollections.length
          ? `Current: ${currentCollections.join(", ")}`
          : "Current: unfiled",
      ].filter(Boolean);
      return {
        id: `${assignment.itemId}`,
        label: target?.title || `Item ${assignment.itemId}`,
        description: details.join(" | "),
        value:
          resolveInitialCollectionSelection(assignment, options) || "__skip__",
        checked: true,
      };
    }),
  };
}

export function normalizeMoveAssignmentsFromResolution(
  value: unknown,
): Array<{ itemId: number; targetCollectionId: number }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((entry) => {
      if (!validateObject<Record<string, unknown>>(entry)) {
        return null;
      }
      if (entry.checked === false || entry.value === "__skip__") {
        return null;
      }
      const itemId = normalizePositiveInt(entry.id);
      const targetCollectionId = normalizePositiveInt(entry.value);
      if (!itemId || !targetCollectionId) {
        return null;
      }
      return { itemId, targetCollectionId };
    })
    .filter(
      (entry): entry is { itemId: number; targetCollectionId: number } =>
        Boolean(entry),
    );
}

// ── Metadata review helpers ─────────────────────────────────────────────────

export const METADATA_FIELD_DISPLAY_LABELS: Record<string, string> = {
  title: "Title",
  shortTitle: "Short title",
  abstractNote: "Abstract",
  publicationTitle: "Journal",
  journalAbbreviation: "Journal abbreviation",
  proceedingsTitle: "Proceedings title",
  date: "Date",
  volume: "Volume",
  issue: "Issue",
  pages: "Pages",
  DOI: "DOI",
  url: "URL",
  language: "Language",
  extra: "Extra",
  ISSN: "ISSN",
  ISBN: "ISBN",
  publisher: "Publisher",
  place: "Place",
};

export function formatCreatorsDisplay(
  creators: EditableArticleCreator[],
): string {
  return creators
    .map((c) => {
      if (c.name) return c.name;
      return [c.firstName, c.lastName].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("; ");
}

export function buildUpdateMetadataReviewField(
  operation: UpdateMetadataOperation,
  zoteroGateway: ZoteroGateway,
  context: AgentToolContext,
  itemTitle: string,
  showTitle: boolean,
): Extract<AgentPendingField, { type: "review_table" }> | null {
  const item = zoteroGateway.resolveMetadataItem({
    itemId: operation.itemId,
    paperContext: operation.paperContext,
    request: context.request,
    item: context.item,
  });
  const snapshot = zoteroGateway.getEditableArticleMetadata(item);
  const rows: Extract<AgentPendingField, { type: "review_table" }>["rows"] =
    [];

  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(operation.metadata, fieldName))
      continue;
    const newValue = operation.metadata[fieldName] ?? "";
    const label = METADATA_FIELD_DISPLAY_LABELS[fieldName] || fieldName;
    const before = snapshot?.fields[fieldName] ?? "";
    rows.push({
      key: fieldName,
      label,
      before,
      after: newValue,
      multiline: fieldName === "abstractNote",
    });
  }

  if (operation.metadata.creators !== undefined) {
    const before = snapshot ? formatCreatorsDisplay(snapshot.creators) : "";
    const after = formatCreatorsDisplay(operation.metadata.creators);
    rows.push({ key: "creators", label: "Authors", before, after });
  }

  if (!rows.length) return null;

  return {
    type: "review_table",
    id: `metadataReview:${operation.id}`,
    label: showTitle ? itemTitle : undefined,
    rows,
  };
}

// ── Execution + undo helpers ────────────────────────────────────────────────

/**
 * Execute a single operation via the mutation service and register undo.
 * Used by the focused facade tools for single-operation calls.
 */
export async function executeAndRecordUndo(
  mutationService: LibraryMutationService,
  operation: LibraryMutationOperation,
  context: AgentToolContext,
  facadeToolName: string,
): Promise<{ result: unknown }> {
  const executed = await mutationService.executeOperation(operation, context);
  if (executed.undo) {
    pushUndoEntry(context.request.conversationKey, {
      id: `undo-${facadeToolName}-${Date.now()}`,
      toolName: facadeToolName,
      description: executed.undo.description,
      revert: executed.undo.revert,
    });
  }
  return { result: executed.result };
}

/**
 * Execute multiple operations via the mutation service and register a single
 * grouped undo entry. Used by facade tools that support batching (e.g.
 * update_metadata with multiple items).
 */
export async function executeAndRecordUndoBatch(
  mutationService: LibraryMutationService,
  operations: LibraryMutationOperation[],
  context: AgentToolContext,
  facadeToolName: string,
): Promise<{ appliedCount: number; results: unknown[] }> {
  const results: unknown[] = [];
  const undoEntries: Array<{
    description: string;
    revert: () => Promise<void>;
  }> = [];
  for (const operation of operations) {
    const executed = await mutationService.executeOperation(operation, context);
    results.push(executed.result);
    if (executed.undo) {
      undoEntries.push(executed.undo);
    }
  }
  if (undoEntries.length) {
    pushUndoEntry(context.request.conversationKey, {
      id: `undo-${facadeToolName}-batch-${Date.now()}`,
      toolName: facadeToolName,
      description: `Undo ${undoEntries.length} ${facadeToolName} change${
        undoEntries.length === 1 ? "" : "s"
      }`,
      revert: async () => {
        for (const undo of [...undoEntries].reverse()) {
          await undo.revert();
        }
      },
    });
  }
  return { appliedCount: results.length, results };
}

// ── Metadata & Creator normalization ─────────────────────────────────────────

export function normalizeStringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  return null;
}

export function normalizeCreator(value: unknown): EditableArticleCreator | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const creatorType =
    typeof value.creatorType === "string" && value.creatorType.trim()
      ? value.creatorType.trim()
      : "author";
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : undefined;
  const firstName =
    typeof value.firstName === "string" && value.firstName.trim()
      ? value.firstName.trim()
      : undefined;
  const lastName =
    typeof value.lastName === "string" && value.lastName.trim()
      ? value.lastName.trim()
      : undefined;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    name,
    firstName,
    lastName,
    fieldMode: name ? 1 : 0,
  };
}

export function normalizeCreatorsList(raw: unknown): EditableArticleCreator[] | null {
  if (Array.isArray(raw)) {
    const list = raw
      .map((entry) => normalizeCreator(entry))
      .filter((entry): entry is EditableArticleCreator => Boolean(entry));
    return list.length ? list : null;
  }
  // Model may send a comma/semicolon-separated string like "Stefan Leutgeb, Jill K. Leutgeb"
  if (typeof raw === "string" && raw.trim()) {
    const names = raw
      .split(/;|,(?![^(]*\))/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length) return null;
    return names.map((name) => ({
      creatorType: "author",
      name,
      fieldMode: 1 as const,
    }));
  }
  return null;
}

/**
 * Normalize a metadata patch from tool input.
 * Handles nested `.fields` objects (e.g. from query_library snapshots),
 * the "creators"/"authors" alias, and string/number/boolean field coercion.
 * Skips un-normalizable fields instead of aborting the entire patch.
 */
export function normalizeMetadataPatch(
  value: unknown,
): EditableArticleMetadataPatch | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  // Flatten nested .fields object (e.g. from metadata snapshots)
  const normalizedValue = validateObject<Record<string, unknown>>(value.fields)
    ? {
        ...(value.fields as Record<string, unknown>),
        ...value,
      }
    : value;
  const metadata: EditableArticleMetadataPatch = {};
  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(normalizedValue, fieldName)) continue;
    const normalized = normalizeStringValue(normalizedValue[fieldName]);
    if (normalized === null) continue;
    metadata[fieldName as EditableArticleMetadataField] = normalized;
  }
  // Accept "creators" or "authors" (common model alias). Handle arrays and
  // comma/semicolon-separated strings. Non-parseable values are silently skipped
  // so they do not abort the entire patch.
  const rawCreators =
    Object.prototype.hasOwnProperty.call(normalizedValue, "creators")
      ? normalizedValue.creators
      : Object.prototype.hasOwnProperty.call(normalizedValue, "authors")
        ? normalizedValue.authors
        : undefined;
  if (rawCreators !== undefined) {
    const creators = normalizeCreatorsList(rawCreators);
    if (creators !== null) {
      metadata.creators = creators;
    }
  }
  return Object.keys(metadata).length ? metadata : null;
}
