import type { ContextCachePlan } from "../contextCache/manager";
import type { ZoteroTurnMetadataContext } from "../services/zoteroMetadata/types";
import type {
  ChatMessage,
  ReasoningConfig as LLMReasoningConfig,
  UsageStats,
} from "../shared/llm";
import type {
  ActiveNoteContext,
  AdvancedModelParams,
  ChatAttachment,
  CollectionContextRef,
  LocalDocumentResource,
  NoteContextRef,
  PaperContentSourceMode,
  PaperContextRef,
  QuoteCitation,
  ResolvedSelectedTextAnchor,
  SelectedTextContext,
  SelectedTextSource,
  TagContextRef,
} from "../shared/types";
import type { ModelProviderAuthMode } from "../utils/modelProviders";
import type { ProviderProtocol } from "../utils/providerProtocol";
import type { WebSourceAnchor } from "../webAccess/types";
import type {
  ActionDomain,
  ActionEffect,
  ActionMechanism,
  ActionRiskSignal,
} from "./authorization/types";
import type { MaterialRef } from "./documents/materialRef";
import type {
  TaskPaperDocumentCitation,
  TaskPaperLedgerDelta,
} from "./context/taskPaperLedger";
import type { TaskPaperScopeSet } from "./context/taskPaperScopeListing";
import type {
  ResolvedTurnSelectedTextAnchor,
  ResolvedTurnSelectedTextContext,
  TurnLocalDocument,
  TurnPaperScope,
  TurnPaperScopeWarning,
} from "./context/turnPaperScope";
import type {
  AgentActionEvidence,
  AgentActionOperation,
  AgentActionReceipt,
  AgentToolActionDescriptor,
} from "./contracts/types";
import type { AgentActionVerification } from "./contracts/actionVerificationLabels";
import type { TrustedReadObservation } from "./context/readObservationTypes";
import type { SkillRoutingReceipt } from "./skills/routingTypes";
import type { LoadedSkillRecord } from "./skills/loadingTypes";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointDelta,
  MaterialOutcomeEntry,
} from "./execution/types";

export type {
  AgentActionCapability,
  AgentActionEvidence,
  AgentExternalMutationEvidence,
  AgentLibraryMutationEvidence,
  AgentPostImageState,
  AgentActionOperation,
  AgentActionParameters,
  AgentActionProofDomain,
  AgentActionProposal,
  AgentActionReceipt,
  AgentToolActionDescriptor,
} from "./contracts/types";

export type {
  ExecutionCheckpoint,
  ExecutionCheckpointDelta,
  ExecutionCheckpointTask,
  ExecutionTaskStatus,
  MaterialOutcomeEntry,
  MaterialOutcomeLedger,
  MaterialOutcomeStatus,
} from "./execution/types";

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
  /** Skill IDs explicitly selected by the user, independent of automatic routing. */
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

export type AgentPendingChoiceValue =
  | { kind: "option"; optionId: string }
  | { kind: "custom"; text: string };

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
      /** The approved payload format; previewing never changes this format. */
      contentFormat?: "markdown" | "html";
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
      type: "choice";
      label: string;
      value?: AgentPendingChoiceValue;
      options: Array<{
        id: string;
        label: string;
        description?: string;
      }>;
      allowCustom?: boolean;
      customPlaceholder?: string;
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
  /** Stable identity for an expandable discovery card. */
  discovery?: { sessionId: string; revision: number };
  /**
   * The exact material version this action would consume, copied from the
   * frozen proposal parameters the user is authorizing. The host stamps it;
   * a tool never supplies it, and it is absent unless the proposal named a
   * complete `MaterialRef`.
   */
  material?: { operation: AgentActionOperation; ref: MaterialRef };
  /**
   * The card is a question the run is waiting on an answer to, not an
   * approval of work it already prepared.
   *
   * The tool spec declares this (`interaction: "user_input"`) and the host
   * copies it here, so a view can tell the two apart without holding a list
   * of the names of the tools that ask questions.
   */
  interaction?: "user_input";
  toolName: string;
  title: string;
  mode?: "approval" | "review";
  confirmLabel: string;
  /** Keep a selection action's label bound to the currently checked rows. */
  selectionAction?: { fieldId: string; verb: string };
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
  /** Minted by the host for the exact downstream tool name and raw input. */
  approvedCallDigest?: string;
};

export type AgentWorkCategory =
  | "retrieval"
  | "planning"
  | "generation"
  | "zotero_action"
  | "external_system";

/**
 * The product stage a trace groups by.
 *
 * It is the work category under the name the reader's model of the run uses:
 * one vocabulary, so a stage can never disagree with the category its own
 * tool declared. `external_system` reads as "External action" in the panel;
 * that is a display label, not a second value.
 */
