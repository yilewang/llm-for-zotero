import { assert } from "chai";
import {
  buildPastChatMessageText,
  buildPastChatMessageTextMemoized,
  clearPastChatRenderMemoForTests,
  insertPastChatMessagesBeforeAttachingTurns,
  loadPastConversation,
} from "../src/services/pastConversations/pastConversationLoader";
import {
  PAST_CHAT_MESSAGE_TITLE,
  PAST_CHAT_RELIABILITY_NOTE,
} from "../src/services/pastConversations/pastConversationText";
import type { AttachedConversationRef } from "../src/shared/types";
import {
  createFakePastConversationSource,
  pastChatRows,
} from "./helpers/fakePastConversationSource";

function ref(
  conversationKey: number,
  overrides: Partial<AttachedConversationRef> = {},
): AttachedConversationRef {
  return {
    system: "upstream",
    conversationKey,
    conversationID: `conv-${conversationKey}`,
    title: `Chat ${conversationKey}`,
    libraryID: 1,
    ...overrides,
  };
}

describe("past conversation loader", function () {
  afterEach(function () {
    clearPastChatRenderMemoForTests();
  });

  it("loads a chat with catalog title, mode, date, paper and cleaned messages", async function () {
    const source = createFakePastConversationSource(
      [
        {
          system: "codex",
          conversationKey: 5,
          entry: {
            title: "Codex review",
            kind: "paper",
            paperItemID: 77,
          },
          messages: [
            ...pastChatRows(2),
            { role: "assistant", text: "Compacted", compactMarker: true },
          ],
        },
      ],
      { paperTitles: { 77: "Place cells" } },
    );
    const result = await loadPastConversation(
      ref(5, { system: "codex", title: "Stale title" }),
      { libraryID: 1, source },
    );
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.id, "codex:5");
    assert.equal(result.title, "Codex review");
    assert.equal(result.modeLabel, "Codex");
    assert.equal(result.date, "2026-10-01");
    assert.equal(result.paperLabel, "Place cells");
    assert.deepEqual(
      result.messages.map((message) => message.text),
      ["text 1", "text 2"],
    );
    assert.isAbove(result.tokenEstimate, 0);
  });

  it("refuses a chat that is gone, reused, queued for deletion, or from another library", async function () {
    const source = createFakePastConversationSource(
      [
        { conversationKey: 1, entry: null, messages: [] },
        {
          conversationKey: 2,
          entry: { conversationID: "someone-else" },
          messages: pastChatRows(2),
        },
        { conversationKey: 3, entry: {}, messages: pastChatRows(2) },
        { conversationKey: 4, entry: { libraryID: 2 }, messages: [] },
        { conversationKey: 6, entry: {}, messages: pastChatRows(2) },
      ],
      { pendingDeletion: [3] },
    );
    const status = async (
      attached: AttachedConversationRef,
      libraryID: number | undefined,
    ) => (await loadPastConversation(attached, { libraryID, source })).status;
    assert.equal(await status(ref(1), 1), "deleted");
    assert.equal(await status(ref(2), 1), "deleted");
    assert.equal(await status(ref(3), 1), "deleted");
    assert.equal(await status(ref(4), 1), "other_library");
    assert.equal(await status(ref(6, { libraryID: 2 }), 2), "other_library");
    assert.equal(await status(ref(6), undefined), "other_library");
    assert.equal(await status(ref(6), 1), "ok");
    assert.deepEqual(source.loads, ["upstream:6"]);
  });

  it("reports a store failure without throwing", async function () {
    const source = createFakePastConversationSource([], { failLoads: true });
    const result = await loadPastConversation(ref(9), { libraryID: 1, source });
    assert.equal(result.status, "error");
  });

  it("puts small chats in full while the turn budget lasts, then outlines", async function () {
    const source = createFakePastConversationSource([
      {
        conversationKey: 1,
        entry: { title: "Small" },
        messages: pastChatRows(4, (n) => `small ${n} ${"a".repeat(2_000)}`),
      },
      {
        conversationKey: 2,
        entry: { title: "Second small" },
        messages: pastChatRows(4, (n) => `second ${n} ${"b".repeat(2_000)}`),
      },
      {
        conversationKey: 3,
        entry: { title: "Huge" },
        messages: pastChatRows(80, (n) => `huge ${n} ${"c".repeat(600)}`),
      },
    ]);
    const text = await buildPastChatMessageText({
      refs: [ref(1), ref(2), ref(3)],
      libraryID: 1,
      mode: { kind: "agent", fullTextBudgetTokens: 3_000 },
      source,
    });
    assert.isString(text);
    assert.isTrue(text!.startsWith(PAST_CHAT_MESSAGE_TITLE));
    assert.equal(text!.split(PAST_CHAT_RELIABILITY_NOTE).length - 1, 3);
    // ~2,000 tokens: the first fits the 3,000-token budget in full ...
    assert.include(text, "[message 4 · assistant]\nsmall 4");
    // ... the second would exceed it, so it is outlined ...
    assert.notInclude(text, "second 2 b");
    assert.include(text, 'past_chat_read (chat: "upstream:2"');
    // ... and the huge one (over 8,000 tokens) is always outlined.
    assert.include(text, 'past_chat_read (chat: "upstream:3"');
    assert.notInclude(text, "huge 2 c");
  });

  it("gives every chat its share of the characters in trimmed mode", async function () {
    const source = createFakePastConversationSource([
      {
        conversationKey: 1,
        entry: {},
        messages: pastChatRows(50, (n) => `one ${n} ${"x".repeat(300)}`),
      },
      { conversationKey: 2, entry: null, messages: [] },
    ]);
    const text = await buildPastChatMessageText({
      refs: [ref(1), ref(2)],
      libraryID: 1,
      mode: { kind: "trimmed", totalMaxChars: 6_000 },
      source,
    });
    assert.include(text, "The start of this chat was left out (");
    assert.include(text, "[message 50 · assistant]");
    assert.include(text, 'Past chat "Chat 2" is no longer available.');
    assert.isAtMost(text!.length, 6_000 + PAST_CHAT_MESSAGE_TITLE.length + 200);
  });

  it("renders a chat that fails to load as retryable and does not memoize it", async function () {
    const options = { failLoads: true };
    const source = createFakePastConversationSource(
      [
        {
          conversationKey: 1,
          entry: { title: "Busy chat" },
          messages: pastChatRows(2),
        },
      ],
      options,
    );
    const agentParams = {
      refs: [ref(1, { title: "Busy chat" })],
      libraryID: 1,
      mode: { kind: "agent" as const, fullTextBudgetTokens: 12_000 },
      source,
    };
    const failedAgent = await buildPastChatMessageTextMemoized(
      "agent:9:100",
      agentParams,
    );
    assert.include(
      failedAgent,
      'Past chat "Busy chat" (upstream:1) could not be loaded right now; open it with past_chat_read.',
    );
    assert.notInclude(failedAgent, "no longer available");

    const trimmedParams = {
      ...agentParams,
      mode: { kind: "trimmed" as const, totalMaxChars: 24_000 },
    };
    const failedTrimmed = await buildPastChatMessageTextMemoized(
      "chat:9:100",
      trimmedParams,
    );
    assert.include(
      failedTrimmed,
      'Past chat "Busy chat" could not be loaded right now.',
    );
    assert.notInclude(failedTrimmed, "past_chat_read");
    assert.notInclude(failedTrimmed, "no longer available");

    // The store recovers: the next build loads the chat, because a failed
    // load was never remembered.
    options.failLoads = false;
    const recoveredAgent = await buildPastChatMessageTextMemoized(
      "agent:9:100",
      agentParams,
    );
    assert.include(recoveredAgent, "[message 2 · assistant]\ntext 2");
    const recoveredTrimmed = await buildPastChatMessageTextMemoized(
      "chat:9:100",
      trimmedParams,
    );
    assert.include(recoveredTrimmed, "[message 2 · assistant]\ntext 2");
  });

  it("remembers a chat that is really gone, in both modes", async function () {
    const source = createFakePastConversationSource([
      { conversationKey: 1, entry: null, messages: [] },
      { conversationKey: 2, entry: { libraryID: 2 }, messages: [] },
    ]);
    for (const mode of [
      { kind: "agent" as const, fullTextBudgetTokens: 12_000 },
      { kind: "trimmed" as const, totalMaxChars: 24_000 },
    ]) {
      const text = await buildPastChatMessageTextMemoized(`${mode.kind}:9`, {
        refs: [ref(1), ref(2)],
        libraryID: 1,
        mode,
        source,
      });
      assert.include(text, 'Past chat "Chat 1" is no longer available.');
      assert.include(text, 'Past chat "Chat 2" is no longer available.');
      assert.notInclude(text, "could not be loaded");
    }
  });

  it("returns null when nothing is attached", async function () {
    assert.isNull(
      await buildPastChatMessageText({
        refs: [],
        libraryID: 1,
        mode: { kind: "agent", fullTextBudgetTokens: 12_000 },
      }),
    );
  });

  it("memoizes a rendered message so a rebuild sends the same bytes", async function () {
    const rows = pastChatRows(2);
    const source = createFakePastConversationSource([
      { conversationKey: 1, entry: {}, messages: rows },
    ]);
    const params = {
      refs: [ref(1)],
      libraryID: 1,
      mode: { kind: "agent" as const, fullTextBudgetTokens: 12_000 },
      source,
    };
    const first = await buildPastChatMessageTextMemoized("agent:9:100", params);
    rows.push({ role: "user", text: "added later", timestamp: 9_999 });
    const second = await buildPastChatMessageTextMemoized(
      "agent:9:100",
      params,
    );
    assert.equal(second, first);
    assert.deepEqual(source.loads, ["upstream:1"]);
    const otherRefs = await buildPastChatMessageTextMemoized("agent:9:100", {
      ...params,
      refs: [ref(1, { conversationID: "conv-1-other" })],
    });
    assert.notEqual(otherRefs, first, "different refs never share a memo");
  });

  it("inserts a past-chat message before each user message that attached chats", async function () {
    const source = [
      { role: "user", attachedConversations: [ref(1)] },
      { role: "assistant" },
      { role: "user" },
      { role: "assistant", attachedConversations: [ref(2)] },
      { role: "user", attachedConversations: [ref(3)] },
    ];
    const mapped = ["u1", "a1", "u2", "a2", "u3"];
    const out = await insertPastChatMessagesBeforeAttachingTurns(
      source,
      mapped,
      async (message) =>
        `past:${message.attachedConversations![0].conversationKey}`,
    );
    assert.deepEqual(out, ["past:1", "u1", "a1", "u2", "a2", "past:3", "u3"]);
    assert.deepEqual(
      await insertPastChatMessagesBeforeAttachingTurns(
        source,
        ["mismatched"],
        async () => "x",
      ),
      ["mismatched"],
      "a source that does not map one to one is left alone",
    );
  });
});
