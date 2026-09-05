import { assert } from "chai";
import { clearActiveConversationForPendingDeletion } from "../src/modules/contextPanel/conversationDeletionActivation";

describe("conversationDeletionActivation", function () {
  it("clears active global deletes by switching to a fresh global conversation", async function () {
    const calls: string[] = [];
    const cleared = await clearActiveConversationForPendingDeletion("global", {
      createFreshGlobalConversation: async () => {
        calls.push("global");
        return true;
      },
      createFreshPaperConversation: async () => {
        calls.push("paper");
        return true;
      },
    });

    assert.isTrue(cleared);
    assert.deepEqual(calls, ["global"]);
  });

  it("clears active paper deletes by switching to a fresh paper conversation", async function () {
    const calls: string[] = [];
    const cleared = await clearActiveConversationForPendingDeletion("paper", {
      createFreshGlobalConversation: async () => {
        calls.push("global");
        return true;
      },
      createFreshPaperConversation: async () => {
        calls.push("paper");
        return true;
      },
    });

    assert.isTrue(cleared);
    assert.deepEqual(calls, ["paper"]);
  });

  it("blocks active deletion when the fresh conversation switch fails", async function () {
    const cleared = await clearActiveConversationForPendingDeletion("global", {
      createFreshGlobalConversation: async () => false,
      createFreshPaperConversation: async () => true,
    });

    assert.isFalse(cleared);
  });
});
