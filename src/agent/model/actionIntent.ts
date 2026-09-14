import {
  OPERATION_CATALOG,
  operationCatalogEntry,
} from "../contracts/operationCatalog";
import { isActionIndexList } from "../contracts/workflowDependencies";
import { canonicalJsonEqual } from "../services/libraryMutation/canonicalJson";
import type {
  AgentActionCapability,
  AgentActionIntent,
  AgentActionOperation,
  AgentActionParameters,
  AgentActionProofDomain,
} from "../types";

/** Model-facing structure for the same action fields decoded below. Names and
 * destinations are semantic references; numeric identities are optional. */
export const ACTION_INTENT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation",
    "coverage",
    "targetKind",
    "scopeRole",
    "reviewPreference",
  ],
  properties: {
    dependsOn: {
      type: "array",
      items: { type: "integer", minimum: 0 },
      uniqueItems: true,
    },
    contentFrom: { type: "string", minLength: 1 },
    destinationFrom: {
      type: "integer",
      minimum: 0,
      description:
        "Index of an earlier create_collection action supplying this destination; an action reference, never a native collection ID.",
    },
    reviewPreference: {
      type: "string",
      enum: ["default", "review", "direct"],
      description:
        "For this action only: review means the user wants to inspect changes before applying; direct means the user explicitly requests execution without optional review; otherwise default. Never infer review merely because the model chooses tags, metadata, papers, or destinations.",
    },
    operation: { type: "string", enum: Object.keys(OPERATION_CATALOG) },
    coverage: { type: "string", enum: ["one", "some", "all"] },
    targetKind: { type: "string", enum: ["papers", "items"] },
    scopeRole: { type: "string", enum: ["source", "destination"] },
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "path", "includeDescendants"],
      properties: {
        kind: { const: "collection" },
        referenceKind: { enum: ["literal", "descriptive"] },
        path: { type: "string", minLength: 1 },
        includeDescendants: { type: "boolean" },
      },
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        metadataValues: {
          type: "object",
          additionalProperties: true,
          minProperties: 1,
        },
        ...Object.fromEntries(
          [
            "tag",
            "newTag",
            "collectionName",
            "filePath",
            "newName",
            "newPath",
            "savedSearchName",
            "contentHash",
            "settingsKey",
            "settingsValue",
          ].map((key) => [key, { type: "string", minLength: 1 }]),
        ),
        ...Object.fromEntries(
          ["tags", "metadataFields", "identifiers", "filePaths"].map((key) => [
            key,
            { type: "array", items: { type: "string" }, minItems: 1 },
          ]),
        ),
        ...Object.fromEntries(
          [
            "destinationCollectionId",
            "collectionId",
            "savedSearchId",
            "targetItemId",
            "targetNoteId",
            "revertCount",
          ].map((key) => [key, { type: "integer", minimum: 1 }]),
        ),
        collectionIds: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          minItems: 1,
        },
        parentCollectionId: { type: ["integer", "null"], minimum: 1 },
        sourceCollectionId: {
          anyOf: [{ type: "integer", minimum: 1 }, { const: "all" }],
        },
        pageIndex: { type: "integer", minimum: 0 },
        noteMode: { enum: ["create", "edit", "append"] },
        semanticAction: {
          enum: ["add", "remove", "rename", "merge", "delete", "setColor"],
        },
        deleteItems: { type: "boolean" },
        permanent: { type: "boolean" },
      },
    },
    constraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        tagPrefix: { type: "string" },
        readMode: { const: "full" },
        collectionMode: { const: "move" },
      },
    },
    targetSelectors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: {
          kind: { enum: ["item_id", "item_key", "title"] },
          value: { type: ["string", "integer"] },
        },
      },
    },
    discovery: {
      type: "object",
      additionalProperties: false,
      required: ["description", "source"],
      properties: {
        description: { type: "string" },
        source: { enum: ["context", "library", "collection"] },
        collectionPath: { type: "string" },
      },
    },
  },
} as const;

function operationDetails(operation: string): {
  operation: AgentActionOperation;
  capability: AgentActionCapability;
  proofDomain: AgentActionProofDomain;
} | null {
  return operationCatalogEntry(operation);
}

