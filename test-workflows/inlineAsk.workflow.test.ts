import { assert } from "chai";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestReaderInlineAskCard,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * Inline Ask in the real reader: the selection popup shows "Add Text" and
 * "Inline Ask" in one row; Inline Ask opens a card in the reader document
 * that streams an answer from the model the sidebar selected, takes
 * follow-ups and quick prompts, and saves nothing.
 *
 * The plugin's real popup handler, card, request assembly and stream
 * parsing run; only the network is scripted (a held fake provider).
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-inline-ask.invalid/v1";
const GROUP_ID = "workflow-inline-ask-group";
const ENTRY_ID = "workflow-inline-ask-model";
const MODEL = "inline-ask-model";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "showPopupAddText",
  "showPopupInlineAsk",
  "inlineAskTextSize",
  "outputTokenAutoMigrationNoticePending",
];

const SELECTED_TEXT = "INLINE_ASK_SELECTED_PASSAGE";
const SECOND_SELECTED_TEXT = "INLINE_ASK_SECOND_PASSAGE";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: Inline Ask in the reader", function () {
  this.timeout(120_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];

  async function createFixture(
    title: string,
    source: { creators?: string[]; date?: string } = {},
  ): Promise<WorkflowTestFixture> {
    const fixture = await api.createPaperWithPdfFixture({
      ...source,
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
    Zotero.Prefs.set(PREF_PREFIX + "inlineAskTextSize", 100, true);
  });

  afterEach(async function () {
    provider.failOpenStreams("workflow case ended");
    await api.endReaderInlineAsk({ via: "discard" });
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("shows Add Text and Inline Ask side by side in one popup row", async function () {
    const fixture = await createFixture("Inline Ask popup row");
    const row = await api.readReaderPopupActionRow({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
    });
    const message = JSON.stringify(row);
    assert.equal(row.appendCalls, 1, message);
    assert.deepEqual(row.buttonLabels, ["Add Text", "Inline Ask"], message);
    assert.isTrue(row.sharedRow, message);
    assert.equal(row.rowDisplay, "flex", message);
  });

  it("lines the popup row up with Zotero's highlight/underline toggle", async function () {
    const TOL = 0.5;
    const near = (a: number, b: number, what: string, msg: string) =>
      assert.isAtMost(Math.abs(a - b), TOL, `${what}: ${a} vs ${b}; ${msg}`);
    const fixture = await createFixture("Inline Ask popup alignment");
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const input = {
      panelId: panel.panelId,
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
    };

    const both = await api.readNativeReaderPopupGeometry(input);
    const m = JSON.stringify(both);
    assert.isUndefined(both.error, m);
    const toggle = both.toggle!;
    const row = both.row!;
    const buttons = both.buttons!;
    assert.isOk(toggle && row, m);
    assert.deepEqual(
      buttons.map((b) => b.label),
      ["Add Text", "Inline Ask"],
      m,
    );
    near(
      both.rowTop! - toggle.bottom,
      toggle.top - both.colors!.bottom,
      "gap below toggle vs gap above toggle",
      m,
    );
    near(row.left, toggle.left, "row left vs toggle left", m);
    near(row.right, toggle.right, "row right vs toggle right", m);
    near(buttons[0].left, toggle.left, "first button left", m);
    near(buttons[1].right, toggle.right, "last button right", m);
    near(buttons[0].width, buttons[1].width, "button widths", m);
    near(buttons[1].left - buttons[0].right, 8, "gap", m);

    Zotero.Prefs.set(PREF_PREFIX + "showPopupInlineAsk", false, true);
    // A new paper, so no popup from the first reader can be reused.
    const second = await createFixture("Inline Ask popup alignment single");
    const secondPanel = await api.renderPanelForItem(second.parentItemId);
    const single = await api.readNativeReaderPopupGeometry({
      ...input,
      attachmentItemId: second.pdfAttachmentId,
      panelId: secondPanel.panelId,
    });
    const ms = JSON.stringify(single);
    assert.isUndefined(single.error, ms);
    assert.lengthOf(single.buttons!, 1, ms);
    near(single.buttons![0].left, single.toggle!.left, "single left", ms);
    near(single.buttons![0].right, single.toggle!.right, "single right", ms);
  });

  it("opens the card in place of Zotero's selection popup, which closes", async function () {
    const TOL = 0.5;
    const fixture = await createFixture("Inline Ask replaces popup");
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const opened = await api.openNativeReaderInlineAsk({
      panelId: panel.panelId,
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
    });
    const m = JSON.stringify(opened);
    assert.isUndefined(opened.error, m);
    assert.isTrue(opened.cardMounted, m);
    assert.isFalse(opened.popupOpenAfterPress!.open, `popup after press; ${m}`);
    const popup = opened.popup!;
    const card = opened.card!;
    assert.isAtMost(
      Math.abs(card.left - popup.left),
      TOL,
      `card left ${card.left} vs popup left ${popup.left}; ${m}`,
    );
    assert.isAtMost(
      Math.abs(card.top - popup.top),
      TOL,
      `card top ${card.top} vs popup top ${popup.top}; ${m}`,
    );
    assert.isTrue(opened.selectionKept, `selection kept; ${m}`);
    assert.isFalse(opened.popupOpenLater, `popup while card open; ${m}`);
    assert.isTrue(opened.cardClosed, m);
    assert.isFalse(opened.popupOpenAfterCardClose, `popup after close; ${m}`);
  });

  it("hides Inline Ask when its setting is off", async function () {
    const fixture = await createFixture("Inline Ask toggle off");
    Zotero.Prefs.set(PREF_PREFIX + "showPopupInlineAsk", false, true);
    const row = await api.readReaderPopupActionRow({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
    });
    assert.deepEqual(row.buttonLabels, ["Add Text"], JSON.stringify(row));
    assert.equal(row.appendCalls, 1, JSON.stringify(row));
  });

  it("streams an answer, takes a follow-up, stays open on a page click or new selection, and saves nothing", async function () {
    const fixture = await createFixture("Inline Ask conversation", {
      creators: ["Ratzon", "Derdikman", "Barak"],
      date: "2024-03-15",
    });
    const rowsBefore = await api.getConversationStoreRowTotals();

    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
    });
    const message = JSON.stringify(opened);
    assert.deepEqual(opened.popupButtonLabels, ["Add Text", "Inline Ask"]);
    assert.isTrue(opened.mounted, message);
    assert.match(opened.overlayDocumentUrl, /reader\.html/, message);
    // The passage header starts with the paper's "Creator, year:" label.
    assert.equal(opened.quoteLabel, "Ratzon et al., 2024:", message);
    assert.equal(opened.quoteText, SELECTED_TEXT, message);
    assert.equal(opened.modelLabel, MODEL, message);
    assert.deepEqual(
      opened.pillLabels,
      ["Explain", "Define terms", "Translate"],
      message,
    );
    assert.equal(
      opened.hint,
      "Enter to send · Shift+Enter for a new line · Esc to close",
    );
    assert.equal(opened.editorContentEditable, "true", message);
    assert.deepEqual(
      opened.editorKeys,
      ["Mod+A", "Backspace", "ArrowRight", "h"].map((key) => ({
        key,
        defaultPrevented: false,
      })),
      message,
    );
    // The state must be readable, or the comparison proves nothing.
    assert.notInclude(
      opened.readerKeyStateBefore,
      '"selectedAnnotationCount":-1',
      message,
    );
    assert.equal(
      opened.readerKeyStateAfter,
      opened.readerKeyStateBefore,
      message,
    );
    assert.equal(opened.card.phase, "compose", message);
    assert.isTrue(opened.card.pillsShown, message);
    assert.isFalse(opened.card.footerShown, message);
    // One composer box holds the field, the model button, and the send arrow.
    assert.isTrue(opened.card.composerHoldsControls, message);
    assert.isFalse(opened.card.promptEditorShown, message);

    // First question.
    const Q1 = "inline-ask-first-question-marker";
    const A1 = "Inline ask first answer marker";
    await api.sendReaderInlineAsk({ text: Q1 });
    const first = await provider.waitForStream(Q1);
    assert.equal(first.model, MODEL);
    assert.include(
      first.requestBody,
      "Inline Ask: the user selected a passage",
    );
    assert.include(first.requestBody, SELECTED_TEXT);
    assert.include(first.requestBody, "Inline Ask conversation");
    first.push(A1.slice(0, 10));
    await waitForCard(
      (card) => card.answers[0]?.status === "streaming",
      "the first chunk streams into the card",
    );
    first.push(A1.slice(10));
    first.finish();
    const answered = await waitForCard(
      (card) => card.phase === "answered" && card.answers[0]?.text === A1,
      "the first answer completes",
    );
    assert.deepEqual(answered.questions, [Q1]);
    assert.isTrue(answered.fieldShown, "the follow-up field shows");
    assert.isFalse(answered.pillsShown);
    assert.isTrue(answered.footerShown);
    assert.deepEqual(
      answered.messageActions,
      ["save", "sidebar", "discard"],
      "the quiet message actions sit under the answer",
    );
    assert.isTrue(answered.composerHoldsControls);
    assert.equal(answered.placeholder, "Ask a follow-up");
    assert.isFalse(
      answered.sidebarDisabled,
      "Continue in sidebar is offered once an answer exists",
    );
    assert.isTrue(
      answered.saveDisabled,
      "a draft without rects (and no reader panel) cannot be saved",
    );

    // A card with a conversation survives a page click and a new selection.
    assert.isTrue(
      (await api.pointerDownOutsideReaderInlineAsk()).cardOpen,
      "a page click keeps a card with a conversation",
    );
    assert.isTrue(
      (
        await api.showNewReaderSelectionPopup({
          selectedText: SECOND_SELECTED_TEXT,
        })
      ).cardOpen,
      "a new selection keeps a card with a conversation",
    );

    // Follow-up: the request carries the first turn as history.
    const Q2 = "inline-ask-follow-up-marker";
    const A2 = "Inline ask follow-up answer";
    await api.sendReaderInlineAsk({ text: Q2 });
    const second = await provider.waitForStream(Q2);
    assert.include(second.requestBody, Q1);
    assert.include(second.requestBody, A1);
    second.push(A2);
    second.finish();
    await waitForCard(
      (card) => card.phase === "answered" && card.answers[1]?.text === A2,
      "the follow-up answer completes",
    );

    const discarded = await api.endReaderInlineAsk({ via: "discard" });
    assert.isTrue(discarded.cardRemoved);

    const rowsAfter = await api.getConversationStoreRowTotals();
    assert.deepEqual(
      rowsAfter,
      rowsBefore,
      "Inline Ask writes no conversation, message, registry or usage row",
    );
  });

  it("sends a quick prompt's full text and shows its label", async function () {
    const fixture = await createFixture("Inline Ask quick prompt");
    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
    });
    assert.isTrue(opened.mounted, JSON.stringify(opened));
    await api.sendReaderInlineAsk({ pillId: "explain" });
    const stream = await provider.waitForStream(
      "Explain this passage in plain language",
    );
    stream.push("Plain explanation.");
    stream.finish();
    const card = await waitForCard(
      (state) => state.phase === "answered",
      "the quick prompt's answer completes",
    );
    assert.deepEqual(card.questions, ["Explain"]);
    assert.equal(card.answers[0]?.text, "Plain explanation.");

    const closed = await api.endReaderInlineAsk({ via: "escape" });
    assert.isTrue(closed.cardRemoved, "Escape closes the card");
  });

  it("moves the card by a blank point and resizes it by the corner grip", async function () {
    const fixture = await createFixture("Inline Ask drag");
    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
    });
    assert.isTrue(opened.mounted, JSON.stringify(opened));
    const near = (actual: number, expected: number, label: string) =>
      assert.isAtMost(Math.abs(actual - expected), 2, label);

    // Move: the rect shifts by the drag and the card stays open and quiet.
    const before = api.readReaderInlineAsk();
    const moved = await api.dragReaderInlineAsk({
      part: "card",
      dx: 40,
      dy: 30,
    });
    assert.isTrue(moved.mounted, "a move keeps the card open");
    near(moved.rect.left - before.rect.left, 40, "moved right");
    near(moved.rect.top - before.rect.top, 30, "moved down");
    assert.equal(moved.rect.width, before.rect.width, "a move keeps the width");
    assert.isFalse(moved.promptEditorShown, "a move opens no editor");
    assert.equal(moved.phase, "compose", "a move sends nothing");

    // Resize: width grows by the drag; the grip stays clear of the send arrow.
    const wide = await api.dragReaderInlineAsk({
      part: "resize",
      dx: 60,
      dy: 0,
    });
    near(wide.rect.width - moved.rect.width, 60, "widened");
    near(wide.rect.left, moved.rect.left, "the left edge stays");

    // Answer area: once a question exists, a vertical drag changes its max.
    const Q = "inline-ask-drag-question-marker";
    await api.sendReaderInlineAsk({ text: Q });
    const stream = await provider.waitForStream(Q);
    stream.push("Drag answer.");
    stream.finish();
    const answered = await waitForCard(
      (card) =>
        card.phase === "answered" && card.answers[0]?.text === "Drag answer.",
      "the answer completes",
    );
    assert.isAbove(answered.threadMaxHeight, 80, "the answer area has a max");
    const tall = await api.dragReaderInlineAsk({
      part: "resize",
      dx: 0,
      dy: 50,
    });
    near(
      tall.threadMaxHeight - answered.threadMaxHeight,
      50,
      "the answer area grew",
    );
    assert.equal(tall.rect.width, answered.rect.width, "no width change");
    assert.equal(tall.phase, "answered");
    assert.isTrue(
      tall.composerHoldsControls,
      "the send arrow is still in place",
    );

    // The card stays inside the window.
    const win = Zotero.getMainWindow();
    assert.isAtLeast(tall.rect.left, 0);
    assert.isAtLeast(tall.rect.top, 0);
    assert.isAtMost(tall.rect.left + tall.rect.width, win.innerWidth + 1);
    assert.isAtMost(tall.rect.top + tall.rect.height, win.innerHeight + 1);

    const closed = await api.endReaderInlineAsk({ via: "discard" });
    assert.isTrue(closed.cardRemoved);
  });

  it("closes a card without a conversation on a page click", async function () {
    const fixture = await createFixture("Inline Ask page click");
    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
    });
    assert.isTrue(opened.mounted, JSON.stringify(opened));
    assert.isFalse(
      (await api.pointerDownOutsideReaderInlineAsk()).cardOpen,
      "a page click closes a card before its first question",
    );
  });

  it("shows the passage as a quote line, dims it at rest, and scales all text from the More menu", async function () {
    const fixture = await createFixture("Inline Ask text size", {
      creators: ["Ratzon", "Derdikman", "Barak"],
      date: "2024-03-15",
    });
    const open = () =>
      api.openReaderInlineAsk({
        attachmentItemId: fixture.pdfAttachmentId,
        pageIndex: 0,
        selectedText: SELECTED_TEXT,
      });
    const near = (
      actual: number,
      expected: number,
      tol: number,
      what: string,
    ) =>
      assert.isAtMost(
        Math.abs(actual - expected),
        tol,
        `${what}: ${actual} vs ${expected}`,
      );

    // The passage: a quote line, no curly quotes, dimmed until hovered.
    const opened = await open();
    const message = JSON.stringify(opened);
    assert.isTrue(opened.mounted, message);
    assert.isTrue(opened.card.quoteHasBar, message);
    assert.isFalse(opened.card.quoteHasQuoteMarks, message);
    assert.equal(opened.quoteLabel, "Ratzon et al., 2024:", message);
    assert.equal(opened.quoteText, SELECTED_TEXT, message);
    assert.equal(opened.card.textSize, 100, message);
    near(opened.card.quoteColorAlpha, 0.7, 0.02, "rest alpha");
    assert.isFalse(opened.card.threadFaded, "no fade before a thread exists");
    assert.equal(
      (await api.hoverReaderInlineAskPassage(true)).quoteColorAlpha,
      1,
    );
    near(
      (await api.hoverReaderInlineAskPassage(false)).quoteColorAlpha,
      0.7,
      0.02,
      "alpha after the pointer leaves",
    );
    const baseQuoteSize = opened.card.quoteFontSize;
    assert.equal(baseQuoteSize, 13.5, message);

    // The More menu: larger twice gives 120 percent.
    const menu = await api.clickReaderInlineAskTextSize("toggle");
    assert.isTrue(menu.moreMenuShown, JSON.stringify(menu));
    assert.equal(menu.menuPercent, "100%");
    // Both A glyphs sit in the middle of their buttons.
    assert.lengthOf(menu.glyphOffsets, 2, JSON.stringify(menu.glyphOffsets));
    for (const offset of menu.glyphOffsets) {
      assert.isAtMost(Math.abs(offset.dx), 1, JSON.stringify(offset));
      assert.isAtMost(Math.abs(offset.dy), 1.5, JSON.stringify(offset));
    }
    await api.clickReaderInlineAskTextSize("larger");
    const larger = await api.clickReaderInlineAskTextSize("larger");
    assert.isTrue(larger.moreMenuShown, "the menu stays open");
    assert.equal(larger.menuPercent, "120%");
    assert.equal(larger.card.textSize, 120);
    near(larger.card.quoteFontSize, baseQuoteSize * 1.2, 0.5, "passage size");
    assert.equal(
      Zotero.Prefs.get(PREF_PREFIX + "inlineAskTextSize", true),
      120,
      "the size is saved",
    );

    // A long answer at 120 percent scales too, and scrolls under the passage.
    const Q = "inline-ask-text-size-question-marker";
    await api.sendReaderInlineAsk({ text: Q });
    const stream = await provider.waitForStream(Q);
    const LONG = Array.from(
      { length: 60 },
      (_, index) => `Paragraph ${index + 1} of the long answer.`,
    ).join("\n\n");
    stream.push(LONG);
    stream.finish();
    const answered = await waitForCard(
      (card) => card.phase === "answered" && card.answers[0]?.text !== "",
      "the long answer completes",
    );
    near(answered.answerFontSize, 12.5 * 1.2, 0.5, "answer size at 120%");
    assert.isTrue(answered.threadFaded, JSON.stringify(answered));
    assert.isTrue(answered.quoteHasBar);

    // Escape on the page, outside the card, closes a card that has a
    // conversation; a new card then opens at the saved size.
    const escaped = await api.endReaderInlineAsk({ via: "escape_page" });
    assert.isTrue(escaped.cardRemoved, "Escape on the page closes the card");
    const reopened = await open();
    assert.isTrue(reopened.mounted, JSON.stringify(reopened));
    assert.equal(reopened.card.textSize, 120);
    near(reopened.card.quoteFontSize, baseQuoteSize * 1.2, 0.5, "reopened");

    // Reset goes back to 100 percent and the base sizes.
    await api.clickReaderInlineAskTextSize("toggle");
    const reset = await api.clickReaderInlineAskTextSize("reset");
    assert.equal(reset.card.textSize, 100);
    assert.equal(reset.menuPercent, "100%");
    assert.equal(reset.card.quoteFontSize, baseQuoteSize);
    assert.equal(
      Zotero.Prefs.get(PREF_PREFIX + "inlineAskTextSize", true),
      100,
    );
  });
});
