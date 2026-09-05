import type { ModelProviderAuthMode } from "../utils/modelProviders";
import type { ProviderProtocol } from "../utils/providerProtocol";
import type {
  AdvancedModelParams,
  ActiveNoteContext,
  ChatAttachment,
  CollectionContextRef,
  NoteContextRef,
  PaperContentSourceMode,
  PaperContextRef,
  LocalDocumentResource,
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
  SelectedTextSource,
  TagContextRef,
} from "../shared/types";
import type {
  ResolvedTurnSelectedTextAnchor,
  ResolvedTurnSelectedTextContext,
  TurnLocalDocument,
  TurnPaperScope,
  TurnPaperScopeWarning,
} from "./context/turnPaperScope";
import type { WebSourceAnchor } from "../webAccess/types";
import type {
  ChatMessage,
  ReasoningConfig as LLMReasoningConfig,
  UsageStats,
} from "../shared/llm";
import type { ContextCachePlan } from "../contextCache/manager";
import type { ZoteroTurnMetadataContext } from "../services/zoteroMetadata/types";
import type {
  AgentActionContract,
  AgentActionEvidence,
  AgentActionIntent,
  AgentActionProgressLedger,
  AgentActionReceipt,
  AgentToolActionDescriptor,
} from "./contracts/types";

export type {
  AgentActionCapability,
  AgentActionContract,
  AgentActionEvidence,
  AgentActionIntent,
  AgentActionObligation,
  AgentActionOperation,
  AgentActionParameters,
  AgentActionProofDomain,
  AgentActionProgressLedger,
  AgentActionProposal,
  AgentActionReceipt,
  AgentToolActionDescriptor,
} from "./contracts/types";

export type AgentRequest = {
  conversationKey: number;
  mode: "agent";
  userText: string;
  conversationKind?: "global" | "paper";
  scopeType?: "paper" | "open" | "folder" | "tag" | "tagset" | "custom";
  scopeId?: string;
  scopeLabel?: string;
  activeItemId?: number;
  /** Input-only exact active paper/content-source identity from the UI. */
  activePaperContext?: PaperContextRef;
  selectedTextContexts?: SelectedTextContext[];
  resolvedSelectedTextAnchors?: ResolvedSelectedTextAnchor[];
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  selectedPaperContexts?: PaperContextRef[];
  pdfPaperContexts?: PaperContextRef[];
  localDocuments?: readonly LocalDocumentResource[];
  fullTextPaperContexts?: PaperContextRef[];
  citationPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  selectedCollectionContexts?: CollectionContextRef[];
  selectedTagContexts?: TagContextRef[];
  availableAttachmentResources?: AgentAttachmentResource[];
  attachmentResourceSummaries?: AgentAttachmentResourceSummary[];
  attachments?: ChatAttachment[];
  screenshots?: string[];
  /** Skill IDs to force-activate regardless of regex matching (from slash menu selection). */
  forcedSkillIds?: string[];
  model?: string;
  apiBase?: string;
  apiKey?: string;
  providerProtocol?: ProviderProtocol;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
};

export type AgentPendingActionButton = {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
  approved?: boolean;
  executionMode?: "immediate" | "edit";
  submitLabel?: string;
  backLabel?: string;
};

type AgentPendingFieldBase = {
  id: string;
  visibleForActionIds?: string[];
  requiredForActionIds?: string[];
};

