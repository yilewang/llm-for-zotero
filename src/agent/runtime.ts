import { ensureModelCapabilities } from "../modelCapabilities";
import { reanchorQuoteCitationsToClaims } from "../services/quotes/claimAnchoring";
import {
  QUOTE_CITATION_PATTERN,
  selectUsedQuoteCitations,
} from "../services/quotes/quoteCitations";
import { paragraphCitationIds } from "../services/quotes/paragraphCitations";
import type { QuoteCitation } from "../shared/types";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import { createTurnUsageRecorder } from "../utils/usageTurnRecorder";
import type { UsageEventRuntime } from "../utils/usageStore";
import {
  classifyConversationKey,
  isEphemeralConversationKey,
} from "../shared/conversationKeySpace";
import type {
  SourceCatalog,
  WebAttributionAssessment,
} from "../webAccess/attribution";
import {
  EARLIER_SOURCE_TOOL_NAMES,
  buildEarlierSourcesBlock,
  earlierSourceCatalog,
} from "../webAccess/earlierSources";
import {
  clearWebSourcesForRun,
  highestWebSourceNumber,
  seedWebSourceNumbering,
} from "../webAccess/runSources";
import {
  clearOutsideSearchTurn,
  resetOutsideSearchLedger,
} from "./tools/read/outsideSearchLedger";
import {
  buildAgentContextBudgetState,
  resolveAgentContextBudgetPolicy,
} from "./context/budgetPolicy";
import {
  commitAgentCoverageActivities,
  hydrateAgentCoverageLedger,
} from "./context/coverageLedger";
import { validateLocalPdfDocumentBatch } from "./context/localDocumentBatch";
import { PaperEvidenceFrontier } from "./context/paperEvidenceFrontier";
import { preparePaperPromptContext } from "./context/paperPromptContext";
import { PassageCitationCollector } from "./context/passageCitationCollector";
import {
  buildPaperDigest,
  collectPaperEvidence,
  readStoredPaperDigests,
  renderPaperDigests,
  type PaperDigest,
} from "./context/paperDigests";
import {
  AgentPromptBudgetError,
  enforceAgentPromptBudget,
  resolveAgentPromptBudgetLimits,
} from "./context/promptBudget";
import { getTurnPapersWithRoles } from "./context/requestTurnPaperScope";
import {
  resolveAgentRuntimeRequest,
  type AgentRequestPaperContextResolver,
} from "./context/resolvedAgentRequest";
import {
  buildAgentResourceContextPlan,
  commitAgentReadActivities,
  hydrateAgentEvidenceCache,
  type AgentPendingReadActivity,
} from "./context/resourceContextPlan";
import {
  statesTurnPaperScope,
  type TaskPaperScopeSet,
} from "./context/taskPaperScopeListing";
import {
  buildAgentSemanticCheckpoint,
  buildPortableAgentTranscript,
  buildConversationReferenceMessage,
  buildRetainedActionMessage,
  readRetainedWorkingDirectory,
  compactAgentTranscript,
} from "./context/transcriptCompactor";
import { AgentRunContinuationSession } from "./continuation/runContinuationSession";
import { ActionContractRunSession } from "./contracts/actionContractRunSession";
import type { MaterialRef } from "./documents/materialRef";
import { AgentFinalAnswerController } from "./finalization/finalAnswerController";
import {
  isSubstantiveAnswerText,
  withoutLeadingRepeat,
} from "./finalization/answerSegments";
import type { RunStopRule } from "./loop/stopRules";
import { namedItemTargets, toolFailureReason } from "./loop/paperFailures";
import {
  buildResumeNote,
  buildSearchRecord,
  classifyModelFailure,
  MODEL_STEP_RETRIES,
  rejectsToolChoiceNone,
  recordedStopRule,
  renderFinalOnlyInstruction,
  renderSearchCheckpoint,
  renderSearchExhaustedFallback,
  renderStoppedTurnText,
  SEARCH_EXHAUSTED_REASON,
  searchScopeLabel,
  TurnBoundary,
  type RoundProgressReport,
  type TurnSafetyLimits,
} from "./loop/turnBoundary";
import {
  LongJobPager,
  priorPaperTokens,
  readLongJob,
  renderLongJobMessage,
  renderLongJobRecord,
  renderUnfinishedParts,
  settledTargetCount,
} from "./loop/longJob";
import {
  applyOutcomeEvidence,
  closeOpenOutcomes,
  declaresReadPart,
  decideRunEnd,
  OUTCOME_REASONS,
  openDeclaredOutcomes,
  reconcileJournaledReceipts,
  resumesOnContinue,
  settleOutcomes,
  type OutcomeEvidence,
} from "./loop/outcomes";
import { estimateContextMessagesTokens } from "../utils/modelInputCap";
import { isExplicitContinueCommand } from "./continuation/continueCommand";
import type { AgentModelAdapter } from "./model/adapter";
import { resolveCapabilitiesContentInputs } from "./model/contentCapabilities";
import { buildAnswerContinuationInstruction } from "./model/completion";
import {
  addsNewAnswerText,
  answerContinuationCeiling,
  resolveAgentLimits,
} from "./model/limits";
import { resolveOutputReserve } from "../utils/outputTokenPolicy";
import {
  buildAgentPromptInstructionInventory,
  composeAgentModelInput,
  normalizeHistoryMessages,
  renderAgentPromptEnvelope,
} from "./model/messageBuilder";
import {
  buildAdapterToolCallResult,
  type ToolWorkflowOutcome,
} from "./model/toolArtifactDelivery";
import {
  acquireLocalDocumentPathLease,
  AgentEventLocalDocumentStreamRedactor,
  LocalDocumentPathStreamRedactor,
} from "./privacy/localDocumentPathRedaction";
import {
  getAllSkills,
  getBuiltinSkillInstructionById,
  getMatchedSkillIds,
  loadSkill,
} from "./skills";
import { listJournalActions } from "./store/changeJournal";
import { recordAgentTurn } from "./store/conversationMemory";
import {
  createAgentToolResultHandleRecord,
  hasAgentToolResultHandles,
  hydrateAgentToolResultHandles,
  listAgentToolResultHandles,
  upsertAgentToolResultHandles,
  type AgentToolResultHandleRecord,
} from "./store/toolResultHandles";
import { listResumableBatches } from "./store/batchItemStore";
import {
  appendAgentRunEvents,
  createAgentRun,
  finishAgentRun,
  getAgentRunTrace,
  getLatestAgentRunForConversation,
  INTERRUPTED_AGENT_RUN_MARKER,
} from "./store/traceStore";
import {
  createRunEventWriter,
  type RunEventRow,
  type RunEventWriter,
} from "./store/runEventWriter";
import {
  appendAgentTranscriptMessages,
  PORTABLE_TRANSCRIPT_KEY,
  loadAgentTranscriptSegment,
  loadLatestAgentTranscriptSegment,
  replaceAgentTranscriptSegment,
  replaceAgentTranscriptSegmentIfUnchanged,
  type AgentTranscriptSegment,
  type AgentTranscriptWriteResult,
} from "./store/transcriptStore";
import { resolveAgentToolCallWorkCategory } from "./workCategory";
import {
  AgentToolRegistry,
  isToolWithheldForEphemeralRequest,
} from "./tools/registry";
import {
  createEmptyExecutionCheckpoint,
  latestExecutionCheckpoint,
} from "./execution/checkpoint";
import { executionCheckpointEvent } from "./execution/checkpointEvents";
import type { ExecutionCheckpoint, RunEndState } from "./execution/types";
import { createAgentExecutionContext } from "./execution/context";
import { loadMaterialOutcomesForConversation } from "./execution/materialOutcomes";
import { journaledNoteReceipts } from "./execution/journalReceipts";
import {
  buildCarriedSkillsMessage,
  buildScopeItemKeysMessage,
} from "./context/restartCarry";
import {
  createToolExecution,
  type ToolExecutionRecord,
} from "./execution/toolExecution";
import {
  buildInterruptedRunRecoveryMessage,
  buildTranscriptUserMessage,
  buildTurnStartRecoveryMessage,
  isCurrentTurnUserTranscriptMessage,
  isManualCompactRequest,
  readLatestTranscriptGoal,
} from "./execution/transcriptRecovery";
import {
  isUserDeniedToolResult,
  setToolResultReadAvailability,
} from "./execution/toolResultLifecycle";
import {
  renderAgentPastChatMessageText,
  type PastConversationSource,
} from "../services/pastConversations/pastConversationLoader";
import {
  isPastChatMessageText,
  pastChatMessageHasFailedSection,
  pastChatMessageIdSignature,
  withoutAgentAttachedConversationRefs,
} from "../services/pastConversations/pastConversationText";
import type {
  AgentAssistantMessage,
  AgentConfirmationResolution,
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentPendingAction,
  AgentRunEventRecord,
  AgentRunStatus,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
  AgentToolContext,
  AgentToolMessage,
  AgentUserMessage,
  ResolvedAgentRuntimeRequest,
} from "./types";

type AgentRuntimeDeps = {
  registry: AgentToolRegistry;
  adapterFactory: (request: ResolvedAgentRuntimeRequest) => AgentModelAdapter;
  paperContextResolver?: AgentRequestPaperContextResolver;
  now?: () => number;
  /** Overridable so a failing re-anchoring can be exercised in tests. */
  reanchorCitations?: typeof reanchorQuoteCitationsToClaims;
  /**
   * Every paper of a turn's scope, from the library index. Without it a turn
   * states no scope and no part can be declared over it.
   */
  resolveTurnScopePapers?: (
    request: AgentRuntimeRequest,
  ) => Promise<TaskPaperScopeSet | undefined>;
  /**
   * How long a turn waits for its conversation's stopped run to settle;
   * {@link STOPPED_RUN_WAIT_MS} unless a test exercises the bound.
   */
  stoppedRunWaitMs?: number;
  /**
   * The per-turn safety limits (`turnBoundary.ts`, Rule 3); the defaults
   * unless a test exercises a limit without a hundred model steps.
   */
  turnLimits?: Partial<TurnSafetyLimits>;
  /**
   * The waits before the retries of a failed model step (Rule 4); the
   * defaults unless a test exercises the retries without waiting.
   */
  modelRetryBackoffMs?: readonly number[];
  /**
   * Where attached past chats are read from; the conversation stores unless
   * a test supplies a fake.
   */
  pastConversationSource?: PastConversationSource;
};

/**
 * Best-effort log. The runtime runs inside Zotero, where `ztoolkit` exists,
 * and inside unit tests, where it does not.
 */
