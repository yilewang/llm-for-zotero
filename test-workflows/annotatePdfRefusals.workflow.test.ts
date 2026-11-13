import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import {
  getModelEntryById,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import type { AgentToolContext } from "../src/agent/types";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
  WorkflowTestReaderInlineAskCard,
  WorkflowTestReaderInlineAskOpen,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  installHeldChatProvider,
  type HeldChatProvider,
} from "./helpers/heldChatProvider";

/**
 * annotate_pdf's refusals, against real Zotero state.
 *
 * A reader selection (page, rects, sort index) is Zotero's own draft, and
 * only the plugin's reader UI may hand one to annotate_pdf. A model turn
 * that passes one is refused, both when the call is planned and when the
 * tool body runs; the model's tool schema never lists the fields. A host
 * Save also needs the PDF open in a reader, because the saved row is
 * checked against that reader's document. Every case reads the
 * itemAnnotations table and the change journal: a refusal adds neither.
 */

declare const Zotero: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero.";
const API_BASE = "https://workflow-annotate-refusals.invalid/v1";
const GROUP_ID = "workflow-annotate-refusals-group";
const ENTRY_ID = "workflow-annotate-refusals-model";
const MODEL = "annotate-refusals-model";

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

const SELECTED_TEXT = "ANNOTATE_REFUSAL_PASSAGE";
const HOST_ONLY_FRAGMENT =
  "only the plugin's own reader actions may pass selection coordinates";
const NEEDS_READER_FRAGMENT = "must be open in Zotero's reader";
const SELECTION_FIELDS = ["selection", "rects", "sortIndex", "position"];

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

async function journalSummary(conversationKey: number) {
  const actions = await listJournalActions({ conversationKey, limit: 50 });
  return actions.map((action) => ({
    actionId: action.actionId,
    toolName: action.toolName,
    status: action.status,
  }));
}