export type AgentPendingField =
  | (AgentPendingFieldBase & {
      type: "textarea";
      label: string;
      value?: string;
      placeholder?: string;
      editorMode?: "plain" | "json";
      spellcheck?: boolean;
    })
  | (AgentPendingFieldBase & {
      type: "text";
      label: string;
      value?: string;
      placeholder?: string;
    })
  | (AgentPendingFieldBase & {
      type: "code_preview";
      label: string;
      value: string;
      language?: string;
    })
  | (AgentPendingFieldBase & {
      type: "select";
      label: string;
      value?: string;
      options: Array<{
        id: string;
        label: string;
      }>;
    })
  | (AgentPendingFieldBase & {
      type: "review_table";
      label?: string;
      rows: Array<{
        key: string;
        label: string;
        before?: string;
        after: string;
        multiline?: boolean;
      }>;
    })
  | (AgentPendingFieldBase & {
      type: "diff_preview";
      label?: string;
      before?: string;
      after?: string;
      sourceFieldId?: string;
      contextLines?: number;
      emptyMessage?: string;
    })
  | (AgentPendingFieldBase & {
      type: "image_gallery";
      label?: string;
      items: Array<{
        label: string;
        storedPath: string;
        mimeType?: string;
        title?: string;
      }>;
    })
  | (AgentPendingFieldBase & {
      type: "checklist";
      label: string;
      items: Array<{
        id: string;
        label: string;
        description?: string;
        checked?: boolean;
      }>;
    })
  | (AgentPendingFieldBase & {
      type: "assignment_table";
      label: string;
      options: Array<{
        id: string;
        label: string;
      }>;
      rows: Array<{
        id: string;
        label: string;
        description?: string;
        value?: string;
        checked?: boolean;
      }>;
    })
  | (AgentPendingFieldBase & {
      type: "tag_assignment_table";
      label: string;
      rows: Array<{
        id: string;
        label: string;
        description?: string;
        value?: string | string[];
        placeholder?: string;
      }>;
    })
  | (AgentPendingFieldBase & {
      type: "paper_result_list";
      label: string;
      rows: Array<{
        id: string;
        title: string;
        subtitle?: string;
        body?: string;
        badges?: string[];
        href?: string;
        importIdentifier?: string;
        checked?: boolean;
        year?: number;
        citationCount?: number;
      }>;
      /**
       * Optional multi-mode view. When present, the renderer shows a toggle
       * group above the list (e.g. Recommendations / References / Citations)
       * and swaps the visible rows per selected mode. Selections persist
       * across mode switches — the submitted value is the union of checked
       * row IDs across all modes.
       *
       * When omitted, the card renders the flat `rows` list (legacy).
       */
      modes?: Array<{
        id: string;
        label: string;
        rows: Array<{
          id: string;
          title: string;
          subtitle?: string;
          body?: string;
          badges?: string[];
          href?: string;
          importIdentifier?: string;
          checked?: boolean;
          year?: number;
          citationCount?: number;
        }>;
        emptyMessage?: string;
      }>;
      defaultModeId?: string;
      /**
       * When set, the renderer shows a "Load more" button at the bottom of
       * the list. Clicking it resolves the confirmation with this actionId
       * plus the current selection, letting the action fetch an expanded
       * result set and re-invoke requestConfirmation with the larger list.
       * The action is responsible for the re-fetch loop.
       */
      loadMoreActionId?: string;
      loadMoreLabel?: string;
      minSelectedByAction?: Array<{
        actionId: string;
        min: number;
      }>;
    });

export type AgentPendingAction = {
  toolName: string;
  title: string;
  mode?: "approval" | "review";
  confirmLabel: string;
  cancelLabel: string;
  description?: string;
  fields: AgentPendingField[];
  actions?: AgentPendingActionButton[];
  defaultActionId?: string;
  cancelActionId?: string;
};

export type AgentConfirmationResolution = {
  approved: boolean;
  actionId?: string;
  data?: unknown;
};

export type AgentInheritedApproval = {
  sourceToolName: string;
  sourceActionId: string;
  sourceMode?: "approval" | "review";
};

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: object;
  mutability: "read" | "write";
  requiresConfirmation: boolean;
  /**
   * Model-visible tools are advertised to agent/model runtimes and MCP
   * clients. Internal tools stay registered so plugin-owned migration
   * delegates and review-card workflows can still invoke them.
   */
  exposure?: "model" | "internal";
  /**
   * Advanced tools remain model-visible when exposure is "model", but get
   * stricter policy/trace treatment because they can touch local files,
   * shell commands, or direct Zotero scripts.
   */
  tier?: "normal" | "advanced";
  /**
   * Advertise the tool only to the in-plugin Agent runtime. External bridges,
   * MCP, and public tool catalogs must not expose it.
   */
  localAgentOnly?: boolean;
};

