/**
 * Live R2: Claude Code and Codex act on the library from a library chat.
 *
 * A collection holds two fixture papers. The panel asks the runtime to list
 * them and to create a standalone note titled with a marker in that
 * collection; the test approves each confirmation card the turn raises. It
 * then checks that the note is in the collection, that the conversation rows
 * are in that runtime's own store, and that the run's activity is still shown
 * after the panel is torn down and rebuilt. One live turn per runtime.
 *
 * Permissions: Claude Code uses the "default" permission mode. Claude Code
 * asks before a tool it has no standing permission for, the bridge forwards
 * that request to the panel as a confirmation card, and the plugin's own
 * write tool asks with its review card. "acceptEdits", "auto", "dontAsk" and
 * "bypassPermissions" would skip some of these questions, and "plan" would
 * not write at all, so "default" is the mode in which the note is created
 * only after a confirmation; the test requires at least one card.
 *
 * Codex runs with its default read-only sandbox and the plugin's Zotero MCP
 * tools on (codexAppServerZoteroMcpToolsEnabled). The plugin registers its
 * MCP write tools with approval "auto" and answers Codex's approval request
 * for the trusted Zotero MCP server itself
 * (resolveSafeCodexNativeApprovalRequest), so by design no card appears for a
 * Codex note write in any permission mode. The test approves a card if one
 * appears and reports the count, but does not require one.
 *
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live-runtimes \
 *   LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS=library \
 *   LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-flash \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js with that model> \
 *   LLM_FOR_ZOTERO_LIVE_CODEX_PATH=<codex binary> \
 *   ZOTERO_PLUGIN_KILL_COMMAND='pkill -9 -f "<worktree>/.scaffold/test/profile" || true' \
 *   node scripts/run-workflow-tests.mjs --agent-live
 */
import { assert } from "chai";
import { resolveLiveAgentCredentials } from "../test-live-agent/liveAgentCredentials";
import {
  LIVE_SYSTEMS,
  approveCardsUntil,
  describeError,
  ensureOwnZoteroHttpServer,
  env,
  liveRuntimePrefs,
  persistenceSnapshot,
  randomTag,
  readActivityDisclosures,
  readAgentRun,
  readStoredMessages,
  selectedSystems,
  shortSystemName,
  switchPanelToLibraryChat,
  waitFor,
  withPrefs,
  workflowApi,
  type ApprovedCard,
} from "./runtimeLiveShared";

declare const Zotero: any;

const selectedTests = env("LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS");
const enabled = !selectedTests || selectedTests.split(",").includes("library");

function notesInCollection(collectionId: number): any[] {
  const collection = Zotero.Collections.get(collectionId);
  if (!collection) return [];
  return (collection.getChildItems(false) as any[]).filter((item) =>
    item.isNote(),
  );
}

