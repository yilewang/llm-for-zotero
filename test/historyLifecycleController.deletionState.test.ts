import { assert } from "chai";
import { clearDeletedAgentConversationState } from "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController";

describe("historyLifecycleController deletion state cleanup", function () {
  it("clears agent caches and persisted state for deleted history conversations", async function () {
    const calls: string[] = [];
    const hadError = await clearDeletedAgentConversationState(
      {
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`state:${conversationKey}`);
        },
        log: (message) => {
          calls.push(`log:${message}`);
        },
      },
      4201,
      "global",
    );

    assert.isFalse(hadError);
    assert.deepEqual(calls, ["tool:4201", "state:4201"]);
  });

  it("keeps clearing persisted agent state if in-memory cache cleanup fails", async function () {
    const calls: string[] = [];
    const hadError = await clearDeletedAgentConversationState(
      {
        clearAgentToolCaches: (conversationKey) => {
          calls.push(`tool:${conversationKey}`);
          throw new Error("tool cleanup failed");
        },
        clearAgentConversationState: async (conversationKey) => {
          calls.push(`state:${conversationKey}`);
        },
        log: (message) => {
          calls.push(`log:${message}`);
        },
      },
      4202,
      "paper",
    );

    assert.isTrue(hadError);
    assert.deepEqual(calls, [
      "tool:4202",
      "log:LLM: Failed to clear deleted paper agent tool caches",
      "state:4202",
    ]);
  });
});
