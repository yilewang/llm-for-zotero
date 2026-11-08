/**
 * Live check: a web-using Agent answer whose model text puts web source
 * markers mid-line is repaired by the host (markers merged to the end of
 * their paragraph line) and rendered with its web source chips, instead of
 * being replaced by the attribution failure text. It costs API usage: run it
 * only when asked.
 *
 * The prompt asks for one single-line paragraph with a marker after each
 * claim, which invites mid-line markers. The model's raw streamed text is
 * read at the plugin's fetch, so the report says whether a mid-line marker
 * was actually produced (the repair ran) or not (the turn was ordinary).
 * Up to LLM_FOR_ZOTERO_WEB_REPAIR_ATTEMPTS turns (default 3) run until one
 * produces a mid-line marker. Web access is AnySearch (keyless).
 *
 *   ZOTERO_PLUGIN_KILL_COMMAND="pkill -9 -f \"$PWD/.scaffold/test/profile\" || true" \
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/agent/web-attribution-repair \
 *   LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-flash \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js with that model> \
 *   node scripts/run-workflow-tests.mjs --agent-live
 *
 * The report is written to <data dir>/web-attribution-repair-report.json.
 */
import { assert } from "chai";
import {
  liveModelName,
  resolveLiveAgentCredentials,
} from "../liveAgentCredentials";
import {
  LIVE_MODEL_ENTRY_ID,
  describeError,
  env,
  liveRuntimePrefs,
  panelElement,
  switchPanelToLibraryChat,
  withPrefs,
  workflowApi,
} from "../../runtimes/runtimeLiveShared";

declare const Zotero: any;

const FAILURE_TEXT =
  "could not safely attach valid paragraph-level sources to the answer";
const QUESTION =
  "Search the web for the latest stable release versions of Python and of Node.js. " +
  "Answer as ONE paragraph written on a single line (no line breaks). " +
  "Put the source marker right after the sentence it supports, then continue the paragraph on the same line.";
const MID_LINE_MARKER = /<!--llm-web-source:[^<>]*?-->[ \t]*\S/;

type AttemptRecord = {
  attempt: number;
  rawMidLineMarker: boolean;
  modelResponses?: number;
  rawTextChars?: number;
  firstBodyHead?: string;
  rawExcerpts: string[];
  answerChars: number;
  answerExcerpt: string;
  chipCount: number;
  failureText: boolean;
  error?: string;
};

/**
 * The assistant text of a model response body: the `message.content` of an
 * OpenAI-compatible JSON body, or the text deltas of an OpenAI-compatible or
 * Anthropic Messages SSE body.
 */
function streamedContent(body: string): string {
  try {
    const content = JSON.parse(body)?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  } catch {
    /* Not a JSON body: read it as SSE. */
  }
  let text = "";
  for (const line of body.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      const delta =
        event?.choices?.[0]?.delta?.content ??
        (event?.type === "content_block_delta" ? event.delta?.text : undefined);
      if (typeof delta === "string") text += delta;
    } catch {
      /* A non-JSON data line carries no content. */
    }
  }
  return text;
}