export type AgentEvent =
  | {
      type: "provider_event";
      providerType?: string;
      sessionId?: string;
      payload?: Record<string, unknown>;
      ts?: number;
    }
  | { type: "status"; text: string }
  | {
      type: "reasoning";
      round: number;
      stepId?: string;
      stepLabel?: string;
      summary?: string;
      details?: string;
    }
  | ({ type: "usage"; round: number } & UsageStats)
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      effect?: AgentToolEffect;
      actionReceipts: AgentActionReceipt[];
      content: unknown;
      artifacts?: AgentToolArtifact[];
    }
  | {
      type: "tool_error";
      callId: string;
      name: string;
      error: string;
      round: number;
    }
  | {
      type: "confirmation_required";
      requestId: string;
      action: AgentPendingAction;
    }
  | {
      type: "confirmation_resolved";
      requestId: string;
      approved: boolean;
      actionId?: string;
      data?: unknown;
    }
  | { type: "message_delta"; text: string }
  | { type: "message_rollback"; length: number; text: string }
  | {
      type: "codex_progress";
      itemId: string;
      text: string;
      status?: "running" | "completed";
      kind?: "assistant_message";
    }
  | {
      type: "codex_tool_activity";
      itemId: string;
      phase: "started" | "completed";
      toolName?: string;
      toolLabel?: string;
      serverName?: string;
      args?: unknown;
      ok?: boolean;
      text?: string;
      codeBlock?: string;
      artifacts?: AgentToolArtifact[];
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      contextTokens: number;
      contextWindow?: number;
      contextWindowIsAuthoritative?: boolean;
      percentage?: number;
      sessionId?: string;
      model?: string;
    }
  | { type: "context_compacted"; automatic?: boolean }
  | { type: "fallback"; reason: string }
  | {
      type: "final";
      text: string;
      answerStartedAt?: number;
      webSourceAnchors?: WebSourceAnchor[];
    };

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

export type AgentRunRecord = {
  runId: string;
  conversationKey: number;
  mode: "agent";
  model?: string;
  status: AgentRunStatus;
  createdAt: number;
  completedAt?: number;
  finalText?: string;
};

export type AgentRunEventRecord = {
  runId: string;
  seq: number;
  eventType: AgentEvent["type"];
  payload: AgentEvent;
  createdAt: number;
};

export type AgentToolCall = {
  id: string;
  name: string;
  arguments: unknown;
  /**
   * Gemini thought signature attached to the functionCall part.  Gemini 3
   * rejects continuations that omit it, so it must survive history rebuilds.
   */
  thoughtSignature?: string;
};

export type AgentTraceDetailKind = "text" | "code" | "json" | "url";

export type AgentTraceTimelineIcon = "brain" | "paper" | "website";

export type AgentTraceTimelineRow = {
  icon: AgentTraceTimelineIcon;
  /** Public HTTP(S) destination opened through Zotero when the row is clicked. */
  href?: string;
  /** Optional public favicon URL. Website rows fall back to the globe icon. */
  faviconUrl?: string;
};

export type AgentTraceDetail = {
  label: string;
  value: string;
  kind?: AgentTraceDetailKind;
  /** Render this detail as one row in the compact connected trace timeline. */
  timeline?: AgentTraceTimelineRow;
};

export type AgentTraceChip = {
  icon?: string;
  iconName?: string;
  label: string;
  title?: string;
  detail?: AgentTraceDetail;
  details?: AgentTraceDetail[];
};

export type AgentTraceRequestSummary = {
  selectedTexts: string[];
  paperTitles: string[];
  fileNames: string[];
  screenshotCount: number;
};

export type AgentModelCapabilities = {
  streaming: boolean;
  toolCalls: boolean;
  contentInputs?: AgentContentInputCapabilities;
  /** Compatibility alias: true when any non-text content input is available. */
  multimodal: boolean;
  /** Native upload/file-reference support, not inline document-block support. */
  fileInputs: boolean;
  reasoning: boolean;
};

export type AgentContentInputCapabilities = {
  images: boolean;
  pdfDocuments: boolean;
  nativeFiles: boolean;
};