function parseParameters(value: unknown): AgentActionParameters | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const tags = Array.isArray(record.tags)
    ? record.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : undefined;
  const stringArray = (key: string): string[] | undefined => {
    if (!Array.isArray(record[key])) return undefined;
    const values = (record[key] as unknown[])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    return values.length ? values : undefined;
  };
  const numberArray = (key: string): number[] | undefined => {
    if (!Array.isArray(record[key])) return undefined;
    const values = (record[key] as unknown[])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0);
    return values.length ? values : undefined;
  };
  const stringValue = (key: string): string | undefined =>
    typeof record[key] === "string" && String(record[key]).trim()
      ? String(record[key]).trim()
      : undefined;
  const positiveNumber = (key: string): number | undefined => {
    const number = Number(record[key]);
    return Number.isInteger(number) && number > 0 ? number : undefined;
  };
  const parameters: AgentActionParameters = {
    ...(tags?.length ? { tags } : {}),
    ...(record.metadataValues &&
    typeof record.metadataValues === "object" &&
    !Array.isArray(record.metadataValues) &&
    Object.keys(record.metadataValues).length
      ? { metadataValues: record.metadataValues as Record<string, unknown> }
      : {}),
    ...(stringArray("metadataFields")
      ? { metadataFields: stringArray("metadataFields") }
      : {}),
    ...(stringValue("tag") ? { tag: stringValue("tag") } : {}),
    ...(stringValue("newTag") ? { newTag: stringValue("newTag") } : {}),
    ...(stringValue("collectionName")
      ? { collectionName: stringValue("collectionName") }
      : {}),
    ...(stringValue("filePath") ? { filePath: stringValue("filePath") } : {}),
    ...(stringValue("newName") ? { newName: stringValue("newName") } : {}),
    ...(stringValue("newPath") ? { newPath: stringValue("newPath") } : {}),
    ...(stringValue("savedSearchName")
      ? { savedSearchName: stringValue("savedSearchName") }
      : {}),
    ...(stringArray("identifiers")
      ? { identifiers: stringArray("identifiers") }
      : {}),
    ...(stringArray("filePaths")
      ? { filePaths: stringArray("filePaths") }
      : {}),
    ...(stringValue("contentHash")
      ? { contentHash: stringValue("contentHash") }
      : {}),
    ...(stringValue("settingsKey")
      ? { settingsKey: stringValue("settingsKey") }
      : {}),
    ...(stringValue("settingsValue")
      ? { settingsValue: stringValue("settingsValue") }
      : {}),
    ...(positiveNumber("destinationCollectionId")
      ? { destinationCollectionId: positiveNumber("destinationCollectionId") }
      : {}),
    ...(positiveNumber("collectionId")
      ? { collectionId: positiveNumber("collectionId") }
      : {}),
    ...(positiveNumber("savedSearchId")
      ? { savedSearchId: positiveNumber("savedSearchId") }
      : {}),
    ...(numberArray("collectionIds")
      ? { collectionIds: numberArray("collectionIds") }
      : {}),
    ...(positiveNumber("targetItemId")
      ? { targetItemId: positiveNumber("targetItemId") }
      : {}),
    ...(positiveNumber("targetNoteId")
      ? { targetNoteId: positiveNumber("targetNoteId") }
      : {}),
    ...(record.pageIndex === 0 || positiveNumber("pageIndex")
      ? { pageIndex: Math.max(0, Math.floor(Number(record.pageIndex))) }
      : {}),
    ...(positiveNumber("revertCount")
      ? { revertCount: positiveNumber("revertCount") }
      : {}),
    ...(record.parentCollectionId === null
      ? { parentCollectionId: null }
      : positiveNumber("parentCollectionId")
        ? { parentCollectionId: positiveNumber("parentCollectionId") }
        : {}),
    ...(record.sourceCollectionId === "all"
      ? { sourceCollectionId: "all" as const }
      : positiveNumber("sourceCollectionId")
        ? { sourceCollectionId: positiveNumber("sourceCollectionId") }
        : {}),
    ...(record.noteMode === "create" ||
    record.noteMode === "edit" ||
    record.noteMode === "append"
      ? { noteMode: record.noteMode }
      : {}),
    ...(record.semanticAction === "add" ||
    record.semanticAction === "remove" ||
    record.semanticAction === "rename" ||
    record.semanticAction === "merge" ||
    record.semanticAction === "delete" ||
    record.semanticAction === "setColor"
      ? { semanticAction: record.semanticAction }
      : {}),
    ...(typeof record.deleteItems === "boolean"
      ? { deleteItems: record.deleteItems }
      : {}),
    ...(typeof record.permanent === "boolean"
      ? { permanent: record.permanent }
      : {}),
  };
  return Object.keys(parameters).length ? parameters : undefined;
}

