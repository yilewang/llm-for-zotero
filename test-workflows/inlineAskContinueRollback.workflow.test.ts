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
 * Inline Ask's Continue in sidebar when the database fails partway through
 * storing the new paper chat.
 *
 * The messages are stored all or nothing: a failed write removes the rows it
 * stored, the card stays open with the user's turns and says why, and a
 * retry stores exactly one copy. A failed title write is not fatal: the
 * messages are stored, Continue succeeds, and the chat keeps its default
 * title. The faults are injected on one real INSERT or UPDATE statement
 * through Zotero.DB.queryAsync; every check reads the plugin's tables.
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-inline-ask-rollback.invalid/v1";
const GROUP_ID = "workflow-inline-ask-rollback-group";
const ENTRY_ID = "workflow-inline-ask-rollback-model";
const MODEL = "inline-ask-rollback-model";

const MESSAGES_TABLE = "llm_for_zotero_chat_messages";
const PAPER_CHATS_TABLE = "llm_for_zotero_paper_conversations";

const SAVED_PREF_KEYS = [
  "modelProviderGroups",
  "modelProviderGroupsMigrationVersion",
  "lastUsedModelEntryId",
  "conversationSystem",
  "enableCodexAppServerMode",
  "enableClaudeCodeMode",
  "showPopupAddText",
  "showPopupInlineAsk",
  "outputTokenAutoMigrationNoticePending",
];

const SELECTED_TEXT = "INLINE_ASK_ROLLBACK_PASSAGE";
const EXPLAIN_PROMPT =
  "Explain this passage in plain language, using the context of the paper.";
const SAVE_FAILED_TEXT = "The conversation could not be saved to the sidebar.";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

async function storedMessages(conversationKey: number) {
  const rows = await Zotero.DB.queryAsync(
    `SELECT role, text FROM ${MESSAGES_TABLE}
      WHERE conversation_key = ? ORDER BY timestamp, id`,
    [conversationKey],
  );
  return rows.map((row: any) => [String(row.role), String(row.text)]);
}

/** Every paper chat of the paper, with its stored message count. */
async function paperChats(paperItemId: number): Promise<
  Array<{
    conversationKey: number;
    userTurnCount: number;
    title: string;
    messageCount: number;
  }>
> {
  const rows = await Zotero.DB.queryAsync(
    `SELECT C.conversation_key AS conversationKey,
            C.user_turn_count AS userTurnCount,
            C.title AS title,
            (SELECT COUNT(*) FROM ${MESSAGES_TABLE} M
              WHERE M.conversation_key = C.conversation_key) AS messageCount
       FROM ${PAPER_CHATS_TABLE} C
      WHERE C.paper_item_id = ? AND COALESCE(C.webchat_session, 0) = 0
      ORDER BY C.conversation_key`,
    [paperItemId],
  );
  return rows.map((row: any) => ({
    conversationKey: Number(row.conversationKey),
    userTurnCount: Number(row.userTurnCount),
    title: row.title === null ? "" : String(row.title),
    messageCount: Number(row.messageCount),
  }));
}

