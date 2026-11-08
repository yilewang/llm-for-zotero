import { assert } from "chai";
import { buildAgentRuntimeRequestForTests } from "../src/modules/contextPanel/chat";
import { chatHistory } from "../src/modules/contextPanel/state";
import { toAgentRuntimeRequestParams } from "../src/modules/contextPanel/requestContext";
import type {
  AttachedConversationRef,
  Message,
} from "../src/modules/contextPanel/types";

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

describe("attached past chats on the agent request", function () {
  const conversationKey = 7_301;
  let previousZotero: unknown;
  beforeEach(function () {
    previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: { get: () => null },
      Prefs: { get: () => undefined },
    };
  });
  afterEach(function () {
    chatHistory.delete(conversationKey);
    (globalThis as { Zotero?: unknown }).Zotero = previousZotero;
  });

  async function build(current: AttachedConversationRef[] | undefined) {
    return buildAgentRuntimeRequestForTests(
      toAgentRuntimeRequestParams(
        {
          selectedTexts: [],
          selectedPaperContexts: [],
          fullTextPaperContexts: [],
          attachedConversations: current,
          attachments: undefined,
          screenshots: undefined,
        },
        {
          conversationKey,
          item: {
            id: 9_001,
            libraryID: 1,
            isAttachment: () => false,
            isRegularItem: () => false,
            isNote: () => false,
          } as unknown as Zotero.Item,
          userText: "Compare with my earlier chats.",
          effectiveRequestConfig: {
            model: "test",
            apiBase: "https://example.invalid",
            apiKey: "test",
            authMode: "api_key",
            reasoning: undefined,
            advanced: undefined,
          },
          history: [],
        },
      ),
    );
  }

  it("carries the current message's chats and the conversation-wide scope", async function () {
    const many = Array.from({ length: 5 }, (_, index) => ({
      role: "user" as const,
      text: `question ${index}`,
      timestamp: 10 + index,
      attachedConversations: [
        ref(100 + index * 2),
        ref(101 + index * 2),
        ref(1, { title: "Repeated" }),
      ],
    })) as Message[];
    chatHistory.set(conversationKey, [
      ...many,
      { role: "assistant", text: "answer", timestamp: 30 } as Message,
      {
        role: "user",
        text: "Compare with my earlier chats.",
        timestamp: 40,
        attachedConversations: [ref(2), ref(100)],
      } as Message,
    ]);
    const request = await build([ref(2), ref(100)]);
    assert.deepEqual(
      request.attachedConversations?.map((entry) => entry.conversationKey),
      [2, 100],
    );
    const scope = request.attachedConversationScope || [];
    assert.lengthOf(scope, 12, "no cap on the union; one entry per chat");
    assert.deepEqual(
      scope.slice(0, 3).map((entry) => entry.conversationKey),
      [100, 101, 1],
    );
    assert.equal(
      new Set(scope.map((entry) => `${entry.system}:${entry.conversationKey}`))
        .size,
      scope.length,
    );
  });

  it("keeps the scope of earlier messages when the current message attaches nothing", async function () {
    chatHistory.set(conversationKey, [
      {
        role: "user",
        text: "first",
        timestamp: 1,
        attachedConversations: [ref(5, { system: "claude_code" })],
      } as Message,
      { role: "assistant", text: "a", timestamp: 2 } as Message,
      { role: "user", text: "second", timestamp: 3 } as Message,
    ]);
    const request = await build(undefined);
    assert.isUndefined(request.attachedConversations);
    assert.deepEqual(
      request.attachedConversationScope?.map(
        (entry) => `${entry.system}:${entry.conversationKey}`,
      ),
      ["claude_code:5"],
    );
  });

  it("sets neither field in a conversation that never attached a chat", async function () {
    chatHistory.set(conversationKey, [
      { role: "user", text: "hello", timestamp: 1 } as Message,
    ]);
    const request = await build(undefined);
    assert.isUndefined(request.attachedConversations);
    assert.isUndefined(request.attachedConversationScope);
  });
});
