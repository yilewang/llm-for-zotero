import { assert } from "chai";
import {
  CODEX_DIRECT_RESPONSES_URL,
  loadCodexAuthJson,
} from "../../src/codexAuth/auth";
import { loadCodexDirectCatalog } from "../../src/codexAuth/modelCatalog";
import { initAgentChangeJournal } from "../../src/agent/store/changeJournal";
import { resolveInlineAskModelTarget } from "../../src/modules/contextPanel/selectionPrompt/inlineAskModel";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestReaderInlineAskCard,
  WorkflowTestReaderInlineAskSave,
} from "../../src/modules/contextPanel/workflowTestTypes";
import { liveModelName } from "../agent/liveAgentCredentials";

/**
 * Live Inline Ask: the real card in the real reader, answered by Codex
 * Direct (`authMode: "codex_auth"`, credentials read by the plugin from
 * ~/.codex/auth.json). Only contracts are asserted, never model prose:
 * a non-empty streamed answer, no error state, the model line, a follow-up,
 * the ephemeral contract (no conversation rows before Save), and a native
 * readback of the saved highlight.
 *
 * Runs only with LLM_FOR_ZOTERO_AGENT_LIVE=1 (`--agent-live`). No token is
 * read, printed or logged by this test.
 */

declare const Zotero: any;
declare const Services: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const GROUP_ID = "live-inline-ask-codex-group";
const ENTRY_ID = "live-inline-ask-codex-model";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const HIGHLIGHT_TYPE = 1;

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "showPopupAddText",
  "showPopupInlineAsk",
  "originalAgentPermissionMode",
  "outputTokenAutoMigrationNoticePending",
  "inlineAskModelEntryId",
];

// Short enough to stay on one line of the generated PDF page.
const SELECTED_TEXT = "representational drift";

function envValue(name: string): string {
  try {
    return String(Services.env.get(name) || "").trim();
  } catch {
    return "";
  }
}

async function annotationRows(attachmentId: number) {
  const rows = await Zotero.DB.queryAsync(
    `SELECT A.itemID AS itemID, type, text, comment, position,
            EXISTS (SELECT 1 FROM deletedItems DI
                     WHERE DI.itemID = A.itemID) AS trashed
       FROM itemAnnotations A WHERE parentItemID = ?
      ORDER BY A.itemID`,
    [attachmentId],
  );
  return rows.map((row: any) => ({
    itemID: Number(row.itemID),
    type: Number(row.type),
    text: row.text === null ? null : String(row.text),
    comment: row.comment === null ? null : String(row.comment),
    position: JSON.parse(String(row.position)),
    trashed: Boolean(row.trashed),
  }));
}

