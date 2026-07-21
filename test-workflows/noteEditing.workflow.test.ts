import { assert } from "chai";
import { isConversationKeyForKind } from "../src/shared/conversationKeySpace";
import type { ConversationSystem } from "../src/shared/types";
import type {
  WorkflowTestApi,
  WorkflowTestDiagnostics,
  WorkflowTestNoteFixture,
  WorkflowTestStandaloneNoteFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PREF_PREFIX = "extensions.zotero.llmforzotero";

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

function assertDualRuntimeControls(
  diagnostics: Pick<WorkflowTestDiagnostics, "runtimeSystemToggles">,
  activeSystem?: "codex" | "claude_code",
): void {
  const visible = diagnostics.runtimeSystemToggles.filter(
    (toggle) => toggle.visible,
  );
  assert.deepEqual(
    visible.map((toggle) => toggle.system),
    ["codex", "claude_code"],
  );
  assert.deepEqual(
    visible.filter((toggle) => toggle.active).map((toggle) => toggle.system),
    activeSystem ? [activeSystem] : [],
  );
}

async function diagnosticsMessage(
  api: WorkflowTestApi,
  panelId?: string,
): Promise<string> {
  const diagnostics = await api.getDiagnostics(panelId);
  return JSON.stringify(
    {
      activeItemId: diagnostics.activeItemId,
      conversationKey: diagnostics.conversationKey,
      panelConversationKey: diagnostics.panelConversationKey,
      conversationKind: diagnostics.conversationKind,
      conversationSystem: diagnostics.conversationSystem,
      noteId: diagnostics.noteId,
      noteKind: diagnostics.noteKind,
      noteParentItemId: diagnostics.noteParentItemId,
      contextSnapshot: diagnostics.contextSnapshot,
      chipText: diagnostics.chipText,
      selectedContextLabels: diagnostics.selectedContextLabels,
      historyNewVisible: diagnostics.historyNewVisible,
      historyToggleVisible: diagnostics.historyToggleVisible,
      lastSend: diagnostics.lastSend
        ? {
            question: diagnostics.lastSend.question,
            conversationKey: diagnostics.lastSend.conversationKey,
            conversationKind: diagnostics.lastSend.conversationKind,
            scopeType: diagnostics.lastSend.scopeType,
            selectedTexts: diagnostics.lastSend.selectedTexts,
            selectedTextSources: diagnostics.lastSend.selectedTextSources,
            selectedTextNoteContexts:
              diagnostics.lastSend.selectedTextNoteContexts,
            activeNoteContext: diagnostics.lastSend.activeNoteContext,
            contextSource: diagnostics.lastSend.contextSource,
            runtimeMode: diagnostics.lastSend.runtimeMode,
            modelProviderLabel: diagnostics.lastSend.modelProviderLabel,
          }
        : null,
    },
    null,
    2,
  );
}

function assertNoteSendRouting(params: {
  send: Awaited<ReturnType<WorkflowTestApi["ask"]>>;
  system: ConversationSystem;
  noteItemId: number;
  conversationKind: "global" | "paper";
}) {
  const { send, system, noteItemId, conversationKind } = params;
  assert.equal(send.conversationKind, conversationKind);
  assert.notEqual(send.scopeType, "note");
  assert.equal(send.activeNoteContext?.noteId, noteItemId);
  assert.isNumber(send.conversationKey);
  assert.isTrue(
    isConversationKeyForKind(
      system,
      conversationKind,
      send.conversationKey || 0,
    ),
    `expected ${send.conversationKey} to be a ${system} ${conversationKind} key`,
  );
}

describe("workflow: note editing mode", function () {
  this.timeout(30000);

  let api: WorkflowTestApi;
  let fixture:
    | WorkflowTestNoteFixture
    | WorkflowTestStandaloneNoteFixture
    | null = null;

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
  });

  it("adds selected item-note text and preloads the parent paper context", async function () {
    const selectedSentence =
      "Stable subspaces remain readable while dynamic components drift.";
    fixture = await api.createItemNoteFixture({
      title: "Workflow Note Parent Paper",
      pdfTitle: "Workflow Note Parent PDF",
      noteHtml: `<p>${selectedSentence}</p><p>Additional note detail.</p>`,
    });

    const panel = await api.renderPanelForItem(fixture.noteItemId);
    const initialDiagnostics = await api.getDiagnostics(panel.panelId);
    assert.equal(initialDiagnostics.conversationKind, "paper");
    assert.isTrue(
      initialDiagnostics.historyNewVisible,
      await diagnosticsMessage(api, panel.panelId),
    );
    assert.isTrue(
      initialDiagnostics.historyToggleVisible,
      await diagnosticsMessage(api, panel.panelId),
    );
    await api.selectNoteEditorText(panel.panelId, selectedSentence);
    const send = await api.ask(panel.panelId, "Rewrite the selected sentence");

    assert.deepEqual(send.selectedTexts, [selectedSentence]);
    assert.deepEqual(send.selectedTextSources, ["note-edit"]);
    assert.equal(
      send.selectedTextNoteContexts?.[0]?.noteItemId,
      fixture.noteItemId,
      await diagnosticsMessage(api, panel.panelId),
    );
    assert.equal(send.selectedTextNoteContexts?.[0]?.noteKind, "item");
    assert.equal(
      send.selectedTextNoteContexts?.[0]?.parentItemId,
      fixture.parentItemId,
    );
    assert.include(send.activeNoteContext?.noteText || "", selectedSentence);
    assert.equal(send.activeNoteContext?.noteKind, "item");
    assert.equal(send.activeNoteContext?.parentItemId, fixture.parentItemId);
    assert.equal(
      send.contextSource?.paperContext?.itemId,
      fixture.parentItemId,
      await diagnosticsMessage(api, panel.panelId),
    );
    assert.equal(
      send.contextSource?.paperContext?.contextItemId,
      fixture.pdfAttachmentId,
      await diagnosticsMessage(api, panel.panelId),
    );
    assertNoteSendRouting({
      send,
      system: "upstream",
      noteItemId: fixture.noteItemId,
      conversationKind: "paper",
    });
  });

  it("keeps standalone notes on library chat without parent paper context", async function () {
    const selectedSentence =
      "Standalone notes should not borrow a paper unless the user adds one.";
    fixture = await api.createStandaloneNoteFixture({
      noteHtml: `<p>${selectedSentence}</p>`,
    });

    const panel = await api.renderPanelForItem(fixture.noteItemId);
    const initialDiagnostics = await api.getDiagnostics(panel.panelId);
    assert.equal(initialDiagnostics.conversationKind, "global");
    assert.isTrue(
      initialDiagnostics.historyNewVisible,
      await diagnosticsMessage(api, panel.panelId),
    );
    assert.isTrue(
      initialDiagnostics.historyToggleVisible,
      await diagnosticsMessage(api, panel.panelId),
    );
    await api.selectNoteEditorText(panel.panelId, selectedSentence);
    const send = await api.ask(panel.panelId, "Rewrite this note sentence");

    assert.deepEqual(send.selectedTexts, [selectedSentence]);
    assert.deepEqual(send.selectedTextSources, ["note-edit"]);
    assert.equal(send.selectedTextNoteContexts?.[0]?.noteKind, "standalone");
    assert.isUndefined(send.selectedTextNoteContexts?.[0]?.parentItemId);
    assert.equal(send.activeNoteContext?.noteKind, "standalone");
    assert.isUndefined(send.activeNoteContext?.parentItemId);
    assert.isUndefined(
      send.contextSource?.paperContext,
      await diagnosticsMessage(api, panel.panelId),
    );
    assertNoteSendRouting({
      send,
      system: "upstream",
      noteItemId: fixture.noteItemId,
      conversationKind: "global",
    });
  });

  it("routes upstream, Codex, and Claude Code sends through parent paper conversations", async function () {
    const selectedSentence = "Runtime-specific note chats must stay isolated.";
    fixture = await api.createItemNoteFixture({
      title: "Workflow Runtime Note Parent",
      pdfTitle: "Workflow Runtime Note PDF",
      noteHtml: `<p>${selectedSentence}</p>`,
    });

    const modes: Array<{
      system: ConversationSystem;
      prefs: Record<string, unknown>;
    }> = [
      {
        system: "upstream",
        prefs: {
          enableCodexAppServerMode: true,
          enableClaudeCodeMode: true,
          conversationSystem: "upstream",
        },
      },
      {
        system: "codex",
        prefs: {
          enableCodexAppServerMode: true,
          enableClaudeCodeMode: true,
          conversationSystem: "codex",
        },
      },
      {
        system: "claude_code",
        prefs: {
          enableCodexAppServerMode: true,
          enableClaudeCodeMode: true,
          conversationSystem: "claude_code",
        },
      },
    ];

    for (const mode of modes) {
      await api.reset();
      await withPrefs(mode.prefs, async () => {
        const panel = await api.renderPanelForItem(
          (fixture as WorkflowTestNoteFixture).noteItemId,
        );
        await api.selectNoteEditorText(panel.panelId, selectedSentence);
        const send = await api.ask(
          panel.panelId,
          `Route this note through ${mode.system}`,
        );
        const diagnostics = await api.getDiagnostics(panel.panelId);
        assert.equal(
          diagnostics.conversationKind,
          "paper",
          await diagnosticsMessage(api, panel.panelId),
        );
        assert.equal(diagnostics.conversationSystem, mode.system);
        assert.isTrue(
          isConversationKeyForKind(
            mode.system,
            "paper",
            diagnostics.conversationKey || 0,
          ),
          await diagnosticsMessage(api, panel.panelId),
        );
        assertNoteSendRouting({
          send,
          system: mode.system,
          noteItemId: (fixture as WorkflowTestNoteFixture).noteItemId,
          conversationKind: "paper",
        });
      });
    }
  });

  it("keeps Codex parent paper scope when Claude Code is disabled", async function () {
    const selectedSentence =
      "Disabled Claude preferences must not demote Codex note chats.";
    fixture = await api.createItemNoteFixture({
      title: "Workflow Disabled Claude Parent",
      pdfTitle: "Workflow Disabled Claude PDF",
      noteHtml: `<p>${selectedSentence}</p>`,
    });

    await withPrefs(
      {
        enableCodexAppServerMode: true,
        enableClaudeCodeMode: false,
        conversationSystem: "codex",
      },
      async () => {
        const panel = await api.renderPanelForItem(
          (fixture as WorkflowTestNoteFixture).noteItemId,
        );
        await api.selectNoteEditorText(panel.panelId, selectedSentence);
        const diagnostics = await api.getDiagnostics(panel.panelId);
        assert.equal(
          diagnostics.conversationKind,
          "paper",
          await diagnosticsMessage(api, panel.panelId),
        );
        assert.equal(diagnostics.conversationSystem, "codex");
        assert.isTrue(
          isConversationKeyForKind(
            "codex",
            "paper",
            diagnostics.conversationKey || 0,
          ),
          await diagnosticsMessage(api, panel.panelId),
        );
        assert.include(
          diagnostics.selectedContextLabels,
          "Editing",
          await diagnosticsMessage(api, panel.panelId),
        );

        const send = await api.ask(
          panel.panelId,
          "Rewrite this note after switching to Codex",
        );

        assert.deepEqual(send.selectedTexts, [selectedSentence]);
        assert.deepEqual(send.selectedTextSources, ["note-edit"]);
        assert.equal(
          send.selectedTextNoteContexts?.[0]?.noteItemId,
          (fixture as WorkflowTestNoteFixture).noteItemId,
        );
        assert.equal(
          send.contextSource?.paperContext?.itemId,
          (fixture as WorkflowTestNoteFixture).parentItemId,
          await diagnosticsMessage(api, panel.panelId),
        );
        assertNoteSendRouting({
          send,
          system: "codex",
          noteItemId: (fixture as WorkflowTestNoteFixture).noteItemId,
          conversationKind: "paper",
        });
      },
    );
  });

  it("updates the active note focus conversation key immediately after mode switch", async function () {
    const selectedSentence =
      "Mode switches must not leave note selection rendering on the old key.";
    fixture = await api.createItemNoteFixture({
      title: "Workflow Switched Runtime Parent",
      pdfTitle: "Workflow Switched Runtime PDF",
      noteHtml: `<p>${selectedSentence}</p>`,
    });

    await withPrefs(
      {
        enableCodexAppServerMode: true,
        enableClaudeCodeMode: true,
        conversationSystem: "upstream",
      },
      async () => {
        const panel = await api.renderPanelForItem(
          (fixture as WorkflowTestNoteFixture).noteItemId,
        );
        const initial = await api.getDiagnostics(panel.panelId);
        assert.equal(initial.conversationSystem, "upstream");
        assert.equal(
          initial.panelConversationKey,
          initial.conversationKey,
          await diagnosticsMessage(api, panel.panelId),
        );
        assertDualRuntimeControls(initial);

        const switched = await api.clickPanelSystemToggle(
          panel.panelId,
          "codex",
        );
        assert.equal(switched.conversationSystem, "codex");
        assert.equal(
          switched.panelConversationKey,
          switched.conversationKey,
          await diagnosticsMessage(api, panel.panelId),
        );
        assertDualRuntimeControls(switched, "codex");
        const firstCodexKey = switched.conversationKey;
        const codexMarker = "nonblank note-focused Codex chat";
        await api.seedPanelStoredUserMessage(panel.panelId, codexMarker);

        const claude = await api.clickPanelSystemToggle(
          panel.panelId,
          "claude_code",
        );
        assert.equal(claude.conversationSystem, "claude_code");
        assert.equal(claude.panelConversationKey, claude.conversationKey);
        assertDualRuntimeControls(claude, "claude_code");

        const upstream = await api.clickPanelSystemToggle(
          panel.panelId,
          "claude_code",
        );
        assert.equal(upstream.conversationSystem, "upstream");
        assert.equal(upstream.panelConversationKey, upstream.conversationKey);
        assertDualRuntimeControls(upstream);

        const freshCodex = await api.clickPanelSystemToggle(
          panel.panelId,
          "codex",
        );
        assert.equal(freshCodex.conversationSystem, "codex");
        assert.notEqual(freshCodex.conversationKey, firstCodexKey);
        assert.notInclude(freshCodex.messageText || "", codexMarker);
        assertDualRuntimeControls(freshCodex, "codex");

        await api.selectNoteEditorText(panel.panelId, selectedSentence);
        const selected = await api.getDiagnostics(panel.panelId);
        assert.include(
          selected.selectedContextLabels,
          "Editing",
          await diagnosticsMessage(api, panel.panelId),
        );
      },
    );
  });

  it("switches a standalone note directly between both toolbar runtimes", async function () {
    fixture = await api.createItemNoteFixture({
      title: "Workflow Standalone Runtime Parent",
      pdfTitle: "Workflow Standalone Runtime PDF",
      noteHtml: "<p>Standalone note routing must follow its toolbar.</p>",
    });

    await withPrefs(
      {
        enableCodexAppServerMode: true,
        enableClaudeCodeMode: true,
        conversationSystem: "upstream",
      },
      async () => {
        const initial = await api.openStandaloneForItem(
          (fixture as WorkflowTestNoteFixture).noteItemId,
        );
        assert.equal(initial.conversationSystem, "upstream");
        assertDualRuntimeControls(initial);

        const codex = await api.clickStandaloneSystemToggle("codex");
        assert.equal(codex.conversationSystem, "codex");
        assert.isTrue(
          isConversationKeyForKind(
            "codex",
            "paper",
            codex.conversationKey || 0,
          ),
          JSON.stringify(codex, null, 2),
        );
        assertDualRuntimeControls(codex, "codex");

        const claude = await api.clickStandaloneSystemToggle("claude_code");
        assert.equal(claude.conversationSystem, "claude_code");
        assert.isTrue(
          isConversationKeyForKind(
            "claude_code",
            "paper",
            claude.conversationKey || 0,
          ),
          JSON.stringify(claude, null, 2),
        );
        assertDualRuntimeControls(claude, "claude_code");

        const send = await api.askStandalone(
          "Route this standalone note through Claude Code",
        );
        assertNoteSendRouting({
          send,
          system: "claude_code",
          noteItemId: (fixture as WorkflowTestNoteFixture).noteItemId,
          conversationKind: "paper",
        });
      },
    );
  });

  it("clears only the transient note-edit selection", async function () {
    const selectedSentence = "This selected sentence is transient.";
    fixture = await api.createItemNoteFixture({
      title: "Workflow Clear Note Parent",
      pdfTitle: "Workflow Clear Note PDF",
      noteHtml: `<p>${selectedSentence}</p><p>Persistent note body.</p>`,
    });

    const panel = await api.renderPanelForItem(fixture.noteItemId);
    await api.selectNoteEditorText(panel.panelId, selectedSentence);
    await api.selectNoteEditorText(panel.panelId, "");
    const send = await api.ask(panel.panelId, "Use the note without selection");

    assert.isUndefined(send.selectedTexts);
    assert.isUndefined(send.selectedTextSources);
    assert.equal(send.activeNoteContext?.noteId, fixture.noteItemId);
    assert.include(send.activeNoteContext?.noteText || "", selectedSentence);
    assert.equal(
      send.contextSource?.paperContext?.itemId,
      fixture.parentItemId,
      await diagnosticsMessage(api, panel.panelId),
    );
  });

  it("keeps the editing chip after send while the note selection remains", async function () {
    const selectedSentence = "Persistent note selections stay editable.";
    fixture = await api.createItemNoteFixture({
      title: "Workflow Persistent Note Parent",
      pdfTitle: "Workflow Persistent Note PDF",
      noteHtml: `<p>${selectedSentence}</p><p>Persistent note body.</p>`,
    });

    const panel = await api.renderPanelForItem(fixture.noteItemId);
    await api.selectNoteEditorText(panel.panelId, selectedSentence);

    const firstSend = await api.ask(panel.panelId, "Rewrite selected text");
    assert.deepEqual(firstSend.selectedTexts, [selectedSentence]);
    assert.deepEqual(firstSend.selectedTextSources, ["note-edit"]);

    const afterFirstSend = await api.getDiagnostics(panel.panelId);
    assert.include(
      afterFirstSend.selectedContextLabels,
      "Editing",
      await diagnosticsMessage(api, panel.panelId),
    );

    const followUpSend = await api.ask(panel.panelId, "Try again");
    assert.deepEqual(followUpSend.selectedTexts, [selectedSentence]);
    assert.deepEqual(followUpSend.selectedTextSources, ["note-edit"]);

    await api.selectNoteEditorText(panel.panelId, "");
    const afterClear = await api.getDiagnostics(panel.panelId);
    assert.notInclude(
      afterClear.selectedContextLabels,
      "Editing",
      await diagnosticsMessage(api, panel.panelId),
    );
  });

  it("rehydrates note focus and selected snippet after remount", async function () {
    const selectedSentence = "Remounted note panels keep the editing snippet.";
    fixture = await api.createItemNoteFixture({
      title: "Workflow Remount Note Parent",
      pdfTitle: "Workflow Remount Note PDF",
      noteHtml: `<p>${selectedSentence}</p>`,
    });

    const firstPanel = await api.renderPanelForItem(fixture.noteItemId);
    await api.selectNoteEditorText(firstPanel.panelId, selectedSentence);

    const remountedPanel = await api.renderPanelForItem(fixture.noteItemId);
    const send = await api.ask(
      remountedPanel.panelId,
      "Use the existing selected note text",
    );

    assert.deepEqual(send.selectedTexts, [selectedSentence]);
    assert.deepEqual(send.selectedTextSources, ["note-edit"]);
    assert.equal(send.conversationKind, "paper");
    assert.notEqual(send.scopeType, "note");
    assert.equal(send.activeNoteContext?.noteId, fixture.noteItemId);
  });
});
