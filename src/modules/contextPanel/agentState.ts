import type { AgentRunEventRecord } from "../../agent/types";

export type AgentTraceUiState = {
  status: "loading" | "ready" | "failed" | "reconstructed";
  events: AgentRunEventRecord[];
  lastAttemptAt?: number;
};

export const agentRunTraceCache = new Map<string, AgentTraceUiState>();
export const agentRunTraceLoadingTasks = new Map<string, Promise<void>>();
export const agentReasoningExpandedCache = new Map<string, boolean>();
export const agentProcessExpandedCache = new Map<string, boolean>();
