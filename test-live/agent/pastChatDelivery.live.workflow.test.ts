import { assert } from "chai";
import {
  liveModelName,
  resolveLiveAgentCredentials,
} from "./liveAgentCredentials";
import type { WorkflowTestApi } from "../../src/modules/contextPanel/workflowTestTypes";
import type { AttachedConversationRef } from "../../src/shared/types";

declare const Zotero: any;

/**
 * Live check of attached past chats in the built-in agent (step 3, D4(g)).
 * It costs API usage: run it only when asked.
 *
 * (a) A short past chat goes into the turn in full: the agent answers with a
 *     fact found only there and calls no tool. Baseline: the same question
 *     without the attachment does not produce the fact.
 * (b) A long past chat (more than 8,000 tokens) goes in as an outline: the
 *     agent opens it with past_chat_read to find a fact deep inside.
 * (c) A chat id that was not attached: past_chat_read refuses, and the
 *     answer does not invent the chat's content.
 * (d) A fact in an answer whose question does not reveal it, so the outline
 *     cannot point to it: the agent finds it (with past_chat_read query or by
 *     reading). Pass is the correct fact; whether query was used and how
 *     many calls it took are recorded in the report (exploratory smoke test,
 *     n=1).
 */

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const MODEL_ENTRY_ID = "live-past-chat-model";

const SHORT_FACT = "Biscuit-Tamarind";
const SHORT_QUESTION =
  "In the earlier chat I attached, what did we say the rat in Dr. Okonkwo-Lindqvist's lab was called? Answer in one sentence.";
// A bare fact question that does not mention the earlier chat. Recorded in
// the report for comparison; it does not decide pass or fail.
const WORLD_FACT_PROBE =
  "What was the name of the rat in Dr. Okonkwo-Lindqvist's lab? Answer in one sentence. If you do not know, say so.";
const LONG_FACT = "QX-4471-PLUM";
const LONG_QUESTION =
  "In the attached past chat about rig maintenance, what calibration code was given for rig 7? Answer with the code.";
const FAKE_CHAT_ID = "upstream:987654321";
const HIDDEN_FACT = "HELIX-0932-FERN";
const HIDDEN_QUESTION =
  "In the attached past chat about rig maintenance, what was the freezer alarm reset password? Answer with the password.";

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

type TurnRecord = {
  label: string;
  userText: string;
  text: string;
  kind: string;
  calls: Array<{ name: string; args: unknown }>;
  results: Array<{ name: string; ok: boolean; content: unknown }>;
};

