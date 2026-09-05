import { assert } from "chai";
import {
  RECENTLY_DELETED_CONVERSATION_TTL_MS,
  forgetRecentlyDeletedConversation,
  isConversationRecentlyDeleted,
  markConversationRecentlyDeleted,
  resetRecentlyDeletedConversationsForTests,
} from "../src/core/conversations/recentlyDeletedConversations";

describe("recentlyDeletedConversations", function () {
  afterEach(function () {
    resetRecentlyDeletedConversationsForTests();
  });

  it("tombstones a finalized conversation so seeding paths can see it", function () {
    markConversationRecentlyDeleted(41, 1_000);
    assert.isTrue(isConversationRecentlyDeleted(41, 1_000));
    assert.isFalse(
      isConversationRecentlyDeleted(42, 1_000),
      "unrelated keys must stay seedable",
    );
  });

  it("expires the tombstone after the TTL", function () {
    markConversationRecentlyDeleted(41, 1_000);
    assert.isTrue(
      isConversationRecentlyDeleted(
        41,
        1_000 + RECENTLY_DELETED_CONVERSATION_TTL_MS - 1,
      ),
    );
    assert.isFalse(
      isConversationRecentlyDeleted(
        41,
        1_000 + RECENTLY_DELETED_CONVERSATION_TTL_MS,
      ),
    );
  });

  it("lifts the tombstone when the key is deliberately reused", function () {
    // Regression guard: a user starting a new chat on a recycled key must not
    // be blocked by the tombstone of the chat that previously held it.
    markConversationRecentlyDeleted(41, 1_000);
    forgetRecentlyDeletedConversation(41);
    assert.isFalse(isConversationRecentlyDeleted(41, 1_000));
  });

  it("ignores non-positive keys", function () {
    markConversationRecentlyDeleted(0, 1_000);
    markConversationRecentlyDeleted(-3, 1_000);
    markConversationRecentlyDeleted(Number.NaN, 1_000);
    assert.isFalse(isConversationRecentlyDeleted(0, 1_000));
    assert.isFalse(isConversationRecentlyDeleted(-3, 1_000));
    assert.isFalse(isConversationRecentlyDeleted(Number.NaN, 1_000));
  });
});
