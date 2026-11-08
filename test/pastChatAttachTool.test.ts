import { assert } from "chai";
import { createPastChatAttachTool } from "../src/agent/tools/control/pastChatAttach";
import { createPastChatReadTool } from "../src/agent/tools/read/pastChatRead";
import { createPastChatSearchTool } from "../src/agent/tools/read/pastChatSearch";
import {
  clearRememberedLocalDocumentPaths,
  rememberLocalDocumentPaths,
} from "../src/agent/privacy/localDocumentPathRedaction";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { clearAgentReadLedger } from "../src/agent/context/resourceContextPlan";
import { clearAgentCoverageLedger } from "../src/agent/context/coverageLedger";
import { clearAgentTranscriptStore } from "../src/agent/store/transcriptStore";
import {
  clearAgentToolResultHandleStore,
  listAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import {
  setPastChatAttachHandler,
  type PastChatAttachRequest,
} from "../src/services/pastConversations/attachSink";
import { clearPastChatRenderMemoForTests } from "../src/services/pastConversations/pastConversationLoader";
import {
  PAST_CHAT_MESSAGE_TITLE,
  readPastChatMessageSections,
} from "../src/services/pastConversations/pastConversationText";
import { createPastChatAttachHandler } from "../src/modules/contextPanel/pastChatAttachHandler";
import { toStoredUserRowPatch } from "../src/modules/contextPanel/storedUserRow";
import {
  restoreRetryUserSnapshot,
  takeRetryUserSnapshot,
} from "../src/modules/contextPanel/retryUserSnapshot";
import {
  injectAttachedPastChatsIntoAgentHistory,
  resolveCurrentTurnDeliveredPastChats,
} from "../src/modules/contextPanel/agentMode/pastChatHistory";
import {
  addAttachedPastChatsToSimpleChatHistory,
  renderCodexCurrentTurnPastChatText,
} from "../src/modules/contextPanel/pastChatSimpleChatHistory";
import { normalizeAttachedConversationRefs } from "../src/services/context/normalizers";
import { EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import type { Message } from "../src/modules/contextPanel/types";
import type {
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import type { AttachedConversationRef } from "../src/shared/types";
import type { ChatMessage } from "../src/utils/llmClient";
import {
  installMockDb,
  type InstalledMockDb,
} from "./helpers/agentRuntimeMockDb";
import {
  createFakePastConversationSource,
  pastChatRows,
} from "./helpers/fakePastConversationSource";

/**
 * past_chat_attach adds an agent-found chat to the user's message through the
 * attach sink (the panel is the one writer), extends the turn's scope, and
 * returns the chat's text. A chat it attached carries via "agent": the turn
 * that attached it does not get the past-chat block again, a history rebuilt
 * from stored rows does.
 */

const CONVERSATION_KEY = 7_301;
const USER_TS = 5_000;

const source = createFakePastConversationSource([
  {
    conversationKey: 10,
    entry: { title: "Grid cells chat" },
    messages: pastChatRows(4, (n) =>
      n === 2 ? "Grid cells fire on a hexagonal lattice." : `turn ${n}`,
    ),
  },
  {
    conversationKey: 11,
    entry: { title: "Place cells chat" },
    messages: pastChatRows(2),
  },
  { conversationKey: 12, entry: { libraryID: 2 }, messages: pastChatRows(2) },
  {
    conversationKey: 13,
    entry: { title: "Web chat", webchatSession: true },
    messages: pastChatRows(2),
  },
  {
    conversationKey: 14,
    entry: { title: "Deleted chat" },
    messages: pastChatRows(2),
  },
  {
    system: "codex",
    conversationKey: CONVERSATION_KEY,
    entry: { title: "Codex chat with the same key" },
    messages: pastChatRows(2, (n) => `codex ${n}`),
  },
]);
const pendingSource = createFakePastConversationSource(
  [{ conversationKey: 14, entry: { title: "Deleted" }, messages: [] }],
  { pendingDeletion: [14] },
);

function pickedRef(conversationKey: number): AttachedConversationRef {
  return {
    system: "upstream",
    conversationKey,
    conversationID: `conv-${conversationKey}`,
    title: `Picked ${conversationKey}`,
    libraryID: 1,
  };
}

function agentRef(conversationKey: number): AttachedConversationRef {
  return { ...pickedRef(conversationKey), via: "agent" };
}

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    role: "user",
    text: "find the grid cells chat",
    timestamp: USER_TS,
    ...overrides,
  };
}

type Recorded = { request: PastChatAttachRequest; row: unknown };

/** The panel's handler over an in-memory chat history. */
function installHandler(history: Message[]) {
  const writes: Recorded[] = [];
  const refreshes: number[] = [];
  setPastChatAttachHandler(
    createPastChatAttachHandler({
      getHistory: (key) => (key === CONVERSATION_KEY ? history : undefined),
      isTemporaryConversation: (key) =>
        key >= EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE,
      persistUserMessage: async (request, message) => {
        writes.push({ request, row: toStoredUserRowPatch(message) });
      },
      refreshConversation: (key) => refreshes.push(key),
    }),
  );
  return { writes, refreshes };
}

function toolContext(
  overrides: Partial<AgentRuntimeRequest> = {},
  extra: Partial<AgentToolContext> = {},
): AgentToolContext {
  return {
    request: {
      conversationKey: CONVERSATION_KEY,
      mode: "agent",
      userText: "find the grid cells chat",
      libraryID: 1,
      metadata: { sourceMessageTimestamp: USER_TS },
      ...overrides,
    } as AgentRuntimeRequest,
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    ...extra,
  };
}

async function runAttach(
  args: unknown,
  context: AgentToolContext,
  toolSource = source,
): Promise<Record<string, any>> {
  const tool = createPastChatAttachTool(toolSource) as AgentToolDefinition<
    unknown,
    unknown
  >;
  const input = tool.validate(args);
  if (!input.ok) throw new Error(input.error);
  return (await tool.execute(input.value, context)) as Record<string, any>;
}

describe("past_chat_attach", function () {
  beforeEach(function () {
    clearPastChatRenderMemoForTests();
  });
  afterEach(function () {
    setPastChatAttachHandler(null);
    clearPastChatRenderMemoForTests();
  });

  it("adds the chat to the in-memory user message, saves that row, refreshes the chip, and returns the text", async function () {
    const message = userMessage();
    const { writes, refreshes } = installHandler([message]);
    const context = toolContext();
    const result = await runAttach({ chat: "upstream:10" }, context);
    assert.isTrue(result.ok, JSON.stringify(result));
    assert.isTrue(result.attached);
    assert.equal(result.title, "Grid cells chat");
    assert.isTrue(String(result.pastChat).startsWith(PAST_CHAT_MESSAGE_TITLE));
    assert.include(result.pastChat, "Grid cells fire on a hexagonal lattice.");
    assert.match(result.hint, /chip on the user's message/);
    const expected: AttachedConversationRef = {
      system: "upstream",
      conversationKey: 10,
      conversationID: "conv-10",
      title: "Grid cells chat",
      libraryID: 1,
      kind: "global",
      via: "agent",
    };
    assert.deepEqual(message.attachedConversations, [expected]);
    assert.lengthOf(writes, 1);
    assert.equal(writes[0].request.userMessageTimestamp, USER_TS);
    assert.equal(writes[0].request.conversationSystem, "upstream");
    assert.deepEqual(
      (writes[0].row as { attachedConversations: unknown })
        .attachedConversations,
      [expected],
    );
    assert.deepEqual(refreshes, [CONVERSATION_KEY]);
    assert.deepEqual(context.request.attachedConversationScope, [expected]);
  });

  it("keeps the picked chips and appends the agent's chat after them", async function () {
    const message = userMessage({ attachedConversations: [pickedRef(11)] });
    installHandler([message]);
    const result = await runAttach(
      { chat: "upstream:10" },
      toolContext({ attachedConversationScope: [pickedRef(11)] }),
    );
    assert.isTrue(result.ok);
    assert.deepEqual(
      message.attachedConversations?.map((ref) => [
        ref.conversationKey,
        ref.via,
      ]),
      [
        [11, undefined],
        [10, "agent"],
      ],
    );
  });

  it("does not add a chat already in the conversation's scope, and returns its text again", async function () {
    const message = userMessage();
    const { writes } = installHandler([message]);
    const scope = [pickedRef(10)];
    const result = await runAttach(
      { chat: "upstream:10" },
      toolContext({ attachedConversationScope: scope }),
    );
    assert.isTrue(result.ok);
    assert.isTrue(result.alreadyAttached);
    assert.include(result.pastChat, "Grid cells fire on a hexagonal lattice.");
    assert.isUndefined(message.attachedConversations);
    assert.lengthOf(writes, 0);
    assert.lengthOf(scope, 1);
  });

  it("is idempotent: a second attach of the same chat adds nothing", async function () {
    const message = userMessage();
    const { writes } = installHandler([message]);
    const context = toolContext();
    await runAttach({ chat: "upstream:10" }, context);
    const again = await runAttach({ chat: "upstream:10" }, context);
    assert.isTrue(again.alreadyAttached);
    assert.lengthOf(message.attachedConversations || [], 1);
    assert.lengthOf(writes, 1);
  });

  it("two parallel attaches of one chat add it once", async function () {
    const message = userMessage();
    installHandler([message]);
    const context = toolContext();
    const results = await Promise.all([
      runAttach({ chat: "upstream:10" }, context),
      runAttach({ chat: "upstream:10" }, context),
    ]);
    assert.isTrue(results.every((result) => result.ok));
    assert.lengthOf(message.attachedConversations || [], 1);
    assert.lengthOf(context.request.attachedConversationScope || [], 1);
  });

  it("refuses when the message already holds three chats, and drops nothing", async function () {
    const full = [pickedRef(21), pickedRef(22), pickedRef(23)];
    const message = userMessage({ attachedConversations: [...full] });
    const { writes } = installHandler([message]);
    const context = toolContext({ attachedConversationScope: [...full] });
    const result = await runAttach({ chat: "upstream:10" }, context);
    assert.isFalse(result.ok);
    assert.match(result.error, /already has 3 attached past chats/);
    assert.deepEqual(message.attachedConversations, full);
    assert.lengthOf(writes, 0);
    assert.lengthOf(context.request.attachedConversationScope || [], 3);
  });

  it("refuses a temporary conversation (side chat) before reaching the panel", async function () {
    const { writes } = installHandler([userMessage()]);
    const result = await runAttach(
      { chat: "upstream:10" },
      toolContext({
        conversationKey: EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE + 3,
      }),
    );
    assert.isFalse(result.ok);
    assert.match(result.error, /only in a saved conversation/);
    assert.lengthOf(writes, 0);
  });

  it("refuses a chat from another library, a web chat, an unknown chat, a deleted chat and a temporary chat", async function () {
    installHandler([userMessage()]);
    const other = await runAttach({ chat: "upstream:12" }, toolContext());
    assert.match(other.error, /^Only past chats from this library/);
    const web = await runAttach({ chat: "upstream:13" }, toolContext());
    assert.match(web.error, /^No past chat with this id/);
    const unknown = await runAttach({ chat: "claude_code:99" }, toolContext());
    assert.match(unknown.error, /^No past chat with this id/);
    const deleted = await runAttach(
      { chat: "upstream:14" },
      toolContext(),
      pendingSource,
    );
    assert.match(deleted.error, /was deleted/);
    const temporary = await runAttach(
      { chat: `upstream:${EPHEMERAL_GLOBAL_CONVERSATION_KEY_BASE + 9}` },
      toolContext(),
    );
    assert.match(temporary.error, /^No past chat with this id/);
  });

  it("refuses the current conversation by system and key, and allows another system's chat with the same key", async function () {
    const message = userMessage();
    installHandler([message]);
    const current = await runAttach(
      { chat: `upstream:${CONVERSATION_KEY}` },
      toolContext(),
    );
    assert.isFalse(current.ok);
    assert.match(current.error, /current conversation/);
    const otherSystem = await runAttach(
      { chat: `codex:${CONVERSATION_KEY}` },
      toolContext(),
    );
    assert.isTrue(otherSystem.ok, JSON.stringify(otherSystem));
    const fromCodex = await runAttach(
      { chat: `codex:${CONVERSATION_KEY}` },
      toolContext({}, { conversationSystem: "codex" }),
    );
    assert.match(fromCodex.error, /current conversation/);
  });

  it("refuses without a conversation key or user message timestamp", async function () {
    const { writes } = installHandler([userMessage()]);
    const noKey = await runAttach(
      { chat: "upstream:10" },
      toolContext({ conversationKey: 0 }),
    );
    assert.match(noKey.error, /only in a conversation in Zotero/);
    const noTimestamp = await runAttach(
      { chat: "upstream:10" },
      toolContext({ metadata: {} }),
    );
    assert.match(noTimestamp.error, /only in a conversation in Zotero/);
    assert.lengthOf(writes, 0);
  });

  it("refuses when no panel handles the attach or the message is not in memory", async function () {
    const context = toolContext();
    const noHandler = await runAttach({ chat: "upstream:10" }, context);
    assert.isFalse(noHandler.ok);
    assert.match(noHandler.error, /could not be added right now/);
    installHandler([userMessage({ timestamp: USER_TS + 1 })]);
    const notFound = await runAttach({ chat: "upstream:10" }, context);
    assert.isFalse(notFound.ok);
    assert.isUndefined(context.request.attachedConversationScope);
  });

  it("is a control tool with a read-only plan and no domains", function () {
    const tool = createPastChatAttachTool(source);
    assert.equal(tool.spec.executionClass, "control");
    const plan = tool.planInvocation?.({ chat: "upstream:1" }, {} as never) as {
      impact: string;
      domains: string[];
    };
    assert.equal(plan.impact, "read_only");
    assert.deepEqual(plan.domains, []);
    assert.isFalse(tool.validate({ chat: "upstream:0" }).ok);
    assert.isFalse(tool.validate({}).ok);
  });
});

describe("the panel's past-chat attach handler", function () {
  it("adds to the same Message object, so a later whole-row write keeps the chip (no clobber)", async function () {
    const message = userMessage({ attachedConversations: [pickedRef(11)] });
    const writes: unknown[] = [];
    const handler = createPastChatAttachHandler({
      getHistory: () => [message],
      isTemporaryConversation: () => false,
      persistUserMessage: async (_request, row) => {
        writes.push(toStoredUserRowPatch(row));
      },
      refreshConversation: () => undefined,
    });
    const outcome = await handler({
      conversationKey: CONVERSATION_KEY,
      conversationSystem: "upstream",
      userMessageTimestamp: USER_TS,
      ref: agentRef(10),
    });
    assert.deepEqual(outcome, { ok: true });
    // The agent engine's later tool-result or finish update builds the row
    // from the same in-memory message.
    message.citationPaperContexts = [
      { itemId: 1, contextItemId: 2, title: "Paper" } as never,
    ];
    const laterRow = toStoredUserRowPatch(message, { runMode: "agent" });
    assert.deepEqual(
      laterRow.attachedConversations?.map((ref) => [
        ref.conversationKey,
        ref.via,
      ]),
      [
        [11, undefined],
        [10, "agent"],
      ],
    );
  });

  it("keeps the chip when a failed retry restores the user message", async function () {
    const message = userMessage({ attachedConversations: [pickedRef(11)] });
    const snapshot = takeRetryUserSnapshot(message);
    const handler = createPastChatAttachHandler({
      getHistory: () => [message],
      isTemporaryConversation: () => false,
      persistUserMessage: async () => undefined,
      refreshConversation: () => undefined,
    });
    await handler({
      conversationKey: CONVERSATION_KEY,
      conversationSystem: "upstream",
      userMessageTimestamp: USER_TS,
      ref: agentRef(10),
    });
    restoreRetryUserSnapshot(message, snapshot);
    assert.deepEqual(
      toStoredUserRowPatch(message).attachedConversations?.map(
        (ref) => ref.conversationKey,
      ),
      [11, 10],
    );
  });

  it("finds the message by timestamp, not by position, and refuses one that is not there", async function () {
    const older = userMessage({ timestamp: 1_000 });
    const current = userMessage({ timestamp: USER_TS });
    const handler = createPastChatAttachHandler({
      getHistory: () => [
        older,
        { role: "assistant", text: "a", timestamp: 1_001 },
        current,
      ],
      isTemporaryConversation: () => false,
      persistUserMessage: async () => undefined,
      refreshConversation: () => undefined,
    });
    await handler({
      conversationKey: CONVERSATION_KEY,
      conversationSystem: "upstream",
      userMessageTimestamp: USER_TS,
      ref: agentRef(10),
    });
    assert.isUndefined(older.attachedConversations);
    assert.lengthOf(current.attachedConversations || [], 1);
    const missing = await handler({
      conversationKey: CONVERSATION_KEY,
      conversationSystem: "upstream",
      userMessageTimestamp: 42,
      ref: agentRef(10),
    });
    assert.deepEqual(missing, { ok: false, reason: "not_found" });
  });

  it("takes the chip back when the row cannot be saved", async function () {
    const message = userMessage();
    let refreshed = false;
    const handler = createPastChatAttachHandler({
      getHistory: () => [message],
      isTemporaryConversation: () => false,
      persistUserMessage: async () => {
        throw new Error("database busy");
      },
      refreshConversation: () => {
        refreshed = true;
      },
    });
    const outcome = await handler({
      conversationKey: CONVERSATION_KEY,
      conversationSystem: "upstream",
      userMessageTimestamp: USER_TS,
      ref: agentRef(10),
    });
    assert.deepEqual(outcome, { ok: false, reason: "error" });
    assert.isUndefined(message.attachedConversations);
    assert.isFalse(refreshed);
  });

  it("refuses a temporary conversation", async function () {
    const handler = createPastChatAttachHandler({
      getHistory: () => [userMessage()],
      isTemporaryConversation: () => true,
      persistUserMessage: async () => undefined,
      refreshConversation: () => undefined,
    });
    const outcome = await handler({
      conversationKey: CONVERSATION_KEY,
      conversationSystem: "upstream",
      userMessageTimestamp: USER_TS,
      ref: agentRef(10),
    });
    assert.deepEqual(outcome, { ok: false, reason: "temporary" });
  });
});

describe("the via marker", function () {
  it("survives the reference normalizer", function () {
    assert.deepEqual(normalizeAttachedConversationRefs([agentRef(10)]), [
      agentRef(10),
    ]);
    assert.deepEqual(
      normalizeAttachedConversationRefs([{ ...pickedRef(10), via: "user" }]),
      [pickedRef(10)],
    );
  });
});

describe("agent-attached chats in each delivery path", function () {
  let installed: InstalledMockDb;
  beforeEach(function () {
    clearAgentReadLedger();
    clearAgentCoverageLedger();
    clearAgentTranscriptStore();
    clearAgentToolResultHandleStore();
    clearPastChatRenderMemoForTests();
    installed = installMockDb();
  });
  afterEach(function () {
    installed();
    setPastChatAttachHandler(null);
    clearPastChatRenderMemoForTests();
  });

  function contentText(message: AgentModelMessage | undefined): string {
    if (!message) return "";
    return typeof message.content === "string"
      ? message.content
      : message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n");
  }

  function scriptedRuntime(
    steps: AgentModelStep[],
    prompts: AgentModelMessage[][],
    toolSource = source,
  ): AgentRuntime {
    const registry = new AgentToolRegistry();
    registry.register(createPastChatAttachTool(toolSource));
    registry.register(createPastChatReadTool(toolSource));
    registry.register(createPastChatSearchTool(toolSource));
    let index = 0;
    return new AgentRuntime({
      registry,
      pastConversationSource: source,
      adapterFactory: () => ({
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
        }),
        supportsTools: () => true,
        async runStep(params): Promise<AgentModelStep> {
          prompts.push(params.messages.map((message) => ({ ...message })));
          return (
            steps[index++] || {
              kind: "final",
              text: "Answered.",
              assistantMessage: { role: "assistant", content: "Answered." },
            }
          );
        },
      }),
    });
  }

  function toolStep(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): AgentModelStep {
    const call = { id, name, arguments: args };
    return {
      kind: "tool_calls",
      calls: [call],
      assistantMessage: { role: "assistant", content: "", tool_calls: [call] },
    };
  }

  function toolResult(
    prompt: AgentModelMessage[],
    callId: string,
  ): Record<string, any> {
    const message = prompt.find(
      (entry) =>
        entry.role === "tool" &&
        (entry as { tool_call_id?: string }).tool_call_id === callId,
    );
    assert.exists(message, `tool result ${callId}`);
    return JSON.parse(contentText(message));
  }

  it("a later past_chat_read in the same built-in turn opens the chat the agent attached", async function () {
    const message = userMessage();
    installHandler([message]);
    const prompts: AgentModelMessage[][] = [];
    const runtime = scriptedRuntime(
      [
        toolStep("read-before", "past_chat_read", { chat: "upstream:10" }),
        toolStep("attach", "past_chat_attach", { chat: "upstream:10" }),
        toolStep("read-after", "past_chat_read", {
          chat: "upstream:10",
          message: 2,
        }),
      ],
      prompts,
    );
    const outcome = await runtime.runTurn({
      request: {
        conversationKey: CONVERSATION_KEY,
        mode: "agent",
        userText: "find the grid cells chat",
        libraryID: 1,
        model: "test",
        apiKey: "test",
        apiBase: "https://example.invalid",
        metadata: { sourceMessageTimestamp: USER_TS },
      },
    });
    assert.equal(outcome.kind, "completed");
    const last = prompts[prompts.length - 1];
    const before = toolResult(last, "read-before");
    assert.isFalse(before.ok);
    const attach = toolResult(last, "attach");
    assert.isTrue(attach.ok, JSON.stringify(attach));
    const after = toolResult(last, "read-after");
    assert.isTrue(after.ok, JSON.stringify(after));
    assert.equal(
      after.messages[0].text,
      "Grid cells fire on a hexagonal lattice.",
    );
    assert.equal(message.attachedConversations?.[0]?.via, "agent");
    assert.isFalse(
      last.some(
        (entry) =>
          entry.role === "user" &&
          contentText(entry).startsWith(PAST_CHAT_MESSAGE_TITLE),
      ),
      "no past-chat block on the turn that attached it",
    );
  });

  it("the built-in runtime keeps a search snippet with the turn's local paths redacted, as for past_chat_read", async function () {
    const conversationKey = 7_302;
    const secretPath = "/Users/someone/private/papers/grid.pdf";
    rememberLocalDocumentPaths(conversationKey, [
      {
        kind: "local_pdf",
        sourceKey: "zotero-pdf:1:2",
        itemId: 1,
        contextItemId: 2,
        title: "Grid",
        name: "grid.pdf",
        mimeType: "application/pdf",
        absolutePath: secretPath,
      },
    ]);
    try {
      const pathSource = createFakePastConversationSource([
        {
          conversationKey: 40,
          entry: { title: "Path chat" },
          messages: pastChatRows(2, (n) =>
            n === 1 ? `the grid file is at ${secretPath} today` : "noted",
          ),
        },
      ]);
      const prompts: AgentModelMessage[][] = [];
      const runtime = scriptedRuntime(
        [toolStep("search", "past_chat_search", { query: "grid file" })],
        prompts,
        pathSource,
      );
      await runtime.runTurn({
        request: {
          conversationKey,
          mode: "agent",
          userText: "find the grid file chat",
          libraryID: 1,
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
          metadata: { sourceMessageTimestamp: USER_TS },
        },
      });
      const search = toolResult(prompts[prompts.length - 1], "search");
      assert.equal(search.chats[0].chat, "upstream:40");
      // The model saw this turn's result as the tool returned it; what is
      // kept for later turns (the tool-result store) has the path redacted.
      const stored = await listAgentToolResultHandles({
        conversationKey,
        toolName: "past_chat_search",
      });
      assert.lengthOf(stored, 1);
      const storedJson = JSON.stringify(stored[0].content);
      assert.include(storedJson, "upstream:40");
      assert.notInclude(storedJson, secretPath);
      assert.notInclude(storedJson, "/Users/someone/private/papers");
    } finally {
      clearRememberedLocalDocumentPaths(conversationKey);
    }
  });

  it("the built-in current turn and its retry leave an agent chat out and keep picked ones", async function () {
    const prompts: AgentModelMessage[][] = [];
    const runtime = scriptedRuntime([], prompts);
    const base = {
      conversationKey: CONVERSATION_KEY,
      mode: "agent" as const,
      userText: "compare",
      libraryID: 1,
      model: "test",
      apiKey: "test",
      apiBase: "https://example.invalid",
      metadata: { sourceMessageTimestamp: USER_TS },
    };
    await runtime.runTurn({
      request: {
        ...base,
        attachedConversations: [agentRef(10)],
        attachedConversationScope: [agentRef(10)],
      },
    });
    assert.isFalse(
      prompts[0].some((entry) =>
        contentText(entry).startsWith(PAST_CHAT_MESSAGE_TITLE),
      ),
      "agent chat only: no block",
    );
    clearAgentTranscriptStore();
    installed.transcripts.length = 0;
    await runtime.runTurn({
      request: {
        ...base,
        metadata: { sourceMessageTimestamp: USER_TS + 10 },
        attachedConversations: [pickedRef(11), agentRef(10)],
        attachedConversationScope: [pickedRef(11), agentRef(10)],
      },
    });
    const block = prompts[1].find((entry) =>
      contentText(entry).startsWith(PAST_CHAT_MESSAGE_TITLE),
    );
    assert.deepEqual(
      readPastChatMessageSections(contentText(block)).map(
        (section) => section.id,
      ),
      ["upstream:11"],
    );
  });

  it("a rebuilt agent or Claude Code history keeps the agent chat before its message", async function () {
    const messages = [
      {
        role: "user",
        text: "find the grid cells chat",
        timestamp: USER_TS,
        attachedConversations: [agentRef(10)],
      },
      { role: "assistant", text: "Found it.", timestamp: USER_TS + 1 },
    ];
    const history: ChatMessage[] = [
      { role: "user", content: "find the grid cells chat" },
      { role: "assistant", content: "Found it." },
    ];
    for (const conversationSystem of ["upstream", "claude_code"]) {
      const rebuilt = await injectAttachedPastChatsIntoAgentHistory({
        conversationKey: CONVERSATION_KEY,
        conversationSystem,
        libraryID: 1,
        messages,
        history,
        effectiveRequestConfig: {
          model: "test",
          apiBase: "https://example.invalid",
          authMode: "api_key",
          advanced: undefined,
        },
        source,
      });
      assert.lengthOf(rebuilt, 3, conversationSystem);
      assert.isTrue(
        String(rebuilt[0].content).startsWith(PAST_CHAT_MESSAGE_TITLE),
      );
      assert.equal(rebuilt[1].content, "find the grid cells chat");
    }
  });

  it("the Claude Code current turn leaves an agent chat out", function () {
    const delivered = resolveCurrentTurnDeliveredPastChats({
      conversationSystem: "claude_code",
      history: [],
      current: {
        text: "compare",
        attachedConversations: [pickedRef(11), agentRef(10)],
      },
    });
    assert.deepEqual(
      delivered?.map((ref) => ref.conversationKey),
      [11],
    );
    assert.isUndefined(
      resolveCurrentTurnDeliveredPastChats({
        conversationSystem: "claude_code",
        history: [],
        current: { text: "compare", attachedConversations: [agentRef(10)] },
      }),
    );
  });

  it("the Codex current-turn block leaves an agent chat out; a reseeded thread keeps it", async function () {
    const config = {
      model: "gpt-5.5",
      apiBase: "",
      providerProtocol: "codex_responses" as const,
      authMode: "codex_app_server" as const,
      advanced: undefined,
    };
    const codexKey = 6_000_007_501;
    const attachTurn = {
      role: "user",
      timestamp: USER_TS,
      attachedConversations: [agentRef(10)],
    };
    assert.isNull(
      await renderCodexCurrentTurnPastChatText({
        conversationKey: codexKey,
        libraryID: 1,
        message: attachTurn,
        pastChatReadAvailable: true,
        effectiveRequestConfig: config,
        source,
      }),
    );
    const mixed = await renderCodexCurrentTurnPastChatText({
      conversationKey: codexKey,
      libraryID: 1,
      message: {
        ...attachTurn,
        attachedConversations: [pickedRef(11), agentRef(10)],
      },
      pastChatReadAvailable: true,
      effectiveRequestConfig: config,
      source,
    });
    assert.deepEqual(
      readPastChatMessageSections(mixed || "").map((section) => section.id),
      ["upstream:11"],
    );
    const reseeded = await addAttachedPastChatsToSimpleChatHistory({
      conversationKey: codexKey,
      conversationSystem: "codex",
      includeCodex: true,
      pastChatReadAvailable: true,
      libraryID: 1,
      messages: [attachTurn, { role: "assistant", timestamp: USER_TS + 1 }],
      rawHistory: [
        { role: "user", content: "find the grid cells chat" },
        { role: "assistant", content: "Found it." },
      ],
      effectiveRequestConfig: config,
      source,
    });
    assert.lengthOf(reseeded, 3);
    assert.deepEqual(
      readPastChatMessageSections(String(reseeded[0].content)).map(
        (section) => section.id,
      ),
      ["upstream:10"],
    );
  });
});
