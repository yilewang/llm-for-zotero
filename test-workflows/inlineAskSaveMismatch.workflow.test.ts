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
 * Inline Ask's Save when the committed highlight does not match the
 * selection the user saw. A real concurrent writer (a Zotero.Notifier
 * observer on the annotation's "add") moves the highlight's rects after
 * Zotero commits it and before the save reads it back. The receipt must
 * then be "unverified", the card must report failure, and the native row
 * keeps the writer's rects: the plugin does not claim a save it could not
 * confirm.
 *
 * Every check reads the itemAnnotations table.
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-inline-ask-mismatch.invalid/v1";
const GROUP_ID = "workflow-inline-ask-mismatch-group";
const ENTRY_ID = "workflow-inline-ask-mismatch-model";
const MODEL = "inline-ask-mismatch-model";
const OBSERVER_ID = "workflow-inline-ask-mismatch-writer";

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

const SELECTED_TEXT = "INLINE_ASK_MISMATCH_PASSAGE";
/** How far the concurrent writer moves the first rect, in PDF points. */
const SHIFT = 3;

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

async function annotationRows(attachmentId: number) {
  const rows = await Zotero.DB.queryAsync(
    `SELECT A.itemID AS itemID, type, text, comment, color, position
       FROM itemAnnotations A WHERE parentItemID = ? ORDER BY A.itemID`,
    [attachmentId],
  );
  return rows.map((row: any) => ({
    itemID: Number(row.itemID),
    type: Number(row.type),
    text: row.text === null ? null : String(row.text),
    comment: row.comment === null ? null : String(row.comment),
    color: String(row.color),
    position: JSON.parse(String(row.position)),
  }));
}

describe("workflow: Inline Ask save with a concurrent position change", function () {
  this.timeout(120_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
  let observerId: string | null = null;
  let writes: Array<{ itemID: number; rects: number[][] }> = [];

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

  async function askAndAnswer(
    fixture: WorkflowTestFixture,
  ): Promise<WorkflowTestReaderInlineAskOpen> {
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
      panelId: panel.panelId,
      draft: "native",
    });
    assert.isTrue(opened.mounted, JSON.stringify(opened));
    const question = `inline-ask-mismatch-question-${Date.now()}`;
    await api.sendReaderInlineAsk({ text: question });
    const stream = await provider.waitForStream(question);
    stream.push("A short answer.");
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

  /**
   * A second writer: when Zotero announces a new annotation, it rewrites
   * that annotation's rects once through a normal item save, then leaves.
   */
  function installConcurrentWriter() {
    writes = [];
    observerId = Zotero.Notifier.registerObserver(
      {
        notify: async (event: string, type: string, ids: number[]) => {
          if (event !== "add" || type !== "item" || writes.length) return;
          for (const id of ids) {
            const item = Zotero.Items.get(id);
            if (!item?.isAnnotation?.()) continue;
            const position = JSON.parse(item.annotationPosition);
            const rects = position.rects.map((rect: number[], index: number) =>
              index === 0
                ? [rect[0], rect[1] + SHIFT, rect[2], rect[3] + SHIFT]
                : rect,
            );
            item.annotationPosition = JSON.stringify({ ...position, rects });
            await item.saveTx();
            writes.push({ itemID: id, rects });
            removeConcurrentWriter();
            return;
          }
        },
      },
      ["item"],
      OBSERVER_ID,
    );
  }

  function removeConcurrentWriter() {
    if (observerId) Zotero.Notifier.unregisterObserver(observerId);
    observerId = null;
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
    Zotero.Prefs.set(PREF_PREFIX + "originalAgentPermissionMode", "auto", true);
  });

  afterEach(async function () {
    removeConcurrentWriter();
    provider.failOpenStreams("workflow case ended");
    await api.endReaderInlineAsk({ via: "discard" });
    for (const fixture of fixtures.splice(0)) {
      // Erase the annotation rows this case wrote, then the fixture.
      const ids = await Zotero.DB.columnQueryAsync(
        "SELECT itemID FROM itemAnnotations WHERE parentItemID = ?",
        [fixture.pdfAttachmentId],
      );
      for (const id of ids) await Zotero.Items.get(id)?.eraseTx();
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("reports failure in the card when the committed highlight moved before the read-back", async function () {
    const fixture = await createFixture("Inline Ask mismatch card");
    const opened = await askAndAnswer(fixture);
    const draft = draftOf(opened);
    await api.openReaderInlineAskSave({ via: "click" });
    const comment = "Kept after the failed check";
    await api.editReaderInlineAskSave({ comment, color: "#ff6666" });

    installConcurrentWriter();
    await api.confirmReaderInlineAskSave({ via: "click" });
    const failed = await waitForSave(
      (state) => Boolean(state.error) || !state.mounted,
      "the save ends",
    );
    const message = JSON.stringify(failed);
    assert.lengthOf(writes, 1, "the concurrent writer ran once");
    // Failure, not success: the card stays open on the save view.
    assert.isTrue(failed.mounted, message);
    assert.equal(failed.view, "save", message);
    assert.include(failed.error, "did not confirm", message);
    assert.equal(failed.comment.trim(), comment, message);
    assert.isFalse(failed.confirmDisabled, message);

    // Native state: the one row carries the writer's rects, not the draft's.
    const rows = await annotationRows(fixture.pdfAttachmentId);
    assert.lengthOf(rows, 1, JSON.stringify(rows));
    assert.notDeepEqual(rows[0].position.rects, draft.position.rects);
    assert.deepEqual(rows[0].position.rects, writes[0].rects);
    assert.equal(
      rows[0].position.rects[0][1],
      draft.position.rects[0][1] + SHIFT,
    );
    assert.equal(rows[0].comment, comment);
    assert.equal(rows[0].color, "#ff6666");
  });

  it("returns an unverified receipt for the moved highlight and no success", async function () {
    const fixture = await createFixture("Inline Ask mismatch receipt");
    const opened = await askAndAnswer(fixture);
    const draft = draftOf(opened);
    const conversationKey = opened.panelConversationKey;
    assert.isAbove(conversationKey, 0, JSON.stringify(opened));

    installConcurrentWriter();
    const outcome = await Zotero.LLMForZotero.api.agent.saveSelectionAnnotation(
      {
        attachmentId: fixture.pdfAttachmentId,
        libraryID: Zotero.Libraries.userLibraryID,
        conversationKey,
        selection: {
          pageIndex: draft.position.pageIndex,
          rects: draft.position.rects,
          sortIndex: draft.sortIndex,
          pageLabel: draft.pageLabel,
          text: draft.text.trim(),
        },
        color: "#a28ae5",
        comment: "Receipt check",
      },
    );
    assert.lengthOf(writes, 1, "the concurrent writer ran once");
    assert.isFalse(outcome.ok, JSON.stringify(outcome));
    const receipt = outcome.result?.actionReceipts?.[0];
    assert.isOk(receipt, JSON.stringify(outcome.result));
    assert.equal(receipt.verification, "unverified", JSON.stringify(receipt));
    assert.equal(receipt.status, "unverified", JSON.stringify(receipt));
    assert.lengthOf(receipt.appliedTargets || [], 0);

    const rows = await annotationRows(fixture.pdfAttachmentId);
    assert.lengthOf(rows, 1, JSON.stringify(rows));
    assert.deepEqual(rows[0].position.rects, writes[0].rects);
    assert.notDeepEqual(rows[0].position.rects, draft.position.rects);

    // The write itself is journaled, so the change stays reachable for undo.
    const actions = await listJournalActions({ conversationKey, limit: 10 });
    assert.isTrue(
      actions.some((action) => action.toolName === "annotate_pdf"),
      JSON.stringify(actions.map((action) => action.toolName)),
    );
  });
});
