import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const WEBCHAT_MODEL_ENTRY_ID = "workflow-webchat-model";
const WEBCHAT_MODEL_GROUPS = JSON.stringify([
  {
    id: "workflow-webchat-provider",
    apiBase: "",
    apiKey: "",
    authMode: "webchat",
    providerProtocol: "web_sync",
    models: [
      {
        id: WEBCHAT_MODEL_ENTRY_ID,
        model: "chatgpt.com",
        temperature: 0.7,
        maxTokens: 4096,
      },
    ],
  },
]);

async function withPrefs<T>(
  prefs: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
    Zotero.Prefs.set(fullKey, value, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) {
        Zotero.Prefs.clear?.(fullKey, true);
      } else {
        Zotero.Prefs.set(fullKey, value, true);
      }
    }
  }
}

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

describe("workflow: panel lifecycle", function () {
  this.timeout(30000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  let freshPaper: Zotero.Item | null = null;

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    if (fixture) {
      await api.cleanupFixture(fixture);
      fixture = null;
    }
    await api.reset();
    if (freshPaper) {
      freshPaper.deleted = true;
      await freshPaper.saveTx({ skipSelect: true });
      freshPaper = null;
    }
  });

  for (const panelCount of [1, 2]) {
    it(`initializes one fresh paper conversation across ${panelCount} panel(s) without rejected transactions`, async function () {
      await withPrefs(
        {
          enableCodexAppServerMode: false,
          enableClaudeCodeMode: false,
          conversationSystem: "upstream",
        },
        async () => {
          freshPaper = new Zotero.Item("journalArticle");
          freshPaper.libraryID = Zotero.Libraries.userLibraryID;
          freshPaper.setField("title", "Fresh paper initialization");
          // Keep fixture creation from opening the real item pane before the
          // test starts observing its first panel initialization.
          await freshPaper.saveTx({ skipSelect: true });
          const paperID = freshPaper.id;
          const countChats = () =>
            Zotero.DB.valueQueryAsync(
              "SELECT COUNT(*) FROM llm_for_zotero_paper_conversations WHERE paper_item_id = ?",
              [paperID],
            );
          assert.equal(await countChats(), 0);

          const db = Zotero.DB as any;
          const executeTransaction = db.executeTransaction;
          const failures: string[] = [];
          db.executeTransaction = async function (...args: any[]) {
            try {
              return await executeTransaction.apply(this, args);
            } catch (error) {
              failures.push(String(error));
              throw error;
            }
          };
          try {
            const panels = await Promise.all(
              Array.from({ length: panelCount }, () =>
                api.renderPanelForItem(paperID),
              ),
            );
            for (const panel of panels) {
              const diagnostics = await api.getDiagnostics(panel.panelId);
              assert.equal(diagnostics.conversationKey, paperID);
              assert.equal(diagnostics.conversationKind, "paper");
            }
            assert.deepEqual(
              failures,
              [],
              "first-open initialization must not recover from rejected writes",
            );
            assert.equal(await countChats(), 1);
            const rows = await Zotero.DB.queryAsync(
              `SELECT p.conversation_instance_id AS paperInstance,
                      r.instance_id AS registryInstance,
                      l.instance_id AS ledgerInstance,
                      r.valid, r.is_paper_restore_target AS marker,
                      l.retired_at AS retired
               FROM llm_for_zotero_paper_conversations p
               JOIN llm_for_zotero_conversation_registry r
                 ON r.legacy_conversation_key = p.conversation_key
               JOIN llm_for_zotero_conversation_key_ledger l
                 ON l.conversation_key = p.conversation_key
               WHERE p.paper_item_id = ?`,
              [paperID],
            );
            assert.lengthOf(rows, 1);
            assert.isNotEmpty(rows[0].paperInstance);
            assert.equal(rows[0].paperInstance, rows[0].registryInstance);
            assert.equal(rows[0].paperInstance, rows[0].ledgerInstance);
            assert.equal(rows[0].valid, 1);
            assert.equal(rows[0].marker, 1);
            assert.isNull(rows[0].retired);
          } finally {
            db.executeTransaction = executeTransaction;
          }
        },
      );
    });
  }

  it("keeps a duplicate setup callback idempotent", async function () {
    await withPrefs(
      {
        enableCodexAppServerMode: false,
        enableClaudeCodeMode: false,
        conversationSystem: "upstream",
      },
      async () => {
        fixture = await api.createPaperWithPdfFixture({
          title: "Duplicate Panel Setup Parent",
          pdfTitle: "Duplicate Panel Setup PDF",
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const initial = await api.getDiagnostics(panel.panelId);
        assert.isFalse(
          initial.runtimeSystemToggles.some(
            (toggle) => toggle.system === "codex" && toggle.visible,
          ),
        );

        const duplicate = await api.exerciseDuplicatePanelSetup(panel.panelId);
        assert.isTrue(duplicate.samePanelRoot);
        assert.isNotEmpty(duplicate.initializationGenerationBefore);
        assert.equal(
          duplicate.initializationGenerationAfter,
          duplicate.initializationGenerationBefore,
        );
        assert.isTrue(duplicate.panelStateSyncBefore);
        assert.isTrue(duplicate.panelStateSyncAfter);
        assert.equal(duplicate.turnNavigatorCountBefore, 1);
        assert.equal(duplicate.turnNavigatorCountAfter, 1);

        Zotero.Prefs.set(`${PREF_PREFIX}.enableCodexAppServerMode`, true, true);
        await Zotero.Promise.delay(250);
        const afterPreferenceChange = await api.getDiagnostics(panel.panelId);
        assert.isTrue(
          afterPreferenceChange.runtimeSystemToggles.some(
            (toggle) => toggle.system === "codex" && toggle.visible,
          ),
        );
      },
    );
  });

  it("preserves an unsent WebChat draft through a panel state refresh", async function () {
    await withPrefs(
      {
        enableCodexAppServerMode: false,
        enableClaudeCodeMode: false,
        conversationSystem: "upstream",
        modelProviderGroups: WEBCHAT_MODEL_GROUPS,
        modelProviderGroupsMigrationVersion: 3,
        lastUsedModelEntryId: WEBCHAT_MODEL_ENTRY_ID,
      },
      async () => {
        fixture = await api.createPaperWithPdfFixture({
          title: "WebChat Draft Refresh Parent",
          pdfTitle: "WebChat Draft Refresh PDF",
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const draft = "This unsent WebChat prompt must survive.";
        const result = await api.exercisePanelDraftStateRefresh(
          panel.panelId,
          draft,
        );

        assert.isTrue(result.webChatMode);
        assert.equal(result.inputBeforeRefresh, draft);
        assert.equal(result.inputAfterRefresh, draft);
      },
    );
  });

  it("starts one plan execution after repeated panel rebuilds and removes disposed plan listeners", async function () {
    await withPrefs(
      {
        enableCodexAppServerMode: false,
        enableClaudeCodeMode: false,
        conversationSystem: "upstream",
      },
      async () => {
        fixture = await api.createPaperWithPdfFixture({
          title: "Rebuilt plan approval",
          pdfTitle: "Rebuilt plan approval PDF",
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const result = await api.exerciseRebuiltPanelPlanApproval(
          panel.panelId,
        );
        assert.equal(result.sendsAfterApproval, 1);
        assert.equal(
          result.queuedAfterApproval,
          0,
          "one approval must not queue duplicate execution prompts",
        );
        assert.equal(
          result.sendsAfterDispose,
          1,
          "disposed handlers must not dispatch again",
        );
      },
    );
  });
});
