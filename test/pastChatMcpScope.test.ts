import { assert } from "chai";
import {
  getOrCreateZoteroMcpBearerToken,
  registerMcpServer,
  registerScopedZoteroMcpScope,
  unregisterMcpServer,
  updateScopedZoteroMcpScope,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_EXCLUDED_TOOL_NAMES,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createPastChatReadTool } from "../src/agent/tools/read/pastChatRead";
import { buildCodexNativeScopedMcpScopeForTests } from "../src/codexAppServer/nativeClient";
import { buildClaudeZoteroMcpScopeForTests } from "../src/agent/externalBackendBridge";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import type { AttachedConversationRef } from "../src/shared/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import {
  createFakePastConversationSource,
  pastChatRows,
} from "./helpers/fakePastConversationSource";

/**
 * past_chat_read over the Zotero MCP bridge (Codex and Claude Code): always
 * listed, scoped to the chats attached in the calling conversation (from the
 * host-registered MCP scope, never from tool arguments), and pinned to the
 * scope's library.
 */

type EndpointReply = [number, string, string];

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

async function callPastChatRead(
  args: Record<string, unknown>,
  scopeToken?: string,
): Promise<Record<string, any>> {
  const payload = await invoke({
    scopeToken,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "past_chat_read", arguments: args },
    },
  });
  const text = payload.result?.content?.[0]?.text;
  assert.isString(text, JSON.stringify(payload));
  const parsed = JSON.parse(text);
  // A refusal is the tool's own result, wrapped like any tool result.
  return parsed.result ?? parsed;
}