function parseActionIntent(value: unknown): AgentActionIntent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const details =
    typeof record.operation === "string"
      ? operationDetails(record.operation)
      : null;
  if (!details) return null;
  const targetSelectors = parseTargetSelectors(record.targetSelectors);
  if (record.targetSelectors !== undefined && !targetSelectors) return null;
  if (
    record.coverage !== "one" &&
    record.coverage !== "some" &&
    record.coverage !== "all"
  ) {
    return null;
  }
  const discovery = record.discovery as AgentActionIntent["discovery"];
  if (
    discovery !== undefined &&
    (!discovery ||
      typeof discovery.description !== "string" ||
      !discovery.description.trim() ||
      !["context", "library", "collection"].includes(discovery.source) ||
      (discovery.source === "collection" &&
        (typeof discovery.collectionPath !== "string" ||
          !discovery.collectionPath.trim())) ||
      Object.keys(discovery).some(
        (key) => !["description", "source", "collectionPath"].includes(key),
      ))
  )
    return null;
  if (
    record.reviewPreference !== undefined &&
    !["default", "review", "direct"].includes(String(record.reviewPreference))
  )
    return null;
  const parameters = parseParameters(record.parameters);
  if (
    record.parameters !== undefined &&
    !canonicalJsonEqual(record.parameters, parameters || {})
  )
    return null;
  if (record.targetKind !== "items" && record.targetKind !== "papers")
    return null;
  if (
    record.scopeRole !== undefined &&
    record.scopeRole !== "source" &&
    record.scopeRole !== "destination"
  )
    return null;
  const rawScope = record.scope;
  const scope =
    rawScope &&
    typeof rawScope === "object" &&
    (rawScope as { kind?: unknown }).kind === "collection"
      ? {
          kind: "collection" as const,
          ...((rawScope as { referenceKind?: unknown }).referenceKind ===
          "descriptive"
            ? { referenceKind: "descriptive" as const }
            : (rawScope as { referenceKind?: unknown }).referenceKind ===
                "literal"
              ? { referenceKind: "literal" as const }
              : {}),
          path:
            typeof (rawScope as { path?: unknown }).path === "string" &&
            (rawScope as { path: string }).path.trim()
              ? (rawScope as { path: string }).path.trim()
              : undefined,
          includeDescendants:
            (rawScope as { includeDescendants?: unknown })
              .includeDescendants === true,
        }
      : undefined;
  if (rawScope !== undefined && !scope) return null;
  const constraintsValue = record.constraints;
  const constraintsRecord =
    constraintsValue && typeof constraintsValue === "object"
      ? (constraintsValue as Record<string, unknown>)
      : {};
  const tagPrefix =
    typeof constraintsRecord.tagPrefix === "string"
      ? constraintsRecord.tagPrefix.trim()
      : "";
  const readMode = constraintsRecord.readMode === "full" ? "full" : undefined;
  const collectionMode =
    constraintsRecord.collectionMode === "move" ? "move" : undefined;
  const constraints = {
    ...(tagPrefix ? { tagPrefix } : {}),
    ...(readMode ? { readMode } : {}),
    ...(collectionMode ? { collectionMode } : {}),
  };
  if (
    record.constraints !== undefined &&
    !canonicalJsonEqual(record.constraints, constraints)
  )
    return null;
  if (rawScope && typeof rawScope === "object") {
    if (
      Object.keys(rawScope).some(
        (key) =>
          !["kind", "path", "includeDescendants", "referenceKind"].includes(
            key,
          ),
      )
    )
      return null;
    if (
      (rawScope as any).referenceKind !== undefined &&
      !["literal", "descriptive"].includes((rawScope as any).referenceKind)
    )
      return null;
    if (
      typeof (rawScope as Record<string, unknown>).includeDescendants !==
      "boolean"
    )
      return null;
  }
  if (
    record.destinationFrom !== undefined &&
    (!Number.isSafeInteger(record.destinationFrom) ||
      Number(record.destinationFrom) < 0)
  )
    return null;
  if (record.dependsOn !== undefined && !isActionIndexList(record.dependsOn))
    return null;
  if (
    record.contentFrom !== undefined &&
    (typeof record.contentFrom !== "string" || !record.contentFrom.trim())
  )
    return null;
  return {
    ...details,
    ...(record.reviewPreference !== undefined
      ? {
          reviewPreference:
            record.reviewPreference as AgentActionIntent["reviewPreference"],
        }
      : {}),
    ...(record.dependsOn !== undefined
      ? { dependsOn: record.dependsOn as number[] }
      : {}),
    ...(typeof record.contentFrom === "string"
      ? { contentFrom: record.contentFrom }
      : {}),
    ...(typeof record.destinationFrom === "number"
      ? { destinationFrom: record.destinationFrom }
      : {}),
    ...(discovery ? { discovery } : {}),
    coverage: record.coverage,
    targetKind: record.targetKind === "items" ? "items" : "papers",
    scopeRole: record.scopeRole === "destination" ? "destination" : "source",
    parameters,
    ...(targetSelectors ? { targetSelectors } : {}),
    ...(scope ? { scope } : {}),
    ...(tagPrefix || readMode || collectionMode
      ? {
          constraints: {
            ...(tagPrefix ? { tagPrefix } : {}),
            ...(readMode ? { readMode } : {}),
            ...(collectionMode ? { collectionMode } : {}),
          },
        }
      : {}),
  };
}

function parseTargetSelectors(
  value: unknown,
): AgentActionIntent["targetSelectors"] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const selectors: NonNullable<AgentActionIntent["targetSelectors"]> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    if (
      entry.kind === "item_id" &&
      Number.isInteger(entry.value) &&
      entry.value > 0
    ) {
      selectors.push({ kind: "item_id", value: entry.value });
    } else if (
      (entry.kind === "title" || entry.kind === "item_key") &&
      typeof entry.value === "string" &&
      entry.value.trim() &&
      (entry.kind !== "item_key" || /^[A-Z0-9]{8}$/i.test(entry.value))
    ) {
      selectors.push({ kind: entry.kind, value: entry.value.trim() });
    } else return undefined;
  }
  return selectors;
}

export function parseActionIntents(value: unknown): AgentActionIntent[] {
  return Array.isArray(value)
    ? value
        .map(parseActionIntent)
        .filter((intent): intent is AgentActionIntent => Boolean(intent))
    : [];
}
