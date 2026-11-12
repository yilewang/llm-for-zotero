/**
 * Live scenario shared by the built-in agent
 * (test-live/agent/pastChatFind.live.workflow.test.ts) and Claude Code and
 * Codex (runtimePastChat.live.workflow.test.ts): the agent finds an earlier
 * chat from plain words with past_chat_search and adds it with
 * past_chat_attach. It costs API usage: run it only when asked.
 *
 * One library chat of the system under test holds three seeded past chats:
 * A (a fact found nowhere else, about the "Quokka rig"), and B and C (both
 * about the "zebrafish tectum"). Each case runs in a new conversation of the
 * panel, through the panel's own send, so the attach reaches the stored user
 * row through the real panel handler.
 *
 *   clear:   one chat matches. The agent attaches it without asking; the
 *            answer holds A's fact; the stored user row holds a via "agent"
 *            reference to A; no question card appeared.
 *   several: two chats match. The agent asks the user to pick (a question
 *            card, which this test denies, or a question in the text) and
 *            attaches nothing.
 *   none:    no chat matches. Nothing is attached and the answer points to
 *            "Add past conversation".
 *
 * n = 1 per case and system; exploratory.
 */
import { assert } from "chai";
import type { LiveAgentCredentials } from "../agent/liveAgentCredentials";
import {
  LIVE_MODEL_ENTRY_ID,
  MESSAGE_TABLES,
  describeError,
  liveRuntimePrefs,
  panelElement,
  shortSystemName,
  switchPanelToLibraryChat,
  withPrefs,
  workflowApi,
  type LiveSystem,
} from "./runtimeLiveShared";

declare const Zotero: any;

export type PastChatFindCase = "clear" | "several" | "none";

const CLEAR_FACT = "Marmalade-Kestrel";
// Worded like the user's own request ("... Add that chat here."): a question
// that only asks for a fact can be answered from the search snippet alone,
// with no attach.
const CLEAR_QUESTION =
  "I asked about the Quokka rig calibration in an earlier chat. Add that chat here, then tell me what name we gave that calibration. Answer in one sentence.";
const SEVERAL_QUESTION =
  "I asked about the zebrafish tectum in an earlier chat. Add that chat here and tell me what we decided there.";
const NONE_QUESTION =
  "I asked about axolotl limb regeneration in an earlier chat. Add that chat here and tell me what we concluded there.";

const QUESTIONS: Record<PastChatFindCase, string> = {
  clear: CLEAR_QUESTION,
  several: SEVERAL_QUESTION,
  none: NONE_QUESTION,
};

export type PastChatFindTurn = {
  system: LiveSystem;
  case: PastChatFindCase;
  conversationKey: number;
  answerText: string;
  elapsedMs: number;
  deniedCards: string[];
  storedRefs: Array<Record<string, unknown>>;
  runEvents: FindEvent[];
  error?: string;
};

/**
 * One run-journal event that names a past-chat tool or request_user_input.
 * `tool` is the tool of a tool_call or tool_result event; `match` is the
 * label a past_chat_search result gave.
 */
type FindEvent = {
  type: string;
  tool?: string;
  match?: string;
  text: string;
};

/** The label a past_chat_search result gives in its content. */
const MATCH_LABEL_PATTERN = /\\?"match\\?"\s*:\s*\\?"(clear|several|none)/;

/**
 * Denies every confirmation or question card that appears in the panel until
 * `until` settles, and records the card text. The built-in agent's
 * request_user_input and an MCP host question both show as such a card.
 */
async function denyCardsUntil<T>(
  panelId: string,
  until: Promise<T>,
  denied: string[],
): Promise<T> {
  let settled = false;
  const watched = until.finally(() => {
    settled = true;
  });
  const seen = new Set<string>();
  while (!settled) {
    let body: HTMLElement | null = null;
    try {
      body = panelElement(panelId);
    } catch {
      body = null;
    }
    const cards = Array.from(
      body?.querySelectorAll(".llm-agent-hitl-card[data-request-id]") || [],
    ) as HTMLElement[];
    for (const card of cards) {
      const requestId = card.dataset.requestId || "";
      if (!requestId || seen.has(requestId)) continue;
      // Confirmation cards mark cancel with data-kind; the question card
      // (request_user_input) uses its own class.
      const cancel = card.querySelector(
        'button[data-kind="cancel"], button.llm-planning-question-cancel',
      ) as HTMLButtonElement | null;
      if (!cancel || cancel.disabled) continue;
      seen.add(requestId);
      denied.push((card.textContent || "").replace(/\s+/g, " ").slice(0, 300));
      cancel.click();
    }
    await Promise.race([
      watched.catch(() => undefined),
      Zotero.Promise.delay(250),
    ]);
  }
  return watched;
}

