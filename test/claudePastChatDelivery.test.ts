import { assert } from "chai";
import {
  PAST_CHAT_MESSAGE_TITLE,
  isSlashCommandText,
  normalizeAttachedConversationScope,
  readPastChatMessageSections,
  resolveDeliveredPastChatRefs,
} from "../src/services/pastConversations/pastConversationText";
import { clearPastChatRenderMemoForTests } from "../src/services/pastConversations/pastConversationLoader";
import {
  injectAttachedPastChatsIntoAgentHistory,
  resolveCurrentTurnDeliveredPastChats,
} from "../src/modules/contextPanel/agentMode/pastChatHistory";
import { buildClaudeBridgeUserTextForTests } from "../src/agent/externalBackendBridge";
import type { AttachedConversationRef } from "../src/shared/types";
import type { ChatMessage } from "../src/utils/llmClient";
import { createFakePastConversationSource } from "./helpers/fakePastConversationSource";

/**
 * Claude Code receives attached past chats as a prefix of the turn's text
 * (step 5). A slash message is a Claude Code command and carries nothing;
 * the next non-slash turn carries its chats. The resume-fallback history
 * puts each block before the message that delivered it, by the same rule
 * (resolveDeliveredPastChatRefs) and the same render memo.
 */

function ref(conversationKey: number, title: string): AttachedConversationRef {
  return {
    system: "upstream",
    conversationKey,
    conversationID: `conv-${conversationKey}`,
    title,
    libraryID: 1,
  };
}

const A = ref(1, "Chat A");
const B = ref(2, "Chat B");
const C = ref(3, "Chat C");
const D = ref(4, "Chat D");

const CONVERSATION_KEY = 7_401;
const CONFIG = {
  model: "claude-sonnet-4-5",
  apiBase: "",
  providerProtocol: undefined,
  authMode: "api_key" as const,
  advanced: undefined,
};

type Row = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  attachedConversations?: AttachedConversationRef[];
};

/** Stored rows before the current turn: one attach, then two slash turns. */
const STORED: Row[] = [
  { role: "user", text: "first", timestamp: 100, attachedConversations: [A] },
  { role: "assistant", text: "answer 1", timestamp: 101 },
  {
    role: "user",
    text: "/review the plan",
    timestamp: 200,
    attachedConversations: [B],
  },
  { role: "assistant", text: "review output", timestamp: 201 },
  { role: "user", text: "/cost", timestamp: 300, attachedConversations: [C] },
  { role: "assistant", text: "cost output", timestamp: 301 },
];

/** The current (non-slash) turn: attaches D, carries B and C. */
const CURRENT = {
  text: "Compare them",
  timestamp: 400,
  attachedConversations: [D],
};

function source() {
  return createFakePastConversationSource(
    [A, B, C, D].map((entry) => ({
      conversationKey: entry.conversationKey,
      entry: { title: entry.title },
      messages: [
        {
          role: "user",
          text: `question in ${entry.title}`,
          timestamp: 1,
        },
        {
          role: "assistant",
          text: `answer in ${entry.title}`,
          timestamp: 2,
        },
      ],
    })),
  );
}

function toHistory(rows: readonly Row[]): ChatMessage[] {
  return rows.map((row) => ({ role: row.role, content: row.text }));
}

