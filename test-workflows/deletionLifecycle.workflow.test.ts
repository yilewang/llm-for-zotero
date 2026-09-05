import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

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
      if (value === undefined) Zotero.Prefs.clear?.(fullKey, true);
      else Zotero.Prefs.set(fullKey, value, true);
    }
  }
}

declare const Zotero: any;

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

// Errors serialized across the Zotero/runner boundary lose their message;
// surface them through the assertion's `actual` field, which is printed.
async function surfacing(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Gecko Error#stack does NOT include the message line — surface both, or
    // diagnostic details thrown by the harness are lost at the boundary.
    const message = String((err as Error)?.message || err);
    const stack = String((err as Error)?.stack || "");
    const detail = message + (stack ? `\n${stack}` : "");
    assert.equal(detail, "OK", "step failed");
  }
}

describe("deletion lifecycle", function () {
  this.timeout(45000);

  for (const runtime of [
    {
      label: "upstream/Agent",
      system: "upstream",
      prefs: {
        enableCodexAppServerMode: false,
        enableClaudeCodeMode: false,
        conversationSystem: "upstream",
      },
    },
    {
      label: "Claude Code",
      system: "claude_code",
      prefs: {
        enableCodexAppServerMode: false,
        enableClaudeCodeMode: true,
        conversationSystem: "claude_code",
      },
    },
    {
      label: "Codex",
      system: "codex",
      prefs: {
        enableCodexAppServerMode: true,
        enableClaudeCodeMode: false,
        conversationSystem: "codex",
      },
    },
  ] as const) {
    it(`header trash action deletes the active ${runtime.label} conversation and renders a fresh panel`, async function () {
      await withPrefs(runtime.prefs, async () =>
        surfacing(async () => {
          const api = getWorkflowTestApi();
          await api.reset();
          const fixture = await api.createPaperWithPdfFixture({
            title: `Header Delete ${runtime.label} Paper`,
            pdfTitle: `header-delete-${runtime.system}.pdf`,
          });
          try {
            const panel = await api.renderPanelForItem(fixture.parentItemId);
            const before = await api.getDiagnostics(panel.panelId);
            assert.equal(before.conversationSystem, runtime.system);
            const seeded = await api.seedPanelStoredTurn(
              panel.panelId,
              `delete ${runtime.label} question`,
              `delete ${runtime.label} answer`,
            );
            assert.equal(
              await api.getPanelVisibleMessageCount(panel.panelId),
              2,
            );

            await api.clickPanelDelete(panel.panelId);

            const after = await api.getDiagnostics(panel.panelId);
            assert.equal(after.conversationSystem, runtime.system);
            assert.notEqual(after.conversationKey, seeded.conversationKey);
            assert.equal(
              await api.getPanelVisibleMessageCount(panel.panelId),
              0,
              "the replacement panel must be empty",
            );
            const pending = await api.getPendingDeletionState();
            assert.include(
              pending.pendingConversationKeys,
              seeded.conversationKey,
            );
            assert.equal(pending.persistedRowCount, 1);
            assert.isTrue(await api.isPanelUndoToastVisible(panel.panelId));
            const history = await api.listPanelHistory(panel.panelId);
            assert.notInclude(
              history.map((row) => row.conversationKey),
              seeded.conversationKey,
            );

            await api.clickPanelUndo(panel.panelId);
            const restored = await api.getDiagnostics(panel.panelId);
            assert.equal(restored.conversationKey, seeded.conversationKey);
            assert.equal(
              await api.getPanelVisibleMessageCount(panel.panelId),
              2,
              "Undo must restore the deleted conversation and its messages",
            );
            assert.equal(
              (await api.getPendingDeletionState()).persistedRowCount,
              0,
            );
          } finally {
            await api.cleanupFixture(fixture);
          }
        }),
      );
    });
  }

  it("rejects header trash while the active conversation is generating", async function () {
    await withPrefs(
      {
        enableCodexAppServerMode: false,
        enableClaudeCodeMode: false,
        conversationSystem: "upstream",
      },
      async () =>
        surfacing(async () => {
          const api = getWorkflowTestApi();
          await api.reset();
          const fixture = await api.createPaperWithPdfFixture({
            title: "Pending Header Delete Paper",
            pdfTitle: "pending-header-delete.pdf",
          });
          try {
            const panel = await api.renderPanelForItem(fixture.parentItemId);
            const result = await api.exercisePanelDeleteDuringPendingSend(
              panel.panelId,
              "Keep this request active while I click delete",
            );

            assert.isTrue(result.requestPendingBeforeClick);
            assert.isTrue(result.requestPendingAfterClick);
            assert.equal(
              result.conversationKeyAfter,
              result.conversationKeyBefore,
              JSON.stringify(result),
            );
            assert.isFalse(
              result.pendingDeletionQueued,
              JSON.stringify(result),
            );
            assert.include(
              result.statusText,
              "Cannot delete while generating",
              JSON.stringify(result),
            );
          } finally {
            await api.cleanupFixture(fixture);
          }
        }),
    );
  });

  it("delete → remount (user switches) → undo from the new panel restores the chat", async function () {
    await surfacing(async () => {
      const api = getWorkflowTestApi();
      await api.reset();
      const fixture = await api.createPaperWithPdfFixture({
        title: "Deletion Lifecycle Paper A",
        pdfTitle: "deletion-a.pdf",
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await api.seedPanelStoredUserMessage(panel.panelId, "hello world");
        const diagnostics = await api.getDiagnostics(panel.panelId);
        const conversationKey = diagnostics.conversationKey!;
        assert.isOk(conversationKey);

        // A second conversation so the first becomes a deletable history row.
        await api.startNewPanelConversation(panel.panelId);
        await api.seedPanelStoredUserMessage(panel.panelId, "second chat");

        await api.deletePanelHistoryConversation(
          panel.panelId,
          conversationKey,
        );
        let state = await api.getPendingDeletionState();
        assert.include(state.pendingConversationKeys, conversationKey);
        assert.equal(state.persistedRowCount, 1, "intent must be durable");
        assert.isTrue(await api.isPanelUndoToastVisible(panel.panelId));
        const hiddenHistory = await api.listPanelHistory(panel.panelId);
        assert.notInclude(
          hiddenHistory.map((h) => h.conversationKey),
          conversationKey,
          "queued row must be hidden immediately",
        );

        // The user switches away: the panel is torn down and rebuilt.
        const remounted = await api.remountPanel(panel.panelId);
        assert.isTrue(
          await api.isPanelUndoToastVisible(remounted.panelId),
          "undo toast must survive the remount",
        );
        const history = await api.listPanelHistory(remounted.panelId);
        assert.notInclude(
          history.map((h) => h.conversationKey),
          conversationKey,
          "queued row must stay hidden after remount",
        );

        await api.clickPanelUndo(remounted.panelId);
        state = await api.getPendingDeletionState();
        assert.equal(state.persistedRowCount, 0, "undo must clear the intent");
        const restored = await api.listPanelHistory(remounted.panelId);
        assert.include(
          restored.map((h) => h.conversationKey),
          conversationKey,
          "undone conversation must reappear",
        );
      } finally {
        await api.cleanupFixture(fixture);
      }
    });
  });

  it("delete → no undo → the chat is really gone, even across a simulated restart", async function () {
    await surfacing(async () => {
      const api = getWorkflowTestApi();
      await api.reset();
      const fixture = await api.createPaperWithPdfFixture({
        title: "Deletion Lifecycle Paper B",
        pdfTitle: "deletion-b.pdf",
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await api.seedPanelStoredUserMessage(panel.panelId, "doomed chat");
        const conversationKey = (await api.getDiagnostics(panel.panelId))
          .conversationKey!;
        await api.startNewPanelConversation(panel.panelId);
        await api.seedPanelStoredUserMessage(panel.panelId, "survivor chat");
        const survivorKey = (await api.getDiagnostics(panel.panelId))
          .conversationKey!;
        assert.notEqual(conversationKey, survivorKey);

        await api.deletePanelHistoryConversation(
          panel.panelId,
          conversationKey,
        );
        // Simulate "user quit during the cooldown": go straight to the sweep
        // that runs on next startup, without waiting for the live timer.
        await api.sweepPendingDeletionsAsRestart();

        const state = await api.getPendingDeletionState();
        assert.equal(state.persistedRowCount, 0);
        const history = await api.listPanelHistory(panel.panelId);
        const keys = history.map((h) => h.conversationKey);
        assert.notInclude(
          keys,
          conversationKey,
          "intended delete must complete",
        );
        assert.include(keys, survivorKey, "unintended chat must survive");
      } finally {
        await api.cleanupFixture(fixture);
      }
    });
  });

  it("issue #356: an orphaned Codex conversation with a missing native thread stays deleted", async function () {
    await withPrefs(
      {
        enableCodexAppServerMode: true,
        enableClaudeCodeMode: false,
        conversationSystem: "codex",
      },
      async () =>
        surfacing(async () => {
          const api = getWorkflowTestApi();
          await api.reset();
          const fixture = await api.createPaperWithPdfFixture({
            title: "Issue 356 orphaned Codex paper",
            pdfTitle: "issue-356-orphan.pdf",
          });
          try {
            const panel = await api.renderPanelForItem(fixture.parentItemId);
            const initial = await api.getDiagnostics(panel.panelId);
            assert.equal(initial.conversationSystem, "codex");

            await api.seedPanelStoredUserMessage(
              panel.panelId,
              "ISSUE-356-DOOMED-CONTENT",
            );
            const doomedKey = (await api.getDiagnostics(panel.panelId))
              .conversationKey!;

            await api.startNewPanelConversation(panel.panelId);
            await api.seedPanelStoredUserMessage(
              panel.panelId,
              "ISSUE-356-SURVIVOR-CONTENT",
            );
            const survivorKey = (await api.getDiagnostics(panel.panelId))
              .conversationKey!;
            assert.notEqual(doomedKey, survivorKey);
            const survivorBefore =
              await api.getWorkflowConversationPersistenceSnapshot(
                "codex",
                survivorKey,
              );

            // Reproduce the orphan: the Zotero source is gone, while the
            // catalog still carries a native thread ID that cannot be found.
            await api.setWorkflowProviderSession(
              "codex",
              doomedKey,
              "workflow-issue-356-native-thread-does-not-exist",
            );
            await api.trashWorkflowItem(fixture.parentItemId);

            await api.deletePanelHistoryConversation(panel.panelId, doomedKey);
            const queued = await api.getPendingDeletionState();
            assert.include(queued.pendingConversationKeys, doomedKey);
            assert.equal(queued.persistedRowCount, 1);

            // The restart sweep stands in for the expired timer, and the
            // second sweep/remount exercises the old retry-and-resurrection
            // path that used to recreate an empty conversation.
            await api.sweepPendingDeletionsAsRestart();
            const remounted = await api.remountPanel(panel.panelId);
            await api.sweepPendingDeletionsAsRestart();

            const history = await api.listPanelHistory(remounted.panelId);
            const historyKeys = history.map((row) => row.conversationKey);
            assert.notInclude(historyKeys, doomedKey);
            assert.include(historyKeys, survivorKey);
            const doomedRows =
              await api.getWorkflowConversationPersistenceSnapshot(
                "codex",
                doomedKey,
              );
            assert.equal(doomedRows.catalogRows, 0);
            assert.equal(doomedRows.messageRows, 0);
            assert.equal(doomedRows.searchIndexRows, 0);
            assert.equal(doomedRows.registryRows, 0);
            assert.equal(doomedRows.forkSourceRows, 0);
            assert.equal(doomedRows.forkTargetRows, 0);
            assert.equal(doomedRows.pendingDeletionRows, 0);
            const survivorAfter =
              await api.getWorkflowConversationPersistenceSnapshot(
                "codex",
                survivorKey,
              );
            assert.deepEqual(survivorAfter, survivorBefore);
          } finally {
            await api.cleanupFixture(fixture);
          }
        }),
    );
  });

  it("turn delete → undo restores the turn; turn delete → sweep removes only that turn", async function () {
    await surfacing(async () => {
      const api = getWorkflowTestApi();
      await api.reset();
      const fixture = await api.createPaperWithPdfFixture({
        title: "Deletion Lifecycle Paper C",
        pdfTitle: "deletion-c.pdf",
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const keptTurn = await api.seedPanelStoredTurn(
          panel.panelId,
          "keep question",
          "keep answer",
        );
        const doomedTurn = await api.seedPanelStoredTurn(
          panel.panelId,
          "doomed question",
          "doomed answer",
        );
        assert.equal(keptTurn.conversationKey, doomedTurn.conversationKey);
        const fullCount = await api.getPanelVisibleMessageCount(panel.panelId);
        assert.isAtLeast(fullCount, 4);

        // Queue the second turn for deletion, then undo — everything is back.
        await api.deletePanelTurn(
          panel.panelId,
          doomedTurn.userTimestamp,
          doomedTurn.assistantTimestamp,
        );
        assert.equal(
          await api.getPanelVisibleMessageCount(panel.panelId),
          fullCount - 2,
          "queued turn must be hidden from the render",
        );
        assert.isTrue(await api.isPanelUndoToastVisible(panel.panelId));
        await api.clickPanelUndo(panel.panelId);
        assert.equal(
          await api.getPanelVisibleMessageCount(panel.panelId),
          fullCount,
          "undone turn must reappear",
        );

        // Queue again, then simulate quit + restart sweep — the turn is gone
        // for real while the kept turn survives.
        await api.deletePanelTurn(
          panel.panelId,
          doomedTurn.userTimestamp,
          doomedTurn.assistantTimestamp,
        );
        await api.sweepPendingDeletionsAsRestart();
        const state = await api.getPendingDeletionState();
        assert.equal(state.persistedRowCount, 0);
        const remounted = await api.remountPanel(panel.panelId);
        const countAfter = await api.getPanelVisibleMessageCount(
          remounted.panelId,
        );
        assert.equal(
          countAfter,
          fullCount - 2,
          "swept turn must stay deleted after a rebuild",
        );
      } finally {
        await api.cleanupFixture(fixture);
      }
    });
  });

  it("a turn whose finalize fails stays out of the next send's prompt", async function () {
    await surfacing(async () => {
      const api = getWorkflowTestApi();
      await api.reset();
      const fixture = await api.createPaperWithPdfFixture({
        title: "Deletion Prompt Invariant Paper",
        pdfTitle: "deletion-prompt.pdf",
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await api.seedPanelStoredTurn(
          panel.panelId,
          "keep this question",
          "keep this answer",
        );
        const doomed = await api.seedPanelStoredTurn(
          panel.panelId,
          "DOOMED-QUESTION-XK9",
          "DOOMED-ANSWER-XK9",
        );
        await api.deletePanelTurn(
          panel.panelId,
          doomed.userTimestamp,
          doomed.assistantTimestamp,
        );
        await api.failNextPendingTurnFinalizes(1);
        const finalRequest = await api.askCapturingFinalRequest(
          panel.panelId,
          "and a brand new question",
        );
        const historyBlob = (finalRequest.historyTexts || []).join("\n");
        assert.notInclude(historyBlob, "DOOMED-QUESTION-XK9");
        assert.notInclude(historyBlob, "DOOMED-ANSWER-XK9");
        assert.include(historyBlob, "keep this question");
        const pending = await api.getPendingDeletionState();
        assert.equal(
          pending.persistedRowCount,
          1,
          "failed finalize keeps the entry queued for retry",
        );
      } finally {
        await api.cleanupFixture(fixture);
      }
    });
  });

  it("history search cannot surface text from a turn queued for deletion", async function () {
    await surfacing(async () => {
      const api = getWorkflowTestApi();
      await api.reset();
      const fixture = await api.createPaperWithPdfFixture({
        title: "Deletion Search Invariant Paper",
        pdfTitle: "deletion-search.pdf",
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await api.seedPanelStoredTurn(
          panel.panelId,
          "tell me about zebrafish",
          "zebrafish are great",
        );
        const doomed = await api.seedPanelStoredTurn(
          panel.panelId,
          "question about XYLOGRAPH-SECRET",
          "answer about XYLOGRAPH-SECRET",
        );
        const before = await api.searchPanelHistory(panel.panelId, "xylograph");
        assert.isAtLeast(
          before.entries.length,
          1,
          "sanity: text is searchable before deletion",
        );
        await api.deletePanelTurn(
          panel.panelId,
          doomed.userTimestamp,
          doomed.assistantTimestamp,
        );
        const during = await api.searchPanelHistory(panel.panelId, "xylograph");
        assert.lengthOf(
          during.entries,
          0,
          "queued-for-deletion text must not match",
        );
        const otherTurn = await api.searchPanelHistory(
          panel.panelId,
          "zebrafish",
        );
        assert.isAtLeast(otherTurn.entries.length, 1);
        for (const preview of otherTurn.previews) {
          assert.notInclude(preview, "XYLOGRAPH-SECRET");
        }
        await api.clickPanelUndo(panel.panelId);
        const after = await api.searchPanelHistory(panel.panelId, "xylograph");
        assert.isAtLeast(
          after.entries.length,
          1,
          "undo must restore searchability",
        );
      } finally {
        await api.cleanupFixture(fixture);
      }
    });
  });
});
