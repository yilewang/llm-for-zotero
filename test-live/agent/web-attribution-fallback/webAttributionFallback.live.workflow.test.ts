/**
 * Live smoke check: every web-using Agent answer reaches the user with its
 * web sources shown as chips, on its paragraphs or on one end chip, and is
 * never replaced by the attribution failure text (#526). It costs API usage
 * and web searches: run it only when asked.
 *
 * Each prompt runs LLM_FOR_ZOTERO_WEB_FALLBACK_REPEATS times (default 3), each
 * in a fresh library chat. The model's raw streamed text is read at the
 * plugin's fetch, so the report shows whether the model wrote markers or
 * links, and how the panel placed the chips. This is not a compliance
 * benchmark: it checks what the user sees.
 *
 * LLM_FOR_ZOTERO_WEB_PROVIDER picks the web search provider:
 * "anysearch" (default, keyless) or "deepseek". DeepSeek search uses the
 * official DeepSeek group from the live profile (as
 * deepseekWebSearch.live.workflow.test.ts does); without one the test skips.
 *
 *   ZOTERO_PLUGIN_KILL_COMMAND="pkill -9 -f \"$PWD/.scaffold/test/profile\" || true" \
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/agent/web-attribution-fallback \
 *   LLM_FOR_ZOTERO_LIVE_MODEL=deepseek-flash \
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH=<prefs.js with that model> \
 *   node scripts/run-workflow-tests.mjs --agent-live
 *
 * The report is written to <data dir>/web-attribution-fallback-report.json.
 */
import { assert } from "chai";
import { listOfficialDeepSeekGroups } from "../../../src/webAccess/deepseekSearchKey";
import {
  liveModelName,
  resolveLiveAgentCredentials,
  stringPrefFromContents,
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

const PREF_PREFIX = "extensions.zotero.llmforzotero";
const FAILURE_TEXT = "could not safely attach";
const PROMPTS = [
  "Search the web: what does the NIH Data Management and Sharing Policy require?",
  "Search the web for the latest stable releases of Python and Node.js, and cite where each fact comes from.",
  "搜索网页：NIH 数据管理与共享政策有哪些要求？",
];
// Canonical or variant markers: spaces inside, any letter case.
const RAW_MARKER_PATTERN = /<!--\s*llm-web-source\s*:[^<>]*?-->/gi;
/** Marker syntax a reader could see; the bare word in prose is not a marker. */
const VISIBLE_MARKER_PATTERN = /<!--\s*llm-web-source/i;
const RAW_MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(\s*<?https?:\/\/[^)\s]+\)/gi;
const RAW_BARE_URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;

type WebProvider = "anysearch" | "deepseek";

type TurnRecord = {
  prompt: string;
  repeat: number;
  webProvider: WebProvider;
  rawMarkerCount: number;
  rawLinkCount: number;
  answerChars: number;
  paragraphChips: number;
  endChip: boolean;
  failureText: boolean;
  markerLeak: boolean;
  rawExcerpt: string;
  answerExcerpt: string;
  /** Text around a visible marker, and the HTML of the element holding it. */
  leakContext?: string;
  leakSurface?: "answer" | "thinking";
  leakHtml?: string;
  error?: string;
};

type ProviderGroup = {
  id: string;
  authMode: string;
  apiBase?: string;
  apiKey?: string;
  models?: Array<{ model?: string }>;
};

function intPrefFromContents(contents: string, key: string): number | null {
  const escaped = key.replace(/\./g, "\\.");
  const match = contents.match(
    new RegExp(`user_pref\\("${escaped}",\\s*(\\d+)\\);`),
  );
  return match ? Number(match[1]) : null;
}

function firstOfficialGroup(serialized: string): ProviderGroup | null {
  try {
    const groups = JSON.parse(serialized) as ProviderGroup[];
    return Array.isArray(groups)
      ? listOfficialDeepSeekGroups(groups).find(
          (group) => group.models?.length,
        ) || null
      : null;
  } catch {
    return null;
  }
}

/**
 * The official DeepSeek group from the live profile, or from the running
 * Zotero's prefs, and the migration version its JSON was saved under.
 */
