import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { createPastChatReadTool } from "../src/agent/tools/read/pastChatRead";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { PAST_CHAT_RELIABILITY_NOTE } from "../src/services/pastConversations/pastConversationText";
import type {
  AgentRuntimeRequest,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
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

describe("past_chat_read", function () {
  const source = createFakePastConversationSource([
    {
      conversationKey: 10,
      entry: { title: "Grid cells chat" },
      messages: pastChatRows(30, (n) =>
        n === 5 ? `long ${"q".repeat(30_000)} tail` : `message ${n} body`,
      ),
    },
    { conversationKey: 11, entry: null, messages: [] },
    { conversationKey: 12, entry: { libraryID: 2 }, messages: [] },
  ]);
  const tool = createPastChatReadTool(source) as AgentToolDefinition<
    unknown,
    unknown
  >;
  const context = (
    scope: AttachedConversationRef[] | undefined,
    libraryID = 1,
  ): AgentToolContext => ({
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "what did we say before?",
      libraryID,
      ...(scope ? { attachedConversationScope: scope } : {}),
    } as AgentRuntimeRequest,
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  });
  const run = async (args: unknown, toolContext: AgentToolContext) => {
    const input = tool.validate(args);
    if (!input.ok) throw new Error(input.error);
    return (await tool.execute(input.value, toolContext)) as Record<
      string,
      any
    >;
  };

  it("is always listed, even when nothing is attached", function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "hello",
      libraryID: 1,
    });
    const spec = registry
      .listToolsForRequest(request)
      .find((entry) => entry.name === "past_chat_read");
    assert.exists(spec);
    assert.equal(
      registry.getTool("past_chat_read")?.spec.executionClass,
      "read",
    );
    // 300 before the query sentence was added (320 characters, 2026-10-18).
    assert.isAtMost(spec!.description.length, 330);
    assert.isAtMost(
      registry.getTool("past_chat_read")!.spec.description.length,
      1_200,
    );
    assert.notMatch(
      JSON.stringify(registry.getTool("past_chat_read")!.spec),
      /conversation_read|\bcontract|obligation|frozen workflow/i,
    );
  });

  it("validates the chat id and the paging fields", function () {
    assert.isFalse(tool.validate({}).ok);
    assert.isFalse(tool.validate({ chat: "Grid cells chat" }).ok);
    assert.isFalse(tool.validate({ chat: "upstream:10", message: 0 }).ok);
    assert.isFalse(tool.validate({ chat: "upstream:10", textOffset: 5 }).ok);
    assert.isFalse(tool.validate({ chat: "upstream:10", maxTokens: -1 }).ok);
    const input = tool.validate({ chat: "upstream:10", maxTokens: 99_999 });
    assert.isTrue(input.ok);
    if (input.ok) assert.equal((input.value as any).maxTokens, 12_000);
  });

  it("says how to attach a chat when none is attached", async function () {
    const result = await run({ chat: "upstream:10" }, context(undefined));
    assert.isFalse(result.ok);
    assert.equal(
      result.error,
      "No past chat is attached in this conversation. The user can attach one with / → Add past conversation.",
    );
    assert.deepEqual(source.loads, []);
  });

  it("refuses a chat that is not attached, even while others are", async function () {
    const result = await run(
      { chat: "upstream:99" },
      context([ref(10), ref(11)]),
    );
    assert.isFalse(result.ok);
    assert.equal(
      result.error,
      "This past chat was not attached in this conversation. Ask the user to attach it with / → Add past conversation.",
    );
  });

  it("refuses a chat from another library and a deleted chat", async function () {
    const otherLibrary = await run({ chat: "upstream:12" }, context([ref(12)]));
    assert.equal(
      otherLibrary.error,
      "Only past chats from this library can be read.",
    );
    const fromOtherRequestLibrary = await run(
      { chat: "upstream:10" },
      context([ref(10)], 2),
    );
    assert.equal(
      fromOtherRequestLibrary.error,
      "Only past chats from this library can be read.",
    );
    const deleted = await run({ chat: "upstream:11" }, context([ref(11)]));
    assert.equal(deleted.error, "This past chat was deleted.");
  });

  it("returns the outline without message", async function () {
    const result = await run({ chat: "upstream:10" }, context([ref(10)]));
    assert.isTrue(result.ok);
    assert.equal(result.title, "Grid cells chat");
    assert.equal(result.mode, "Chat");
    assert.equal(result.note, PAST_CHAT_RELIABILITY_NOTE);
    assert.equal(result.totalMessages, 30);
    assert.deepEqual(result.questions[0], {
      message: 1,
      preview: "message 1 body",
    });
    assert.lengthOf(result.questions, 15);
    assert.notProperty(result, "messages");
    assert.equal(tool.presentation?.summaries?.onCall, "Reading past chat");
    const onSuccess = tool.presentation?.summaries?.onSuccess as (input: {
      label: string;
      content: unknown;
    }) => string;
    assert.equal(
      onSuccess({ label: "Read Past Chat", content: result }),
      "Listed past chat “Grid cells chat”",
    );
  });

  it("reads from a message on and says where to continue", async function () {
    const result = await run(
      { chat: "upstream:10", message: 1, maxTokens: 512 },
      context([ref(10)]),
    );
    assert.isTrue(result.ok);
    assert.deepEqual(
      result.messages.map((message: any) => message.message),
      [1, 2, 3, 4],
    );
    assert.equal(result.messages[0].text, "message 1 body");
    assert.equal(result.messages[1].role, "assistant");
    assert.equal(
      result.nextMessage,
      5,
      "message 5 does not fit, so it is next",
    );
    assert.notProperty(result, "nextTextOffset");
    const onSuccess = tool.presentation?.summaries?.onSuccess as (input: {
      label: string;
      content: unknown;
    }) => string;
    assert.equal(
      onSuccess({ label: "Read Past Chat", content: result }),
      "Read past chat “Grid cells chat”, message 1 of 30",
    );
  });

  it("pages a long message with textOffset until it ends", async function () {
    const first = await run(
      { chat: "upstream:10", message: 5, maxTokens: 2_000 },
      context([ref(10)]),
    );
    assert.equal(first.messages.length, 1);
    assert.equal(first.nextMessage, 5);
    assert.isNumber(first.nextTextOffset);
    assert.isTrue(first.messages[0].text.startsWith("long "));
    let text = first.messages[0].text as string;
    let next: Record<string, any> = first;
    for (
      let guard = 0;
      next.nextTextOffset !== undefined && guard < 20;
      guard++
    ) {
      next = await run(
        {
          chat: "upstream:10",
          message: 5,
          textOffset: next.nextTextOffset,
          maxTokens: 12_000,
        },
        context([ref(10)]),
      );
      text += next.messages[0].text;
    }
    assert.isTrue(text.endsWith(" tail"));
    assert.equal(text.length, `long ${"q".repeat(30_000)} tail`.length);
    assert.equal(next.messages[1]?.message, 6, "the next message follows");
  });

  it("refuses a message number past the end", async function () {
    const result = await run(
      { chat: "upstream:10", message: 31 },
      context([ref(10)]),
    );
    assert.isFalse(result.ok);
    assert.equal(result.error, "message must be between 1 and 30.");
  });

  describe("query search", function () {
    const searchSource = createFakePastConversationSource([
      {
        conversationKey: 40,
        entry: { title: "Search chat" },
        messages: [
          { role: "user", text: "How do grid cells fire?", timestamp: 1 },
          {
            role: "assistant",
            text: `${"Background. ".repeat(40)}Grid cells fire on a triangular lattice; the spacing is about 40 cm.${" More.".repeat(40)}`,
            timestamp: 2,
          },
          { role: "user", text: "And place cells?", timestamp: 3 },
          {
            role: "assistant",
            text: "Place cells fire in one place field.",
            timestamp: 4,
          },
          { role: "user", text: "网格细胞的间距是多少？", timestamp: 5 },
          {
            role: "assistant",
            text: "网格细胞的间距大约是四十厘米。",
            timestamp: 6,
          },
          ...Array.from({ length: 10 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            text: `Theta note ${index + 1}: theta rhythm detail.`,
            timestamp: 10 + index,
          })),
        ],
      },
    ]);
    const searchTool = createPastChatReadTool(
      searchSource,
    ) as AgentToolDefinition<unknown, unknown>;
    const search = async (args: Record<string, unknown>) => {
      const input = searchTool.validate({ chat: "upstream:40", ...args });
      if (!input.ok) throw new Error(input.error);
      return (await searchTool.execute(
        input.value,
        context([ref(40)]),
      )) as Record<string, any>;
    };

    it("returns the messages that contain every word, with a snippet around the first", async function () {
      const result = await search({ query: "SPACING grid" });
      assert.isTrue(result.ok);
      assert.equal(result.query, "SPACING grid");
      assert.deepEqual(
        result.matches.map((match: any) => [match.message, match.role]),
        [[2, "assistant"]],
      );
      const snippet = result.matches[0].snippet as string;
      assert.include(snippet, "Grid cells fire on a triangular lattice");
      assert.isTrue(snippet.startsWith("…") && snippet.endsWith("…"));
      assert.isAtMost(snippet.length, 242);
      assert.equal(result.totalMatches, 1);
      assert.notProperty(result, "partial");
      assert.notProperty(result, "omittedMatches");
      assert.equal(result.hint, "Read one with message: <number>.");
      const onSuccess = searchTool.presentation?.summaries
        ?.onSuccess as (input: { label: string; content: unknown }) => string;
      assert.equal(
        onSuccess({ label: "Read Past Chat", content: result }),
        "Searched past chat “Search chat”, 1 match",
      );
    });

    it("never cuts a surrogate pair at either end of a snippet", async function () {
      // Position 200 puts the cut at 80 and 320: an emoji straddles each.
      const emoji = "\u{1F600}";
      const text =
        "a".repeat(79) +
        emoji +
        "b".repeat(119) +
        "zzkey" +
        "b".repeat(114) +
        emoji +
        "c".repeat(200);
      assert.equal(text.indexOf("zzkey"), 200);
      const emojiSource = createFakePastConversationSource([
        {
          conversationKey: 41,
          entry: { title: "Emoji chat" },
          messages: [{ role: "assistant", text, timestamp: 1 }],
        },
      ]);
      const tool = createPastChatReadTool(emojiSource) as AgentToolDefinition<
        unknown,
        unknown
      >;
      const input = tool.validate({ chat: "upstream:41", query: "zzkey" });
      if (!input.ok) throw new Error(input.error);
      const result = (await tool.execute(
        input.value,
        context([ref(41)]),
      )) as Record<string, any>;
      const snippet = result.matches[0].snippet as string;
      assert.include(snippet, "zzkey");
      // Well-formed UTF-16: JSON round trip keeps every code unit.
      assert.isFalse(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
          snippet,
        ),
      );
    });

    it("falls back to the messages with the most words, marked partial", async function () {
      const result = await search({ query: "place grid fire" });
      // No message holds all three words; messages 2 and 4 hold two each
      // (grid+fire, place+fire), messages 1 and 3 one each.
      assert.isTrue(result.partial);
      assert.deepEqual(
        result.matches.map((match: any) => match.message),
        [1, 2, 3, 4],
      );
      assert.equal(result.totalMatches, 4);
      assert.match(result.hint, /these contain the most/);
    });

    it("ranks partial hits by words matched, keeps eight, and lists them in message order", async function () {
      const result = await search({ query: "theta detail grid" });
      // The ten theta messages hold two words each, messages 1 and 2 one
      // ("grid"): the eight kept are theta messages, though 1 and 2 come
      // first in the chat.
      assert.isTrue(result.partial);
      assert.lengthOf(result.matches, 8);
      assert.deepEqual(
        result.matches.map((match: any) => match.message),
        [7, 8, 9, 10, 11, 12, 13, 14],
      );
      assert.equal(result.totalMatches, 12);
      assert.equal(result.omittedMatches, 4);
      const few = await search({ query: "theta grid" });
      // One word each: ties go to the lower message number.
      assert.deepEqual(
        few.matches.map((match: any) => match.message),
        [1, 2, 7, 8, 9, 10, 11, 12],
      );
    });

    it("keeps more than eight complete hits out and says how many", async function () {
      const result = await search({ query: "theta rhythm" });
      assert.notProperty(result, "partial");
      assert.deepEqual(
        result.matches.map((match: any) => match.message),
        [7, 8, 9, 10, 11, 12, 13, 14],
      );
      assert.equal(result.totalMatches, 10);
      assert.equal(result.omittedMatches, 2);
    });

    it("finds text without spaces (Chinese) by substring", async function () {
      const result = await search({ query: "间距" });
      assert.deepEqual(
        result.matches.map((match: any) => match.message),
        [5, 6],
      );
    });

    it("returns no hits as an ok result with a hint, not an error", async function () {
      const result = await search({ query: "hippocampus" });
      assert.isTrue(result.ok);
      assert.deepEqual(result.matches, []);
      assert.equal(result.totalMatches, 0);
      assert.match(result.hint, /No message in this chat contains these words/);
    });

    it("refuses query with message or textOffset, and an empty or long query", function () {
      const conflict = searchTool.validate({
        chat: "upstream:40",
        query: "grid",
        message: 2,
      });
      assert.isFalse(conflict.ok);
      if (!conflict.ok)
        assert.match(
          conflict.error,
          /query cannot be combined with message or textOffset/,
        );
      assert.isFalse(
        searchTool.validate({
          chat: "upstream:40",
          query: "grid",
          textOffset: 5,
        }).ok,
      );
      assert.isFalse(
        searchTool.validate({ chat: "upstream:40", query: "  " }).ok,
      );
      assert.isFalse(
        searchTool.validate({ chat: "upstream:40", query: "x".repeat(201) }).ok,
      );
      assert.isFalse(searchTool.validate({ chat: "upstream:40", query: 3 }).ok);
    });

    it("checks the scope before it searches", async function () {
      const input = searchTool.validate({ chat: "upstream:40", query: "grid" });
      if (!input.ok) throw new Error(input.error);
      const result = (await searchTool.execute(
        input.value,
        context([ref(10)]),
      )) as Record<string, any>;
      assert.isFalse(result.ok);
      assert.match(result.error, /was not attached in this conversation/);
    });
  });
});
