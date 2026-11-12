import { buildActionCallDigest } from "../authorization/proposal";
import type { ActionContractRunSession } from "../contracts/actionContractRunSession";
import { createUnverifiedReceipt } from "../contracts/actionEvaluation";
import type { PaperEvidenceFrontier } from "../context/paperEvidenceFrontier";
import type {
  AgentPendingReadActivity,
  buildAgentResourceContextPlan,
} from "../context/resourceContextPlan";
import type { MaterialRef } from "../documents/materialRef";
import type { TrustedReadObservation } from "../context/readObservationTypes";
import {
  outsidePaperRecordsFromToolResult,
  prefetchOutsidePaperLookups,
  rememberOutsidePapers,
} from "../context/outsidePaperRecords";
import {
  buildArtifactFollowupMessage,
  filterFollowupMessageForCapabilities,
  type ToolWorkflowDelivery,
  type ToolWorkflowOutcome,
} from "../model/toolArtifactDelivery";
import { resolveCapabilitiesContentInputs } from "../model/contentCapabilities";
import {
  attestAndRecordRead,
  buildPaperLedgerUpdateEvent,
  recordTaskPaperDecisions,
} from "../context/taskPaperLedgerRecorder";
import {
  readObservationSourceKey,
  readObservationSourceKeys,
} from "../context/readObservation";
import { shortEvidenceRef } from "../context/evidenceRefTokens";
import {
  taskPaperReadDepths,
  type TaskPaperLedgerDelta,
} from "../context/taskPaperLedger";
import {
  openDeclaredOutcomes,
  papersAlreadyWritten,
  type OutcomeDocumentExclusion,
  type OutcomeEvidence,
} from "../loop/outcomes";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { PERSISTED_TOOL_RESULT_MAX_BYTES } from "../store/truncatedToolResult";
import {
  createAgentToolResultHandleRecord,
  type AgentToolResultHandleRecord,
} from "../store/toolResultHandles";
import { buildAgentStageEvent } from "../stageEvents";
import { resolvePreparedActionReview } from "../tools/execution/review";
import type { AgentToolRegistry } from "../tools/registry";
import { resolveAgentToolPresentationLabel } from "../toolPresentation";
import { resolveAgentToolCallWorkCategory } from "../workCategory";
import { withConversationWriteLock } from "../../shared/conversationWriteFence";
import {
  buildSyntheticToolCall,
  isUserDeniedToolResult,
  readToolError,
  setToolResultReadAvailability,
} from "./toolResultLifecycle";
import type {
  AgentActionProposal,
  AgentActionReceipt,
  AgentConfirmationResolution,
  AgentEvent,
  AgentInheritedApproval,
  AgentModelCapabilities,
  AgentModelMessage,
  AgentPendingAction,
  AgentRuntimeRequest,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolEffect,
  AgentToolResult,
} from "../types";

/** How the model reaches what a sized view left out. */
const MODEL_VIEW_HANDLE_NOTICE =
  "This result is sized to the request; omitted counts what it left out. context_read source:'tool_result' with this handle pages the exact stored result, which lists the rows shown here first: read a row path from offset = the number of rows shown.";

/** One tool call the turn executed, as the runtime's loop consumes it. */
export type ExecutedToolCall = {
  toolResult: AgentToolResult;
  toolDefinition?: import("../types").AgentToolDefinition<any, any>;
  input?: unknown;
  documentEvidenceRefs?: unknown[];
  /** The model's sized view of a successful result, for a tool that sizes it. */
  modelView?: Record<string, unknown>;
};

/** What the turn remembers about a tool call for its own summaries. */
export type ToolExecutionRecord = {
  name: string;
  ok: boolean;
  mutability?: "read" | "write";
  effect?: AgentToolEffect;
  input?: unknown;
  content?: unknown;
  actionReceipts?: AgentActionReceipt[];
  /**
   * For paper_read: whether the read added evidence the turn lacked. A read
   * that added none is navigation, not progress (`turnBoundary.ts`).
   */
  frontier?: "advanced" | "unchanged" | "unavailable";
};

/**
 * Everything the tool-execution block used to reach through `runTurn`'s
 * closure.
 *
 * A turn builds one of these and keeps it for the whole turn. Read-only
 * state is passed by reference -- `request` and `context` are `const`
 * objects the turn keeps mutating in place, so the collaborator must see the
 * same objects rather than a copy. The two turn-scoped `let` bindings this
 * block writes are reached through setters, because the loop outside reads
 * them again after a tool call returns.
 */
export type ToolExecutionDeps = {
  /** The tool registry that resolves, prepares and executes a call. */
  registry: AgentToolRegistry;
  /** The turn's clock, for durable records this block writes. */
  now: () => number;
  /** The caller's cancellation signal, checked at each tool boundary. */
  signal?: AbortSignal;
  /** The single event emitter of the turn; every event goes through it. */
  emit: (event: AgentEvent) => Promise<void>;
  /** The turn's request object, mutated in place as evidence accumulates. */
  request: AgentRuntimeRequest;
  /** The run this turn is writing. */
  runId: string;
  /** The tool context, mutated in place by the turn after this is built. */
  context: AgentToolContext;
  /** Whether the conversation still accepts writes from this turn. */
  writeAllowed: () => boolean;
  /** The adapter's content capabilities, for follow-up message filtering. */
  adapterCapabilities: AgentModelCapabilities;
  /** The turn's action-contract session, which records tool receipts. */
  actionContractSession: ActionContractRunSession;
  /** The paper-evidence frontier that caches and trims paper reads. */
  paperEvidenceFrontier: PaperEvidenceFrontier;
  /** The turn's resource plan, whose signature keys evidence reuse. */
  resourceContextPlan: ReturnType<typeof buildAgentResourceContextPlan>;
  /**
   * Durable persistence for compacted tool-result handles. Resolves to false
   * when the records did not reach the database; a writer that reports
   * nothing (void) is taken at its word.
   */
  persistToolResultHandles: (
    records: AgentToolResultHandleRecord[],
  ) => Promise<boolean | void>;
  /** Raises a confirmation card and waits for the user's resolution. */
  requestActionResolution: (action: AgentPendingAction) => Promise<{
    requestId: string;
    resolution: AgentConfirmationResolution;
  }>;
  /** Material this run finalized, keyed by document id. */
  finalizedMaterialRefs: Map<string, MaterialRef>;
  /** Read activities awaiting commit at the end of the turn. */
  pendingReadActivities: AgentPendingReadActivity[];
  /** Handle records this turn wrote, preserved for its own recovery. */
  preservedTurnHandleRecords: AgentToolResultHandleRecord[];
  /** Every tool call of the turn, in order. */
  toolExecutionRecords: ToolExecutionRecord[];
  /** The names of the tools this turn called. */
  toolsUsedThisTurn: string[];
  /** The summaries of the prepared actions this turn verified. */
  /**
   * The answer text streamed so far.
   *
   * A getter because the model loop keeps appending to and rolling back the
   * turn's `currentAnswerText`; a tool context must see its value now, not
   * the value it had when this collaborator was built.
   */
  getCurrentAnswerText: () => string;
  /**
   * Records the material a terminal tool result finalized.
   *
   * A setter because `finalizedMaterial` is a `let` in `runTurn`, and the
   * finalization path reads it again after this block writes it.
   */
  setFinalizedMaterial: (material: {
    documentId: string;
    finalText: string;
  }) => void;
  /**
   * Records that a durable tool-result handle now exists.
   *
   * A setter because `toolResultReadAvailable` is a `let` in `runTurn` and
   * the next model step reads it to decide whether context_read may serve
   * source:'tool_result' reads.
   */
  setToolResultReadAvailable: (available: boolean) => void;
  /**
   * Hands each call's outcome evidence to the turn's ledger owner.
   *
   * Supplied only on ordinary Original Agent turns.
   */
  recordOutcomeEvidence?: (evidence: OutcomeEvidence) => Promise<void>;
};

