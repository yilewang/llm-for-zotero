import type {
  AgentActionProposal,
  AgentToolActionDescriptor,
  AgentToolDefinition,
} from "../types";
import type { LibraryMutationOperation } from "../services/libraryMutationService";
import {
  actionDetailsForLibraryMutation,
  capabilityForLibraryMutation,
  isRegisteredLibraryMutationOperation,
} from "../services/libraryMutation/handlerOperations";
import { innermostToolResult } from "./toolResultEnvelope";

export type CollectionSummary = {
  collectionId: number;
  libraryID: number;
  name: string;
  path?: string;
};

export type ActionContractGateway = {
  getCollectionSummary(collectionId: number): CollectionSummary | null;
  getCollectionNativeState?(collectionId: number): {
    exists: boolean;
    name: string;
    parentCollectionId: number | null;
    deleted: boolean;
  };
  getSettingNativeState?(key: string): { exists: boolean; value: unknown };
  listCollectionSummaries(libraryID: number): CollectionSummary[];
  /** Native collection state for scope freezing; must not use a search snapshot. */
  listCurrentCollectionSummaries?(libraryID: number): CollectionSummary[];
  /** Direct native members used to freeze and revalidate action scope. */
  listCurrentCollectionTargetIds?(params: {
    libraryID: number;
    collectionId: number;
    targetKind: "papers" | "items";
  }): number[];
  /** Current native top-level targets used to freeze whole-library scope. */
  listCurrentLibraryTargetIds?(params: {
    libraryID: number;
    targetKind: "papers" | "items";
  }): Promise<number[]>;
  listCollectionPaperTargets(params: {
    libraryID: number;
    collectionId: number;
  }): Promise<{ papers: Array<{ itemId: number }> }>;
  listLibraryPaperTargets?(params: {
    libraryID: number;
  }): Promise<{ papers: Array<{ itemId: number }> }>;
  listCollectionItemTargets(params: {
    libraryID: number;
    collectionId: number;
  }): Promise<{ items: Array<{ itemId: number }> }>;
  listLibraryItemTargets?(params: {
    libraryID: number;
  }): Promise<{ items: Array<{ itemId: number }> }>;
  getItem(itemId: number): Zotero.Item | null;
  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): { fields: Record<string, string>; creators: unknown[] } | null;
};

export type PreparedActionExecution = {
  mutability: "read" | "write";
  hasExplicitAdapter: boolean;
  proposals: AgentActionProposal[];
  operations: LibraryMutationOperation[];
  requestedTargets: string[];
  destinationCollectionIds: number[];
  alreadySatisfiedTargets: string[];
  verifiedFacts: string[];
};

function nestedOperationResult(
  content: unknown,
): Record<string, unknown> | null {
  const result = innermostToolResult(content);
  return Object.keys(result).length ? result : null;
}

