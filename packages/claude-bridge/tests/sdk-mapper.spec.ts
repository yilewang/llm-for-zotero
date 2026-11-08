import { describe, expect, it } from "vitest";
import { mapSdkMessageToProviderEvents } from "../src/event-mapper/map-sdk-message.js";

describe("mapSdkMessageToProviderEvents", () => {
  it("maps assistant text and tool_use blocks", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "assistant",
      session_id: "sess-1",
      message: {
        content: [
          { type: "text", text: "hello" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file: "a.ts" },
          },
        ],
      },
    });

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "provider_event",
      payload: { providerType: "assistant", sessionId: "sess-1" },
    });
    expect(events[1]).toMatchObject({
      type: "message_delta",
      payload: { delta: "hello", sessionId: "sess-1" },
    });
    expect(events[2]).toMatchObject({
      type: "tool_call",
      payload: { id: "toolu_1", name: "Read", sessionId: "sess-1" },
    });
  });

  it("maps result to final event", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "result",
      session_id: "sess-2",
      result: "done",
      is_error: false,
      num_turns: 3,
    });

    expect(events).toEqual([
      {
        type: "provider_event",
        payload: expect.objectContaining({
          providerType: "result",
          sessionId: "sess-2",
        }),
      },
      {
        type: "final",
        payload: {
          output: "done",
          isError: false,
          subtype: undefined,
          durationMs: undefined,
          numTurns: 3,
          sessionId: "sess-2",
        },
      },
    ]);
  });

  it("maps stream_event text deltas", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "stream_event",
      session_id: "sess-3",
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "chunk",
        },
      },
    });

    expect(events).toEqual([
      {
        type: "provider_event",
        payload: expect.objectContaining({
          providerType: "stream_event",
          sessionId: "sess-3",
        }),
      },
      {
        type: "message_delta",
        payload: {
          delta: "chunk",
          partial: true,
          sessionId: "sess-3",
        },
      },
    ]);
  });

  it("leaves a streamed tool_use block start to the assistant message", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "stream_event",
      session_id: "sess-5",
      event: {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "tool_abc",
          name: "Bash",
          input: {},
        },
      },
    });

    expect(events).toEqual([
      {
        type: "provider_event",
        payload: expect.objectContaining({
          providerType: "stream_event",
          sessionId: "sess-5",
        }),
      },
    ]);
  });

  it("maps error result payload into final output text", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "result",
      session_id: "sess-4",
      is_error: true,
      errors: [{ message: "models/sonnet not found" }],
    });

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "final",
      payload: {
        output: "Error: models/sonnet not found",
        isError: true,
        subtype: undefined,
        durationMs: undefined,
        numTurns: undefined,
        sessionId: "sess-4",
      },
    });
  });
});