async function readOfficialDeepSeekGroup(): Promise<{
  group: ProviderGroup;
  migrationVersion: number | null;
} | null> {
  const key = (name: string) => `${PREF_PREFIX}.${name}`;
  const profilePath = env("LLM_FOR_ZOTERO_LIVE_PROFILE_PATH");
  if (profilePath) {
    try {
      const contents = await Zotero.File.getContentsAsync(profilePath);
      if (typeof contents === "string") {
        const group = firstOfficialGroup(
          stringPrefFromContents(contents, key("modelProviderGroups")),
        );
        if (group) {
          return {
            group,
            migrationVersion: intPrefFromContents(
              contents,
              key("modelProviderGroupsMigrationVersion"),
            ),
          };
        }
      }
    } catch {
      // Fall through to the running Zotero's prefs.
    }
  }
  const group = firstOfficialGroup(
    String(Zotero.Prefs.get(key("modelProviderGroups"), true) || ""),
  );
  if (!group) return null;
  const version = Zotero.Prefs.get(
    key("modelProviderGroupsMigrationVersion"),
    true,
  );
  return {
    group,
    migrationVersion: typeof version === "number" ? version : null,
  };
}

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

/** Markdown links, then the bare URLs outside them. */
function countRawLinks(text: string): number {
  const links = text.match(RAW_MARKDOWN_LINK_PATTERN) || [];
  const rest = text.replace(RAW_MARKDOWN_LINK_PATTERN, " ");
  return links.length + (rest.match(RAW_BARE_URL_PATTERN) || []).length;
}