export type AgentModelContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "low" | "high" | "auto" };
    }
  | {
      type: "file_ref";
      file_ref: {
        name: string;
        mimeType: string;
        storedPath: string;
        contentHash?: string;
      };
    };

export type AgentSystemMessage = {
  role: "system";
  content: string | AgentModelContentPart[];
  cachePolicy?: "stable-prefix";
};

export type AgentUserMessage = {
  role: "user";
  content: string | AgentModelContentPart[];
};

export type AgentAssistantMessage = {
  role: "assistant";
  content: string | AgentModelContentPart[];
  tool_calls?: AgentToolCall[];
};

export type AgentToolMessage = {
  role: "tool";
  content: string;
  tool_call_id: string;
  name: string;
};

export type AgentModelMessage =
  | AgentSystemMessage
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolMessage;

export type AgentModelStep =
  | {
      kind: "final";
      text: string;
      assistantMessage?: AgentAssistantMessage;
    }
  | {
      kind: "tool_calls";
      calls: AgentToolCall[];
      assistantMessage: AgentAssistantMessage;
    };

export type ExhaustiveReadBackend =
  | "request_provider"
  | "codex_responses"
  | "unavailable";

/**
 * Language-independent turn intent produced by the per-turn classifier LLM
 * call, used as a default (never an override) by retrieval and routing.
 */
export type ClassifiedTurnIntent = {
  retrievalIntent: "enumerate" | "verify" | "summarize" | "none";
  paperTargetIntent?: "active" | "added" | "all_visible" | "unspecified";
  externalSearchIntent?: "none" | "web" | "literature" | "both";
  wantedSections: Array<"methods" | "results" | "limitations">;
  queryLanguage?: string;
  writeDisposition?: "none" | "required" | "uncertain";
  actionInterpretationSource?: "classifier" | "deterministic_fallback";
  actionIntents: AgentActionIntent[];
};

export type AgentRuntimeRequestInput = AgentRequest & {
  /** Generation captured when this turn started; Clear advances it. */
  conversationGeneration?: number;
  /** Set by the runtime after per-turn classification; absent on fallback. */
  classifiedIntent?: ClassifiedTurnIntent;
  /** Internal per-turn action obligations. Persisted with transcript events. */
  actionContract?: AgentActionContract;
  /** Mutable completion state kept separate from the immutable contract. */
  actionProgress?: AgentActionProgressLedger;
  item?: Zotero.Item | null;
  history?: ChatMessage[];
  authMode?: ModelProviderAuthMode;
  claudeEffortLevel?: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;
  /** Optional user-defined instructions injected between persona and tool guidance */
  customInstructions?: string;
  modelProviderLabel?: string;
  libraryID?: number;
  activeNoteContext?: ActiveNoteContext;
  metadata?: Record<string, unknown>;
  contextCache?: ContextCachePlan;
  /**
   * Completion boundary used for exhaustive document batches.
   * Missing means the request's configured provider is the completion backend.
   */
  exhaustiveReadBackend?: ExhaustiveReadBackend;
};

export type LegacyPaperContextField =
  | "selectedPaperContexts"
  | "pdfPaperContexts"
  | "fullTextPaperContexts"
  | "citationPaperContexts"
  | "pinnedPaperContexts"
  | "selectedCollectionContexts"
  | "selectedTagContexts"
  | "selectedTextPaperContexts";

export type ResolvedAgentRuntimeRequest = Omit<
  AgentRuntimeRequestInput,
  | LegacyPaperContextField
  | "activePaperContext"
  | "selectedTextContexts"
  | "resolvedSelectedTextAnchors"
  | "localDocuments"
> & {
  turnPaperScope: TurnPaperScope;
  zoteroMetadataContext: ZoteroTurnMetadataContext;
  selectedTextContexts?: readonly ResolvedTurnSelectedTextContext[];
  resolvedSelectedTextAnchors?: readonly ResolvedTurnSelectedTextAnchor[];
  localDocuments?: readonly TurnLocalDocument[];
  turnPaperScopeWarnings?: readonly TurnPaperScopeWarning[];
};