export type AgentStage = AgentWorkCategory;

type ToolSpecBase = {
  name: string;
  description: string;
  /**
   * Provider-portable JSON Schema for model-generated arguments.
   *
   * A model-visible tool must use a non-array root with `type: "object"` and
   * must not use root-level `oneOf`, `allOf`, or `anyOf`. Nested composition is
   * allowed. Enforce cross-field constraints in the tool's `validate()`
   * function. Internal-only tools are exempt because their schemas are not
   * advertised to models or MCP clients.
   */
  inputSchema: object;
  /**
   * Safety class for the validated operation.
   *
   * Reads may be cached/deduplicated. Controls only change the internal
   * plan/approval lifecycle (or pause for user input), so they are never
   * deduplicated and never consume an external action contract. External
   * effects require a typed action adapter and the full authorization path.
   */
  executionClass: "read" | "control" | "external_effect";
  /**
   * Product work represented by this tool.
   *
   * This is deliberately independent of execution lifecycle and effect
   * status.  It lets trace and recovery readers describe what the Agent was
   * doing without guessing from a tool name or model prose.  Required: an
   * execution class cannot stand in for it, because control-class tools run
   * library changes and external-effect tools reach past the library.
   */
  workCategory: AgentWorkCategory;
  /**
   * Model-visible tools are advertised to agent/model runtimes and MCP
   * clients. Internal tools stay registered so plugin-owned migration
   * delegates and review-card workflows can still invoke them.
   */
  exposure?: "model" | "internal";
  /**
   * Advertise the tool only to the in-plugin Agent runtime. External bridges,
   * MCP, and public tool catalogs must not expose it.
   */
  localAgentOnly?: boolean;
};

/**
 * A tool's confirmation rule is not its own to declare.
 *
 * Every external effect is gated centrally by `authorizeOriginalAction` from
 * the typed proposal it produced, never by a flag on its spec. The one place
 * the host reads a spec-level pause is `InvocationController.dispatch`, and
 * only for the host-owned tools that stop the turn to ask the user something.
 * Keeping `requiresConfirmation` inside that shape is what stops a write tool
 * from writing a private permission rule that nothing enforces.
 */
export type ToolSpec = ToolSpecBase &
  (
    | {
        /** Host-owned interaction tools pause for input even though they are reads. */
        interaction: "user_input";
        /** Whether this interaction pauses for the user by default. */
        requiresConfirmation: boolean;
      }
    | { interaction?: never; requiresConfirmation?: never }
  );

