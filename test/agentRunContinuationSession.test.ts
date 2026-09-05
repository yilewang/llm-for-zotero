import { assert } from "chai";
import { AgentRunContinuationSession } from "../src/agent/continuation/runContinuationSession";
import type { AgentModelMessage } from "../src/agent/types";

describe("AgentRunContinuationSession", function () {
  it("replaces a completed tool delta with only the correction after a final", function () {
    const messages: AgentModelMessage[] = [
      { role: "user", content: "Read the paper" },
    ];
    const session = new AgentRunContinuationSession(messages);

    session.commitProviderResponse();
    session.beginToolStep({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-overview", name: "paper_read", arguments: {} }],
    });
    session.completeToolStep({
      toolMessages: [
        {
          role: "tool",
          tool_call_id: "call-overview",
          name: "paper_read",
          content: '{"mode":"overview"}',
        },
      ],
      followupMessages: [],
    });
    assert.deepEqual(
      session
        .inputForNextStep()
        .continuationMessages.map((message) => message.role),
      ["tool"],
    );

    session.commitProviderResponse();
    session.appendFinalCorrection({
      assistantMessage: {
        role: "assistant",
        content: "Premature answer.",
      },
      correctionMessage: {
        role: "user",
        content: "Read the complete paper before answering.",
      },
    });

    const continuation = session.inputForNextStep().continuationMessages;
    assert.deepEqual(
      continuation.map((message) => message.role),
      ["user"],
    );
    assert.notInclude(JSON.stringify(continuation), "call-overview");
  });

  it("installs a complete restart input and clears live continuation state", function () {
    const messages: AgentModelMessage[] = [
      { role: "user", content: "Original request" },
    ];
    const session = new AgentRunContinuationSession(messages);
    session.beginToolStep({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "stale-call", name: "read", arguments: {} }],
    });

    const restartMessages = [
      { role: "system" as const, content: "Managed policy" },
      { role: "user" as const, content: "Original request" },
      {
        role: "user" as const,
        content: "Agent context checkpoint: evidence is incomplete.",
      },
    ] satisfies readonly AgentModelMessage[];
    const suppliedSnapshot = structuredClone(restartMessages);

    session.restartWithMessages(restartMessages);

    assert.deepEqual(messages, suppliedSnapshot);
    assert.deepEqual(restartMessages, suppliedSnapshot);
    assert.deepEqual(session.inputForNextStep().continuationMessages, []);
  });

  it("rejects model calls while a tool-result batch is incomplete", function () {
    const session = new AgentRunContinuationSession([
      { role: "user", content: "Do the work" },
    ]);
    session.beginToolStep({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-1", name: "read", arguments: {} }],
    });

    assert.throws(
      () => session.inputForNextStep(),
      "active tool-result batch is complete",
    );
  });
});
