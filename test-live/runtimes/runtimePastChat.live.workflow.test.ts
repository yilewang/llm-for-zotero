/**
 * Live R3: Claude Code and Codex read an attached past chat, and
 * past_chat_read refuses a chat that was not attached.
 *
 * For each system (claude_code, codex) the library chat of that system holds
 * one short past chat with a fact found nowhere else. A new conversation
 * attaches it through the real "/" picker.
 *
 *   (a) The first turn asks what the earlier chat said; the answer must
 *       contain the fact. The runtime gets the past-chat block with the turn.
 *   (b) The next turn (no new chip) asks the runtime to call past_chat_read
 *       with a chat id that was never attached. The answer must not contain
 *       the fact and must quote the tool's "not attached" refusal. If the run
 *       journal holds a past_chat_read result, it must contain "was not
 *       attached in this conversation".
 *
 * The upstream system is skipped: the built-in agent has its own test
 * (test-live/agent/pastChatDelivery.live.workflow.test.ts).
 *
 * A second test per system ("pastchatfind" in
 * LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS) checks that the runtime finds an
 * earlier chat from plain words over the Zotero MCP bridge
 * (past_chat_search, then past_chat_attach): a clear match is attached
 * without a question, and between several matches it asks and attaches
 * nothing (pastChatFindLive.ts). Its report is
 * <data dir>/runtime-past-chat-find-live-report.json. Claude Code's allowed
 * tools leave out request_user_input, so its question is expected in the
 * text.
 *
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/runtimes \
 *   LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS=pastchat \
 *   LLM_FOR_ZOTERO_LIVE_RUNTIME_SYSTEMS=codex,claude_code \
 *   LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-flash \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js with that model> \
 *   LLM_FOR_ZOTERO_LIVE_CODEX_PATH=<codex binary> \
 *   ZOTERO_PLUGIN_KILL_COMMAND='pkill -9 -f "<worktree>/.scaffold/test/profile" || true' \
 *   node scripts/run-workflow-tests.mjs --agent-live
 *
 * The report is written to <data dir>/runtime-past-chat-live-report.json.
 */
import { assert } from "chai";
import { resolveLiveAgentCredentials } from "../agent/liveAgentCredentials";
import {
  runPastChatFindCases,
  type PastChatFindTurn,
} from "./pastChatFindLive";
import {
  describeError,
  ensureOwnZoteroHttpServer,
  env,
  liveRuntimePrefs,
  selectedSystems,
  shortSystemName,
  switchPanelToLibraryChat,
  withPrefs,
  workflowApi,
  type LiveSystem,
} from "./runtimeLiveShared";

declare const Zotero: any;

const selectedTests = env("LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS");
const enabled = !selectedTests || selectedTests.split(",").includes("pastchat");
const findEnabled =
  !selectedTests || selectedTests.split(",").includes("pastchatfind");
const FIND_REPORT_NAME = "runtime-past-chat-find-live-report.json";
const findTurns: PastChatFindTurn[] = [];

const SHORT_FACT = "Biscuit-Tamarind";
const SHORT_QUESTION =
  "In the earlier chat I attached, what did we say the rat in Dr. Okonkwo-Lindqvist's lab was called? Answer in one sentence.";
const FAKE_CHAT_ID = "upstream:987654321";
const REFUSAL_TEXT = "was not attached in this conversation";
const REFUSED_QUESTION = `Call the past_chat_read tool with chat "${FAKE_CHAT_ID}" and tell me the first question the user asked in that chat. If the tool returns an error, quote its error message word for word and do not guess.`;
// The quoted refusal proves the call reached the Zotero MCP tool and was
// refused there; a bare "cannot" would also match a missing tool.
const REFUSAL_QUOTE = /not attached/i;
const REPORT_NAME = "runtime-past-chat-live-report.json";
// One report for all systems of the run.
const reportEntries: Array<{
  system: LiveSystem;
  notes: string[];
  turns: unknown[];
}> = [];

type TurnRecord = {
  system: LiveSystem;
  label: string;
  userText: string;
  answerText: string;
  elapsedMs: number;
  disclosures: string[];
  runEvents: Array<{ type: string; text: string }>;
};

/**
 * Run-journal events of the conversation that mention past_chat_read. This is
 * the only tool-call view the workflow API gives for Claude Code and Codex
 * turns; it is best effort and may be empty.
 */