export type AgentEvent =
  | {
      type: "execution_checkpoint";
      checkpoint: ExecutionCheckpoint;
    }
  | {
      /** A change to the run's ledger since its previous ledger event. */
      type: "execution_checkpoint_delta";
      delta: ExecutionCheckpointDelta;
    }
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
  | {
      type: "tool_call";
      callId: string;
      name: string;
      args: unknown;
      /** The tool's own presentation label, resolved when the call was made. */
      toolLabel?: string;
      workCategory?: AgentWorkCategory;
    }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      /** The tool's own presentation label, resolved when the call was made. */
      toolLabel?: string;
      workCategory?: AgentWorkCategory;
      effect?: AgentToolEffect;
      authority?: "yolo_judgment";
      actionReceipts: AgentActionReceipt[];
      content: unknown;
      artifacts?: AgentToolArtifact[];
      /**
       * The trh_ handle holding the whole content, for a result too big to
       * persist in the trace. The live event carries the content too; the
       * persisted row carries `{ truncated: true, handle, bytes }` instead.
       * Optional: small results and older events carry none.
       */
      toolResultHandle?: string;
    }
  | {
      type: "tool_error";
      callId: string;
      name: string;
      error: string;
      round: number;
      /** The tool's own presentation label, resolved when the call was made. */
      toolLabel?: string;
      workCategory?: AgentWorkCategory;
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
      /**
       * Codex's own checklist (see `taskProgress/codexPlan.ts`), on the one
       * event with the item id
       * `codex-plan-checklist`: shown in the Task progress Steps block, never
       * as a trace row.
       */
      steps?: Array<{ content: string; status?: string }>;
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
      actionReceipts?: AgentActionReceipt[];
      workCategory?: AgentWorkCategory;
      /** Whether the call could change library state, as the server saw it. */
      mutability?: "read" | "write";
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
      /**
       * One product stage of the run, as the reader will see it grouped.
       *
       * The stage is required and always comes from a declared contract --
       * the tool's `workCategory`, or the fixed category of the event this
       * announces -- so nothing downstream has to infer work from a tool
       * name.
       *
       * A stage event is emitted immediately before the event it describes:
       * `started` before the `tool_call`, the closing event before the
       * `tool_result` that reports the call's outcome. A `tool_error` is a
       * detail of the call rather than the event a stage describes, so it
       * stays inside the open stage and precedes the close. A live run and a
       * trace projected from an older run therefore interleave identically.
       */
      type: "agent_stage";
      stage: AgentStage;
      status: "started" | "completed" | "failed";
      /** The tool call this stage brackets, when one call owns it. */
      callId?: string;
      toolName?: string;
      toolLabel?: string;
      /** The material this stage finalized, when it finalized one. */
      materialRef?: MaterialRef;
      /** Receipts the closing call produced, by `AgentActionReceipt.id`. */
      receiptIds?: string[];
      /** The durable batch this stage reports one item of. */
      batchId?: string;
      itemKey?: string;
      /**
       * Reconstructed while rendering a trace recorded before stages
       * existed, rather than emitted by the run itself.
       */
      projected?: boolean;
      /**
       * Set on the one stage that stands for a whole run whose events
       * declare no work category at all. Such a trace predates the category
       * contract, and a category guessed from a tool name is exactly what
       * the stage model exists to remove, so the run reports one
       * undifferentiated stage instead of several invented ones.
       */
      undifferentiated?: boolean;
    }
  | {
      /**
       * What one successful read tool call read from each paper, for the
       * Task progress view.
       *
       * Host-emitted immediately after the call's `tool_result`, by the one
       * recorder that sits beside read attestation, and persisted and
       * redacted like every other run event, so a conversation's ledger can
       * be rebuilt from its trace. A connected runtime (Codex, Claude Code)
       * gets the same event from the MCP activity's `paperLedgerDelta`.
       */
      type: "paper_ledger_update";
      callId?: string;
      delta: TaskPaperLedgerDelta;
    }
  | {
      type: "material_finalized";
      /** Immutable identity of the material this run finalized. */
      materialRef: MaterialRef;
      materialKind?: string;
      materialTitle?: string;
      /** The tool call that finalized it; absent for host-side publication. */
      callId?: string;
      /**
       * The sources the finalized document cites, with the heading each
       * first appears under, for the Task progress rows. Optional: older
       * events and non-document material carry none.
       */
      citedSources?: TaskPaperDocumentCitation[];
    }
  | {
      /**
       * One item of a durable batch and the material it wrote.
       *
       * Batch material is announced here rather than through
       * `material_finalized`, so fifty note bodies never flood the turn's
       * material ledger; batches recover from their own durable rows.
       */
      type: "batch_item_outcome";
      batchId: string;
      itemKey: string;
      /** Absent only for an item whose body could not be finalized. */
      materialRef?: MaterialRef;
      status: "pending" | "saved" | "failed";
      /**
       * Whether the carrying call wrote this note, or only reported a row an
       * earlier call had already written. A resumed batch announces every row
       * it holds, so a `saved` row that this call skipped is `written: false`;
       * anything that presents these events as "what just happened" must read
       * this rather than the status.
       */
      written: boolean;
      noteId?: number;
      error?: string;
      /** The tool call that carried this batch. */
      callId: string;
    }
  | {
      type: "final";
      text: string;
      /** Immutable host-finalized document rendered for this visible answer. */
      documentId?: string;
      /** Identity of that document when the answer came from finalized material. */
      materialRef?: MaterialRef;
      /** @deprecated Legacy Plan-only field. */
      planDocumentId?: string;
      answerStartedAt?: number;
      webSourceAnchors?: WebSourceAnchor[];
      /**
       * Every citation this run's tools delivered, re-anchored to the answer
       * sentence that cites it. Absent when no tool delivered a citation.
       */
      quoteCitations?: QuoteCitation[];
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
  messageId?: string;
  /** Historical execution data, never current authorization or host state. */
  retainedTool?: {
    name: string;
    callId: string;
    handle?: string;
    category?: AgentWorkCategory;
    workingDirectory?: string;
  };
  /**
   * Host state the model should see this turn and never again.
   *
   * The transcript and its checkpoints are durable; a transient message is
   * recomputed from durable evidence at every turn start, so persisting it
   * would stack duplicates and keep serving a stale copy after the state it
   * described has changed.  Providers never see this field: adapters build
   * their payload from `role` and `content` alone.
   */
  transient?: true;
};

export type AgentAssistantMessage = {
  role: "assistant";
  content: string | AgentModelContentPart[];
  messageId?: string;
  tool_calls?: AgentToolCall[];
};