describe("live: web answers always show their sources", function () {
  this.timeout(3_600_000);

  it("shows paragraph or end source chips and never the failure text", async function () {
    const providerSetting = (
      env("LLM_FOR_ZOTERO_WEB_PROVIDER") || "anysearch"
    ).toLowerCase();
    assert.include(
      ["anysearch", "deepseek"],
      providerSetting,
      "LLM_FOR_ZOTERO_WEB_PROVIDER must be anysearch or deepseek",
    );
    const webProvider = providerSetting as WebProvider;
    const official =
      webProvider === "deepseek" ? await readOfficialDeepSeekGroup() : null;
    if (webProvider === "deepseek" && !official) this.skip();

    const credentials = await resolveLiveAgentCredentials({
      requestedModel: liveModelName("deepseek-flash"),
    });
    assert.isOk(
      credentials,
      "Configure the requested model in the selected test profile; this test must not skip",
    );
    const repeats = Math.max(
      1,
      Number(env("LLM_FOR_ZOTERO_WEB_FALLBACK_REPEATS")) || 3,
    );
    const runtimePrefs = liveRuntimePrefs("upstream", credentials!, {
      enableAgentMode: true,
      lastUsedRuntimeMode: "agent",
      webAccessProvider: webProvider,
    });
    // DeepSeek search reads its key from the official DeepSeek group, so
    // that group joins the chat model's group; the Tavily key is cleared.
    // withPrefs restores every pref it sets.
    const prefs = official
      ? {
          ...runtimePrefs,
          modelProviderGroups: JSON.stringify([
            ...JSON.parse(String(runtimePrefs.modelProviderGroups)),
            official.group,
          ]),
          ...(official.migrationVersion !== null
            ? { modelProviderGroupsMigrationVersion: official.migrationVersion }
            : {}),
          tavilyApiKey: "",
        }
      : runtimePrefs;

    const api = workflowApi();
    await api.reset();
    const records: TurnRecord[] = [];
    let fixture: Awaited<
      ReturnType<typeof api.createPaperWithPdfFixture>
    > | null = null;
    try {
      await withPrefs(prefs, async () => {
        fixture = await api.createPaperWithPdfFixture({
          title: "Live web attribution fallback",
          pdfTitle: "live-web-attribution-fallback.pdf",
          pages: [
            "This synthetic page exists only so the panel has a paper to open.",
          ],
        });
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await switchPanelToLibraryChat(panel.panelId);
        const toolkit = Zotero.LLMForZotero.data.ztoolkit;
        const original = toolkit.getGlobal;
        let turns = 0;
        for (const prompt of PROMPTS) {
          for (let repeat = 1; repeat <= repeats; repeat += 1) {
            if (turns > 0)
              await api.startNewPanelConversation(panel.panelId, {
                allowReusedDraft: true,
              });
            turns += 1;
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
            const record: TurnRecord = {
              prompt,
              repeat,
              webProvider,
              rawMarkerCount: 0,
              rawLinkCount: 0,
              answerChars: 0,
              paragraphChips: 0,
              endChip: false,
              failureText: false,
              markerLeak: false,
              rawExcerpt: "",
              answerExcerpt: "",
            };
            records.push(record);
            try {
              const result = await api.sendLiveChatTurn(
                panel.panelId,
                prompt,
                600_000,
              );
              record.answerChars = result.answerText.length;
              record.answerExcerpt = result.answerText.slice(0, 1500);
              record.failureText = result.answerText.includes(FAILURE_TEXT);
            } catch (error) {
              record.error = describeError(error);
            } finally {
              toolkit.getGlobal = original;
              const raw = (await Promise.all(bodies)).map(streamedContent);
              const rawText = raw.join("\n");
              record.rawMarkerCount = (
                rawText.match(RAW_MARKER_PATTERN) || []
              ).length;
              record.rawLinkCount = countRawLinks(rawText);
              record.rawExcerpt = (
                [...raw].reverse().find((text) => text.trim()) || ""
              ).slice(0, 3000);
              const wrappers = panelElement(panel.panelId).querySelectorAll(
                ".llm-message-wrapper.assistant",
              );
              const last = wrappers[wrappers.length - 1] as
                | HTMLElement
                | undefined;
              const chips = Array.from(
                last?.querySelectorAll(".llm-web-source-chip") || [],
              ) as HTMLElement[];
              // The end chip is a paragraph of its own: the chip is all
              // that paragraph holds.
              const endChips = chips.filter((chip) => {
                const paragraph = chip.closest("p");
                return Boolean(paragraph) && !paragraph!.textContent?.trim();
              });
              record.endChip = endChips.length > 0;
              record.paragraphChips = chips.length - endChips.length;
              // The whole message counts, the Thinking section included:
              // the user reads both.
              const visibleText = last?.textContent || "";
              const leak = VISIBLE_MARKER_PATTERN.exec(visibleText);
              record.markerLeak = Boolean(leak);
              if (leak) {
                record.leakContext = visibleText.slice(
                  Math.max(0, leak.index - 200),
                  leak.index + 200,
                );
                const holder = (
                  Array.from(last?.querySelectorAll("*") || []) as Element[]
                ).find(
                  (element) =>
                    !element.children.length &&
                    VISIBLE_MARKER_PATTERN.test(element.textContent || ""),
                );
                record.leakSurface = holder?.closest(
                  ".llm-agent-reasoning-text",
                )
                  ? "thinking"
                  : "answer";
                record.leakHtml = (holder?.outerHTML || "").slice(0, 1500);
              }
            }
          }
        }
      });
    } finally {
      await Zotero.File.putContentsAsync(
        `${env("LLM_FOR_ZOTERO_LIVE_REPORT_DIR") || Zotero.DataDirectory.dir}/web-attribution-fallback-report.json`,
        JSON.stringify(
          { model: credentials?.model, webProvider, records },
          null,
          2,
        ),
      ).catch(() => undefined);
      await api.reset();
      if (fixture) await api.cleanupFixture(fixture);
    }

    for (const record of records) {
      const label = `${record.prompt} (repeat ${record.repeat})`;
      assert.isUndefined(record.error, `${label}: the turn failed`);
      assert.isAbove(record.answerChars, 0, `${label}: the answer is empty`);
      assert.isFalse(
        record.failureText,
        `${label}: the answer was replaced by the attribution failure text`,
      );
      assert.isFalse(
        record.markerLeak,
        `${label}: a source marker is visible in the answer`,
      );
      assert.isAtLeast(
        record.paragraphChips + (record.endChip ? 1 : 0),
        1,
        `${label}: the answer rendered no web source chip`,
      );
    }
  });
});
