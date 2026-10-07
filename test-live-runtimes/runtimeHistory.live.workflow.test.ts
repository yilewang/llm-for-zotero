/**
 * Live R1: each conversation system keeps a real two-turn conversation
 * through history, search, remount, turn delete + Undo, and a deletion that
 * the restart sweep finishes.
 *
 * For each system (upstream, Claude Code, Codex) and each kind (paper,
 * library) the panel sends "Reply with exactly MARK-..." and then "Reply
 * with exactly the text of your previous reply." through the composer. Six
 * cases, two live turns each.
 *
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live-runtimes \
 *   LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS=history \
 *   LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-flash \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js with that model> \
 *   LLM_FOR_ZOTERO_LIVE_CODEX_PATH=<codex binary> \
 *   ZOTERO_PLUGIN_KILL_COMMAND='pkill -9 -f "<worktree>/.scaffold/test/profile" || true' \
 *   node scripts/run-workflow-tests.mjs --agent-live
 *
 * Optional: LLM_FOR_ZOTERO_LIVE_RUNTIME_SYSTEMS=upstream,codex (a subset),
 * LLM_FOR_ZOTERO_LIVE_CODEX_MODEL (default gpt-6-astra),
 * LLM_FOR_ZOTERO_LIVE_CLAUDE_MODEL (default: the plugin's default).
 */
import { assert } from "chai";
import { resolveLiveAgentCredentials } from "../test-live-agent/liveAgentCredentials";
import {
  LIVE_MODEL_ENTRY_ID,
  describeError,
  ensureOwnZoteroHttpServer,
  env,
  liveRuntimePrefs,
  persistenceSnapshot,
  randomTag,
  readStoredMessages,
  selectedSystems,
  shortSystemName,
  switchPanelToLibraryChat,
  waitFor,
  withPrefs,
  workflowApi,
  type LiveKind,
} from "./runtimeLiveShared";

const selectedTests = env("LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS");
const enabled = !selectedTests || selectedTests.split(",").includes("history");

