import type { AgentEvent } from "../types.js";
import type { TraceStore } from "./trace-store.js";

export interface ReplayEvent {
  runId: string;
  event: AgentEvent;
}

export class TraceReplayService {
  constructor(private readonly traceStore: TraceStore) {}

  async getConversationReplay(conversationKey: string): Promise<ReplayEvent[]> {
    const records = await this.traceStore.list(conversationKey);
    return records
      .slice()
      .sort((a, b) => a.event.ts - b.event.ts)
      .map((record) => ({ runId: record.runId, event: record.event }));
  }

  async getRunReplay(
    conversationKey: string,
    runId: string,
  ): Promise<AgentEvent[]> {
    const records = await this.traceStore.list(conversationKey);
    return records
      .filter((record) => record.runId === runId)
      .sort((a, b) => a.event.ts - b.event.ts)
      .map((record) => record.event);
  }
}