(enabled ? describe : describe.skip)(
  "live R2: runtime library actions",
  function () {
    this.timeout(900_000);

    // Codex and Claude Code call this instance's MCP endpoint over HTTP.
    before(async function () {
      await ensureOwnZoteroHttpServer();
    });

    for (const system of selectedSystems().filter(
      (entry) => entry !== "upstream",
    )) {
      it(`${system}: lists a collection's papers and creates a confirmed note in it`, async function () {
        const credentials = await resolveLiveAgentCredentials();
        assert.isOk(
          credentials,
          "Configure LLM_FOR_ZOTERO_LIVE_MODEL in LLM_FOR_ZOTERO_LIVE_PROFILE_PATH; this test must not skip",
        );
        const api = workflowApi();
        await api.reset();
        const tag = randomTag();
        const titles = [
          `Lantern coding in synthetic cortex ${tag}`,
          `Harbor drift in simulated hippocampus ${tag}`,
        ];
        const fixtures: Array<
          Awaited<ReturnType<typeof api.createPaperWithPdfFixture>>
        > = [];
        let collection: any = null;
        const approved: ApprovedCard[] = [];
        const step = { name: "setup" };
        const details: Record<string, unknown> = {};
        try {
          await withPrefs(
            liveRuntimePrefs(system, credentials!, {
              codexAppServerZoteroMcpToolsEnabled: true,
              claudeCodePermissionMode: "default",
            }),
            async () => {
              for (const [index, title] of titles.entries()) {
                fixtures.push(
                  await api.createPaperWithPdfFixture({
                    title,
                    pdfTitle: `r2-${system}-${index}.pdf`,
                    pages: [
                      `${title}. This synthetic paper reports that a simulated population code stays readable across sessions.`,
                    ],
                  }),
                );
              }
              collection = new Zotero.Collection();
              collection.libraryID = Zotero.Libraries.userLibraryID;
              collection.name = `R2 ${shortSystemName(system)} folder ${tag}`;
              await collection.saveTx();
              for (const fixture of fixtures) {
                const paper = Zotero.Items.get(fixture.parentItemId);
                paper.addToCollection(collection.id);
                await paper.saveTx();
              }

              let panel = await api.renderPanelForItem(
                fixtures[0].parentItemId,
              );
              let diag = await api.getDiagnostics(panel.panelId);
              assert.equal(diag.conversationSystem, system, "panel system");
              diag = await switchPanelToLibraryChat(panel.panelId);
              assert.equal(diag.conversationKind, "global", "library chat");
              await api.setTaskProgressComposerContexts({
                panelId: panel.panelId,
                collectionContexts: [
                  {
                    collectionId: collection.id,
                    name: collection.name,
                    libraryID: collection.libraryID,
                  },
                ],
              });

              const marker = `MARK-R2-${shortSystemName(system)}-${tag}`;
              step.name = "live turn";
              const turn = await approveCardsUntil(
                panel.panelId,
                api.sendLiveChatTurn(
                  panel.panelId,
                  `List the papers in my Zotero collection "${collection.name}". ` +
                    `Then create one standalone note in that collection titled "${marker}" ` +
                    "that summarises those papers in one sentence each. Use the Zotero tools.",
                  720_000,
                ),
                approved,
              );
              details.approvedCards = approved.length;
              details.answerHead = turn.answerText.slice(0, 400);
              const key = Number(
                (await api.getDiagnostics(panel.panelId)).conversationKey,
              );
              assert.isAbove(key, 0, "the turn has a conversation key");

              step.name = "answer lists the papers";
              for (const title of titles) {
                assert.include(
                  turn.answerText.toLowerCase(),
                  title.split(" ")[0].toLowerCase(),
                  `the answer names ${title}`,
                );
              }

              step.name = "note in collection";
              const notes = await waitFor(
                async () => notesInCollection(collection.id),
                (list) =>
                  list.some((note) =>
                    String(note.getNoteTitle() || "").includes(marker),
                  ),
                30_000,
                500,
              );
              details.notesInCollection = notes.length;
              const note = notes.find((entry) =>
                String(entry.getNoteTitle() || "").includes(marker),
              );
              assert.isOk(
                note,
                `a note titled ${marker} is in the collection; ${JSON.stringify(details)}`,
              );
              assert.isFalse(
                Boolean(note.parentID),
                "the note is standalone, not a child note",
              );
              if (system === "claude_code") {
                assert.isAtLeast(
                  approved.length,
                  1,
                  "the Claude Code write asked for a confirmation",
                );
              }

              step.name = "runtime store";
              const own = await persistenceSnapshot(system, key);
              assert.equal(own.catalogRows, 1, JSON.stringify(own));
              assert.isAtLeast(own.messageRows, 2, JSON.stringify(own));
              assert.equal(own.registryRows, 1, JSON.stringify(own));
              for (const other of LIVE_SYSTEMS.filter(
                (entry) => entry !== system,
              )) {
                const foreign = await persistenceSnapshot(other, key);
                assert.equal(
                  foreign.catalogRows + foreign.messageRows,
                  0,
                  `the ${other} store holds no rows for this conversation`,
                );
              }
              const rows = await readStoredMessages(system, key);
              const runId =
                [...rows].reverse().find((row) => row.role === "assistant")
                  ?.agentRunId || "";
              const run = await readAgentRun(runId);
              details.run = run;
              assert.isOk(run, `the answer has an agent run; ${runId}`);
              assert.isAbove(run!.events, 0, "the run recorded activity");

              step.name = "activity before remount";
              const before = await waitFor(
                async () => readActivityDisclosures(panel.panelId),
                (list) => list.some((text) => /^Worked for /.test(text)),
              );
              details.activityBefore = before;
              assert.isTrue(
                before.some((text) => /^Worked for /.test(text)),
                `the finished run shows its activity; ${JSON.stringify(before)}`,
              );
              const visibleBefore = await api.getPanelVisibleMessageCount(
                panel.panelId,
              );

              step.name = "activity after remount";
              panel = await api.remountPanel(panel.panelId);
              diag = await api.getDiagnostics(panel.panelId);
              if (diag.conversationKind !== "global") {
                diag = await api.togglePanelConversationMode(panel.panelId);
              }
              assert.equal(diag.conversationKey, key, "same conversation");
              assert.equal(
                await waitFor(
                  () => api.getPanelVisibleMessageCount(panel.panelId),
                  (count) => count === visibleBefore,
                ),
                visibleBefore,
                "same messages after the remount",
              );
              const after = await waitFor(
                async () => readActivityDisclosures(panel.panelId),
                (list) => list.some((text) => /^Worked for /.test(text)),
                15_000,
              );
              details.activityAfter = after;
              assert.isTrue(
                after.some((text) => /^Worked for /.test(text)),
                `the activity survives the remount; ${JSON.stringify(after)}`,
              );
            },
          );
        } catch (error) {
          assert.fail(
            `${system} failed at ${step.name}: ${describeError(error)}\n${JSON.stringify({ ...details, approved })}`,
          );
        } finally {
          await api.reset();
          for (const fixture of fixtures) await api.cleanupFixture(fixture);
          if (collection) {
            for (const note of notesInCollection(collection.id))
              await note.eraseTx().catch(() => undefined);
            await collection.eraseTx().catch(() => undefined);
          }
        }
      });
    }
  },
);