/** Canonical request consumed after the one-way runtime boundary. */
export type AgentRuntimeRequest = ResolvedAgentRuntimeRequest;

export type AgentAttachmentReadableVia =
  | "read_attachment"
  | "paper_read"
  | "unsupported";

export type AgentAttachmentType =
  | "pdf"
  | "markdown"
  | "html"
  | "txt"
  | "docx"
  | "unsupported";

export type AgentAttachmentResource = {
  lifecycleState: "available";
  parentItemId: number;
  parentTitle: string;
  contextItemId: number;
  title: string;
  contentType: string;
  attachmentType: AgentAttachmentType;
  readableVia: AgentAttachmentReadableVia;
  contentSourceMode?: PaperContentSourceMode;
  isPrimary?: boolean;
};

export type AgentAttachmentResourceSummary = {
  scope: "selected-collection";
  collectionId: number;
  libraryID: number;
  collectionName: string;
  parentItemCount: number;
  attachmentCounts: Partial<Record<AgentAttachmentType, number>>;
};

export type AgentRuntimeOutcome =
  | {
      kind: "completed";
      runId: string;
      text: string;
      usedFallback: false;
    }
  | {
      kind: "fallback";
      runId: string;
      reason: string;
      usedFallback: true;
    };

export type AgentToolArtifact =
  | {
      kind: "image";
      mimeType: string;
      storedPath: string;
      contentHash?: string;
      title?: string;
      pageIndex?: number;
      pageLabel?: string;
      paperContext?: PaperContextRef;
    }
  | {
      kind: "file_ref";
      mimeType: string;
      storedPath: string;
      name: string;
      contentHash?: string;
      title?: string;
      paperContext?: PaperContextRef;
    };

/**
 * `ok` means the tool RAN — it is not a report of whether anything changed.
 *
 * That distinction is load-bearing and easy to get wrong. `ok` gates the
 * result-review loop (`runtime.ts`), counts toward the consecutive-error
 * breaker that fails a run after three, and is mapped to MCP's `isError` for
 * external backends. A write that legitimately changed nothing — every item
 * already carried the tag — must therefore stay `ok: true`.
 *
 * `effect` carries what actually happened:
 *   - `"applied"` — every targeted object changed
 *   - `"partial"` — some changed, some were skipped or refused
 *   - `"none"`    — nothing changed
 *
 * Absent `effect` means the tool does not mutate (reads) or does not report
 * granular outcomes.
 */
export type AgentToolEffect = "applied" | "partial" | "none";

export type AgentToolResult = {
  callId: string;
  name: string;
  ok: boolean;
  effect?: AgentToolEffect;
  actionReceipts: AgentActionReceipt[];
  content: unknown;
  artifacts?: AgentToolArtifact[];
};

export type AgentToolReviewResolution =
  | {
      kind: "deliver";
      toolMessageContent?: unknown;
      followupMessages?: AgentModelMessage[];
    }
  | {
      kind: "stop";
      finalText: string;
    }
  | {
      kind: "invoke_tool";
      call: {
        name: string;
        arguments: unknown;
        inheritedApproval?: AgentInheritedApproval;
      };
      terminalText?:
        | {
            onSuccess: string;
            onDenied: string;
            onError: string;
          }
        | undefined;
    };

export type AgentToolExecutionOutput<TResult = unknown> =
  | TResult
  | {
      content: TResult;
      artifacts?: AgentToolArtifact[];
      effect?: AgentToolEffect;
      actionEvidence?: AgentActionEvidence[];
    };

/** Explicit execution contract for tools whose validated operation can write. */
export type AgentWriteToolOutput<TResult = unknown> = {
  content: TResult;
  effect: AgentToolEffect;
  artifacts?: AgentToolArtifact[];
  actionEvidence?: AgentActionEvidence[];
};

export type AgentJournalStepOutcome = {
  effect: AgentToolEffect;
  status:
    | "applied"
    | "partially_applied"
    | "no_effect"
    | "irreversible"
    | "uncertain"
    | "failed";
  reversibility: "full" | "partial" | "none";
  affectedCount: number;
};