export type AgentToolMessage = {
  role: "tool";
  content: string;
  tool_call_id: string;
  name: string;
  workCategory?: AgentWorkCategory;
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
      kind: "incomplete";
      reason: "output_limit" | "provider_pause" | "stream_interrupted";
      providerReason?: string;
      text: string;
      recoveryInstruction: string;
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
 * Host-created facts for one main-agent execution.
 *
 * This deliberately contains no predicted operations or model-authored
 * authority. Concrete tool calls are assessed against these frozen facts at
 * the invocation boundary.
 */
export type AgentExecutionContext = Readonly<{
  version: 1;
  executionId: string;
  conversationKey: number;
  conversationGeneration: number;
  chatLibraryID?: number;
  permissionOwner: "original_agent" | "external_runtime";
  workspaceSnapshot: Readonly<{
    activePaper?: Readonly<{
      libraryID: number;
      itemId: number;
      contextItemId: number;
      title: string;
    }>;
    selectedPapers: readonly Readonly<{
      libraryID: number;
      itemId: number;
      contextItemId: number;
      title: string;
    }>[];
    selectedCollections: readonly Readonly<{
      libraryID: number;
      collectionId: number;
      name: string;
    }>[];
    activeNote?: Readonly<{
      noteId: number;
      parentItemId?: number;
      title: string;
    }>;
  }>;
  configuredAccess: Readonly<{
    libraryIDs: readonly number[];
    /** Legacy write roots retained for stored execution-context compatibility. */
    outputDirectories: readonly string[];
    /** Host-issued MCP capability; path approval belongs to the calling agent. */
    unrestrictedFileAccess?: boolean;
    fileAccess?: Readonly<{
      /** Exact host-resolved task files; never populated from tool arguments. */
      readFiles: readonly string[];
      /** Exact host-approved write targets retained for this execution. */
      writeFiles?: readonly string[];
      readDirectories: readonly string[];
      writeDirectories: readonly string[];
    }>;
    /** Explicit host-process execution capability, independent of file roots. */
    hostCommandExecution?: boolean;
  }>;
}>;

export type AgentRuntimeRequestInput = AgentRequest & {
  /** Last successfully used explicit command directory; never filesystem authority. */
  workingDirectory?: string;
  /** Set by the host entry point, never by model tool arguments. */
  actionEntryPoint?: "action_ui" | "conversation";
  /** Generation captured when this turn started; Clear advances it. */
  conversationGeneration?: number;
  /** Host-created execution facts. Fresh UI requests leave this unset. */
  executionContext?: AgentExecutionContext;
  /** Latest durable ordinary-work progress. This record never grants authority. */
  executionCheckpoint?: ExecutionCheckpoint;
  /**
   * What happened to the material this conversation finalized, derived from
   * persisted run events at turn start.  Evidence, never authority.
   */
  materialOutcomes?: readonly MaterialOutcomeEntry[];
  /** Exact skill instructions loaded or forced by the host for this workflow. */
  loadedSkillRecords?: LoadedSkillRecord[];
  /** Cheap chat-path keyword signal for tool-guidance matching only; never grants authority. */
  userTextSignals?: {
    mentionsDuplicates: boolean;
    mentionsTrash: boolean;
    mentionsAttachment: boolean;
    mentionsImport: boolean;
  };
  clarificationHistory?: Array<{ question: string; answer: string }>;
  /** Validated per-turn skill routing identity; never provider-authored authority. */
  skillRoutingReceipt?: SkillRoutingReceipt;
  /** Host-issued read attestations available to a direct document finalizer. */
  documentReadObservations?: readonly TrustedReadObservation[];
  /** Host-observed tool artifacts eligible for direct document embedding. */
  documentArtifactObservations?: readonly AgentToolArtifact[];
  /** Live model-context state supplied by the runtime to capacity-aware tools. */
  runtimeContextBudget?: Readonly<{
    contextWindowTokens: number;
    usedContextTokens: number;
    /** While a long job's page is open: each page paper's share of it. */
    maxTokensPerPaper?: number;
  }>;
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
  /**
   * Every paper the turn's scope covers, resolved by the host at turn start:
   * the turn context states it, and a part declared over the scope freezes
   * these papers. Runtime-set only.
   */
  turnScopePapers?: TaskPaperScopeSet;
  /**
   * Tool guidance instructions the model has already received this turn: the
   * rendered prompt's guidance plus any load_skill returned. Runtime-set only.
   */
  deliveredToolGuidance?: string[];
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
      documentId?: string;
      /** @deprecated Legacy Plan-only field. */
      planDocumentId?: string;
      /** The same claim-anchored citations the `final` event published. */
      quoteCitations?: QuoteCitation[];
      usedFallback: false;
      /**
       * `"failed"` when the run answered but was stored as failed (a stop
       * rule such as repeated tool errors, or an unverified delegated
       * action): the text is the answer and the report. Absent otherwise.
       */
      runStatus?: "completed" | "failed";
    }
  | {
      kind: "fallback";
      runId: string;
      reason: string;
      usedFallback: true;
    }
  | {
      /** The caller's Stop ended the run; it was stored as cancelled. */
      kind: "cancelled";
      runId: string;
      /** The answer text the run had streamed when it stopped, if any. */
      text?: string;
      /**
       * What the stopped run threw, kept in process only, so the throwing
       * public `runTurn` rethrows it unchanged. Never sent over a bridge.
       */
      cause?: unknown;
    }
  | {
      /** An error ended the run before it answered; it was stored as failed. */
      kind: "failed";
      runId: string;
      message: string;
      /** True when the run was stored as interrupted, resumable on "continue". */
      interrupted: boolean;
      /** The thrown error, in process only, as for `cancelled`. */
      cause?: unknown;
    };

/** The outcome of a turn that ended without an answer or a fallback. */
export type AgentRuntimeUnansweredOutcome = Extract<
  AgentRuntimeOutcome,
  { kind: "cancelled" | "failed" }
>;

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
  /** Set when the host granted this effect on the agent's own judgment (yolo). */
  authority?: "yolo_judgment";
  /** The host rejected the model's input before execution; nothing ran. */
  inputRejected?: true;
  actionReceipts: AgentActionReceipt[];
  content: unknown;
  artifacts?: AgentToolArtifact[];
  /**
   * Durable material this call finalized. The host announces it as a run
   * event, so later turns recover it without re-reading tool payloads.
   */
  materialRef?: MaterialRef;
  materialKind?: string;
  materialTitle?: string;
  /** Sources the finalized document cites; announced on `material_finalized`. */
  materialCitedSources?: TaskPaperDocumentCitation[];
  /**
   * Per-item outcomes of a durable batch. The host announces one run event
   * each, so a batch's material is recoverable per item instead of collapsing
   * into a single turn-level `materialRef`.
   */
  batchItems?: AgentBatchItemOutcome[];
};

