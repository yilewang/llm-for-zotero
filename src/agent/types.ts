import type { ChatMessage } from "../utils/llmClient";
import type { ModelProviderAuthMode } from "../utils/modelProviders";
import type { ProviderProtocol } from "../utils/providerProtocol";
import type {
  AdvancedModelParams,
  ActiveNoteContext,
  ChatAttachment,
  PaperContextRef,
  SelectedTextSource,
} from "../shared/types";
import type { ReasoningConfig as LLMReasoningConfig } from "../utils/llmClient";

export type AgentRequest = {
  conversationKey: number;
  mode: "agent";
  userText: string;
  activeItemId?: number;
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedPaperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  attachments?: ChatAttachment[];
  screenshots?: string[];
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
      }>;
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
};

export type AgentEvent =
  | { type: "status"; text: string }
  | {
      type: "reasoning";
      round: number;
      summary?: string;
      details?: string;
    }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
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
  | { type: "confirmation_required"; requestId: string; action: AgentPendingAction }
  | {
      type: "confirmation_resolved";
      requestId: string;
      approved: boolean;
      actionId?: string;
      data?: unknown;
    }
  | { type: "message_delta"; text: string }
  | { type: "message_rollback"; length: number; text: string }
  | { type: "fallback"; reason: string }
  | { type: "final"; text: string };

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
};

export type AgentTraceChip = {
  icon: string;
  label: string;
  title?: string;
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
  multimodal: boolean;
  fileInputs: boolean;
  reasoning: boolean;
};

export type AgentModelContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
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

export type AgentRuntimeRequest = AgentRequest & {
  item?: Zotero.Item | null;
  history?: ChatMessage[];
  authMode?: ModelProviderAuthMode;
  systemPrompt?: string;
  /** Optional user-defined instructions injected between persona and tool guidance */
  customInstructions?: string;
  modelProviderLabel?: string;
  libraryID?: number;
  activeNoteContext?: ActiveNoteContext;
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

export type AgentToolResult = {
  callId: string;
  name: string;
  ok: boolean;
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
    };

export type AgentToolContext = {
  request: AgentRuntimeRequest;
  item: Zotero.Item | null;
  currentAnswerText: string;
  modelName: string;
  modelProviderLabel?: string;
};

export type AgentToolInputValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type AgentToolGuidance = {
  matches: (request: AgentRuntimeRequest) => boolean;
  instruction: string;
};

export type AgentToolPresentationSummaryInput = {
  label: string;
  args?: unknown;
  content?: unknown;
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
  /**
   * When provided, the agent trace renders a read-only card list below the
   * tool's success row. Return `null` or an empty array to suppress cards.
   */
  buildResultCards?: (content: unknown) => AgentToolResultCard[] | null;
};

export type AgentToolDefinition<TInput = unknown, TResult = unknown> = {
  spec: ToolSpec;
  isAvailable?: (request: AgentRuntimeRequest) => boolean;
  guidance?: AgentToolGuidance;
  presentation?: AgentToolPresentation;
  validate: (args: unknown) => AgentToolInputValidation<TInput>;
  execute: (
    input: TInput,
    context: AgentToolContext,
  ) => Promise<AgentToolExecutionOutput<TResult>>;
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

export type PreparedToolExecutionResult = {
  tool: AgentToolDefinition<any, any>;
  input: unknown;
  result: AgentToolResult;
};

export type PreparedToolExecutionOptions = {
  inheritedApproval?: AgentInheritedApproval;
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
