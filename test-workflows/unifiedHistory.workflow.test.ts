import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestDiagnostics,
  WorkflowTestFixture,
  WorkflowTestSeededHistoryConversation,
} from "../src/modules/contextPanel/workflowTestTypes";
import type { ConversationSystem } from "../src/shared/types";

/**
 * One history list for Agent, Codex and Claude Code chats, and one click to
 * open a chat in its own runtime (plan 2026-10-18, Part B, checks 1-8).
 *
 * Codex and Claude Code chats are written straight into their catalogs and
 * message stores (seedHistoryConversation): no Codex or Claude Code process
 * runs. These tests therefore cover listing, labels, search, row actions,
 * and the runtime switch of the panel and the window; they do not cover a
 * real Codex or Claude Code turn after the open.
 */

const PREF_PREFIX = "extensions.zotero.llmforzotero";

const ALL_RUNTIME_PREFS = {
  enableAgentMode: true,
  enableClaudeCodeMode: true,
  enableCodexAppServerMode: true,
  conversationSystem: "upstream",
  agentLibraryWriteMode: "auto",
};

async function withPrefs<T>(
  prefs: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(prefs)) {
    const fullKey = `${PREF_PREFIX}.${key}`;
    previous.set(fullKey, Zotero.Prefs.get(fullKey, true));
    Zotero.Prefs.set(fullKey, value as string | number | boolean, true);
  }
  try {
    return await task();
  } finally {
    for (const [fullKey, value] of previous) {
      if (value === undefined) {
        Zotero.Prefs.clear?.(fullKey, true);
      } else {
        Zotero.Prefs.set(fullKey, value as string | number | boolean, true);
      }
    }
  }
}

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function message(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function activeHeaderSystems(diagnostics: {
  runtimeSystemToggles?: Array<{
    system: string;
    visible: boolean;
    active: boolean;
  }>;
}): string[] {
  return (diagnostics.runtimeSystemToggles || [])
    .filter((toggle) => toggle.visible && toggle.active)
    .map((toggle) => toggle.system);
}

/** A word no other chat in the test library contains. */
function uniqueWord(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;
}

describe("workflow: unified history across Agent, Codex and Claude", function () {
  this.timeout(180000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];
  const seeded: WorkflowTestSeededHistoryConversation[] = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    try {
      await api.closeStandalone();
    } catch {
      // No window was open.
    }
    while (seeded.length) {
      await api.deleteSeededHistoryConversation(seeded.pop()!);
    }
    while (fixtures.length) {
      await api.cleanupFixture(fixtures.pop()!);
    }
    await api.reset();
  });

  async function createPaper(title: string): Promise<WorkflowTestFixture> {
    const fixture = await api.createPaperWithPdfFixture({
      title,
      pdfTitle: `${title} PDF`,
    });
    fixtures.push(fixture);
    return fixture;
  }

  async function seed(input: {
    system: ConversationSystem;
    kind: "global" | "paper";
    paperItemId?: number;
    userText: string;
  }): Promise<WorkflowTestSeededHistoryConversation> {
    const chat = await api.seedHistoryConversation({
      ...input,
      assistantText: `Answer to: ${input.userText}`,
    });
    seeded.push(chat);
    return chat;
  }

  /** A sidebar panel on the library chat, on a fresh Agent draft. */
  async function libraryPanel(title: string): Promise<{
    panelId: string;
    paper: WorkflowTestFixture;
    draft: WorkflowTestDiagnostics;
  }> {
    const paper = await createPaper(title);
    const panel = await api.renderPanelForItem(paper.parentItemId);
    let state = await api.getDiagnostics(panel.panelId);
    if (state.conversationKind !== "global") {
      state = await api.togglePanelConversationMode(panel.panelId);
    }
    assert.equal(state.conversationKind, "global", message(state));
    const draft = await api.startNewPanelConversation(panel.panelId, {
      allowReusedDraft: true,
    });
    assert.equal(draft.conversationSystem, "upstream", message(draft));
    return { panelId: panel.panelId, paper, draft };
  }

  it("1-2: lists Agent, Codex and Claude library chats with runtime names, keeps the Agent draft, and hides a runtime turned off", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const { panelId, draft } = await libraryPanel("Unified History List");
      const agent = await seed({
        system: "upstream",
        kind: "global",
        userText: "Unified list Agent chat",
      });
      const codex = await seed({
        system: "codex",
        kind: "global",
        userText: "Unified list Codex chat",
      });
      const claude = await seed({
        system: "claude_code",
        kind: "global",
        userText: "Unified list Claude chat",
      });

      const rows = await api.listPanelHistory(panelId, { reopen: true });
      const byKey = new Map(rows.map((row) => [row.conversationKey, row]));
      const agentRow = byKey.get(agent.conversationKey);
      const codexRow = byKey.get(codex.conversationKey);
      const claudeRow = byKey.get(claude.conversationKey);
      assert.isOk(agentRow, `the Agent chat is listed: ${message(rows)}`);
      assert.isOk(codexRow, `the Codex chat is listed: ${message(rows)}`);
      assert.isOk(claudeRow, `the Claude chat is listed: ${message(rows)}`);
      assert.equal(agentRow!.system, "upstream");
      assert.equal(agentRow!.runtimeLabel, "", "Agent rows have no name");
      assert.equal(codexRow!.system, "codex");
      assert.equal(codexRow!.runtimeLabel, "Codex");
      assert.equal(claudeRow!.system, "claude_code");
      assert.equal(claudeRow!.runtimeLabel, "Claude");

      // Check 2: the panel's own empty draft is still listed as a draft.
      const draftRow = byKey.get(Number(draft.conversationKey));
      assert.isOk(draftRow, `the active draft is listed: ${message(rows)}`);
      assert.isTrue(draftRow!.isDraft, message(draftRow));

      // Codex turned off in Preferences: its rows are hidden.
      Zotero.Prefs.set(`${PREF_PREFIX}.enableCodexAppServerMode`, false, true);
      const withoutCodex = await api.listPanelHistory(panelId, {
        reopen: true,
      });
      const keys = withoutCodex.map((row) => row.conversationKey);
      assert.include(keys, agent.conversationKey, message(withoutCodex));
      assert.include(keys, claude.conversationKey, message(withoutCodex));
      assert.notInclude(keys, codex.conversationKey, message(withoutCodex));
      assert.isFalse(
        withoutCodex.some((row) => row.system === "codex"),
        message(withoutCodex),
      );
    });
  });

  it("3: opens a Claude row from Agent in Claude, and two quick clicks end on one chat", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const { panelId } = await libraryPanel("Unified History Open");
      const claude = await seed({
        system: "claude_code",
        kind: "global",
        userText: "Unified open Claude chat",
      });

      const opened = await api.clickPanelHistoryRow(
        panelId,
        claude.conversationKey,
      );
      assert.equal(opened.conversationKey, claude.conversationKey);
      assert.equal(opened.conversationSystem, "claude_code", message(opened));
      assert.equal(opened.runtimeBadge?.label, "Claude", message(opened));
      assert.deepEqual(activeHeaderSystems(opened), ["claude_code"]);
      assert.equal(opened.statusText, "Conversation loaded", message(opened));
      assert.equal(
        Zotero.Prefs.get(`${PREF_PREFIX}.conversationSystem`, true),
        "claude_code",
        "the sidebar saves the runtime it opened",
      );

      // Back to Agent, then two rows of other runtimes in one task.
      const back = await api.pickPanelRuntime(panelId, "upstream");
      assert.equal(back.conversationSystem, "upstream", message(back));
      const codexA = await seed({
        system: "codex",
        kind: "global",
        userText: "Unified rapid Codex chat",
      });
      const claudeB = await seed({
        system: "claude_code",
        kind: "global",
        userText: "Unified rapid Claude chat",
      });
      const rapid = await api.clickPanelHistoryRowsRapidly(panelId, [
        codexA.conversationKey,
        claudeB.conversationKey,
      ]);
      assert.deepEqual(rapid.errors, [], message(rapid));
      // The first click owns the switch; the second is refused.
      assert.equal(
        rapid.diagnostics.conversationKey,
        codexA.conversationKey,
        message(rapid.diagnostics),
      );
      assert.equal(rapid.diagnostics.conversationSystem, "codex");
      assert.equal(rapid.diagnostics.runtimeBadge?.label, "Codex");
      assert.deepEqual(activeHeaderSystems(rapid.diagnostics), ["codex"]);

      // The other order: a same-runtime row first, then a row of another
      // runtime. The second click is refused and nothing disagrees.
      const backAgain = await api.pickPanelRuntime(panelId, "upstream");
      assert.equal(
        backAgain.conversationSystem,
        "upstream",
        message(backAgain),
      );
      const agentA1 = await seed({
        system: "upstream",
        kind: "global",
        userText: "Unified rapid Agent chat",
      });
      const codexC = await seed({
        system: "codex",
        kind: "global",
        userText: "Unified rapid second Codex chat",
      });
      const mixed = await api.clickPanelHistoryRowsRapidly(panelId, [
        agentA1.conversationKey,
        codexC.conversationKey,
      ]);
      assert.deepEqual(mixed.errors, [], message(mixed));
      assert.equal(
        mixed.diagnostics.conversationKey,
        agentA1.conversationKey,
        message(mixed.diagnostics),
      );
      assert.equal(mixed.diagnostics.conversationSystem, "upstream");
      assert.equal(mixed.diagnostics.runtimeBadge?.label, "Agent");
      assert.deepEqual(activeHeaderSystems(mixed.diagnostics), []);
      assert.equal(
        Zotero.Prefs.get(`${PREF_PREFIX}.conversationSystem`, true),
        "upstream",
        "the saved sidebar runtime agrees with the panel",
      );
    });
  });

  it("3b: a refused cross-runtime open leaves the runtime, the saved choice, the badge and the header on Agent", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const { panelId } = await libraryPanel("Unified History Refused");
      const codex = await seed({
        system: "codex",
        kind: "global",
        userText: "Unified refused Codex chat",
      });
      const { diagnostics: state, interceptorHit } =
        await api.clickPanelHistoryRowWithForcedOpenFailure(
          panelId,
          codex.conversationKey,
          "codex",
        );
      assert.isTrue(interceptorHit, `the refusal path ran: ${message(state)}`);
      assert.notEqual(
        state.conversationKey,
        codex.conversationKey,
        message(state),
      );
      assert.equal(state.conversationSystem, "upstream", message(state));
      assert.equal(state.runtimeBadge?.label, "Agent", message(state));
      assert.deepEqual(activeHeaderSystems(state), []);
      assert.equal(
        Zotero.Prefs.get(`${PREF_PREFIX}.conversationSystem`, true),
        "upstream",
        "the saved sidebar runtime is restored",
      );
    });
  });

  it("4: a Codex paper chat of another paper selects that paper, and its new panel opens in Codex on that chat", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const paperA = await createPaper("Unified History Paper A");
      const paperB = await createPaper("Unified History Paper B");
      const word = uniqueWord("crosspaper");
      const codex = await seed({
        system: "codex",
        kind: "paper",
        paperItemId: paperB.parentItemId,
        userText: `Paper B question ${word}`,
      });
      const panelA = await api.renderPanelForItem(paperA.parentItemId);
      const before = await api.getDiagnostics(panelA.panelId);
      assert.equal(before.conversationSystem, "upstream", message(before));

      const search = await api.searchAndOpenPanelHistory(
        panelA.panelId,
        word,
        codex.conversationKey,
      );
      assert.isTrue(search.opened, message(search));

      const pane = Zotero.getActiveZoteroPane() as any;
      const selectedIds = (pane?.getSelectedItems?.() || []).map(
        (item: Zotero.Item) => item.id,
      );
      assert.include(
        selectedIds,
        paperB.parentItemId,
        "the other paper is selected",
      );
      assert.equal(
        Zotero.Prefs.get(`${PREF_PREFIX}.conversationSystem`, true),
        "codex",
        "the runtime choice is set before the paper is selected",
      );

      // The panel the selection builds for paper B (modelled by a new panel
      // on paper B) opens in Codex on the target chat.
      const panelB = await api.renderPanelForItem(paperB.parentItemId);
      const onB = await api.getDiagnostics(panelB.panelId);
      assert.equal(onB.conversationSystem, "codex", message(onB));
      assert.equal(onB.conversationKey, codex.conversationKey, message(onB));
      assert.equal(onB.runtimeBadge?.label, "Codex", message(onB));
    });
  });

  it("5: renames and deletes a Codex row from Agent in the Codex store only", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const { panelId } = await libraryPanel("Unified History Row Actions");
      const codex = await seed({
        system: "codex",
        kind: "global",
        userText: "Unified row actions Codex chat",
      });

      const titles = await api.renamePanelHistoryConversation(
        panelId,
        codex.conversationKey,
        "Renamed Codex chat",
      );
      assert.equal(titles.codex, "Renamed Codex chat", message(titles));
      assert.isNull(titles.upstream, "no upstream row gets the title");
      assert.isNull(titles.claude_code, message(titles));

      const before = await api.getWorkflowConversationPersistenceSnapshot(
        "codex",
        codex.conversationKey,
      );
      assert.equal(before.catalogRows, 1, message(before));
      await api.deletePanelHistoryConversation(panelId, codex.conversationKey);
      const pending = await api.getPendingDeletionState();
      assert.include(
        pending.pendingConversationKeys,
        codex.conversationKey,
        message(pending),
      );
      await api.sweepPendingDeletionsAsRestart();
      const after = await api.getWorkflowConversationPersistenceSnapshot(
        "codex",
        codex.conversationKey,
      );
      assert.equal(after.catalogRows, 0, message(after));
      assert.equal(after.messageRows, 0, message(after));
      const panel = await api.getDiagnostics(panelId);
      assert.equal(panel.conversationSystem, "upstream", message(panel));
    });
  });

  it("6: finds a word only a Codex chat holds from Agent, and opens it in Codex", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const { panelId } = await libraryPanel("Unified History Search");
      const word = uniqueWord("codexonly");
      const codex = await seed({
        system: "codex",
        kind: "global",
        userText: `Where is the ${word} note?`,
      });

      const indexed = await api.searchPanelHistory(panelId, word);
      assert.include(
        indexed.entries.map((entry) => entry.conversationKey),
        codex.conversationKey,
        message(indexed),
      );

      const search = await api.searchAndOpenPanelHistory(
        panelId,
        word,
        codex.conversationKey,
      );
      const index = search.resultKeys.indexOf(codex.conversationKey);
      assert.isAtLeast(index, 0, message(search));
      assert.equal(search.resultSystems[index], "codex", message(search));
      assert.equal(search.resultRuntimeLabels[index], "Codex");
      assert.isTrue(search.opened, message(search));

      const opened = await api.getDiagnostics(panelId);
      assert.equal(opened.conversationKey, codex.conversationKey);
      assert.equal(opened.conversationSystem, "codex", message(opened));
      assert.equal(opened.runtimeBadge?.label, "Codex");
      assert.deepEqual(activeHeaderSystems(opened), ["codex"]);
    });
  });

  it("7: the window opens a Claude row and a searched Codex row in their runtimes; the sidebar stays as it is", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const paper = await createPaper("Unified History Window");
      const sidebar = await api.renderPanelForItem(paper.parentItemId);
      const sidebarBefore = await api.getDiagnostics(sidebar.panelId);
      const claude = await seed({
        system: "claude_code",
        kind: "global",
        userText: "Unified window Claude chat",
      });
      const word = uniqueWord("windowcodex");
      const codex = await seed({
        system: "codex",
        kind: "global",
        userText: `Window search ${word}`,
      });

      await api.openStandaloneForItem(paper.parentItemId);
      const library = await api.clickStandaloneTab("open");
      assert.equal(library.conversationSystem, "upstream", message(library));

      const rows = await api.listStandaloneSidebarHistory();
      const claudeRow = rows.find(
        (row) => row.conversationKey === claude.conversationKey,
      );
      assert.isOk(claudeRow, message(rows));
      // The window's section label names the runtime; rows carry no tag.
      assert.equal(claudeRow!.system, "claude_code", message(claudeRow));
      assert.equal(claudeRow!.runtimeLabel, "", message(claudeRow));

      const opened = await api.clickStandaloneSidebarHistoryRow(
        claude.conversationKey,
      );
      assert.equal(opened.conversationKey, claude.conversationKey);
      assert.equal(opened.conversationSystem, "claude_code", message(opened));
      assert.equal(opened.runtimeBadge?.label, "Claude", message(opened));
      assert.deepEqual(activeHeaderSystems(opened), ["claude_code"]);

      const search = await api.searchAndOpenStandaloneHistory(
        word,
        codex.conversationKey,
      );
      assert.isTrue(search.opened, message(search));
      const afterSearch = await api.getStandaloneDiagnostics();
      assert.equal(afterSearch.conversationKey, codex.conversationKey);
      assert.equal(afterSearch.conversationSystem, "codex");
      assert.equal(afterSearch.runtimeBadge?.label, "Codex");

      const sidebarAfter = await api.getDiagnostics(sidebar.panelId);
      assert.equal(sidebarAfter.conversationSystem, "upstream");
      assert.equal(
        sidebarAfter.conversationKey,
        sidebarBefore.conversationKey,
        "the sidebar's conversation does not move",
      );
      assert.equal(
        Zotero.Prefs.get(`${PREF_PREFIX}.conversationSystem`, true),
        "upstream",
        "the window's runtime is not saved as the sidebar's",
      );
    });
  });

  it("7b: with WebChat on in the window, a searched Codex row leaves WebChat first", async function () {
    const apiEntry = "workflow-unified-api-model";
    const webChatEntry = "workflow-unified-webchat-model";
    const groups = JSON.stringify([
      {
        id: "workflow-unified-api-provider",
        authMode: "api_key",
        apiBase: "http://localhost:1234/v1",
        apiKey: "",
        providerProtocol: "openai_chat_compat",
        presetIdOverride: "customized",
        models: [
          {
            id: apiEntry,
            model: "local-model",
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
        ],
      },
      {
        id: "workflow-unified-webchat-provider",
        apiBase: "",
        apiKey: "",
        authMode: "webchat",
        providerProtocol: "web_sync",
        models: [
          {
            id: webChatEntry,
            model: "chatgpt.com",
            temperature: 0.7,
            maxTokens: 4096,
          },
        ],
      },
    ]);
    await withPrefs(
      {
        ...ALL_RUNTIME_PREFS,
        modelProviderGroups: groups,
        modelProviderGroupsMigrationVersion: 3,
        lastUsedModelEntryId: apiEntry,
      },
      async () => {
        const paper = await createPaper("Unified History WebChat");
        const word = uniqueWord("webchatcodex");
        const codex = await seed({
          system: "codex",
          kind: "global",
          userText: `WebChat leave ${word}`,
        });
        await api.openStandaloneForItem(paper.parentItemId);
        await api.clickStandaloneTab("open");

        const win = (Zotero as any).LLMForZotero?.data?.standaloneWindow as
          | Window
          | undefined;
        assert.isOk(win, "the window is open");
        const body = win!.document.querySelector(
          ".llm-standalone-content",
        ) as HTMLElement;
        const root = () =>
          body.querySelector("#llm-main") as HTMLElement | null;
        (body.querySelector("#llm-model-toggle") as HTMLElement).click();
        const optionSelector = `.llm-model-option[data-entry-id="${webChatEntry}"]`;
        let option: HTMLElement | null = null;
        const optionDeadline = Date.now() + 5000;
        while (!option && Date.now() < optionDeadline) {
          option =
            body.querySelector<HTMLElement>(optionSelector) ||
            win!.document.querySelector<HTMLElement>(optionSelector);
          if (!option) await Zotero.Promise.delay(50);
        }
        assert.isOk(option, "the window's model menu offers WebChat");
        option!.click();
        const webChatDeadline = Date.now() + 8000;
        while (
          root()?.dataset.webchatMode !== "true" &&
          Date.now() < webChatDeadline
        ) {
          await Zotero.Promise.delay(50);
        }
        assert.equal(root()?.dataset.webchatMode, "true", "WebChat is on");

        const search = await api.searchAndOpenStandaloneHistory(
          word,
          codex.conversationKey,
        );
        assert.isTrue(search.opened, message(search));
        const after = await api.getStandaloneDiagnostics();
        assert.equal(after.conversationKey, codex.conversationKey);
        assert.equal(after.conversationSystem, "codex", message(after));
        assert.notEqual(root()?.dataset.webchatMode, "true", "WebChat is off");
      },
    );
  });

  it("8: a note session and a side chat list and find only their own runtime's chats", async function () {
    await withPrefs(ALL_RUNTIME_PREFS, async () => {
      const note = await api.createItemNoteFixture({
        title: "Unified History Note Parent",
        pdfTitle: "Unified History Note PDF",
        noteHtml: "<p>Unified history note</p>",
      });
      fixtures.push(note);
      const word = uniqueWord("notecodex");
      // A Codex chat filed under the note itself, and a Codex library chat.
      const codexOnNote = await seed({
        system: "codex",
        kind: "paper",
        paperItemId: note.noteItemId,
        userText: `Note scoped ${word}`,
      });
      const codexLibrary = await seed({
        system: "codex",
        kind: "global",
        userText: `Library scoped ${word}`,
      });

      // Positive control: an ordinary paper panel finds both.
      const paperPanel = await api.renderPanelForItem(note.parentItemId);
      const found = await api.searchPanelHistory(paperPanel.panelId, word);
      const foundKeys = found.entries.map((entry) => entry.conversationKey);
      assert.include(foundKeys, codexOnNote.conversationKey, message(found));
      assert.include(foundKeys, codexLibrary.conversationKey, message(found));

      const notePanel = await api.renderPanelForItem(note.noteItemId);
      const noteState = await api.getDiagnostics(notePanel.panelId);
      assert.equal(
        noteState.conversationSystem,
        "upstream",
        message(noteState),
      );
      const noteSearch = await api.searchPanelHistory(notePanel.panelId, word);
      assert.deepEqual(
        noteSearch.entries.map((entry) => entry.conversationKey),
        [],
        `a note session finds no Codex chat: ${message(noteSearch)}`,
      );
      const noteRows = await api.listPanelHistory(notePanel.panelId);
      assert.notInclude(
        noteRows.map((row) => row.conversationKey),
        codexOnNote.conversationKey,
        message(noteRows),
      );

      const side = await api.renderSidePanelForItem({
        itemId: note.parentItemId,
        mode: "global",
      });
      const sideSearch = await api.searchPanelHistory(side.panelId, word);
      assert.deepEqual(
        sideSearch.entries.map((entry) => entry.conversationKey),
        [],
        `a side chat finds no Codex chat: ${message(sideSearch)}`,
      );
      api.discardSidePanelConversation(side.conversationKey);
    });
  });
});