describe("past_chat_read over the Zotero MCP bridge", function () {
  const originalZotero = globalThis.Zotero;
  const prefStore = new Map<string, unknown>();
  const source = createFakePastConversationSource([
    {
      conversationKey: 10,
      entry: { title: "Grid cells chat" },
      messages: pastChatRows(6, (n) => `message ${n}`),
    },
    ...[11, 12, 13, 14].map((conversationKey) => ({
      conversationKey,
      entry: { title: `Chat ${conversationKey}` },
      messages: pastChatRows(2),
    })),
  ]);

  beforeEach(function () {
    prefStore.clear();
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
      // The library selected in Zotero is 1: a headerless call must still
      // not reach a chat through it.
      getActiveZoteroPane: () => ({
        getSelectedLibraryIDs: () => [1],
        getSelectedItems: () => [],
      }),
      Items: { get: () => null },
      Server: { Endpoints: {} },
    } as unknown as typeof Zotero;
    const registry = new AgentToolRegistry();
    registry.register(createPastChatReadTool(source));
    registerMcpServer({ toolRegistry: registry, zoteroGateway: {} as never });
  });

  afterEach(function () {
    unregisterMcpServer();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  function registerScope(
    attachedConversationScope: AttachedConversationRef[] | undefined,
    token: string,
  ) {
    return registerScopedZoteroMcpScope(
      {
        runtimeAuthority: "codex",
        conversationKey: 8_801,
        libraryID: 1,
        kind: "global",
        ...(attachedConversationScope ? { attachedConversationScope } : {}),
      },
      { token },
    );
  }

  it("is a safe read on the curated list, not an exclusion, and is always listed", async function () {
    assert.include(
      ZOTERO_MCP_SAFE_READ_TOOL_NAMES as readonly string[],
      "past_chat_read",
    );
    assert.notProperty(ZOTERO_MCP_EXCLUDED_TOOL_NAMES, "past_chat_read");
    for (const scopeToken of [undefined, "past-chat-list-scope"]) {
      const scope = scopeToken ? registerScope(undefined, scopeToken) : null;
      try {
        const payload = await invoke({
          scopeToken,
          body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        });
        const names = (payload.result.tools as Array<{ name: string }>).map(
          (tool) => tool.name,
        );
        assert.include(names, "past_chat_read", String(scopeToken));
      } finally {
        scope?.clear();
      }
    }
  });

  it("opens a chat in the scope, also after the host updates the scope mid-turn", async function () {
    const scope = registerScope([ref(10)], "past-chat-in-scope");
    try {
      const outline = await callPastChatRead(
        { chat: "upstream:10" },
        scope.token,
      );
      assert.isTrue(outline.ok, JSON.stringify(outline));
      assert.equal(outline.title, "Grid cells chat");
      // updateScopedZoteroMcpScope normalizes the scope again: the list must
      // survive it.
      updateScopedZoteroMcpScope(scope.token, { runId: "run-after-start" });
      const read = await callPastChatRead(
        { chat: "upstream:10", message: 2 },
        scope.token,
      );
      assert.isTrue(read.ok, JSON.stringify(read));
      assert.equal(read.messages[0].text, "message 2");
      const search = await callPastChatRead(
        { chat: "upstream:10", query: "message 5" },
        scope.token,
      );
      assert.isTrue(search.ok, JSON.stringify(search));
      assert.deepEqual(
        search.matches.map((match: { message: number }) => match.message),
        [5],
      );
    } finally {
      scope.clear();
    }
  });

  it("keeps every attached chat readable: no cap of three on the scope", async function () {
    const scope = registerScope(
      [ref(10), ref(11), ref(12), ref(13), ref(14)],
      "past-chat-five",
    );
    try {
      const result = await callPastChatRead(
        { chat: "upstream:14" },
        scope.token,
      );
      assert.isTrue(result.ok, JSON.stringify(result));
      assert.equal(result.title, "Chat 14");
    } finally {
      scope.clear();
    }
  });

  it("refuses a chat outside the scope, a scope without chats, and a headerless call", async function () {
    const scoped = registerScope([ref(10)], "past-chat-outside");
    const empty = registerScope(undefined, "past-chat-empty");
    try {
      const outside = await callPastChatRead(
        { chat: "upstream:11" },
        scoped.token,
      );
      assert.isFalse(outside.ok);
      assert.match(outside.error, /was not attached in this conversation/);
      const none = await callPastChatRead({ chat: "upstream:10" }, empty.token);
      assert.isFalse(none.ok);
      assert.match(none.error, /No past chat is attached/);
      const headerless = await callPastChatRead({ chat: "upstream:10" });
      assert.isFalse(headerless.ok);
      assert.match(headerless.error, /No past chat is attached/);
    } finally {
      scoped.clear();
      empty.clear();
    }
  });

  it("refuses a libraryID argument other than the scope's library", async function () {
    const scope = registerScope([ref(10)], "past-chat-other-library");
    try {
      const result = await callPastChatRead(
        { chat: "upstream:10", libraryID: 2 },
        scope.token,
      );
      assert.isFalse(result.ok);
      assert.match(result.error, /^Only past chats from this library/);
    } finally {
      scope.clear();
    }
  });

  it("refuses an explicit libraryID that matches the chat but not the scope", async function () {
    const scope = registerScope(
      [ref(10, { libraryID: 2 })],
      "past-chat-bypass-library",
    );
    try {
      const result = await callPastChatRead(
        { chat: "upstream:10", libraryID: 2 },
        scope.token,
      );
      assert.isFalse(result.ok, JSON.stringify(result));
      assert.match(result.error, /libraryID 2 is not the conversation's/);
    } finally {
      scope.clear();
    }
  });

  it("is given the conversation's chats by both scope builders", function () {
    const attached = [ref(10), ref(11, { system: "codex" })];
    const request = resolveAgentRuntimeRequest({
      conversationKey: 8_802,
      mode: "agent",
      userText: "compare",
      libraryID: 1,
      attachedConversationScope: attached,
    });
    const codexScope = buildCodexNativeScopedMcpScopeForTests({
      preparedRequest: request,
      scope: { conversationKey: 8_802, libraryID: 1, kind: "global" },
      profileSignature: "profile-past-chat",
      userText: "compare",
    });
    assert.deepEqual(codexScope.attachedConversationScope, attached);
    const claudeScope = buildClaudeZoteroMcpScopeForTests(
      {
        conversationKey: 8_802,
        mode: "agent",
        userText: "compare",
        libraryID: 1,
        attachedConversationScope: attached,
      },
      "profile-past-chat",
    );
    assert.deepEqual(claudeScope.attachedConversationScope, attached);
  });
});
