import { describe, expect, it, vi } from "vitest";

import { ClaudeCodeRuntimeAdapter } from "../src/bridge/claude-code-runtime-adapter.js";

describe("ClaudeCodeRuntimeAdapter session adoption", () => {
  it("does not let hook-only system events overwrite the resumed session id", async () => {
    const sessionMapper = {
      get: vi.fn().mockResolvedValue("main-session"),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    const runtimeClient = {
      startTurn: vi.fn().mockResolvedValue({
        runId: "run-1",
        providerSessionId: "main-session",
        events: (async function* () {
          yield {
            type: "provider_event",
            payload: {
              providerType: "system",
              sessionId: "hook-session",
              payload: { subtype: "hook_started", session_id: "hook-session" },
            },
          };
          yield {
            type: "provider_event",
            payload: {
              providerType: "assistant",
              sessionId: "main-session",
              payload: { type: "assistant", session_id: "main-session" },
            },
          };
          yield {
            type: "final",
            payload: {
              output: "done",
              sessionId: "main-session",
            },
          };
        })(),
      }),
    };

    const adapter = new ClaudeCodeRuntimeAdapter({
      runtimeClient: runtimeClient as any,
      sessionMapper: sessionMapper as any,
    });

    const outcome = await adapter.runTurn({
      conversationKey: "conv-1",
      userMessage: "hello",
    });

    expect(outcome.providerSessionId).toBe("main-session");
    expect(sessionMapper.set).not.toHaveBeenCalledWith(
      "conv-1",
      "hook-session",
    );
  });
});
