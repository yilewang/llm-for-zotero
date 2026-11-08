import { assert } from "chai";
import {
  addAttachedPastChatsToSimpleChatHistory,
  pastChatHistoryCurrentMessage,
} from "../src/modules/contextPanel/pastChatSimpleChatHistory";
import { clearPastChatRenderMemoForTests } from "../src/services/pastConversations/pastConversationLoader";
import {
  PAST_CHAT_MESSAGE_TITLE,
  PAST_CHAT_RELIABILITY_NOTE,
  PAST_CHAT_SIMPLE_CHAT_MAX_CHARS,
} from "../src/services/pastConversations/pastConversationText";
import { applyHistoryCompression } from "../src/modules/contextPanel/conversationSummaryCache";
import { applyModelInputTokenCap } from "../src/utils/modelInputCap";
import type { AttachedConversationRef } from "../src/shared/types";
import { callLLM, type ChatMessage } from "../src/utils/llmClient";
import {
  createFakePastConversationSource,
  pastChatRows,
} from "./helpers/fakePastConversationSource";

/**
 * Simple chat (no tools) receives attached past chats as a user message
 * right before the user message that attached them, rebuilt from chat
 * history every turn with the same bytes. The current turn's chats sit
 * last in the history, right before the prompt.
 */

const SHORT_REF: AttachedConversationRef = {
  system: "upstream",
  conversationKey: 10,
  conversationID: "conv-10",
  title: "Rat chat",
  libraryID: 1,
};

const LONG_REF: AttachedConversationRef = {
  system: "upstream",
  conversationKey: 20,
  conversationID: "conv-20",
  title: "Long chat",
  libraryID: 1,
};

const CONFIG = {
  model: "gpt-4o",
  apiBase: "https://api.openai.com/v1",
  providerProtocol: "openai_chat_compat" as const,
  authMode: "api_key" as const,
  advanced: undefined,
};

type Source = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  attachedConversations?: AttachedConversationRef[];
};

function toHistory(messages: Source[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.text,
  }));
}

