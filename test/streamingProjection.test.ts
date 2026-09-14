import { assert } from "chai";
import { buildAgentTraceDisplayItems } from "../src/modules/contextPanel/agentTrace/render";
import type { AgentEvent, AgentRunEventRecord } from "../src/agent/types";
import type { Message } from "../src/modules/contextPanel/types";

describe("incremental streaming projection", function () {
  it("matches a fresh canonical projection through repeated chunks, step labels, tools and finalization", function () {
    const message: Message = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      streaming: true,
    };
    const events: AgentRunEventRecord[] = [];
    const sequence: AgentEvent[] = [
      { type: "reasoning", round: 1, stepId: "read", summary: "Evidence " },
      { type: "reasoning", round: 1, stepId: "read", summary: "repeated " },
      { type: "reasoning", round: 1, stepId: "read", summary: "repeated " },
      {
        type: "reasoning",
        round: 1,
        stepId: "read",
        summary: "again.",
        stepLabel: "Checking evidence",
      },
      {
        type: "tool_call",
        callId: "call",
        name: "query_library",
        args: {},
      },
      {
        type: "tool_result",
        callId: "call",
        name: "query_library",
        ok: true,
        actionReceipts: [],
        content: { results: [] },
      },
      { type: "reasoning", round: 2, summary: "Next step. " },
      { type: "reasoning", round: 2, details: "Detailed explanation. " },
      { type: "message_delta", text: "Answer " },
      { type: "message_delta", text: "with evidence." },
      { type: "message_rollback", length: 4 },
      { type: "final", text: "Final answer." },
    ];
    for (const payload of sequence) {
      events.push({
        runId: "stream",
        seq: events.length + 1,
        createdAt: events.length + 1,
        eventType: payload.type,
        payload,
      });
      if (payload.type === "final") {
        message.streaming = false;
        message.text = payload.text;
      }
      const fresh = buildAgentTraceDisplayItems([...events], undefined, {
        ...message,
      });
      assert.deepEqual(
        buildAgentTraceDisplayItems(events, undefined, message),
        fresh,
        payload.type,
      );
    }
  });

  it("reprojects replaced histories and does not share mutable display state between runs", function () {
    const message: Message = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      streaming: true,
    };
    const make = (summary: string): AgentRunEventRecord => ({
      runId: "run",
      seq: 1,
      createdAt: 1,
      eventType: "reasoning",
      payload: { type: "reasoning", round: 1, summary },
    });
    const events = [make("Old stream")];
    buildAgentTraceDisplayItems(events, undefined, message);
    events[0] = make("Replacement");
    assert.deepEqual(
      buildAgentTraceDisplayItems(events, undefined, message),
      buildAgentTraceDisplayItems([...events], undefined, { ...message }),
    );
  });
});
