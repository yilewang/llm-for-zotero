import type { ChatMessage } from "../utils/llmClient";
import type { ModelProviderAuthMode } from "../utils/modelProviders";
import type {
  AdvancedModelParams,
  ChatAttachment,
  PaperContextRef,
} from "../modules/contextPanel/types";
import type { ReasoningConfig as LLMReasoningConfig } from "../utils/llmClient";

export type AgentRequest = {
  conversationKey: number;
  mode: "agent";
  userText: string;
  activeItemId?: number;
  selectedTexts?: string[];
  selectedPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  attachments?: ChatAttachment[];
  screenshots?: string[];
  model?: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
};

export type AgentPendingField =
  | {
      type: "textarea";
      id: string;
      label: string;
      value?: string;
      placeholder?: string;
      editorMode?: "plain" | "json";
      spellcheck?: boolean;
    }
  | {
      type: "text";
      id: string;
      label: string;
      value?: string;
      placeholder?: string;
    }
  | {
      type: "select";
      id: string;
      label: string;
      value?: string;
      options: Array<{
        id: string;
        label: string;
      }>;
    }
  | {
      type: "review_table";
      id: string;
      label?: string;
      rows: Array<{
        key: string;
        label: string;
        before?: string;
        after: string;
        multiline?: boolean;
      }>;
    }
  | {
      type: "image_gallery";
      id: string;
      label?: string;
      items: Array<{
        label: string;
        storedPath: string;
        mimeType?: string;
        title?: string;
      }>;
    }
  | {
      type: "checklist";
      id: string;
      label: string;
      items: Array<{
        id: string;
        label: string;
        description?: string;
        checked?: boolean;
      }>;
    }
  | {
      type: "assignment_table";
      id: string;
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
    }
  | {
      type: "tag_assignment_table";
      id: string;
      label: string;
      rows: Array<{
        id: string;
        label: string;
        description?: string;
        value?: string | string[];
        placeholder?: string;
      }>;
    };

export type AgentPendingAction = {
  toolName: string;
  title: string;
  confirmLabel: string;
  cancelLabel: string;
  description?: string;
  fields: AgentPendingField[];
};

export type AgentConfirmationResolution = {
  approved: boolean;
  data?: unknown;
};

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: object;
  mutability: "read" | "write";
  requiresConfirmation: boolean;
};

export type ResourceSpec = {
  name: string;
  description: string;
  uri: string;
};

export type PromptSpec = {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
};

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      content: unknown;
      artifacts?: AgentToolArtifact[];
    }
  | { type: "confirmation_required"; requestId: string; action: AgentPendingAction }
  | {
      type: "confirmation_resolved";
      requestId: string;
      approved: boolean;
      data?: unknown;
    }
  | { type: "message_delta"; text: string }
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
  modelProviderLabel?: string;
  libraryID?: number;
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
};

export type AgentToolDefinition<TInput = unknown, TResult = unknown> = {
  spec: ToolSpec;
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
};

export type AgentResourceDefinition<TValue = unknown> = {
  spec: ResourceSpec;
  read: (context: AgentToolContext) => Promise<TValue>;
};

export type AgentPromptDefinition<TArgs = unknown> = {
  spec: PromptSpec;
  render: (args: TArgs, context: AgentToolContext) => Promise<string>;
};

export type PreparedToolExecution =
  | {
      kind: "result";
      result: AgentToolResult;
    }
  | {
      kind: "confirmation";
      requestId: string;
      action: AgentPendingAction;
      execute: (resolutionData?: unknown) => Promise<AgentToolResult>;
      deny: (resolutionData?: unknown) => AgentToolResult;
    };