/**
 * Host-owned binding between a batch operation's items and their durable rows.
 *
 * It travels on the tool context rather than inside the operation: the
 * operation value is the semantic change the user approved, and the action
 * contract only verifies a receipt when the executed operation is byte-equal
 * to the proposed one.
 */
export type AgentBatchBinding = {
  batchId: string;
  /** One entry per note of the operation, in that operation's own order. */
  items: ReadonlyArray<{
    itemKey: string;
    targetItemId: number;
    /** The item's place in the durable batch, which a resume writes a subset of. */
    position: number;
    material?: MaterialRef;
    /** Why this item has no material; it is recorded failed and never written. */
    failure?: string;
  }>;
};

/** One item of a durable batch, with the material it wrote. */
export type AgentBatchItemOutcome = {
  batchId: string;
  itemKey: string;
  /** Absent only for an item whose body could not be finalized. */
  materialRef?: MaterialRef;
  status: "pending" | "saved" | "failed";
  /**
   * Whether this call wrote the note, as opposed to reporting a row an
   * earlier call had already written. A batch reports every row it holds,
   * so `status: "saved"` alone cannot tell the two apart.
   */
  written: boolean;
  noteId?: number;
  error?: string;
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
      materialRef?: MaterialRef;
      materialKind?: string;
      materialTitle?: string;
      materialCitedSources?: TaskPaperDocumentCitation[];
      batchItems?: AgentBatchItemOutcome[];
    };

