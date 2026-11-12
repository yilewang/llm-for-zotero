import { describe, expect, it } from "vitest";

import { mapSdkMessageToProviderEvents } from "../src/event-mapper/map-sdk-message.js";

describe("mapSdkMessageToProviderEvents", () => {
  it("maps thinking deltas to reasoning events", () => {
    const streamEvent = {
      type: "stream_event",
      session_id: "session-1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "Reasoning chunk",
        },
      },
    };

    const events = mapSdkMessageToProviderEvents(streamEvent);
    expect(events).toContainEqual({
      type: "reasoning",
      payload: {
        round: 1,
        details: "Reasoning chunk",
        sessionId: "session-1",
      },
    });
  });

  it("maps system subtypes to readable status text", () => {
    const hookStarted = mapSdkMessageToProviderEvents({
      type: "system",
      session_id: "session-1",
      subtype: "hook_started",
      hook_name: "SessionStart:resume",
    });
    const apiRetry = mapSdkMessageToProviderEvents({
      type: "system",
      session_id: "session-1",
      subtype: "api_retry",
      attempt: 4,
      max_retries: 10,
      error_status: 429,
      error: "rate_limit",
    });

    expect(hookStarted).toContainEqual({
      type: "status",
      payload: expect.objectContaining({
        text: "Running SessionStart:resume",
      }),
    });
    expect(apiRetry).toContainEqual({
      type: "status",
      payload: expect.objectContaining({
        text: "Claude API rate limited. Retrying request (attempt 4/10).",
      }),
    });
  });

  it("emits tool_call once, from the assistant message that carries its arguments", () => {
    const assistantMessage = {
      type: "assistant",
      session_id: "session-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_123",
            name: "Read",
            input: { file_path: "/tmp/a.txt" },
          },
        ],
      },
    };

    const streamEvent = {
      type: "stream_event",
      session_id: "session-1",
      event: {
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          id: "call_123",
          name: "Read",
          input: {},
        },
      },
    };

    const assistantEvents = mapSdkMessageToProviderEvents(assistantMessage);
    const streamEvents = mapSdkMessageToProviderEvents(streamEvent);

    const calls = assistantEvents.filter((event) => event.type === "tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toMatchObject({
      id: "call_123",
      name: "Read",
      input: { file_path: "/tmp/a.txt" },
    });
    expect(
      streamEvents.filter((event) => event.type === "tool_call"),
    ).toHaveLength(0);
  });

  it("keeps Claude Code's own system bookkeeping out of status lines", () => {
    for (const subtype of [
      "thinking_tokens",
      "status",
      "session_state_changed",
    ]) {
      const events = mapSdkMessageToProviderEvents({
        type: "system",
        subtype,
        session_id: "session-1",
      });
      expect(events.map((event) => event.type)).toEqual(["provider_event"]);
    }
  });

  it("does not duplicate tool_result when user message contains both top-level and content-block results", () => {
    const userMessage = {
      type: "user",
      session_id: "session-1",
      tool_use_result: "top-level duplicate",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_123",
            content: [{ type: "text", text: "content-block result" }],
          },
        ],
      },
    };

    const events = mapSdkMessageToProviderEvents(userMessage);
    const toolResults = events.filter((event) => event.type === "tool_result");

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: "tool_result",
      payload: {
        toolUseId: "call_123",
        content: "content-block result",
      },
    });
  });

  it("maps stream message_delta usage as single-step context usage", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "stream_event",
      session_id: "session-1",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 40,
        },
      },
    });

    expect(events).toContainEqual({
      type: "usage",
      payload: expect.objectContaining({
        inputTokens: 100,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 30,
        outputTokens: 40,
        contextTokens: 190,
        sessionId: "session-1",
      }),
    });
  });

  it("does not treat cumulative result usage as current context usage", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "result",
      subtype: "success",
      session_id: "session-1",
      result: "done",
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 500,
        output_tokens: 100,
      },
      modelUsage: {
        "claude-opus-4-6": {
          contextWindow: 200000,
        },
      },
    });

    expect(events).toContainEqual({
      type: "usage",
      payload: expect.objectContaining({
        contextTokens: 0,
        contextWindow: 200000,
        contextWindowIsAuthoritative: true,
      }),
    });
    expect(events).not.toContainEqual({
      type: "usage",
      payload: expect.objectContaining({
        contextTokens: 1500,
      }),
    });
  });

  it("normalizes Claude plan and task tools as host-owned transition requests", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "assistant",
      session_id: "session-plan",
      message: {
        content: [
          {
            type: "tool_use",
            id: "exit-plan-1",
            name: "ExitPlanMode",
            input: { plan: "1. Inspect targets\n2. Apply and verify" },
          },
          {
            type: "tool_use",
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: [{ content: "Inspect targets", status: "completed" }],
            },
          },
        ],
      },
    });

    expect(events).toContainEqual({
      type: "provider_event",
      payload: expect.objectContaining({
        providerType: "claude_plan",
        payload: expect.objectContaining({ ready: true }),
      }),
    });
    expect(events).toContainEqual({
      type: "provider_event",
      payload: expect.objectContaining({
        providerType: "claude_task_progress",
      }),
    });
  });
});
