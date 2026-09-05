import type { AgentRunEventRecord } from "../../agent/types";

export const agentRunTraceCache = new Map<string, AgentRunEventRecord[]>();
export const agentRunTraceLoadingTasks = new Map<string, Promise<void>>();
export const agentReasoningExpandedCache = new Map<string, boolean>();

/** Remove trace UI state after the backing run rows have been deleted. */
export function clearAgentRuntimeTraceState(runIds: readonly string[]): void {
  for (const rawRunId of runIds) {
    const runId = String(rawRunId || "").trim();
    if (!runId) continue;
    agentRunTraceCache.delete(runId);
    agentRunTraceLoadingTasks.delete(runId);
    const expansionPrefix = `${runId}:`;
    for (const key of agentReasoningExpandedCache.keys()) {
      if (key.startsWith(expansionPrefix)) {
        agentReasoningExpandedCache.delete(key);
      }
    }
  }
}
