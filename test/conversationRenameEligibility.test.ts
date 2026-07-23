import { assert } from "chai";
import {
  canCommitConversationRename,
  isConversationRenameEligible,
  type ConversationRenameIdentity,
} from "../src/modules/contextPanel/conversationRenameEligibility";

describe("conversation rename eligibility", function () {
  const target: ConversationRenameIdentity = {
    system: "upstream",
    kind: "global",
    conversationKey: 42,
  };

  it("blocks pending deletion, orphan, and generation", function () {
    for (const state of [
      { pendingDelete: true },
      { orphan: true },
      { requestPending: true },
    ]) {
      assert.isFalse(
        isConversationRenameEligible({ identity: target, ...state }),
      );
    }
  });

  it("rejects a missing or replaced target after the dialog await", function () {
    assert.isFalse(canCommitConversationRename({ target, current: null }));
    assert.isFalse(
      canCommitConversationRename({
        target,
        current: { ...target, conversationKey: 43 },
      }),
    );
    assert.isFalse(
      canCommitConversationRename({
        target,
        current: { ...target, system: "codex" },
      }),
    );
  });

  it("allows only the same live identity after the await", function () {
    assert.isTrue(canCommitConversationRename({ target, current: target }));
    assert.isFalse(
      canCommitConversationRename({
        target,
        current: target,
        pendingDelete: true,
      }),
    );
  });
});
