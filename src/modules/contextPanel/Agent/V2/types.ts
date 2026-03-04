import type { ReasoningConfig } from "../../../../utils/llmClient";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  AgentToolExecutorState,
} from "../Tools/types";
import type { Message, PaperContextRef, AdvancedModelParams } from "../../types";

export type RouterContextSummary = {
  question: string;
  conversationMode: "paper" | "open";
  libraryAvailable: boolean;
  remainingBudgetTokens: number;
  iterationIndex: number;
  maxIterations: number;
  contextDescriptors: string[];
  recentConversationSummary: string[];
  recentToolLogs: string[];
  availableTargets: string[];
  availableTools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    callExample: string;
  }>;
};

export type RouterDecision =
  | {
    decision: "stop";
    trace: string;
    stopReason?: string;
  }
  | {
    decision: "tool_call";
    trace: string;
    call: AgentToolCall;
    stopReason?: string;
  };

export type ToolSpecV2 = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  callExample: string;
  validate(call: AgentToolCall): AgentToolCall | null;
};

export type UiActionDirective =
  | {
    type: "show_note_review";
    targetLabel: string;
    message: string;
  }
  | {
    type: "show_metadata_review";
    targetLabel: string;
    message: string;
  }
  | {
    type: "custom";
    targetLabel: string;
    message: string;
  };

export type ToolExecutionOutcome =
  | {
    kind: "context_update";
    result: AgentToolExecutionResult;
  }
  | {
    kind: "ui_action";
    result: AgentToolExecutionResult;
    action: UiActionDirective;
  }
  | {
    kind: "error";
    result: AgentToolExecutionResult;
    error: string;
  };

export type AgentV2ToolLog = {
  iteration: number;
  toolName: string;
  targetLabel: string;
  ok: boolean;
  traceLines: string[];
  summary: string;
};

export type AgentV2PromptPack = {
  routerPrompt: string;
  responderPrompt: string;
  source: "file" | "fallback";
};

export type AgentV2OrchestratorParams = {
  item: Zotero.Item;
  question: string;
  activeContextItem: Zotero.Item | null;
  conversationMode: "paper" | "open";
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  model: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: ReasoningConfig;
  advanced?: AdvancedModelParams;
  availableContextBudgetTokens?: number;
  maxIterations?: number;
  images?: string[];
  historyMessages?: Message[];
  onStatus?: (statusText: string) => void;
  onTrace?: (line: string) => void;
};

export type AgentV2OrchestratorResult = {
  activeContextItem: Zotero.Item | null;
  conversationMode: "paper" | "open";
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  contextPrefix: string;
  responderContext: string;
  uiActions: UiActionDirective[];
  toolLogs: AgentV2ToolLog[];
};

export type AgentV2RouterParams = {
  summary: RouterContextSummary;
  model: string;
  apiBase?: string;
  apiKey?: string;
  promptPack: AgentV2PromptPack;
};

export type AgentV2ToolBrokerParams = {
  call: AgentToolCall;
  ctx: AgentToolExecutionContext;
  state: AgentToolExecutorState;
};
