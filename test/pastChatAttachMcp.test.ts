import { assert } from "chai";
import {
  getOrCreateZoteroMcpBearerToken,
  registerMcpServer,
  registerScopedZoteroMcpScope,
  unregisterMcpServer,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_EXCLUDED_TOOL_NAMES,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createPastChatReadTool } from "../src/agent/tools/read/pastChatRead";
import { createPastChatSearchTool } from "../src/agent/tools/read/pastChatSearch";
import { createPastChatAttachTool } from "../src/agent/tools/control/pastChatAttach";
import {
  setPastChatAttachHandler,
  type PastChatAttachRequest,
} from "../src/services/pastConversations/attachSink";
import { clearPastChatRenderMemoForTests } from "../src/services/pastConversations/pastConversationLoader";
import { createPastChatAttachHandler } from "../src/modules/contextPanel/pastChatAttachHandler";
import type { Message } from "../src/modules/contextPanel/types";
import type { AttachedConversationRef } from "../src/shared/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import {
  createFakePastConversationSource,
  pastChatRows,
} from "./helpers/fakePastConversationSource";

/**
 * past_chat_search and past_chat_attach over the Zotero MCP bridge (Codex
 * and Claude Code): both always listed and auto-approved, pinned to the
 * scope's library; an attach reaches the panel through the same sink as the
 * built-in agent and extends the scope token, so a later call of the turn
 * can open the chat.
 */

type EndpointReply = [number, string, string];

const CONVERSATION_KEY = 8_811;
const USER_TS = 9_000;

function ref(conversationKey: number): AttachedConversationRef {
  return {
    system: "upstream",
    conversationKey,
    conversationID: `conv-${conversationKey}`,
    title: `Chat ${conversationKey}`,
    libraryID: 1,
  };
}