(enabled ? describe : describe.skip)(
  "live R1: runtime conversation history lifecycle",
  function () {
    this.timeout(900_000);

    // Codex and Claude Code call this instance's MCP endpoint over HTTP.
    before(async function () {
      await ensureOwnZoteroHttpServer();
    });

    for (const system of selectedSystems()) {
      for (const kind of ["paper", "library"] as LiveKind[]) {
        it(`${system} ${kind}: two live turns survive history, search, remount, undo and the restart sweep`, async function () {
          const credentials = await resolveLiveAgentCredentials();
          assert.isOk(
            credentials,
            "Configure LLM_FOR_ZOTERO_LIVE_MODEL in LLM_FOR_ZOTERO_LIVE_PROFILE_PATH; this test must not skip",
          );
          const api = workflowApi();
          await api.reset();
          let fixture: Awaited<
            ReturnType<typeof api.createPaperWithPdfFixture>
          > | null = null;
          const step = { name: "setup" };
          // A run that fails before its own delete step leaves the
          // conversation behind, and the Claude Code bridge keeps that
          // conversation's session hot. Each run starts on a reset DB, so the
          // next run gets the same conversation key and would resume the old
          // session with every earlier marker in it. The finally block deletes
          // such a conversation through the plugin, which also invalidates
          // the bridge session.
          const leftover = { key: 0, deleted: false };
          try {
            await withPrefs(
              liveRuntimePrefs(system, credentials!),
              async () => {
                fixture = await api.createPaperWithPdfFixture({
                  title: `Live runtime history ${system} ${kind}`,
                  pdfTitle: `live-runtime-history-${system}-${kind}.pdf`,
                  pages: [
                    "This synthetic page exists only so the panel has a paper to open.",
                  ],
                });
                let panel = await api.renderPanelForItem(fixture.parentItemId);
                let diag = await api.getDiagnostics(panel.panelId);
                assert.equal(diag.conversationSystem, system, "panel system");
                if (kind === "library") {
                  diag = await switchPanelToLibraryChat(panel.panelId);
                }
                assert.equal(
                  diag.conversationKind,
                  kind === "library" ? "global" : "paper",
                  "panel kind",
                );
                if (system === "upstream") {
                  await api.selectPanelModelEntry(
                    panel.panelId,
                    LIVE_MODEL_ENTRY_ID,
                  );
                }

                const marker = `MARK-${shortSystemName(system)}-${kind}-${randomTag()}`;
                step.name = "turn 1";
                const first = await api.sendLiveChatTurn(
                  panel.panelId,
                  `Reply with exactly ${marker}`,
                  300_000,
                );
                const key = Number(
                  (await api.getDiagnostics(panel.panelId)).conversationKey,
                );
                assert.isAbove(key, 0, "the turn has a conversation key");
                leftover.key = key;
                step.name = "turn 2";
                const second = await api.sendLiveChatTurn(
                  panel.panelId,
                  "Reply with exactly the text of your previous reply.",
                  300_000,
                );
                assert.include(
                  first.answerText,
                  marker,
                  "turn 1 answers with the marker",
                );
                assert.include(
                  second.answerText,
                  marker,
                  "turn 2 remembers the marker from turn 1",
                );

                step.name = "persistence";
                const stored = await waitFor(
                  () => persistenceSnapshot(system, key),
                  (snapshot) =>
                    snapshot.messageRows >= 4 && snapshot.searchIndexRows >= 1,
                );
                assert.equal(stored.catalogRows, 1, JSON.stringify(stored));
                assert.equal(stored.messageRows, 4, JSON.stringify(stored));
                assert.isAtLeast(
                  stored.searchIndexRows,
                  1,
                  JSON.stringify(stored),
                );
                assert.equal(stored.registryRows, 1, JSON.stringify(stored));

                step.name = "history title";
                const history = await api.listPanelHistory(panel.panelId);
                const row = history.find(
                  (entry) => entry.conversationKey === key,
                );
                assert.isOk(row, "the conversation is listed in history");
                assert.isNotEmpty(
                  row!.title.trim(),
                  "the history row has a title",
                );

                step.name = "history search";
                const search = await waitFor(
                  () => api.searchPanelHistory(panel.panelId, marker),
                  (result) =>
                    result.entries.some(
                      (entry) => entry.conversationKey === key,
                    ),
                );
                assert.include(
                  search.entries.map((entry) => entry.conversationKey),
                  key,
                  "history search finds the marker",
                );

                step.name = "remount";
                panel = await api.remountPanel(panel.panelId);
                diag = await api.getDiagnostics(panel.panelId);
                if (kind === "library" && diag.conversationKind !== "global") {
                  diag = await api.togglePanelConversationMode(panel.panelId);
                }
                assert.equal(
                  diag.conversationKey,
                  key,
                  "the remounted panel reopens the conversation",
                );
                const visible = await waitFor(
                  () => api.getPanelVisibleMessageCount(panel.panelId),
                  (count) => count === 4,
                );
                assert.equal(visible, 4, "four messages after the remount");

                step.name = "turn delete and undo";
                const rows = await readStoredMessages(system, key);
                assert.lengthOf(rows, 4, "four stored message rows");
                await api.deletePanelTurn(
                  panel.panelId,
                  rows[2].timestamp,
                  rows[3].timestamp,
                );
                assert.equal(
                  await waitFor(
                    () => api.getPanelVisibleMessageCount(panel.panelId),
                    (count) => count === 2,
                  ),
                  2,
                  "the queued turn is hidden",
                );
                await api.clickPanelUndo(panel.panelId);
                assert.equal(
                  await waitFor(
                    () => api.getPanelVisibleMessageCount(panel.panelId),
                    (count) => count === 4,
                  ),
                  4,
                  "Undo restores the turn",
                );
                assert.equal(
                  (await api.getPendingDeletionState()).persistedRowCount,
                  0,
                  "Undo clears the deletion intent",
                );
                assert.equal(
                  (await persistenceSnapshot(system, key)).messageRows,
                  4,
                  "Undo keeps all four stored rows",
                );

                step.name = "conversation delete and restart sweep";
                await api.startNewPanelConversation(panel.panelId);
                await api.deletePanelHistoryConversation(panel.panelId, key);
                await api.sweepPendingDeletionsAsRestart();
                leftover.deleted = true;
                const gone = await persistenceSnapshot(system, key);
                assert.deepInclude(
                  gone,
                  {
                    catalogRows: 0,
                    messageRows: 0,
                    searchIndexRows: 0,
                    registryRows: 0,
                    pendingDeletionRows: 0,
                  },
                  JSON.stringify(gone),
                );
              },
            );
          } catch (error) {
            assert.fail(
              `${system} ${kind} failed at ${step.name}: ${describeError(error)}`,
            );
          } finally {
            if (leftover.key && !leftover.deleted && fixture) {
              const paperItemId = (fixture as { parentItemId: number })
                .parentItemId;
              await withPrefs(
                liveRuntimePrefs(system, credentials!),
                async () => {
                  const panel = await api.renderPanelForItem(paperItemId);
                  if (kind === "library") {
                    await switchPanelToLibraryChat(panel.panelId);
                  }
                  await api.startNewPanelConversation(panel.panelId);
                  await api.deletePanelHistoryConversation(
                    panel.panelId,
                    leftover.key,
                  );
                  await api.sweepPendingDeletionsAsRestart();
                },
              ).catch(() => undefined); // cleanup only; the failure is reported
            }
            await api.reset();
            if (fixture) await api.cleanupFixture(fixture);
          }
        });
      }
    }
  },
);
