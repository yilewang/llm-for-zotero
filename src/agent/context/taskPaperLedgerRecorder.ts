/**
 * The host's one recorder for the Task progress ledger.
 *
 * `attestAndRecordRead` is the only way the tool-execution paths attest a
 * read: it issues the trusted read observations and derives the paper ledger
 * delta from the same call, so nothing can attest a read without recording
 * it. (The plan session re-attests a call the tool-execution path already
 * attested and recorded, to file plan evidence; it deliberately does not
 * record a second time.)
 *
 * `recordTaskPaperDecisions` is its counterpart for a call that is not a
 * read: the agent's paper decisions a tool result carries
 * (`AgentToolResult.paperDecisions`) become that call's delta, under the
 * call's own id and run. Both tool-execution paths (the built-in runtime and
 * the MCP server) emit the one delta a call yields the same way.
 */
import { createTrustedReadObservations } from "./readObservation";
import type { TrustedReadObservation } from "./readObservationTypes";
import type { ZoteroMcpToolActivityEvent } from "../mcp/activityTypes";
import type { AgentEvent } from "../types";
import {
  buildDecisionLedgerDelta,
  deriveTaskPaperLedgerDelta,
  type TaskPaperDecisionInput,
  type TaskPaperLedgerDelta,
  type TaskPaperResolvedRef,
} from "./taskPaperLedger";

export type PaperLedgerUpdateEvent = Extract<
  AgentEvent,
  { type: "paper_ledger_update" }
>;

type ZoteroItemLike = {
  id?: number;
  key?: string;
  libraryID?: number;
  parentID?: number | false | null;
};

function zoteroItem(id: number | undefined): ZoteroItemLike | null {
  if (!id) return null;
  try {
    const items = (
      globalThis as {
        Zotero?: { Items?: { get?: (id: number) => unknown } };
      }
    ).Zotero?.Items;
    const item = items?.get?.(id);
    return item && typeof item === "object" ? (item as ZoteroItemLike) : null;
  } catch {
    return null;
  }
}

/** The bibliographic item and library a row's ids name, as Zotero knows them. */
export function resolveZoteroPaperRef(ref: {
  itemId?: number;
  contextItemId?: number;
}): TaskPaperResolvedRef | null {
  const direct = zoteroItem(ref.itemId);
  const start = direct || zoteroItem(ref.contextItemId);
  if (!start) return null;
  const startId = (direct ? ref.itemId : ref.contextItemId) || 0;
  // An attachment stands for its parent paper.
  const parentId = Number(start.parentID) || 0;
  const paper = parentId ? zoteroItem(parentId) : start;
  const itemId = parentId || startId;
  if (!itemId) return null;
  const libraryID = Number(paper?.libraryID ?? start.libraryID) || undefined;
  return libraryID ? { itemId, libraryID } : { itemId };
}

/**
 * The ledger delta of one successful read call, or `null` when there is no
 * conversation to record it in (an MCP client without a conversation) or
 * the call read no paper. Never throws: the ledger is bookkeeping and must
 * not fail the call it describes.
 */
export function recordTaskPaperRead(params: {
  toolName: string;
  callId: string;
  input: unknown;
  /** The tool's original content, never a handle-replaced copy. */
  content: unknown;
  conversationKey?: number;
  libraryID?: number;
  runId?: string;
}): TaskPaperLedgerDelta | null {
  if (!params.conversationKey || params.conversationKey <= 0) return null;
  try {
    return deriveTaskPaperLedgerDelta({
      toolName: params.toolName,
      callId: params.callId,
      input: params.input,
      content: params.content,
      libraryID: params.libraryID,
      runId: params.runId,
      resolvePaper: resolveZoteroPaperRef,
    });
  } catch {
    return null;
  }
}

/**
 * The ledger delta of the paper decisions one successful call stated, or
 * `null` when there is no conversation to record it in or no decision is
 * left after bounding. Never throws, as `recordTaskPaperRead`.
 */