async function invoke(params: {
  body: Record<string, unknown>;
  scopeToken?: string;
}): Promise<Record<string, any>> {
  const EndpointClass = (
    globalThis.Zotero.Server.Endpoints as Record<string, any>
  )[ZOTERO_MCP_ENDPOINT_PATH];
  const reply: EndpointReply = await new EndpointClass().init({
    method: "POST",
    data: params.body,
    headers: {
      Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
      ...(params.scopeToken
        ? { [ZOTERO_MCP_SCOPE_HEADER]: params.scopeToken }
        : {}),
    },
  });
  return JSON.parse(reply[2]);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  scopeToken?: string,
): Promise<Record<string, any>> {
  const payload = await invoke({
    scopeToken,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  const text = payload.result?.content?.[0]?.text;
  assert.isString(text, JSON.stringify(payload));
  const parsed = JSON.parse(text);
  return parsed.result ?? parsed;
}

describe("past_chat_search and past_chat_attach over the Zotero MCP bridge", function () {
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();
  let slowLoads: Set<number>;
  const baseSource = createFakePastConversationSource([
    {
      conversationKey: 10,
      entry: { title: "Grid cells chat" },
      messages: pastChatRows(4, (n) =>
        n === 2 ? "Grid cells fire on a hexagonal lattice." : `grid turn ${n}`,
      ),
    },
    {
      conversationKey: 11,
      entry: { title: "Place cells chat" },
      messages: pastChatRows(4, (n) => `place turn ${n}`),
    },
    {
      // The calling Codex conversation itself: never listed.
      system: "codex",
      conversationKey: CONVERSATION_KEY,
      entry: { title: "Current codex grid chat" },
      messages: pastChatRows(2, (n) => `grid now ${n}`),
    },
    {
      conversationKey: 12,
      entry: { title: "Other library grid", libraryID: 2 },
      messages: pastChatRows(2, (n) => `grid elsewhere ${n}`),
    },
  ]);
  // Reads of a chat in slowLoads take a while, so an attach can finish
  // while a read is still running.
  const source = {
    ...baseSource,
    async loadMessages(target: Parameters<typeof baseSource.loadMessages>[0]) {
      if (slowLoads.has(target.conversationKey)) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return baseSource.loadMessages(target);
    },
  };
  let history: Message[];
  let attachRequests: PastChatAttachRequest[];

  beforeEach(function () {
    prefStore.clear();
    slowLoads = new Set();
    clearPastChatRenderMemoForTests();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: {
        get: (key: string) =>
          key === "httpServer.port" ? 24680 : prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
      Libraries: { userLibraryID: 1 },
      getActiveZoteroPane: () => ({
        getSelectedLibraryIDs: () => [1],
        getSelectedItems: () => [],
      }),
      Items: { get: () => null },
      Server: { Endpoints: {} },
    } as unknown as typeof Zotero;
    const registry = new AgentToolRegistry();
    registry.register(createPastChatReadTool(source));
    registry.register(createPastChatSearchTool(source));
    registry.register(createPastChatAttachTool(source));
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
    history = [
      { role: "user", text: "find the grid chat", timestamp: USER_TS },
    ];
    attachRequests = [];
    setPastChatAttachHandler(
      createPastChatAttachHandler({
        getHistory: (key) => (key === CONVERSATION_KEY ? history : undefined),
        isTemporaryConversation: () => false,
        persistUserMessage: async (request) => {
          attachRequests.push(request);
        },
        refreshConversation: () => undefined,
      }),
    );
  });

  afterEach(function () {
    setPastChatAttachHandler(null);
    unregisterMcpServer();
    clearPastChatRenderMemoForTests();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  function registerScope(
    token: string,
    overrides: Record<string, unknown> = {},
  ) {
    return registerScopedZoteroMcpScope(
      {
        runtimeAuthority: "codex",
        conversationKey: CONVERSATION_KEY,
        libraryID: 1,
        kind: "global",
        sourceMessageTimestamp: USER_TS,
        ...overrides,
      },
      { token },
    );
  }

  it("lists both tools as safe reads for both runtimes, with no exclusion", async function () {
    for (const name of ["past_chat_search", "past_chat_attach"]) {
      assert.include(
        ZOTERO_MCP_SAFE_READ_TOOL_NAMES as readonly string[],
        name,
      );
      assert.notProperty(ZOTERO_MCP_EXCLUDED_TOOL_NAMES, name);
    }
    const scope = registerScope("past-chat-attach-list");
    try {
      const payload = await invoke({
        scopeToken: scope.token,
        body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      });
      const names = (payload.result.tools as Array<{ name: string }>).map(
        (tool) => tool.name,
      );
      assert.includeMembers(names, ["past_chat_search", "past_chat_attach"]);
    } finally {
      scope.clear();
    }
  });

  it("searches the scope's library and leaves out the calling conversation by its system", async function () {
    const scope = registerScope("past-chat-search-scope");
    try {
      const result = await callTool(
        "past_chat_search",
        { query: "grid" },
        scope.token,
      );
      assert.isTrue(result.ok, JSON.stringify(result));
      assert.deepEqual(
        result.chats.map((entry: { chat: string }) => entry.chat),
        ["upstream:10"],
      );
      const other = await callTool(
        "past_chat_search",
        { query: "grid", libraryID: 2 },
        scope.token,
      );
      assert.isFalse(other.ok);
      assert.match(other.error, /^Only past chats from this library/);
    } finally {
      scope.clear();
    }
  });

  it("attaches through the panel's sink, and a later call of the same scope opens the chat", async function () {
    const scope = registerScope("past-chat-attach-then-read");
    try {
      const before = await callTool(
        "past_chat_read",
        { chat: "upstream:10" },
        scope.token,
      );
      assert.isFalse(before.ok);
      const attached = await callTool(
        "past_chat_attach",
        { chat: "upstream:10" },
        scope.token,
      );
      assert.isTrue(attached.ok, JSON.stringify(attached));
      assert.include(
        attached.pastChat,
        "Grid cells fire on a hexagonal lattice.",
      );
      assert.lengthOf(attachRequests, 1);
      assert.equal(attachRequests[0].conversationSystem, "codex");
      assert.equal(attachRequests[0].userMessageTimestamp, USER_TS);
      assert.equal(history[0].attachedConversations?.[0]?.via, "agent");
      const read = await callTool(
        "past_chat_read",
        { chat: "upstream:10", message: 2 },
        scope.token,
      );
      assert.isTrue(read.ok, JSON.stringify(read));
      assert.equal(
        read.messages[0].text,
        "Grid cells fire on a hexagonal lattice.",
      );
    } finally {
      scope.clear();
    }
  });

  it("a slower read running during an attach does not take the attach back", async function () {
    const scope = registerScope("past-chat-attach-concurrent", {
      attachedConversationScope: [ref(11)],
    });
    slowLoads.add(11);
    try {
      const [read, attached] = await Promise.all([
        callTool("past_chat_read", { chat: "upstream:11" }, scope.token),
        callTool("past_chat_attach", { chat: "upstream:10" }, scope.token),
      ]);
      assert.isTrue(read.ok, JSON.stringify(read));
      assert.isTrue(attached.ok, JSON.stringify(attached));
      const later = await callTool(
        "past_chat_read",
        { chat: "upstream:10" },
        scope.token,
      );
      assert.isTrue(later.ok, JSON.stringify(later));
      const stillThere = await callTool(
        "past_chat_read",
        { chat: "upstream:11" },
        scope.token,
      );
      assert.isTrue(stillThere.ok);
    } finally {
      scope.clear();
    }
  });

  it("refuses an attach without a conversation or user message, and from another library", async function () {
    const noTimestamp = registerScope("past-chat-attach-no-ts", {
      sourceMessageTimestamp: undefined,
    });
    const scope = registerScope("past-chat-attach-library");
    try {
      const provisional = await callTool(
        "past_chat_attach",
        { chat: "upstream:10" },
        noTimestamp.token,
      );
      assert.isFalse(provisional.ok);
      assert.match(provisional.error, /only in a conversation in Zotero/);
      const headerless = await callTool("past_chat_attach", {
        chat: "upstream:10",
      });
      assert.isFalse(headerless.ok);
      assert.match(headerless.error, /only in a conversation in Zotero/);
      const otherLibrary = await callTool(
        "past_chat_attach",
        { chat: "upstream:12" },
        scope.token,
      );
      assert.isFalse(otherLibrary.ok);
      assert.match(otherLibrary.error, /^Only past chats from this library/);
      const pinned = await callTool(
        "past_chat_attach",
        { chat: "upstream:12", libraryID: 2 },
        scope.token,
      );
      assert.isFalse(pinned.ok);
      assert.lengthOf(attachRequests, 0);
      assert.isUndefined(history[0].attachedConversations);
    } finally {
      noTimestamp.clear();
      scope.clear();
    }
  });
});
