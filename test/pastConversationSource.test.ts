import { assert } from "chai";
import {
  buildAttachedConversationRef,
  catalogEntryToPastEntry,
  filterPastConversationEntries,
  formatAttachedConversationLabel,
  getPastConversationSystemLabel,
  isAttachedConversationDeleted,
  rankPastConversationMatches,
  setAttachedConversationExistenceForTests,
  sortPastConversationEntries,
  type PastConversationEntry,
} from "../src/modules/contextPanel/pastConversationSource";
import type { AttachedConversationRef } from "../src/shared/types";

describe("pastConversationSource", function () {
  const entry = (
    key: number,
    extra: Partial<PastConversationEntry> = {},
  ): PastConversationEntry =>
    catalogEntryToPastEntry({
      conversationID: `id-${key}`,
      conversationKey: key,
      system: "upstream",
      kind: "global",
      libraryID: 1,
      createdAt: 10,
      lastActivityAt: 100 + key,
      title: `Chat ${key}`,
      userTurnCount: 2,
      ...(extra as object),
    }) as PastConversationEntry;

  afterEach(function () {
    setAttachedConversationExistenceForTests(null);
  });

  it("labels the three systems for the user", function () {
    assert.equal(getPastConversationSystemLabel("codex"), "Codex");
    assert.equal(getPastConversationSystemLabel("claude_code"), "Claude Code");
    assert.equal(getPastConversationSystemLabel("upstream"), "Chat");
  });

  it("drops the current chat, empty chats, repeats, and queued deletions", function () {
    const entries = [
      entry(1),
      entry(2, { userTurnCount: 0 }),
      entry(3),
      entry(1),
      entry(4),
    ];
    const kept = filterPastConversationEntries(entries, {
      excludeConversationKey: 3,
      isPendingDeletion: (key) => key === 4,
    });
    assert.deepEqual(
      kept.map((e) => e.conversationKey),
      [1],
    );
  });

  it("drops temporary side chat keys", function () {
    const kept = filterPastConversationEntries([
      entry(1_900_000_005),
      entry(2_900_000_005),
      entry(7),
    ]);
    assert.deepEqual(
      kept.map((e) => e.conversationKey),
      [7],
    );
  });

  it("sorts newest activity first across systems", function () {
    const sorted = sortPastConversationEntries([
      entry(1, { lastActivityAt: 50 }),
      entry(2, { lastActivityAt: 300, system: "codex" }),
      entry(3, { lastActivityAt: 300, system: "claude_code" }),
    ]);
    assert.deepEqual(
      sorted.map((e) => e.conversationKey),
      [3, 2, 1],
    );
  });

  it("ranks merged matches by match count, then newest activity", function () {
    const a = entry(1, { title: "alpha", lastActivityAt: 10 });
    const b = entry(2, { title: "alpha", lastActivityAt: 20 });
    const c = entry(3, { title: "other", lastActivityAt: 30 });
    const ranked = rankPastConversationMatches(
      [
        { entry: a, bodyText: "alpha alpha alpha" },
        { entry: b, bodyText: "alpha" },
        { entry: c, bodyText: "nothing here" },
      ],
      "alpha",
    );
    assert.deepEqual(
      ranked.entries.map((e) => e.conversationKey),
      [1, 2],
    );
    assert.isTrue(ranked.resultsByKey.has(1));
    assert.isFalse(ranked.resultsByKey.has(3));
  });

  it("builds a reference with no chat text", function () {
    const ref = buildAttachedConversationRef(
      entry(5, { kind: "paper", paperItemID: 9, system: "codex" }),
      1,
    );
    assert.deepEqual(ref, {
      system: "codex",
      conversationKey: 5,
      conversationID: "id-5",
      title: "Chat 5",
      libraryID: 1,
      kind: "paper",
      paperItemID: 9,
    });
  });

  it("renders a deleted chat as 'Deleted chat' and keeps the system label", function () {
    const ref: AttachedConversationRef = {
      system: "claude_code",
      conversationKey: 8,
      conversationID: "x",
      title: "Gone soon",
      libraryID: 1,
    };
    assert.isFalse(isAttachedConversationDeleted(ref));
    assert.equal(
      formatAttachedConversationLabel(ref),
      "Gone soon · Claude Code",
    );
    setAttachedConversationExistenceForTests(ref, false);
    assert.isTrue(isAttachedConversationDeleted(ref));
    assert.equal(
      formatAttachedConversationLabel(ref),
      "Deleted chat · Claude Code",
    );
    setAttachedConversationExistenceForTests(ref, true);
    assert.isFalse(isAttachedConversationDeleted(ref));
  });
});
