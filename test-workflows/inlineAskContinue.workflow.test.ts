import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestPanel,
  WorkflowTestReaderInlineAskCard,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";

/**
 * Inline Ask's Continue in sidebar in the real reader: the card's finished
 * turns become a new paper conversation in the reader tab's panel, stored as
 * real messages with the selection on the first question, titled, listed in
 * history, and reopened from it. A panel that is answering refuses, and the
 * card keeps its conversation. In a Claude Code chat the paper, page,
 * passage and turns also go into the composer for the provider's fresh
 * session; a Codex app-server thread gets the stored turns as history, so
 * no chip repeats them. The composer's own chips stay.
 *
 * The plugin's real popup handler, card, panel handle, stores and history
 * run; only the network is scripted (a held fake provider).
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-inline-ask-continue.invalid/v1";
const GROUP_ID = "workflow-inline-ask-continue-group";
const ENTRY_ID = "workflow-inline-ask-continue-model";
const MODEL = "inline-ask-continue-model";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "codexAppServerModel",
  "codexAppServerReasoning",
  "codexAppServerPath",
  "showPopupAddText",
  "showPopupInlineAsk",
  "outputTokenAutoMigrationNoticePending",
];

const SELECTED_TEXT = "INLINE_ASK_CONTINUE_PASSAGE";
const SECOND_SELECTED_TEXT = "INLINE_ASK_CONTINUE_SECOND";
const EXPLAIN_PROMPT =
  "Explain this passage in plain language, using the context of the paper.";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: Inline Ask continue in sidebar", function () {
  this.timeout(120_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];

  async function createFixture(title: string): Promise<WorkflowTestFixture> {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
      pages: [
        `Drift study. The ${SELECTED_TEXT} reports slow change. Later the ${SECOND_SELECTED_TEXT} follows.`,
      ],
    });
    fixtures.push(fixture);
    return fixture;
  }

  async function waitForCard(
    check: (card: WorkflowTestReaderInlineAskCard) => boolean,
    label: string,
  ): Promise<WorkflowTestReaderInlineAskCard> {
    const deadline = Date.now() + 20_000;
    let card = api.readReaderInlineAsk();
    while (Date.now() < deadline) {
      card = api.readReaderInlineAsk();
      if (check(card)) return card;
      await Zotero.Promise.delay(50);
    }
    assert.fail(`${label}: ${JSON.stringify(card)}`);
  }

  async function waitFor(check: () => Promise<boolean>, label: string) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Zotero.Promise.delay(50);
    }
    assert.fail(label);
  }

  /** The panel in the reader pane, a card, a pill answer and a follow-up. */
  async function askTwoTurns(
    fixture: WorkflowTestFixture,
    tag: string,
  ): Promise<{ panel: WorkflowTestPanel; panelConversationKey: number }> {
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
      panelId: panel.panelId,
    });
    assert.isTrue(opened.mounted, JSON.stringify(opened));
    assert.isAbove(opened.panelConversationKey, 0, JSON.stringify(opened));
    assert.isTrue(opened.card.sidebarDisabled, "nothing to continue yet");

    await api.sendReaderInlineAsk({ pillId: "explain" });
    const first = await provider.waitForStream(EXPLAIN_PROMPT);
    first.push(`${tag} first answer`);
    first.finish();
    await waitForCard(
      (card) => card.phase === "answered" && card.answers.length === 1,
      "the pill's answer completes",
    );
    const followUp = `${tag} follow-up question`;
    await api.sendReaderInlineAsk({ text: followUp });
    const second = await provider.waitForStream(followUp);
    second.push(`${tag} second answer`);
    second.finish();
    const answered = await waitForCard(
      (card) => card.phase === "answered" && card.answers.length === 2,
      "the follow-up's answer completes",
    );
    assert.isFalse(answered.sidebarDisabled, JSON.stringify(answered));
    return { panel, panelConversationKey: opened.panelConversationKey };
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    provider = installHeldChatProvider(API_BASE);
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
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "showPopupAddText", true, true);
    Zotero.Prefs.set(PREF_PREFIX + "showPopupInlineAsk", true, true);
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await api.endReaderInlineAsk({ via: "discard" });
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("opens a new paper chat with the turns as messages, titled, in history, and reopened from it", async function () {
    const fixture = await createFixture("Inline Ask continue");
    const tag = "continue-upstream";
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    // The panel's chat already has a turn, so the seeded chat must be new.
    const before = await api.seedPanelStoredUserMessage(
      panel.panelId,
      "existing panel question",
    );
    const previousKey = Number(before.conversationKey);
    assert.isAbove(previousKey, 0);

    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
      panelId: panel.panelId,
    });
    assert.isTrue(opened.mounted, JSON.stringify(opened));
    assert.equal(opened.panelConversationKey, previousKey);
    await api.sendReaderInlineAsk({ pillId: "explain" });
    const first = await provider.waitForStream(EXPLAIN_PROMPT);
    first.push(`${tag} first answer`);
    first.finish();
    await waitForCard(
      (card) => card.phase === "answered" && card.answers.length === 1,
      "the pill's answer completes",
    );
    const followUp = `${tag} follow-up question`;
    await api.sendReaderInlineAsk({ text: followUp });
    const second = await provider.waitForStream(followUp);
    second.push(`${tag} second answer`);
    second.finish();
    await waitForCard(
      (card) => card.phase === "answered" && card.answers.length === 2,
      "the follow-up's answer completes",
    );

    const moved = await api.continueReaderInlineAskInSidebar();
    assert.isFalse(moved.disabledBefore, JSON.stringify(moved));
    assert.isFalse(moved.cardOpen, `the card closes: ${JSON.stringify(moved)}`);
    assert.equal(moved.error, "");

    const expectedOrder = [
      ["user", EXPLAIN_PROMPT],
      ["assistant", `${tag} first answer`],
      ["user", followUp],
      ["assistant", `${tag} second answer`],
    ];
    let shown = await api.readPanelChatMessages(panel.panelId);
    await waitFor(async () => {
      shown = await api.readPanelChatMessages(panel.panelId);
      return shown.rendered.length === 4;
    }, "the panel draws the seeded messages");
    const message = JSON.stringify(shown);
    assert.notEqual(shown.conversationKey, previousKey, message);
    assert.equal(shown.conversationKind, "paper", message);
    assert.equal(shown.conversationSystem, "upstream", message);
    // Stored: the prompt the model got (not the pill label), in order.
    assert.deepEqual(
      shown.stored.map((row) => [row.role, row.text]),
      expectedOrder,
      message,
    );
    assert.deepEqual(
      shown.rendered.map((row) => [row.role, row.text]),
      expectedOrder,
      message,
    );
    const context = shown.stored[0].selectedTextContexts?.[0];
    assert.isOk(context, message);
    assert.equal(context!.text, SELECTED_TEXT);
    assert.equal(context!.source, "pdf");
    assert.equal(context!.contextItemId, fixture.pdfAttachmentId);
    assert.equal(context!.pageIndex, 0);
    assert.equal(context!.paperContext?.itemId, fixture.parentItemId);
    for (const row of shown.stored.slice(1)) {
      assert.isUndefined(row.selectedTextContexts, message);
    }
    assert.equal(
      shown.rendered[1].model,
      MODEL,
      "the answers keep their model",
    );
    assert.equal(shown.rendered[0].selectedText, SELECTED_TEXT, message);
    assert.equal(shown.rendered[2].selectedText, "", message);
    // Titled by the first question, by the panel's own title rule.
    assert.match(
      shown.catalog!.title,
      /^Explain this passage in plain language, using the context of/,
      message,
    );
    assert.equal(shown.catalog!.userTurnCount, 2, message);
    assert.equal(shown.catalog!.paperItemID, fixture.parentItemId, message);
    const composer = await api.getDiagnostics(panel.panelId);
    assert.notInclude(
      composer.selectedContextLabels,
      "Inline Ask",
      "an API chat needs no handover",
    );

    // The chat the panel showed before keeps its turn.
    const previous = await api.getConversationHistoryTexts(previousKey);
    assert.deepEqual(
      previous.stored.map((row) => row.text),
      ["existing panel question"],
    );

    // Switch away, find the chat in history, and open it again.
    const seededKey = shown.conversationKey;
    await api.startNewPanelConversation(panel.panelId);
    const away = await api.readPanelChatMessages(panel.panelId);
    assert.notEqual(away.conversationKey, seededKey);
    const rows = await api.listPanelHistory(panel.panelId, { reopen: true });
    const row = rows.find((entry) => entry.conversationKey === seededKey);
    assert.isOk(row, JSON.stringify(rows));
    assert.isFalse(Boolean(row!.isDraft), JSON.stringify(row));
    // The row shows the catalog title, shortened to fit the row.
    assert.match(row!.title, /^Explain this passage/, JSON.stringify(row));
    await api.clickPanelHistoryRow(panel.panelId, seededKey);
    const reopened = await api.readPanelChatMessages(panel.panelId);
    assert.equal(reopened.conversationKey, seededKey);
    assert.deepEqual(
      reopened.rendered.map((entry) => [entry.role, entry.text]),
      expectedOrder,
      JSON.stringify(reopened),
    );
    assert.equal(reopened.rendered[0].selectedText, SELECTED_TEXT);

    // A fresh mount of the paper's panel lists it too.
    const remounted = await api.renderPanelForItem(fixture.parentItemId);
    const remountedRows = await api.listPanelHistory(remounted.panelId, {
      reopen: true,
    });
    assert.isOk(
      remountedRows.find((entry) => entry.conversationKey === seededKey),
      JSON.stringify(remountedRows),
    );
  });

  it("moves a panel in Library chat to a new chat of the reader's paper", async function () {
    const fixture = await createFixture("Inline Ask continue library");
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const library = await api.togglePanelConversationMode(panel.panelId);
    assert.equal(library.conversationKind, "global");
    await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
      panelId: panel.panelId,
    });
    const question = "continue-library question";
    await api.sendReaderInlineAsk({ text: question });
    const stream = await provider.waitForStream(question);
    stream.push("continue-library answer");
    stream.finish();
    await waitForCard((card) => card.phase === "answered", "answered");

    const moved = await api.continueReaderInlineAskInSidebar();
    assert.isFalse(moved.cardOpen, JSON.stringify(moved));
    let shown = await api.readPanelChatMessages(panel.panelId);
    await waitFor(async () => {
      shown = await api.readPanelChatMessages(panel.panelId);
      return shown.rendered.length === 2;
    }, "the panel draws the seeded turn");
    const message = JSON.stringify(shown);
    assert.equal(shown.conversationKind, "paper", message);
    assert.equal(shown.catalog?.paperItemID, fixture.parentItemId, message);
    assert.deepEqual(
      shown.stored.map((row) => [row.role, row.text]),
      [
        ["user", question],
        ["assistant", "continue-library answer"],
      ],
      message,
    );
  });

  it("keeps the card and says why while the panel is answering", async function () {
    const fixture = await createFixture("Inline Ask continue busy");
    const { panel, panelConversationKey } = await askTwoTurns(
      fixture,
      "continue-busy",
    );
    const busyQuestion = "panel-busy-question-marker";
    const started = await api.startPanelChatSend(panel.panelId, busyQuestion);
    assert.equal(started.conversationKey, panelConversationKey);
    const panelStream = await provider.waitForStream(busyQuestion);

    const refused = await api.continueReaderInlineAskInSidebar();
    assert.isTrue(refused.cardOpen, JSON.stringify(refused));
    assert.equal(
      refused.error,
      "The sidebar is answering. Try again when it finishes.",
    );
    const kept = api.readReaderInlineAsk();
    assert.equal(kept.phase, "answered", JSON.stringify(kept));
    assert.deepEqual(kept.questions, [
      "Explain",
      "continue-busy follow-up question",
    ]);
    assert.lengthOf(kept.answers, 2);
    const still = await api.readPanelChatMessages(panel.panelId);
    assert.equal(still.conversationKey, panelConversationKey);

    // Once the panel is done, the same card moves.
    panelStream.push("panel answer");
    panelStream.finish();
    await waitFor(async () => {
      const diagnostics = await api.getDiagnostics(panel.panelId);
      return !/Thinking|Generating|Streaming/i.test(
        diagnostics.statusText || "",
      );
    }, "the panel's answer ends");
    let moved = await api.continueReaderInlineAskInSidebar();
    // The panel's turn may still be finishing its stored row.
    for (let attempt = 0; moved.cardOpen && attempt < 20; attempt++) {
      await Zotero.Promise.delay(100);
      moved = await api.continueReaderInlineAskInSidebar();
    }
    assert.isFalse(moved.cardOpen, JSON.stringify(moved));
    const shown = await api.readPanelChatMessages(panel.panelId);
    assert.notEqual(shown.conversationKey, panelConversationKey);
    assert.lengthOf(shown.stored, 4, JSON.stringify(shown));
  });

  it("in a Codex app-server chat, stores the turns in Codex's store and adds no chip (the new thread gets them as history)", async function () {
    api.configureCodexModelCatalogs(
      Array.from({ length: 12 }, () => ({
        models: [
          {
            id: "gpt-workflow-codex",
            model: "gpt-workflow-codex",
            displayName: "gpt-workflow-codex",
            description: "",
            hidden: false,
            supportedReasoningEfforts: ["low", "high"],
          },
        ],
      })),
    );
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", true, true);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "codex", true);
    Zotero.Prefs.set(
      PREF_PREFIX + "codexAppServerModel",
      "gpt-workflow-codex",
      true,
    );
    Zotero.Prefs.set(PREF_PREFIX + "codexAppServerReasoning", "auto", true);
    Zotero.Prefs.set(
      PREF_PREFIX + "codexAppServerPath",
      "/workflow/codex",
      true,
    );
    const fixture = await createFixture("Inline Ask continue Codex");
    const tag = "continue-codex";
    const { panel } = await askTwoTurns(fixture, tag);
    const panelBefore = await api.readPanelChatMessages(panel.panelId);
    assert.equal(panelBefore.conversationSystem, "codex");

    const moved = await api.continueReaderInlineAskInSidebar();
    assert.isFalse(moved.cardOpen, JSON.stringify(moved));
    let shown = await api.readPanelChatMessages(panel.panelId);
    await waitFor(async () => {
      shown = await api.readPanelChatMessages(panel.panelId);
      return shown.rendered.length === 4;
    }, "the panel draws the seeded Codex messages");
    const message = JSON.stringify(shown);
    assert.equal(shown.conversationSystem, "codex", message);
    assert.equal(shown.conversationKind, "paper", message);
    assert.isAbove(shown.conversationKey, 0, message);
    assert.deepEqual(
      shown.stored.map((row) => [row.role, row.text]),
      [
        ["user", EXPLAIN_PROMPT],
        ["assistant", `${tag} first answer`],
        ["user", `${tag} follow-up question`],
        ["assistant", `${tag} second answer`],
      ],
      message,
    );
    assert.equal(
      shown.stored[0].selectedTextContexts?.[0]?.text,
      SELECTED_TEXT,
      message,
    );
    assert.equal(shown.catalog?.userTurnCount, 2, message);
    assert.isAbove(shown.catalog?.title.length || 0, 0, message);
    const composer = await api.getDiagnostics(panel.panelId);
    assert.notInclude(
      composer.selectedContextLabels,
      "Inline Ask",
      `no handover chip would repeat the injected turns: ${JSON.stringify(composer.selectedContextLabels)}`,
    );
    assert.deepEqual(shown.composerSelectedTexts, [], message);
    const rows = await api.listPanelHistory(panel.panelId, { reopen: true });
    const row = rows.find(
      (entry) => entry.conversationKey === shown.conversationKey,
    );
    assert.isOk(row, JSON.stringify(rows));
    assert.isFalse(Boolean(row!.isDraft), JSON.stringify(row));
  });

  it("Add Text keeps a card that holds a conversation, and Continue keeps the composer's chip", async function () {
    const fixture = await createFixture("Inline Ask continue keeps chips");
    const { panel, panelConversationKey } = await askTwoTurns(
      fixture,
      "continue-chips",
    );
    const panelBefore = await api.readPanelChatMessages(panel.panelId);
    assert.lengthOf(panelBefore.stored, 0, "the panel shows an empty draft");

    // Add Text on a new selection: the chip goes to the panel, the card
    // stays, and Add Text's question box does not replace it.
    const added = await api.showNewReaderSelectionPopup({
      selectedText: SECOND_SELECTED_TEXT,
      pressAddText: true,
    });
    assert.isTrue(added.cardOpen, JSON.stringify(added));
    assert.isFalse(added.addTextPromptOpen, JSON.stringify(added));
    const card = api.readReaderInlineAsk();
    assert.equal(card.phase, "answered", JSON.stringify(card));
    assert.lengthOf(card.answers, 2);
    let withChip = await api.readPanelChatMessages(panel.panelId);
    await waitFor(async () => {
      withChip = await api.readPanelChatMessages(panel.panelId);
      return withChip.composerSelectedTexts.some(
        (entry) => entry.text === SECOND_SELECTED_TEXT,
      );
    }, "Add Text puts the chip in the panel's composer");
    assert.equal(withChip.conversationKey, panelConversationKey);

    // Continue reuses that empty draft and leaves the chip in the composer.
    const moved = await api.continueReaderInlineAskInSidebar();
    assert.isFalse(moved.cardOpen, JSON.stringify(moved));
    let shown = await api.readPanelChatMessages(panel.panelId);
    await waitFor(async () => {
      shown = await api.readPanelChatMessages(panel.panelId);
      return shown.rendered.length === 4;
    }, "the panel draws the seeded messages");
    const message = JSON.stringify(shown);
    assert.equal(shown.conversationKey, panelConversationKey, message);
    assert.lengthOf(shown.stored, 4, message);
    assert.deepEqual(
      shown.composerSelectedTexts.map((entry) => [entry.source, entry.text]),
      [["pdf", SECOND_SELECTED_TEXT]],
      message,
    );
    const composer = await api.getDiagnostics(panel.panelId);
    assert.lengthOf(
      composer.selectedContextLabels,
      1,
      JSON.stringify(composer.selectedContextLabels),
    );
  });

  it("in a Claude Code chat, stores the turns in Claude's store, hands the passage and turns over, and keeps the chat through reopen", async function () {
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", true, true);
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "claude_code", true);
    const fixture = await createFixture("Inline Ask continue Claude");
    const tag = "continue-claude";
    const { panel } = await askTwoTurns(fixture, tag);
    const panelBefore = await api.readPanelChatMessages(panel.panelId);
    assert.equal(panelBefore.conversationSystem, "claude_code");

    const moved = await api.continueReaderInlineAskInSidebar();
    assert.isFalse(moved.cardOpen, JSON.stringify(moved));
    let shown = await api.readPanelChatMessages(panel.panelId);
    await waitFor(async () => {
      shown = await api.readPanelChatMessages(panel.panelId);
      return shown.rendered.length === 4;
    }, "the panel draws the seeded Claude messages");
    const message = JSON.stringify(shown);
    assert.equal(shown.conversationSystem, "claude_code", message);
    assert.equal(shown.conversationKind, "paper", message);
    const expectedOrder = [
      ["user", EXPLAIN_PROMPT],
      ["assistant", `${tag} first answer`],
      ["user", `${tag} follow-up question`],
      ["assistant", `${tag} second answer`],
    ];
    assert.deepEqual(
      shown.stored.map((row) => [row.role, row.text]),
      expectedOrder,
      message,
    );
    // Claude's history and its empty-session clean-up treat a chat with
    // user turns or a title as a real chat, never as an empty draft.
    assert.equal(shown.catalog?.userTurnCount, 2, message);
    assert.match(shown.catalog?.title || "", /^Explain this passage/, message);

    // The fresh Claude session gets the passage and turns from the chip.
    const chips = shown.composerSelectedTexts.filter(
      (entry) => entry.source === "inlineask",
    );
    assert.lengthOf(chips, 1, message);
    const handover = chips[0].text;
    assert.isTrue(
      handover.startsWith(`Paper: Inline Ask continue Claude`),
      handover,
    );
    assert.include(handover, `Selected passage:\n${SELECTED_TEXT}`);
    assert.isAbove(
      handover.indexOf(`Q: ${EXPLAIN_PROMPT}`),
      handover.indexOf(SELECTED_TEXT),
    );
    assert.include(handover, `A: ${tag} second answer`);
    const composer = await api.getDiagnostics(panel.panelId);
    assert.include(composer.selectedContextLabels, "Inline Ask");

    // Listed as a titled chat, reopened from history, and still listed
    // after a fresh mount.
    const seededKey = shown.conversationKey;
    await api.startNewPanelConversation(panel.panelId);
    const away = await api.readPanelChatMessages(panel.panelId);
    assert.notEqual(away.conversationKey, seededKey);
    const rows = await api.listPanelHistory(panel.panelId, { reopen: true });
    const row = rows.find((entry) => entry.conversationKey === seededKey);
    assert.isOk(row, JSON.stringify(rows));
    assert.isFalse(Boolean(row!.isDraft), JSON.stringify(row));
    assert.match(row!.title, /^Explain this passage/, JSON.stringify(row));
    await api.clickPanelHistoryRow(panel.panelId, seededKey);
    const reopened = await api.readPanelChatMessages(panel.panelId);
    assert.equal(reopened.conversationKey, seededKey);
    assert.equal(reopened.conversationSystem, "claude_code");
    assert.deepEqual(
      reopened.rendered.map((entry) => [entry.role, entry.text]),
      expectedOrder,
      JSON.stringify(reopened),
    );
    const remounted = await api.renderPanelForItem(fixture.parentItemId);
    const remountedRows = await api.listPanelHistory(remounted.panelId, {
      reopen: true,
    });
    const remountedRow = remountedRows.find(
      (entry) => entry.conversationKey === seededKey,
    );
    assert.isOk(remountedRow, JSON.stringify(remountedRows));
    assert.isFalse(Boolean(remountedRow!.isDraft));
  });

  it("opens a collapsed reader pane and seeds the reader tab's own chat", async function () {
    const fixture = await createFixture("Inline Ask continue reveal");
    const win = Zotero.getMainWindow();
    const collapsedBefore = win.ZoteroContextPane.collapsed;
    try {
      // No workflow panel: the reader tab's own chat section takes the chat.
      await api.openReaderInlineAsk({
        attachmentItemId: fixture.pdfAttachmentId,
        pageIndex: 0,
        selectedText: SELECTED_TEXT,
      });
      win.ZoteroContextPane.collapsed = true;
      const details: any = getReaderContextPanelForTab(
        win.document,
        win.Zotero_Tabs.selectedID,
      );
      assert.isOk(details?.querySelector(".llm-dedicated-chat-pane"));
      assert.isTrue(details.sidenav._collapsed, "the pane starts collapsed");

      const question = "continue-reveal question";
      await api.sendReaderInlineAsk({ text: question });
      const stream = await provider.waitForStream(question);
      stream.push("continue-reveal answer");
      stream.finish();
      await waitForCard((card) => card.phase === "answered", "answered");

      const moved = await api.continueReaderInlineAskInSidebar();
      assert.isFalse(moved.cardOpen, JSON.stringify(moved));
      // Zotero expands the pane after its own scroll to the section.
      await waitFor(
        async () =>
          !details.sidenav._collapsed && !win.ZoteroContextPane.collapsed,
        "the reader pane opens",
      );
      const root: any = details.querySelector(
        ".llm-dedicated-chat-pane #llm-main",
      );
      const key = Number(root?.dataset.itemId || 0);
      assert.isAbove(key, 0);
      assert.isAbove(root.getBoundingClientRect().width, 100);
      const texts = await api.getConversationHistoryTexts(key);
      assert.deepEqual(
        texts.stored.map((row) => [row.role, row.text]),
        [
          ["user", question],
          ["assistant", "continue-reveal answer"],
        ],
      );
      await waitFor(
        async () =>
          root.querySelectorAll("#llm-chat-box .llm-message-wrapper").length ===
          2,
        "the reader tab's chat draws the seeded turn",
      );
    } finally {
      win.ZoteroContextPane.collapsed = collapsedBefore;
    }
  });
});