describe("live: Inline Ask answered by Codex Direct", function () {
  this.timeout(240_000);

  let api: WorkflowTestApi;
  let model = "";
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];

  async function waitForCard(
    check: (card: WorkflowTestReaderInlineAskCard) => boolean,
    label: string,
    timeoutMs = 120_000,
  ): Promise<WorkflowTestReaderInlineAskCard> {
    const deadline = Date.now() + timeoutMs;
    let card = api.readReaderInlineAsk();
    while (Date.now() < deadline) {
      card = api.readReaderInlineAsk();
      // An error state ends the wait at once; it is never a valid answer.
      if (card.answers.some((answer) => answer.status === "error")) break;
      if (check(card)) return card;
      await Zotero.Promise.delay(250);
    }
    assert.fail(`${label}: ${JSON.stringify(card)}`);
  }

  async function waitForSave(
    check: (state: WorkflowTestReaderInlineAskSave) => boolean,
    label: string,
  ): Promise<WorkflowTestReaderInlineAskSave> {
    const deadline = Date.now() + 30_000;
    let state = api.readReaderInlineAskSave();
    while (Date.now() < deadline) {
      state = api.readReaderInlineAskSave();
      if (check(state)) return state;
      await Zotero.Promise.delay(50);
    }
    assert.fail(`${label}: ${JSON.stringify(state)}`);
  }

  before(async function () {
    if (envValue("LLM_FOR_ZOTERO_AGENT_LIVE") !== "1") {
      this.skip();
    }
    // The plugin modules bundled into this test read the plugin's toolkit
    // global; the test runner's window does not have it.
    const scope = globalThis as unknown as { ztoolkit?: unknown };
    scope.ztoolkit ??= (Zotero as any).LLMForZotero?.data?.ztoolkit;
    assert.isOk(scope.ztoolkit, "the plugin toolkit should be available");
    // Presence check only: booleans, never the token values.
    const auth = await loadCodexAuthJson();
    const hasCredentials = Boolean(
      String(auth?.tokens?.access_token || "").trim() ||
      String(auth?.tokens?.refresh_token || "").trim(),
    );
    if (!hasCredentials) {
      console.log(
        "SKIP: no usable codex_auth credentials; run `codex login` to create ~/.codex/auth.json.",
      );
      this.skip();
    }
    try {
      const catalog = await loadCodexDirectCatalog({ force: true });
      const requested = liveModelName(DEFAULT_CODEX_MODEL);
      const listed = catalog.models.find(
        (entry) => entry.model.toLowerCase() === requested.toLowerCase(),
      );
      if (listed) model = listed.model;
      else if (!envValue("LLM_FOR_ZOTERO_LIVE_MODEL") && catalog.models[0])
        model = catalog.models[0].model;
    } catch {
      console.log("SKIP: the Codex Direct model catalog could not be loaded.");
      this.skip();
    }
    if (!model) {
      console.log("SKIP: the Codex Direct catalog lists no usable model.");
      this.skip();
    }

    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero?.api?.workflowTest as WorkflowTestApi;
    assert.isOk(api, "workflow test API should be installed");
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    Zotero.Prefs.set(PREF_PREFIX + "conversationSystem", "upstream", true);
    Zotero.Prefs.set(PREF_PREFIX + "enableCodexAppServerMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "enableClaudeCodeMode", false, true);
    Zotero.Prefs.set(PREF_PREFIX + "originalAgentPermissionMode", "auto", true);
    // No earlier card choice may redirect the request to another entry.
    Zotero.Prefs.clear(PREF_PREFIX + "inlineAskModelEntryId", true);
    setModelProviderGroups([
      {
        id: GROUP_ID,
        authMode: "codex_auth",
        providerProtocol: "codex_responses",
        apiBase: CODEX_DIRECT_RESPONSES_URL,
        apiKey: "",
        models: [{ id: ENTRY_ID, model }],
      },
    ] as any);
    Zotero.Prefs.set(PREF_PREFIX + "lastUsedModelEntryId", ENTRY_ID, true);
    assert.isOk(getModelEntryById(ENTRY_ID), "the Codex Direct model is set");
    await initAgentChangeJournal();
  });

  after(async function () {
    if (!api) return;
    await api.reset();
    for (const [key, value] of previousPrefs) {
      if (value === undefined) Zotero.Prefs.clear(PREF_PREFIX + key, true);
      else Zotero.Prefs.set(PREF_PREFIX + key, value, true);
    }
  });

  beforeEach(async function () {
    await api.reset();
    Zotero.Prefs.set(PREF_PREFIX + "showPopupAddText", true, true);
    Zotero.Prefs.set(PREF_PREFIX + "showPopupInlineAsk", true, true);
  });

  afterEach(async function () {
    await api.endReaderInlineAsk({ via: "discard" });
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("explains a selection, answers a follow-up, and saves the highlight natively", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Live Inline Ask paper",
      pdfTitle: "Live Inline Ask paper PDF",
      pages: [
        `Learning study. We report ${SELECTED_TEXT} in mouse cortex.`,
        "Neural activity patterns change across days while behavior stays the same.",
      ],
    });
    fixtures.push(fixture);

    // The request must resolve to the Codex Direct entry, not another one.
    const entry = getModelEntryById(ENTRY_ID)!;
    const target = resolveInlineAskModelTarget({
      conversationSystem: "upstream",
      sidebarEntry: entry,
      entries: [entry],
      codexDirect: {
        configured: true,
        runtimeModel: "",
        isModelAvailable: () => true,
      },
    });
    assert.isOk(target, "Inline Ask resolves a model target");
    assert.equal(target!.authMode, "codex_auth");
    assert.equal(target!.providerProtocol, "codex_responses");
    assert.equal(target!.apiBase, CODEX_DIRECT_RESPONSES_URL);
    assert.equal(target!.model, model);

    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const rowsBefore = await api.getConversationStoreRowTotals();

    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
      panelId: panel.panelId,
      draft: "native",
    });
    const openedMessage = JSON.stringify({
      mounted: opened.mounted,
      quoteText: opened.quoteText,
      modelLabel: opened.modelLabel,
      pillLabels: opened.pillLabels,
    });
    assert.isTrue(opened.mounted, openedMessage);
    assert.include(opened.pillLabels, "Explain", openedMessage);
    assert.equal(opened.modelLabel, target!.displayLabel, openedMessage);
    assert.include(
      `${opened.modelLabel} ${target!.model}`.toLowerCase(),
      model.toLowerCase(),
      "the model line names the Codex Direct model in use",
    );

    // Turn 1: the Explain pill.
    await api.sendReaderInlineAsk({ pillId: "explain" });
    const first = await waitForCard(
      (card) =>
        card.phase === "answered" &&
        card.answers.length === 1 &&
        card.answers[0].status === "done" &&
        card.answers[0].text.length > 40,
      "the Explain answer completes",
    );
    assert.deepEqual(first.questions, ["Explain"]);
    assert.isAbove(first.answers[0].text.length, 40);
    assert.isFalse(
      first.answers.some((answer) => answer.status === "error"),
      JSON.stringify(first),
    );
    assert.equal(first.modelLabel, target!.displayLabel);

    // Turn 2: a typed follow-up; both turns stay in the card.
    const followUp = "Why does this matter for long-term memory?";
    await api.sendReaderInlineAsk({ text: followUp });
    const second = await waitForCard(
      (card) =>
        card.phase === "answered" &&
        card.answers.length === 2 &&
        card.answers[1].status === "done" &&
        card.answers[1].text.length > 40,
      "the follow-up answer completes",
    );
    assert.deepEqual(second.questions, ["Explain", followUp]);
    assert.isAbove(second.answers[0].text.length, 40);
    assert.isAbove(second.answers[1].text.length, 40);
    assert.isFalse(
      second.answers.some((answer) => answer.status === "error"),
      JSON.stringify(second),
    );

    // Ephemeral contract: nothing is stored before Save or Continue.
    assert.deepEqual(
      await api.getConversationStoreRowTotals(),
      rowsBefore,
      "Inline Ask writes no conversation, message, registry or usage row before Save",
    );
    assert.lengthOf(await annotationRows(fixture.pdfAttachmentId), 0);

    // Save as annotation with an edited comment.
    const draft = opened.draft?.annotation as {
      text: string;
      position: { pageIndex: number; rects: number[][] };
    };
    assert.isOk(draft, "the popup carries Zotero's native selection draft");
    assert.include(draft.text, SELECTED_TEXT.slice(0, 40));
    assert.isAbove(draft.position.rects.length, 0);

    const saveState = api.readReaderInlineAskSave();
    assert.isFalse(saveState.footerSaveDisabled, JSON.stringify(saveState));
    const view = await api.openReaderInlineAskSave({ via: "click" });
    assert.equal(view.view, "save", JSON.stringify(view));
    const comment = "Live edited comment\nsecond line";
    await api.editReaderInlineAskSave({ comment });
    await api.confirmReaderInlineAskSave({ via: "click" });
    const closed = await waitForSave(
      (state) => !state.mounted || Boolean(state.error),
      "the card closes after a verified save",
    );
    assert.isFalse(closed.mounted, JSON.stringify(closed));

    const rows = await annotationRows(fixture.pdfAttachmentId);
    assert.lengthOf(rows, 1, JSON.stringify(rows));
    const [row] = rows;
    assert.equal(row.type, HIGHLIGHT_TYPE);
    assert.equal(row.text, draft.text.trim());
    assert.equal(row.comment, comment);
    assert.equal(row.position.pageIndex, draft.position.pageIndex);
    assert.deepEqual(row.position.rects, draft.position.rects);
    assert.isFalse(row.trashed);
  });
});
