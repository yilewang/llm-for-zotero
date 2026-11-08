import { assert } from "chai";
import { runCodexAppServerNativeTurn } from "./helpers/preparedNativeTurn";
import {
  createNativeLifecycleTestProcess,
  installDirectPathTestPrefs,
} from "./helpers/codexNativeLifecycle";
import {
  CodexAppServerProcess,
  destroyCachedCodexAppServerProcess,
} from "../src/utils/codexAppServerProcess";
import {
  insertCodexPastChatTurnInput,
  type CodexAppServerUserInput,
} from "../src/utils/codexAppServerInput";
import {
  addAttachedPastChatsToSimpleChatHistory,
  renderCodexCurrentTurnPastChatText,
} from "../src/modules/contextPanel/pastChatSimpleChatHistory";
import { clearPastChatRenderMemoForTests } from "../src/services/pastConversations/pastConversationLoader";
import {
  PAST_CHAT_MESSAGE_TITLE,
  readPastChatMessageSections,
} from "../src/services/pastConversations/pastConversationText";
import type { AttachedConversationRef } from "../src/shared/types";
import type { ChatMessage } from "../src/utils/llmClient";
import {
  createFakePastConversationSource,
  pastChatRows,
} from "./helpers/fakePastConversationSource";

/**
 * Codex receives attached past chats (step 4): the current turn's block goes
 * into the turn/start input, as its first text item (or right before the
 * latest "User:" item of a legacy flattened input); a thread seeded from chat
 * history gets the blocks of earlier attaching messages before them, and
 * never the current turn's block twice.
 */

const BLOCK = `${PAST_CHAT_MESSAGE_TITLE}\n\n### Past chat upstream:10\nTitle: Grid cells chat\n…`;

function textItems(input: unknown): string[] {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text));
}

