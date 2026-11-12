/**
 * Live two-turn evidence-quality replay.
 *
 * Seeds one paper with its PDF attachment and a pre-parsed MinerU cache,
 * resolves selected-text anchors the way the chat panel does, and drives two
 * real agent turns. Turn 1 asks a question about the selected sentence; turn 2
 * pushes back on the answer, which is where evidence quality usually decides
 * whether the agent re-reads the paper or argues from memory.
 *
 * Every tool call, every passage the agent read back, and the exact last user
 * message of the first provider request are written to a JSON report, so the
 * retrieval-structure work has a baseline to compare against. Quality
 * assertions come later; this test only requires that turn 1 completes and the
 * report is on disk.
 *
 * Fixtures come from the environment, so the suite skips when they are absent:
 *   LLM_FOR_ZOTERO_LIVE_PAPER_PDF     PDF file attached to the seeded paper
 *   LLM_FOR_ZOTERO_LIVE_PAPER_CACHE   directory with full.md + content_list.json
 *   LLM_FOR_ZOTERO_LIVE_REPORT_DIR    directory the reports are written into
 *   LLM_FOR_ZOTERO_LIVE_MODELS        comma separated models, default deepseek-flash
 *   LLM_FOR_ZOTERO_LIVE_PROFILE_PATH  prefs.js holding the provider credentials
 */
import { assert } from "chai";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "./liveAgentCredentials";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../../src/services/mineru/mineruCache";
import { resolveSelectedTextAnchors } from "../../src/modules/contextPanel/selectedTextAnchors";

declare const Zotero: any;
declare const IOUtils: any;
declare const Services: any;

const PREF_PREFIX = "extensions.zotero.llmforzotero";

function environmentValue(key: string): string {
  try {
    return String(Services.env.get(key) || "").trim();
  } catch {
    return "";
  }
}

const PAPER_PDF_PATH = environmentValue("LLM_FOR_ZOTERO_LIVE_PAPER_PDF");
const PAPER_CACHE_DIR = environmentValue("LLM_FOR_ZOTERO_LIVE_PAPER_CACHE");
const REPORT_DIR = environmentValue("LLM_FOR_ZOTERO_LIVE_REPORT_DIR");
const PROFILE_PATH = environmentValue("LLM_FOR_ZOTERO_LIVE_PROFILE_PATH");
const MODELS = (
  environmentValue("LLM_FOR_ZOTERO_LIVE_MODELS") || "deepseek-flash"
)
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const PAPER_TITLE =
  "Numerics of thin-film free boundary problems for partial wetting";
const PAPER_YEAR = "2014";
const PAPER_AUTHOR = { firstName: "Dirk", lastName: "Peschka" };

const SELECTED_SENTENCE =
  "In the work by Karapetsas et al. [25] the velocity/position of the contact-line is determined from the global mass conservation constraint. However, since this is only one scalar constraint such an approach only works in one spatial dimension with a single contact point. Karapetsas et al. argued that the evaluation of the usual kinematic conditions ẋ = (m/h)∇Δh is not feasible, since it contains the product of the singular term ∇Δh and the degenerate term m/h as one approaches the boundary.";
const QUESTION_TURN_1 = "为什么压力梯度项在边界线处奇异?";
const QUESTION_TURN_2 =
  "不对，这是循环论证：你用“接触线速度有限且非零”来解释为什么接触线速度公式不可用，但接触线速度正是这个公式要定义的量。必须自己想：∇π 在接触线处奇异的真正原因是什么？";

/** One provider request seen during a turn. */
type RequestCapture = {
  host: string;
  model: string;
  isAgentRequest: boolean;
  systemChars: number;
  turnRule: string;
  heldBlock: string;
  coverageBlock: string;
  messageCount: number;
  lastUserPreview: string;
  hasSelectedTextBlock: boolean;
};

