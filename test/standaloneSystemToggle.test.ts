import { assert } from "chai";
import { describe, it } from "mocha";
import {
  findReusableStandaloneDraft,
  isReusableStandaloneDraft,
} from "../src/modules/contextPanel/standaloneConversationResolution";
import type { ConversationSystem } from "../src/shared/types";

describe("standalone system toggle", function () {
  it("does not force a fresh conversation by default", function () {
    const calls: ConversationSystem[] = [];
    const switchConversationSystem = async (
      nextSystem: ConversationSystem,
      options?: { forceFresh?: boolean },
    ) => {
      assert.isUndefined(options?.forceFresh);
      calls.push(nextSystem);
    };

    void switchConversationSystem("codex");
    assert.deepEqual(calls, ["codex"]);
  });

  it("reuses an active empty Codex global draft even when forced fresh", function () {
    const draft = {
      conversationKey: 5_000_000_001,
      kind: "global",
      libraryID: 1,
      userTurnCount: 0,
    };

    assert.isTrue(
      isReusableStandaloneDraft({
        forceFresh: true,
        summary: draft,
        kind: "global",
        libraryID: 1,
      }),
    );
    assert.isTrue(
      isReusableStandaloneDraft({
        forceFresh: false,
        summary: draft,
        kind: "global",
        libraryID: 1,
      }),
    );
  });

  it("reuses an active empty Codex paper draft even when forced fresh", function () {
    const draft = {
      conversationKey: 6_000_000_001,
      kind: "paper",
      libraryID: 1,
      userTurnCount: 0,
    };

    assert.isTrue(
      isReusableStandaloneDraft({
        forceFresh: true,
        summary: draft,
        kind: "paper",
      }),
    );
    assert.isTrue(
      isReusableStandaloneDraft({
        forceFresh: false,
        summary: draft,
        kind: "paper",
      }),
    );
  });

  it("reuses listed empty drafts even when forced fresh", function () {
    const drafts = [
      {
        conversationKey: 5_000_000_010,
        kind: "global",
        libraryID: 1,
        userTurnCount: 1,
      },
      {
        conversationKey: 5_000_000_011,
        kind: "global",
        libraryID: 1,
        userTurnCount: 0,
      },
    ];

    assert.equal(
      findReusableStandaloneDraft({
        forceFresh: true,
        summaries: drafts,
      })?.conversationKey,
      5_000_000_011,
    );
    assert.equal(
      findReusableStandaloneDraft({
        forceFresh: false,
        summaries: drafts,
      })?.conversationKey,
      5_000_000_011,
    );
  });
});