describe("Codex: attached past chats", function () {
  describe("the turn input", function () {
    it("puts the block first in a turn input, before the context prefix", function () {
      const input: CodexAppServerUserInput[] = [
        {
          type: "text",
          text: "Zotero context for this turn\n…\nUser request:\nWhat did we find?",
        },
        { type: "image", url: "data:image/png;base64,AAAA" },
      ];
      const out = insertCodexPastChatTurnInput(input, BLOCK, {
        legacy: false,
      });
      assert.deepEqual(out, [{ type: "text", text: BLOCK }, ...input]);
    });

    it("puts the block right before the latest User item of a legacy input", function () {
      const input: CodexAppServerUserInput[] = [
        { type: "text", text: "System:\nrules" },
        { type: "text", text: "User:\nearlier" },
        { type: "text", text: "Assistant:\nanswer" },
        { type: "text", text: "User:\nWhat did we find?" },
        { type: "image", url: "data:image/png;base64,AAAA" },
      ];
      const out = insertCodexPastChatTurnInput(input, BLOCK, { legacy: true });
      assert.deepEqual(
        out.map((item) => (item.type === "text" ? item.text : item.type)),
        [
          "System:\nrules",
          "User:\nearlier",
          "Assistant:\nanswer",
          BLOCK,
          "User:\nWhat did we find?",
          "image",
        ],
      );
    });

    it("leaves the input as it was without a block", function () {
      const input: CodexAppServerUserInput[] = [{ type: "text", text: "Q" }];
      assert.strictEqual(
        insertCodexPastChatTurnInput(input, undefined, { legacy: false }),
        input,
      );
      assert.strictEqual(
        insertCodexPastChatTurnInput(input, "  ", { legacy: true }),
        input,
      );
    });
  });

  describe("the native turn", function () {
    async function runTurn(params: {
      processKey: string;
      storedThreadId?: string;
      messages: ChatMessage[];
      attachedPastChatText?: string;
      injectUnsupported?: boolean;
    }) {
      const requests: Array<{ method: string; params: Record<string, any> }> =
        [];
      const proc = createNativeLifecycleTestProcess({
        newThreadIds: [`${params.processKey}-thread`],
        requests,
        deltaForTurn: () => "answer",
      });
      if (params.injectUnsupported) proc.setInjectItemsSupport("unsupported");
      const restorePrefs = installDirectPathTestPrefs("off");
      const originalDB = (globalThis as any).Zotero.DB;
      (globalThis as any).Zotero.DB = { queryAsync: async () => [] };
      const originalSpawn = CodexAppServerProcess.spawn;
      CodexAppServerProcess.spawn = async () => proc;
      try {
        await runCodexAppServerNativeTurn({
          scope: {
            conversationKey: 6_000_007_401,
            libraryID: 1,
            kind: "global" as const,
          },
          model: "gpt-5.6",
          messages: params.messages,
          attachedPastChatText: params.attachedPastChatText,
          processKey: params.processKey,
          hooks: {
            loadProviderSessionId: async () => params.storedThreadId,
            persistProviderSessionId: async () => {},
          },
        });
      } finally {
        destroyCachedCodexAppServerProcess(params.processKey, proc);
        CodexAppServerProcess.spawn = originalSpawn;
        (globalThis as any).Zotero.DB = originalDB;
        restorePrefs();
      }
      const turnStart = requests.find(
        (request) => request.method === "turn/start",
      );
      const inject = requests.filter(
        (request) => request.method === "thread/inject_items",
      );
      return { turnStart, inject, requests };
    }

    it("sends the block first on a resumed thread, and nothing extra without one", async function () {
      const resumed = await runTurn({
        processKey: "codex-past-chat-resumed",
        storedThreadId: "codex-past-chat-stored-thread",
        messages: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
          { role: "user", content: "What did we find?" },
        ],
        attachedPastChatText: BLOCK,
      });
      assert.isTrue(
        resumed.requests.some((request) => request.method === "thread/resume"),
      );
      assert.lengthOf(resumed.inject, 0, "a resumed thread injects nothing");
      const texts = textItems(resumed.turnStart?.params.input);
      assert.equal(texts[0], BLOCK);
      assert.include(texts[texts.length - 1], "What did we find?");
      assert.equal(
        texts.filter((text) => text.includes(PAST_CHAT_MESSAGE_TITLE)).length,
        1,
      );

      const plain = await runTurn({
        processKey: "codex-past-chat-plain",
        storedThreadId: "codex-past-chat-stored-thread",
        messages: [{ role: "user", content: "What did we find?" }],
      });
      assert.notInclude(
        JSON.stringify(plain.turnStart?.params.input),
        PAST_CHAT_MESSAGE_TITLE,
      );
    });

    it("never puts the current block in the history it injects into a new thread", async function () {
      const olderBlock = `${PAST_CHAT_MESSAGE_TITLE}\n\n### Past chat upstream:5\nTitle: Older chat\n…`;
      const fresh = await runTurn({
        processKey: "codex-past-chat-new-thread",
        messages: [
          { role: "user", content: olderBlock },
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
          { role: "user", content: "What did we find?" },
        ],
        attachedPastChatText: BLOCK,
      });
      assert.lengthOf(fresh.inject, 1);
      const injected = JSON.stringify(fresh.inject[0].params.items);
      assert.include(injected, "### Past chat upstream:5", "older block kept");
      assert.notInclude(injected, "### Past chat upstream:10");
      const texts = textItems(fresh.turnStart?.params.input);
      assert.equal(texts[0], BLOCK);
      assert.include(texts[texts.length - 1], "What did we find?");
    });

    it("puts the block before the latest User item when inject_items is unsupported", async function () {
      const legacy = await runTurn({
        processKey: "codex-past-chat-legacy",
        messages: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
          { role: "user", content: "What did we find?" },
        ],
        attachedPastChatText: BLOCK,
        injectUnsupported: true,
      });
      assert.lengthOf(legacy.inject, 0);
      const texts = textItems(legacy.turnStart?.params.input);
      const blockIndex = texts.indexOf(BLOCK);
      assert.isAbove(blockIndex, 0, "not at the start of the transcript");
      assert.isTrue(texts[blockIndex + 1].startsWith("User:\n"));
      assert.include(texts[blockIndex + 1], "What did we find?");
      assert.isTrue(texts[blockIndex - 1].startsWith("Assistant:\n"));
    });
  });

  describe("the seeded history and the current block", function () {
    const SHORT: AttachedConversationRef = {
      system: "upstream",
      conversationKey: 10,
      conversationID: "conv-10",
      title: "Grid cells chat",
      libraryID: 1,
    };
    const LONG: AttachedConversationRef = {
      system: "claude_code",
      conversationKey: 20,
      conversationID: "conv-20",
      title: "Long chat",
      libraryID: 1,
    };
    const CONFIG = {
      model: "gpt-5.5",
      apiBase: "",
      providerProtocol: "codex_responses" as const,
      authMode: "codex_app_server" as const,
      advanced: undefined,
    };
    const source = () =>
      createFakePastConversationSource([
        {
          conversationKey: 10,
          entry: { title: "Grid cells chat" },
          messages: pastChatRows(4, (n) => `grid ${n}`),
        },
        {
          system: "claude_code",
          conversationKey: 20,
          entry: { title: "Long chat" },
          // About 15,000 tokens: an outline in agent mode.
          messages: pastChatRows(40, (n) => `long ${n} ${"w".repeat(1_500)}`),
        },
      ]);

    afterEach(function () {
      clearPastChatRenderMemoForTests();
    });

    it("renders the current block once and puts the same bytes before that message on a later seed", async function () {
      const fakeSource = source();
      const attachTurn = {
        role: "user" as const,
        timestamp: 300,
        attachedConversations: [SHORT, LONG],
      };
      // The attach turn: the history before it attaches nothing, so the
      // seeded history is unchanged and the block is the turn's alone.
      const earlier = [
        { role: "user" as const, timestamp: 100 },
        { role: "assistant" as const, timestamp: 101 },
      ];
      const earlierHistory: ChatMessage[] = [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ];
      const seeded = await addAttachedPastChatsToSimpleChatHistory({
        conversationKey: 6_000_007_402,
        conversationSystem: "codex",
        includeCodex: true,
        pastChatReadAvailable: true,
        libraryID: 1,
        messages: earlier,
        rawHistory: earlierHistory,
        effectiveRequestConfig: CONFIG,
        source: fakeSource,
      });
      assert.strictEqual(seeded, earlierHistory);
      const block = await renderCodexCurrentTurnPastChatText({
        conversationKey: 6_000_007_402,
        libraryID: 1,
        message: attachTurn,
        pastChatReadAvailable: true,
        effectiveRequestConfig: CONFIG,
        source: fakeSource,
      });
      assert.isString(block);
      assert.deepEqual(
        readPastChatMessageSections(block!).map((section) => section.id),
        ["upstream:10", "claude_code:20"],
      );
      assert.include(block!, "[message 2 · assistant]\ngrid 2", "full text");
      assert.include(
        block!,
        'past_chat_read (chat: "claude_code:20", message: <number>), or search with query.',
        "MCP on: the long chat is an outline the tool opens",
      );

      // A later turn seeds a new thread: the attach turn is history now, and
      // its block sits right before it with the same bytes.
      const later = await addAttachedPastChatsToSimpleChatHistory({
        conversationKey: 6_000_007_402,
        conversationSystem: "codex",
        includeCodex: true,
        pastChatReadAvailable: true,
        libraryID: 1,
        messages: [
          ...earlier,
          attachTurn,
          { role: "assistant", timestamp: 301 },
        ],
        rawHistory: [
          ...earlierHistory,
          { role: "user", content: "compare" },
          { role: "assistant", content: "compared" },
        ],
        effectiveRequestConfig: CONFIG,
        source: fakeSource,
      });
      assert.deepEqual(
        later.map((message) => message.content),
        ["q1", "a1", block, "compare", "compared"],
      );
    });

    it("trims the chats when the Zotero MCP tools are off", async function () {
      const block = await renderCodexCurrentTurnPastChatText({
        conversationKey: 6_000_007_403,
        libraryID: 1,
        message: {
          role: "user",
          timestamp: 400,
          attachedConversations: [LONG],
        },
        pastChatReadAvailable: false,
        effectiveRequestConfig: CONFIG,
        source: source(),
      });
      assert.isString(block);
      assert.include(block!, "The start of this chat was left out (");
      assert.notInclude(block!, "past_chat_read");
    });

    it("renders nothing for a message that attached nothing", async function () {
      const fakeSource = source();
      assert.isNull(
        await renderCodexCurrentTurnPastChatText({
          conversationKey: 6_000_007_404,
          libraryID: 1,
          message: { role: "user", timestamp: 500 },
          pastChatReadAvailable: true,
          effectiveRequestConfig: CONFIG,
          source: fakeSource,
        }),
      );
      assert.deepEqual(fakeSource.loads, []);
    });
  });
});
