import { assert } from "chai";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../src/agent/mcp/server";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

/**
 * past_chat_read opens the conversation it is called from, up to the turn
 * being answered. A runtime whose new session got only the newest messages
 * of a long chat (agent/context/runtimeHistory.ts) reads the older ones
 * this way; a retry never reads the answer it replaces. Called through the
 * installed plugin's MCP endpoint, under a turn's scope, as Claude Code,
 * Codex and Antigravity call it.
 */
describe("workflow: past_chat_read on the current conversation", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest as WorkflowTestApi;
    await api.reset();
  });

  afterEach(async function () {
    if (fixture) await api.cleanupFixture(fixture);
    fixture = null;
    await api.reset();
  });

  async function callPastChatRead(
    token: string,
    args: Record<string, unknown>,
  ): Promise<any> {
    const EndpointClass = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
    const [status, , body] = await new EndpointClass().init({
      method: "POST",
      headers: {
        Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
        [ZOTERO_MCP_SCOPE_HEADER]: token,
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "past_chat_read", arguments: args },
      },
    });
    assert.equal(status, 200);
    const response = JSON.parse(body);
    return JSON.parse(response.result.content[0].text).result;
  }

  it("reads this conversation's messages before the turn, and none from it on", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Current chat read fixture",
      pages: ["A disposable paper."],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const first = await api.seedPanelStoredTurn(
      panel.panelId,
      "OLDEST what was the lab rat called?",
      "The rat was named BISCUIT.",
    );
    await api.seedPanelStoredTurn(
      panel.panelId,
      "MIDDLE and the mouse?",
      "The mouse was named PEPPER.",
    );
    // The turn being answered now, as on a retry: its stored answer is the
    // one the retry replaces.
    const current = await api.seedPanelStoredTurn(
      panel.panelId,
      "NEWEST pick a number",
      "REPLACED-ANSWER 417",
    );
    const key = first.conversationKey;
    const paper = Zotero.Items.get(fixture.parentItemId);
    const chat = `upstream:${key}`;
    const scope = api.registerScopedMcpScope({
      conversationKey: key,
      libraryID: paper.libraryID,
      kind: "paper",
      runId: `current-chat-read:${Date.now()}`,
      runtimeAuthority: "claude",
      sourceMessageTimestamp: current.userTimestamp,
    });
    const untimed = api.registerScopedMcpScope({
      conversationKey: key,
      libraryID: paper.libraryID,
      kind: "paper",
      runId: `current-chat-read-untimed:${Date.now()}`,
      runtimeAuthority: "claude",
    });
    try {
      const outline = await callPastChatRead(scope.token, { chat });
      assert.isTrue(outline.ok, JSON.stringify(outline));
      assert.equal(outline.totalMessages, 4, JSON.stringify(outline));
      const questions = (outline.questions as Array<{ preview: string }>).map(
        (entry) => entry.preview,
      );
      assert.isTrue(
        questions.some((text) => text.includes("OLDEST")),
        JSON.stringify(questions),
      );
      assert.isFalse(
        questions.some((text) => text.includes("NEWEST")),
        JSON.stringify(questions),
      );

      const read = await callPastChatRead(scope.token, { chat, message: 1 });
      const text = (read.messages as Array<{ text: string }>)
        .map((entry) => entry.text)
        .join("\n");
      assert.include(text, "BISCUIT");
      assert.include(text, "PEPPER");
      assert.notInclude(text, "REPLACED-ANSWER");

      const search = await callPastChatRead(scope.token, {
        chat,
        query: "REPLACED-ANSWER",
      });
      assert.equal(search.totalMatches, 0, JSON.stringify(search));

      // Without the turn's time there is no way to leave the turn out.
      const refused = await callPastChatRead(untimed.token, { chat });
      assert.isFalse(refused.ok, JSON.stringify(refused));

      // Another chat is still readable only once attached.
      const other = await callPastChatRead(scope.token, {
        chat: `upstream:${key + 1}`,
      });
      assert.isFalse(other.ok, JSON.stringify(other));
    } finally {
      api.clearScopedMcpScope(scope.token);
      api.clearScopedMcpScope(untimed.token);
    }
  });
  it("reaches the oldest messages of a chat longer than any fixed window", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Long current chat read fixture",
      pages: ["A disposable paper."],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const first = await api.seedPanelStoredTurn(
      panel.panelId,
      "OLDEST-QUESTION what was the lab rat called?",
      "OLDEST-ANSWER the rat was named BISCUIT.",
    );
    const key = first.conversationKey;
    // 460 more messages after it, then the turn being answered.
    const filler: Array<{
      role: "user" | "assistant";
      text: string;
      timestamp: number;
    }> = [];
    let time = first.userTimestamp + 1_000;
    for (let turn = 0; turn < 230; turn += 1) {
      filler.push({ role: "user", text: `filler ${turn}`, timestamp: time++ });
      filler.push({ role: "assistant", text: `ok ${turn}`, timestamp: time++ });
    }
    const currentTime = time + 1_000;
    filler.push({ role: "user", text: "NEWEST", timestamp: currentTime });
    filler.push({
      role: "assistant",
      text: "REPLACED-ANSWER",
      timestamp: currentTime + 1,
    });
    await api.seedStoredConversationTurns(key, filler);
    const paper = Zotero.Items.get(fixture.parentItemId);
    const scope = api.registerScopedMcpScope({
      conversationKey: key,
      libraryID: paper.libraryID,
      kind: "paper",
      runId: `current-chat-read-long:${Date.now()}`,
      runtimeAuthority: "claude",
      sourceMessageTimestamp: currentTime,
    });
    try {
      const chat = `upstream:${key}`;
      const read = await callPastChatRead(scope.token, { chat, message: 1 });
      assert.isTrue(read.ok, JSON.stringify(read).slice(0, 500));
      assert.equal(read.totalMessages, 462);
      const text = (read.messages as Array<{ text: string }>)
        .map((entry) => entry.text)
        .join("\n");
      assert.include(text, "OLDEST-QUESTION");
      assert.include(text, "OLDEST-ANSWER");
      const search = await callPastChatRead(scope.token, {
        chat,
        query: "OLDEST-ANSWER",
      });
      assert.equal(search.totalMatches, 1, JSON.stringify(search));
    } finally {
      api.clearScopedMcpScope(scope.token);
    }
  });
});
