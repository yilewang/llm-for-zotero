import type { ReasoningEvent } from "../../utils/llmClient";
import type {
  AgentModelCapabilities,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  ToolSpec,
} from "../types";

export type AgentStepParams = {
  request: AgentRuntimeRequest;
  messages: AgentModelMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onReasoning?: (event: ReasoningEvent) => void | Promise<void>;
};

export interface AgentModelAdapter {
  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities;
  supportsTools(request: AgentRuntimeRequest): boolean;
  runStep(params: AgentStepParams): Promise<AgentModelStep>;
}
