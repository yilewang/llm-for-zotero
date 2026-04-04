import type { AgentRunEventRecord } from "../../agent/types";

export const agentRunTraceCache = new Map<string, AgentRunEventRecord[]>();
export const agentRunTraceLoadingTasks = new Map<string, Promise<void>>();
export const agentReasoningExpandedCache = new Map<string, boolean>();
export const agentProcessExpandedCache = new Map<string, boolean>();