/** Explicit execution contract for tools whose validated operation can write. */
export type AgentWriteToolOutput<TResult = unknown> = {
  content: TResult;
  effect: AgentToolEffect;
  artifacts?: AgentToolArtifact[];
  actionEvidence?: AgentActionEvidence[];
  batchItems?: AgentBatchItemOutcome[];
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
  /** Reuse the running loop's completed actions when reviewing intermediate work. */
  readCurrentTurnActions?: () => import("./authorization/types").ActionReviewInput["currentTurnActions"];
  /** Announce instructions loaded during the current run through its durable trace. */
  publishSkillActivation?: (id: string) => Promise<void>;
  /**
   * Whether a tool is offered to the calling client. MCP sets it from the
   * active profile so load_skill never returns guidance for a hidden tool;
   * absent means every tool offered on the request.
   */
  isToolVisible?: (spec: ToolSpec) => boolean;
  /** Host-injected Auto reviewer, shared by normal and nested operation assessment. */
  reviewAction?: import("./authorization/types").ActionReviewer;
  /** Host-owned authority; never decoded from model or MCP tool arguments. */
  authorization?: { kind: "external_runtime"; standalone: boolean };
  /** Retain native-verified child results when a prepared workflow coordinates tools. */
  recordChildExecution?: (result: AgentToolResult) => void;
  /** Host-only execution lifetime carried into child action invocations. */
  nestedExecutionOptions?: Pick<
    PreparedToolExecutionOptions,
    "isExecutionAllowed" | "executeWithLock"
  >;
  /** Existing pending-action surface, for bounded host-prepared selection cards. */
  requestActionReview?: (
    action: AgentPendingAction,
  ) => Promise<AgentConfirmationResolution>;
  /** Resolve a host-prepared action through the existing pending-action channel. */
  resolvePreparedAction?: (
    prepared: PreparedToolExecution,
  ) => Promise<PreparedToolExecutionResult>;
  request: AgentRuntimeRequest;
  /** Durable identity of the execution that owns any journalled writes. */
  runId?: string;
  item: Zotero.Item | null;
  currentAnswerText: string;
  modelName: string;
  modelProviderLabel?: string;
  resourceSignature?: string;
  /** Exact authoritative plan prepared by the registry for this execution. */
  invocationPlan?: AgentInvocationPlan;
  /** Exact authority set by the execution controller after review or policy assessment. */
  executionAuthority?:
    | "user"
    | "safe_read"
    | "requested_note"
    | "external_runtime"
    | "auto_policy"
    | "yolo"
    | "yolo_judgment";
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
  /**
   * Internal action this call continues rather than replaces.
   *
   * A resumed batch belongs to the action its first attempt opened, so undo
   * still reverts every item of it. The coordinator reopens that action only
   * while it is still this conversation's and still holds applied work;
   * otherwise it mints a new one.
   */
  resumeJournalAction?: {
    actionId: string;
    /**
     * Work the action is still missing that this call is not performing.
     * A batch holding an item it can never write leaves its action partially
     * applied however well this call itself goes.
     */
    unfinishedWork?: boolean;
  };
  /** Internal durable batch this call's items belong to. */
  batchBinding?: AgentBatchBinding;
  /** Host-owned registered operation bridge. Each call retains its own authorization and native receipts. */
  invokeRegisteredOperation?: (
    name: string,
    args: unknown,
  ) => Promise<AgentToolResult>;
  /**
   * Apply one change to the turn's ordinary-work checkpoint through the
   * runtime, its only writer, which publishes it when it changed. Resolves to
   * the checkpoint after the change.
   */
  updateExecutionCheckpoint?: (
    apply: (checkpoint: ExecutionCheckpoint) => ExecutionCheckpoint,
  ) => Promise<ExecutionCheckpoint>;
  /** The model's id for the call being executed; set per call by the host. */
  toolCallId?: string;
  /**
   * Publish a paper-row change the tool built itself while it runs (a host
   * digest per paper), through the turn's one event emitter.
   */
  publishPaperLedgerDelta?: (
    delta: import("./context/taskPaperLedger").TaskPaperLedgerDelta,
  ) => Promise<void>;
  /**
   * Store records in the conversation's tool-result handle store, through
   * the turn's writer, and offer context_read for them.
   */
  persistToolResultHandles?: (
    records: import("./store/toolResultHandles").AgentToolResultHandleRecord[],
  ) => Promise<void>;
  /**
   * Register read observations the host issued while the tool ran (a host
   * digest per paper), so a submitted document may cite them as a read
   * tool's observations.
   */
  recordReadObservations?: (
    observations: readonly import("./context/readObservationTypes").TrustedReadObservation[],
  ) => void;
};

