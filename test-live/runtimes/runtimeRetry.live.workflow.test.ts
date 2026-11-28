/**
 * Live R4: re-sending a turn on each external runtime, through the panel's
 * own buttons, against the installed Claude Code, Codex and agy.
 *
 * A re-send is the Retry button when the answer has one (a chat-mode turn),
 * otherwise Edit on the latest question and Send with the same words (an
 * agent turn: Claude Code and Antigravity). Both detach the runtime's
 * session first (runtimeSessionReset.ts), so the re-sent turn runs in a
 * session that never saw the answer it replaces, and gets the chat's
 * earlier messages as fresh-session history (runtimeHistory.ts).
 *
 *   (a) retry: turn 1 gives a code word; turn 2 asks for a random number,
 *       or DUPLICATE if the conversation already holds an answer to that
 *       request. The re-sent turn 2 must answer with a number (it must not
 *       see the answer it replaces), and turn 3 must still recall the code
 *       word (the earlier turn reached the fresh session).
 *   (b) local PDF: the paper chip is switched to "PDF file", turn 1 asks for
 *       a phrase printed only in the PDF, and the re-sent turn must answer
 *       with it again (the retry sends the PDF file as the first send did).
 *       The Zotero MCP tools are turned off for this case, so the file the
 *       turn carries is the only way to the phrase.
 *
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/runtimes \
 *   LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS=retry \
 *   LLM_FOR_ZOTERO_LIVE_CODEX_PATH=<codex binary> \
 *   node scripts/run-workflow-tests.mjs --agent-live
 *
 * Optional: LLM_FOR_ZOTERO_LIVE_RETRY_SYSTEMS=codex,antigravity (a subset of
 * claude_code, codex, antigravity), LLM_FOR_ZOTERO_LIVE_CODEX_MODEL,
 * LLM_FOR_ZOTERO_LIVE_CLAUDE_MODEL.
 */
import { assert } from "chai";
import {
  describeError,
  ensureOwnZoteroHttpServer,
  env,
  randomTag,
  withPrefs,
  workflowApi,
} from "./runtimeLiveShared";
import {
  choosePdfFileSource,
  resendLatestTurn,
  sendTurn,
} from "../../test/helpers/panelTurnActions";

declare const Zotero: any;

type RetrySystem = "claude_code" | "codex" | "antigravity";
const RETRY_SYSTEMS: readonly RetrySystem[] = [
  "claude_code",
  "codex",
  "antigravity",
];

const selectedTests = env("LLM_FOR_ZOTERO_LIVE_RUNTIME_TESTS");
const enabled = !selectedTests || selectedTests.split(",").includes("retry");

function retrySystems(): RetrySystem[] {
  const requested = env("LLM_FOR_ZOTERO_LIVE_RETRY_SYSTEMS")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return requested.length
    ? RETRY_SYSTEMS.filter((system) => requested.includes(system))
    : [...RETRY_SYSTEMS];
}

function runtimePrefs(
  system: RetrySystem,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const codexPath = env("LLM_FOR_ZOTERO_LIVE_CODEX_PATH");
  const codexModel = env("LLM_FOR_ZOTERO_LIVE_CODEX_MODEL");
  const claudeModel = env("LLM_FOR_ZOTERO_LIVE_CLAUDE_MODEL");
  return {
    conversationSystem: system,
    enableClaudeCodeMode: true,
    enableCodexAppServerMode: true,
    enableAntigravityMode: true,
    lastUsedRuntimeMode: "chat",
    ...(codexPath ? { codexAppServerPath: codexPath } : {}),
    ...(codexModel ? { codexAppServerModel: codexModel } : {}),
    codexAppServerReasoning:
      env("LLM_FOR_ZOTERO_LIVE_CODEX_REASONING") || "low",
    ...(claudeModel ? { claudeCodeModel: claudeModel } : {}),
    ...extra,
  };
}

const TURN_TIMEOUT_MS = 300_000;

/**
 * Deletes the panel's conversation through the plugin. Each run starts on a
 * reset database, so the next run gets the same conversation key; the Claude
 * Code bridge outlives Zotero and would resume this run's session for it.
 * Deleting the conversation drops that session (as in live R1).
 */
async function deletePanelConversation(panelId: string): Promise<void> {
  const api = workflowApi();
  const key = Number((await api.getDiagnostics(panelId)).conversationKey);
  if (!key) return;
  await api.startNewPanelConversation(panelId);
  await api.deletePanelHistoryConversation(panelId, key);
  await api.sweepPendingDeletionsAsRestart();
}

/** The plugin's latest debug lines, for a failure report. */
async function debugTail(): Promise<string> {
  let jobs = "";
  try {
    const rows = (await Zotero.DB.queryAsync(
      "SELECT operation, provider_session_id AS session, attempts, last_error AS lastError FROM llm_for_zotero_conversation_cleanup_jobs",
    )) as any[];
    jobs = `--- cleanup jobs ---\n${(rows || [])
      .map((row) =>
        JSON.stringify({
          operation: row.operation,
          session: row.session,
          attempts: row.attempts,
          lastError: row.lastError,
        }),
      )
      .join("\n")}\n`;
  } catch (error) {
    jobs = `--- no cleanup jobs: ${String(error)}\n`;
  }
  return jobs + (await debugLines());
}

async function debugLines(): Promise<string> {
  try {
    const text = String((await Zotero.Debug.get?.()) || "");
    const lines = text
      .split("\n")
      .filter((line) =>
        /LLM|llm|codex|Codex|agy|Antigravity|Claude|bridge/.test(line),
      );
    return `--- debug tail ---\n${lines.slice(-60).join("\n").slice(-12_000)}`;
  } catch (error) {
    return `--- no debug output: ${String(error)}`;
  }
}

