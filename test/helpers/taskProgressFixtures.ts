/** Ledger deltas, quote citations and outcome ledgers the Task progress tests share. */
import {
  buildDigestFailureLedgerDelta,
  buildDigestLedgerDelta,
  type TaskPaperDigestRelevance,
  type TaskPaperDigestStance,
  type TaskPaperLedgerDelta,
  type TaskPaperState,
} from "../../src/agent/context/taskPaperLedger";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
  RunEndState,
} from "../../src/agent/execution/types";
import type { QuoteCitation } from "../../src/shared/types";

/** One outcome of a run's ledger, as the host records it. */
export function outcomeTask(
  local: string,
  overrides: Partial<ExecutionCheckpointTask> = {},
): ExecutionCheckpointTask {
  return {
    taskId: `execution-1:task:${local}`,
    description: local,
    dependencies: [],
    status: "pending",
    journalActionIds: [],
    verifiedReceiptIds: [],
    readEvidenceIds: [],
    materialRefs: [],
    createdAt: 1,
    updatedAt: 1,
    effect: "mutation",
    origin: "model",
    ...overrides,
  };
}

/** A run's outcome ledger: its outcomes and, once it settled, how it ended. */
export function outcomeCheckpoint(
  tasks: ExecutionCheckpointTask[],
  end?: RunEndState,
  updatedAt = 2,
): ExecutionCheckpoint {
  return {
    version: 1,
    executionId: "execution-1",
    conversationKey: 42,
    conversationGeneration: 0,
    tasks,
    createdAt: 1,
    updatedAt,
    ...(end ? { end: { state: end } } : {}),
  };
}

export function ledgerDelta(
  callId: string,
  papers: Array<[number, TaskPaperState, string?]>,
  runId?: string,
): TaskPaperLedgerDelta {
  return {
    version: 1,
    callId,
    runId,
    toolName: "library_retrieve",
    papers: papers.map(([itemId, state]) => ({
      key: `1:${itemId}`,
      libraryID: 1,
      itemId,
      title: `Paper ${itemId}`,
      state,
    })),
    reads: papers
      .filter(([, , snippet]) => snippet)
      .map(([itemId, , snippet]) => ({
        key: `1:${itemId}`,
        callId,
        toolName: "library_retrieve",
        granularity: "passage" as const,
        method: "bm25",
        label: "Results",
        snippet,
      })),
  };
}

export function quoteCitation(id: string, itemId: number): QuoteCitation {
  return {
    id,
    quoteText: `Quoted evidence ${id}`,
    citationLabel: "(Smith, 2021)",
    itemId,
  };
}

/**
 * What the host records for one paper of a digest part: its answer (given
 * as `summary`) and verified evidence, or, given `failure`, why it has none.
 * Given `partId` and `label`, the reads name the part they answer, as they
 * do since parts were recorded; without them, a row saved before. Built by
 * the production builders, as `task_update` emits them.
 */
export function digestLedgerDelta(
  callId: string,
  itemId: number,
  options: {
    runId?: string;
    summary?: string;
    evidence?: Array<{ section?: string; quote: string; chunk?: number }>;
    failure?: string;
    partId?: string;
    label?: string;
    relevance?: TaskPaperDigestRelevance;
    stance?: TaskPaperDigestStance;
    /** The digest read only part of the text (an item over the digest limit). */
    partial?: boolean;
  } = {},
): TaskPaperLedgerDelta {
  const paper = { libraryID: 1, itemId, title: `Paper ${itemId}` };
  const part = {
    ...(options.partId ? { partId: options.partId } : {}),
    ...(options.label ? { label: options.label } : {}),
  };
  if (options.failure) {
    return buildDigestFailureLedgerDelta({
      runId: options.runId,
      callId,
      toolName: "task_update",
      ...part,
      failure: { target: `item:${itemId}`, itemId, reason: options.failure },
      paper,
    });
  }
  return buildDigestLedgerDelta({
    runId: options.runId,
    callId,
    toolName: "task_update",
    ...part,
    digest: {
      schema: 2,
      itemId,
      contextItemId: itemId + 100,
      answer: options.summary ?? `Paper ${itemId} in brief.`,
      ...(options.relevance ? { relevance: options.relevance } : {}),
      ...(options.stance ? { stance: options.stance } : {}),
      evidence: options.evidence ?? [],
      facets: [],
      gaps: [],
      source: {
        backend: "mineru",
        readCharacters: 1000,
        totalCharacters: options.partial ? 4000 : 1000,
        complete: !options.partial,
      },
      model: "test-model",
      producedAt: 1,
      cacheKey: `digest-${itemId}`,
    },
    paper,
  });
}