export type AgentToolInputValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type AgentToolGuidance = {
  matches: (
    request: Omit<
      AgentRuntimeRequest,
      "userText" | "history" | "clarificationHistory"
    >,
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
export type AgentSavedNoteResultCard = {
  kind: "saved_note";
  actionId?: string;
  title: string;
  destination: string;
  bodyHtml: string;
  note: { itemId: number; libraryID: number; key: string };
};

export type AgentNoteChangeResultCard = {
  kind: "note_change";
  title: string;
  description: string;
  note: { itemId: number; libraryID: number; key: string };
  conversationKey: number;
  actionId: string;
  state:
    | "proposed"
    | "applied"
    | "failed"
    | "undone"
    | "no_op"
    | "mismatch"
    | "unverified";
  afterVerified?: boolean;
  before: import("./store/journalRecoveryBlobStore").RecoveryPayload;
  after: import("./store/journalRecoveryBlobStore").RecoveryPayload;
};

/**
 * How the action card draws an operation: an optional glyph, and whether that
 * glyph is drawn in the destructive colour.
 *
 * The reader-facing word is not here; `operationLabel()` in the operation
 * catalog is the single vocabulary for naming an operation to a person. Which
 * operation carries which glyph is the panel's table
 * (`agentTrace/actionCardVocabulary`); only the shape lives here, so the card
 * type can be stated without the runtime layer reaching into the panel.
 */
export type ActionCardVerb = {
  glyph?: "→" | "+" | "−" | "↺" | "›";
  destructive?: true;
};

/** A native object an effect covered, named the way the reader already sees it. */
export type ActionCardTarget =
  | {
      kind: "item";
      itemId: number;
      label: string;
      libraryID?: number;
      itemKey?: string;
    }
  | {
      kind: "collection";
      collectionId: number;
      label: string;
      libraryID?: number;
    }
  | { kind: "library"; libraryID: number; label: string };

/** What an effect acted on, beyond the targets it covered. */
export type ActionCardObject =
  | {
      kind: "collection";
      label: string;
      collectionId?: number;
      libraryID?: number;
    }
  | { kind: "tag"; label: string; removed?: true }
  | {
      kind: "note";
      label: string;
      noteId?: number;
      libraryID?: number;
      itemKey?: string;
    }
  | { kind: "file"; label: string; path: string }
  | { kind: "command"; label: string }
  | { kind: "trash"; libraryID?: number }
  | { kind: "field"; label: string };

/** One receipt's effect: how it is drawn, what it is called, what it touched. */
export type ActionCardEffect = {
  receiptId: string;
  operation: string;
  verb: ActionCardVerb;
  label: string;
  objects: ActionCardObject[];
  /** Exact command source carried by the matching conversation event. */
  command?: string;
};

/** One row of the card: the objects a set of effects covered, and its verdict. */
export type ActionCardEntry = {
  targets: ActionCardTarget[];
  effects: ActionCardEffect[];
  verification: AgentActionVerification | null;
  badges: string[];
  authority?: "external_runtime";
  rejected: ActionCardTarget[];
  rejectedReason?: string;
  /** Set when a receipt in this row landed only part of what it asked for. */
  partial?: true;
  /** Set by render.ts when a note card matches a note effect in this row. */
  detail?:
    | { kind: "saved_note"; card: AgentSavedNoteResultCard }
    | { kind: "note_change"; card: AgentNoteChangeResultCard };
};

/**
 * What one turn did, as the reader is told after its final answer.
 *
 * Every row comes from receipts: the objects they covered, the operations they
 * state, the objects those acted on, and what their verification proved.
 * Nothing here is read from a tool name, and nothing is added that no receipt
 * claims. The projection that builds the rows is the panel's
 * (`agentTrace/actionCardModel`), which re-exports these shapes.
 */
export type AgentActionSummaryResultCard = {
  kind: "action_summary";
  /** Title of the material the visible answer was rendered from, if any. */
  answerMaterial?: string;
  /** Receipt count, for the pill. */
  actionCount: number;
  entries: readonly ActionCardEntry[];
};

export type AgentToolResultCard =
  | AgentNoteChangeResultCard
  | AgentSavedNoteResultCard
  | AgentActionSummaryResultCard
  | {
      kind?: "paper";
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

/**
 * A code block a tool wants shown under its trace row.
 *
 * `replacesSummary` says the block already carries what the row's summary
 * would say -- a shell command whose summary is "Running: <the command>" --
 * so the row shows the tool's label instead of repeating the block.
 */
export type AgentToolTraceCodeBlock = {
  code: string;
  replacesSummary?: boolean;
};

export type AgentToolPresentation = {
  label?: string;
  /** Optional semantic icon for this tool's compact activity-summary row. */
  traceIcon?: "library" | "web";
  /**
   * Keep this tool out of the activity trace entirely.
   *
   * Set by the tools that are the plan machinery itself: their calls and
   * results are how a plan is drafted and advanced, and the plan card already
   * shows the reader the result. Declared here so the trace reads the fact
   * from the tool instead of holding its own list of names.
   */
  hiddenInTrace?: boolean;
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
  /**
   * Details drawn from the call's arguments alone, shown whether or not a
   * result has arrived yet. `buildTraceDetails` replaces the generic details
   * once a result exists; these are added to them.
   */
  buildTraceArgDetails?: (params: { args: unknown }) => AgentTraceDetail[];
  /** The code block this call shows under its row, if any. */
  buildTraceCodeBlock?: (params: {
    args: unknown;
  }) => AgentToolTraceCodeBlock | null;
  /** Merge a successful result into its expandable call row in the trace. */
  mergeResultIntoCallTrace?: boolean;
  /**
   * The row a completed call gets instead of its generic summary.
   *
   * A call relayed from a connected client reaches the trace with artifacts
   * and no result payload, so the phase, outcome and artifacts are passed
   * alongside the content for the tools that can say something about them.
   */
  buildTraceSummary?: (params: {
    args: unknown;
    content?: unknown;
    artifacts?: AgentToolArtifact[];
    phase?: "started" | "completed";
    ok?: boolean;
  }) => string | null;
  /**
   * When provided, the agent trace renders a read-only card list below the
   * tool's success row. Return `null` or an empty array to suppress cards.
   */
  buildResultCards?: (content: unknown) => AgentToolResultCard[] | null;
};

/** The single safety decision produced from one validated invocation. */
export type AgentInvocationPlan = {
  mechanism: ActionMechanism;
  impact: "read_only" | "state_change" | "ambiguous" | "prohibited";
  assurance: "runtime_enforced" | "statically_recognized" | "unknown";
  domains: ActionDomain[];
  effects: ActionEffect[];
  targets: string[];
  riskSignals: ActionRiskSignal[];
  reversibility: "full" | "partial" | "none";
  reason: string;
};

/**
 * What the model reads of a successful result when the whole is more than
 * the question needs. `stored` (the whole result when absent) must list the
 * rows `content` shows first in each row array it shares with it, so paging
 * a row path from offset = rows shown reads exactly what was left out.
 */
export type AgentToolModelView = {
  content: Record<string, unknown>;
  stored?: Record<string, unknown>;
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
  /**
   * Every operation this tool's `describeAction` can produce.
   *
   * Registration has no input, so the descriptors themselves cannot be
   * inspected there. This static list is what the registry validates against
   * `OPERATION_CATALOG`, which owns each operation's capability and proof
   * domain. Required for `executionClass: "external_effect"`.
   */
  effectOperations?: readonly AgentActionOperation[];
  validate: (args: unknown) => AgentToolInputValidation<TInput>;
  /**
   * Narrow this call's work category when one spec fronts several kinds of
   * work, as a delegating facade does. Receives the raw model arguments
   * because the trace labels a call before it is validated; returning
   * `undefined` keeps the spec's declared category.
   */
  resolveWorkCategory?: (args: unknown) => AgentWorkCategory | undefined;
  execute: (
    input: TInput,
    context: AgentToolContext,
  ) => Promise<AgentToolExecutionOutput<TResult>>;
  planInvocation?: (
    input: TInput,
    context: AgentToolContext,
  ) => AgentInvocationPlan | Promise<AgentInvocationPlan>;
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
  /**
   * The view of a successful result the model reads. The UI, the paper
   * ledger and citations keep the whole result. The host stores the view's
   * `stored` result, with every evidence ref, under a trh_ handle that
   * context_read pages, and sends `content` with the handle and the evidence
   * refs of the rows it keeps; `omitted.documentEvidenceRefs` counts the
   * rest. With no handle to hold the rest, the whole result is sent. Null
   * sends the whole result.
   */
  buildModelView?: (
    input: TInput,
    result: TResult,
    context: AgentToolContext,
  ) => AgentToolModelView | null;
  /**
   * Allows a host-owned terminal artifact to become the application-visible
   * answer without fabricating a provider assistant message. The exact
   * provider tool call/result remains the transcript authority.
   */
  resolveTerminalResult?: (
    input: TInput,
    result: AgentToolResult,
    context: AgentToolContext,
  ) =>
    | {
        finalText: string;
        documentId?: string;
        /** @deprecated Legacy Plan-only field. */
        planDocumentId?: string;
        providerTranscript: "tool_only";
      }
    | null
    | Promise<{
        finalText: string;
        documentId?: string;
        /** @deprecated Legacy Plan-only field. */
        planDocumentId?: string;
        providerTranscript: "tool_only";
      } | null>;
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
> = Omit<
  AgentToolDefinition<TInput, TResult>,
  "spec" | "execute" | "planInvocation"
> & {
  spec: ToolSpec & { executionClass: "external_effect" };
  planInvocation: (
    input: TInput,
    context: AgentToolContext,
  ) => AgentInvocationPlan | Promise<AgentInvocationPlan>;
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
  callerKind?: "model" | "action" | "api" | "mcp";
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
        resolution: AgentConfirmationResolution,
      ) => Promise<PreparedToolExecution>;
      deny: (resolutionData?: unknown) => Promise<PreparedToolExecutionResult>;
    };
