import { fnv1a32 } from "../../utils/fnv1a";
import { noteHtmlMatches } from "../../utils/noteHtml";
import type {
  AgentActionProposal,
  AgentToolActionDescriptor,
  AgentToolDefinition,
} from "../types";
import type { LibraryMutationOperation } from "../services/libraryMutationService";
import type { NativeNoteWriteEvidence } from "../services/libraryMutation/contracts";
import {
  actionDetailsForLibraryMutation,
  capabilityForLibraryMutation,
  isRegisteredLibraryMutationOperation,
} from "../services/libraryMutation/handlerOperations";
import { innermostToolResult } from "./toolResultEnvelope";
import { operationAuthorityIsConsistent } from "./operationCatalog";
import { normalizeNotePlainText, stripNoteHtml } from "../../utils/noteText";
import { sha256Text } from "../store/journalRecoveryBlobStore";

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
  getItemByLibraryAndKey?(libraryID: number, key: string): Zotero.Item | null;
  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): { fields: Record<string, string>; creators: unknown[] } | null;
};

export type PreparedActionExecution = {
  executionClass: "read" | "control" | "external_effect";
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
  return `fnv1a32:${fnv1a32(value)}`;
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

/**
 * The shared adapter for tools whose validated input already carries canonical
 * library mutation operations.
 *
 * `prepareActionExecution` applies exactly this rule when a definition declares
 * no `describeAction`. Registration now requires every external effect to name
 * its adapter, so these tools declare this function instead of relying on the
 * implicit fallback, and their adapter no longer appears and disappears with
 * the shape of the input.
 *
 * It has two branches, and a tool that names it owns both. When the validated
 * input carries no library mutation operation this falls through to
 * `explicitReadActions`, which describes `read_full` for an input with
 * `mode: "full"`. A tool whose schema can reach that branch must declare
 * `read_full` in its `effectOperations`; none of the current callers can, and
 * `prepareActionExecution` refuses the descriptor if one ever does without
 * declaring it.
 */
export function describeLibraryMutationInput(
  input: unknown,
): AgentToolActionDescriptor[] {
  return extractLibraryMutationOperations(input).length
    ? describeLibraryMutationActions(input)
    : explicitReadActions(input);
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

export type NoteWriteVerification =
  | {
      targets: string[];
      /**
       * Content evidence this verification actually consumed, as receipt facts.
       * A native read-back yields a digest fact, the weaker plain-text fallback
       * yields only a text-match fact, so the two evidence strengths stay
       * distinguishable on the receipt. See the digest's provenance limit where
       * the `html_sha256` fact is built below.
       */
      facts: string[];
      reason?: never;
    }
  | { targets: null; facts?: never; reason: string };

export async function verifyNoteWriteTarget(
  proposal: AgentActionProposal,
  content: unknown,
  gateway: ActionContractGateway,
): Promise<NoteWriteVerification> {
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
  const verification = result?.noteVerification as
    | {
        noteId?: number;
        matches?: boolean;
        html?: string;
        expectedHtml?: string;
      }
    | undefined;
  if (verification) {
    if (
      verification.noteId !== note.id ||
      verification.matches !== true ||
      typeof verification.html !== "string" ||
      typeof verification.expectedHtml !== "string" ||
      !noteHtmlMatches(String(note.getNote() || ""), verification.html) ||
      !noteHtmlMatches(verification.html, verification.expectedHtml)
    ) {
      return {
        targets: null,
        reason:
          "The native note evidence does not prove the prepared change on the bound note.",
      };
    }
    // Provenance limit, and it is narrow: the digest is taken over the
    // read-back string the tool result supplied, not over the stored note
    // bytes. The checks above prove that string is *canonically* equal to
    // `note.getNote()` and to the expected HTML — `noteHtmlMatches` normalizes
    // whitespace, sorts attributes and strips Zotero's wrapper divs — so two
    // semantically identical spellings of the same note hash differently. The
    // fact therefore means "a forced native read-back matched the expected
    // HTML", and it is only usable as a strength token and as a
    // receipt-to-receipt equality token. Never recompute it from a live note
    // and expect a match.
    return {
      targets: [itemTarget(noteId)],
      facts: [
        `native_note:${noteId}:html_sha256:${await sha256Text(verification.html)}`,
      ],
    };
  }
  if (proposal.parameters?.expectedText?.trim()) {
    const actual = normalizeNotePlainText(
      stripNoteHtml(String(note.getNote?.() || "")),
    );
    const expected = normalizeNotePlainText(proposal.parameters.expectedText);
    const textMatches =
      mode === "edit" ? actual === expected : actual.includes(expected);
    if (!textMatches) {
      return {
        targets: null,
        reason: `Stored content for note ${noteId} does not satisfy the requested note text.`,
      };
    }
    return {
      targets: [itemTarget(noteId)],
      facts: [`native_note:${noteId}:text_match`],
    };
  }
  return { targets: [itemTarget(noteId)], facts: [] };
}

/**
 * The per-note facts a write that created several notes at once owes.
 *
 * A batch that wrote three notes is still three note writes, and the rule
 * every native write answers to -- a receipt fact minted from a native
 * re-read of what was written -- does not weaken because the notes shared one
 * approval. Each entry is therefore put through exactly the verifier a single
 * `note_write` is put through: the note is read back out of live Zotero state
 * here, at receipt time, and checked against the read-back its creation
 * forced. Nothing else is credited -- the evidence carries only the notes the
 * call physically created, so an item it skipped as already written, or one it
 * failed on, contributes no fact and is left to the receipt that did write it.
 *
 * A note whose re-read fails contributes a REASON instead, in the same
 * wording and from the same verifier the single-note branch reports. The
 * whole-set postcondition is a claim about the set and can still hold while
 * one note of the set is gone, so without the reason the only symptom would
 * be a missing fact -- indistinguishable from a note the call never wrote.
 */
export async function nativeNoteWriteFacts(
  proposal: AgentActionProposal,
  noteWrites: readonly NativeNoteWriteEvidence[] | undefined,
  gateway: ActionContractGateway,
): Promise<{ facts: string[]; reasons: string[] }> {
  const facts: string[] = [];
  const reasons: string[] = [];
  for (const write of noteWrites || []) {
    const verification = await verifyNoteWriteTarget(
      {
        ...proposal,
        operation: "note_create",
        parameters: {
          noteMode: "create",
          ...(write.parentItemId ? { targetItemId: write.parentItemId } : {}),
        },
        destinationCollectionIds: write.collections || [],
      },
      { noteId: write.noteId, noteVerification: write.verification },
      gateway,
    );
    if (!verification.targets) {
      reasons.push(verification.reason);
      continue;
    }
    facts.push(
      ...verification.targets.map((target) => `created_note:${target}`),
      ...verification.facts,
    );
  }
  return { facts, reasons };
}

export async function prepareActionExecution(
  tool: AgentToolDefinition<any, any>,
  input: unknown,
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
  // The registry validates the definition's declared operations against the
  // catalog, but registration has no input and so cannot see what the adapter
  // actually produces. This is the other half: the declaration is only worth
  // anything if a descriptor outside it is refused. Tools that declare nothing
  // are reads and controls, which own no effect to declare.
  const declared = tool.effectOperations;
  for (const proposal of proposals) {
    if (!operationAuthorityIsConsistent(proposal)) {
      throw new Error(
        `Typed action adapter rejected an inconsistent authority triple for ${proposal.operation}.`,
      );
    }
    if (declared && !declared.includes(proposal.operation)) {
      throw new Error(
        `Typed action adapter for ${tool.spec.name} described "${proposal.operation}", which it never declared: effectOperations is [${declared.join(", ")}].`,
      );
    }
  }
  const requestedTargets = uniqueStrings(
    proposals.flatMap((proposal) => proposal.requestedTargets),
  );
  const destinationCollectionIds = uniqueNumbers([
    ...proposals.flatMap((proposal) => proposal.destinationCollectionIds),
  ]);
  const verifiedFacts = verifiedFactsForInput(input);
  return {
    executionClass: tool.spec.executionClass,
    hasExplicitAdapter: Boolean(tool.describeAction) || operations.length > 0,
    proposals,
    operations,
    requestedTargets,
    destinationCollectionIds,
    alreadySatisfiedTargets: [],
    verifiedFacts,
  };
}