export function recordTaskPaperDecisions(params: {
  toolName: string;
  callId: string;
  decisions: readonly TaskPaperDecisionInput[] | undefined;
  conversationKey?: number;
  runId?: string;
}): TaskPaperLedgerDelta | null {
  if (!params.conversationKey || params.conversationKey <= 0) return null;
  if (!params.decisions?.length) return null;
  try {
    return buildDecisionLedgerDelta({
      toolName: params.toolName,
      callId: params.callId,
      runId: params.runId,
      decisions: params.decisions,
    });
  } catch {
    return null;
  }
}

/** Attest a successful read and record it in the task ledger, together. */
export async function attestAndRecordRead(params: {
  toolName: string;
  callId: string;
  input: unknown;
  result: unknown;
  conversationKey?: number;
  libraryID?: number;
  runId?: string;
}): Promise<{
  observations: TrustedReadObservation[];
  paperLedgerDelta: TaskPaperLedgerDelta | null;
}> {
  const observations = await createTrustedReadObservations({
    toolName: params.toolName,
    callId: params.callId,
    input: params.input,
    result: params.result,
  });
  const paperLedgerDelta = recordTaskPaperRead({
    toolName: params.toolName,
    callId: params.callId,
    input: params.input,
    content: params.result,
    conversationKey: params.conversationKey,
    libraryID: params.libraryID,
    runId: params.runId,
  });
  if (paperLedgerDelta && observations.length) {
    joinReadObservations(paperLedgerDelta, observations);
  }
  return { observations, paperLedgerDelta };
}

/**
 * File each read with the observation ids the host issued for its paper,
 * and each paper with its Zotero key, in place. Observations name papers by
 * key, the delta by item id; the key is looked up only for papers some
 * observation could name.
 */
export function joinReadObservations(
  delta: TaskPaperLedgerDelta,
  observations: readonly Pick<
    TrustedReadObservation,
    "observationId" | "libraryID" | "itemKey"
  >[],
  itemKeyOf: (itemId: number) => string | undefined = (itemId) => {
    const key = zoteroItem(itemId)?.key;
    return typeof key === "string" ? key : undefined;
  },
): void {
  const idsByPaper = new Map<string, string[]>();
  for (const observation of observations) {
    const identity = `${observation.libraryID}:${observation.itemKey}`;
    const ids = idsByPaper.get(identity) || [];
    if (!ids.includes(observation.observationId)) {
      ids.push(observation.observationId);
    }
    idsByPaper.set(identity, ids);
  }
  if (!idsByPaper.size) return;
  const idsByKey = new Map<string, string[]>();
  for (const paper of delta.papers) {
    if (!paper.itemKey) {
      const itemKey = itemKeyOf(paper.itemId);
      if (!itemKey || !idsByPaper.has(`${paper.libraryID}:${itemKey}`))
        continue;
      paper.itemKey = itemKey;
    }
    const ids = idsByPaper.get(`${paper.libraryID}:${paper.itemKey}`);
    if (ids?.length) idsByKey.set(paper.key, ids);
  }
  for (const read of delta.reads) {
    const ids = idsByKey.get(read.key);
    if (ids) read.observationIds = [...ids];
  }
}

export function buildPaperLedgerUpdateEvent(
  delta: TaskPaperLedgerDelta,
): PaperLedgerUpdateEvent {
  return { type: "paper_ledger_update", callId: delta.callId, delta };
}

/**
 * The run event a connected runtime's MCP activity carries, if any: only a
 * successful completion with a delta produces one.
 */
export function paperLedgerUpdateFromMcpActivity(
  event: Pick<ZoteroMcpToolActivityEvent, "phase" | "ok" | "paperLedgerDelta">,
): PaperLedgerUpdateEvent | null {
  if (event.phase !== "completed" || !event.ok || !event.paperLedgerDelta) {
    return null;
  }
  return buildPaperLedgerUpdateEvent(event.paperLedgerDelta);
}