async function readPastChatEvents(
  conversationKey: number,
): Promise<Array<{ type: string; text: string }>> {
  try {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT e.event_type AS type, e.payload_json AS payload
         FROM llm_for_zotero_agent_run_events e
         JOIN llm_for_zotero_agent_runs r ON r.run_id = e.run_id
        WHERE r.conversation_key = ? AND e.payload_json LIKE ?
        ORDER BY e.id`,
      // Zotero's Sqlite wrapper refuses LIKE patterns written inline.
      [conversationKey, "%past_chat_read%"],
    )) as any[];
    return (rows || []).map((row) => ({
      type: String(row.type || ""),
      text: String(row.payload || "").slice(0, 2000),
    }));
  } catch (error) {
    return [{ type: "query_error", text: describeError(error) }];
  }
}

function panelDisclosures(panelId: string): string[] {
  try {
    const docs = [
      Zotero.getMainWindow?.()?.document,
      (globalThis as { document?: Document }).document,
    ].filter(Boolean) as Document[];
    for (const doc of docs) {
      const body = doc.querySelector(
        `[data-workflow-panel-id="${panelId}"]`,
      ) as HTMLElement | null;
      if (!body) continue;
      return (
        Array.from(
          body.querySelectorAll(".llm-agent-activity-details > summary"),
        ) as HTMLElement[]
      ).map((summary) => (summary.textContent || "").trim());
    }
  } catch {
    // diagnostics only
  }
  return [];
}

(enabled ? describe : describe.skip)(
  "live R3: attached past chats in Claude Code and Codex",
  function () {
    this.timeout(900_000);

    // Codex and Claude Code call this instance's MCP endpoint over HTTP.
    before(async function () {
      await ensureOwnZoteroHttpServer();
    });

    const systems = selectedSystems().filter(
      (system) => system === "claude_code" || system === "codex",
    );

    for (const system of systems) {
      it(`${system} library: answers from an attached past chat and refuses a chat that was not attached`, async function () {
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
        const turns: TurnRecord[] = [];
        const notes: string[] = [];
        const step = { name: "setup" };
        // The Claude Code bridge keeps a conversation's session hot, and a
        // reset DB hands the next run the same conversation key. A run that
        // fails before its delete step must delete the conversation through
        // the plugin, which also invalidates the bridge session.
        const leftover: { keys: number[]; deleted: boolean } = {
          keys: [],
          deleted: false,
        };
        try {
          await withPrefs(liveRuntimePrefs(system, credentials!), async () => {
            fixture = await api.createPaperWithPdfFixture({
              title: `Live runtime past chat ${system}`,
              pdfTitle: `live-runtime-pastchat-${system}.pdf`,
              pages: [
                "This synthetic page exists only so the panel has a paper to open.",
              ],
            });
            const panel = await api.renderPanelForItem(fixture.parentItemId);
            let diag = await api.getDiagnostics(panel.panelId);
            assert.equal(diag.conversationSystem, system, "panel system");
            diag = await switchPanelToLibraryChat(panel.panelId);
            assert.equal(diag.conversationKind, "global", "panel kind");

            step.name = "seed past chat";
            const tag = `PASTCHAT-${shortSystemName(system)}`;
            await api.seedPanelStoredUserMessage(
              panel.panelId,
              `${tag} lab animals in Dr. Okonkwo-Lindqvist's lab`,
            );
            await api.seedPanelStoredTurn(
              panel.panelId,
              "What was the rat in Dr. Okonkwo-Lindqvist's lab called?",
              `The rat in Dr. Okonkwo-Lindqvist's lab was named ${SHORT_FACT}.`,
            );
            const seededKey = Number(
              (await api.getDiagnostics(panel.panelId)).conversationKey,
            );
            assert.isAbove(seededKey, 0, "the seeded chat has a key");
            leftover.keys.push(seededKey);

            step.name = "attach";
            await api.startNewPanelConversation(panel.panelId);
            const picked = await api.pickPastConversationInPanel(
              panel.panelId,
              { title: tag },
            );
            assert.isTrue(picked.picked, JSON.stringify(picked));

            async function turn(
              label: string,
              userText: string,
            ): Promise<TurnRecord> {
              const started = Date.now();
              const result = await api.sendLiveChatTurn(
                panel.panelId,
                userText,
                300_000,
              );
              const elapsedMs = Date.now() - started;
              const key = Number(
                (await api.getDiagnostics(panel.panelId)).conversationKey,
              );
              if (key > 0 && !leftover.keys.includes(key)) {
                leftover.keys.push(key);
              }
              const record: TurnRecord = {
                system,
                label,
                userText,
                answerText: result.answerText,
                elapsedMs,
                disclosures: panelDisclosures(panel.panelId),
                runEvents: await readPastChatEvents(key),
              };
              turns.push(record);
              return record;
            }

            step.name = "turn a: attached chat";
            const first = await turn("a-attached", SHORT_QUESTION);
            assert.include(
              first.answerText.toLowerCase(),
              SHORT_FACT.toLowerCase(),
              `the answer states the fact from the attached chat: ${JSON.stringify(first)}`,
            );

            step.name = "turn b: chat that was not attached";
            const second = await turn("b-not-attached", REFUSED_QUESTION);
            assert.notInclude(
              second.answerText.toLowerCase(),
              SHORT_FACT.toLowerCase(),
              "the answer must not borrow another chat's content",
            );
            assert.match(
              second.answerText,
              REFUSAL_QUOTE,
              `the answer quotes the tool's refusal: ${JSON.stringify(second.answerText)}`,
            );
            // Tool-call visibility: the run journal, when the runtime writes
            // one for this turn. Without it the text assertion decides.
            const journal = second.runEvents.filter(
              (event) => event.type !== "query_error",
            );
            if (journal.length) {
              assert.isTrue(
                journal.some((event) => event.text.includes(REFUSAL_TEXT)),
                `a past_chat_read result must say "${REFUSAL_TEXT}": ${JSON.stringify(journal)}`,
              );
            } else {
              notes.push(
                "No past_chat_read event in the run journal for turn b; only the answer text was asserted.",
              );
            }

            step.name = "delete";
            const turnKey = Number(
              (await api.getDiagnostics(panel.panelId)).conversationKey,
            );
            await api.startNewPanelConversation(panel.panelId);
            for (const key of new Set([turnKey, ...leftover.keys])) {
              if (key > 0) {
                await api.deletePanelHistoryConversation(panel.panelId, key);
              }
            }
            await api.sweepPendingDeletionsAsRestart();
            leftover.deleted = true;
          });
        } catch (error) {
          assert.fail(
            `${system} failed at ${step.name}: ${describeError(error)}`,
          );
        } finally {
          if (leftover.keys.length && !leftover.deleted && fixture) {
            const paperItemId = (fixture as { parentItemId: number })
              .parentItemId;
            await withPrefs(
              liveRuntimePrefs(system, credentials!),
              async () => {
                const panel = await api.renderPanelForItem(paperItemId);
                await switchPanelToLibraryChat(panel.panelId);
                await api.startNewPanelConversation(panel.panelId);
                for (const key of leftover.keys) {
                  await api
                    .deletePanelHistoryConversation(panel.panelId, key)
                    .catch(() => undefined);
                }
                await api.sweepPendingDeletionsAsRestart();
              },
            ).catch(() => undefined); // cleanup only; the failure is reported
          }
          reportEntries.push({ system, notes, turns });
          await Zotero.File.putContentsAsync(
            `${Zotero.DataDirectory.dir}/${REPORT_NAME}`,
            JSON.stringify({ systems: reportEntries }, null, 2),
          ).catch(() => undefined);
          await api.reset();
          if (fixture) await api.cleanupFixture(fixture);
        }
      });
    }
  },
);

(findEnabled ? describe : describe.skip)(
  "live: Claude Code and Codex find and add an earlier chat",
  function () {
    this.timeout(900_000);

    const systems = selectedSystems().filter(
      (system) => system === "claude_code" || system === "codex",
    );

    for (const system of systems) {
      it(`${system}: attaches a clear match without asking and asks between several`, async function () {
        // Codex and Claude Code call this instance's MCP endpoint over HTTP.
        await ensureOwnZoteroHttpServer();
        const credentials = await resolveLiveAgentCredentials();
        assert.isOk(
          credentials,
          "Configure LLM_FOR_ZOTERO_LIVE_MODEL in LLM_FOR_ZOTERO_LIVE_PROFILE_PATH; this test must not skip",
        );
        try {
          await runPastChatFindCases({
            system,
            credentials: credentials!,
            cases: ["clear", "several"],
            turns: findTurns,
          });
        } finally {
          await Zotero.File.putContentsAsync(
            `${Zotero.DataDirectory.dir}/${FIND_REPORT_NAME}`,
            JSON.stringify({ turns: findTurns }, null, 2),
          ).catch(() => undefined);
        }
      });
    }
  },
);