describe("live: mid-line web source markers are repaired, not rejected", function () {
  this.timeout(1_200_000);

  it("renders the answer with its web source chips", async function () {
    const credentials = await resolveLiveAgentCredentials({
      requestedModel: liveModelName("deepseek-flash"),
    });
    assert.isOk(
      credentials,
      "Configure the requested model in the selected test profile; this test must not skip",
    );
    const attempts = Math.max(
      1,
      Number(env("LLM_FOR_ZOTERO_WEB_REPAIR_ATTEMPTS")) || 3,
    );
    const api = workflowApi();
    await api.reset();
    const records: AttemptRecord[] = [];
    let fixture: Awaited<
      ReturnType<typeof api.createPaperWithPdfFixture>
    > | null = null;
    try {
      await withPrefs(
        liveRuntimePrefs("upstream", credentials!, {
          enableAgentMode: true,
          lastUsedRuntimeMode: "agent",
          webAccessProvider: "anysearch",
        }),
        async () => {
          fixture = await api.createPaperWithPdfFixture({
            title: "Live web attribution repair",
            pdfTitle: "live-web-attribution-repair.pdf",
            pages: [
              "This synthetic page exists only so the panel has a paper to open.",
            ],
          });
          const panel = await api.renderPanelForItem(fixture.parentItemId);
          await switchPanelToLibraryChat(panel.panelId);
          const toolkit = Zotero.LLMForZotero.data.ztoolkit;
          const original = toolkit.getGlobal;
          for (let attempt = 1; attempt <= attempts; attempt += 1) {
            if (attempt > 1)
              await api.startNewPanelConversation(panel.panelId, {
                allowReusedDraft: true,
              });
            await api.selectPanelModelEntry(panel.panelId, LIVE_MODEL_ENTRY_ID);
            const diag = await api.getDiagnostics(panel.panelId);
            assert.equal(diag.runtimeMode, "agent", "Agent mode is on");
            const bodies: Promise<string>[] = [];
            const fetch = original.call(toolkit, "fetch");
            toolkit.getGlobal = function (name: string) {
              if (name !== "fetch") return original.call(toolkit, name);
              return async (url: string, init?: RequestInit) => {
                const response = await fetch(url, init);
                try {
                  const body = JSON.parse(String(init?.body || "{}"));
                  if (Array.isArray(body.tools) && body.tools.length)
                    bodies.push(
                      response
                        .clone()
                        .text()
                        .catch(() => ""),
                    );
                } catch {
                  /* A body that is not JSON is not a model request. */
                }
                return response;
              };
            };
            const record: AttemptRecord = {
              attempt,
              rawMidLineMarker: false,
              rawExcerpts: [],
              answerChars: 0,
              answerExcerpt: "",
              chipCount: 0,
              failureText: false,
            };
            records.push(record);
            try {
              const result = await api.sendLiveChatTurn(
                panel.panelId,
                QUESTION,
                600_000,
              );
              record.answerChars = result.answerText.length;
              record.answerExcerpt = result.answerText.slice(0, 1500);
              record.failureText = result.answerText.includes(FAILURE_TEXT);
            } catch (error) {
              record.error = describeError(error);
              throw error;
            } finally {
              toolkit.getGlobal = original;
              const rawBodies = await Promise.all(bodies);
              const raw = rawBodies.map(streamedContent);
              record.modelResponses = rawBodies.length;
              record.rawTextChars = raw.reduce(
                (sum, text) => sum + text.length,
                0,
              );
              record.firstBodyHead = (rawBodies[0] || "").slice(0, 300);
              record.rawExcerpts = raw
                .filter((text) => text.includes("<!--llm-web-source:"))
                .map((text) => text.slice(0, 3000));
              record.rawMidLineMarker = raw.some((text) =>
                MID_LINE_MARKER.test(text),
              );
              const wrappers = panelElement(panel.panelId).querySelectorAll(
                ".llm-message-wrapper.assistant",
              );
              const last = wrappers[wrappers.length - 1] as
                | HTMLElement
                | undefined;
              record.chipCount =
                last?.querySelectorAll(".llm-web-source-chip").length || 0;
            }
            assert.isFalse(
              record.failureText,
              `attempt ${attempt}: the answer was replaced by the attribution failure text`,
            );
            assert.isAbove(
              record.chipCount,
              0,
              `attempt ${attempt}: the answer rendered no web source chip`,
            );
            if (record.rawMidLineMarker) break;
          }
        },
      );
    } finally {
      await Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/web-attribution-repair-report.json`,
        JSON.stringify({ model: credentials?.model, records }, null, 2),
      ).catch(() => undefined);
      await api.reset();
      if (fixture) await api.cleanupFixture(fixture);
    }
    assert.isTrue(
      records.some((record) => record.rawMidLineMarker),
      `no attempt produced a mid-line marker, so the repair was not exercised (${records.length} attempts)`,
    );
  });
});
