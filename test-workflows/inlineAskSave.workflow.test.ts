import { assert } from "chai";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestReaderInlineAskCard,
  WorkflowTestReaderInlineAskOpen,
  WorkflowTestReaderInlineAskSave,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * Inline Ask's Save as annotation in the real reader: from a real text
 * selection, the card saves Zotero's own selection draft as a highlight
 * with the edited comment and the chosen color, through the agent action
 * route (authorization, write lock, change journal, verified receipt).
 *
 * Every check of the saved highlight reads Zotero's itemAnnotations table,
 * not the card or the tool result. Only the model is scripted (a held fake
 * provider).
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-inline-ask-save.invalid/v1";
const GROUP_ID = "workflow-inline-ask-save-group";
const ENTRY_ID = "workflow-inline-ask-save-model";
const MODEL = "inline-ask-save-model";

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
];

const SELECTED_TEXT = "INLINE_ASK_SAVE_PASSAGE";

/** Zotero stores highlight as annotation type 1. */
const HIGHLIGHT_TYPE = 1;

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

async function annotationRows(attachmentId: number) {
  const rows = await Zotero.DB.queryAsync(
    `SELECT A.itemID AS itemID, type, text, comment, color, pageLabel,
            sortIndex, position,
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
    color: String(row.color),
    pageLabel: row.pageLabel === null ? null : String(row.pageLabel),
    sortIndex: String(row.sortIndex),
    position: JSON.parse(String(row.position)),
    trashed: Boolean(row.trashed),
  }));
}

describe("workflow: Inline Ask saves a selection as an annotation", function () {
  this.timeout(120_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
  let restoreSaveFromJSON: (() => void) | null = null;

  async function createFixture(title: string): Promise<WorkflowTestFixture> {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
      pages: [
        `Drift study. The ${SELECTED_TEXT} reports slow change in the cortex.`,
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

  async function waitForSave(
    check: (state: WorkflowTestReaderInlineAskSave) => boolean,
    label: string,
  ): Promise<WorkflowTestReaderInlineAskSave> {
    const deadline = Date.now() + 20_000;
    let state = api.readReaderInlineAskSave();
    while (Date.now() < deadline) {
      state = api.readReaderInlineAskSave();
      if (check(state)) return state;
      await Zotero.Promise.delay(50);
    }
    assert.fail(`${label}: ${JSON.stringify(state)}`);
  }

  /** Opens the card on a real selection and lets the model answer. */
  async function askAndAnswer(
    fixture: WorkflowTestFixture,
    draft: "native" | "native_cross_page" = "native",
    withPanel = true,
  ): Promise<WorkflowTestReaderInlineAskOpen> {
    const panel = withPanel
      ? await api.renderPanelForItem(fixture.parentItemId)
      : null;
    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
      ...(panel ? { panelId: panel.panelId } : {}),
      draft,
    });
    assert.isTrue(opened.mounted, JSON.stringify(opened));
    const question = `inline-ask-save-question-${Date.now()}`;
    await api.sendReaderInlineAsk({ text: question });
    const stream = await provider.waitForStream(question);
    stream.push("Drift is **slow** [[cite:X]].\n\n- first point");
    stream.finish();
    await waitForCard(
      (card) => card.phase === "answered" && card.answers.length === 1,
      "the answer completes",
    );
    return opened;
  }

  function draftOf(opened: WorkflowTestReaderInlineAskOpen) {
    const annotation = opened.draft?.annotation as {
      text: string;
      sortIndex: string;
      pageLabel: string;
      position: { pageIndex: number; rects: number[][] };
    };
    assert.isOk(annotation, JSON.stringify(opened.draft));
    return annotation;
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
    await initAgentChangeJournal();
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
    Zotero.Prefs.set(PREF_PREFIX + "showPopupAddText", true, true);
    Zotero.Prefs.set(PREF_PREFIX + "showPopupInlineAsk", true, true);
  });

  afterEach(async function () {
    restoreSaveFromJSON?.();
    restoreSaveFromJSON = null;
    provider.failOpenStreams("workflow case ended");
    await api.endReaderInlineAsk({ via: "discard" });
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  for (const [mode, via, color] of [
    ["safe", "click", "#2ea8e5"],
    ["auto", "keyboard", "#a28ae5"],
  ] as const) {
    it(`saves the real selection draft with an edited comment and color in ${mode} mode`, async function () {
      Zotero.Prefs.set(PREF_PREFIX + "originalAgentPermissionMode", mode, true);
      const fixture = await createFixture(`Inline Ask save ${mode}`);
      const opened = await askAndAnswer(fixture);
      const draft = draftOf(opened);
      assert.equal(
        opened.draft!.source,
        "_primaryView._selectionPopup.annotation",
        "the draft is the one Zotero's own selection popup carries",
      );
      assert.include(draft.text, SELECTED_TEXT);
      assert.isAbove(draft.position.rects.length, 0);
      assert.isString(draft.sortIndex);
      assert.isAbove(opened.panelConversationKey, 0, JSON.stringify(opened));

      const answered = api.readReaderInlineAskSave();
      assert.isFalse(answered.footerSaveDisabled, JSON.stringify(answered));

      const view = await api.openReaderInlineAskSave({ via });
      const message = JSON.stringify(view);
      assert.equal(view.view, "save", message);
      assert.isTrue(view.saveViewShown, message);
      assert.equal(view.color, "rgb(255, 212, 0)", message);
      assert.equal(view.markText, SELECTED_TEXT, message);
      assert.equal(view.pageText, `Page ${draft.pageLabel}`, message);
      assert.equal(view.commentContentEditable, "true", message);
      assert.equal(
        view.comment.trim(),
        "Drift is slow.\n\n• first point",
        message,
      );
      assert.isFalse(view.colorsShown, message);

      const comment = `Edited ${mode} comment\nsecond line`;
      const edited = await api.editReaderInlineAskSave({ comment, color });
      assert.isTrue(edited.colorsShown, JSON.stringify(edited));
      assert.lengthOf(edited.colorLabels, 8, JSON.stringify(edited));

      assert.lengthOf(await annotationRows(fixture.pdfAttachmentId), 0);
      await api.confirmReaderInlineAskSave({ via });
      const closed = await waitForSave(
        (state) => !state.mounted || Boolean(state.error),
        "the card closes after a verified save",
      );
      assert.isFalse(closed.mounted, JSON.stringify(closed));

      const rows = await annotationRows(fixture.pdfAttachmentId);
      assert.lengthOf(rows, 1, JSON.stringify(rows));
      const [row] = rows;
      assert.equal(row.type, HIGHLIGHT_TYPE);
      assert.equal(row.color, color);
      assert.equal(row.comment, comment);
      assert.equal(row.text, draft.text.trim());
      assert.equal(row.pageLabel, draft.pageLabel);
      assert.equal(row.sortIndex, draft.sortIndex);
      assert.equal(row.position.pageIndex, draft.position.pageIndex);
      assert.deepEqual(row.position.rects, draft.position.rects);
      assert.notProperty(row.position, "nextPageRects");
      assert.isFalse(row.trashed);

      // The change is filed under the reader panel's conversation, so its
      // undo is reachable there; never under conversation 0.
      const actions = await listJournalActions({
        conversationKey: opened.panelConversationKey,
        limit: 10,
      });
      assert.isTrue(
        actions.some(
          (action) =>
            action.toolName === "annotate_pdf" &&
            action.conversationKey === opened.panelConversationKey,
        ),
        JSON.stringify(
          actions.map(({ toolName, conversationKey, status }) => ({
            toolName,
            conversationKey,
            status,
          })),
        ),
      );
    });
  }

  for (const via of ["back", "cancel", "escape"] as const) {
    it(`shows the passage, thread and composer again after Save then ${via}`, async function () {
      const fixture = await createFixture(`Inline Ask save ${via} passage`);
      await askAndAnswer(fixture);
      // Expanded state must survive the round trip too.
      if (via === "back") await api.clickReaderInlineAskPassage();
      const before = api.readReaderInlineAsk();
      assert.isTrue(before.passageShown, JSON.stringify(before));
      assert.include(before.passageText, SELECTED_TEXT);
      assert.equal(before.passageExpanded, via === "back");

      await api.openReaderInlineAskSave({ via: "click" });
      const inSave = api.readReaderInlineAsk();
      assert.isFalse(inSave.passageShown, JSON.stringify(inSave));
      assert.isFalse(inSave.threadShown);
      assert.isFalse(inSave.fieldShown);

      if (via === "escape") {
        await api.pressReaderInlineAskKey({ key: "Escape", target: "editor" });
      } else {
        await api.leaveReaderInlineAskSave({ via });
      }
      const after = await waitForCard(
        (card) => card.passageShown,
        "the passage line returns",
      );
      const message = JSON.stringify({ before, after });
      assert.isTrue(after.mounted, message);
      assert.equal(after.passageText, before.passageText, message);
      assert.equal(after.passageExpanded, before.passageExpanded, message);
      assert.isTrue(after.threadShown, message);
      assert.isTrue(after.fieldShown, message);
      assert.deepEqual(after.answers, before.answers, message);
      assert.equal(after.rect.height, before.rect.height, message);
    });
  }

  it("saves with no chat panel open, filed under the paper's conversation", async function () {
    Zotero.Prefs.set(PREF_PREFIX + "originalAgentPermissionMode", "auto", true);
    const fixture = await createFixture("Inline Ask save without panel");
    const opened = await askAndAnswer(fixture, "native", false);
    const draft = draftOf(opened);

    const answered = api.readReaderInlineAskSave();
    assert.isFalse(answered.footerSaveDisabled, JSON.stringify(answered));
    await api.openReaderInlineAskSave({ via: "click" });
    const comment = "Saved with the sidebar closed";
    await api.editReaderInlineAskSave({ comment, color: "#5fb236" });
    await api.confirmReaderInlineAskSave({ via: "click" });
    const closed = await waitForSave(
      (state) => !state.mounted || Boolean(state.error),
      "the card closes after a verified save",
    );
    assert.isFalse(closed.mounted, JSON.stringify(closed));

    const rows = await annotationRows(fixture.pdfAttachmentId);
    assert.lengthOf(rows, 1, JSON.stringify(rows));
    assert.equal(rows[0].comment, comment);
    assert.equal(rows[0].color, "#5fb236");
    assert.deepEqual(rows[0].position.rects, draft.position.rects);

    const actions = await listJournalActions({
      conversationKey: fixture.parentItemId,
      limit: 10,
    });
    assert.isTrue(
      actions.some((action) => action.toolName === "annotate_pdf"),
      JSON.stringify(
        actions.map(({ toolName, status }) => ({ toolName, status })),
      ),
    );
  });

  it("keeps the payload after a failed save, and the retry writes no second row", async function () {
    Zotero.Prefs.set(PREF_PREFIX + "originalAgentPermissionMode", "auto", true);
    const fixture = await createFixture("Inline Ask save retry");
    const opened = await askAndAnswer(fixture);
    const draft = draftOf(opened);
    await api.openReaderInlineAskSave({ via: "click" });
    const comment = "Retry keeps this comment";
    await api.editReaderInlineAskSave({ comment, color: "#ff6666" });

    // Zotero commits the row, then the call fails: the case a retry must
    // not duplicate.
    const annotations = Zotero.Annotations;
    const original = annotations.saveFromJSON;
    let failures = 0;
    annotations.saveFromJSON = async (...args: unknown[]) => {
      const saved = await original.apply(annotations, args);
      if (failures++ === 0) throw new Error("Simulated failure after commit");
      return saved;
    };
    restoreSaveFromJSON = () => {
      annotations.saveFromJSON = original;
    };

    await api.confirmReaderInlineAskSave({ via: "click" });
    const failed = await waitForSave(
      (state) => Boolean(state.error) || !state.mounted,
      "the failed save shows its error",
    );
    const message = JSON.stringify(failed);
    assert.isTrue(failed.mounted, message);
    assert.equal(failed.view, "save", message);
    assert.include(failed.error, "Simulated failure after commit", message);
    assert.equal(failed.comment.trim(), comment, message);
    assert.equal(failed.color, "rgb(255, 102, 102)", message);
    assert.isFalse(failed.confirmDisabled, message);
    assert.lengthOf(await annotationRows(fixture.pdfAttachmentId), 1);

    restoreSaveFromJSON();
    restoreSaveFromJSON = null;
    await api.confirmReaderInlineAskSave({ via: "click" });
    const done = await waitForSave(
      (state) =>
        !state.mounted || Boolean(state.error && state.error !== failed.error),
      "the retry closes the card",
    );
    assert.isFalse(done.mounted, JSON.stringify(done));

    const rows = await annotationRows(fixture.pdfAttachmentId);
    assert.lengthOf(rows, 1, JSON.stringify(rows));
    assert.equal(rows[0].comment, comment);
    assert.equal(rows[0].color, "#ff6666");
    assert.deepEqual(rows[0].position.rects, draft.position.rects);
  });

  it("disables Save with a reason for a selection that continues on the next page", async function () {
    const fixture = await createFixture("Inline Ask save cross page");
    await askAndAnswer(fixture, "native_cross_page");
    const state = api.readReaderInlineAskSave();
    const message = JSON.stringify(state);
    assert.isTrue(state.footerSaveDisabled, message);
    assert.include(state.footerSaveTitle, "next page", message);
    const opened = await api.openReaderInlineAskSave({ via: "keyboard" });
    assert.equal(opened.view, "thread", JSON.stringify(opened));
    assert.lengthOf(await annotationRows(fixture.pdfAttachmentId), 0);
  });
});
