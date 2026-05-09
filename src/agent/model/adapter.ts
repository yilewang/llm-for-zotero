import type { ReasoningEvent, UsageStats } from "../../utils/llmClient";
import type {
  AgentModelCapabilities,
  AgentToolCall,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  ToolSpec,
} from "../types";

export type AgentAdapterToolContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export type AgentAdapterToolCallResult = {
  contentItems: AgentAdapterToolContentItem[];
  success: boolean;
};

export type AgentStepParams = {
  request: AgentRuntimeRequest;
  messages: AgentModelMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onReasoning?: (event: ReasoningEvent) => void | Promise<void>;
  onUsage?: (usage: UsageStats) => void | Promise<void>;
  onToolCall?: (
    call: AgentToolCall,
  ) => Promise<AgentAdapterToolCallResult>;
};

export interface AgentModelAdapter {
  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities;
  supportsTools(request: AgentRuntimeRequest): boolean;
  runStep(params: AgentStepParams): Promise<AgentModelStep>;
}