export function normalizePath(value: string | undefined): string {
  return (value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function uniqueNumbers(values: number[]): number[] {
  return [
    ...new Set(values.filter((value) => Number.isInteger(value) && value > 0)),
  ];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function itemTarget(itemId: number): string {
  return `item:${itemId}`;
}

export function fingerprintText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function extractLibraryMutationOperations(
  input: unknown,
): LibraryMutationOperation[] {
  if (!input || typeof input !== "object") return [];
  if (isRegisteredLibraryMutationOperation(input)) return [input];
  const record = input as Record<string, unknown>;
  if (isRegisteredLibraryMutationOperation(record.operation)) {
    return [record.operation];
  }
  return Array.isArray(record.operations) &&
    record.operations.every(isRegisteredLibraryMutationOperation)
    ? record.operations
    : [];
}

export function describeLibraryMutationActions(
  input: unknown,
): AgentToolActionDescriptor[] {
  return extractLibraryMutationOperations(input).map((operation, index) => {
    const details = actionDetailsForLibraryMutation(operation);
    return {
      id: `${operation.type}:${operation.id || index}`,
      proofDomain: "zotero_state",
      capability: capabilityForLibraryMutation(operation),
      operation: operation.type,
      parameters: details.parameters,
      source: "library_mutation",
      operationValue: operation,
      requestedTargets: details.requestedTargets,
      destinationCollectionIds: details.destinationCollectionIds,
    };
  });
}

function explicitReadActions(input: unknown): AgentActionProposal[] {
  if (
    input &&
    typeof input === "object" &&
    (input as { mode?: unknown }).mode === "full"
  ) {
    return [
      {
        id: "read_full:0",
        proofDomain: "zotero_state",
        capability: "zotero.read",
        operation: "read_full",
        source: "full_read",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ];
  }
  return [];
}

function verifiedFactsForInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  if (record.mode === "full") return ["read_mode:full"];
  return [];
}

function itemCollections(item: Zotero.Item | null): number[] {
  return uniqueNumbers(
    (item?.getCollections?.() || []).map((value: unknown) => Number(value)),
  );
}

function normalizeNoteText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)>\s?/g, "$1")
    .replace(/(^|\s)[+-]\s+/g, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type NoteWriteVerification =
  | { targets: string[]; reason?: never }
  | { targets: null; reason: string };

export function verifyNoteWriteTarget(
  proposal: AgentActionProposal,
  content: unknown,
  gateway: ActionContractGateway,
): NoteWriteVerification {
  if (
    proposal.operation !== "note_create" &&
    proposal.operation !== "note_edit" &&
    proposal.operation !== "note_append" &&
    proposal.operation !== "save_note"
  ) {
    return { targets: null, reason: "The tool has no note-write descriptor." };
  }
  const mode =
    proposal.parameters?.noteMode ||
    (proposal.operation === "note_edit"
      ? "edit"
      : proposal.operation === "note_append"
        ? "append"
        : "create");
  const result = nestedOperationResult(content);
  const noteId = Number(result?.noteId);
  if (!(noteId > 0)) {
    return {
      targets: null,
      reason: "The note mutation returned no stable note ID to verify.",
    };
  }
  const note = noteId > 0 ? gateway.getItem(noteId) : null;
  if (!note) {
    return {
      targets: null,
      reason: `Created note ${noteId} was not readable from Zotero state immediately after mutation.`,
    };
  }
  if (note.isNote?.() !== true || Boolean(note.deleted)) {
    return {
      targets: null,
      reason: `Zotero item ${noteId} is not a live note after mutation.`,
    };
  }
  if (
    proposal.parameters?.targetNoteId &&
    Number(proposal.parameters.targetNoteId) !== Number(note.id)
  ) {
    return {
      targets: null,
      reason: `The mutation affected note ${note.id}, not requested note ${proposal.parameters.targetNoteId}.`,
    };
  }
  if (
    mode === "create" &&
    proposal.parameters?.targetItemId &&
    Number(note.parentID) !== Number(proposal.parameters.targetItemId)
  ) {
    return {
      targets: null,
      reason: `Created note ${noteId} is not attached to requested item ${proposal.parameters.targetItemId}.`,
    };
  }
  if (
    proposal.destinationCollectionIds.length &&
    !proposal.destinationCollectionIds.every((collectionId) =>
      itemCollections(note).includes(collectionId),
    )
  ) {
    return {
      targets: null,
      reason: `Created note ${noteId} is missing one or more requested collection memberships.`,
    };
  }
  if (proposal.parameters?.expectedText?.trim()) {
    const actual = normalizeNoteText(String(note.getNote?.() || ""));
    const expected = normalizeNoteText(proposal.parameters.expectedText);
    const textMatches =
      mode === "edit" ? actual === expected : actual.includes(expected);
    if (!textMatches) {
      return {
        targets: null,
        reason: `Stored content for note ${noteId} does not satisfy the requested note text.`,
      };
    }
  }
  return { targets: [itemTarget(noteId)] };
}

export async function prepareActionExecution(
  tool: AgentToolDefinition<any, any>,
  input: unknown,
  _gateway: ActionContractGateway,
  context?: import("../types").AgentToolContext,
): Promise<PreparedActionExecution> {
  const operations = extractLibraryMutationOperations(input);
  const described = tool.describeAction
    ? await tool.describeAction(input, context)
    : undefined;
  const proposals =
    described ||
    (operations.length
      ? describeLibraryMutationActions(input)
      : explicitReadActions(input));
  const requestedTargets = uniqueStrings(
    proposals.flatMap((proposal) => proposal.requestedTargets),
  );
  const destinationCollectionIds = uniqueNumbers([
    ...proposals.flatMap((proposal) => proposal.destinationCollectionIds),
  ]);
  const verifiedFacts = verifiedFactsForInput(input);
  return {
    mutability: tool.spec.mutability,
    hasExplicitAdapter: Boolean(tool.describeAction) || operations.length > 0,
    proposals,
    operations,
    requestedTargets,
    destinationCollectionIds,
    alreadySatisfiedTargets: [],
    verifiedFacts,
  };
}