describe("live: attached past chats in the built-in agent", function () {
  this.timeout(900000);

  it("uses a short chat without a tool, opens a long chat with past_chat_read, and refuses a chat that was not attached", async function () {
    const credentials = await resolveLiveAgentCredentials({
      requestedModel: liveModelName("deepseek-v4-flash"),
    });
    assert.isNotNull(
      credentials,
      "Configure the requested model in the selected test profile; this test must not silently skip.",
    );
    const api = Zotero.LLMForZotero.api;
    const workflow = api.workflowTest as WorkflowTestApi;
    await workflow.reset();
    const libraryID = Zotero.Libraries.userLibraryID as number;
    const turns: TurnRecord[] = [];
    let hiddenFactReport: Record<string, unknown> | null = null;
    let fixture: Awaited<
      ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
    > | null = null;

    async function turn(
      label: string,
      request: Record<string, unknown> & {
        conversationKey: number;
        userText: string;
      },
    ): Promise<TurnRecord> {
      const record: TurnRecord = {
        label,
        userText: request.userText,
        text: "",
        kind: "",
        calls: [],
        results: [],
      };
      turns.push(record);
      const result = await api.agent.runTurn(
        {
          mode: "agent",
          libraryID,
          conversationKind: "global",
          ...credentials,
          ...request,
        },
        (event: any) => {
          if (event.type === "tool_call")
            record.calls.push({ name: event.name, args: event.args });
          if (event.type === "tool_result")
            record.results.push({
              name: event.name,
              ok: Boolean(event.ok),
              content: event.content,
            });
          if (event.type === "confirmation_required")
            void api.agent.resolveConfirmation(event.requestId, false);
        },
      );
      record.kind = String(result.kind);
      record.text = String(result.text || "");
      assert.equal(
        result.kind,
        "completed",
        JSON.stringify({ label, kind: result.kind, text: result.text }),
      );
      return record;
    }

    /** Attaches the past chat whose title contains `title`; returns its ref. */
    async function attachRef(
      panelId: string,
      title: string,
    ): Promise<AttachedConversationRef> {
      const picked = await workflow.pickPastConversationInPanel(panelId, {
        title,
      });
      assert.isTrue(picked.picked, JSON.stringify(picked));
      // The default workflow send interceptor stops the send before
      // sendQuestion and stores nothing; it returns the send options, which
      // carry the reference the real picker built.
      const sent = await workflow.ask(panelId, `attach ${title}`);
      const ref = sent.attachedConversations?.[0];
      assert.isOk(ref, JSON.stringify(sent.attachedConversations));
      return ref!;
    }

    try {
      await withPrefs(
        {
          conversationSystem: "upstream",
          enableClaudeCodeMode: false,
          enableCodexAppServerMode: false,
          modelProviderGroups: JSON.stringify([
            {
              id: "live-past-chat-provider",
              apiBase: credentials!.apiBase,
              apiKey: credentials!.apiKey,
              providerProtocol: credentials!.providerProtocol,
              models: [
                {
                  id: MODEL_ENTRY_ID,
                  model: credentials!.model,
                  temperature: 0.3,
                  maxTokens: 4096,
                },
              ],
            },
          ]),
          modelProviderGroupsMigrationVersion: 3,
          lastUsedModelEntryId: MODEL_ENTRY_ID,
        },
        async () => {
          fixture = await workflow.createPaperWithPdfFixture({
            title: "Live past chat host paper",
            pdfTitle: "Live past chat host PDF",
            pages: [
              "This synthetic page exists only so the panel has a paper to open.",
            ],
          });
          const panel = await workflow.renderPanelForItem(fixture.parentItemId);

          // Past chat 1, short: one fact found nowhere else.
          await workflow.seedPanelStoredUserMessage(
            panel.panelId,
            "PASTSHORT lab animals in Dr. Okonkwo-Lindqvist's lab",
          );
          await workflow.seedPanelStoredTurn(
            panel.panelId,
            "What was the rat in Dr. Okonkwo-Lindqvist's lab called?",
            `The rat in Dr. Okonkwo-Lindqvist's lab was named ${SHORT_FACT}.`,
          );

          // Past chat 2, long: about 14 turns of 3,200 characters (more than
          // 8,000 tokens), with the fact in the middle.
          await workflow.startNewPanelConversation(panel.panelId);
          await workflow.seedPanelStoredUserMessage(
            panel.panelId,
            "PASTLONG rig maintenance log",
          );
          const filler =
            "The rig was cleaned, the perfusion lines were flushed, the camera focus was checked, and the stage was levelled. ".repeat(
              28,
            );
          for (let index = 1; index <= 14; index += 1) {
            await workflow.seedPanelStoredTurn(
              panel.panelId,
              `Maintenance question ${index}: what happened on rig ${index}?`,
              index === 7
                ? `${filler} The calibration code for rig 7 is ${LONG_FACT}. ${filler}`
                : index === 11
                  ? // The question does not name the fact: only a search or
                    // a read of this answer finds it.
                    `${filler} Rig 11 needed no calibration. While we were there, the freezer alarm reset password was changed to ${HIDDEN_FACT}. ${filler}`
                  : `${filler} Rig ${index} needed no calibration.`,
            );
          }

          // The current chat, where the chips are attached.
          await workflow.startNewPanelConversation(panel.panelId);
          const shortRef = await attachRef(panel.panelId, "PASTSHORT");
          const longRef = await attachRef(panel.panelId, "PASTLONG");

          // (a) Baseline: without the attachment the fact is unknown.
          const baseline = await turn("a-baseline", {
            conversationKey: 920701,
            userText: SHORT_QUESTION,
          });
          assert.notInclude(
            baseline.text.toLowerCase(),
            SHORT_FACT.toLowerCase(),
            "the fact must not be guessable without the past chat",
          );

          // (a) With the short chat attached: answered from the full text.
          const short = await turn("a-short-attached", {
            conversationKey: 920702,
            userText: SHORT_QUESTION,
            attachedConversations: [shortRef],
            attachedConversationScope: [shortRef],
          });
          assert.include(
            short.text.toLowerCase(),
            SHORT_FACT.toLowerCase(),
            JSON.stringify(short),
          );
          // The fact exists only in the past chat, so the answer states it as
          // what that chat said instead of refusing or calling it unverified.
          assert.notMatch(
            short.text,
            /\bI don['’]t know\b|not supported|cannot verify|can['’]t verify|unverified/i,
            JSON.stringify(short),
          );
          assert.match(
            short.text,
            /\b(earlier|past|previous) (chat|conversation)\b/i,
            JSON.stringify(short),
          );
          assert.notInclude(
            short.calls.map((call) => call.name),
            "past_chat_read",
            "a short chat is in the turn in full; no tool call is needed",
          );

          // (b) With the long chat attached: an outline, then the tool.
          const long = await turn("b-long-attached", {
            conversationKey: 920703,
            userText: LONG_QUESTION,
            attachedConversations: [longRef],
            attachedConversationScope: [longRef],
          });
          const reads = long.calls.filter(
            (call) => call.name === "past_chat_read",
          );
          assert.isAtLeast(reads.length, 1, JSON.stringify(long.calls));
          assert.isTrue(
            reads.every(
              (call) =>
                (call.args as { chat?: unknown } | undefined)?.chat ===
                `upstream:${longRef.conversationKey}`,
            ),
            JSON.stringify(reads),
          );
          assert.include(long.text, LONG_FACT, JSON.stringify(long.text));

          // (c) A chat id that was not attached: the tool refuses it.
          const refused = await turn("c-not-attached", {
            conversationKey: 920704,
            userText: `Use past_chat_read with chat "${FAKE_CHAT_ID}" and tell me the first question the user asked in that chat. If the tool cannot open it, say so and do not guess.`,
            attachedConversationScope: [shortRef],
          });
          const refusals = refused.results.filter(
            (result) =>
              result.name === "past_chat_read" &&
              JSON.stringify(result.content).includes(
                "was not attached in this conversation",
              ),
          );
          assert.isAtLeast(
            refusals.length,
            1,
            `the tool must refuse the id: ${JSON.stringify(refused.results)}`,
          );
          assert.match(
            refused.text,
            /not attached|cannot|can't|could not|couldn't|unable|not available|no access|refus/i,
            JSON.stringify(refused.text),
          );
          assert.notInclude(
            refused.text.toLowerCase(),
            SHORT_FACT.toLowerCase(),
            "the answer must not borrow another chat's content",
          );

          // (d) A fact the outline cannot point to.
          const hidden = await turn("d-hidden-fact", {
            conversationKey: 920706,
            userText: HIDDEN_QUESTION,
            attachedConversations: [longRef],
            attachedConversationScope: [longRef],
          });
          const hiddenReads = hidden.calls.filter(
            (call) => call.name === "past_chat_read",
          );
          hiddenFactReport = {
            pastChatReadCalls: hiddenReads.length,
            queryUsed: hiddenReads.some(
              (call) =>
                typeof (call.args as { query?: unknown } | undefined)?.query ===
                "string",
            ),
            found: hidden.text.includes(HIDDEN_FACT),
          };
          assert.include(hidden.text, HIDDEN_FACT, JSON.stringify(hidden.text));

          // Probe only: the bare fact question with the short chat attached.
          await turn("probe-world-fact-attached", {
            conversationKey: 920705,
            userText: WORLD_FACT_PROBE,
            attachedConversations: [shortRef],
            attachedConversationScope: [shortRef],
          });
        },
      );
    } finally {
      await Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/past-chat-delivery-live-report.json`,
        JSON.stringify(
          { model: credentials?.model, hiddenFact: hiddenFactReport, turns },
          null,
          2,
        ),
      );
      await workflow.reset();
      if (fixture) await workflow.cleanupFixture(fixture);
    }
  });
});