/** The tool-execution collaborator of one turn. */
export type ToolExecution = {
  executePreparedToolCall: (
    call: AgentToolCall,
    round: number,
    options?: {
      inheritedApproval?: AgentInheritedApproval;
    },
  ) => Promise<ExecutedToolCall>;
  buildToolDelivery: (
    toolResult: AgentToolResult,
    callId: string,
    toolDefinition?: import("../types").AgentToolDefinition<any, any>,
    contentOverride?: unknown,
    extraFollowupMessages?: AgentModelMessage[],
  ) => Promise<ToolWorkflowDelivery>;
  executeToolWorkflow: (
    call: AgentToolCall,
    round: number,
    options?: {
      modelCallId?: string;
      suppressModelDelivery?: boolean;
      inheritedApproval?: AgentInheritedApproval;
      /** Calls after this one in the same model step, still to run. */
      followingCallCount?: number;
    },
  ) => Promise<ToolWorkflowOutcome>;
};

/**
 * The papers a material-producing call's validated input leaves out
 * (submit_document's `excluded`), with their reasons; none for a call that
 * names none.
 */
function documentExclusionsOf(input: unknown): OutcomeDocumentExclusion[] {
  const named = (input as { excluded?: unknown } | null | undefined)?.excluded;
  if (!Array.isArray(named)) return [];
  return named.flatMap((entry) => {
    const { targetIds, reason } = (entry || {}) as {
      targetIds?: unknown;
      reason?: unknown;
    };
    const targets = Array.isArray(targetIds)
      ? targetIds.filter(
          (target): target is string => typeof target === "string",
        )
      : [];
    return targets.length && typeof reason === "string" && reason.trim()
      ? [{ targets, reason: reason.trim() }]
      : [];
  });
}

/**
 * The outcome evidence one executed call carries: the papers it read, each
 * receipt, the material it finalized, and a write the user declined.
 */
async function outcomeEvidenceOf(params: {
  toolResult: AgentToolResult;
  toolDefinition?: import("../types").AgentToolDefinition<any, any>;
  input: unknown;
  context: AgentToolContext;
  paperLedgerDelta: TaskPaperLedgerDelta | null;
  observationIds: readonly string[];
  /** The call's arguments, when a review card showed them to the user. */
  reviewedArguments?: unknown;
}): Promise<OutcomeEvidence[]> {
  const { toolResult } = params;
  const evidence: OutcomeEvidence[] = [];
  // How deep the call read each paper decides which parts it ticks.
  const depths = taskPaperReadDepths(params.paperLedgerDelta);
  const item = (itemId: number) => `item:${itemId}`;
  if (
    toolResult.ok &&
    (depths.text.length ||
      depths.shallow.length ||
      depths.noText.length ||
      params.observationIds.length)
  ) {
    evidence.push({
      kind: "read",
      targets: depths.text.map(item),
      ...(depths.shallow.length ? { shallow: depths.shallow.map(item) } : {}),
      ...(depths.noText.length ? { noText: depths.noText.map(item) } : {}),
      observationIds: params.observationIds,
    });
  }
  for (const receipt of toolResult.actionReceipts || []) {
    evidence.push({ kind: "receipt", receipt });
  }
  if (toolResult.materialRef) {
    // The part the call named, the document's kind and the papers it cites
    // decide which part the material completes and which of its papers; the
    // papers it leaves out are recorded on that part.
    const named = (params.input as { taskId?: unknown } | null | undefined)
      ?.taskId;
    const taskId =
      typeof named === "string" && named.trim() ? named.trim() : undefined;
    const excluded = documentExclusionsOf(params.input);
    const citedTargets = [
      ...new Set(
        (toolResult.materialCitedSources || []).flatMap((source) =>
          typeof source.itemId === "number" && source.itemId > 0
            ? [item(source.itemId)]
            : [],
        ),
      ),
    ];
    evidence.push({
      kind: "material",
      materialRef: toolResult.materialRef,
      ...(taskId ? { taskId } : {}),
      ...(toolResult.materialKind
        ? { documentKind: toolResult.materialKind }
        : {}),
      // Known for every material, so an empty list means it cites nothing.
      citedTargets,
      ...(excluded.length ? { excluded } : {}),
    });
  }
  if (
    isUserDeniedToolResult(toolResult) &&
    params.toolDefinition?.describeAction
  ) {
    let proposals: AgentActionProposal[] = [];
    try {
      proposals =
        (await params.toolDefinition.describeAction(
          params.input as never,
          params.context,
        )) || [];
    } catch {
      proposals = [];
    }
    if (proposals.length) {
      evidence.push({
        kind: "declined",
        callId: toolResult.callId,
        proposals: proposals.map(
          ({ capability, operation, requestedTargets }) => ({
            capability,
            operation,
            requestedTargets,
          }),
        ),
      });
    }
  } else if (params.reviewedArguments !== undefined && params.toolDefinition) {
    const untouched = await leftUntouchedInReview({
      callId: toolResult.callId,
      toolDefinition: params.toolDefinition,
      shownArguments: params.reviewedArguments,
      input: params.input,
      context: params.context,
    });
    if (untouched) evidence.push(untouched);
  }
  return evidence;
}

