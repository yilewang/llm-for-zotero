import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import {
  classifyConversationKey,
  isEphemeralConversationKey,
} from "../src/shared/conversationKeySpace";
import { EPHEMERAL_BACKGROUND_CONTEXT_LABEL } from "../src/shared/ephemeralBackgroundContext";
import type {
  WorkflowTestApi,
  WorkflowTestEphemeralConversationRowCounts,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * The window's side chat is temporary: it is a full chat panel mounted on an
 * ephemeral conversation key, and nothing it does is saved. A turn sent from
 * it goes through the panel's own composer and the real send flow; only the
 * network is scripted (a held fake provider).
 *
 * Under test:
 * - the side body resolves to the "side" surface on the API runtime and
 *   shows its ephemeral key;
 * - its request carries the main chat as a labelled background block;
 * - after a completed turn (plain chat, then agent mode), no store holds a
 *   row for its key: catalog, registry, ledger, messages, search index,
 *   agent tables, plan documents, attachment refs, usage;
 * - the sidebar's and the window's saved selection prefs do not change.
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-side-chat-ephemeral.invalid/v1";
const GROUP_ID = "workflow-side-chat-group";
const ENTRY_ID = "workflow-side-chat-model";
const MODEL = "side-chat-model";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "enableAgentMode",
  "outputTokenAutoMigrationNoticePending",
];

/** The prefs that hold a surface's saved selection and choices. */
const SELECTION_PREF_KEYS = [
  "lastUsedModelEntryId",
  "lastUsedRuntimeMode",
  "lastUsedReasoningLevel",
  "lastUsedReasoningLevelByProvider",
  "conversationSystem",
  "lastUsedConversationModeMap",
  "lastUsedGlobalConversationMap",
  "lastUsedPaperConversationMap",
  "lockedGlobalConversation",
];

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function readSelectionPrefs(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SELECTION_PREF_KEYS) {
    out[key] = Zotero.Prefs.get(PREF_PREFIX + key, true);
  }
  return out;
}

function assertNoRows(
  counts: WorkflowTestEphemeralConversationRowCounts,
  context: string,
): void {
  const nonZero = Object.entries(counts).filter(([, value]) => value !== 0);
  assert.deepEqual(
    nonZero,
    [],
    `${context}: no store may hold a row for the side chat's key: ${JSON.stringify(counts)}`,
  );
}