function text(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

function isPastChat(message: ChatMessage | undefined): boolean {
  return (
    message?.role === "user" &&
    text(message).startsWith(PAST_CHAT_MESSAGE_TITLE)
  );
}

function fakeSource() {
  return createFakePastConversationSource([
    {
      conversationKey: 10,
      entry: { title: "Rat chat" },
      messages: [
        { role: "user", text: "What was the rat called?", timestamp: 1 },
        {
          role: "assistant",
          text: "The lab's rat was named Biscuit.",
          timestamp: 2,
        },
      ],
    },
    {
      conversationKey: 20,
      entry: { title: "Long chat" },
      messages: pastChatRows(60, (n) => `long ${n} ${"w".repeat(900)}`),
    },
  ]);
}

describe("simple chat: attached past chats in history", function () {
  afterEach(function () {
    clearPastChatRenderMemoForTests();
  });

  it("puts the current turn's past chat last, right before the prompt", async function () {
    const source = fakeSource();
    const history: Source[] = [
      { role: "user", text: "earlier question", timestamp: 100 },
      { role: "assistant", text: "earlier answer", timestamp: 101 },
    ];
    const out = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: 5,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: history,
      rawHistory: toHistory(history),
      currentMessage: {
        role: "user",
        timestamp: 200,
        attachedConversations: [SHORT_REF],
      },
      effectiveRequestConfig: CONFIG,
      source,
    });
    assert.lengthOf(out, 3);
    assert.equal(text(out[0]), "earlier question");
    assert.isTrue(isPastChat(out[2]));
    assert.include(text(out[2]), PAST_CHAT_RELIABILITY_NOTE);
    assert.include(text(out[2]), "The lab's rat was named Biscuit.");
    assert.notInclude(
      text(out[2]),
      "past_chat_read",
      "simple chat has no tool, so the text never names one",
    );

    // The input cap drops history from the oldest end and never the last
    // user message (the prompt): the past chat survives longer than older
    // history on a small model.
    const capped = applyModelInputTokenCap(
      [
        { role: "system", content: "system prompt" },
        { role: "user", content: "x".repeat(40_000) },
        { role: "assistant", content: "y".repeat(40_000) },
        ...out.slice(2),
        { role: "user", content: "the question" },
      ],
      "small-model",
      4_000,
    );
    assert.isTrue(capped.effects.historyDropped);
    assert.isTrue(
      capped.messages.some((message) => isPastChat(message as ChatMessage)),
      "the current turn's past chat is kept while older history is dropped",
    );
  });

  it("sends the same message at the same place on the next turn", async function () {
    const source = fakeSource();
    const firstUser: Source = {
      role: "user",
      text: "question with a past chat",
      timestamp: 200,
      attachedConversations: [SHORT_REF],
    };
    const turn1 = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: 5,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: [],
      rawHistory: [],
      currentMessage: firstUser,
      effectiveRequestConfig: CONFIG,
      source,
    });
    assert.lengthOf(turn1, 1);

    const history: Source[] = [
      firstUser,
      { role: "assistant", text: "answer", timestamp: 201 },
    ];
    const turn2 = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: 5,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: history,
      rawHistory: toHistory(history),
      currentMessage: { role: "user", timestamp: 300 },
      effectiveRequestConfig: CONFIG,
      source,
    });
    assert.lengthOf(turn2, 3);
    assert.equal(text(turn2[0]), text(turn1[0]), "identical bytes");
    assert.equal(text(turn2[1]), "question with a past chat");
    assert.deepEqual(source.loads, ["upstream:10"], "rendered once");
  });

  it("puts a past-chat message before each user message that attached chats", async function () {
    const source = fakeSource();
    const history: Source[] = [
      {
        role: "user",
        text: "q1",
        timestamp: 100,
        attachedConversations: [SHORT_REF],
      },
      { role: "assistant", text: "a1", timestamp: 101 },
      { role: "user", text: "q2", timestamp: 102 },
      { role: "assistant", text: "a2", timestamp: 103 },
      {
        role: "user",
        text: "q3",
        timestamp: 104,
        attachedConversations: [LONG_REF],
      },
      { role: "assistant", text: "a3", timestamp: 105 },
    ];
    const out = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: 5,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: history,
      rawHistory: toHistory(history),
      currentMessage: { role: "user", timestamp: 300 },
      effectiveRequestConfig: CONFIG,
      source,
    });
    assert.deepEqual(
      out.map((message) => (isPastChat(message) ? "past" : text(message))),
      ["past", "q1", "a1", "q2", "a2", "past", "q3", "a3"],
    );
    assert.include(text(out[5]), "The start of this chat was left out (");
    assert.isAtMost(
      text(out[5]).length,
      PAST_CHAT_SIMPLE_CHAT_MAX_CHARS + PAST_CHAT_MESSAGE_TITLE.length + 2,
    );
  });

  it("changes nothing when no chat is attached, and never for Claude Code", async function () {
    const history: Source[] = [
      { role: "user", text: "q1", timestamp: 100 },
      { role: "assistant", text: "a1", timestamp: 101 },
    ];
    const rawHistory = toHistory(history);
    const none = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: 5,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: history,
      rawHistory,
      currentMessage: { role: "user", timestamp: 300 },
      effectiveRequestConfig: CONFIG,
      source: fakeSource(),
    });
    assert.strictEqual(none, rawHistory);

    // Claude Code gets its chats through agentMode/pastChatHistory.ts; Codex
    // is covered in codexPastChatDelivery.test.ts.
    for (const conversationSystem of ["claude_code"]) {
      const source = fakeSource();
      const out = await addAttachedPastChatsToSimpleChatHistory({
        conversationKey: 5,
        conversationSystem,
        libraryID: 1,
        messages: history,
        rawHistory,
        currentMessage: {
          role: "user",
          timestamp: 300,
          attachedConversations: [SHORT_REF],
        },
        effectiveRequestConfig: CONFIG,
        source,
      });
      assert.strictEqual(out, rawHistory, conversationSystem);
      assert.deepEqual(source.loads, []);
    }

    const webchat = fakeSource();
    const webchatOut = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: 5,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: history,
      rawHistory,
      currentMessage: {
        role: "user",
        timestamp: 300,
        attachedConversations: [SHORT_REF],
      },
      effectiveRequestConfig: {
        ...CONFIG,
        authMode: "webchat",
        providerProtocol: "web_sync",
      },
      source: webchat,
    });
    assert.strictEqual(webchatOut, rawHistory, "webchat never gets past chats");
    assert.deepEqual(webchat.loads, []);
  });

  it("caps all attaching messages together at twice the per-message budget", async function () {
    const refs: AttachedConversationRef[] = [31, 32, 33, 34].map((key) => ({
      system: "upstream",
      conversationKey: key,
      conversationID: `conv-${key}`,
      title: `Long chat ${key}`,
      libraryID: 1,
    }));
    const source = createFakePastConversationSource([
      ...refs.map((ref) => ({
        conversationKey: ref.conversationKey,
        entry: { title: ref.title },
        messages: pastChatRows(
          60,
          (n) => `c${ref.conversationKey} ${n} ${"w".repeat(900)}`,
        ),
      })),
      {
        conversationKey: 10,
        entry: { title: "Rat chat" },
        messages: pastChatRows(2, () => "short"),
      },
    ]);
    const history: Source[] = refs.flatMap((ref, index) => [
      {
        role: "user" as const,
        text: `question ${index}`,
        timestamp: 100 + index * 10,
        attachedConversations: [ref],
      },
      {
        role: "assistant" as const,
        text: `answer ${index}`,
        timestamp: 101 + index * 10,
      },
    ]);
    const current: Source = {
      role: "user",
      text: "now",
      timestamp: 500,
      attachedConversations: [SHORT_REF],
    };
    const build = () =>
      addAttachedPastChatsToSimpleChatHistory({
        conversationKey: 9,
        conversationSystem: "upstream",
        libraryID: 1,
        messages: history,
        rawHistory: toHistory(history),
        currentMessage: current,
        effectiveRequestConfig: CONFIG,
        source,
      });
    const out = await build();
    const pastChats = out.filter(isPastChat);
    const fullChars = pastChats.reduce((sum, m) => sum + text(m).length, 0);
    assert.isAtMost(
      fullChars,
      2 * PAST_CHAT_SIMPLE_CHAT_MAX_CHARS,
      "all past-chat text together stays within twice the per-message budget",
    );
    const leftOut = out.filter((m) =>
      text(m).startsWith("Past chats attached earlier in this conversation ("),
    );
    assert.isAtLeast(leftOut.length, 1);
    assert.include(
      leftOut.map(text),
      "Past chats attached earlier in this conversation (Long chat 31) were left out to save space.",
      "the oldest message is replaced by one stable line",
    );
    assert.isTrue(
      isPastChat(out[out.length - 1]),
      "the current turn's message is always kept",
    );
    assert.include(text(out[out.length - 1]), "Rat chat");
    // Turn after turn the same bytes.
    const again = await build();
    assert.deepEqual(again.map(text), out.map(text));
  });

  it("still sends a chat attached again after its first copy was left out", async function () {
    const big = [41, 42].map((key) => ({
      system: "upstream" as const,
      conversationKey: key,
      conversationID: `conv-${key}`,
      title: `Big chat ${key}`,
      libraryID: 1,
    }));
    const source = createFakePastConversationSource([
      {
        conversationKey: 10,
        entry: { title: "Rat chat" },
        messages: pastChatRows(2, () => "short"),
      },
      ...big.map((ref) => ({
        conversationKey: ref.conversationKey,
        entry: { title: ref.title },
        messages: pastChatRows(
          60,
          (n) => `c${ref.conversationKey} ${n} ${"w".repeat(900)}`,
        ),
      })),
    ]);
    const history: Source[] = [
      {
        role: "user",
        text: "q0",
        timestamp: 100,
        attachedConversations: [SHORT_REF],
      },
      { role: "assistant", text: "a0", timestamp: 101 },
      {
        role: "user",
        text: "q1",
        timestamp: 110,
        attachedConversations: [big[0]],
      },
      { role: "assistant", text: "a1", timestamp: 111 },
      {
        role: "user",
        text: "q2",
        timestamp: 120,
        attachedConversations: [big[1]],
      },
      { role: "assistant", text: "a2", timestamp: 121 },
    ];
    const out = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: 11,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: history,
      rawHistory: toHistory(history),
      currentMessage: {
        role: "user",
        timestamp: 500,
        attachedConversations: [SHORT_REF],
      },
      effectiveRequestConfig: CONFIG,
      source,
    });
    const last = out[out.length - 1];
    assert.isTrue(isPastChat(last), "the re-attached chat is sent");
    assert.include(text(last), "### Past chat upstream:10");
    assert.isTrue(
      out.some((m) =>
        text(m).startsWith(
          "Past chats attached earlier in this conversation (Rat chat)",
        ),
      ),
      "the first copy became the left-out line",
    );
  });

  it("keeps a summarized turn's past chat right after the summary", async function () {
    const source = fakeSource();
    const history: Source[] = [];
    for (let index = 0; index < 12; index += 1) {
      history.push({
        role: "user",
        text: `q${index + 1}`,
        timestamp: 100 + index * 2,
        attachedConversations: index === 0 ? [SHORT_REF] : undefined,
      });
      history.push({
        role: "assistant",
        text: `a${index + 1}`,
        timestamp: 101 + index * 2,
      });
    }
    const rawHistory = toHistory(history);
    const compressed = applyHistoryCompression(5, rawHistory);
    assert.notStrictEqual(compressed, rawHistory, "history is compressed");
    const out = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: 5,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: history,
      rawHistory,
      history: compressed,
      currentMessage: { role: "user", timestamp: 300 },
      effectiveRequestConfig: CONFIG,
      source,
    });
    assert.lengthOf(out, compressed.length + 1);
    assert.deepEqual(out.slice(0, 2), compressed.slice(0, 2));
    assert.isTrue(isPastChat(out[2]));
    assert.deepEqual(out.slice(3), compressed.slice(2));
  });

  it("sends a chat attached twice only where it was first attached", async function () {
    const source = fakeSource();
    const history: Source[] = [
      {
        role: "user",
        text: "q1",
        timestamp: 100,
        attachedConversations: [SHORT_REF],
      },
      { role: "assistant", text: "a1", timestamp: 101 },
    ];
    const out = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: 5,
      conversationSystem: "upstream",
      libraryID: 1,
      messages: history,
      rawHistory: toHistory(history),
      currentMessage: {
        role: "user",
        timestamp: 300,
        attachedConversations: [SHORT_REF],
      },
      effectiveRequestConfig: CONFIG,
      source,
    });
    assert.deepEqual(
      out.map((message) => (isPastChat(message) ? "past" : text(message))),
      ["past", "q1", "a1"],
    );
  });

  it("spends less on a small-context model", async function () {
    const run = async (inputTokenCap: number | undefined) => {
      clearPastChatRenderMemoForTests();
      const out = await addAttachedPastChatsToSimpleChatHistory({
        conversationKey: 5,
        conversationSystem: "upstream",
        libraryID: 1,
        messages: [],
        rawHistory: [],
        currentMessage: {
          role: "user",
          timestamp: 300,
          attachedConversations: [LONG_REF],
        },
        effectiveRequestConfig: {
          ...CONFIG,
          advanced: inputTokenCap ? { inputTokenCap } : undefined,
        },
        source: fakeSource(),
      });
      return text(out[0]);
    };
    const large = await run(undefined);
    const small = await run(16_000);
    // 15% of 16,000 tokens at four characters a token.
    assert.isAtMost(small.length, 9_600 + PAST_CHAT_MESSAGE_TITLE.length + 2);
    assert.isBelow(small.length, large.length);
    assert.include(small, "The start of this chat was left out (");
  });

  describe("over the Anthropic Messages protocol", function () {
    const originalZotero = globalThis.Zotero;
    const globals = globalThis as typeof globalThis & { ztoolkit?: unknown };
    const originalToolkit = globals.ztoolkit;
    let bodies: Array<Record<string, unknown>>;

    beforeEach(function () {
      bodies = [];
      const prefs = new Map<string, unknown>();
      globalThis.Zotero = {
        Prefs: {
          get: (key: string) => prefs.get(key) ?? "",
          set: (key: string, value: unknown) => prefs.set(key, value),
        },
      } as unknown as typeof Zotero;
      const reply = {
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
      };
      const fetchFn = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: null,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => reply,
          text: async () => JSON.stringify(reply),
        } as Response;
      }) as typeof fetch;
      globals.ztoolkit = {
        getGlobal: (name: string) => (name === "fetch" ? fetchFn : undefined),
        log: () => undefined,
      };
    });

    afterEach(function () {
      globalThis.Zotero = originalZotero;
      globals.ztoolkit = originalToolkit;
    });

    it("sends the past chat and the question as two user turns in order", async function () {
      const history = await addAttachedPastChatsToSimpleChatHistory({
        conversationKey: 5,
        conversationSystem: "upstream",
        libraryID: 1,
        messages: [
          { role: "user", text: "q0", timestamp: 100 },
          { role: "assistant", text: "a0", timestamp: 101 },
        ],
        rawHistory: [
          { role: "user", content: "q0" },
          { role: "assistant", content: "a0" },
        ],
        currentMessage: {
          role: "user",
          timestamp: 300,
          attachedConversations: [SHORT_REF],
        },
        effectiveRequestConfig: {
          model: "claude-sonnet-4-5",
          apiBase: "https://api.anthropic.com/v1",
          providerProtocol: "anthropic_messages",
          authMode: "api_key",
        },
        source: fakeSource(),
      });
      const outcome = await callLLM({
        prompt: "What was the rat called?",
        history,
        model: "claude-sonnet-4-5",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "test-key",
        providerProtocol: "anthropic_messages",
      });
      assert.equal(outcome.text, "OK");
      assert.lengthOf(bodies, 1);
      const messages = bodies[0].messages as Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
      }>;
      // The builder neither merges nor drops back-to-back user turns; the
      // Messages API accepts them (it joins consecutive same-role turns).
      assert.deepEqual(
        messages.map((message) => message.role),
        ["user", "assistant", "user", "user"],
      );
      assert.isTrue(
        String(messages[2].content[0]?.text).startsWith(
          PAST_CHAT_MESSAGE_TITLE,
        ),
      );
      assert.include(
        String(messages[2].content[0]?.text),
        "The lab's rat was named Biscuit.",
      );
      assert.equal(messages[3].content[0]?.text, "What was the rat called?");
      assert.notInclude(
        String(bodies[0].system || ""),
        PAST_CHAT_MESSAGE_TITLE,
        "no system message for past chats",
      );
    });
  });

  describe("pastChatHistoryCurrentMessage", function () {
    const message = { role: "user", timestamp: 5 };

    it("never passes the current message on a native Codex turn", function () {
      assert.isUndefined(pastChatHistoryCurrentMessage(true, message));
      assert.isUndefined(pastChatHistoryCurrentMessage(true, undefined));
    });

    it("passes it unchanged for every other system", function () {
      assert.strictEqual(
        pastChatHistoryCurrentMessage(false, message),
        message,
      );
      assert.isUndefined(pastChatHistoryCurrentMessage(false, undefined));
    });
  });

  it("gives a Codex conversation past chats only when includeCodex is set", async function () {
    const messages = [
      { role: "user", timestamp: 1, attachedConversations: [SHORT_REF] },
    ];
    const rawHistory: ChatMessage[] = [{ role: "user", content: "hi" }];
    const base = {
      conversationKey: 6_000_007_901,
      conversationSystem: "codex",
      libraryID: 1,
      messages,
      rawHistory,
      effectiveRequestConfig: CONFIG,
    };
    assert.strictEqual(
      await addAttachedPastChatsToSimpleChatHistory(base),
      rawHistory,
    );
  });
});