/** What one `paper_read` call handed back to the model. */
type PaperReadRecord = {
  ok: unknown;
  mode: unknown;
  resultCount: number;
  results: Array<{
    chunkIndex: unknown;
    sectionLabel: unknown;
    // `sectionPath` and `why` do not exist yet; they are recorded as undefined
    // until the retrieval-structure work introduces them.
    sectionPath: unknown;
    why: unknown;
    chunkKind: unknown;
    score: unknown;
    sourceStart: unknown;
    sourceEnd: unknown;
    anchors: number;
    textPreview: string;
  }>;
  quoteCitations: number;
  quoteCitationSectionLabels: Array<string | null>;
  passageAnchorCounts: number[];
  anchors: number;
};

function prefFromContents(
  contents: string,
  key: string,
): string | boolean | undefined {
  const escaped = `${PREF_PREFIX}.${key}`.replace(/\./g, "\\.");
  const match = contents.match(
    new RegExp(
      `user_pref\\("${escaped}",\\s*("(?:\\\\.|[^"\\\\])*"|true|false)\\);`,
    ),
  );
  if (!match) return undefined;
  if (match[1] === "true") return true;
  if (match[1] === "false") return false;
  try {
    return String(JSON.parse(match[1]));
  } catch {
    return undefined;
  }
}

function extractSystem(body: any): string {
  if (typeof body.system === "string") return body.system;
  if (Array.isArray(body.system))
    return body.system.map((block: any) => block?.text || "").join("\n");
  const instruction = body.systemInstruction || body.system_instruction;
  if (instruction?.parts)
    return instruction.parts.map((part: any) => part?.text || "").join("\n");
  for (const list of [body.messages, body.input]) {
    if (!Array.isArray(list)) continue;
    const system = list.find(
      (message: any) =>
        message?.role === "system" || message?.role === "developer",
    );
    if (system) {
      return typeof system.content === "string"
        ? system.content
        : JSON.stringify(system.content);
    }
  }
  if (typeof body.instructions === "string") return body.instructions;
  return "";
}

function grabBlock(text: string, startPattern: RegExp): string {
  const match = text.match(startPattern);
  if (!match || match.index === undefined) return "";
  const rest = text.slice(match.index);
  const end = rest.search(/\n\s*\n/);
  return (end >= 0 ? rest.slice(0, end) : rest).slice(0, 2000);
}

function lastUserText(body: any): string {
  const list = body.messages || body.input || body.contents || [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== "user") continue;
    const content = message.content ?? message.parts;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return "";
}

/**
 * Embedding calls also carry an `input` field, so they have to be told apart
 * from the agent's own chat requests before the prompt is recorded.
 */
function isAgentRequestBody(url: string, body: any): boolean {
  if (/embed/i.test(String(url))) return false;
  if (Array.isArray(body?.messages) || Array.isArray(body?.contents))
    return true;
  return (
    Array.isArray(body?.input) &&
    body.input.some((entry: unknown) => entry && typeof entry === "object")
  );
}

function requestHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return String(url).slice(0, 80);
  }
}

function anchorCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Model names can carry slashes, which must not become report subdirectories. */
function safeFileName(value: string): string {
  return String(value).replace(/[^a-z0-9._-]+/gi, "-");
}