function logRuntimeWarning(message: string, error: unknown): void {
  (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit?.log?.(message, error);
}

type PendingConfirmation = {
  resolve: (resolution: AgentConfirmationResolution) => void;
};

/** Web source anchors moved by `delta` characters (text added or removed before them). */
function shiftWebAttribution(
  attribution: WebAttributionAssessment | undefined,
  delta: number,
): WebAttributionAssessment | undefined {
  if (!attribution || attribution.status !== "valid" || !delta)
    return attribution;
  return {
    ...attribution,
    anchors: attribution.anchors.map((anchor) => ({
      ...anchor,
      offset: Math.max(0, anchor.offset + delta),
    })),
  };
}

/**
 * The highest web_<n> the model can still copy in this conversation: in the
 * loaded transcript, and in the stored web_search and web_read results, which
 * the transcript keeps only as handles. If the store cannot be read, the
 * transcript alone sets the seed.
 */
export async function webSourceNumberSeed(
  conversationKey: number,
  messages: readonly { content?: unknown }[],
): Promise<number> {
  let stored: AgentToolResultHandleRecord[] = [];
  try {
    stored = (
      await Promise.all(
        ["web_search", "web_read"].map((toolName) =>
          listAgentToolResultHandles({ conversationKey, toolName }),
        ),
      )
    ).flat();
  } catch {
    stored = [];
  }
  return highestWebSourceNumber([...messages, ...stored]);
}

/**
 * The outside sources earlier questions of this conversation found: papers
 * and web pages from their stored tool results. If the store cannot be read,
 * a follow-up starts with none.
 */
export async function loadEarlierSources(
  conversationKey: number,
): Promise<SourceCatalog> {
  try {
    const stored = (
      await Promise.all(
        EARLIER_SOURCE_TOOL_NAMES.map((toolName) =>
          listAgentToolResultHandles({ conversationKey, toolName }),
        ),
      )
    ).flat();
    return earlierSourceCatalog(stored);
  } catch {
    return { sources: new Map(), linkIds: new Map() };
  }
}

function createRunId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createConfirmationRequestId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * End states a run records even when it has no outcome: each one says the
 * run stopped short of a plain ending, which the run row alone cannot tell.
 */
const END_STATES_RECORDED_WITHOUT_OUTCOMES: ReadonlySet<RunEndState> =
  new Set<RunEndState>(["blocked", "interrupted", "completed_with_exceptions"]);

/**
 * How long a turn waits for its conversation's stopped run to settle.
 * Stop is checked before a tool starts, so a tool running when it landed
 * runs to its end, and the run settles after it. The tools that read the
 * signal (web reads, retrieval, full-text reads, commands) end at once; the
 * rest end within their own limits: a script's default deadline is 30 s, a
 * literature search request 15 s, a note batch stops after its note in
 * flight, and Zotero's own reads and writes take seconds. A minute covers
 * them with room, and is about as long as a user watches a waiting status.
 * A tool that runs longer (a script given its 120 s maximum, a large
 * import) is not waited for: the turn goes on as it did before it waited.
 */
const STOPPED_RUN_WAIT_MS = 60_000;

/**
 * Run events written (with every row buffered before them) before the panel
 * sees them: the durable boundaries a reload must find. Deltas, statuses and
 * other progress reach the panel first and are written with their batch, at
 * most 250 ms or 64 rows later; a crash loses at most that buffer.
 */
const FLUSH_BEFORE_DELIVERY: ReadonlySet<AgentEvent["type"]> = new Set<
  AgentEvent["type"]
>([
  "tool_call",
  "tool_result",
  "tool_error",
  "final",
  "material_finalized",
  "execution_checkpoint",
  "execution_checkpoint_delta",
  "confirmation_required",
  "confirmation_resolved",
]);

/**
 * The latest turn this process started in each conversation, until it
 * settles: the promise resolves once the turn has written everything it
 * writes (the ledger's end, the run row, the transcript). A turn waits for
 * the one before it (`latestSettledRun`), so turns started one after
 * another settle in that order.
 */
const unsettledTurns = new Map<number, Promise<void>>();

/**
 * Thrown by a model step that found the caller's Stop before it started,
 * after it ended the run as cancelled; the loop returns the cancelled
 * outcome for it.
 */
class StoppedBeforeStep extends Error {
  constructor(readonly text: string) {
    super("Aborted");
  }
}

/**
 * Thrown by a model attempt that failed: the error, the text it streamed
 * before failing, and whether it reached a tool call.
 */
class ModelAttemptFailed extends Error {
  constructor(
    readonly failure: unknown,
    readonly streamedText: string,
    readonly toolCallSeen: boolean,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/**
 * Thrown by a model step the retry policy gave up on (`turnBoundary.ts`,
 * Rule 4); the loop ends the run with its rule.
 */
class ModelStepAbandoned extends Error {
  constructor(
    readonly rule: "connection_lost" | "prompt_budget_exceeded",
    readonly failure: unknown,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/**
 * Thrown when the request that asked again for an empty final-only answer
 * failed fatally; the loop ends the turn with the host's answer.
 */
class FinalOnlyAnswerUnwritten extends Error {
  constructor(readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/** Waits `ms`, or rejects with an AbortError once `signal` aborts. */
function waitUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) return aborted();
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      aborted();
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** Whether `settling` resolves within `ms`. */
function settlesWithin(settling: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void settling.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * The conversation's latest run, once the turn before this one has
 * settled. Stop releases the composer at once, while the run it stopped
 * finishes the tool in flight and only then records its page and settles
 * its ledger: read before that, the run is still running, so "continue"
 * finds nothing to resume and starts the job over, and the two turns
 * overwrite each other's transcript. So while the latest run is running and
 * the turn before this one has not settled, this one waits for it, up to
 * `waitMs`, and reads the latest run again. A run left running by a crash
 * has no turn of this process behind it: it is the interrupted run the turn
 * recovers.
 */
async function latestSettledRun(params: {
  conversationKey: number;
  /** The turn this process started before this one, until it settles. */
  priorTurn: Promise<void> | undefined;
  waitMs: number;
  /** Says what the turn waits for; an observer failing on it is ignored. */
  announce: () => void | Promise<void>;
}): Promise<Awaited<ReturnType<typeof getLatestAgentRunForConversation>>> {
  const latest = await getLatestAgentRunForConversation(params.conversationKey);
  if (latest?.status !== "running" || !params.priorTurn) return latest;
  try {
    await params.announce();
  } catch (error) {
    logRuntimeWarning(
      "LLM Agent: announcing the wait for a stopped run failed",
      error,
    );
  }
  if (!(await settlesWithin(params.priorTurn, params.waitMs))) return latest;
  return getLatestAgentRunForConversation(params.conversationKey);
}

/**
 * The past-chat copy a retry of this turn already stored: the message right
 * before the transcript's last "User request:" entry, when that entry has this
 * turn's text and the copy holds the same set of chats. A copy with a failed
 * section does not count when the new render loaded: history only grows, so
 * the new copy is appended after it.
 */
function findStoredPastChatCopyForTurn(
  transcript: readonly AgentModelMessage[],
  request: AgentRuntimeRequest,
  rendered: AgentModelMessage,
): AgentModelMessage | null {
  const signature = pastChatMessageIdSignature(rendered.content);
  if (!signature) return null;
  const renderedFailed = pastChatMessageHasFailedSection(rendered.content);
  // Every retry appends the request again, so walk back over each request
  // with this turn's text and stop at the first one with other text.
  for (let index = transcript.length - 1; index >= 1; index -= 1) {
    const message = transcript[index];
    if (
      message.role !== "user" ||
      typeof message.content !== "string" ||
      !message.content.startsWith("User request:")
    ) {
      continue;
    }
    if (!isCurrentTurnUserTranscriptMessage(message, request)) return null;
    const previous = transcript[index - 1];
    if (
      previous.role === "user" &&
      typeof previous.content === "string" &&
      isPastChatMessageText(previous.content) &&
      pastChatMessageIdSignature(previous.content) === signature &&
      !(pastChatMessageHasFailedSection(previous.content) && !renderedFailed)
    ) {
      return previous;
    }
  }
  return null;
}

export class AgentRuntime {
  private readonly registry: AgentToolRegistry;
  private readonly adapterFactory: AgentRuntimeDeps["adapterFactory"];
  private readonly paperContextResolver?: AgentRequestPaperContextResolver;
  private readonly now: () => number;
  private readonly reanchorCitations: typeof reanchorQuoteCitationsToClaims;
  private readonly resolveTurnScopePapers?: AgentRuntimeDeps["resolveTurnScopePapers"];
  private readonly stoppedRunWaitMs: number;
  private readonly turnLimits?: Partial<TurnSafetyLimits>;
  private readonly modelRetryBackoffMs?: readonly number[];
  private readonly pastConversationSource?: PastConversationSource;
  private readonly pendingConfirmations = new Map<
    string,
    PendingConfirmation
  >();

  constructor(deps: AgentRuntimeDeps) {
    this.registry = deps.registry;
    this.adapterFactory = deps.adapterFactory;
    this.paperContextResolver = deps.paperContextResolver;
    this.now = deps.now || (() => Date.now());
    this.reanchorCitations =
      deps.reanchorCitations || reanchorQuoteCitationsToClaims;
    this.resolveTurnScopePapers = deps.resolveTurnScopePapers;
    this.stoppedRunWaitMs = deps.stoppedRunWaitMs ?? STOPPED_RUN_WAIT_MS;
    this.turnLimits = deps.turnLimits;
    this.modelRetryBackoffMs = deps.modelRetryBackoffMs;
    this.pastConversationSource = deps.pastConversationSource;
  }

  listTools() {
    return this.registry.listTools();
  }

  getToolDefinition(name: string) {
    return this.registry.getTool(name);
  }

  registerTool<TInput, TResult>(
    tool: import("./types").AgentToolDefinition<TInput, TResult>,
  ): void {
    this.registry.register(tool);
  }

  unregisterTool(name: string): boolean {
    return this.registry.unregister(name);
  }

  async prepareExecutionRequest(
    requestInput: AgentRuntimeRequestInput | AgentRuntimeRequest,
    options: {
      signal?: AbortSignal;
      permissionOwner?: NonNullable<
        AgentRuntimeRequest["executionContext"]
      >["permissionOwner"];
    } = {},
  ): Promise<AgentRuntimeRequest> {
    const request =
      "turnPaperScope" in requestInput
        ? requestInput
        : resolveAgentRuntimeRequest(requestInput, {
            resolvePaperContext: this.paperContextResolver,
          });
    request.conversationGeneration ??= getConversationWriteGeneration(
      request.conversationKey,
    );
    request.skillRoutingReceipt = undefined;
    if (options.signal?.aborted)
      throw new Error("Agent preparation was cancelled.");
    request.executionContext ||= createAgentExecutionContext(
      request,
      `execution-${request.conversationKey}-${request.conversationGeneration}-${this.now()}`,
    );
    if (options.permissionOwner) {
      request.executionContext = {
        ...request.executionContext,
        permissionOwner: options.permissionOwner,
      };
    }
    return request;
  }

  getCapabilities(request: AgentRuntimeRequestInput) {
    const resolved = resolveAgentRuntimeRequest(request, {
      resolvePaperContext: this.paperContextResolver,
    });
    return this.adapterFactory(resolved).getCapabilities(
      resolved as unknown as AgentRuntimeRequest,
    );
  }

  /**
   * Registers an external pending confirmation so that `resolveConfirmation`
   * can settle it.  Used by the action-picker UI to wire action HITL cards
   * into the same resolution path as agent-turn confirmations.
   */
  registerPendingConfirmation(
    requestId: string,
    resolve: (resolution: AgentConfirmationResolution) => void,
  ): void {
    this.pendingConfirmations.set(requestId, { resolve });
  }

  resolveConfirmation(
    requestId: string,
    approvedOrResolution: boolean | AgentConfirmationResolution,
    data?: unknown,
  ): boolean {
    const pending = this.pendingConfirmations.get(requestId);
    if (!pending) return false;
    this.pendingConfirmations.delete(requestId);
    const resolution =
      typeof approvedOrResolution === "boolean"
        ? {
            approved: approvedOrResolution,
            actionId: approvedOrResolution ? undefined : "cancel",
            data,
          }
        : {
            approved: Boolean(approvedOrResolution.approved),
            actionId: approvedOrResolution.actionId,
            data: approvedOrResolution.data,
          };
    pending.resolve(resolution);
    return true;
  }

  async getRunTrace(runId: string) {
    return getAgentRunTrace(runId);
  }

  /**
   * The turn's scope, when it is worth stating (not a one-paper chat), or
   * none when it cannot be resolved: never fails a turn.
   */
  private async turnScopePapers(
    request: AgentRuntimeRequest,
  ): Promise<TaskPaperScopeSet | undefined> {
    if (
      !this.resolveTurnScopePapers ||
      !statesTurnPaperScope(request.turnPaperScope)
    )
      return undefined;
    try {
      return await this.resolveTurnScopePapers(request);
    } catch (error) {
      logRuntimeWarning(
        "LLM Agent: resolving the turn's paper scope failed",
        error,
      );
      return undefined;
    }
  }

  /**
   * The past-chat message for the chats the current user message attached,
   * or null. Rendered once, on the attaching turn; the transcript keeps it,
   * so later turns send the same bytes. A chat goes in full when it is small
   * and the turn's budget (min 12,000 tokens, 15% of the context window)
   * has room, otherwise as an outline the agent opens with past_chat_read.
   * Never fails the turn.
   *
   * Only the chats the user picked: a chat the agent attached with
   * past_chat_attach (via "agent") is in its tool result already. A retry of
   * that turn has it in scope and opens it again with a tool.
   */
  private async renderAttachedPastChatMessage(
    request: AgentRuntimeRequest,
  ): Promise<AgentUserMessage | null> {
    const refs = withoutAgentAttachedConversationRefs(
      request.attachedConversations,
    );
    if (!refs.length) return null;
    try {
      const { contextWindow } = resolveAgentPromptBudgetLimits({
        model: request.model,
        inputTokenCap: request.advanced?.inputTokenCap,
        apiBase: request.apiBase,
        providerProtocol: request.providerProtocol,
        authMode: request.authMode,
        profileOverride: request.advanced?.profileOverride,
        outputTokenLimit: request.advanced?.outputTokenLimit,
      });
      // Memoized under the user message, so a later rebuild of this turn's
      // history in the same session (agentMode/pastChatHistory.ts) sends the
      // same bytes.
      const text = await renderAgentPastChatMessageText({
        conversationKey: request.conversationKey,
        userMessageTimestamp: request.metadata?.sourceMessageTimestamp,
        refs,
        libraryID: request.libraryID,
        contextWindowTokens: contextWindow,
        source: this.pastConversationSource,
      });
      return text ? { role: "user", content: text } : null;
    } catch (error) {
      logRuntimeWarning(
        "LLM Agent: rendering the attached past chats failed",
        error,
      );
      return null;
    }
  }

  async runTurn(params: {
    request: AgentRuntimeRequestInput;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
    onStart?: (runId: string) => void | Promise<void>;
    /**
     * Says what the turn waits for before its run starts: the run this
     * conversation's last turn stopped, still finishing. Called before
     * `onStart`, and not one of the run's events.
     */
    onWaiting?: (text: string) => void | Promise<void>;
    signal?: AbortSignal;
    /**
     * False when this run replays a question the local usage ledger already
     * counted (a retry). The tokens it burns are still recorded.
     */
    usageCountsAsQuestion?: boolean;
  }): Promise<AgentRuntimeOutcome> {
    const request = resolveAgentRuntimeRequest(params.request, {
      resolvePaperContext: this.paperContextResolver,
    });
    request.conversationGeneration ??= getConversationWriteGeneration(
      request.conversationKey,
    );
    const runId = createRunId();
    request.executionContext ||= createAgentExecutionContext(request, runId);
    const writeAllowed = () =>
      !areConversationWritesFrozen(request.conversationKey) &&
      (request.conversationGeneration === undefined ||
        isConversationWriteGenerationCurrent(
          request.conversationKey,
          request.conversationGeneration,
        ));
    // Local usage ledger for this turn. The adapter reports usage per round
    // and cumulatively within a round, so the recorder folds every callback
    // into the one row written when the run settles below.
    const usageConversationSystem = classifyConversationKey(
      request.conversationKey,
    )?.system;
    const usageRuntime: UsageEventRuntime =
      usageConversationSystem === "claude_code"
        ? "claude-code"
        : usageConversationSystem === "codex"
          ? "codex"
          : "agent";
    const usageRecorder = createTurnUsageRecorder({
      conversationKey: request.conversationKey,
      conversationGeneration: request.conversationGeneration,
      countsAsQuestion: params.usageCountsAsQuestion !== false,
      runtime: usageRuntime,
      model: request.model,
      provider: request.modelProviderLabel,
    });
    // writeAllowed() gates delivery to the panel; persistAllowed() gates the
    // durable stores. A temporary side chat (an ephemeral key) receives every
    // event but writes no run, event, transcript, handle, evidence, coverage,
    // or memory row: each turn starts from its in-memory chat history.
    const persistAllowed = () =>
      writeAllowed() && !isEphemeralConversationKey(request.conversationKey);
    const persistIfLive = async <T>(
      task: () => Promise<T>,
    ): Promise<T | undefined> => {
      if (!persistAllowed()) return undefined;
      return withConversationWriteLock(request.conversationKey, async () => {
        if (!persistAllowed()) return undefined;
        return task();
      });
    };
    try {
      await ensureModelCapabilities(
        {
          model: request.model || "",
          apiBase: request.apiBase,
          protocol: request.providerProtocol,
          authMode: request.authMode,
          apiKey: request.apiKey,
        },
        { timeoutMs: 5_000 },
      );
    } catch {
      // Capability discovery is advisory; the adapter retains its fallback
      // profile when a provider does not expose a catalog.
    }
    validateLocalPdfDocumentBatch({
      pdfPaperContexts: getTurnPapersWithRoles(request, ["raw_pdf"]),
      localDocuments: request.localDocuments?.map((entry) => entry.resource),
    });
    const pathLease = acquireLocalDocumentPathLease(
      request.conversationKey,
      request.localDocuments?.map((entry) => entry.resource),
    );
    let webSourceRunId: string | undefined;
    // Set as the run starts to end: a run ends once, so an ending that fails
    // partway (its run row's write throwing) is not followed by a second.
    let runTerminating = false;
    let redactRunTerminalText = (value: string) => value;
    // The answer text streamed so far, redacted, once the run streams.
    let stoppedAnswerText = (): string => "";
    // The run's event stream, once it is open. An ending before then has no
    // stream to record its stop rule in.
    let emitRunEvent: ((event: AgentEvent) => Promise<void>) | undefined;
    // The run's event rows, written in batches off the stream's critical
    // path once the stream is open; flushed before every durable boundary.
    let runEvents: RunEventWriter | undefined;
    // Records the results of a long job's unfinished page, once the turn has
    // a job to record; a Stop or an error calls it before the run ends.
    let recordUnfinishedPage: (() => Promise<void>) | undefined;
    // The turn's outcome ledger has one writer. task_update and the evidence
    // recorder both apply their change here, one change at a time, and each
    // change that moves the ledger is published once.
    let executionCheckpointWrites: Promise<unknown> = Promise.resolve();
    // The ledger the run's events last published. A change is published as
    // a delta from it; the first change, and the one after a publication
    // that failed, is published whole.
    let publishedCheckpoint: ExecutionCheckpoint | undefined;
    // Set when a batch holding a published ledger failed to write: the
    // stored deltas no longer chain, so the next publication is whole.
    let checkpointChainBroken = false;
    // The run's `final` rows a failed batch lost; retried once at run end.
    const lostFinalRows: RunEventRow[] = [];
    const retryLostFinalRows = async (): Promise<void> => {
      const rows = lostFinalRows.splice(0);
      if (!rows.length) return;
      try {
        await persistIfLive(() => appendAgentRunEvents(runId, rows));
      } catch (error) {
        logRuntimeWarning("LLM Agent: rewriting the final event failed", error);
      }
    };
    // The turn's reads, so a read part declared after them still takes them.
    const turnReads: OutcomeEvidence[] = [];
    const updateExecutionCheckpoint = (
      apply: (checkpoint: ExecutionCheckpoint) => ExecutionCheckpoint,
    ): Promise<ExecutionCheckpoint> => {
      const write = executionCheckpointWrites.then(async () => {
        const current =
          request.executionCheckpoint ||
          createEmptyExecutionCheckpoint(request.executionContext!, this.now());
        let next = apply(current);
        if (next !== current && declaresReadPart(current, next)) {
          for (const read of turnReads)
            next = applyOutcomeEvidence(next, read, this.now()).checkpoint;
        }
        if (next !== current) {
          request.executionCheckpoint = next;
          if (emitRunEvent) {
            const event = executionCheckpointEvent(
              checkpointChainBroken ? undefined : publishedCheckpoint,
              next,
            );
            if (event.type === "execution_checkpoint")
              checkpointChainBroken = false;
            publishedCheckpoint = undefined;
            await emitRunEvent(event);
            publishedCheckpoint = next;
          }
        }
        return next;
      });
      executionCheckpointWrites = write.catch(() => undefined);
      return write;
    };
    /**
     * Publishes the ledger as it stands, whole, unless the run's events carry
     * it already: through the one writer, after any change queued before.
     */
    const publishExecutionCheckpoint = (): Promise<void> => {
      const write = executionCheckpointWrites.then(async () => {
        const current = request.executionCheckpoint;
        if (
          !current ||
          !emitRunEvent ||
          (publishedCheckpoint === current && !checkpointChainBroken)
        )
          return;
        checkpointChainBroken = false;
        publishedCheckpoint = undefined;
        await emitRunEvent(executionCheckpointEvent(undefined, current));
        publishedCheckpoint = current;
      });
      executionCheckpointWrites = write.catch(() => undefined);
      return write;
    };
    // Outcome evidence and the end state belong to ordinary turns.
    const recordsOutcomes = () =>
      request.executionContext?.permissionOwner === "original_agent";
    const recordOutcomeEvidence = async (
      evidence: OutcomeEvidence,
    ): Promise<void> => {
      if (evidence.kind === "read") turnReads.push(evidence);
      try {
        await updateExecutionCheckpoint(
          (checkpoint) =>
            applyOutcomeEvidence(checkpoint, evidence, this.now()).checkpoint,
        );
      } catch (error) {
        logRuntimeWarning(
          "LLM Agent: recording outcome evidence failed",
          error,
        );
      }
    };
    /**
     * The one path inside runTurn that finishes a run. The ledger is settled
     * with the run's end state, then the rule that ended it is recorded, so
     * every ending can be told apart afterwards; then the run's terminal
     * status and text are written.
     */
    const terminateRun = async (
      status: Exclude<AgentRunStatus, "running">,
      finalText: string | undefined,
      stopRule: RunStopRule,
    ): Promise<void> => {
      runTerminating = true;
      // Every event emitted so far is written before the ending is.
      await runEvents?.flush();
      if (recordsOutcomes()) {
        try {
          const end = decideRunEnd(request.executionCheckpoint, {
            status,
            stopRule,
          });
          if (
            request.executionCheckpoint?.tasks.length ||
            END_STATES_RECORDED_WITHOUT_OUTCOMES.has(end)
          ) {
            await updateExecutionCheckpoint((checkpoint) =>
              settleOutcomes(checkpoint, end, this.now()),
            );
          }
        } catch (error) {
          // Like the stop rule below, the end state is a record of the
          // ending: failing to write it must not change the ending.
          logRuntimeWarning(
            "LLM Agent: settling the outcome ledger failed",
            error,
          );
        }
      }
      try {
        await emitRunEvent?.({
          type: "provider_event",
          providerType: "agent_run_stop",
          payload: { rule: stopRule, status },
        });
      } catch (error) {
        // The record is diagnostic: an observer failing on it must not change
        // how the run ends.
        logRuntimeWarning("LLM Agent: recording the stop rule failed", error);
      }
      await runEvents?.flush();
      await retryLostFinalRows();
      await persistIfLive(() => finishAgentRun(runId, status, finalText));
    };
    // A turn started while the one before it in this conversation is still
    // settling waits for it (`latestSettledRun`); the next waits for this.
    const priorTurn = unsettledTurns.get(request.conversationKey);
    let settled = () => {};
    const settling = new Promise<void>((resolve) => {
      settled = resolve;
    });
    unsettledTurns.set(request.conversationKey, settling);
    try {
      const latestPriorRun = await latestSettledRun({
        conversationKey: request.conversationKey,
        priorTurn,
        waitMs: this.stoppedRunWaitMs,
        announce: () =>
          writeAllowed()
            ? params.onWaiting?.("Waiting for the stopped run to finish")
            : undefined,
      });
      // The turn's own clock starts here, once a stopped run before it has
      // settled: the safety limits count from this moment (turnBoundary.ts,
      // Rule 3).
      const turnStartedAt = this.now();
      const interruptedPriorRun =
        latestPriorRun?.status === "failed" &&
        latestPriorRun.finalText === INTERRUPTED_AGENT_RUN_MARKER
          ? latestPriorRun
          : null;
      webSourceRunId = runId;
      const adapter = this.adapterFactory(request);
      const adapterCapabilities = adapter.getCapabilities(request);
      const eventStreamRedactor = new AgentEventLocalDocumentStreamRedactor(
        request.conversationKey,
      );
      const turnPathRedactor = new LocalDocumentPathStreamRedactor(
        request.conversationKey,
      );
      redactRunTerminalText = (value) =>
        turnPathRedactor.redactTerminalText(value);
      // Resolves to whether the records reached the database.
      const persistToolResultHandles = async (
        records: AgentToolResultHandleRecord[],
      ): Promise<boolean> => {
        if (!records.length) return false;
        const sanitized = turnPathRedactor.redactTerminalValue(records);
        // A temporary side chat keeps its handles in memory (the store skips
        // the database for its key), so context_read can still open them.
        if (isEphemeralConversationKey(request.conversationKey)) {
          if (writeAllowed()) await upsertAgentToolResultHandles(sanitized);
          return false;
        }
        return (
          (await persistIfLive(() =>
            upsertAgentToolResultHandles(sanitized),
          )) === true
        );
      };
      let eventSeq = 0;
      let currentAnswerText = "";
      // Deliverable text the model streamed before calling a tool (per-paper
      // summaries, a table): already on screen, never rolled back, and the
      // start of whatever answer the turn ends with.
      let committedAnswerText = "";
      stoppedAnswerText = () =>
        turnPathRedactor.redactTerminalText(currentAnswerText);
      /** The visible answer after the committed text. */
      const uncommittedAnswerText = (): string =>
        committedAnswerText && currentAnswerText.startsWith(committedAnswerText)
          ? currentAnswerText.slice(committedAnswerText.length)
          : currentAnswerText;
      /** `text` without a leading repeat of the committed text. */
      const withoutCommittedPrefix = (text: string): string =>
        withoutLeadingRepeat(text, committedAnswerText);
      /**
       * For a model restarted from a checkpoint, which no longer shows what
       * it wrote before its tool calls: that text is already the answer's
       * start and must not be written again.
       */
      const committedAnswerNote = (): string => {
        if (!committedAnswerText) return "";
        const firstLine =
          committedAnswerText
            .split("\n")
            .map((line) => line.trim())
            .find(Boolean) || "";
        return `The text you wrote before the tool calls (${committedAnswerText.length} characters, starting "${firstLine.slice(0, 120)}") is already shown to the user and already starts the answer; continue after it and do not repeat it.`;
      };
      const item = request.item || null;
      await persistIfLive(() =>
        createAgentRun({
          runId,
          conversationKey: request.conversationKey,
          mode: "agent",
          model: request.model,
          status: "running",
          createdAt: this.now(),
        }),
      );
      // createAgentRun may have waited on the provider/DB.  Clear can commit
      // during that await and intentionally leave the conversation key live,
      // so a retired-key check alone is insufficient.  Never publish a late
      // run ID into the cleared generation's UI/cache.
      if (writeAllowed()) await params.onStart?.(runId);

      // Every citation this run's tools delivered, with the passage it was cut
      // from, so the terminal answer can be re-anchored to the claims it makes.
      const passageCitations = new PassageCitationCollector();
      let passageCollectionFailed = false;
      /**
       * The papers an answer cites (`item:<id>`), from the citations this
       * turn's tools delivered that the answer uses. Undefined when that
       * cannot be told: citation collection failed, the answer carries no
       * citation markup at all (prose written from host digests, say), or
       * (for a document, whose citations may be structured rather than
       * tokens in its text) nothing resolves. An empty list means citation
       * markup that resolves to no paper.
       */
      const answerCitedTargets = (
        text: string,
        options: { document?: boolean } = {},
      ): string[] | undefined => {
        if (passageCollectionFailed) return undefined;
        let used: QuoteCitation[];
        try {
          used = selectUsedQuoteCitations({
            text,
            quoteCitations: passageCitations.quoteCitations,
          });
        } catch (error) {
          logRuntimeWarning(
            "LLM Agent: reading the answer's citations failed",
            error,
          );
          return undefined;
        }
        const referenced = new Set<string>(paragraphCitationIds(text));
        for (const match of text.matchAll(
          new RegExp(QUOTE_CITATION_PATTERN.source, "g"),
        ))
          referenced.add(match[1]);
        // A selected-text anchor is offered with every answer; it counts
        // only when the answer cites it.
        const cited = used.filter(
          (citation) =>
            citation.sourceMatchKind !== "selected-text" ||
            referenced.has(citation.id),
        );
        const targets = [
          ...new Set(
            cited.flatMap((citation) => {
              const itemId = Number(citation.itemId);
              return Number.isInteger(itemId) && itemId > 0
                ? [`item:${itemId}`]
                : [];
            }),
          ),
        ];
        if (targets.length) return targets;
        // A document's citations may be structured, not tokens in its text.
        if (options.document) return undefined;
        // Markup that resolves to no item cites none of the papers; prose
        // with no markup at all says nothing about which it covers.
        return cited.length || referenced.size ? [] : undefined;
      };
      const writer = createRunEventWriter({
        persist: (rows) =>
          persistIfLive(() => appendAgentRunEvents(runId, rows)).then(
            () => undefined,
          ),
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: (handle) =>
          globalThis.clearTimeout(
            handle as ReturnType<typeof globalThis.setTimeout>,
          ),
        onError: (error) =>
          logRuntimeWarning("LLM Agent: run event persistence failed", error),
        onBatchFailed: (rows) => {
          for (const row of rows) {
            if (
              row.event.type === "execution_checkpoint" ||
              row.event.type === "execution_checkpoint_delta"
            )
              checkpointChainBroken = true;
            if (row.event.type === "final") lostFinalRows.push(row);
          }
        },
      });
      runEvents = writer;
      const emit = async (event: AgentEvent) => {
        if (!writeAllowed()) return;
        // Collected before redaction: the collector keeps only quote and
        // passage text, and the citations it publishes are redacted with the
        // final event that carries them.  Citation bookkeeping never decides
        // whether the run survives, so a failure while walking a tool result
        // is logged once and the turn keeps going.
        if (event.type === "tool_result" && event.ok) {
          try {
            passageCitations.collect(event.content, event.artifacts);
          } catch (error) {
            if (!passageCollectionFailed) {
              passageCollectionFailed = true;
              logRuntimeWarning(
                "LLM Agent: passage citation collection failed",
                error,
              );
            }
          }
        }
        for (const redactedEvent of eventStreamRedactor.process(event)) {
          eventSeq += 1;
          writer.enqueue({
            seq: eventSeq,
            event: redactedEvent,
            createdAt: this.now(),
          });
          // A durable boundary is written before the panel sees it; a delta
          // reaches the panel first and is written with its batch.
          if (FLUSH_BEFORE_DELIVERY.has(redactedEvent.type))
            await writer.flush();
          if (writeAllowed()) await params.onEvent?.(redactedEvent);
        }
      };
      emitRunEvent = emit;
      const actionContractSession = new ActionContractRunSession();

      const context: AgentToolContext = {
        request,
        runId,
        item,
        currentAnswerText,
        modelName: request.model || "unknown",
        modelProviderLabel: request.modelProviderLabel,
        signal: params.signal,
        readCurrentTurnActions: () =>
          toolExecutionRecords
            .slice(-8)
            .map(({ name, ok, input, content }) => ({
              name,
              ok,
              input,
              content,
            })),
        publishSkillActivation: (id) =>
          emit({ type: "status", text: `Skill activated: ${id}` }),
        updateExecutionCheckpoint,
      };
      const toolsUsedThisTurn: string[] = [];
      const toolExecutionRecords: ToolExecutionRecord[] = [];
      const pendingReadActivities: AgentPendingReadActivity[] = [];
      await hydrateAgentToolResultHandles(request.conversationKey);
      let toolResultReadAvailable = hasAgentToolResultHandles(
        request.conversationKey,
      );
      setToolResultReadAvailability(request, false);
      // A turn carries only explicitly forced skills; the model loads any
      // other guidance from the installed inventory with load_skill, so no
      // request precedes it.
      request.userTextSignals = computeUserTextSignals(request.userText);
      request.skillRoutingReceipt = undefined;
      const matchedSkills = getMatchedSkillIds(request, []);
      const forcedSkillIds = new Set(request.forcedSkillIds || []);
      request.loadedSkillRecords = (
        await Promise.all(
          getAllSkills()
            .filter((skill) => matchedSkills.includes(skill.id))
            .map(async (skill) => ({
              ...(
                await loadSkill(skill, getBuiltinSkillInstructionById(skill.id))
              ).loadedSkill,
              source: forcedSkillIds.has(skill.id)
                ? ("forced" as const)
                : ("loaded" as const),
            })),
        )
      ).sort((left, right) => left.id.localeCompare(right.id));
      if (!adapter.supportsTools(request)) {
        const reason =
          "Agent tools unavailable for this model; used direct response instead.";
        await emit({
          type: "fallback",
          reason,
        });
        await terminateRun(
          "completed",
          undefined,
          "tools_unsupported_fallback",
        );
        return {
          kind: "fallback",
          runId,
          reason,
          usedFallback: true,
        };
      }
      const toolDefinitions =
        this.registry.listToolDefinitionsForRequest(request);
      await hydrateAgentEvidenceCache(request.conversationKey);
      await hydrateAgentCoverageLedger({
        conversationKey: request.conversationKey,
        request,
      });
      // Resolved once per turn: the turn context states this scope, and a
      // part declared over it freezes exactly these papers.
      request.turnScopePapers = await this.turnScopePapers(request);
      const resourceContextPlan = buildAgentResourceContextPlan(request);
      resourceContextPlan.paperContext = await preparePaperPromptContext(
        request,
        { signal: params.signal },
      );
      passageCitations.collect({
        quoteCitations: resourceContextPlan.paperContext.quoteCitations,
      });
      context.resourceSignature = resourceContextPlan.resourceSignature;
      request.contextCache = resourceContextPlan.contextCache;
      const paperEvidenceFrontier = new PaperEvidenceFrontier();
      const preservedTurnHandleRecords: AgentToolResultHandleRecord[] = [];
      const transcriptCompatibilityKey = PORTABLE_TRANSCRIPT_KEY;
      let transcriptSegment = await loadAgentTranscriptSegment({
        conversationKey: request.conversationKey,
        compatibilityKey: transcriptCompatibilityKey,
      });
      if (!transcriptSegment.messages.length) {
        const legacy = await loadLatestAgentTranscriptSegment(
          request.conversationKey,
        );
        if (legacy)
          transcriptSegment = {
            ...legacy,
            compatibilityKey: transcriptCompatibilityKey,
          };
      }
      seedWebSourceNumbering(
        runId,
        await webSourceNumberSeed(
          request.conversationKey,
          transcriptSegment.messages,
        ),
      );
      const earlierSources = await loadEarlierSources(request.conversationKey);
      const history = normalizeHistoryMessages(request);
      const legacyCheckpoint = transcriptSegment.messages.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("Agent semantic continuation checkpoint:"),
      );
      const portable = buildPortableAgentTranscript({
        messages:
          legacyCheckpoint && history.length
            ? [
                ...transcriptSegment.messages.map((message) =>
                  message.role === "user" &&
                  typeof message.content === "string" &&
                  message.content.startsWith(
                    "Agent semantic continuation checkpoint:",
                  )
                    ? {
                        ...message,
                        content: message.content.replace(
                          "Agent semantic continuation checkpoint:",
                          "Legacy conversation summary (earlier exact text may be unavailable):",
                        ),
                      }
                    : message,
                ),
                ...history,
              ]
            : transcriptSegment.messages.length
              ? transcriptSegment.messages
              : history,
        conversationKey: request.conversationKey,
        resourceSignature: resourceContextPlan.resourceSignature,
      });
      await persistToolResultHandles(portable.handleRecords);
      transcriptSegment = { ...transcriptSegment, messages: portable.messages };
      request.workingDirectory ||= readRetainedWorkingDirectory(
        portable.messages,
      );
      const hadCompatibleTranscript = transcriptSegment.messages.length > 0;
      let transcriptMessagesForPrompt = [...transcriptSegment.messages];
      await persistIfLive(() =>
        replaceAgentTranscriptSegment(transcriptSegment),
      );
      // Material the conversation finalized outlives the run that made it.
      // Every turn -- not only the one after an interruption -- has to know
      // what is still unwritten, or it regenerates what already exists.
      request.materialOutcomes = (
        await loadMaterialOutcomesForConversation(request.conversationKey)
      ).entries;
      // The same is true of a note batch that stopped halfway: its unwritten
      // items live in durable rows, and a turn that cannot see them has no way
      // to continue the batch except by authoring every body again.
      const resumableBatches = await listResumableBatches(
        request.conversationKey,
      );
      let recoveryMessage: AgentModelMessage | null = null;
      let interruptedTraceEvents: readonly AgentRunEventRecord[] | undefined;
      // The run whose ledger this turn resumes, if it resumes one.
      let resumedFromRunId: string | undefined;
      if (interruptedPriorRun) {
        const [actions, latestTranscriptSegment, interruptedTrace] =
          await Promise.all([
            listJournalActions({
              runId: interruptedPriorRun.runId,
              limit: 50,
            }),
            loadLatestAgentTranscriptSegment(request.conversationKey),
            getAgentRunTrace(interruptedPriorRun.runId),
          ]);
        interruptedTraceEvents = interruptedTrace.events;
        const ordinaryCheckpoint = latestExecutionCheckpoint(
          interruptedTrace.events,
        );
        // A run left running when Zotero closed never settled its ledger, so
        // it is restored as it stood. A ledger its run settled comes back
        // only through a continue command, below.
        if (
          ordinaryCheckpoint &&
          !ordinaryCheckpoint.end &&
          request.executionContext?.permissionOwner === "original_agent" &&
          ordinaryCheckpoint.conversationKey === request.conversationKey &&
          ordinaryCheckpoint.conversationGeneration ===
            request.executionContext.conversationGeneration
        ) {
          request.executionCheckpoint = ordinaryCheckpoint;
          request.executionContext = {
            ...request.executionContext,
            executionId: ordinaryCheckpoint.executionId,
          };
          resumedFromRunId = interruptedPriorRun.runId;
        }
        const compatibilityMatches =
          latestTranscriptSegment?.compatibilityKey ===
          transcriptCompatibilityKey;
        recoveryMessage = buildInterruptedRunRecoveryMessage({
          run: interruptedPriorRun,
          actions,
          priorGoal: compatibilityMatches
            ? undefined
            : readLatestTranscriptGoal(latestTranscriptSegment?.messages || []),
          materialOutcomes: request.materialOutcomes,
          resumableBatches,
        });
        transcriptMessagesForPrompt = compatibilityMatches
          ? [...transcriptMessagesForPrompt, recoveryMessage]
          : [recoveryMessage];
      }
      // The prior run's events, read once, when the whole message asks to
      // continue it.
      const continuesPriorRun =
        Boolean(latestPriorRun) && isExplicitContinueCommand(request.userText);
      let priorRunEvents = interruptedTraceEvents;
      const readPriorRunEvents = async () =>
        (priorRunEvents ??= (await getAgentRunTrace(latestPriorRun!.runId))
          .events);
      // An interrupted ledger, or one the user stopped with a part still open,
      // resumes only when the whole message asks to continue; any other
      // message starts with no ledger.
      if (
        !request.executionCheckpoint &&
        latestPriorRun &&
        recordsOutcomes() &&
        continuesPriorRun
      ) {
        const priorEvents = await readPriorRunEvents();
        const interruptedLedger = latestExecutionCheckpoint(priorEvents);
        if (
          interruptedLedger &&
          resumesOnContinue(interruptedLedger) &&
          interruptedLedger.conversationKey === request.conversationKey &&
          interruptedLedger.conversationGeneration ===
            request.executionContext?.conversationGeneration
        ) {
          const { end, ...ledger } = interruptedLedger;
          request.executionCheckpoint = ledger;
          request.executionContext = {
            ...request.executionContext!,
            executionId: ledger.executionId,
          };
          resumedFromRunId = latestPriorRun.runId;
        }
      }
      // The run a resumed ledger comes from may have written notes whose
      // receipts never reached it: Stop or an error ended the run while a
      // write was running, or Zotero quit mid-batch. The change journal holds
      // every one, so the ledger takes those it lacks before the turn goes
      // on, each once.
      if (resumedFromRunId && request.executionCheckpoint) {
        try {
          const journaled = await journaledNoteReceipts({
            runId: resumedFromRunId,
            conversationKey: request.conversationKey,
          });
          if (journaled.length)
            await updateExecutionCheckpoint(
              (checkpoint) =>
                reconcileJournaledReceipts(checkpoint, journaled, this.now())
                  .checkpoint,
            );
        } catch (error) {
          logRuntimeWarning(
            "LLM Agent: reconciling the resumed ledger with the change journal failed",
            error,
          );
        }
        // The resumed ledger is this run's from its start, and published
        // whole now: a run that ends before it changes the ledger (Zotero
        // quits again, say) still leaves it for the next "continue".
        try {
          await publishExecutionCheckpoint();
        } catch (error) {
          logRuntimeWarning(
            "LLM Agent: publishing the resumed ledger failed",
            error,
          );
        }
      }
      // An interrupted run already carries the material and batch block inside
      // its one-time recovery note. Every other turn gets it as a prompt-only
      // host message: the ledger is recomputed from run events at every turn
      // start, so persisting the block would only stack identical -- and,
      // once the material is saved, stale -- copies in the transcript.
      const turnStartRecoveryMessage = recoveryMessage
        ? null
        : buildTurnStartRecoveryMessage({
            materialOutcomes: request.materialOutcomes,
            resumableBatches,
          });
      // A "continue" after a turn that a resumable rule stopped (a safety
      // limit, a lost connection, a prompt too long, a search that ran out)
      // gets a prompt-only note, with or without parts: the turn's work is
      // the saved transcript.
      let resumeNoteMessage: AgentUserMessage | null = null;
      if (continuesPriorRun && !recoveryMessage) {
        try {
          const rule = recordedStopRule(await readPriorRunEvents());
          const note = rule ? buildResumeNote(rule) : undefined;
          if (note) resumeNoteMessage = { role: "user", content: note };
        } catch (error) {
          logRuntimeWarning(
            "LLM Agent: reading the stopped run for its resume note failed",
            error,
          );
        }
      }
      const conversationReferenceMessage = buildConversationReferenceMessage(
        transcriptSegment.messages,
      );
      const promptTranscriptMessages = (): AgentModelMessage[] => {
        const retainedActionMessage = buildRetainedActionMessage(
          transcriptSegment.messages,
          transcriptMessagesForPrompt,
        );
        return [
          ...transcriptMessagesForPrompt,
          ...(conversationReferenceMessage
            ? [conversationReferenceMessage]
            : []),
          ...(retainedActionMessage ? [retainedActionMessage] : []),
          ...(turnStartRecoveryMessage ? [turnStartRecoveryMessage] : []),
          ...(resumeNoteMessage ? [resumeNoteMessage] : []),
        ];
      };

      if (isManualCompactRequest(request)) {
        const policy = resolveAgentContextBudgetPolicy();
        const budget = buildAgentContextBudgetState({
          messages: transcriptMessagesForPrompt,
          model: request.model,
          inputTokenCap: request.advanced?.inputTokenCap,
          apiBase: request.apiBase,
          providerProtocol: request.providerProtocol,
          authMode: request.authMode,
          profileOverride: request.advanced?.profileOverride,
          policy,
          forceCompact: true,
        });
        const compacted = compactAgentTranscript({
          messages: transcriptMessagesForPrompt,
          budget,
          force: true,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        const text = compacted.compacted
          ? "Conversation compacted"
          : "Nothing to compact yet";
        if (compacted.compacted) {
          transcriptSegment = {
            ...transcriptSegment,
            compactedAt: this.now(),
          };
          await persistToolResultHandles(compacted.handleRecords);
          if (compacted.handleRecords.length) toolResultReadAvailable = true;
          await persistIfLive(() =>
            replaceAgentTranscriptSegment(
              turnPathRedactor.redactTerminalValue(transcriptSegment),
            ),
          );
          await emit({ type: "context_compacted", automatic: false });
        }
        await emit({ type: "final", text });
        await terminateRun("completed", text, "manual_compaction");
        return {
          kind: "completed",
          runId,
          text,
          usedFallback: false,
        };
      }

      const currentUserTranscriptMessage = buildTranscriptUserMessage(request);
      const turnStartTranscriptMessages: AgentModelMessage[] = transcriptSegment
        .messages.length
        ? recoveryMessage
          ? [recoveryMessage]
          : []
        : [...transcriptMessagesForPrompt];
      const transcriptTail =
        turnStartTranscriptMessages[turnStartTranscriptMessages.length - 1] ||
        transcriptSegment.messages[transcriptSegment.messages.length - 1];
      const storesTurnMessages =
        hadCompatibleTranscript ||
        !isCurrentTurnUserTranscriptMessage(transcriptTail, request);
      // Loaded only when this turn's message attached chats and the block
      // below will store them.
      const pickedPastChats = withoutAgentAttachedConversationRefs(
        request.attachedConversations,
      );
      const renderedPastChatMessage =
        storesTurnMessages && pickedPastChats.length
          ? await this.renderAttachedPastChatMessage(request)
          : null;
      if (
        params.signal?.aborted &&
        storesTurnMessages &&
        pickedPastChats.length
      ) {
        // Stopped while the chats loaded: nothing of this turn is stored.
        const stopped = new Error("Aborted");
        stopped.name = "AbortError";
        throw stopped;
      }
      // Redacted once, so the prompt and the stored transcript hold the same
      // bytes and the next turn's prefix matches this one's.
      const pastChatMessage = renderedPastChatMessage
        ? turnPathRedactor.redactTerminalValue(renderedPastChatMessage)
        : null;
      let currentTurnPastChatMessage: AgentModelMessage | undefined;
      if (storesTurnMessages) {
        // The attached past chats go in once, as their own user message right
        // before this turn's request: stored in the transcript for later
        // turns, and in this turn's prompt, where the turn message stands in
        // for the stored request. Never transient, never a system message.
        // A retry of the latest turn keeps its transcript, which already
        // holds the same bytes (the render is memoized per user message):
        // the chat stays where it is instead of going in twice.
        const storedPastChatCopy = pastChatMessage
          ? findStoredPastChatCopyForTurn(
              transcriptMessagesForPrompt,
              request,
              pastChatMessage,
            )
          : null;
        if (pastChatMessage && !storedPastChatCopy) {
          turnStartTranscriptMessages.push(pastChatMessage);
          transcriptMessagesForPrompt = [
            ...transcriptMessagesForPrompt,
            pastChatMessage,
          ];
          currentTurnPastChatMessage = pastChatMessage;
        } else if (storedPastChatCopy) {
          // The stored copy stands in for this turn's, and stays in the
          // recent tail like a fresh one would.
          currentTurnPastChatMessage = storedPastChatCopy;
        }
        turnStartTranscriptMessages.push(currentUserTranscriptMessage);
      }
      if (turnStartTranscriptMessages.length) {
        await persistIfLive(() =>
          appendAgentTranscriptMessages({
            conversationKey: request.conversationKey,
            compatibilityKey: transcriptCompatibilityKey,
            messages: turnPathRedactor.redactTerminalValue(
              turnStartTranscriptMessages,
            ),
          }),
        );
        if (writeAllowed()) {
          transcriptSegment = {
            ...transcriptSegment,
            messages: [
              ...transcriptSegment.messages,
              ...turnStartTranscriptMessages,
            ],
          };
        }
      }

      await emit({
        type: "provider_event",
        providerType: "agent_context_envelope",
        payload: {
          resourceSignature: resourceContextPlan.resourceSignature,
          selectedPaperCount: getTurnPapersWithRoles(request, ["selected"])
            .length,
          fullTextPaperCount: getTurnPapersWithRoles(request, ["full_text"])
            .length,
          selectedCollectionCount: request.turnPaperScope.collections.length,
          selectedTagCount: request.turnPaperScope.tags.length,
          attachmentCount: request.attachments?.length || 0,
          screenshotCount: request.screenshots?.length || 0,
        },
      });
      const captureInstructionInventory =
        request.metadata?.instructionHarnessInventory === true;
      const renderedPrompt = await renderAgentPromptEnvelope(
        request,
        toolDefinitions,
        matchedSkills,
        resourceContextPlan,
        {
          contentInputs: resolveCapabilitiesContentInputs(adapterCapabilities),
          earlierSourcesBlock: buildEarlierSourcesBlock(earlierSources),
        },
      );
      request.deliveredToolGuidance = [
        ...renderedPrompt.inventory.toolGuidanceInstructions,
      ];
      const initialTranscriptMessages = promptTranscriptMessages();
      const messages = composeAgentModelInput(renderedPrompt.envelope, {
        transcriptMessages: initialTranscriptMessages,
      });
      const instructionInventory = captureInstructionInventory
        ? buildAgentPromptInstructionInventory(
            renderedPrompt,
            messages,
            initialTranscriptMessages,
          )
        : undefined;
      if (captureInstructionInventory && instructionInventory) {
        await emit({
          type: "provider_event",
          providerType: "instruction_harness_inventory",
          payload: {
            model: request.model || "",
            protocol: request.providerProtocol || "",
            matchedSkillIds: matchedSkills,
            ...instructionInventory,
          },
        });
      }
      const continuationSession = new AgentRunContinuationSession(messages);

      const budgetState = buildAgentContextBudgetState({
        messages,
        model: request.model,
        inputTokenCap: request.advanced?.inputTokenCap,
        apiBase: request.apiBase,
        providerProtocol: request.providerProtocol,
        authMode: request.authMode,
        profileOverride: request.advanced?.profileOverride,
        recentlyCompacted: Boolean(transcriptSegment.compactedAt),
      });
      const providerReplaySoftLimit = resolveAgentPromptBudgetLimits({
        model: request.model,
        inputTokenCap: request.advanced?.inputTokenCap,
        apiBase: request.apiBase,
        providerProtocol: request.providerProtocol,
        authMode: request.authMode,
        profileOverride: request.advanced?.profileOverride,
        outputTokenLimit: request.advanced?.outputTokenLimit,
      }).softLimitTokens;
      if (
        (budgetState.shouldCompact || transcriptSegment.compactedAt) &&
        transcriptMessagesForPrompt.length
      ) {
        await emit({ type: "status", text: "Compacting context…" });
        const compacted = compactAgentTranscript({
          messages: transcriptMessagesForPrompt,
          budget: budgetState,
          force: Boolean(transcriptSegment.compactedAt),
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
          keepInTail: currentTurnPastChatMessage,
        });
        if (compacted.compacted) {
          transcriptMessagesForPrompt = compacted.messages;
          transcriptSegment = {
            ...transcriptSegment,
            compactedAt: this.now(),
          };
          await persistToolResultHandles(compacted.handleRecords);
          if (compacted.handleRecords.length) toolResultReadAvailable = true;
          await persistIfLive(() =>
            replaceAgentTranscriptSegment(
              turnPathRedactor.redactTerminalValue(transcriptSegment),
            ),
          );
          await emit({ type: "context_compacted", automatic: true });
          messages.splice(
            0,
            messages.length,
            ...composeAgentModelInput(renderedPrompt.envelope, {
              transcriptMessages: promptTranscriptMessages(),
            }),
          );
        }
      }
      const newTranscriptMessages: AgentModelMessage[] = [];
      /**
       * Writes the run's transcript. Stop releases the conversation at once,
       * and a turn queued behind it may write the transcript while this run
       * still finishes a call: once stopped, the run writes only over the
       * transcript as it last saw it, never over what that turn wrote.
       */
      // A temporary side chat keeps its transcript in memory only: the
      // write is accepted ("memory_only") without a row, so its checkpoints
      // pass as a stored chat's do.
      const writeTranscriptSegment = async (
        next: AgentTranscriptSegment,
      ): Promise<AgentTranscriptWriteResult | undefined> => {
        if (isEphemeralConversationKey(request.conversationKey))
          return writeAllowed() ? "memory_only" : undefined;
        return persistIfLive(() =>
          params.signal?.aborted
            ? replaceAgentTranscriptSegmentIfUnchanged(transcriptSegment, next)
            : replaceAgentTranscriptSegment(next),
        );
      };
      let latestProviderReplayTokens = 0;
      const commitSemanticCheckpoint = async (params: {
        sourceMessages: AgentModelMessage[];
        preservedHandleRecords?: AgentToolResultHandleRecord[];
        retryInstruction?: string;
      }): Promise<{
        checkpoint: AgentUserMessage;
        writeResult: AgentTranscriptWriteResult | undefined;
        handleCount: number;
      }> => {
        const semantic = buildAgentSemanticCheckpoint({
          messages: params.sourceMessages,
          summaryTokens: budgetState.summaryTokens,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
          preservedHandleRecords: [
            ...preservedTurnHandleRecords,
            ...(params.preservedHandleRecords || []),
          ],
        });
        const checkpoint: AgentUserMessage = {
          ...semantic.checkpoint,
          content: [
            turnPathRedactor.redactTerminalText(semantic.checkpoint.content),
            params.retryInstruction
              ? turnPathRedactor.redactTerminalText(params.retryInstruction)
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        };
        await persistToolResultHandles(semantic.handleRecords);
        const nextSegment = {
          ...transcriptSegment,
          compactedAt: this.now(),
        };
        const writeResult = await writeTranscriptSegment(nextSegment);
        if (
          writeAllowed() &&
          (writeResult === "persisted" || writeResult === "memory_only")
        ) {
          transcriptSegment = nextSegment;
        }
        return {
          checkpoint,
          writeResult,
          handleCount: semantic.handleRecords.length,
        };
      };
      const requireAcceptedCheckpointWrite = (
        result: AgentTranscriptWriteResult | undefined,
      ): void => {
        if (result === "persisted" || result === "memory_only") return;
        throw new Error(
          result === "failed"
            ? "Agent transcript checkpoint storage failed."
            : "Agent transcript checkpoint was skipped because the conversation is no longer writable.",
        );
      };
      const persistTranscriptCheckpoint = async (
        options: {
          requireAccepted?: boolean;
        } = {},
      ): Promise<AgentTranscriptWriteResult | undefined> => {
        // The trace is written up to here before the transcript moves on.
        await runEvents?.flush();
        if (!newTranscriptMessages.length) return "skipped";
        const portable = buildPortableAgentTranscript({
          messages: [...transcriptSegment.messages, ...newTranscriptMessages],
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        await persistToolResultHandles(portable.handleRecords);
        const nextSegment = {
          ...transcriptSegment,
          messages: portable.messages,
        };
        const committed = {
          writeResult: await writeTranscriptSegment(nextSegment),
        };
        if (
          committed.writeResult === "persisted" ||
          committed.writeResult === "memory_only"
        )
          transcriptSegment = nextSegment;
        if (options.requireAccepted) {
          requireAcceptedCheckpointWrite(committed.writeResult);
        }
        if (
          committed.writeResult !== "persisted" &&
          committed.writeResult !== "memory_only"
        ) {
          return committed.writeResult;
        }
        newTranscriptMessages.splice(0, newTranscriptMessages.length);
        return committed.writeResult;
      };
      // A long job (loop/longJob.ts): when the papers a turn's parts name do
      // not fit one pass, the host pages them.
      const scopePaper = (target: string) =>
        request.turnScopePapers?.papers?.[Number(target.replace(/^item:/, ""))];
      const longJob = new LongJobPager((target) =>
        priorPaperTokens(scopePaper(target)?.text),
      );
      const longJobDigests = new Map<string, PaperDigest>();
      // A job "continue" picked back up: the per-paper results its earlier
      // turns recorded carry forward, so its last step still sees every
      // paper. They are read where each batch was stored, by the job, not
      // from the transcript, whose copy of a batch is the model's view and
      // may be gone. Such a digest is re-cut to this turn's share at its
      // first page, and recorded again only with new evidence.
      const carriedDigests = new Set<string>();
      if (recordsOutcomes() && readLongJob(request.executionCheckpoint)) {
        const batches = await listAgentToolResultHandles({
          conversationKey: request.conversationKey,
          toolName: "long_job_results",
        });
        for (const record of batches) {
          const content = record.content as
            | { executionId?: unknown; digests?: unknown }
            | undefined;
          if (content?.executionId !== request.executionCheckpoint?.executionId)
            continue;
          for (const digest of readStoredPaperDigests(content?.digests)) {
            longJobDigests.set(`item:${digest.itemId}`, digest);
            carriedDigests.add(`item:${digest.itemId}`);
          }
        }
      }
      // The message that carries every digest and the next page. Every
      // restart sends it again, so no restart loses the job's results.
      let longJobMessage: AgentUserMessage | null = null;
      // While a page is open: each page paper's share, which caps a read.
      let longJobReadShare = 0;
      // How many of the turn's reads the pager has seen, so each round
      // tells it only the papers its own read calls carried.
      let longJobReadsSeen = 0;
      // Papers the host gave up on in the round the pager checks next.
      let longJobGaveUp: string[] = [];
      // How many batches of per-paper results the transcript holds.
      let longJobRecords = 0;
      const restartFromSemanticCheckpoint = async (params: {
        sourceMessages: AgentModelMessage[];
        handleRecords?: AgentToolResultHandleRecord[];
        retryInstruction?: string;
      }): Promise<void> => {
        if (newTranscriptMessages.length)
          await persistTranscriptCheckpoint({ requireAccepted: true });
        const committed = await commitSemanticCheckpoint({
          sourceMessages: params.sourceMessages,
          preservedHandleRecords: params.handleRecords,
          retryInstruction:
            [params.retryInstruction, committedAnswerNote()]
              .filter(Boolean)
              .join("\n\n") || undefined,
        });
        requireAcceptedCheckpointWrite(committed.writeResult);
        if (committed.handleCount) {
          toolResultReadAvailable = true;
          setToolResultReadAvailability(request, true);
        }
        const restartMessages = composeAgentModelInput(
          renderedPrompt.envelope,
          {
            transcriptMessages: [],
            postTurnMessages: [
              committed.checkpoint,
              ...[
                conversationReferenceMessage,
                buildRetainedActionMessage(transcriptSegment.messages),
                // What the dropped tool results gave the model mid-turn:
                // the skills it loaded and the scope's item keys.
                buildCarriedSkillsMessage(toolExecutionRecords, matchedSkills),
                buildScopeItemKeysMessage(
                  request.turnScopePapers,
                  request.turnPaperScope.libraryID || request.libraryID,
                  request.executionCheckpoint,
                ),
                longJobMessage,
              ].filter((message): message is AgentUserMessage =>
                Boolean(message),
              ),
            ],
          },
        );
        continuationSession.restartWithMessages(restartMessages);
        newTranscriptMessages.splice(0, newTranscriptMessages.length);
        latestProviderReplayTokens = 0;
        adapter.resetState?.();
        // Every restart drops the prompt a long job's page measures its
        // papers' cost from: the pager measures again from this one. A page's
        // end restarts here too, and its next page then starts a measurement
        // of its own.
        if (recordsOutcomes())
          longJob.restarted({
            checkpoint: request.executionCheckpoint,
            promptTokens: estimateContextMessagesTokens(messages),
          });
      };

      for (const skillId of matchedSkills) {
        await emit({ type: "status", text: `Skill activated: ${skillId}` });
      }

      const extendedRunLimits = request.metadata?.hostRecordedBatchJob === true;
      const { maxRounds, maxToolCallsPerRound } =
        resolveAgentLimits(extendedRunLimits);
      const finalAnswerController = new AgentFinalAnswerController(request, {
        earlierSources,
      });
      // Every whole-turn stop decision (loop/turnBoundary.ts): the failure
      // counters, navigation without evidence, the safety limits and the
      // retry policy. Rejected input never ran, so it is a repair
      // opportunity, not a failing tool, with its own, more forgiving cap.
      const turnBoundary = new TurnBoundary({
        now: turnStartedAt,
        maxRounds,
        settledTargets: settledTargetCount(request.executionCheckpoint),
        limits: this.turnLimits,
        retryBackoffMs: this.modelRetryBackoffMs,
        // A settled paper restarts the outside-search counts with the rest.
        onSettled: () => resetOutsideSearchLedger(runId),
      });
      const searchScope = searchScopeLabel(request.turnPaperScope);
      /** How many of the turn's declared parts are done, for a stop text. */
      const partsProgress = () => {
        const tasks = (request.executionCheckpoint?.tasks || []).filter(
          (task) => task.origin === "model" && !task.supersededBy,
        );
        return {
          done: tasks.filter((task) => task.status === "completed").length,
          total: tasks.length,
        };
      };
      // The last round whose progress classification was published.
      let lastClassifiedRound = 0;
      const publishRoundProgress = async (
        report: RoundProgressReport,
      ): Promise<void> => {
        lastClassifiedRound = report.round;
        await emit({
          type: "provider_event",
          providerType: "agent_round_progress",
          payload: { ...report },
        });
      };
      const shouldFlushStreamBuffer = (value: string): boolean => {
        if (!value) return false;
        if (value.length >= 8) return true;
        return /(?:\n|[.!?,:;]\s?)$/u.test(value);
      };
      let finalizedMaterial:
        | { documentId: string; finalText: string }
        | undefined;
      // Material this run finalized, keyed by document id, so the terminal
      // event can name the exact revision the answer came from.
      const finalizedMaterialRefs = new Map<string, MaterialRef>();
      const completeRun = async (
        finalText: string,
        status: "completed" | "failed",
        stopRule: RunStopRule,
        options: {
          emitFinalEvent?: boolean;
          webAttribution?: WebAttributionAssessment;
          documentId?: string;
        } = {},
      ): Promise<AgentRuntimeOutcome> => {
        if (finalizedMaterial && !options.documentId) {
          options = { ...options, documentId: finalizedMaterial.documentId };
          finalText =
            status === "failed"
              ? `${finalizedMaterial.finalText}\n\n${finalText}`
              : finalizedMaterial.finalText;
        }
        if (committedAnswerText && !finalText.startsWith(committedAnswerText)) {
          finalText = `${committedAnswerText}${finalText}`;
          options = {
            ...options,
            webAttribution: shiftWebAttribution(
              options.webAttribution,
              committedAnswerText.length,
            ),
          };
        }
        const redactedFinalText =
          turnPathRedactor.redactTerminalText(finalText);
        const finalMaterialRef = options.documentId
          ? finalizedMaterialRefs.get(options.documentId)
          : undefined;
        // The transcript and the read/coverage ledgers record what this run
        // DID. Gating them on a clean finish meant a run that exhausted its
        // rounds -- or was failed by three cancellations -- threw away its own
        // memory *after* its library writes had already landed, so "continue"
        // started blind on a library that had already changed.
        //
        // recordAgentTurn stays gated below: it is the turn summary, and
        // summarising an unfinished turn as an answer would be its own lie.
        {
          await persistIfLive(() =>
            commitAgentReadActivities({
              conversationKey: request.conversationKey,
              activities: pendingReadActivities,
              resourceSignature: resourceContextPlan.resourceSignature,
            }),
          );
          await persistIfLive(() =>
            commitAgentCoverageActivities({
              conversationKey: request.conversationKey,
              activities: pendingReadActivities,
            }),
          );
          if (redactedFinalText)
            newTranscriptMessages.push({
              role: "assistant",
              content: redactedFinalText,
              messageId: `${runId}:answer`,
            });
          await persistTranscriptCheckpoint({ requireAccepted: true });
          if (status === "completed" && redactedFinalText) {
            await persistIfLive(() =>
              recordAgentTurn(
                request.conversationKey,
                turnPathRedactor.redactTerminalText(request.userText),
                toolsUsedThisTurn,
                redactedFinalText,
              ),
            );
          }
        }
        await terminateRun(status, redactedFinalText, stopRule);
        // The tools' citations name the sentence the retrieval picked, not the
        // sentence the answer went on to make. Re-anchor them to the claim that
        // cites them, so a chip opens the line the reader is looking at.
        //
        // The answer is already durable at this point. Citations are an
        // improvement on it, never a condition of publishing it: if
        // re-anchoring or its redaction throws, the final event and the
        // outcome still carry the answer, without citations.
        //
        // Only the citations the answer uses are published: the tool results
        // already delivered the whole retrieved set to the panel, and a final
        // event carrying every passage of a long run froze it at completion.
        let finalQuoteCitations: QuoteCitation[] | undefined;
        try {
          const usedCitations = selectUsedQuoteCitations({
            text: redactedFinalText,
            quoteCitations: passageCitations.quoteCitations,
          });
          finalQuoteCitations = usedCitations.length
            ? turnPathRedactor.redactTerminalValue(
                this.reanchorCitations({
                  text: redactedFinalText,
                  quoteCitations: usedCitations,
                  passageTextByCitationId:
                    passageCitations.passageTextByCitationId,
                }).quoteCitations,
              )
            : undefined;
        } catch (error) {
          finalQuoteCitations = undefined;
          logRuntimeWarning("LLM Agent: claim re-anchoring failed", error);
        }
        // A final event publishes a durable outcome. A UI observer may fail;
        // it must not leave an already completed answer only on screen.
        if (options.emitFinalEvent !== false) {
          await emit({
            type: "final",
            text: redactedFinalText,
            ...(options.documentId ? { documentId: options.documentId } : {}),
            ...(finalMaterialRef ? { materialRef: finalMaterialRef } : {}),
            ...(options.webAttribution?.status === "valid" &&
            options.webAttribution.anchors.length
              ? {
                  webSourceAnchors: options.webAttribution.anchors,
                }
              : {}),
            ...(finalQuoteCitations
              ? { quoteCitations: finalQuoteCitations }
              : {}),
          });
        }
        return {
          kind: "completed",
          runId,
          text: redactedFinalText,
          ...(options.documentId ? { documentId: options.documentId } : {}),
          ...(finalQuoteCitations
            ? { quoteCitations: finalQuoteCitations }
            : {}),
          usedFallback: false,
          ...(status === "failed" ? { runStatus: "failed" as const } : {}),
        } as const;
      };
      const emitFinalStep = async (
        step: Extract<AgentModelStep, { kind: "final" }>,
        stepStreamedText: string,
        webAttribution: WebAttributionAssessment,
        options: {
          /** Answer text already held by earlier transcript messages. */
          transcriptPrefix?: string;
          /** The rule the answer ends the run with; a plain final answer. */
          stopRule?: Extract<RunStopRule, "final_answer" | "search_exhausted">;
        } = {},
      ): Promise<AgentRuntimeOutcome> => {
        // A provider may repeat the committed text at the start of its final
        // step; the answer already leads with it.
        const modelFinalText = withoutCommittedPrefix(webAttribution.cleanText);
        webAttribution = shiftWebAttribution(
          webAttribution,
          modelFinalText.length - webAttribution.cleanText.length,
        )!;
        const receiptStatus = actionContractSession.receiptStatus();
        // Parts still open after the answer end the run not done: the answer
        // says so, whatever the model claimed.
        const unfinished = recordsOutcomes()
          ? renderUnfinishedParts(
              openDeclaredOutcomes(request.executionCheckpoint),
              OUTCOME_REASONS.noText,
            )
          : "";
        const finalText = [
          receiptStatus
            ? `${modelFinalText}\n\n${receiptStatus}`
            : modelFinalText,
          unfinished,
        ]
          .filter(Boolean)
          .join("\n\n");
        if (finalText) {
          if (!stepStreamedText) {
            currentAnswerText = `${committedAnswerText}${finalText}`;
            await emit({
              type: "message_delta",
              text: finalText,
            });
          } else if (finalText.startsWith(stepStreamedText)) {
            const remainder = finalText.slice(stepStreamedText.length);
            if (remainder) {
              currentAnswerText += remainder;
              await emit({
                type: "message_delta",
                text: remainder,
              });
            }
          } else {
            currentAnswerText = `${committedAnswerText}${finalText}`;
          }
        }
        return await completeRun(
          finalText,
          "completed",
          options.stopRule ?? "final_answer",
          { webAttribution },
        );
      };
      const providerTerminalOutcomes: ToolWorkflowOutcome[] = [];
      const rollbackCommittedStreamedText = async (
        stepStreamedText: string,
      ): Promise<void> => {
        if (!stepStreamedText) return;
        currentAnswerText = currentAnswerText.slice(
          0,
          Math.max(0, currentAnswerText.length - stepStreamedText.length),
        );
        await emit({
          type: "message_rollback",
          length: stepStreamedText.length,
          text: stepStreamedText,
        });
      };
      // A final answer cut off at the output limit, kept on screen while the
      // model writes the remainder (see the incomplete-step branch).
      let keptAnswerVisibleText = "";
      let keptAnswerModelText = "";
      const rollbackKeptAnswer = async (): Promise<void> => {
        if (!keptAnswerVisibleText) {
          keptAnswerModelText = "";
          return;
        }
        const text = keptAnswerVisibleText;
        keptAnswerVisibleText = "";
        keptAnswerModelText = "";
        currentAnswerText = currentAnswerText.slice(
          0,
          Math.max(0, currentAnswerText.length - text.length),
        );
        await emit({
          type: "message_rollback",
          length: text.length,
          text,
        });
      };
      /**
       * Text streamed before a tool call: commit deliverable content, roll
       * back a lead-in. A kept cut-off answer sits just before `streamed` on
       * screen, so the two are one segment: committed together, or rolled
       * back newest first. Returns the newly streamed text when committed,
       * "" otherwise.
       */
      const settleStreamedTextBeforeTools = async (
        streamed: string,
      ): Promise<string> => {
        const segment = `${keptAnswerVisibleText}${streamed}`;
        if (!segment) return "";
        if (!isSubstantiveAnswerText(segment)) {
          await rollbackCommittedStreamedText(streamed);
          await rollbackKeptAnswer();
          return "";
        }
        keptAnswerVisibleText = "";
        keptAnswerModelText = "";
        // What the model writes next starts a new paragraph.
        const separator = segment.endsWith("\n\n")
          ? ""
          : segment.endsWith("\n")
            ? "\n"
            : "\n\n";
        if (separator) {
          currentAnswerText += separator;
          await emit({ type: "message_delta", text: separator });
        }
        committedAnswerText += `${segment}${separator}`;
        return streamed;
      };
      /**
       * One provider request for the round's model step. A failure is
       * thrown as ModelAttemptFailed, with the text the attempt streamed and
       * whether it reached a tool call; runModelStep decides on a retry.
       */
      // Set when the provider refused `tool_choice` none: the final-only
      // step is then sent with its default choice, and any tool call it
      // returns is refused (turnBoundary.ts, Rule 2).
      let toolChoiceNoneRejected = false;
      // A final-only step that wrote no visible text is asked once more; a
      // fatal failure of that request ends the turn with the host's answer.
      let finalOnlyEmptyAnswerReasked = false;
      const attemptModelStep = async (
        round: number,
        statusText: string,
        attempt: number,
      ): Promise<{ step: AgentModelStep; stepStreamedText: string }> => {
        if (params.signal?.aborted) {
          await recordUnfinishedPage?.().catch((error) =>
            logRuntimeWarning(
              "LLM Agent: recording a stopped page's results failed",
              error,
            ),
          );
          // The run is finished here, so the catch below no longer does it.
          const stoppedText = stoppedAnswerText();
          await terminateRun("cancelled", stoppedText, "cancelled_before_step");
          throw new StoppedBeforeStep(stoppedText);
        }
        await emit({
          type: "status",
          text: statusText,
        });
        let stepStreamedText = "";
        let stepPendingDelta = "";
        const flushStepDelta = async () => {
          if (!stepPendingDelta) return;
          const text = stepPendingDelta;
          stepPendingDelta = "";
          currentAnswerText += text;
          await emit({
            type: "message_delta",
            text,
          });
        };
        const settleStepStreamedText = async (): Promise<string> => {
          await flushStepDelta();
          const committed =
            await settleStreamedTextBeforeTools(stepStreamedText);
          stepStreamedText = "";
          stepPendingDelta = "";
          return committed;
        };
        if (latestProviderReplayTokens > providerReplaySoftLimit) {
          const replayTokens = latestProviderReplayTokens;
          await restartFromSemanticCheckpoint({ sourceMessages: messages });
          await emit({
            type: "provider_event",
            providerType: "agent_context_budget",
            payload: {
              action: "checkpoint_provider_replay_usage",
              providerReplayTokens: replayTokens,
              softLimitTokens: providerReplaySoftLimit,
            },
          });
        }
        const preflight = enforceAgentPromptBudget({
          messages,
          model: request.model,
          inputTokenCap: request.advanced?.inputTokenCap,
          apiBase: request.apiBase,
          providerProtocol: request.providerProtocol,
          authMode: request.authMode,
          profileOverride: request.advanced?.profileOverride,
          outputTokenLimit: request.advanced?.outputTokenLimit,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        if (preflight.changed) {
          await restartFromSemanticCheckpoint({
            sourceMessages: preflight.messages,
            handleRecords: preflight.handleRecords,
          });
          await emit({
            type: "provider_event",
            providerType: "agent_context_budget",
            payload: {
              action: "compacted_model_prompt",
              beforeTokens: preflight.estimatedBeforeTokens,
              afterTokens: preflight.estimatedAfterTokens,
              softLimitTokens: preflight.softLimitTokens,
              contextWindow: preflight.contextWindow,
              reductions: preflight.reductions,
              handleCount: preflight.handleRecords.length,
            },
          });
        }
        const stepToolResultReadAvailable =
          toolResultReadAvailable || preflight.handleRecords.length > 0;
        setToolResultReadAvailability(request, stepToolResultReadAvailable);
        const stepToolSpecs = this.registry.listToolsForRequest(request);
        const stepContextWindow = preflight.contextWindow;
        const stepInputLimitIsUserAuthoritative =
          preflight.inputLimitSource === "advanced" ||
          preflight.inputLimitSource === "user";
        const stepContextTokens = preflight.estimatedAfterTokens;
        request.runtimeContextBudget = {
          contextWindowTokens: stepContextWindow,
          usedContextTokens: stepContextTokens,
          ...(longJobReadShare > 0
            ? { maxTokensPerPaper: longJobReadShare }
            : {}),
        };
        if (stepContextTokens > 0 && stepContextWindow > 0) {
          await emit({
            type: "usage",
            round,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            contextTokens: stepContextTokens,
            contextWindow: stepContextWindow,
          });
        }
        const modelInput = continuationSession.inputForNextStep();
        // The provider bills from here on, abort included, so the turn owes a
        // usage row even if this round never finishes.
        usageRecorder.markDispatched();
        // A retried request is billed on its own, beside the one that failed.
        const usageSegment = attempt ? `${round}.${attempt}` : round;
        // The prompt tokens the provider reported for this request, for the
        // turn's safety limit; and whether it reached a tool call.
        let attemptInputTokens = 0;
        let toolCallSeen = false;
        const attemptRequest = adapter.runStep({
          request,
          messages: modelInput.messages,
          continuationMessages: modelInput.continuationMessages,
          tools: stepToolSpecs,
          ...(turnBoundary.finalOnly && !toolChoiceNoneRejected
            ? { toolChoice: "none" as const }
            : {}),
          signal: params.signal,
          onTextDelta: async (delta) => {
            if (!delta) return;
            stepStreamedText += delta;
            stepPendingDelta += delta;
            if (shouldFlushStreamBuffer(stepPendingDelta)) {
              await flushStepDelta();
            }
          },
          onReasoning: async (reasoning) => {
            if (!reasoning.summary && !reasoning.details) return;
            await emit({
              type: "reasoning",
              round,
              stepId: reasoning.stepId,
              stepLabel: reasoning.stepLabel,
              summary: reasoning.summary,
              details: reasoning.details,
            });
          },
          onUsage: async (usage) => {
            // One agent round is one provider request: its counters are
            // cumulative within the round, and each round is billed on top of
            // the previous one.
            usageRecorder.record(usage, { segment: usageSegment });
            const usageRecord = usage as unknown as Record<string, unknown>;
            const totalTokens = Math.max(0, usage.totalTokens || 0);
            const promptTokens = Math.max(0, usage.promptTokens || 0);
            const completionTokens = Math.max(0, usage.completionTokens || 0);
            attemptInputTokens = Math.max(attemptInputTokens, promptTokens);
            const contextTokens =
              typeof usageRecord.contextTokens === "number" &&
              Number.isFinite(usageRecord.contextTokens)
                ? Math.max(0, usageRecord.contextTokens)
                : undefined;
            const providerContextWindow =
              typeof usageRecord.contextWindow === "number" &&
              Number.isFinite(usageRecord.contextWindow)
                ? Math.max(0, usageRecord.contextWindow)
                : undefined;
            const contextWindow = stepInputLimitIsUserAuthoritative
              ? stepContextWindow
              : providerContextWindow ||
                (typeof contextTokens === "number" && contextTokens > 0
                  ? stepContextWindow
                  : undefined);
            const contextWindowIsAuthoritative =
              !stepInputLimitIsUserAuthoritative &&
              usageRecord.contextWindowIsAuthoritative === true;
            const percentage =
              typeof usageRecord.percentage === "number" &&
              Number.isFinite(usageRecord.percentage)
                ? Math.max(0, Math.min(100, usageRecord.percentage))
                : undefined;
            const sessionId =
              typeof usageRecord.sessionId === "string" &&
              usageRecord.sessionId.trim()
                ? usageRecord.sessionId.trim()
                : undefined;
            const model =
              typeof usageRecord.model === "string" && usageRecord.model.trim()
                ? usageRecord.model.trim()
                : undefined;
            const cacheReadTokens =
              typeof usageRecord.cacheReadTokens === "number" &&
              Number.isFinite(usageRecord.cacheReadTokens)
                ? Math.max(0, usageRecord.cacheReadTokens)
                : undefined;
            const cacheWriteTokens =
              typeof usageRecord.cacheWriteTokens === "number" &&
              Number.isFinite(usageRecord.cacheWriteTokens)
                ? Math.max(0, usageRecord.cacheWriteTokens)
                : undefined;
            const cacheMissTokens =
              typeof usageRecord.cacheMissTokens === "number" &&
              Number.isFinite(usageRecord.cacheMissTokens)
                ? Math.max(0, usageRecord.cacheMissTokens)
                : undefined;
            const cacheHitRatio =
              typeof usageRecord.cacheHitRatio === "number" &&
              Number.isFinite(usageRecord.cacheHitRatio)
                ? Math.max(0, Math.min(1, usageRecord.cacheHitRatio))
                : undefined;
            const cacheProvider =
              typeof usageRecord.cacheProvider === "string" &&
              usageRecord.cacheProvider.trim()
                ? usageRecord.cacheProvider.trim()
                : undefined;
            latestProviderReplayTokens = Math.max(
              latestProviderReplayTokens,
              totalTokens,
              typeof contextTokens === "number" ? contextTokens : 0,
            );
            if (
              totalTokens <= 0 &&
              promptTokens <= 0 &&
              completionTokens <= 0 &&
              !(typeof contextTokens === "number" && contextTokens > 0) &&
              !(typeof contextWindow === "number" && contextWindow > 0)
            ) {
              return;
            }
            await emit({
              type: "usage",
              round,
              promptTokens,
              completionTokens,
              totalTokens,
              ...(typeof contextTokens === "number" ? { contextTokens } : {}),
              ...(typeof contextWindow === "number" ? { contextWindow } : {}),
              ...(contextWindowIsAuthoritative
                ? { contextWindowIsAuthoritative: true }
                : {}),
              ...(typeof percentage === "number" ? { percentage } : {}),
              ...(sessionId ? { sessionId } : {}),
              ...(model ? { model } : {}),
              ...(typeof cacheReadTokens === "number"
                ? { cacheReadTokens }
                : {}),
              ...(typeof cacheWriteTokens === "number"
                ? { cacheWriteTokens }
                : {}),
              ...(typeof cacheMissTokens === "number"
                ? { cacheMissTokens }
                : {}),
              ...(typeof cacheHitRatio === "number" ? { cacheHitRatio } : {}),
              ...(cacheProvider ? { cacheProvider } : {}),
            });
          },
          onToolCall: async (call) => {
            // Native adapters run tools only after a step completes; an
            // adapter that runs them during a step does it here, and a step
            // that failed after one ran is never retried.
            toolCallSeen = true;
            const committedSegment = await settleStepStreamedText();
            const outcome = await toolExecution.executeToolWorkflow(
              call,
              round,
              {
                modelCallId: call.id,
              },
            );
            if (outcome.stopRun) providerTerminalOutcomes.push(outcome);
            newTranscriptMessages.push({
              role: "assistant",
              content: committedSegment,
              tool_calls: [call],
            });
            if (outcome.delivery) {
              newTranscriptMessages.push({
                role: "tool",
                tool_call_id: outcome.delivery.callId,
                name: outcome.delivery.name,
                workCategory: this.registry.getTool(call.name)
                  ? resolveAgentToolCallWorkCategory(
                      this.registry.getTool(call.name)!,
                      call.arguments,
                    )
                  : undefined,
                content: JSON.stringify(outcome.delivery.content ?? {}),
              });
              newTranscriptMessages.push(...outcome.delivery.followupMessages);
            }
            if (
              outcome.stopRun &&
              outcome.finalText &&
              !outcome.preserveToolOnlyTranscript
            ) {
              newTranscriptMessages.push({
                role: "assistant",
                content: outcome.finalText,
              });
            }
            await persistTranscriptCheckpoint();
            return buildAdapterToolCallResult(outcome);
          },
        });
        const step = await attemptRequest
          .catch(async (error: unknown) => {
            // What the attempt streamed is on screen; the caller rolls it
            // back before a retry.
            await flushStepDelta();
            throw new ModelAttemptFailed(error, stepStreamedText, toolCallSeen);
          })
          .finally(() => turnBoundary.recordModelCall(attemptInputTokens));
        continuationSession.commitProviderResponse();
        await flushStepDelta();
        return {
          step,
          stepStreamedText,
        };
      };
      /**
       * The round's model step under the turn's one retry policy
       * (turnBoundary.ts, Rule 4): a network error, a broken stream or an
       * HTTP 429/5xx/529 is sent again after a wait, at most
       * MODEL_STEP_RETRIES times, unless the failed attempt reached a tool
       * call; a prompt the provider calls too long is compacted once. The
       * text a failed attempt streamed is rolled back first.
       */
      const runModelStep = async (
        round: number,
        statusText: string,
      ): Promise<{ step: AgentModelStep; stepStreamedText: string }> => {
        for (let attempt = 0; ; attempt += 1) {
          let result: { step: AgentModelStep; stepStreamedText: string };
          try {
            result = await attemptModelStep(round, statusText, attempt);
          } catch (error) {
            if (!(error instanceof ModelAttemptFailed)) throw error;
            if (params.signal?.aborted) throw error.failure;
            if (
              turnBoundary.finalOnly &&
              !toolChoiceNoneRejected &&
              rejectsToolChoiceNone(error.failure)
            ) {
              // The provider has no tool_choice none: send the step with its
              // default choice; the loop refuses any tool call it returns.
              toolChoiceNoneRejected = true;
              await rollbackCommittedStreamedText(error.streamedText);
              await emit({
                type: "provider_event",
                providerType: "agent_model_retry",
                payload: {
                  round,
                  action: "tool_choice_default",
                  error: redactRunTerminalText(error.message).slice(0, 300),
                },
              });
              continue;
            }
            const decision = turnBoundary.onModelFailure(
              classifyModelFailure(error.failure),
              { toolCallSeen: error.toolCallSeen },
            );
            if (decision.kind === "throw") {
              if (turnBoundary.finalOnly && finalOnlyEmptyAnswerReasked)
                throw new FinalOnlyAnswerUnwritten(error.failure);
              throw error.failure;
            }
            await rollbackCommittedStreamedText(error.streamedText);
            await emit({
              type: "provider_event",
              providerType: "agent_model_retry",
              payload: {
                round,
                action: decision.kind,
                ...(decision.kind === "retry"
                  ? { retry: decision.retry, delayMs: decision.delayMs }
                  : {}),
                ...(decision.kind === "stop" ? { rule: decision.rule } : {}),
                toolCallSeen: error.toolCallSeen,
                error: redactRunTerminalText(error.message).slice(0, 300),
              },
            });
            if (decision.kind === "stop")
              throw new ModelStepAbandoned(decision.rule, error.failure);
            if (decision.kind === "compact") {
              await emit({ type: "status", text: "Compacting context…" });
              await restartFromSemanticCheckpoint({ sourceMessages: messages });
              await emit({
                type: "provider_event",
                providerType: "agent_context_budget",
                payload: { action: "compacted_after_prompt_too_long" },
              });
              continue;
            }
            await emit({
              type: "status",
              text: `Connection to the model failed; retrying (${decision.retry} of ${MODEL_STEP_RETRIES})`,
            });
            await waitUnlessAborted(decision.delayMs, params.signal);
            continue;
          }
          if (
            !(
              result.step.kind === "incomplete" &&
              result.step.reason === "stream_interrupted"
            )
          )
            turnBoundary.modelStepSucceeded();
          return result;
        }
      };
      const requestActionResolution = async (
        action: AgentPendingAction,
      ): Promise<{
        requestId: string;
        resolution: AgentConfirmationResolution;
      }> => {
        const requestId = createConfirmationRequestId();
        const resolution = new Promise<AgentConfirmationResolution>(
          (resolve) => {
            this.pendingConfirmations.set(requestId, { resolve });
          },
        );
        await emit({
          type: "confirmation_required",
          requestId,
          action,
        });
        // Time spent waiting on the user is not the turn's own.
        const waitStarted = this.now();
        const settled = await resolution;
        turnBoundary.excludeWait(this.now() - waitStarted);
        await emit({
          type: "confirmation_resolved",
          requestId,
          approved: settled.approved,
          actionId: settled.actionId,
          data: settled.data,
        });
        return {
          requestId,
          resolution: settled,
        };
      };
      // Tool execution is its own collaborator, built once per turn with the
      // state its three functions used to reach through this method's
      // closure.
      const toolExecution = createToolExecution({
        registry: this.registry,
        now: this.now,
        signal: params.signal,
        emit,
        request,
        runId,
        context,
        writeAllowed,
        adapterCapabilities,
        actionContractSession,
        paperEvidenceFrontier,
        resourceContextPlan,
        persistToolResultHandles,
        requestActionResolution,
        finalizedMaterialRefs,
        pendingReadActivities,
        preservedTurnHandleRecords,
        toolExecutionRecords,
        toolsUsedThisTurn,
        getCurrentAnswerText: () => currentAnswerText,
        setFinalizedMaterial: (material) => {
          finalizedMaterial = material;
        },
        setToolResultReadAvailable: (available) => {
          toolResultReadAvailable = available;
        },
        recordOutcomeEvidence: recordsOutcomes()
          ? recordOutcomeEvidence
          : undefined,
      });
      let operationSequence = 0;
      context.invokeRegisteredOperation = async (name, args) => {
        const tool = this.registry.getTool(name);
        if (
          !tool ||
          tool.spec.executionClass === "control" ||
          name === "zotero_script" ||
          tool.spec.exposure === "internal" ||
          tool.isAvailable?.(request) === false ||
          isToolWithheldForEphemeralRequest(tool, request)
        )
          throw new Error("Unknown or unavailable registered operation.");
        const outcome = await toolExecution.executeToolWorkflow(
          {
            id: `workflow-script:${runId}:${++operationSequence}`,
            name,
            arguments: args,
          },
          0,
          { suppressModelDelivery: true },
        );
        return outcome.toolResult;
      };
      // A final answer the provider cut off at its output limit stays on
      // screen and in the transcript; the model is asked for the remainder.
      let answerContinuations = 0;
      // How many times a cut-off answer may continue: as many full-size
      // answers as the input budget holds beside the prompt it started from.
      let answerContinuationLimit: number | undefined;
      /** Handles to the tool results in `source`, by call, and their records. */
      const toolResultHandlesOf = (source: readonly AgentModelMessage[]) => {
        const handles = new Map<string, string>();
        const records: AgentToolResultHandleRecord[] = [];
        for (const message of source) {
          if (message.role !== "tool") continue;
          let content: unknown = message.content;
          try {
            content = JSON.parse(message.content);
          } catch {
            // A result that is not JSON is stored as written.
          }
          const record = createAgentToolResultHandleRecord({
            conversationKey: request.conversationKey,
            toolName: message.name,
            toolCallId: message.tool_call_id,
            resourceSignature: resourceContextPlan.resourceSignature,
            content,
            createdAt: this.now(),
          });
          if (!record) continue;
          handles.set(message.tool_call_id, record.handle);
          records.push(record);
        }
        return { handles, records };
      };
      // The papers this turn's records hold, and the share the last page's
      // digests were cut to.
      const recordedPapers = new Set<string>();
      let lastDigestShare = 0;
      /**
       * One batch of per-paper results as the transcript keeps it, under a
       * handle that holds the digests themselves and the job they belong to,
       * so a job "continue" picks back up carries them forward.
       */
      const recordLongJobResults = async (
        digests: readonly PaperDigest[],
      ): Promise<AgentUserMessage> => {
        longJobRecords += 1;
        const recordText = renderLongJobRecord(
          longJobRecords,
          renderPaperDigests(digests),
        );
        const record = createAgentToolResultHandleRecord({
          conversationKey: request.conversationKey,
          toolName: "long_job_results",
          toolCallId: `${runId}:results-${longJobRecords}`,
          resourceSignature: resourceContextPlan.resourceSignature,
          content: {
            itemIds: digests.map((digest) => digest.itemId),
            results: recordText,
            executionId: request.executionCheckpoint?.executionId,
            digests,
          },
          createdAt: this.now(),
        });
        if (record) await persistToolResultHandles([record]);
        for (const digest of digests)
          recordedPapers.add(`item:${digest.itemId}`);
        return {
          role: "user",
          retainedTool: {
            name: "long_job_results",
            callId: `${runId}:results-${longJobRecords}`,
            ...(record ? { handle: record.handle } : {}),
            category: "retrieval",
          },
          content: recordText,
        };
      };
      /**
       * Stop, or an error, ends a long job wherever it stands, often inside a
       * page. The papers that page had read keep their results: recorded as
       * a page's are, under a handle "continue" finds by the job, and
       * straight into the stored transcript (the turn's own unfinished
       * messages are not kept), unless a turn queued behind Stop wrote it
       * first.
       */
      recordUnfinishedPage = async (): Promise<void> => {
        if (!recordsOutcomes()) return;
        const papers = new Set(
          (request.executionCheckpoint?.tasks || []).flatMap((task) =>
            task.origin === "model"
              ? (task.targets || []).filter((target) =>
                  target.startsWith("item:"),
                )
              : [],
          ),
        );
        if (!papers.size) return;
        const evidence = collectPaperEvidence(messages);
        const itemOf = (target: string) => Number(target.replace(/^item:/, ""));
        const unrecorded = [...papers].filter(
          (target) =>
            evidence.has(itemOf(target)) &&
            !recordedPapers.has(target) &&
            !carriedDigests.has(target),
        );
        if (!unrecorded.length) return;
        const share = Math.max(
          1,
          lastDigestShare ||
            Math.floor(providerReplaySoftLimit / (2 * papers.size)),
        );
        const { handles, records } = toolResultHandlesOf(messages);
        await persistToolResultHandles(records);
        const digests = unrecorded.map((target) => {
          const found = evidence.get(itemOf(target))!;
          return buildPaperDigest(
            itemOf(target),
            { ...found, title: found.title || scopePaper(target)?.title },
            found.calls.flatMap((call) => {
              const handle = handles.get(call.callId);
              return handle ? [handle] : [];
            }),
            share,
          );
        });
        const portable = buildPortableAgentTranscript({
          messages: [
            ...transcriptSegment.messages,
            await recordLongJobResults(digests),
          ],
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        await persistToolResultHandles(portable.handleRecords);
        const next = { ...transcriptSegment, messages: portable.messages };
        // The digests are stored above whatever this write does: a turn
        // queued behind Stop that wrote the transcript first keeps its
        // messages, and "continue" still finds the results by the job.
        const written = await writeTranscriptSegment(next);
        if (written === "persisted" || written === "memory_only")
          transcriptSegment = next;
      };
      /**
       * After a tool round: page the turn's long job. When a page ends, the
       * reads of the job's papers become per-paper digests (each within its
       * share of the input budget, with handles to the full results), the
       * provider session restarts from a checkpoint that carries every digest
       * and the next page, and the page's digests are persisted with the
       * transcript, so they outlive the turn.
       */
      const advanceLongJob = async (): Promise<void> => {
        if (!recordsOutcomes()) return;
        const budgetTokens = providerReplaySoftLimit;
        const roundReads = turnReads
          .slice(longJobReadsSeen)
          .flatMap((read) =>
            read.kind === "read"
              ? [
                  ...read.targets,
                  ...(read.shallow || []),
                  ...(read.noText || []),
                ]
              : [],
          );
        longJobReadsSeen = turnReads.length;
        const boundary = longJob.check({
          checkpoint: request.executionCheckpoint,
          promptTokens: estimateContextMessagesTokens(messages),
          budgetTokens,
          requests: round,
          reads: roundReads,
          gaveUp: longJobGaveUp,
        });
        longJobGaveUp = [];
        if (!boundary) return;
        const job = readLongJob(request.executionCheckpoint, longJob.following);
        if (!job) return;
        // Every job paper whose reads are in this prompt, and every settled
        // one without a digest yet (a paper with no text).
        const evidence = collectPaperEvidence(messages);
        const itemOf = (target: string) => Number(target.replace(/^item:/, ""));
        const toDigest = job.targets.filter(
          (target) =>
            evidence.has(itemOf(target)) || boundary.digest.includes(target),
        );
        const digested: PaperDigest[] = [];
        let digestShare = 0;
        if (toDigest.length) {
          // Handles to the results the restart drops, for the checkpoint and
          // for each digest.
          const { handles, records: handleRecords } =
            toolResultHandlesOf(messages);
          // Restart first, without the job's message, so the digests share
          // and the next page is planned from the prompt the page will
          // start from, not from the checkpoint's budget.
          longJobMessage = null;
          await restartFromSemanticCheckpoint({
            sourceMessages: messages,
            handleRecords,
          });
          // The job's results take at most half of what the restarted
          // prompt leaves, so every page keeps the other half to read in.
          digestShare = longJob.digestShare(job, {
            promptTokens: estimateContextMessagesTokens(messages),
            budgetTokens,
          });
          lastDigestShare = digestShare;
          for (const target of toDigest) {
            const found = evidence.get(itemOf(target));
            const earlier = longJobDigests.get(target);
            const excerpts = [
              ...(earlier?.excerpts || []),
              ...(found?.excerpts || []).filter(
                (excerpt) =>
                  !earlier?.excerpts.some(
                    (known) =>
                      known.text === excerpt.text &&
                      known.section === excerpt.section,
                  ),
              ),
            ];
            const digest = buildPaperDigest(
              itemOf(target),
              {
                title:
                  found?.title || earlier?.title || scopePaper(target)?.title,
                excerpts,
                noText:
                  Boolean(found?.noText || earlier?.noText) && !excerpts.length,
                calls: found?.calls || [],
              },
              [
                ...new Set([
                  ...(earlier?.handles || []),
                  ...(found?.calls || []).flatMap((call) => {
                    const handle = handles.get(call.callId);
                    return handle ? [handle] : [];
                  }),
                ]),
              ],
              digestShare,
            );
            longJobDigests.set(target, digest);
            // A carried paper is in the transcript already: recorded again
            // only when this turn read it.
            if (found || !carriedDigests.has(target)) digested.push(digest);
          }
        }
        const results = renderPaperDigests(
          job.targets.flatMap((target) => {
            const digest = longJobDigests.get(target);
            return digest ? [digest] : [];
          }),
        );
        const render = (
          next: Parameters<typeof renderLongJobMessage>[0]["next"],
        ) =>
          renderLongJobMessage({
            checkpoint: request.executionCheckpoint,
            partIds: longJob.following,
            results,
            next,
            titleOf: (target) =>
              scopePaper(target)?.title || longJobDigests.get(target)?.title,
            noTextReason: OUTCOME_REASONS.noText,
          });
        // The page starts from the prompt as it stands plus the job's message.
        const next = longJob.plan({
          checkpoint: request.executionCheckpoint,
          promptTokens: estimateContextMessagesTokens([
            ...messages,
            { role: "user", content: render({ complete: true }) },
          ]),
          budgetTokens,
          requests: round,
        });
        longJobReadShare = "complete" in next ? 0 : next.readShare;
        longJobMessage = {
          role: "user",
          transient: true,
          content: render(next),
        };
        await emit({
          type: "provider_event",
          providerType: "agent_long_job_page",
          payload:
            "complete" in next
              ? {
                  complete: true,
                  papers: job.targets.length,
                  digested: digested.length,
                }
              : {
                  page: next.number,
                  papers: next.targets.length,
                  left: next.left,
                  costPerPaper: next.costPerPaper,
                  measured: next.measured,
                  room: next.room,
                  budgetTokens: next.budgetTokens,
                  promptTokens: next.promptTokens,
                  fitBound: next.fitBound,
                  costBound: next.costBound,
                  papersPerRequest: next.papersPerRequest,
                  requestsPerPage: next.requestsPerPage,
                  readsPerPage: next.readsPerPage,
                  digested: digested.length,
                  digestShare,
                  readShare: next.readShare,
                },
        });
        continuationSession.appendHostMessage(longJobMessage);
        if (!digested.length) return;
        // The page's per-paper results outlive the turn: Stop, a restart of
        // Zotero and "continue" find them in the transcript, and a handle
        // keeps them readable once older history is compacted.
        newTranscriptMessages.push(await recordLongJobResults(digested));
        await persistTranscriptCheckpoint();
      };
      let round = 0;
      let segment = 1;
      // A final-only step that still called tools is re-asked once.
      let finalOnlyToolCallRejected = false;
      // What the status says each round: the round, or the long job's page
      // and its progress. A segment is the span of the incomplete-step and
      // tool-overflow limits and a durable checkpoint, not a cap.
      const roundStatus = (): string => {
        const page = recordsOutcomes()
          ? longJob.openPage(request.executionCheckpoint)
          : null;
        return page
          ? `Continuing agent (page ${page.number} · ${page.settled} of ${page.total})`
          : `Continuing agent (round ${round})`;
      };
      /**
       * The answer of a turn a resumable incident stopped: what the model
       * had streamed, then why it stopped and what it did.
       */
      const stoppedTurnText = (
        rule: "budget_reached" | "connection_lost" | "prompt_budget_exceeded",
        detail?: string,
      ): string => {
        const streamed = uncommittedAnswerText().trim();
        const text = renderStoppedTurnText({
          rule,
          calls: toolExecutionRecords,
          parts: partsProgress(),
          usage: turnBoundary.usage(this.now()),
          detail,
        });
        return streamed ? `${streamed}\n\n${text}` : text;
      };
      /** Ends a final-only step whose answer still could not be written. */
      const endSearchExhausted = async (
        text: string,
      ): Promise<AgentRuntimeOutcome> => {
        if (recordsOutcomes() && request.executionCheckpoint)
          await updateExecutionCheckpoint((checkpoint) =>
            closeOpenOutcomes(checkpoint, SEARCH_EXHAUSTED_REASON, this.now()),
          );
        return await completeRun(text, "completed", "search_exhausted");
      };
      /**
       * Before a resumable stop ends the turn: a long job's open page keeps
       * the results it read, as on Stop, so "continue" finds them.
       */
      const keepUnfinishedPage = (): Promise<void> =>
        (recordUnfinishedPage?.() ?? Promise.resolve()).catch((error) =>
          logRuntimeWarning(
            "LLM Agent: recording a stopped page's results failed",
            error,
          ),
        );
      while (true) {
        for (
          let segmentRound = 1;
          segmentRound <= maxRounds;
          segmentRound += 1
        ) {
          round += 1;
          // A round that called no tool is published as such once the next
          // one starts.
          if (round > 1 && lastClassifiedRound < round - 1)
            await publishRoundProgress(turnBoundary.noToolRound(round - 1));
          // Rule 3: a per-turn safety limit stops the turn, resumable.
          if (
            !params.signal?.aborted &&
            turnBoundary.beforeModelCall({
              now: this.now(),
              settledTargets: settledTargetCount(request.executionCheckpoint),
            }).kind === "stop"
          ) {
            await persistTranscriptCheckpoint();
            await keepUnfinishedPage();
            return await completeRun(
              stoppedTurnText("budget_reached"),
              "failed",
              "budget_reached",
            );
          }
          let stepResult: { step: AgentModelStep; stepStreamedText: string };
          try {
            stepResult = await runModelStep(
              round,
              round === 1 ? "Running agent" : roundStatus(),
            );
          } catch (err) {
            if (err instanceof StoppedBeforeStep)
              return {
                kind: "cancelled",
                runId,
                ...(err.text ? { text: err.text } : {}),
              };
            if (err instanceof AgentPromptBudgetError) {
              return await completeRun(
                err.message,
                "failed",
                "prompt_budget_exceeded",
              );
            }
            if (err instanceof FinalOnlyAnswerUnwritten)
              return await endSearchExhausted(
                renderSearchExhaustedFallback(
                  buildSearchRecord(toolExecutionRecords),
                  searchScope,
                ),
              );
            if (err instanceof ModelStepAbandoned) {
              await persistTranscriptCheckpoint();
              await keepUnfinishedPage();
              return err.rule === "connection_lost"
                ? await completeRun(
                    stoppedTurnText(
                      "connection_lost",
                      redactRunTerminalText(err.message).slice(0, 200),
                    ),
                    "failed",
                    "connection_lost",
                  )
                : await completeRun(
                    stoppedTurnText("prompt_budget_exceeded"),
                    "failed",
                    "prompt_budget_exceeded",
                  );
            }
            throw err;
          }
          const { step, stepStreamedText } = stepResult;
          const terminalOutcome = providerTerminalOutcomes.shift();
          if (terminalOutcome) {
            if (
              !terminalOutcome.failed &&
              terminalOutcome.documentId &&
              recordsOutcomes()
            )
              await recordOutcomeEvidence({
                kind: "answer",
                citedTargets: answerCitedTargets(
                  `${committedAnswerText}${terminalOutcome.finalText || uncommittedAnswerText()}`,
                  { document: true },
                ),
              });
            return await completeRun(
              terminalOutcome.finalText || uncommittedAnswerText(),
              terminalOutcome.failed ? "failed" : "completed",
              "provider_terminal_outcome",
              { documentId: terminalOutcome.documentId },
            );
          }
          if (step.kind === "incomplete") {
            const truncatedAnswerText = step.text || "";
            if (
              step.reason === "output_limit" &&
              truncatedAnswerText.trim().length > 0
            ) {
              // The model was writing its answer, not a tool call: keep what
              // it wrote visible and ask only for the remainder.
              const addsText = addsNewAnswerText(
                truncatedAnswerText,
                keptAnswerModelText,
              );
              answerContinuationLimit ??= answerContinuationCeiling({
                budgetTokens: providerReplaySoftLimit,
                promptTokens: estimateContextMessagesTokens(messages),
                outputTokens: resolveOutputReserve(
                  request.advanced?.outputTokenLimit,
                  request.model || "",
                  {
                    apiBase: request.apiBase,
                    protocol: request.providerProtocol,
                    authMode: request.authMode,
                    profileOverride: request.advanced?.profileOverride,
                  },
                ),
              });
              if (stepStreamedText) {
                keptAnswerVisibleText += stepStreamedText;
              } else {
                const visible =
                  turnPathRedactor.redactTerminalText(truncatedAnswerText);
                currentAnswerText += visible;
                keptAnswerVisibleText += visible;
                await emit({ type: "message_delta", text: visible });
              }
              keptAnswerModelText += truncatedAnswerText;
              const truncatedAssistantMessage: AgentAssistantMessage =
                step.assistantMessage || {
                  role: "assistant",
                  content: truncatedAnswerText,
                };
              if (
                !addsText ||
                answerContinuations >= answerContinuationLimit ||
                turnBoundary.incompleteStepsExhausted(segmentRound)
              ) {
                newTranscriptMessages.push(truncatedAssistantMessage);
                const customLimit = request.advanced?.outputTokenLimit;
                const note =
                  customLimit?.mode === "custom"
                    ? `\n\n[This answer was cut short by the custom per-response output limit (${customLimit.tokens} tokens) ${answerContinuations + 1} times. Raise the limit in Advanced settings, or ask to continue.]`
                    : `\n\n[This answer was cut short by the provider's output limit ${answerContinuations + 1} times. Ask to continue if it is incomplete.]`;
                return await completeRun(
                  `${turnPathRedactor.redactTerminalText(keptAnswerModelText)}${note}`,
                  "completed",
                  "answer_continuation_limit",
                );
              }
              answerContinuations += 1;
              (
                globalThis as typeof globalThis & {
                  ztoolkit?: { log?: (...args: unknown[]) => void };
                }
              ).ztoolkit?.log?.(
                "LLM Agent: Continuing a truncated final answer",
                {
                  settingMode:
                    request.advanced?.outputTokenLimit?.mode || "auto",
                  providerStopReason: step.providerReason,
                  continuation: answerContinuations,
                  keptCharacters: keptAnswerModelText.length,
                },
              );
              newTranscriptMessages.push(
                ...continuationSession.appendFinalCorrection({
                  assistantMessage: truncatedAssistantMessage,
                  correctionMessage: {
                    role: "user",
                    content: buildAnswerContinuationInstruction(),
                  },
                }),
              );
              await persistTranscriptCheckpoint();
              continue;
            }
            if (step.reason === "stream_interrupted") {
              // The adapter kept the broken step and asks for it again: the
              // same retry policy as a thrown failure (turnBoundary.ts, Rule
              // 4), so retries do not stack.
              const decision = turnBoundary.onModelFailure(
                { kind: "transient", cause: "stream" },
                { toolCallSeen: false },
              );
              if (decision.kind !== "retry") {
                await rollbackCommittedStreamedText(stepStreamedText);
                await persistTranscriptCheckpoint();
                await keepUnfinishedPage();
                return await completeRun(
                  stoppedTurnText(
                    "connection_lost",
                    "the response stream broke",
                  ),
                  "failed",
                  "connection_lost",
                );
              }
              await emit({
                type: "status",
                text: `Response stream interrupted; retrying the unfinished step (${decision.retry} of ${MODEL_STEP_RETRIES})`,
              });
              await waitUnlessAborted(decision.delayMs, params.signal);
            }
            (
              globalThis as typeof globalThis & {
                ztoolkit?: { log?: (...args: unknown[]) => void };
              }
            ).ztoolkit?.log?.("LLM Agent: Recovering incomplete model step", {
              settingMode: request.advanced?.outputTokenLimit?.mode || "auto",
              incompleteReason: step.reason,
              providerStopReason: step.providerReason,
              recoveryCount: segmentRound,
            });
            await rollbackCommittedStreamedText(stepStreamedText);
            if (turnBoundary.incompleteStepsExhausted(segmentRound)) {
              const customLimit = request.advanced?.outputTokenLimit;
              const exhaustionMessage =
                step.reason === "stream_interrupted"
                  ? "The response stream was interrupted at the model-step limit. Durable Plan progress was preserved; continue to resume the unfinished step."
                  : step.reason === "provider_pause"
                    ? "The provider repeatedly paused before completing the required structured step. Durable Plan progress was preserved; continue the plan to resume from the pending work unit."
                    : customLimit?.mode === "custom"
                      ? `The custom per-response output limit (${customLimit.tokens} tokens) repeatedly prevented the model from completing the required structured step. Raise the limit in Advanced settings, then continue; durable Plan progress was preserved.`
                      : "The provider repeatedly reached its output limit before completing the required structured step. Durable Plan progress was preserved; continue the plan to resume from the pending work unit.";
              return await completeRun(
                exhaustionMessage,
                "failed",
                "incomplete_step_limit",
              );
            }
            const assistantMessage: AgentAssistantMessage =
              step.assistantMessage || {
                role: "assistant",
                content: step.text,
              };
            newTranscriptMessages.push(
              ...continuationSession.appendFinalCorrection({
                assistantMessage,
                correctionMessage: {
                  role: "user",
                  content: step.recoveryInstruction,
                },
              }),
            );
            await persistTranscriptCheckpoint();
            continue;
          }
          // A final-only step that wrote no visible text (an empty answer,
          // or thinking only) is asked once more with the instruction; a
          // second time, the host writes the answer from its record. The
          // turn never ends with an empty answer.
          if (
            step.kind === "final" &&
            turnBoundary.finalOnly &&
            !(step.text || "").trim() &&
            !stepStreamedText.trim() &&
            !keptAnswerModelText.trim() &&
            !committedAnswerText.trim()
          ) {
            const search = buildSearchRecord(toolExecutionRecords);
            if (finalOnlyEmptyAnswerReasked)
              return await endSearchExhausted(
                renderSearchExhaustedFallback(search, searchScope),
              );
            finalOnlyEmptyAnswerReasked = true;
            // No empty assistant message is kept: the instruction follows
            // as a host message (a provider rejects an empty assistant turn).
            continuationSession.appendHostMessage({
              role: "user",
              transient: true,
              content: `Your last reply had no answer text. ${renderFinalOnlyInstruction(search, searchScope)}`,
            });
            await persistTranscriptCheckpoint();
            continue;
          }
          if (step.kind === "final") {
            const returnedText = step.text || "";
            const streamedTextOffset = stepStreamedText
              ? returnedText.indexOf(stepStreamedText)
              : -1;
            const rawModelFinalText = stepStreamedText
              ? streamedTextOffset >= 0
                ? returnedText.slice(streamedTextOffset)
                : stepStreamedText
              : keptAnswerModelText
                ? // A kept truncated answer already holds the visible text;
                  // falling back to it (or a placeholder) would corrupt it.
                  returnedText
                : returnedText || currentAnswerText || "No response.";
            const finalOnly = turnBoundary.finalOnly;
            const finalDecision = await finalAnswerController.evaluate({
              candidateText: turnPathRedactor.redactTerminalText(
                `${keptAnswerModelText}${rawModelFinalText}`,
              ),
              canCorrect: segmentRound < maxRounds,
              toolExecutionRecords,
              finalOnly,
            });
            if (finalDecision.kind !== "accept") {
              await rollbackCommittedStreamedText(stepStreamedText);
              await rollbackKeptAnswer();
              if (finalDecision.kind === "correct") {
                const assistantCorrectionMessage: AgentAssistantMessage = {
                  ...(step.assistantMessage ?? {
                    role: "assistant" as const,
                    content: step.text || stepStreamedText,
                  }),
                };
                const userCorrectionMessage: AgentUserMessage = {
                  role: "user",
                  content: finalDecision.correction,
                };
                continuationSession.appendFinalCorrection({
                  assistantMessage: assistantCorrectionMessage,
                  correctionMessage: userCorrectionMessage,
                });
                await persistTranscriptCheckpoint();
                continue;
              }
              return await completeRun(
                finalDecision.userMessage,
                "failed",
                "final_gate_rejected",
              );
            }
            const answerPrefix = keptAnswerVisibleText;
            const acceptedAnswerText = `${committedAnswerText}${keptAnswerModelText}${rawModelFinalText}`;
            keptAnswerVisibleText = "";
            keptAnswerModelText = "";
            if (recordsOutcomes())
              await recordOutcomeEvidence({
                kind: "answer",
                citedTargets: answerCitedTargets(acceptedAnswerText),
              });
            // An answer written without tools after the search ran out
            // closes the parts it can no longer do (turnBoundary.ts, Rule 2).
            if (finalOnly && recordsOutcomes() && request.executionCheckpoint)
              await updateExecutionCheckpoint((checkpoint) =>
                closeOpenOutcomes(
                  checkpoint,
                  SEARCH_EXHAUSTED_REASON,
                  this.now(),
                ),
              );
            return await emitFinalStep(
              step,
              `${answerPrefix}${stepStreamedText}`,
              finalDecision.webAttribution,
              {
                transcriptPrefix: answerPrefix,
                stopRule: finalOnly ? "search_exhausted" : "final_answer",
              },
            );
          }

          // A final-only step asked for no tools (turnBoundary.ts, Rule 2).
          // A provider without that control may still call some: none runs,
          // each gets a result saying so, and the step is asked once more;
          // a second time, the host writes the answer from its record.
          if (turnBoundary.finalOnly && step.calls.length) {
            await rollbackCommittedStreamedText(stepStreamedText);
            if (finalOnlyToolCallRejected)
              return await endSearchExhausted(
                renderSearchExhaustedFallback(
                  buildSearchRecord(toolExecutionRecords),
                  searchScope,
                ),
              );
            finalOnlyToolCallRejected = true;
            continuationSession.beginToolStep(step.assistantMessage);
            newTranscriptMessages.push(step.assistantMessage);
            const refusals: AgentToolMessage[] = step.calls.map((call) => ({
              role: "tool",
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify({
                error:
                  "Not run: this step is for the answer, without tools. Answer now from what you have.",
              }),
            }));
            newTranscriptMessages.push(
              ...continuationSession.completeToolStep({
                toolMessages: refusals,
                followupMessages: [],
              }),
            );
            await persistTranscriptCheckpoint();
            continue;
          }

          // The step returned tool_calls, not a final answer.  A lead-in the
          // model streamed during this step ("Let me read more of the
          // paper...") belongs in the agent trace, not the chat answer, and is
          // rolled back; deliverable content (per-paper summaries) stays and
          // starts the answer.
          await settleStreamedTextBeforeTools(stepStreamedText);

          // Item-scoped work may read a page's open papers in one step; an
          // ordinary step keeps the ordinary limit.
          const stepToolCallLimit = recordsOutcomes()
            ? longJob.stepLimit(
                {
                  checkpoint: request.executionCheckpoint,
                  promptTokens: estimateContextMessagesTokens(messages),
                  budgetTokens: providerReplaySoftLimit,
                },
                maxToolCallsPerRound,
              )
            : maxToolCallsPerRound;
          if (step.calls.length > stepToolCallLimit) {
            const overflowMessage = `The model returned ${step.calls.length} tool calls in one step, exceeding the safe limit of ${stepToolCallLimit}. None of those calls were executed.`;
            if (turnBoundary.toolCallOverflow(segmentRound) === "stop") {
              return await completeRun(
                `${overflowMessage} Please narrow the request and try again.`,
                "failed",
                "tool_call_overflow",
              );
            }
            await restartFromSemanticCheckpoint({
              sourceMessages: messages,
              retryInstruction: `${overflowMessage} Retry with a complete new step containing at most ${stepToolCallLimit} tool calls. Do not assume that any result exists for the rejected calls.`,
            });
            await emit({
              type: "provider_event",
              providerType: "agent_tool_call_overflow",
              payload: {
                action: "checkpoint_and_retry",
                returnedToolCalls: step.calls.length,
                maxToolCallsPerRound: stepToolCallLimit,
              },
            });
            continue;
          }

          const calls = step.calls;
          const assistantToolMessage: AgentAssistantMessage =
            step.assistantMessage;
          if (!calls.length) {
            // A tool step that names no call ends the segment, as before;
            // it counts as a tool round without progress.
            const { decision, report } = turnBoundary.afterToolRound({
              round,
              calls: [],
              settledTargets: settledTargetCount(request.executionCheckpoint),
              now: this.now(),
            });
            await publishRoundProgress(report);
            if (decision.kind === "stop")
              return await completeRun(
                uncommittedAnswerText() ||
                  `Agent stopped after ${maxRounds} tool rounds produced no new successful tool result. The completed transcript was saved; narrow or redirect the request before continuing.`,
                "failed",
                "segment_without_progress",
              );
            break;
          }
          const roundRecordStart = toolExecutionRecords.length;
          continuationSession.beginToolStep(assistantToolMessage);
          newTranscriptMessages.push(assistantToolMessage);
          const roundToolMessages: AgentToolMessage[] = [];
          const roundFollowupMessages: AgentModelMessage[] = [];
          const appendRoundContinuation = () => {
            const delta = continuationSession.completeToolStep({
              toolMessages: roundToolMessages,
              followupMessages: roundFollowupMessages,
            });
            newTranscriptMessages.push(...delta);
          };
          let roundHadSuccessfulToolResult = false;
          let roundHadToolFailure = false;
          let roundHadInputRejection = false;
          // Papers of the turn's job a call failed on: their failures are the
          // papers', not the run's, and do not count as repeated tool errors.
          const givenUp = new Map<string, string[]>();
          const jobPapers = recordsOutcomes()
            ? new Set(
                readLongJob(request.executionCheckpoint, longJob.following)
                  ?.notDone || [],
              )
            : new Set<string>();
          const doneBeforeRound = settledTargetCount(
            request.executionCheckpoint,
          );
          for (const [index, call] of calls.entries()) {
            const outcome = await toolExecution.executeToolWorkflow(
              call,
              round,
              {
                modelCallId: call.id,
                followingCallCount: calls.length - index - 1,
              },
            );
            if (outcome.toolResult.ok) roundHadSuccessfulToolResult = true;
            else if (outcome.toolResult.inputRejected)
              roundHadInputRejection = true;
            else if (
              // A call Stop kept from starting failed at nothing.
              !outcome.notStarted &&
              !isUserDeniedToolResult(outcome.toolResult)
            ) {
              const papers = namedItemTargets(call.arguments).filter((target) =>
                jobPapers.has(target),
              );
              if (!papers.length) roundHadToolFailure = true;
              const reason = toolFailureReason(outcome.toolResult.content);
              for (const target of papers) {
                if (turnBoundary.recordPaperFailure(target, reason))
                  givenUp.set(reason, [...(givenUp.get(reason) || []), target]);
              }
            }
            if (outcome.delivery) {
              const toolMessage: AgentToolMessage = {
                role: "tool",
                tool_call_id: outcome.delivery.callId,
                name: outcome.delivery.name,
                workCategory: this.registry.getTool(call.name)
                  ? resolveAgentToolCallWorkCategory(
                      this.registry.getTool(call.name)!,
                      call.arguments,
                    )
                  : undefined,
                content: JSON.stringify(outcome.delivery.content ?? {}),
              };
              roundToolMessages.push(toolMessage);
              for (const followupMessage of outcome.delivery.followupMessages) {
                roundFollowupMessages.push(followupMessage);
              }
            }
            if (outcome.stopRun) {
              appendRoundContinuation();
              const stopFinalText =
                outcome.finalText || uncommittedAnswerText();
              if (stopFinalText && !outcome.preserveToolOnlyTranscript) {
                newTranscriptMessages.push({
                  role: "assistant",
                  content: stopFinalText,
                });
              }
              await persistTranscriptCheckpoint();
              // A finalized document that ends the turn is its answer.
              if (!outcome.failed && outcome.documentId && recordsOutcomes())
                await recordOutcomeEvidence({
                  kind: "answer",
                  citedTargets: answerCitedTargets(
                    `${committedAnswerText}${stopFinalText}`,
                    { document: true },
                  ),
                });
              return await completeRun(
                stopFinalText,
                outcome.failed ? "failed" : "completed",
                outcome.failed ? "tool_action_failed" : "terminal_tool",
                {
                  documentId: outcome.documentId,
                },
              );
            }
          }
          appendRoundContinuation();
          // Sibling calls are one attempt: deliver every result before judging
          // repeated failure, so the next model round can repair their inputs.
          const repeatedFailure = turnBoundary.recordToolRoundOutcome({
            hadSuccessfulResult: roundHadSuccessfulToolResult,
            hadToolFailure: roundHadToolFailure,
            hadInputRejection: roundHadInputRejection,
          });
          if (givenUp.size) {
            for (const [reason, targets] of givenUp)
              await recordOutcomeEvidence({ kind: "failed", targets, reason });
          }
          longJobGaveUp = [...givenUp.values()].flat();
          if (recordsOutcomes()) {
            const given = longJobGaveUp.length;
            const doneThisRound =
              settledTargetCount(request.executionCheckpoint) -
              doneBeforeRound -
              given;
            const failedInARow = turnBoundary.recordPapersGivenUp({
              doneThisRound,
              givenUp: given,
              pageSize: () => {
                const page = longJob.openPage(request.executionCheckpoint);
                return page ? page.targets.length : jobPapers.size;
              },
            });
            // A page's worth of papers failed in a row: something beyond one
            // paper is wrong. The job stops where it is, resumable.
            if (failedInARow !== undefined) {
              await persistTranscriptCheckpoint();
              const [reason] = [...givenUp.keys()];
              return await completeRun(
                `Stopped: the last ${failedInARow} papers in a row failed (${reason}). The job's progress is saved; say "continue" to go on with the papers left.`,
                "failed",
                "page_failed",
              );
            }
          }
          if (repeatedFailure) {
            await persistTranscriptCheckpoint();
            const stopRule: RunStopRule =
              repeatedFailure === "repeated_input_rejections"
                ? "repeated_input_rejections"
                : "repeated_tool_errors";
            const finalText =
              uncommittedAnswerText() ||
              (stopRule === "repeated_input_rejections"
                ? "Agent stopped after repeated invalid tool inputs. Please adjust the request and try again."
                : "Agent stopped after repeated tool errors. Please adjust the request and try again.");
            return await completeRun(finalText, "failed", stopRule);
          }
          await persistTranscriptCheckpoint();
          // A stopped run advances no page: its next step ends it, and
          // records what the open page had read.
          if (!params.signal?.aborted) await advanceLongJob();
          // Rules 1 and 2 (turnBoundary.ts): classify the round, then go
          // on, show the search checkpoint, ask for the answer without
          // tools, or stop after a segment of tool rounds without progress.
          const { decision, report } = turnBoundary.afterToolRound({
            round,
            calls: toolExecutionRecords.slice(roundRecordStart),
            settledTargets: settledTargetCount(request.executionCheckpoint),
            now: this.now(),
          });
          await publishRoundProgress(report);
          if (decision.kind === "stop") {
            const finalText =
              uncommittedAnswerText() ||
              `Agent stopped after ${maxRounds} tool rounds produced no new successful tool result. The completed transcript was saved; narrow or redirect the request before continuing.`;
            return await completeRun(
              finalText,
              "failed",
              "segment_without_progress",
            );
          }
          if (
            decision.kind === "checkpoint" ||
            decision.kind === "final_only"
          ) {
            const search = buildSearchRecord(toolExecutionRecords);
            continuationSession.appendHostMessage({
              role: "user",
              transient: true,
              content:
                decision.kind === "checkpoint"
                  ? renderSearchCheckpoint(search, searchScope)
                  : renderFinalOnlyInstruction(search, searchScope),
            });
            await emit({
              type: "provider_event",
              providerType: "agent_search_boundary",
              payload: {
                round,
                action: decision.kind,
                queries: search.queries.length,
                listed: search.listed.length,
                read: search.read.length,
                metadataLookups: search.metadataLookups,
              },
            });
          }
        }

        // This is the durable continuation boundary. If Zotero or the model
        // process exits later, the next turn can continue from the complete
        // tool-call/result pairs checkpointed here instead of starting blind.
        await persistTranscriptCheckpoint();
        await emit({
          type: "status",
          text: `Checkpointed agent segment ${segment}; continuing`,
        });
        segment += 1;
      }
    } catch (error) {
      // An error before the run started, or while it was being ended, is
      // not an ending of the run: it is thrown.
      if (!webSourceRunId || runTerminating) throw error;
      const message = redactRunTerminalText(
        error instanceof Error ? error.message : String(error),
      );
      await recordUnfinishedPage?.().catch((failure) =>
        logRuntimeWarning(
          "LLM Agent: recording a stopped page's results failed",
          failure,
        ),
      );
      const stoppedText = stoppedAnswerText();
      if (params.signal?.aborted) {
        await terminateRun("cancelled", message, "cancelled_in_flight").catch(
          () => undefined,
        );
        return {
          kind: "cancelled",
          runId,
          ...(stoppedText ? { text: stoppedText } : {}),
          cause: error,
        };
      }
      await terminateRun(
        "failed",
        INTERRUPTED_AGENT_RUN_MARKER,
        "interrupted_by_error",
      ).catch(() => undefined);
      return {
        kind: "failed",
        runId,
        message,
        interrupted: true,
        cause: error,
      };
    } finally {
      // Every event row is written before the turn counts as settled. The
      // writer reports its own failures; closing it never throws.
      await runEvents?.close();
      await retryLostFinalRows();
      if (unsettledTurns.get(request.conversationKey) === settling)
        unsettledTurns.delete(request.conversationKey);
      settled();
      // Completion, provider failure, and abort all land here: write the one
      // usage row for this turn. It never throws, and it is not awaited so a
      // slow database cannot delay the turn's teardown.
      void usageRecorder.flush(params.signal?.aborted ? "abort" : "complete");
      if (webSourceRunId) {
        clearWebSourcesForRun(webSourceRunId);
        clearOutsideSearchTurn(webSourceRunId);
      }
      pathLease.release();
    }
  }
}

/**
 * Cheap keyword signals from the user's text, computed once per ordinary
 * turn. They only select which tool guidance is shown; never authority.
 */
export function computeUserTextSignals(
  userText: string,
): NonNullable<AgentRuntimeRequest["userTextSignals"]> {
  return {
    mentionsDuplicates: /\bduplicat|\bmerg(e|ed|es|ing)\b|重复|合并/i.test(
      userText,
    ),
    mentionsTrash: /\btrash\b|\brestor(e|ed|ing)\b|回收站|恢复/i.test(userText),
    mentionsAttachment:
      /\battachments?\b|\brenam(e|ed|ing)\b|\brelink(ed|ing)?\b|附件/i.test(
        userText,
      ),
    mentionsImport: /\bimport(s|ed|ing)?\b|导入|add .* to (my )?library/i.test(
      userText,
    ),
  };
}