/** Shared by nested tool calls that belong to one user-approved action. */
export type AgentJournalActionScope = {
  actionId: string;
  allocateSequence: () => number;
  recordStep: (outcome: AgentJournalStepOutcome) => void;
};

export type AgentToolContext = {
  request: AgentRuntimeRequest;
  /** Durable identity of the execution that owns any journalled writes. */
  runId?: string;
  item: Zotero.Item | null;
  currentAnswerText: string;
  modelName: string;
  modelProviderLabel?: string;
  resourceSignature?: string;
  signal?: AbortSignal;
  /**
   * Internal consent witness used only when journal initialization failed.
   * The registry sets this after an explicit confirmation in safe/auto mode;
   * direct tool/coordinator calls must not silently bypass durable recovery.
   */
  journalFallbackApproved?: boolean;
  /**
   * Internal identity of the outer semantic tool that the user invoked.
   * Facades set this before delegating so durable history does not expose a
   * legacy implementation-detail tool name.
   */
  journalToolName?: string;
  /** Internal parent action used by composite tools such as library_batch. */
  journalActionScope?: AgentJournalActionScope;
  /** Persist the current contract ledger at a durable composite checkpoint. */
  checkpointActionProgress?: () => Promise<void>;
};

export type AgentToolInputValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type AgentToolGuidance = {
  matches: (
    request: AgentRuntimeRequest,
    context?: { matchedSkillIds: ReadonlyArray<string> },
  ) => boolean;
  instruction: string;
};

export type AgentToolPresentationSummaryInput = {
  label: string;
  args?: unknown;
  content?: unknown;
  effect?: AgentToolEffect;
  request?: AgentTraceRequestSummary;
};

export type AgentToolPresentationSummary =
  | string
  | ((input: AgentToolPresentationSummaryInput) => string | null);

/**
 * A single result card rendered below a tool's success row in the agent trace.
 * This path is display-only. Interactive review/approval flows should use
 * `createPendingAction` or `createResultReviewAction` instead.
 */
export type AgentToolResultCard = {
  title: string;
  subtitle?: string;
  body?: string;
  badges?: string[];
  href?: string;
  /**
   * Optional identifier shown for context. Result-card rendering is read-only;
   * use review cards for any import workflow.
   */
  importIdentifier?: string;
};

export type AgentToolPresentation = {
  label?: string;
  /** Optional semantic icon for this tool's compact activity-summary row. */
  traceIcon?: "library" | "web";
  summaries?: {
    onCall?: AgentToolPresentationSummary;
    onPending?: AgentToolPresentationSummary;
    onApproved?: AgentToolPresentationSummary;
    onDenied?: AgentToolPresentationSummary;
    onSuccess?: AgentToolPresentationSummary;
    onEmpty?: AgentToolPresentationSummary;
    onError?: AgentToolPresentationSummary;
  };
  buildChips?: (params: {
    args: unknown;
    request?: AgentTraceRequestSummary;
  }) => AgentTraceChip[];
  buildTraceDetails?: (params: {
    args: unknown;
    content?: unknown;
  }) => AgentTraceDetail[];
  /** Merge a successful result into its expandable call row in the trace. */
  mergeResultIntoCallTrace?: boolean;
  buildTraceSummary?: (params: {
    args: unknown;
    content?: unknown;
  }) => string | null;
  /**
   * When provided, the agent trace renders a read-only card list below the
   * tool's success row. Return `null` or an empty array to suppress cards.
   */
  buildResultCards?: (content: unknown) => AgentToolResultCard[] | null;
};

/**
 * The safety-relevant part of a tool's mutation plan.
 *
 * This is produced from the validated call, so confirmation policy consumes
 * the same operation-specific answer that the durable coordinator will use
 * instead of maintaining a second allowlist of supposedly reversible tools.
 */
export type AgentMutationPlan = {
  effect: "none" | "write";
  reversibility: "full" | "partial" | "none";
  reason?: string;
  /** Recovery resumes and privileged source review may require consent even
   * when the selected write mode would otherwise auto-approve the call. */
  requiresConfirmation?: boolean;
};