/** The attached-chat references of the conversation's latest user row. */
async function readLatestUserRefs(
  system: LiveSystem,
  conversationKey: number,
): Promise<Array<Record<string, unknown>>> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT attached_conversations_json AS refs
       FROM ${MESSAGE_TABLES[system]}
      WHERE conversation_key = ? AND role = 'user'
      ORDER BY timestamp DESC, id DESC
      LIMIT 1`,
    [conversationKey],
  )) as any[];
  const raw = rows?.[0]?.refs;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Run-journal events of the conversation that name a past-chat tool. Only the
 * built-in agent writes the run journal; Codex and Claude Code give none.
 */
async function readFindEvents(conversationKey: number): Promise<FindEvent[]> {
  try {
    const rows = (await Zotero.DB.queryAsync(
      `SELECT e.event_type AS type, e.payload_json AS payload
         FROM llm_for_zotero_agent_run_events e
         JOIN llm_for_zotero_agent_runs r ON r.run_id = e.run_id
        WHERE r.conversation_key = ?
          AND (e.payload_json LIKE ? OR e.payload_json LIKE ?)
        ORDER BY e.id`,
      [conversationKey, "%past_chat_%", "%request_user_input%"],
    )) as any[];
    return (rows || []).map((row) => {
      const payloadText = String(row.payload || "");
      let tool: string | undefined;
      try {
        const payload = JSON.parse(payloadText);
        if (typeof payload?.name === "string") tool = payload.name;
      } catch {
        tool = undefined;
      }
      const match =
        tool === "past_chat_search" && row.type === "tool_result"
          ? MATCH_LABEL_PATTERN.exec(payloadText)?.[1]
          : undefined;
      return {
        type: String(row.type || ""),
        ...(tool ? { tool } : {}),
        ...(match ? { match } : {}),
        text: payloadText.slice(0, 2000),
      };
    });
  } catch (error) {
    return [{ type: "query_error", text: describeError(error) }];
  }
}

/**
 * Seeds the three past chats, runs the given cases, and asserts each one.
 * Every turn is pushed to `turns` (for the report) before its assertions.
 */
export async function runPastChatFindCases(params: {
  system: LiveSystem;
  credentials: LiveAgentCredentials;
  cases: readonly PastChatFindCase[];
  turns: PastChatFindTurn[];
  /** Extra prefs, such as lastUsedRuntimeMode "agent" for the built-in agent. */
  prefs?: Record<string, unknown>;
}): Promise<void> {
  const { system, credentials } = params;
  const api = workflowApi();
  await api.reset();
  let fixture: Awaited<
    ReturnType<typeof api.createPaperWithPdfFixture>
  > | null = null;
  const keys: number[] = [];
  try {
    await withPrefs(
      liveRuntimePrefs(system, credentials, params.prefs),
      async () => {
        fixture = await api.createPaperWithPdfFixture({
          title: `Live past chat find ${system}`,
          pdfTitle: `live-pastchat-find-${system}.pdf`,
          pages: [
            "This synthetic page exists only so the panel has a paper to open.",
          ],
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await switchPanelToLibraryChat(panel.panelId);
        const tag = `PASTFIND-${shortSystemName(system)}`;

        async function seed(
          label: string,
          question: string,
          answer: string,
        ): Promise<number> {
          // The first seed fills the empty chat the panel opened with; a new
          // chat from an empty one changes no key and times out.
          if (keys.length)
            await api.startNewPanelConversation(panel.panelId, {
              allowReusedDraft: true,
            });
          await api.seedPanelStoredUserMessage(
            panel.panelId,
            `${tag}-${label} ${question}`,
          );
          await api.seedPanelStoredTurn(panel.panelId, question, answer);
          const key = Number(
            (await api.getDiagnostics(panel.panelId)).conversationKey,
          );
          assert.isAbove(key, 0, `seeded chat ${label} has a key`);
          keys.push(key);
          return key;
        }

        try {
          const clearKey = await seed(
            "A",
            "What name did we give the Quokka rig calibration?",
            `We named the Quokka rig calibration ${CLEAR_FACT}.`,
          );
          await seed(
            "B",
            "What did we decide about imaging the zebrafish tectum?",
            "We decided to image the zebrafish tectum at 4 dpf with light-sheet microscopy.",
          );
          await seed(
            "C",
            "What did we decide about ablating the zebrafish tectum?",
            "We decided to ablate the zebrafish tectum with a two-photon laser.",
          );

          for (const findCase of params.cases) {
            await api.startNewPanelConversation(panel.panelId, {
              allowReusedDraft: true,
            });
            if (system === "upstream") {
              // The built-in agent needs the live model entry and Agent mode;
              // plain chat has no tools (see agentLibraryLag).
              await api.selectPanelModelEntry(
                panel.panelId,
                LIVE_MODEL_ENTRY_ID,
              );
              const diag = await api.getDiagnostics(panel.panelId);
              // The built-in runtime is Agent whenever the Agent feature is on.
              assert.equal(diag.runtimeMode, "agent", "Agent mode is on");
            }
            const deniedCards: string[] = [];
            const started = Date.now();
            const record: PastChatFindTurn = {
              system,
              case: findCase,
              conversationKey: 0,
              answerText: "",
              elapsedMs: 0,
              deniedCards,
              storedRefs: [],
              runEvents: [],
            };
            params.turns.push(record);
            try {
              const result = await denyCardsUntil(
                panel.panelId,
                api.sendLiveChatTurn(
                  panel.panelId,
                  QUESTIONS[findCase],
                  300_000,
                ),
                deniedCards,
              );
              record.answerText = result.answerText;
            } catch (error) {
              record.error = describeError(error);
              throw error;
            } finally {
              record.elapsedMs = Date.now() - started;
              record.conversationKey = Number(
                (await api.getDiagnostics(panel.panelId)).conversationKey,
              );
              if (record.conversationKey > 0) {
                keys.push(record.conversationKey);
                record.storedRefs = await readLatestUserRefs(
                  system,
                  record.conversationKey,
                );
                record.runEvents = await readFindEvents(record.conversationKey);
              }
            }

            const agentRefs = record.storedRefs.filter(
              (ref) => ref.via === "agent",
            );
            // The built-in agent's tool calls are in the run journal: the
            // search must have run and given the case's label. Codex and
            // Claude Code write no journal, so only the text and the stored
            // row are checked for them.
            if (system === "upstream") {
              const labels = record.runEvents
                .filter((event) => event.match)
                .map((event) => event.match);
              assert.include(
                labels,
                findCase,
                `${findCase}: past_chat_search ran and gave "${findCase}": ${JSON.stringify(record.runEvents)}`,
              );
              const attachCalls = record.runEvents.filter(
                (event) =>
                  event.type === "tool_call" &&
                  event.tool === "past_chat_attach",
              );
              if (findCase === "clear") {
                assert.isAbove(
                  attachCalls.length,
                  0,
                  `clear: past_chat_attach ran: ${JSON.stringify(record.runEvents)}`,
                );
              } else {
                assert.deepEqual(
                  attachCalls,
                  [],
                  `${findCase}: past_chat_attach did not run`,
                );
              }
            }
            if (findCase === "clear") {
              assert.include(
                record.answerText.toLowerCase(),
                CLEAR_FACT.toLowerCase(),
                `clear: the answer states the fact from chat A: ${JSON.stringify(record)}`,
              );
              assert.isTrue(
                agentRefs.some(
                  (ref) => Number(ref.conversationKey) === clearKey,
                ),
                `clear: the stored user row holds a via "agent" reference to chat A: ${JSON.stringify(record.storedRefs)}`,
              );
              assert.deepEqual(
                deniedCards,
                [],
                "clear: the agent attaches without asking",
              );
            } else if (findCase === "several") {
              assert.deepEqual(
                agentRefs,
                [],
                `several: nothing is attached before the user picks: ${JSON.stringify(record.storedRefs)}`,
              );
              assert.isTrue(
                deniedCards.length > 0 || /\?/.test(record.answerText),
                `several: the agent asks the user to pick: ${JSON.stringify(record)}`,
              );
              // The question offers both matching chats: B (imaging) and C
              // (ablating), in the answer or in the question card.
              const offered = [record.answerText, ...deniedCards].join("\n");
              assert.match(
                offered,
                /imag/i,
                `several: the agent names chat B (imaging): ${JSON.stringify(record)}`,
              );
              assert.match(
                offered,
                /ablat/i,
                `several: the agent names chat C (ablating): ${JSON.stringify(record)}`,
              );
            } else {
              assert.deepEqual(
                agentRefs,
                [],
                `none: nothing is attached: ${JSON.stringify(record.storedRefs)}`,
              );
              assert.match(
                record.answerText,
                /add past conversation/i,
                `none: the answer points to Add past conversation: ${JSON.stringify(record.answerText)}`,
              );
            }
          }
        } finally {
          // Deleted through the plugin even after a failure: the Claude Code
          // bridge keeps a session per conversation, and a reset database
          // hands the next run the same keys.
          await api.startNewPanelConversation(panel.panelId, {
            allowReusedDraft: true,
          });
          for (const key of new Set(keys)) {
            await api
              .deletePanelHistoryConversation(panel.panelId, key)
              .catch(() => undefined);
          }
          await api.sweepPendingDeletionsAsRestart();
        }
      },
    );
  } finally {
    await api.reset();
    if (fixture) await api.cleanupFixture(fixture);
  }
}