/**
 * The rows the user left untouched in a card it approved: the targets the
 * write named as the card showed it that the call no longer names once the
 * user's edits were applied. Only a write that named several targets has
 * rows to leave out.
 */
async function leftUntouchedInReview(params: {
  callId: string;
  toolDefinition: AgentToolDefinition<any, any>;
  shownArguments: unknown;
  input: unknown;
  context: AgentToolContext;
}): Promise<OutcomeEvidence | undefined> {
  const describe = params.toolDefinition.describeAction;
  if (!describe) return undefined;
  try {
    const shownInput = params.toolDefinition.validate(params.shownArguments);
    if (!shownInput.ok) return undefined;
    const shown = (await describe(shownInput.value, params.context)) || [];
    if (new Set(shown.flatMap((write) => write.requestedTargets)).size < 2) {
      return undefined;
    }
    const kept = new Set(
      ((await describe(params.input, params.context)) || []).flatMap(
        (write) => write.requestedTargets,
      ),
    );
    const proposals = shown.flatMap(
      ({ capability, operation, requestedTargets }) => {
        const left = requestedTargets.filter((target) => !kept.has(target));
        return left.length
          ? [{ capability, operation, requestedTargets: left }]
          : [];
      },
    );
    return proposals.length
      ? { kind: "declined", callId: params.callId, proposals, narrowed: true }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the tool-execution collaborator for one turn.
 *
 * This is the block that turns a model's tool call into an executed call,
 * its events, its receipts and the message the model reads next. It was
 * three closures inside `runTurn`; the state they shared is now `deps`.
 */
export function createToolExecution(deps: ToolExecutionDeps): ToolExecution {
  // The read evidence of each call this turn, so a re-read the paper
  // evidence cache answers attests its papers again (a part declared since
  // the first read still takes them).
  const readEvidenceByCall = new Map<string, OutcomeEvidence>();
  // The handle each call's result was stored under this turn, so the trace
  // names that one instead of storing the same result twice.
  const handleByCallId = new Map<string, string>();
  /**
   * Stores a result the model reads only part of under a trh_ handle that
   * context_read pages for the rest of the conversation. Undefined when no
   * handle can be made, so nothing may be left out.
   */
  const persistResultHandle = async (params: {
    call: AgentToolCall;
    input: unknown;
    content: unknown;
  }): Promise<string | undefined> => {
    const inputDigest = `sha256:${await sha256Text(
      canonicalJson(params.input),
    )}`;
    const record = createAgentToolResultHandleRecord({
      conversationKey: deps.request.conversationKey,
      toolName: params.call.name,
      toolCallId: params.call.id,
      inputDigest,
      resourceSignature: deps.resourceContextPlan.resourceSignature,
      content: params.content,
      createdAt: deps.now(),
    });
    if (!record) return undefined;
    // Only a handle the database holds may name the result in the trace.
    if ((await deps.persistToolResultHandles([record])) !== false)
      handleByCallId.set(params.call.id, record.handle);
    deps.preservedTurnHandleRecords.push(record);
    deps.setToolResultReadAvailable(true);
    setToolResultReadAvailability(deps.request, true);
    return record.handle;
  };

  /** Adds observations to the turn's citable reads, one per id. */
  const mergeReadObservations = (
    observations: readonly TrustedReadObservation[],
  ): void => {
    if (!observations.length) return;
    const merged = new Map(
      (deps.request.documentReadObservations || []).map((entry) => [
        entry.observationId,
        entry,
      ]),
    );
    for (const observation of observations) {
      merged.set(observation.observationId, observation);
    }
    deps.request.documentReadObservations = [...merged.values()];
  };

  /**
   * Stores records a tool made itself (a host digest per paper) under trh_
   * handles that context_read pages, kept for the turn's own recovery like
   * the handles this collaborator stores.
   */
  const storeToolHandles = async (
    records: AgentToolResultHandleRecord[],
  ): Promise<void> => {
    if (!records.length) return;
    await deps.persistToolResultHandles(records);
    deps.preservedTurnHandleRecords.push(...records);
    deps.setToolResultReadAvailable(true);
    setToolResultReadAvailability(deps.request, true);
  };

  /**
   * The handle holding a result too big for the run's trace, so the trace
   * can persist a marker naming it (`compactRunEventForPersistence`). A call
   * whose result was already stored for the model (its sized view, or a
   * paper read's original) names that handle; otherwise the result is stored
   * here. Unlike `persistResultHandle` this does not offer the handle to the
   * model: the model's view of the result is unchanged. The handle is a
   * digest of the call and the content, so storing it again is an upsert.
   * Results carrying receipts are persisted whole and need no handle. A
   * handle is returned only once its write is confirmed: a marker naming a
   * handle the database never held would point at nothing after a restart,
   * so without one the trace stores the result whole.
   */
  const storeOversizedResultForTrace = async (params: {
    call: AgentToolCall;
    input: unknown;
    toolResult: AgentToolResult;
  }): Promise<string | undefined> => {
    const { toolResult } = params;
    if (!toolResult.ok || toolResult.actionReceipts?.length) return undefined;
    let bytes: number;
    try {
      bytes = JSON.stringify(toolResult.content ?? null).length;
    } catch {
      return undefined;
    }
    if (bytes <= PERSISTED_TOOL_RESULT_MAX_BYTES) return undefined;
    const stored = handleByCallId.get(params.call.id);
    if (stored) return stored;
    try {
      const inputDigest = `sha256:${await sha256Text(
        canonicalJson(params.input),
      )}`;
      const record = createAgentToolResultHandleRecord({
        conversationKey: deps.request.conversationKey,
        toolName: params.call.name,
        toolCallId: params.call.id,
        inputDigest,
        resourceSignature: deps.resourceContextPlan.resourceSignature,
        content: toolResult.content,
        createdAt: deps.now(),
      });
      if (!record) return undefined;
      const written = await deps.persistToolResultHandles([record]);
      return written === false ? undefined : record.handle;
    } catch {
      // Without a handle the trace stores the result whole, as before.
      return undefined;
    }
  };

  /**
   * The model's view of a result whose tool sizes it: the view, the evidence
   * refs of the rows it keeps, and the handle holding everything else.
   */
  const buildModelViewContent = async (params: {
    call: AgentToolCall;
    toolDefinition: AgentToolDefinition<any, any>;
    input: unknown;
    toolResult: AgentToolResult;
    documentEvidenceRefs?: unknown[];
  }): Promise<Record<string, unknown> | undefined> => {
    const view = params.toolDefinition.buildModelView?.(
      params.input as never,
      params.toolResult.content as never,
      deps.context,
    );
    if (!view) return undefined;
    const refs = (params.documentEvidenceRefs || []) as Array<
      Record<string, unknown>
    >;
    const shown = refs.length
      ? readObservationSourceKeys({
          toolName: params.toolResult.name,
          input: params.input,
          result: view.content,
        })
      : new Set<string>();
    const keptRefs = refs.filter((ref) =>
      shown.has(readObservationSourceKey(ref)),
    );
    const omittedRefs = refs.filter(
      (ref) => !shown.has(readObservationSourceKey(ref)),
    );
    const stored = view.stored ?? params.toolResult.content;
    const handle = await persistResultHandle({
      call: params.call,
      input: params.input,
      content:
        refs.length && stored && typeof stored === "object"
          ? { ...stored, documentEvidenceRefs: [...keptRefs, ...omittedRefs] }
          : stored,
    });
    if (!handle) return undefined;
    const omitted = {
      ...((view.content.omitted as Record<string, number> | undefined) || {}),
      ...(omittedRefs.length
        ? { documentEvidenceRefs: omittedRefs.length }
        : {}),
    };
    return {
      ...view.content,
      ...(keptRefs.length ? { documentEvidenceRefs: keptRefs } : {}),
      ...(Object.keys(omitted).length ? { omitted } : {}),
      toolResultHandle: handle,
      toolResultHandleNotice: MODEL_VIEW_HANDLE_NOTICE,
    };
  };

  /**
   * A note the turn's job has already written on its paper is not written
   * again: the host answers the call itself and runs nothing, so no paper
   * gets a second note, and the model reads why. A call that mixes such
   * papers with papers still owed a note is refused, to be sent again
   * without them. The receipts that ticked the papers stay the proof
   * (`papersAlreadyWritten`). A part counts one note a paper, so the answer
   * also says how a request for a second, different note on a paper is
   * asked: by a part of its own, which then owes that note. Null for every
   * other call, which runs as ever.
   */
  const answerNoteWrittenInJob = async (
    call: AgentToolCall,
    toolDefinition: AgentToolDefinition<any, any> | undefined,
  ): Promise<AgentToolResult | null> => {
    const checkpoint = deps.request.executionCheckpoint;
    if (
      !deps.recordOutcomeEvidence ||
      !checkpoint?.tasks.length ||
      toolDefinition?.spec.executionClass !== "external_effect" ||
      !toolDefinition.describeAction
    )
      return null;
    const args =
      call.arguments &&
      typeof call.arguments === "object" &&
      !Array.isArray(call.arguments)
        ? Object.fromEntries(
            Object.entries(call.arguments as Record<string, unknown>).filter(
              ([key]) => key !== "review",
            ),
          )
        : call.arguments;
    const validation = toolDefinition.validate(args);
    if (!validation.ok) return null;
    let proposals: AgentActionProposal[] = [];
    try {
      proposals =
        (await toolDefinition.describeAction(
          validation.value as never,
          deps.context,
        )) || [];
    } catch {
      return null;
    }
    const found = papersAlreadyWritten(checkpoint, proposals);
    if (!found) return null;
    const ids = (targets: readonly string[]) =>
      targets.map((target) => target.replace(/^item:/, "")).join(", ");
    const one = found.written.length === 1;
    const which = `item${one ? "" : "s"} ${ids(found.written)} already ${
      one ? "has" : "have"
    } the note this job writes (${found.parts
      .map((part) => `“${part}”`)
      .join(", ")})`;
    const another =
      "If the request asks for another, different note on a paper, declare it as a part of its own with task_update, then send it again.";
    if (!found.left.length)
      return {
        callId: call.id,
        name: call.name,
        ok: true,
        effect: "none",
        actionReceipts: [],
        content: {
          skipped: true,
          note: `Skipped by the host: ${which}, so nothing was written. Go on with the papers left. ${another}`,
        },
      };
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      inputRejected: true,
      actionReceipts: [],
      content: {
        error: `Not run: ${which}, and a second would write ${
          one ? "it" : "them"
        } twice. Send the call again with only the papers left: ${ids(found.left)}. ${another}`,
      },
    };
  };

  const executePreparedToolCall = async (
    call: AgentToolCall,
    round: number,
    options: {
      inheritedApproval?: AgentInheritedApproval;
    } = {},
  ): Promise<ExecutedToolCall> => {
    const toolDefinition = deps.registry.getTool(call.name);
    const workCategory = toolDefinition
      ? resolveAgentToolCallWorkCategory(toolDefinition, call.arguments)
      : undefined;
    const toolLabel = resolveAgentToolPresentationLabel(toolDefinition);
    /**
     * Open and close this call's stage.
     *
     * A call the registry cannot resolve has no declared category, and
     * guessing one from its name is the thing the stage model exists to
     * remove -- so it reports no stage at all. The registry answers such
     * a call with a synthetic error and no effect, so there is no work
     * for a stage to describe.
     */
    const emitCallStage = async (
      status: "started" | "completed" | "failed",
      details: {
        receiptIds?: string[];
        materialRef?: MaterialRef;
      } = {},
    ) => {
      if (!workCategory) return;
      await deps.emit(
        buildAgentStageEvent({
          stage: workCategory,
          status,
          callId: call.id,
          toolName: call.name,
          toolLabel,
          ...details,
        }),
      );
    };
    const lifecycleError = (): ExecutedToolCall => ({
      toolResult: {
        callId: call.id,
        name: call.name,
        ok: false,
        actionReceipts: [
          createUnverifiedReceipt({
            reason: "Conversation lifecycle changed before execution.",
          }),
        ],
        content: {
          error:
            "Conversation lifecycle changed before this tool could execute.",
        },
      },
    });
    const executionAllowed = () => !deps.signal?.aborted && deps.writeAllowed();
    /**
     * Whether a call that came back must still be dropped. A conversation
     * changed under it (Clear, deletion) keeps nothing of it. Stop does not
     * undo a call that ran to its result: that result and its receipts are
     * the only record of what it wrote, so they are kept. A call that did not
     * (Stop kept it from starting, or it failed) is dropped as before; a
     * write it made before failing is still in the change journal, which a
     * resumed ledger reads (`journalReceipts.ts`).
     */
    const droppedAfterReturn = (result: AgentToolResult) =>
      !deps.writeAllowed() || (Boolean(deps.signal?.aborted) && !result.ok);
    if (!executionAllowed()) return lifecycleError();
    await emitCallStage("started");
    await deps.emit({
      type: "tool_call",
      callId: call.id,
      name: call.name,
      args: call.arguments,
      toolLabel,
      workCategory,
    });
    deps.toolsUsedThisTurn.push(call.name);
    const cachedPaperEvidence =
      call.name === "paper_read"
        ? await deps.paperEvidenceFrontier.readCached({
            input: call.arguments,
            toolCallId: call.id,
            resourceSignature: deps.resourceContextPlan.resourceSignature,
          })
        : null;
    let executedCall: ExecutedToolCall;
    /** The arguments a review card showed the user before the call ran. */
    let reviewedArguments: unknown;
    const writtenInJob = cachedPaperEvidence
      ? null
      : await answerNoteWrittenInJob(call, toolDefinition);
    if (cachedPaperEvidence) {
      executedCall = {
        toolResult: {
          callId: call.id,
          name: call.name,
          ok: true,
          actionReceipts: [],
          content: cachedPaperEvidence.content,
        },
        toolDefinition: deps.registry.getTool(call.name),
        input: call.arguments,
      };
    } else if (writtenInJob) {
      executedCall = {
        toolResult: writtenInJob,
        toolDefinition,
        input: call.arguments,
      };
    } else {
      const execution = await deps.registry.prepareExecution(
        call,
        {
          ...deps.context,
          currentAnswerText: deps.getCurrentAnswerText(),
          toolCallId: call.id,
          publishPaperLedgerDelta: (delta) =>
            deps.emit(buildPaperLedgerUpdateEvent(delta)),
          persistToolResultHandles: storeToolHandles,
          recordReadObservations: mergeReadObservations,
          requestActionReview: async (action) =>
            (await deps.requestActionResolution(action)).resolution,
          resolvePreparedAction: (prepared) =>
            resolvePreparedActionReview(
              prepared,
              async (action) =>
                (await deps.requestActionResolution(action)).resolution,
              executionAllowed,
            ),
        },
        {
          callerKind: options.inheritedApproval ? "action" : "model",
          inheritedApproval: options.inheritedApproval,
          // The conversation's lifecycle only: the controller reads Stop
          // from the context's signal itself, before the tool runs.
          isExecutionAllowed: deps.writeAllowed,
          executeWithLock: (task) =>
            withConversationWriteLock(deps.request.conversationKey, task),
        },
      );
      if (execution.kind === "confirmation") {
        const { resolution } = await deps.requestActionResolution(
          execution.action,
        );
        if (!executionAllowed()) return lifecycleError();
        // Resolution semantics belong to the rendered action schema. Some
        // review-card controls deliberately carry approved:false while
        // continuing the workflow without applying a mutation.
        let confirmedExecution = await execution.execute(resolution);
        while (confirmedExecution.kind === "confirmation") {
          const next = await deps.requestActionResolution(
            confirmedExecution.action,
          );
          if (!executionAllowed()) return lifecycleError();
          confirmedExecution = await confirmedExecution.execute(
            next.resolution,
          );
        }
        if (droppedAfterReturn(confirmedExecution.execution.result))
          return lifecycleError();
        executedCall = {
          toolResult: confirmedExecution.execution.result,
          toolDefinition: confirmedExecution.execution.tool,
          input: confirmedExecution.execution.input,
        };
        reviewedArguments = call.arguments;
      } else {
        if (droppedAfterReturn(execution.execution.result))
          return lifecycleError();
        executedCall = {
          toolResult: execution.execution.result,
          toolDefinition: execution.execution.tool,
          input: execution.execution.input,
        };
      }
    }
    const { toolResult } = executedCall;
    let readActivityContent = toolResult.content;
    // A submitted document may include only assets a successful call of this
    // turn emitted, such as a figure crop paper_read returned.
    if (toolResult.ok && toolResult.artifacts?.length) {
      const artifactsByPath = new Map(
        (deps.request.documentArtifactObservations || []).map((artifact) => [
          artifact.storedPath,
          artifact,
        ]),
      );
      for (const artifact of toolResult.artifacts) {
        artifactsByPath.set(artifact.storedPath, artifact);
      }
      deps.request.documentArtifactObservations = [...artifactsByPath.values()];
    }
    // Recorded at attestation, from the original content (the paper
    // frontier may replace it with a handle below), and emitted right after
    // this call's tool_result.
    let paperLedgerDelta: TaskPaperLedgerDelta | null = null;
    let attestedObservationIds: string[] = [];
    if (
      !cachedPaperEvidence &&
      toolResult.ok &&
      executedCall.toolDefinition?.spec.executionClass === "read"
    ) {
      const attested = await attestAndRecordRead({
        toolName: toolResult.name,
        callId: toolResult.callId,
        input: executedCall.input,
        result: toolResult.content,
        conversationKey: deps.request.conversationKey,
        libraryID: deps.request.libraryID,
        runId: deps.runId,
      });
      const observations = attested.observations;
      paperLedgerDelta = attested.paperLedgerDelta;
      attestedObservationIds = observations.map(
        (observation) => observation.observationId,
      );
      if (observations.length) {
        mergeReadObservations(observations);
        // The model cites the short ref; the document finalizer expands it.
        executedCall.documentEvidenceRefs = observations.map((observation) => ({
          evidenceRef: shortEvidenceRef(observation.observationId),
          libraryID: observation.libraryID,
          itemKey: observation.itemKey,
          capabilities: observation.capabilities,
          attachmentItemKey: observation.attachmentItemKey,
          pageIndex: observation.pageIndex,
          sourceFingerprint: observation.sourceFingerprint,
        }));
      }
    } else if (toolResult.ok && toolResult.paperDecisions?.length) {
      // A call that states paper decisions (record_paper_decisions, or the
      // papers a document or a part leaves out): the same recorder makes its
      // delta, emitted at the same place as a read's.
      paperLedgerDelta = recordTaskPaperDecisions({
        toolName: toolResult.name,
        callId: toolResult.callId,
        decisions: toolResult.paperDecisions,
        conversationKey: deps.request.conversationKey,
        runId: deps.runId,
      });
    }
    // The outside papers a document of this run may cite: what
    // literature_search and literature_read returned. The DOIs of papers
    // read past their metadata are looked up in the background, for the
    // citations of a document that cites them.
    if (toolResult.ok) {
      const outsidePapers = outsidePaperRecordsFromToolResult(
        toolResult.name,
        toolResult.content,
      );
      rememberOutsidePapers(deps.request, outsidePapers);
      prefetchOutsidePaperLookups(deps.request, outsidePapers);
    }
    let paperEvidenceFrontierState:
      | "advanced"
      | "unchanged"
      | "unavailable"
      | undefined = cachedPaperEvidence?.frontier;
    if (!cachedPaperEvidence && toolResult.ok && call.name === "paper_read") {
      const originalContent = toolResult.content;
      const processed = await deps.paperEvidenceFrontier.processResult({
        input: executedCall.input,
        content: originalContent,
        toolCallId: call.id,
        resourceSignature: deps.resourceContextPlan.resourceSignature,
        persistOriginal: (content) =>
          persistResultHandle({ call, input: executedCall.input, content }),
      });
      toolResult.content = processed.content;
      readActivityContent = processed.originalContent ?? originalContent;
      paperEvidenceFrontierState = processed.frontier;
    }
    deps.toolExecutionRecords.push({
      name: toolResult.name,
      ok: toolResult.ok,
      mutability:
        executedCall.toolDefinition?.spec.executionClass === "external_effect"
          ? "write"
          : "read",
      effect: toolResult.effect,
      input: executedCall.input,
      content: toolResult.content,
      actionReceipts: toolResult.actionReceipts,
      ...(paperEvidenceFrontierState
        ? { frontier: paperEvidenceFrontierState }
        : {}),
    });
    if (toolResult.ok) {
      if (paperEvidenceFrontierState !== "unchanged") {
        deps.pendingReadActivities.push({
          toolName: toolResult.name,
          toolLabel:
            typeof executedCall.toolDefinition?.presentation?.label === "string"
              ? executedCall.toolDefinition.presentation.label
              : undefined,
          input: executedCall.input,
          content: readActivityContent,
          artifacts: toolResult.artifacts,
          request: deps.request,
          timestamp: deps.now(),
        });
      }
    } else {
      const rawError = readToolError(toolResult);
      const userDenied = isUserDeniedToolResult(toolResult);
      // A denial is the user steering, not the tool failing. Counting it
      // meant three careful "Cancel" clicks failed the run outright and
      // -- because persistence is gated on completion -- discarded its
      // memory along with it.
      if (rawError && !userDenied) {
        await deps.emit({
          type: "tool_error",
          callId: toolResult.callId,
          name: toolResult.name,
          error: rawError,
          round,
          toolLabel,
          workCategory,
        });
      }
    }
    await emitCallStage(toolResult.ok ? "completed" : "failed", {
      receiptIds: toolResult.actionReceipts?.length
        ? toolResult.actionReceipts.map((receipt) => receipt.id)
        : undefined,
      materialRef: toolResult.materialRef,
    });
    // The model's view is stored before the result is announced, so a big
    // result's trace row can name the handle the view already stored.
    if (toolResult.ok && executedCall.toolDefinition?.buildModelView) {
      executedCall.modelView = await buildModelViewContent({
        call,
        toolDefinition: executedCall.toolDefinition,
        input: executedCall.input,
        toolResult,
        documentEvidenceRefs: executedCall.documentEvidenceRefs,
      });
    }
    const toolResultHandle = await storeOversizedResultForTrace({
      call,
      input: executedCall.input,
      toolResult,
    });
    await deps.emit({
      type: "tool_result",
      callId: toolResult.callId,
      name: toolResult.name,
      ok: toolResult.ok,
      toolLabel,
      workCategory,
      effect: toolResult.effect,
      authority: toolResult.authority,
      actionReceipts: toolResult.actionReceipts,
      content: toolResult.content,
      artifacts: toolResult.artifacts,
      ...(toolResultHandle ? { toolResultHandle } : {}),
    });
    if (paperLedgerDelta) {
      await deps.emit(buildPaperLedgerUpdateEvent(paperLedgerDelta));
    }
    if (toolResult.materialRef) {
      deps.finalizedMaterialRefs.set(
        toolResult.materialRef.documentId,
        toolResult.materialRef,
      );
      await deps.emit(
        buildAgentStageEvent({
          stage: "generation",
          status: "completed",
          callId: toolResult.callId,
          toolName: toolResult.name,
          toolLabel,
          materialRef: toolResult.materialRef,
        }),
      );
      await deps.emit({
        type: "material_finalized",
        materialRef: toolResult.materialRef,
        materialKind: toolResult.materialKind,
        materialTitle: toolResult.materialTitle,
        callId: toolResult.callId,
        ...(toolResult.materialCitedSources?.length
          ? { citedSources: toolResult.materialCitedSources }
          : {}),
      });
    }
    // A batch announces its items one by one. They are deliberately not
    // `material_finalized`: fifty note bodies are recovered from the
    // batch's own durable rows, not from the turn's material ledger.
    for (const item of toolResult.batchItems || []) {
      // A pending row is one this run has not written yet: not a
      // completion and not a failure, and the stage vocabulary has no
      // third outcome. It reports no stage rather than a wrong one; the
      // row itself still says the note is not written.
      if (item.status !== "pending")
        await deps.emit(
          buildAgentStageEvent({
            stage: "zotero_action",
            status: item.status === "saved" ? "completed" : "failed",
            callId: toolResult.callId,
            toolName: toolResult.name,
            toolLabel,
            batchId: item.batchId,
            itemKey: item.itemKey,
            materialRef: item.materialRef,
          }),
        );
      await deps.emit({
        type: "batch_item_outcome",
        batchId: item.batchId,
        itemKey: item.itemKey,
        materialRef: item.materialRef,
        status: item.status,
        written: item.written,
        noteId: item.noteId,
        error: item.error,
        callId: toolResult.callId,
      });
    }
    if (deps.recordOutcomeEvidence) {
      const evidence = await outcomeEvidenceOf({
        toolResult,
        toolDefinition: executedCall.toolDefinition,
        input: executedCall.input,
        context: deps.context,
        paperLedgerDelta,
        observationIds: attestedObservationIds,
        reviewedArguments,
      });
      const source = cachedPaperEvidence?.sourceToolCallId
        ? readEvidenceByCall.get(cachedPaperEvidence.sourceToolCallId)
        : undefined;
      if (source) evidence.push(source);
      for (const entry of evidence) {
        if (entry.kind === "read" && !cachedPaperEvidence) {
          readEvidenceByCall.set(toolResult.callId, entry);
        }
        await deps.recordOutcomeEvidence(entry);
      }
    }
    deps.actionContractSession.recordToolReceipts(toolResult.actionReceipts);
    return executedCall;
  };
  const buildToolDelivery = async (
    toolResult: AgentToolResult,
    callId: string,
    toolDefinition?: import("../types").AgentToolDefinition<any, any>,
    contentOverride?: unknown,
    extraFollowupMessages: AgentModelMessage[] = [],
  ): Promise<ToolWorkflowDelivery> => {
    const followupMessage = toolDefinition?.buildFollowupMessage
      ? await toolDefinition.buildFollowupMessage(toolResult, {
          ...deps.context,
          currentAnswerText: deps.getCurrentAnswerText(),
        })
      : await buildArtifactFollowupMessage(toolResult, {
          contentInputs: resolveCapabilitiesContentInputs(
            deps.adapterCapabilities,
          ),
          modelName: deps.request.model,
        });
    const filteredFollowupMessage = filterFollowupMessageForCapabilities(
      followupMessage,
      deps.adapterCapabilities,
      deps.request.model,
    );
    const followupMessages = extraFollowupMessages
      .map((message) =>
        filterFollowupMessageForCapabilities(
          message,
          deps.adapterCapabilities,
          deps.request.model,
        ),
      )
      .filter((message): message is AgentModelMessage => Boolean(message));
    if (filteredFollowupMessage) {
      followupMessages.push(filteredFollowupMessage);
    }
    const rawContent = contentOverride ?? toolResult.content;
    const contentWithReceipt =
      rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)
        ? {
            ...(rawContent as Record<string, unknown>),
            actionReceipts: toolResult.actionReceipts,
          }
        : {
            content: rawContent,
            actionReceipts: toolResult.actionReceipts,
          };
    return {
      callId,
      name: toolResult.name,
      content: contentWithReceipt,
      followupMessages,
    };
  };
  const executeToolWorkflow = async (
    call: AgentToolCall,
    round: number,
    options: {
      modelCallId?: string;
      suppressModelDelivery?: boolean;
      inheritedApproval?: AgentInheritedApproval;
      followingCallCount?: number;
    } = {},
  ): Promise<ToolWorkflowOutcome> => {
    // Stop kept this call from starting. It is answered, not thrown: the
    // round completes, so the results of the calls that ran before it (the
    // only record of what they did) reach the transcript with it, and the
    // next model step ends the run as cancelled. Nothing ran, so nothing is
    // published, recorded or proved.
    if (deps.signal?.aborted) {
      const toolResult: AgentToolResult = {
        callId: call.id,
        name: call.name,
        ok: false,
        effect: "none",
        actionReceipts: [],
        content: {
          status: "not_started",
          error:
            "Stopped before it started: the user pressed Stop, so this call did not run and changed nothing.",
        },
      };
      return {
        notStarted: true,
        toolResult,
        delivery: options.suppressModelDelivery
          ? undefined
          : await buildToolDelivery(toolResult, options.modelCallId || call.id),
      };
    }
    if (!deps.writeAllowed()) {
      return {
        failed: true,
        stopRun: true,
        finalText: "Conversation lifecycle changed before execution.",
        toolResult: {
          callId: call.id,
          name: call.name,
          ok: false,
          actionReceipts: [
            createUnverifiedReceipt({
              reason: "Conversation lifecycle changed before execution.",
            }),
          ],
          content: {
            error:
              "Conversation lifecycle changed before this tool could execute.",
          },
        },
      };
    }
    const executedCall = await executePreparedToolCall(call, round, {
      inheritedApproval: options.inheritedApproval,
    });
    const {
      toolResult,
      toolDefinition,
      input,
      documentEvidenceRefs,
      modelView,
    } = executedCall;
    const deliveryCallId = options.modelCallId || call.id;
    // The fields the tool keeps from the model leave only its delivery; the
    // event emitted above carried the whole result.
    const modelContent =
      !modelView && toolResult.ok && toolDefinition?.modelContent
        ? toolDefinition.modelContent(toolResult.content, input as never)
        : toolResult.content;
    const contentForModel =
      modelView ||
      (documentEvidenceRefs?.length
        ? modelContent &&
          typeof modelContent === "object" &&
          !Array.isArray(modelContent)
          ? {
              ...(modelContent as Record<string, unknown>),
              documentEvidenceRefs,
            }
          : { content: modelContent, documentEvidenceRefs }
        : modelContent !== toolResult.content
          ? modelContent
          : undefined);
    // A call that ran while the user pressed Stop is recorded and delivered,
    // and nothing more: no terminal answer and no review card, so the run
    // ends as the user stopped it.
    const stopped = Boolean(deps.signal?.aborted);

    if (!stopped && toolResult.ok && toolDefinition?.resolveTerminalResult) {
      const terminal = await toolDefinition.resolveTerminalResult(
        input as never,
        toolResult,
        { ...deps.context, currentAnswerText: deps.getCurrentAnswerText() },
      );
      if (terminal) {
        if (terminal.documentId) {
          deps.setFinalizedMaterial({
            documentId: terminal.documentId,
            finalText: terminal.finalText,
          });
          const actionDecision = deps.actionContractSession.evaluateFinal();
          const accepted = actionDecision.kind === "accept";
          // An accepted document ends the turn only when nothing else was
          // requested: a later call of this step, or a part the model
          // declared that still needs more than the answer, has to run with
          // it. A declared reasoning part is answered by the document itself.
          const openTasks = openDeclaredOutcomes(
            deps.request.executionCheckpoint,
          );
          if (!accepted || options.followingCallCount || openTasks.length) {
            const remainingWork =
              actionDecision.kind === "fail"
                ? actionDecision.failure
                : openTasks.map((task) => task.description).join("; ");
            return {
              toolResult,
              delivery: options.suppressModelDelivery
                ? undefined
                : await buildToolDelivery(
                    toolResult,
                    deliveryCallId,
                    toolDefinition,
                    {
                      content: contentForModel || toolResult.content,
                      ...(remainingWork ? { remainingWork } : {}),
                      finalizedDocumentId: terminal.documentId,
                      instruction: accepted
                        ? "The document is finalized and preserved. Complete any remaining requested work with this finalized document, passing its documentId where a tool accepts one; do not regenerate it."
                        : "The material is finalized and preserved. Complete the remaining authorized actions using this finalized payload; do not regenerate the document.",
                    },
                  ),
            };
          }
        }
        return {
          toolResult,
          delivery: options.suppressModelDelivery
            ? undefined
            : await buildToolDelivery(
                toolResult,
                deliveryCallId,
                toolDefinition,
                contentForModel,
              ),
          stopRun: true,
          finalText: terminal.finalText,
          documentId: terminal.documentId || terminal.planDocumentId,
          preserveToolOnlyTranscript:
            terminal.providerTranscript === "tool_only",
        };
      }
    }

    if (
      !stopped &&
      toolResult.ok &&
      toolDefinition?.createResultReviewAction &&
      toolDefinition.resolveResultReview
    ) {
      const currentResult = toolResult;
      const currentInput = input;
      while (true) {
        const reviewAction = await toolDefinition.createResultReviewAction(
          currentInput as never,
          currentResult,
          {
            ...deps.context,
            currentAnswerText: deps.getCurrentAnswerText(),
          },
        );
        if (!reviewAction) {
          if (options.suppressModelDelivery) {
            return { toolResult: currentResult };
          }
          return {
            toolResult: currentResult,
            delivery: await buildToolDelivery(
              currentResult,
              deliveryCallId,
              toolDefinition,
              contentForModel,
            ),
          };
        }

        const { resolution } = await deps.requestActionResolution(reviewAction);
        if (deps.signal?.aborted || !deps.writeAllowed()) {
          return { toolResult: currentResult };
        }
        const reviewOutcome = await toolDefinition.resolveResultReview(
          currentInput as never,
          currentResult,
          resolution,
          {
            ...deps.context,
            currentAnswerText: deps.getCurrentAnswerText(),
          },
        );

        if (reviewOutcome.kind === "deliver") {
          // Completion follows the latest review continuation, including a
          // request for more papers that has not triggered another search.
          const reviewRecord = deps.toolExecutionRecords.findLast(
            (record) => record.name === currentResult.name,
          );
          if (reviewRecord && reviewOutcome.toolMessageContent !== undefined) {
            reviewRecord.content = reviewOutcome.toolMessageContent;
          }
          return options.suppressModelDelivery
            ? { toolResult: currentResult }
            : {
                toolResult: currentResult,
                delivery: await buildToolDelivery(
                  currentResult,
                  deliveryCallId,
                  toolDefinition,
                  reviewOutcome.toolMessageContent,
                  reviewOutcome.followupMessages || [],
                ),
              };
        }

        if (reviewOutcome.kind === "stop") {
          return {
            toolResult: currentResult,
            stopRun: true,
            finalText: reviewOutcome.finalText,
          };
        }

        const chainedCall = buildSyntheticToolCall(
          reviewOutcome.call.name,
          reviewOutcome.call.arguments,
        );
        const inheritedApproval = reviewOutcome.call.inheritedApproval
          ? {
              ...reviewOutcome.call.inheritedApproval,
              approvedCallDigest: buildActionCallDigest(
                chainedCall.name,
                chainedCall.arguments,
              ),
            }
          : undefined;
        const chainedOutcome = await executeToolWorkflow(chainedCall, round, {
          modelCallId: deliveryCallId,
          suppressModelDelivery: Boolean(reviewOutcome.terminalText),
          inheritedApproval,
        });
        if (reviewOutcome.terminalText) {
          const finalText = chainedOutcome.toolResult.ok
            ? reviewOutcome.terminalText.onSuccess
            : isUserDeniedToolResult(chainedOutcome.toolResult)
              ? reviewOutcome.terminalText.onDenied
              : reviewOutcome.terminalText.onError;
          return {
            toolResult: chainedOutcome.toolResult,
            stopRun: true,
            finalText,
          };
        }
        // The run continues: the model reads the call's result with the
        // review's next step.
        const delivery = chainedOutcome.delivery;
        const delivered = delivery?.content;
        if (
          reviewOutcome.nextStep &&
          chainedOutcome.toolResult.ok &&
          delivery &&
          delivered &&
          typeof delivered === "object" &&
          !Array.isArray(delivered) &&
          !("nextStep" in delivered)
        ) {
          return {
            ...chainedOutcome,
            delivery: {
              ...delivery,
              content: { ...delivered, nextStep: reviewOutcome.nextStep },
            },
          };
        }
        return chainedOutcome;
      }
    }

    if (options.suppressModelDelivery) {
      return { toolResult };
    }
    return {
      toolResult,
      delivery: await buildToolDelivery(
        toolResult,
        deliveryCallId,
        toolDefinition,
        contentForModel,
      ),
    };
  };

  return { executePreparedToolCall, buildToolDelivery, executeToolWorkflow };
}