export type AgentToolDefinition<TInput = unknown, TResult = unknown> = {
  spec: ToolSpec;
  isAvailable?: (request: AgentRuntimeRequest) => boolean;
  guidance?: AgentToolGuidance;
  presentation?: AgentToolPresentation;
  describeAction?: (
    input: TInput,
    context?: AgentToolContext,
  ) => AgentToolActionDescriptor[] | Promise<AgentToolActionDescriptor[]>;
  validate: (args: unknown) => AgentToolInputValidation<TInput>;
  execute: (
    input: TInput,
    context: AgentToolContext,
  ) => Promise<AgentToolExecutionOutput<TResult>>;
  planMutation?: (
    input: TInput,
    context: AgentToolContext,
  ) => AgentMutationPlan | Promise<AgentMutationPlan>;
  shouldRequireConfirmation?: (
    input: TInput,
    context: AgentToolContext,
  ) => boolean | Promise<boolean>;
  acceptInheritedApproval?: (
    input: TInput,
    approval: AgentInheritedApproval,
    context: AgentToolContext,
  ) => boolean | Promise<boolean>;
  createPendingAction?: (
    input: TInput,
    context: AgentToolContext,
  ) => AgentPendingAction | Promise<AgentPendingAction>;
  applyConfirmation?: (
    input: TInput,
    resolutionData: unknown,
    context: AgentToolContext,
  ) => AgentToolInputValidation<TInput>;
  buildFollowupMessage?: (
    result: AgentToolResult,
    context: AgentToolContext,
  ) => Promise<AgentModelMessage | null>;
  createResultReviewAction?: (
    input: TInput,
    result: AgentToolResult,
    context: AgentToolContext,
  ) => AgentPendingAction | null | Promise<AgentPendingAction | null>;
  resolveResultReview?: (
    input: TInput,
    result: AgentToolResult,
    resolution: AgentConfirmationResolution,
    context: AgentToolContext,
  ) => AgentToolReviewResolution | Promise<AgentToolReviewResolution>;
};

/**
 * Built-in write definitions use this narrower type so every successful
 * execution reports its effect without registry-side result inspection.
 */
export type AgentWriteToolDefinition<
  TInput = unknown,
  TResult = unknown,
> = Omit<AgentToolDefinition<TInput, TResult>, "spec" | "execute"> & {
  spec: ToolSpec & { mutability: "write" };
  execute: (
    input: TInput,
    context: AgentToolContext,
  ) => Promise<AgentWriteToolOutput<TResult>>;
};

export type PreparedToolExecutionResult = {
  tool: AgentToolDefinition<any, any>;
  input: unknown;
  result: AgentToolResult;
};

export type PreparedToolExecutionOptions = {
  inheritedApproval?: AgentInheritedApproval;
  forceConfirmation?: boolean;
  /**
   * Who is driving this call.
   *
   * `prepareExecution` has three very different callers — the model's tool
   * loop, the actions subsystem, and the public `runAction` API — and they
   * carry different consent. A slash command or a plugin API call IS an
   * explicit user gesture; a model tool call is not. Gates that exist to
   * bound autonomy apply to `"model"` only. Defaults to `"model"` when
   * absent, so a caller that forgets to declare itself gets the stricter
   * treatment rather than the looser one.
   */
  callerKind?: "model" | "action" | "api";
  /**
   * Lifecycle fence checked immediately before any tool implementation runs.
   * A tool may be prepared while a conversation is still live and execute only
   * after Clear or deletion has frozen that conversation.
   */
  isExecutionAllowed?: () => boolean;
  /** Serialize the actual side effect with Clear/deletion for this scope. */
  executeWithLock?: <T>(task: () => Promise<T>) => Promise<T>;
};

export type PreparedToolExecution =
  | {
      kind: "result";
      execution: PreparedToolExecutionResult;
    }
  | {
      kind: "confirmation";
      requestId: string;
      action: AgentPendingAction;
      execute: (
        resolutionData?: unknown,
      ) => Promise<PreparedToolExecutionResult>;
      deny: (resolutionData?: unknown) => PreparedToolExecutionResult;
    };
