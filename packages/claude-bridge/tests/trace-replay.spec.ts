import { describe, expect, it } from "vitest";
import { InMemoryTraceStore } from "../src/trace-store/trace-store.js";
import { TraceReplayService } from "../src/trace-store/trace-replay.js";

describe("TraceReplayService", () => {
  it("returns replay events sorted by timestamp", async () => {
    const store = new InMemoryTraceStore();
    await store.append({
      runId: "run-1",
      conversationKey: "conv-1",
      event: { type: "message_delta", ts: 20, payload: { delta: "b" } },
    });
    await store.append({
      runId: "run-1",
      conversationKey: "conv-1",
      event: { type: "status", ts: 10, payload: { phase: "init" } },
    });

    const replay = new TraceReplayService(store);
    const events = await replay.getConversationReplay("conv-1");

    expect(events.map((x) => x.event.type)).toEqual([
      "status",
      "message_delta",
    ]);
  });

  it("filters by runId for run replay", async () => {
    const store = new InMemoryTraceStore();
    await store.append({
      runId: "run-a",
      conversationKey: "conv-2",
      event: { type: "status", ts: 1, payload: { phase: "a" } },
    });
    await store.append({
      runId: "run-b",
      conversationKey: "conv-2",
      event: { type: "status", ts: 2, payload: { phase: "b" } },
    });

    const replay = new TraceReplayService(store);
    const runAEvents = await replay.getRunReplay("conv-2", "run-a");

    expect(runAEvents).toHaveLength(1);
    expect(runAEvents[0]?.payload).toEqual({ phase: "a" });
  });
});