describe("live R4: re-sending a turn on each runtime", function () {
  this.timeout(1_200_000);

  before(async function () {
    if (!enabled) this.skip();
    await ensureOwnZoteroHttpServer();
    // Kept so a failure can show where the turn stopped.
    Zotero.Debug.setStore?.(true);
  });

  for (const system of retrySystems()) {
    it(`${system}: a re-sent turn does not see the answer it replaces and keeps the chat`, async function () {
      const api = workflowApi();
      await api.reset();
      const step = { name: "setup" };
      let panelId = "";
      const log: string[] = [];
      let fixture: Awaited<
        ReturnType<typeof api.createPaperWithPdfFixture>
      > | null = null;
      try {
        await withPrefs(runtimePrefs(system), async () => {
          fixture = await api.createPaperWithPdfFixture({
            title: `Live retry ${system}`,
            pages: ["A synthetic page so the panel has a paper to open."],
          });
          const panel = await api.renderPanelForItem(fixture.parentItemId);
          panelId = panel.panelId;
          const diag = await api.getDiagnostics(panel.panelId);
          assert.equal(diag.conversationSystem, system, "panel system");

          const codeWord = `CW-${randomTag().toUpperCase()}`;
          step.name = "turn 1";
          const first = await sendTurn(
            panel.panelId,
            `Remember the code word ${codeWord} for later. Reply with only OK. Do not use any tools.`,
            TURN_TIMEOUT_MS,
          );
          log.push(`turn 1: ${first.text}`);

          const numberQuestion = `Request ${randomTag()}: reply with one random whole number between 1 and 1000000 and nothing else. If this conversation already contains an earlier answer of yours to this exact request, reply with only the word DUPLICATE instead. Do not use any tools.`;
          step.name = "turn 2";
          const second = await sendTurn(
            panel.panelId,
            numberQuestion,
            TURN_TIMEOUT_MS,
          );
          log.push(`turn 2: ${second.text}`);
          assert.match(second.text, /\d/, "turn 2 answers with a number");

          step.name = "re-send turn 2";
          const resent = await resendLatestTurn(
            panel.panelId,
            numberQuestion,
            TURN_TIMEOUT_MS,
          );
          log.push(`re-sent turn 2 (${resent.path}): ${resent.text}`);
          assert.notMatch(
            resent.text,
            /DUPLICATE/i,
            "the re-sent turn must not see the answer it replaces",
          );
          assert.match(resent.text, /\d/, "the re-sent turn answers a number");

          step.name = "turn 3";
          const third = await sendTurn(
            panel.panelId,
            "What code word did I ask you to remember? Reply with the code word only. Do not use any tools.",
            TURN_TIMEOUT_MS,
          );
          log.push(`turn 3: ${third.text}`);
          assert.include(
            third.text,
            codeWord,
            "the fresh session still has the earlier turn",
          );
        });
      } catch (error) {
        assert.fail(
          `${system} failed at ${step.name}: ${describeError(error)}\n${log.join("\n")}\n${await debugTail()}`,
        );
      } finally {
        if (panelId) {
          await withPrefs(runtimePrefs(system), () =>
            deletePanelConversation(panelId),
          ).catch(() => undefined); // cleanup only; a failure is reported
        }
        await api.reset();
        if (fixture) await api.cleanupFixture(fixture);
      }
      Zotero.debug(`[live R4 retry ${system}]\n${log.join("\n")}`);
    });

    it(`${system}: a re-sent turn still carries the local PDF file`, async function () {
      const api = workflowApi();
      await api.reset();
      const step = { name: "setup" };
      let panelId = "";
      const log: string[] = [];
      let fixture: Awaited<
        ReturnType<typeof api.createPaperWithPdfFixture>
      > | null = null;
      const phrase = `PDF-${randomTag().toUpperCase()}-${randomTag().toUpperCase()}`;
      try {
        await withPrefs(
          runtimePrefs(system, { codexAppServerZoteroMcpToolsEnabled: false }),
          async () => {
            fixture = await api.createPaperWithPdfFixture({
              title: `Live PDF retry ${system}`,
              pages: [
                `This synthetic page holds a verification phrase. The verification phrase is ${phrase}.`,
              ],
            });
            const panel = await api.renderPanelForItem(fixture.parentItemId);
            panelId = panel.panelId;
            step.name = "choose the PDF file source";
            await choosePdfFileSource(panel.panelId);

            const question =
              "What is the verification phrase printed in the attached PDF file? Read the file and reply with the phrase only.";
            step.name = "turn 1";
            const first = await sendTurn(
              panel.panelId,
              question,
              TURN_TIMEOUT_MS,
            );
            log.push(`turn 1: ${first.text}`);
            assert.include(first.text, phrase, "turn 1 reads the PDF");

            step.name = "re-send turn 1";
            const resent = await resendLatestTurn(
              panel.panelId,
              question,
              TURN_TIMEOUT_MS,
            );
            log.push(`re-sent turn 1 (${resent.path}): ${resent.text}`);
            assert.include(
              resent.text,
              phrase,
              "the re-sent turn still reads the PDF",
            );
          },
        );
      } catch (error) {
        assert.fail(
          `${system} failed at ${step.name}: ${describeError(error)}\n${log.join("\n")}\n${await debugTail()}`,
        );
      } finally {
        if (panelId) {
          await withPrefs(runtimePrefs(system), () =>
            deletePanelConversation(panelId),
          ).catch(() => undefined); // cleanup only; a failure is reported
        }
        await api.reset();
        if (fixture) await api.cleanupFixture(fixture);
      }
      Zotero.debug(`[live R4 pdf ${system}]\n${log.join("\n")}`);
    });
  }
});