function contentText(message: ChatMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

function sectionIds(text: string): string[] {
  return readPastChatMessageSections(text).map((section) => section.id);
}

describe("Claude Code: attached past chats", function () {
  afterEach(function () {
    clearPastChatRenderMemoForTests();
  });

  describe("which turn delivers which chat", function () {
    it("treats a message whose trimmed text starts with / as a slash command", function () {
      assert.isTrue(isSlashCommandText("/compact"));
      assert.isTrue(isSlashCommandText("  /review x"));
      assert.isFalse(isSlashCommandText("a / b"));
      assert.isFalse(isSlashCommandText(undefined));
    });

    it("gives a slash message nothing and the next non-slash message the run's chats", function () {
      const messages = [...STORED, { role: "user", ...CURRENT }];
      const ids = messages.map((_message, index) =>
        resolveDeliveredPastChatRefs(messages, index, "claude_code").map(
          (entry) => entry.conversationKey,
        ),
      );
      assert.deepEqual(ids, [[1], [], [], [], [], [], [4, 2, 3]]);
    });

    it("stops the carried run at the previous non-slash message", function () {
      const messages = [
        { role: "user", text: "/a", attachedConversations: [A] },
        { role: "user", text: "plain", attachedConversations: [] },
        { role: "user", text: "/b", attachedConversations: [B] },
        { role: "user", text: "next" },
      ];
      assert.deepEqual(
        resolveDeliveredPastChatRefs(messages, 1, "claude_code").map(
          (entry) => entry.conversationKey,
        ),
        [1],
      );
      assert.deepEqual(
        resolveDeliveredPastChatRefs(messages, 3, "claude_code").map(
          (entry) => entry.conversationKey,
        ),
        [2],
      );
    });

    it("dedupes a chat attached twice, the current message first", function () {
      const messages = [
        { role: "user", text: "/a", attachedConversations: [A, B] },
        { role: "user", text: "next", attachedConversations: [B] },
      ];
      assert.deepEqual(
        resolveDeliveredPastChatRefs(messages, 1, "claude_code").map(
          (entry) => entry.conversationKey,
        ),
        [2, 1],
      );
    });

    it("gives the built-in agent and Codex each message's own chats", function () {
      const messages = [...STORED, { role: "user", ...CURRENT }];
      for (const system of ["upstream", "codex"]) {
        assert.deepEqual(
          resolveDeliveredPastChatRefs(messages, 2, system).map(
            (entry) => entry.conversationKey,
          ),
          [2],
        );
        assert.deepEqual(
          resolveDeliveredPastChatRefs(messages, 6, system).map(
            (entry) => entry.conversationKey,
          ),
          [4],
        );
      }
    });

    it("keeps more than three carried chats (no per-message cap on the union)", function () {
      const many = [1, 2, 3, 4, 5].map((key) => ref(key, `Chat ${key}`));
      assert.lengthOf(normalizeAttachedConversationScope(many), 5);
      assert.deepEqual(normalizeAttachedConversationScope("x"), []);
    });
  });

  describe("current-turn prefix and resume-fallback history on one fixture", function () {
    it("carries the slash run's chats on the current turn only, and never twice", async function () {
      const fakeSource = source();
      // The send path: the turn's history source is the stored rows; the
      // runtime userText is the question.
      const delivered = resolveCurrentTurnDeliveredPastChats({
        conversationSystem: "claude_code",
        history: STORED,
        current: CURRENT,
      });
      assert.deepEqual(
        delivered?.map((entry) => entry.conversationKey),
        [4, 2, 3],
      );
      const userText = await buildClaudeBridgeUserTextForTests(
        {
          conversationKey: CONVERSATION_KEY,
          mode: "agent",
          userText: CURRENT.text,
          libraryID: 1,
          ...CONFIG,
          deliveredConversations: delivered,
          metadata: { sourceMessageTimestamp: CURRENT.timestamp },
        },
        fakeSource,
      );
      assert.isTrue(userText.startsWith(PAST_CHAT_MESSAGE_TITLE));
      assert.isTrue(userText.endsWith(`\n\n${CURRENT.text}`));
      const prefix = userText.slice(0, -`\n\n${CURRENT.text}`.length);
      assert.deepEqual(sectionIds(prefix), [
        "upstream:4",
        "upstream:2",
        "upstream:3",
      ]);

      // Resume fallback on this turn: the history holds only the stored
      // rows; A's block sits before the message that attached it and
      // nothing sits before a slash message.
      const fallback = await injectAttachedPastChatsIntoAgentHistory({
        conversationKey: CONVERSATION_KEY,
        conversationSystem: "claude_code",
        libraryID: 1,
        messages: STORED,
        history: toHistory(STORED),
        effectiveRequestConfig: CONFIG,
        source: fakeSource,
      });
      assert.deepEqual(
        fallback.map((message) =>
          contentText(message).startsWith(PAST_CHAT_MESSAGE_TITLE)
            ? sectionIds(contentText(message)).join(",")
            : contentText(message),
        ),
        [
          "upstream:1",
          "first",
          "answer 1",
          "/review the plan",
          "review output",
          "/cost",
          "cost output",
        ],
      );
      const fallbackText = fallback.map(contentText).join("\n");
      for (const carried of ["upstream:2", "upstream:3", "upstream:4"]) {
        assert.notInclude(
          fallbackText,
          `### Past chat ${carried}\n`,
          "the current turn's chats travel in its prefix only",
        );
      }

      // The next turn's fallback replays the current turn, now stored, with
      // the exact bytes its prefix sent, right before it.
      const nextTurn = await injectAttachedPastChatsIntoAgentHistory({
        conversationKey: CONVERSATION_KEY,
        conversationSystem: "claude_code",
        libraryID: 1,
        messages: [
          ...STORED,
          { role: "user", ...CURRENT },
          { role: "assistant", text: "compared", timestamp: 401 },
        ],
        history: toHistory([
          ...STORED,
          { role: "user", ...CURRENT },
          { role: "assistant", text: "compared", timestamp: 401 },
        ]),
        effectiveRequestConfig: CONFIG,
        source: fakeSource,
      });
      const currentIndex = nextTurn.findIndex(
        (message) => contentText(message) === CURRENT.text,
      );
      assert.equal(contentText(nextTurn[currentIndex - 1]), prefix);
      assert.equal(
        nextTurn.filter((message) =>
          contentText(message).startsWith(PAST_CHAT_MESSAGE_TITLE),
        ).length,
        2,
      );
    });

    it("sends a slash message bare, and nothing when no chat is delivered", async function () {
      const fakeSource = source();
      const slashDelivered = resolveCurrentTurnDeliveredPastChats({
        conversationSystem: "claude_code",
        history: STORED,
        current: { text: "/compact", attachedConversations: [D] },
      });
      assert.isUndefined(slashDelivered);
      const slashText = await buildClaudeBridgeUserTextForTests(
        {
          conversationKey: CONVERSATION_KEY,
          mode: "agent",
          userText: "/review again",
          libraryID: 1,
          ...CONFIG,
          // Even a stray list never prefixes a slash message.
          deliveredConversations: [D],
          metadata: { sourceMessageTimestamp: 500 },
        },
        fakeSource,
      );
      assert.equal(slashText, "/review again");
      const plain = await buildClaudeBridgeUserTextForTests(
        {
          conversationKey: CONVERSATION_KEY,
          mode: "agent",
          userText: "Plain question",
          libraryID: 1,
          ...CONFIG,
        },
        fakeSource,
      );
      assert.equal(plain, "Plain question");
      assert.deepEqual(fakeSource.loads, []);
      assert.isUndefined(
        resolveCurrentTurnDeliveredPastChats({
          conversationSystem: "upstream",
          history: STORED,
          current: CURRENT,
        }),
        "only Claude Code turns get a prefix",
      );
    });
  });
});