describe("workflow: annotate_pdf refusals", function () {
  this.timeout(120_000);

  let api: WorkflowTestApi;
  let provider: HeldChatProvider;
  const previousPrefs = new Map<string, unknown>();
  const fixtures: WorkflowTestFixture[] = [];
  let previousMode: ReturnType<typeof getOriginalAgentPermissionMode>;

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

  async function openWithAnswer(
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
    const question = `annotate-refusal-question-${Date.now()}`;
    await api.sendReaderInlineAsk({ text: question });
    const stream = await provider.waitForStream(question);
    stream.push("An answer.");
    stream.finish();
    await waitForCard(
      (card) => card.phase === "answered" && card.answers.length === 1,
      "the answer completes",
    );
    return opened;
  }

  function selectionOf(opened: WorkflowTestReaderInlineAskOpen) {
    const annotation = opened.draft?.annotation as {
      text: string;
      sortIndex: string;
      pageLabel: string;
      position: { pageIndex: number; rects: number[][] };
    };
    assert.isOk(annotation, JSON.stringify(opened.draft));
    return {
      pageIndex: annotation.position.pageIndex,
      rects: annotation.position.rects,
      sortIndex: annotation.sortIndex,
      pageLabel: annotation.pageLabel,
      text: annotation.text.trim(),
    };
  }

  function modelContext(conversationKey: number): AgentToolContext {
    return {
      request: resolvedAgentRequest({
        conversationKey,
        mode: "agent",
        userText: "highlight the passage",
        libraryID: Zotero.Libraries.userLibraryID,
        executionContext: {
          version: 1,
          executionId: `annotate-refusals:${conversationKey}`,
          conversationKey,
          conversationGeneration: 0,
          chatLibraryID: Zotero.Libraries.userLibraryID,
          permissionOwner: "original_agent",
          workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
          configuredAccess: {
            libraryIDs: [Zotero.Libraries.userLibraryID],
            outputDirectories: [],
          },
        },
      }),
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
      runId: `annotate-refusals-run:${conversationKey}`,
    } as AgentToolContext;
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = getWorkflowTestApi();
    for (const key of SAVED_PREF_KEYS) {
      previousPrefs.set(key, Zotero.Prefs.get(PREF_PREFIX + key, true));
    }
    previousMode = getOriginalAgentPermissionMode();
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
    setOriginalAgentPermissionMode(previousMode);
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
    provider.failOpenStreams("workflow case ended");
    await api.endReaderInlineAsk({ via: "discard" });
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("refuses a model turn that passes selection coordinates, at plan and at execute, and keeps them out of the schema", async function () {
    const fixture = await createFixture("Annotate refusal model");
    const conversationKey = 910_000_000 + (Date.now() % 1_000_000);
    const context = modelContext(conversationKey);
    const selection = {
      pageIndex: 0,
      rects: [[72, 600, 300, 612]],
      sortIndex: "00000|000042|00179",
      pageLabel: "1",
      text: SELECTED_TEXT,
    };
    const args = {
      attachmentId: fixture.pdfAttachmentId,
      text: SELECTED_TEXT,
      color: "#ff6666",
      comment: "",
      annotationType: "highlight",
      selection,
    };
    const rowsBefore = await annotationRows(fixture.pdfAttachmentId);
    const journalBefore = await journalSummary(conversationKey);
    assert.lengthOf(rowsBefore, 0);

    setOriginalAgentPermissionMode("yolo");
    const tool =
      Zotero.LLMForZotero.api.agent.getToolDefinition("annotate_pdf");
    assert.isOk(tool, "annotate_pdf is registered");
    const registry = new AgentToolRegistry(
      new ActionContractService(new ZoteroGateway()),
    );
    registry.register(tool);

    // The schema the model is shown has no host selection fields.
    const spec = registry
      .listToolsForRequest(context.request)
      .find((entry) => entry.name === "annotate_pdf");
    assert.isOk(spec, "annotate_pdf is offered to a model turn");
    const properties = Object.keys(
      (spec!.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    for (const field of SELECTION_FIELDS)
      assert.notInclude(properties, field, `schema lists ${field}`);
    assert.isFalse(
      (spec!.inputSchema as { additionalProperties?: boolean })
        .additionalProperties,
      "the schema allows no extra fields",
    );

    // Path 1: the model's call through the registry (validation, plan).
    const prepared = await registry.prepareExecution(
      { id: "model-call-1", name: "annotate_pdf", arguments: args },
      context,
      { callerKind: "model" },
    );
    assert.equal(prepared.kind, "result", JSON.stringify(prepared));
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.include(
      JSON.stringify(prepared.execution.result.content),
      HOST_ONLY_FRAGMENT,
    );

    // The plan step alone refuses, before any authorization.
    const validated = tool.validate(args);
    assert.isTrue(validated.ok, JSON.stringify(validated));
    let planError = "";
    try {
      tool.planInvocation(validated.value, context);
    } catch (error) {
      planError = String((error as Error).message || error);
    }
    assert.include(planError, HOST_ONLY_FRAGMENT, "planInvocation refuses");

    // Path 2: the tool body refuses when something skips the plan, both for a
    // plain model context and for a host action that is not the reader UI.
    const hostActionInConversation = {
      ...context,
      hostAction: true as const,
      request: { ...context.request, actionEntryPoint: "conversation" },
    } as AgentToolContext;
    for (const [label, callContext] of [
      ["model context", context],
      ["host action from a conversation", hostActionInConversation],
    ] as const) {
      let executeError = "";
      try {
        await tool.execute(validated.value, callContext);
      } catch (error) {
        executeError = String((error as Error).message || error);
      }
      assert.include(executeError, HOST_ONLY_FRAGMENT, `execute: ${label}`);
    }
    // The registry also refuses a host action that is not the reader UI.
    const viaAction = await registry.prepareExecution(
      { id: "model-call-2", name: "annotate_pdf", arguments: args },
      hostActionInConversation,
      { callerKind: "action" },
    );
    assert.equal(viaAction.kind, "result", JSON.stringify(viaAction));
    if (viaAction.kind === "result") {
      assert.isFalse(viaAction.execution.result.ok);
      assert.include(
        JSON.stringify(viaAction.execution.result.content),
        HOST_ONLY_FRAGMENT,
      );
    }

    // Native state: no annotation row, no journal action.
    assert.deepEqual(await annotationRows(fixture.pdfAttachmentId), []);
    assert.deepEqual(await journalSummary(conversationKey), journalBefore);
  });

  it("refuses a host Save once the PDF's reader tab is closed, and the same Save writes one row with the reader open", async function () {
    Zotero.Prefs.set(PREF_PREFIX + "originalAgentPermissionMode", "auto", true);
    const fixture = await createFixture("Annotate refusal closed reader");
    const opened = await openWithAnswer(fixture);
    const conversationKey = opened.panelConversationKey;
    assert.isAbove(conversationKey, 0, JSON.stringify(opened));
    const input = {
      attachmentId: fixture.pdfAttachmentId,
      libraryID: Zotero.Libraries.userLibraryID,
      conversationKey,
      selection: selectionOf(opened),
      color: "#a28ae5",
      comment: "Saved with the reader open",
    };
    const journalBefore = await journalSummary(conversationKey);

    // The card's Save calls exactly this API; the card itself goes with the
    // reader tab, so the closed-reader Save is driven through the API.
    const closed = await api.closeReaderInlineAskReaderTab();
    assert.isTrue(closed.readerClosed, JSON.stringify(closed));
    const refused =
      await Zotero.LLMForZotero.api.agent.saveSelectionAnnotation(input);
    assert.isFalse(refused.ok, JSON.stringify(refused));
    assert.include(String(refused.error), NEEDS_READER_FRAGMENT);
    assert.deepEqual(
      await annotationRows(fixture.pdfAttachmentId),
      [],
      "no annotation row",
    );
    assert.deepEqual(
      await journalSummary(conversationKey),
      journalBefore,
      "no journal action",
    );

    // Positive control: the same input with the reader open.
    const reopened = await api.openReaderInlineAsk({
      attachmentItemId: fixture.pdfAttachmentId,
      pageIndex: 0,
      selectedText: SELECTED_TEXT,
      draft: "native",
    });
    assert.isTrue(reopened.mounted, JSON.stringify(reopened));
    const saved =
      await Zotero.LLMForZotero.api.agent.saveSelectionAnnotation(input);
    assert.isTrue(saved.ok, JSON.stringify(saved));
    assert.equal(saved.status, "applied");
    const rows = await annotationRows(fixture.pdfAttachmentId);
    assert.lengthOf(rows, 1, JSON.stringify(rows));
    assert.equal(rows[0].comment, input.comment);
    assert.equal(rows[0].color, input.color);
    assert.deepEqual(rows[0].position.rects, input.selection.rects);
    const journalAfter = await journalSummary(conversationKey);
    assert.equal(
      journalAfter.filter((action) => action.toolName === "annotate_pdf")
        .length,
      journalBefore.length + 1,
      JSON.stringify(journalAfter),
    );
  });
});