describe("live two-turn evidence quality replay", function () {
  this.timeout(720000);

  const createdItemIds: number[] = [];
  let parentId = 0;
  let attachmentId = 0;
  let paperRef: any;
  let anchors: any[] = [];

  async function writeJson(name: string, payload: unknown): Promise<void> {
    await Zotero.File.putContentsAsync(
      `${REPORT_DIR}/${name}`,
      JSON.stringify(payload, null, 2),
    );
  }

  before(async function () {
    if (!PAPER_PDF_PATH || !PAPER_CACHE_DIR || !REPORT_DIR) {
      this.skip();
      return;
    }
    await IOUtils.makeDirectory(REPORT_DIR, {
      createAncestors: true,
      ignoreExisting: true,
    });

    // MinerU stays on for reads but never parses on its own: the cache below
    // is the paper's only parsed text.
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruEnabled`, false, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruGlobalAutoParse`, false, true);
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruSyncEnabled`, false, true);
    if (PROFILE_PATH) {
      // Semantic search has to match the profile that owns the credentials,
      // otherwise the retrieval path under test is not the configured one.
      const profileContents = String(
        await Zotero.File.getContentsAsync(PROFILE_PATH),
      );
      for (const key of [
        "enableSemanticSearch",
        "embeddingProvider",
        "embeddingApiBase",
        "embeddingApiKey",
        "embeddingModel",
        "modelProviderGroups",
      ]) {
        const value = prefFromContents(profileContents, key);
        if (value !== undefined)
          Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
      }
    }

    const libraryID = Zotero.Libraries.userLibraryID;
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = libraryID;
    paper.setField("title", PAPER_TITLE);
    paper.setField("date", PAPER_YEAR);
    paper.setCreators([{ creatorType: "author", ...PAPER_AUTHOR }]);
    parentId = Math.floor(Number(await paper.saveTx()));
    createdItemIds.push(parentId);

    const attachment = await Zotero.Attachments.importFromFile({
      file: PAPER_PDF_PATH,
      parentItemID: parentId,
      title: PAPER_PDF_PATH.split("/").pop() || "paper.pdf",
      contentType: "application/pdf",
    });
    attachmentId = Math.floor(Number(attachment.id));
    createdItemIds.push(attachmentId);

    const markdown = new TextDecoder("utf-8").decode(
      await IOUtils.read(`${PAPER_CACHE_DIR}/full.md`),
    );
    const contentList = await IOUtils.read(
      `${PAPER_CACHE_DIR}/content_list.json`,
    );
    await writeMineruCacheFiles(attachmentId, markdown, [
      { relativePath: "full.md", data: new TextEncoder().encode(markdown) },
      { relativePath: "content_list.json", data: contentList },
    ]);
    try {
      await writeMineruSourceProvenanceForAttachment(attachment);
    } catch {
      // Provenance is optional for reads; a missing record must not block them.
    }
    Zotero.Prefs.set(`${PREF_PREFIX}.mineruEnabled`, true, true);

    paperRef = {
      libraryID,
      itemId: parentId,
      contextItemId: attachmentId,
      title: PAPER_TITLE,
      firstCreator: PAPER_AUTHOR.lastName,
      year: PAPER_YEAR,
    };
    if (!(globalThis as any).ztoolkit) {
      (globalThis as any).ztoolkit = Zotero.LLMForZotero.data.ztoolkit;
    }
    anchors = await resolveSelectedTextAnchors({
      selectedTextContexts: [
        {
          text: SELECTED_SENTENCE,
          source: "pdf",
          paperContext: paperRef,
          contextItemId: attachmentId,
        } as any,
      ],
      paperContexts: [paperRef],
    });
    await writeJson("live-setup.json", {
      parentId,
      attachmentId,
      anchors: anchors.map((anchor: any) => ({
        contextIndex: anchor.contextIndex,
        resolution: anchor.resolution,
        pageIndex: anchor.pageIndex,
        preferredChunkIndexes: anchor.preferredChunkIndexes,
        sourceType: anchor.sourceType,
        contextTextChars: String(anchor.contextText || "").length,
      })),
    });
  });

  after(async function () {
    for (const itemId of createdItemIds.reverse()) {
      try {
        const item = Zotero.Items.get(itemId);
        if (item) await item.eraseTx();
      } catch {
        // Best-effort cleanup must not hide the evaluation outcome.
      }
    }
  });

  async function runTurn(
    credentials: LiveAgentCredentials,
    conversationKey: number,
    turn: number,
    params: Record<string, unknown>,
    captures: RequestCapture[],
  ) {
    const api = Zotero.LLMForZotero.api.agent;
    const toolkit = Zotero.LLMForZotero.data.ztoolkit;
    const originalGetGlobal = toolkit.getGlobal;
    const nativeFetch = originalGetGlobal.call(toolkit, "fetch");
    let firstAgentRequestLastUserMessage = "";
    toolkit.getGlobal = function (name: string) {
      if (name !== "fetch") return originalGetGlobal.call(toolkit, name);
      return async (url: string, init?: RequestInit) => {
        try {
          const body = JSON.parse(String(init?.body || "{}"));
          if (body.messages || body.input || body.contents) {
            const isAgentRequest = isAgentRequestBody(url, body);
            const system = extractSystem(body);
            const lastUser = lastUserText(body);
            captures.push({
              host: requestHost(url),
              model: String(body.model || ""),
              isAgentRequest,
              systemChars: system.length,
              turnRule: grabBlock(system, /TURN RULE:/),
              heldBlock: grabBlock(system, /Already held/),
              coverageBlock: grabBlock(
                system,
                /Known coverage from prior agent reads/,
              ),
              messageCount: (body.messages || body.input || body.contents || [])
                .length,
              lastUserPreview: lastUser.slice(0, 300),
              hasSelectedTextBlock:
                /selected text/i.test(system) ||
                /selected text/i.test(JSON.stringify(body).slice(0, 200000)),
            });
            if (isAgentRequest && !firstAgentRequestLastUserMessage) {
              firstAgentRequestLastUserMessage = lastUser;
              await Zotero.File.putContentsAsync(
                `${REPORT_DIR}/live-system-prompt-${safeFileName(credentials.model)}-turn${turn}.txt`,
                `${system}\n\n=== LAST USER MESSAGE ===\n${lastUser}`,
              );
            }
          }
        } catch {
          // Capture is evidence only; it must never break the live request.
        }
        return nativeFetch(url, init);
      };
    };

    const toolCalls: Array<{ name: string; args?: unknown }> = [];
    const paperReads: PaperReadRecord[] = [];
    let quoteCitationsTotal = 0;
    let anchorsTotal = 0;
    const startedAt = Date.now();
    let result: any;
    try {
      result = await api.runTurn(
        {
          conversationKey,
          mode: "agent",
          libraryID: Zotero.Libraries.userLibraryID,
          conversationKind: "paper",
          activeItemId: parentId,
          activePaperContext: paperRef,
          model: credentials.model,
          apiBase: credentials.apiBase,
          apiKey: credentials.apiKey,
          providerProtocol: credentials.providerProtocol,
          ...params,
        },
        (event: any) => {
          if (event?.type === "tool_call") {
            toolCalls.push({
              name: String(event.name || ""),
              args: event.name === "paper_read" ? event.args : undefined,
            });
          }
          if (event?.type === "tool_result" && event.name === "paper_read") {
            const content = event.content || {};
            const results = Array.isArray(content.results)
              ? content.results
              : [];
            const quoteCitations = Array.isArray(content.quoteCitations)
              ? content.quoteCitations
              : [];
            quoteCitationsTotal += quoteCitations.length;
            const passageAnchorCounts: number[] = Array.isArray(content.papers)
              ? content.papers.flatMap((paper: any) =>
                  (paper.passages || []).map((passage: any) =>
                    anchorCount(passage.quoteAnchors),
                  ),
                )
              : [];
            const anchorsInResults = results.reduce(
              (total: number, entry: any) =>
                total + anchorCount(entry.quoteAnchors),
              0,
            );
            const anchorsInPassages = passageAnchorCounts.reduce(
              (total, count) => total + count,
              0,
            );
            // `results` and `papers` are two views of the same passages, so an
            // anchor present in both is one anchor, not two.
            const anchors = Math.max(anchorsInResults, anchorsInPassages);
            anchorsTotal += anchors;
            paperReads.push({
              ok: event.ok,
              mode: content.mode,
              resultCount: results.length,
              results: results.map((entry: any) => ({
                chunkIndex: entry.chunkIndex,
                sectionLabel: entry.sectionLabel,
                sectionPath: entry.sectionPath,
                why: entry.why,
                chunkKind: entry.chunkKind,
                score: entry.score,
                sourceStart: entry.sourceStart,
                sourceEnd: entry.sourceEnd,
                anchors: anchorCount(entry.quoteAnchors),
                textPreview: String(entry.text || "")
                  .replace(/\s+/g, " ")
                  .slice(0, 90),
              })),
              quoteCitations: quoteCitations.length,
              quoteCitationSectionLabels: quoteCitations.map(
                (citation: any) => citation.sourceSectionLabel || null,
              ),
              passageAnchorCounts,
              anchors,
            });
          }
          if (event?.type === "confirmation_required" && event.requestId) {
            void api.resolveConfirmation(event.requestId, true);
          }
        },
      );
    } finally {
      toolkit.getGlobal = originalGetGlobal;
    }

    const text = result?.kind === "completed" ? String(result.text || "") : "";
    return {
      outcome: result?.kind,
      reason: result?.reason,
      elapsedMs: Date.now() - startedAt,
      toolCalls,
      paperReads,
      quoteCitationsTotal,
      anchorsTotal,
      quoteTokensInAnswer: (text.match(/\[\[quote:/g) || []).length,
      blockquotesInAnswer: (text.match(/^>\s/gm) || []).length,
      answer: text,
      requests: captures.length,
      firstAgentRequestLastUserMessage,
    };
  }

  for (const modelName of MODELS) {
    it(`replays two turns on ${modelName}`, async function () {
      const reportName = `live-report-${safeFileName(modelName)}.json`;
      const credentials = await resolveLiveAgentCredentials({
        requestedModel: modelName,
        ...(PROFILE_PATH ? { profilePath: PROFILE_PATH } : {}),
      });
      if (!credentials) {
        await writeJson(reportName, {
          model: modelName,
          status: "no-credentials",
        });
        this.skip();
        return;
      }
      const conversationKey = Math.floor(Math.random() * 1_000_000) + 5_000_000;
      const report: Record<string, unknown> = {
        model: credentials.model,
        protocol: credentials.providerProtocol,
        conversationKey,
        turns: [] as unknown[],
      };
      const turns = report.turns as unknown[];

      const turn1Captures: RequestCapture[] = [];
      const turn1 = await runTurn(
        credentials,
        conversationKey,
        1,
        {
          userText: QUESTION_TURN_1,
          selectedTexts: [SELECTED_SENTENCE],
          selectedTextSources: ["pdf"],
          selectedTextPaperContexts: [paperRef],
          resolvedSelectedTextAnchors: anchors,
        },
        turn1Captures,
      );
      turns.push({
        turn: 1,
        userText: QUESTION_TURN_1,
        ...turn1,
        captures: turn1Captures,
      });
      await writeJson(reportName, report);

      const turn2Captures: RequestCapture[] = [];
      const turn2 = await runTurn(
        credentials,
        conversationKey,
        2,
        {
          userText: QUESTION_TURN_2,
          history: [
            {
              role: "user",
              content: `${QUESTION_TURN_1}\n\n[selected text]\n${SELECTED_SENTENCE}`,
            },
            { role: "assistant", content: turn1.answer },
          ],
        },
        turn2Captures,
      );
      turns.push({
        turn: 2,
        userText: QUESTION_TURN_2,
        ...turn2,
        captures: turn2Captures,
      });
      await writeJson(reportName, report);

      assert.equal(
        turn1.outcome,
        "completed",
        JSON.stringify({
          outcome: turn1.outcome,
          reason: turn1.reason,
          toolCalls: turn1.toolCalls.map((call) => call.name),
        }),
      );
      const reportExists = await IOUtils.exists(`${REPORT_DIR}/${reportName}`);
      assert.isTrue(reportExists, "the live report must be written to disk");
    });
  }
});