describe("workflow: the side chat is never saved", function () {
  this.timeout(180_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
  const sideKeys: number[] = [];

  async function until(
    check: () => boolean | Promise<boolean>,
    describe: () => string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Zotero.Promise.delay(50);
    }
    if (await check()) return;
    assert.fail(describe());
  }

  /** Wait until the conversation's newest answer is final and contains `text`. */
  async function waitForAnswer(key: number, text: string) {
    let last: unknown = null;
    let answer: Record<string, unknown> | undefined;
    await until(
      async () => {
        const state = await api.readChatTurnLifecycle(key);
        answer = [...state.memory]
          .reverse()
          .find((message) => message.role === "assistant");
        last = {
          requestPending: state.requestPending,
          answer,
          storedRows: state.storedRows.length,
          usageRows: state.usageRows.length,
        };
        return (
          !state.requestPending &&
          Boolean(answer) &&
          answer!.streaming !== true &&
          String(answer!.text || "").includes(text)
        );
      },
      () =>
        `side chat ${key} finishes an answer containing "${text}": ${JSON.stringify(last)}`,
      30_000,
    );
    return answer!;
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    provider = installHeldChatProvider(API_BASE);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableAgentMode", true, true);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedRuntimeMode", "chat", true);
    setModelProviderGroups([
      {
        id: GROUP_ID,
        authMode: "api_key",
        apiBase: API_BASE,
        apiKey: "workflow-dummy-key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: ENTRY_ID,
            model: MODEL,
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_ID, true);
    assert.isOk(getModelEntryById(ENTRY_ID), "the fake model is configured");
  });

  after(async function () {
    provider?.restore();
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api.reset();
    // Let each panel's send continue into the real request and provider.
    api.enableLiveAgentSending();
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await Zotero.Promise.delay(300);
    for (const key of sideKeys.splice(0)) api.discardSidePanelConversation(key);
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("answers a Paper-chat side question in memory and saves nothing", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Side chat ephemeral paper",
      pdfTitle: "Side chat ephemeral paper PDF",
      pages: ["Side chat ephemeral paper: one short page of text."],
    });
    fixtures.push(fixture);
    const prefsBefore = readSelectionPrefs();

    const MAIN_CHAT = "Q: main chat question\n\nA: main chat answer";
    const side = await api.renderSidePanelForItem({
      itemId: fixture.parentItemId,
      mode: "paper",
      backgroundContext: MAIN_CHAT,
    });
    sideKeys.push(side.conversationKey);
    assert.isTrue(isEphemeralConversationKey(side.conversationKey));
    assert.deepEqual(classifyConversationKey(side.conversationKey), {
      system: "upstream",
      kind: "paper",
    });
    assert.equal(side.surface, "side");
    assert.equal(side.mountedConversationKey, side.conversationKey);
    assert.equal(side.conversationSystem, "upstream");

    const QUESTION = "side-chat-paper-question-marker";
    const ANSWER = "side-chat-paper-answer-marker";
    const sent = await api.startPanelChatSend(side.panelId, QUESTION);
    assert.equal(sent.conversationKey, side.conversationKey);
    const stream = await provider.waitForStream(QUESTION);
    assert.include(
      stream.requestBody,
      JSON.stringify(EPHEMERAL_BACKGROUND_CONTEXT_LABEL).slice(1, -1),
      "the request carries the main chat as labelled background",
    );
    assert.include(stream.requestBody, "main chat answer");
    assert.notInclude(
      stream.lastUserText,
      "main chat answer",
      "the background is not part of the user message",
    );
    stream.push(ANSWER);
    stream.finish();
    await waitForAnswer(side.conversationKey, ANSWER);
    await Zotero.Promise.delay(500);

    const state = await api.readChatTurnLifecycle(side.conversationKey);
    assert.lengthOf(state.storedRows, 0, "no message row is stored");
    assert.lengthOf(state.usageRows, 0, "no usage row is stored");
    assertNoRows(
      await api.getEphemeralConversationRowCounts(side.conversationKey),
      "after a Paper-chat side turn",
    );
    const persistence = await api.getWorkflowConversationPersistenceSnapshot(
      "upstream",
      side.conversationKey,
    );
    assert.deepInclude(persistence, {
      catalogRows: 0,
      messageRows: 0,
      searchIndexRows: 0,
      registryRows: 0,
      pendingDeletionRows: 0,
    });
    assert.deepEqual(
      readSelectionPrefs(),
      prefsBefore,
      "the sidebar's and the window's saved selection do not change",
    );
  });

  it("answers a Library-chat side question in agent mode and saves nothing", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Side chat ephemeral library",
      pdfTitle: "Side chat ephemeral library PDF",
      pages: ["Side chat ephemeral library: one short page of text."],
    });
    fixtures.push(fixture);
    const prefsBefore = readSelectionPrefs();

    const side = await api.renderSidePanelForItem({
      itemId: fixture.parentItemId,
      mode: "global",
    });
    sideKeys.push(side.conversationKey);
    assert.deepEqual(classifyConversationKey(side.conversationKey), {
      system: "upstream",
      kind: "global",
    });
    assert.equal(side.surface, "side");
    // The built-in runtime is Agent; a side chat never offers another one.
    const diagnostics = await api.getDiagnostics(side.panelId);
    assert.isFalse(
      diagnostics.runtimeBadge?.clickable,
      "the side chat's runtime badge is a static label",
    );
    assert.equal(
      diagnostics.runtimeMode,
      "agent",
      "the side chat is in Agent mode",
    );

    const QUESTION = "side-chat-agent-question-marker";
    const ANSWER = "side-chat-agent-answer-marker";
    await api.startPanelChatSend(side.panelId, QUESTION);
    const stream = await provider.waitForStream(QUESTION, 20_000);
    // The model is told the side chat is read-only, and is offered no tool
    // or skill that changes the library.
    const requestBody = JSON.parse(stream.requestBody) as {
      messages?: { role: string; content: unknown }[];
      tools?: { function?: { name?: string } }[];
    };
    const systemText = (requestBody.messages || [])
      .filter((message) => message.role === "system")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      )
      .join("\n");
    assert.include(systemText, "temporary side chat, and it is read-only");
    assert.include(systemText, '"id":"compare-papers"', "read skills stay");
    for (const skillId of [
      "write-note",
      "reorganize-library",
      "import-to-library",
    ])
      assert.notInclude(
        systemText,
        `"id":"${skillId}"`,
        `${skillId} is not offered`,
      );
    const toolNames = (requestBody.tools || []).map(
      (tool) => tool.function?.name || "",
    );
    assert.isAbove(toolNames.length, 0, "read tools are offered");
    for (const name of [
      "note_write",
      "apply_tags",
      "move_to_collection",
      "run_command",
    ])
      assert.notInclude(toolNames, name, `${name} is withheld`);
    stream.push(ANSWER);
    stream.finish();
    const answer = await waitForAnswer(side.conversationKey, ANSWER);
    await Zotero.Promise.delay(500);
    assert.equal(answer.runMode, "agent", "the answer came from an agent run");
    // A finished side answer is not marked interrupted and leaves no error.
    assert.notEqual(answer.interrupted, true, "the answer is not interrupted");
    const status = Zotero.getMainWindow()
      .document.querySelector(
        `[data-workflow-panel-id="${side.panelId}"] #llm-status`,
      )
      ?.textContent?.trim();
    assert.notInclude(status || "", "Error", "no error under the composer");

    const runIds =
      typeof answer.agentRunId === "string" && answer.agentRunId
        ? [answer.agentRunId]
        : [];
    assertNoRows(
      await api.getEphemeralConversationRowCounts(side.conversationKey, runIds),
      "after an agent-mode Library-chat side turn",
    );
    assert.deepEqual(
      readSelectionPrefs(),
      prefsBefore,
      "the side chat's Chat/Agent switch does not change the saved default",
    );
  });
});