describe("workflow: Inline Ask continue when the store fails partway", function () {
  this.timeout(120_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
  let restoreQuery: (() => void) | null = null;

  async function createFixture(title: string): Promise<WorkflowTestFixture> {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
      pages: [`Drift study. The ${SELECTED_TEXT} reports slow change.`],
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

  /** The reader panel, a card, a pill answer and a follow-up. */
  async function askTwoTurns(fixture: WorkflowTestFixture, tag: string) {
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const opened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
      panelId: panel.panelId,
    });
    assert.isTrue(opened.mounted, JSON.stringify(opened));
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
    return {
      panel,
      followUp,
      expected: [
        ["user", EXPLAIN_PROMPT],
        ["assistant", `${tag} first answer`],
        ["user", followUp],
        ["assistant", `${tag} second answer`],
      ],
    };
  }

  /**
   * Wraps Zotero.DB.queryAsync. `onStatement` sees each statement and may
   * return a function that replaces it. Restored by restoreQuery().
   */
  function wrapQuery(
    onStatement: (
      sql: string,
      params: unknown[] | undefined,
    ) => ((run: () => Promise<unknown>) => Promise<unknown>) | null,
  ) {
    const original = Zotero.DB.queryAsync;
    Zotero.DB.queryAsync = function (sql: string, ...rest: any[]) {
      const run = () => original.call(this, sql, ...rest);
      const replacement = onStatement(String(sql), rest[0]);
      return replacement ? replacement(run) : run();
    };
    restoreQuery = () => {
      Zotero.DB.queryAsync = original;
    };
  }

  function unwrapQuery() {
    restoreQuery?.();
    restoreQuery = null;
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
    unwrapQuery();
    provider.failOpenStreams("workflow case ended");
    await api.endReaderInlineAsk({ via: "discard" });
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  for (const [label, failOn, landsFirst] of [
    ["before the third message is written", 3, false],
    ["after the fourth message is written", 4, true],
  ] as const) {
    it(`removes the stored rows when an insert fails ${label}, keeps the card, and a retry stores one copy`, async function () {
      const fixture = await createFixture(`Inline Ask rollback ${failOn}`);
      const { panel, expected } = await askTwoTurns(
        fixture,
        `rollback-${failOn}`,
      );
      const cardBefore = api.readReaderInlineAsk();
      assert.lengthOf(await storedMessages(0), 0);
      const chatsBefore = await paperChats(fixture.parentItemId);
      assert.isTrue(
        chatsBefore.every((chat) => chat.messageCount === 0),
        JSON.stringify(chatsBefore),
      );

      let inserts = 0;
      let seededKey = 0;
      wrapQuery((sql, params) => {
        if (!sql.includes(`INSERT INTO ${MESSAGES_TABLE}`)) return null;
        inserts += 1;
        seededKey = Number(params?.[1]);
        if (inserts !== failOn) return null;
        return async (run) => {
          if (landsFirst) await run();
          throw new Error(`Injected insert failure #${failOn}`);
        };
      });
      const failed = await api.continueReaderInlineAskInSidebar();
      unwrapQuery();
      const message = JSON.stringify(failed);
      assert.equal(inserts, failOn, `the fault fired on insert ${failOn}`);
      assert.isAbove(seededKey, 0);

      // The card keeps the user's work and says why.
      assert.isTrue(failed.cardOpen, message);
      assert.equal(failed.error, SAVE_FAILED_TEXT, message);
      const kept = api.readReaderInlineAsk();
      assert.equal(kept.phase, "answered", JSON.stringify(kept));
      assert.deepEqual(kept.questions, cardBefore.questions);
      assert.deepEqual(kept.answers, cardBefore.answers);

      // Native state: no message row for that attempt, no chat with turns.
      assert.deepEqual(await storedMessages(seededKey), []);
      const chatsAfterFail = await paperChats(fixture.parentItemId);
      for (const chat of chatsAfterFail) {
        assert.equal(chat.messageCount, 0, JSON.stringify(chatsAfterFail));
        assert.equal(chat.userTurnCount, 0, JSON.stringify(chatsAfterFail));
        assert.equal(chat.title, "", JSON.stringify(chatsAfterFail));
      }
      const shown = await api.readPanelChatMessages(panel.panelId);
      assert.lengthOf(shown.stored, 0, JSON.stringify(shown));

      // The retry without the fault stores exactly one copy.
      const moved = await api.continueReaderInlineAskInSidebar();
      assert.isFalse(moved.cardOpen, JSON.stringify(moved));
      assert.equal(moved.error, "");
      let panelShown = await api.readPanelChatMessages(panel.panelId);
      await waitFor(async () => {
        panelShown = await api.readPanelChatMessages(panel.panelId);
        return panelShown.rendered.length === 4;
      }, "the panel draws the stored messages");
      const chats = await paperChats(fixture.parentItemId);
      const withTurns = chats.filter((chat) => chat.messageCount > 0);
      assert.lengthOf(withTurns, 1, JSON.stringify(chats));
      assert.equal(withTurns[0].messageCount, 4, JSON.stringify(chats));
      assert.equal(withTurns[0].userTurnCount, 2, JSON.stringify(chats));
      assert.match(withTurns[0].title, /^Explain this passage/);
      assert.deepEqual(
        await storedMessages(withTurns[0].conversationKey),
        expected,
      );
      assert.equal(panelShown.conversationKey, withTurns[0].conversationKey);
    });
  }

  it("counts the chat as stored when only the title write fails, and a second Continue is not offered", async function () {
    const fixture = await createFixture("Inline Ask rollback title");
    const { panel, expected } = await askTwoTurns(fixture, "rollback-title");

    let titleWrites = 0;
    wrapQuery((sql) => {
      if (
        !sql.includes(`UPDATE ${PAPER_CHATS_TABLE}`) ||
        !/SET\s+title\s*=\s*\?/.test(sql)
      )
        return null;
      titleWrites += 1;
      return async () => {
        throw new Error("Injected title failure");
      };
    });
    const moved = await api.continueReaderInlineAskInSidebar();
    unwrapQuery();
    assert.isAtLeast(titleWrites, 1, "the title write hit the fault");
    assert.isFalse(moved.cardOpen, JSON.stringify(moved));
    assert.equal(moved.error, "");

    let shown = await api.readPanelChatMessages(panel.panelId);
    await waitFor(async () => {
      shown = await api.readPanelChatMessages(panel.panelId);
      return shown.rendered.length === 4;
    }, "the panel draws the stored messages");
    const chats = await paperChats(fixture.parentItemId);
    const withTurns = chats.filter((chat) => chat.messageCount > 0);
    assert.lengthOf(withTurns, 1, JSON.stringify(chats));
    assert.equal(withTurns[0].messageCount, 4, JSON.stringify(chats));
    assert.equal(withTurns[0].userTurnCount, 2, JSON.stringify(chats));
    assert.equal(withTurns[0].title, "", "the chat keeps the default title");
    assert.deepEqual(
      await storedMessages(withTurns[0].conversationKey),
      expected,
    );
    // The card closed on success, so there is no second Continue to repeat.
    assert.isFalse(api.readReaderInlineAsk().mounted);
  });
});
