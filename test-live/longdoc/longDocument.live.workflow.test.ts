/**
 * Opt-in live evaluation: how the agent reads long documents.
 *
 * One dissertation (with and without PDF bookmarks) and one textbook are
 * imported as plain PDFs (no MinerU cache is written, so the agent reads the
 * PDF path). Each answer-key question runs as a fresh paper conversation and
 * writes one JSON report; summary.json holds one numeric row per case.
 *
 * Run:
 *   LLM_FOR_ZOTERO_TEST_ENTRIES=test-live/longdoc node scripts/run-workflow-tests.mjs --agent-live
 *
 * Env: LLM_FOR_ZOTERO_LONGDOC_KEY (answer_key.json), LLM_FOR_ZOTERO_LONGDOC_CORPUS
 * (PDF folder), LLM_FOR_ZOTERO_QA_REPORT_DIR (output; unset = skip), and the
 * optional LLM_FOR_ZOTERO_LONGDOC_CONDITIONS, LLM_FOR_ZOTERO_LONGDOC_CASES,
 * LLM_FOR_ZOTERO_LIVE_MODEL, LLM_FOR_ZOTERO_QA_SOFT, LLM_FOR_ZOTERO_QA_VARIANT.
 *
 * Optional key fields (entries without them run exactly as before):
 * - "selections": [{"pdf_page": 112, "text": "verbatim passage"}] sends PDF
 *   text selections with turn 1 only, as the chat panel does (pdf_page is
 *   1-based). Anchors are resolved against the condition's PDF attachment.
 *   Turn 1 then reports selection { count, anchors[] }; the case reports
 *   selections (pdf_page and text length only).
 * - "pages_needed": reported as pagesNeeded at case level.
 * - "kind" may be sel-local, sel-section, sel-elsewhere, sel-compare or
 *   sel-followup (it is only copied into the report).
 * - "turn2" stays a follow-up turn sent with history and no selection. The
 *   turn 1 history entry carries the selected text, as the panel stores it.
 * Each turn also reports pagesRead: the 1-based PDF pages that paper_read
 * passages carried (pageIndex or pageStart/pageEnd), or null when no
 * passage carried page information.
 *
 * Cut signals (what paper_read says about text that was cut or incomplete).
 * Fields read from each paper_read result content (src/agent/tools/read/paperRead.ts):
 * - status (top level, full mode): "partial" or "unreadable" (not "complete").
 * - papers[].status: full mode "partial"/"unreadable"; targeted-sections mode
 *   "partial"/"no_matching_sections"/"unreadable"/"sections_not_chosen";
 *   query mode "no_matches"/"exploratory".
 * - papers[].sections[].complete === false (section cut by the read budget),
 *   with characters / totalCharacters.
 * - papers[].readShare, papers[].unmatched (named sections not found).
 * - coverageReceipt.complete === false and coverageReceipt.missingChunkRanges
 *   (full mode).
 * - results[].coverage not "complete" (overview: "capacity_sampled",
 *   "abstract_only", "metadata_only"), with selectedCharacters/totalCharacters.
 * - readingReceipt.capacitySampledPapers / abstractOnlyPapers /
 *   metadataOnlyPapers > 0 (overview).
 * - warnings[] (top level and per paper) and readerFallback.
 *
 * Timeouts: the agent-live runner sets 720 s per test. A long-document turn
 * can take many minutes, so each case sets 45 min (90 min for two-turn
 * cases) and setup sets 15 min.
 */
import { assert } from "chai";
import { usageFromResponse } from "../../test/helpers/qaUsage";
import { resolveLiveAgentCredentials } from "../agent/liveAgentCredentials";
import { resolveSelectedTextAnchors } from "../../src/modules/contextPanel/selectedTextAnchors";
import { buildQuestionWithSelectedTextContexts } from "../../src/modules/contextPanel/textUtils";
import type { SelectedTextContext } from "../../src/shared/types";
declare const Zotero: any;
declare const IOUtils: any;
declare const Services: any;
const env = (key: string) => String(Services.env.get(key) || "");
const prefix = "extensions.zotero.llmforzotero";
const directory = env("LLM_FOR_ZOTERO_QA_REPORT_DIR");
const keyPath = env("LLM_FOR_ZOTERO_LONGDOC_KEY");
const corpusDir = env("LLM_FOR_ZOTERO_LONGDOC_CORPUS");
const variant = env("LLM_FOR_ZOTERO_QA_VARIANT") || "unspecified";
const soft = env("LLM_FOR_ZOTERO_QA_SOFT") === "1";
// Simulates a smaller context window: request.advanced.inputTokenCap shrinks
// the whole input budget, including the paper text preloaded into the prompt.
const inputTokenCap = Number(env("LLM_FOR_ZOTERO_LONGDOC_INPUT_CAP")) || 0;
const list = (key: string) =>
  env(key)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const selectedCases = new Set(list("LLM_FOR_ZOTERO_LONGDOC_CASES"));
const selectedConditions = new Set(list("LLM_FOR_ZOTERO_LONGDOC_CONDITIONS"));

type Condition = "diss" | "diss-nobm" | "psy";
const CONDITIONS: Record<
  Condition,
  {
    pdf: string;
    prefix: string;
    itemType: "thesis" | "book";
    title: string;
    author: string;
    year: string;
  }
> = {
  diss: {
    pdf: "2412.19845.pdf",
    prefix: "diss-",
    itemType: "thesis",
    title:
      "Unveiling Secrets of Brain Function with Generative Modeling: Motion Perception in Primates & Cortical Network Organization in Mice",
    author: "Vafaii",
    year: "2023",
  },
  "diss-nobm": {
    pdf: "2412.19845-nobookmarks.pdf",
    prefix: "diss-",
    itemType: "thesis",
    title:
      "Unveiling Secrets of Brain Function with Generative Modeling: Motion Perception in Primates & Cortical Network Organization in Mice (no bookmarks)",
    author: "Vafaii",
    year: "2023",
  },
  psy: {
    pdf: "Psychology2e_WEB.pdf",
    prefix: "psy-",
    itemType: "book",
    title: "Psychology 2e",
    author: "Spielman",
    year: "2020",
  },
};
const conditionOrder = Object.keys(CONDITIONS) as Condition[];

type KeyEntry = {
  id: string;
  doc: string;
  kind: string;
  question: string;
  turn2?: string;
  selections?: Array<{ pdf_page: number; text: string }>;
  pages_needed?: unknown;
};
/** Read at load time: mocha needs the case list before any hook runs. */
function loadKey(): KeyEntry[] {
  if (!directory || !keyPath) return [];
  try {
    const parsed = JSON.parse(String(Zotero.File.getContents(keyPath)));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
const key = loadKey();
const plan: Array<{ condition: Condition; entry: KeyEntry }> = [];
for (const condition of conditionOrder) {
  if (selectedConditions.size && !selectedConditions.has(condition)) continue;
  for (const entry of key) {
    if (!entry.id.startsWith(CONDITIONS[condition].prefix)) continue;
    if (selectedCases.size && !selectedCases.has(entry.id)) continue;
    plan.push({ condition, entry });
  }
}

// Same boundary qaFramework appends to a paper question.
const turnSuffix =
  "Use the supplied context and selected evaluation papers only. Do not use external sources or modify the library. Keep the answer concise.";

/** Sections a read actually delivered: flat results, or the per-paper groups. */
const deliveredSectionsOf = (content: any): string[] => {
  const rows: any[] = Array.isArray(content?.results)
    ? content.results
    : [content?.papers, content?.groups]
        .filter(Array.isArray)
        .flatMap((groups: any[]) =>
          groups.flatMap((group: any) =>
            Array.isArray(group?.passages) ? group.passages : [],
          ),
        );
  return [
    ...new Set(
      rows
        .map((row) => row?.sectionPath || row?.sectionLabel)
        .filter(
          (section): section is string =>
            typeof section === "string" && section.length > 0,
        ),
    ),
  ];
};

/**
 * 1-based PDF pages the passages of a paper_read result carried: pageIndex
 * (0-based) or the pageStart..pageEnd range (0-based, as chunk metadata
 * stores it). Null when no passage carried page information.
 */
const pagesReadOf = (content: any): number[] | null => {
  const rows: any[] = Array.isArray(content?.results)
    ? content.results
    : [content?.papers, content?.groups]
        .filter(Array.isArray)
        .flatMap((groups: any[]) =>
          groups.flatMap((group: any) =>
            Array.isArray(group?.passages) ? group.passages : [],
          ),
        );
  const pages = new Set<number>();
  let seen = false;
  const valid = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  for (const row of rows) {
    if (valid(row?.pageStart)) {
      seen = true;
      const end = valid(row?.pageEnd) ? row.pageEnd : row.pageStart;
      for (let p = row.pageStart; p <= end && p - row.pageStart < 2000; p++)
        pages.add(p + 1);
    } else if (valid(row?.pageIndex)) {
      seen = true;
      pages.add(row.pageIndex + 1);
    }
  }
  return seen ? [...pages].sort((a, b) => a - b) : null;
};

/** Every field of a paper_read result that says text was cut or incomplete. */
function cutSignalsOf(content: any): Array<{ field: string; value: unknown }> {
  const found: Array<{ field: string; value: unknown }> = [];
  const add = (field: string, value: unknown) => found.push({ field, value });
  if (!content || typeof content !== "object") return found;
  if (
    content.status &&
    content.status !== "complete" &&
    content.status !== "ok"
  )
    add("status", content.status);
  if (Array.isArray(content.warnings) && content.warnings.length)
    add("warnings", content.warnings);
  if (content.readerFallback) add("readerFallback", content.readerFallback);
  const receipt = content.coverageReceipt;
  if (
    receipt &&
    (receipt.complete === false || receipt.missingChunkRanges?.length)
  )
    add("coverageReceipt", {
      complete: receipt.complete,
      processedChunks: receipt.processedChunks,
      totalChunks: receipt.totalChunks,
      missingChunkRanges: receipt.missingChunkRanges,
    });
  const reading = content.readingReceipt;
  if (
    reading &&
    (reading.capacitySampledPapers ||
      reading.abstractOnlyPapers ||
      reading.metadataOnlyPapers)
  )
    add("readingReceipt", {
      capacitySampledPapers: reading.capacitySampledPapers,
      abstractOnlyPapers: reading.abstractOnlyPapers,
      metadataOnlyPapers: reading.metadataOnlyPapers,
    });
  if (Array.isArray(content.results))
    content.results.forEach((row: any, index: number) => {
      if (row?.coverage && row.coverage !== "complete")
        add(`results[${index}].coverage`, {
          coverage: row.coverage,
          selectedCharacters: row.selectedCharacters,
          totalCharacters: row.totalCharacters,
        });
    });
  if (Array.isArray(content.papers))
    content.papers.forEach((paper: any, index: number) => {
      if (
        paper?.status &&
        !["complete", "matched"].includes(String(paper.status))
      )
        add(`papers[${index}].status`, paper.status);
      if (paper?.readShare) add(`papers[${index}].readShare`, paper.readShare);
      if (Array.isArray(paper?.unmatched) && paper.unmatched.length)
        add(`papers[${index}].unmatched`, paper.unmatched);
      if (Array.isArray(paper?.warnings) && paper.warnings.length)
        add(`papers[${index}].warnings`, paper.warnings);
      for (const section of Array.isArray(paper?.sections)
        ? paper.sections
        : [])
        if (section?.complete === false)
          add(`papers[${index}].sections[].complete`, {
            section: section.section,
            characters: section.characters,
            totalCharacters: section.totalCharacters,
          });
    });
  return found;
}

const failureMessage = (error: unknown) =>
  String((error as { message?: string } | undefined)?.message || error);
const sizeOf = (content: unknown) => {
  let chars = 0;
  try {
    chars = JSON.stringify(content ?? null)?.length ?? 0;
  } catch {
    chars = 0;
  }
  return { resultChars: chars, resultTokensApprox: Math.ceil(chars / 4) };
};

describe("long document live evaluation", function () {
  this.timeout(2700000);
  const created: number[] = [];
  const refs = new Map<Condition, any>();
  const summary: any[] = [];
  let credentials: Awaited<ReturnType<typeof resolveLiveAgentCredentials>>;
  const write = (name: string, data: unknown) =>
    Zotero.File.putContentsAsync(
      `${directory}/${name}`,
      JSON.stringify(data, null, 2),
    );

  before(async function () {
    this.timeout(900000);
    if (!directory || !keyPath || !corpusDir || !plan.length) {
      this.skip();
      return;
    }
    credentials = await resolveLiveAgentCredentials({
      requestedModel: env("LLM_FOR_ZOTERO_LIVE_MODEL") || "gpt-5.6-luna",
    });
    assert.isOk(
      credentials,
      "Configured live credentials must be available; requested evaluation cannot silently skip",
    );
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    // Plain PDF path: no MinerU parse, no sync, no semantic search.
    Zotero.Prefs.set(`${prefix}.mineruGlobalAutoParse`, false, true);
    Zotero.Prefs.set(`${prefix}.mineruSyncEnabled`, false, true);
    Zotero.Prefs.set(`${prefix}.mineruEnabled`, true, true);
    Zotero.Prefs.set(`${prefix}.enableSemanticSearch`, false, true);
    for (const condition of new Set(plan.map((p) => p.condition))) {
      const spec = CONDITIONS[condition];
      const item = new Zotero.Item(spec.itemType);
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.setField("title", spec.title);
      item.setField("date", spec.year);
      item.setCreators([
        { creatorType: "author", firstName: "", lastName: spec.author },
      ]);
      const itemId = Number(await item.saveTx());
      created.push(itemId);
      const attachment = await Zotero.Attachments.importFromFile({
        file: `${corpusDir}/${spec.pdf}`,
        parentItemID: itemId,
        contentType: "application/pdf",
      });
      created.push(attachment.id);
      refs.set(condition, {
        libraryID: item.libraryID,
        itemId,
        contextItemId: attachment.id,
        title: spec.title,
        firstCreator: spec.author,
        year: spec.year,
      });
    }
    await write(`setup-${variant}.json`, {
      variant,
      model: credentials!.model,
      inputTokenCap: inputTokenCap || null,
      conditions: [...refs.keys()],
      refs: [...refs.entries()],
      cases: plan.map((p) => `${p.condition}/${p.entry.id}`),
    });
  });

  after(async function () {
    if (directory && summary.length) await write("summary.json", summary);
    for (const id of [...created].reverse()) {
      const item = Zotero.Items.get(id);
      if (item) await item.eraseTx();
    }
  });

  if (!plan.length)
    it("needs LLM_FOR_ZOTERO_QA_REPORT_DIR, _LONGDOC_KEY and _LONGDOC_CORPUS", function () {
      this.skip();
    });

  for (const { condition, entry } of plan) {
    const caseId = `${condition}/${entry.id}`;
    it(`${caseId} ${entry.kind}: ${entry.question}`, async function () {
      this.timeout(entry.turn2 ? 5400000 : 2700000);
      const ref = refs.get(condition);
      const conversationKey =
        Math.floor(Date.now() / 10) +
        plan.findIndex((p) => p.entry === entry && p.condition === condition);
      const toolkit = Zotero.LLMForZotero.data.ztoolkit;
      const failures: Array<{ turn: number; stage: string; message: string }> =
        [];

      /** One turn, with its own fetch capture and event list. */
      const runTurn = async (
        turn: number,
        userText: string,
        history?: Array<{ role: string; content: string }>,
        selection?: {
          contexts: SelectedTextContext[];
          anchors: any[];
        },
      ) => {
        const original = toolkit.getGlobal;
        const fetch = original.call(toolkit, "fetch");
        const requests: any[] = [];
        const pending: Promise<void>[] = [];
        const events: any[] = [];
        const start = Date.now();
        toolkit.getGlobal = function (name: string) {
          if (name !== "fetch") return original.call(toolkit, name);
          return async (url: string, init?: RequestInit) => {
            let body: any;
            try {
              body = JSON.parse(String(init?.body || "{}"));
            } catch {
              body = {};
            }
            const measured = Boolean(
              body.model || body.messages || body.input || body.contents,
            );
            const record: any = {
              index: requests.length,
              kind: /embed/i.test(url)
                ? "embedding"
                : body.tools?.length
                  ? "agent"
                  : "utility",
              model: body.model || null,
              startedMs: Date.now() - start,
            };
            if (measured) requests.push(record);
            try {
              const response = await fetch(url, init);
              if (measured) {
                record.status = response.status;
                pending.push(
                  response
                    .clone()
                    .text()
                    .then((text: string) => {
                      record.elapsedMs = Date.now() - start - record.startedMs;
                      record.usage = usageFromResponse(text);
                    })
                    .catch(() => {
                      record.usage = null;
                      record.captureError = true;
                    }),
                );
              }
              return response;
            } catch (error) {
              record.failed = true;
              record.elapsedMs = Date.now() - start - record.startedMs;
              throw error;
            }
          };
        };
        let result: any;
        let error: string | undefined;
        try {
          result = await Zotero.LLMForZotero.api.agent.runTurn(
            {
              conversationKey,
              mode: "agent",
              libraryID: ref.libraryID,
              conversationKind: "paper",
              activeItemId: ref.itemId,
              activePaperContext: ref,
              selectedPaperContexts: [],
              // A PDF selection: the panel's agent path (agentEngine.ts
              // toAgentRuntimeRequestParams) fills selectedTextContexts,
              // resolvedSelectedTextAnchors and the parallel selectedTexts /
              // selectedTextSources / selectedTextPaperContexts arrays
              // (noteContexts stay empty for PDF text). The same set is sent.
              ...(selection
                ? {
                    selectedTextContexts: selection.contexts,
                    resolvedSelectedTextAnchors: selection.anchors,
                    selectedTexts: selection.contexts.map((c) => c.text),
                    selectedTextSources: selection.contexts.map(
                      (c) => c.source,
                    ),
                    selectedTextPaperContexts: selection.contexts.map(
                      (c) => c.paperContext,
                    ),
                  }
                : {}),
              ...credentials,
              ...(inputTokenCap ? { advanced: { inputTokenCap } } : {}),
              ...(history ? { history } : {}),
              userText,
            },
            (event: any) => {
              if (
                [
                  "tool_call",
                  "tool_result",
                  "message_rollback",
                  "usage",
                  "final",
                  "done",
                  "error",
                ].includes(event.type)
              )
                events.push({ ...event, atMs: Date.now() - start });
              if (event.type === "confirmation_required")
                void Zotero.LLMForZotero.api.agent.resolveConfirmation(
                  event.requestId,
                  false,
                );
            },
          );
        } catch (e) {
          error = String(e);
          failures.push({ turn, stage: "turn", message: failureMessage(e) });
        } finally {
          toolkit.getGlobal = original;
          await Promise.all(pending);
        }
        const results = events.filter((e) => e.type === "tool_result");
        const resultByCall = new Map<string, any>();
        for (const r of results) resultByCall.set(String(r.callId), r);
        const toolCalls = events
          .filter((e) => e.type === "tool_call")
          .map((call) => {
            const matched = resultByCall.get(String(call.callId));
            return {
              name: call.name,
              callId: call.callId,
              args: call.args ?? call.arguments ?? call.input ?? null,
              ...sizeOf(matched?.content),
              hasResult: Boolean(matched),
            };
          });
        const largest = toolCalls.reduce(
          (best: any, c: any) =>
            !best || c.resultChars > best.resultChars ? c : best,
          null,
        );
        const readResults = results.filter((e) => e.name === "paper_read");
        const readCalls = events.filter(
          (e) => e.type === "tool_call" && e.name === "paper_read",
        );
        const agentRequests = requests.filter((r) => r.kind === "agent");
        const inputOf = (r: any) => Number(r.usage?.inputTokens) || 0;
        const sum = (rows: any[], pick: (r: any) => number) =>
          rows.reduce((s, r) => s + pick(r), 0);
        return {
          turn,
          userText,
          answer: String(result?.text || ""),
          outcome: result?.kind,
          error,
          elapsedMs: Date.now() - start,
          requests: requests.map((r) => ({
            index: r.index,
            kind: r.kind,
            model: r.model,
            status: r.status,
            elapsedMs: r.elapsedMs,
            usage: r.usage
              ? {
                  input: r.usage.inputTokens,
                  output: r.usage.outputTokens,
                  cached: r.usage.cachedInputTokens,
                  reasoning: r.usage.reasoningTokens,
                }
              : null,
          })),
          peakInputTokens: agentRequests.reduce(
            (m, r) => Math.max(m, inputOf(r)),
            0,
          ),
          totalInputTokens: sum(requests, inputOf),
          totalOutputTokens: sum(
            requests,
            (r) => Number(r.usage?.outputTokens) || 0,
          ),
          toolCalls,
          largestToolResultChars: largest?.resultChars ?? 0,
          largestToolResultTool: largest?.name ?? null,
          paperReadModes: readCalls.map((c) => {
            const args = c.args ?? c.arguments ?? c.input;
            const parsed =
              typeof args === "string"
                ? (() => {
                    try {
                      return JSON.parse(args);
                    } catch {
                      return {};
                    }
                  })()
                : args;
            return String(parsed?.mode ?? "");
          }),
          deliveredSections: readResults.map((e) => ({
            callId: e.callId,
            sections: deliveredSectionsOf(e.content),
          })),
          pagesRead: readResults.length
            ? readResults.map((e) => ({
                callId: e.callId,
                pages: pagesReadOf(e.content),
              }))
            : null,
          ...(selection
            ? {
                selection: {
                  count: selection.contexts.length,
                  anchors: selection.anchors.map((a: any) => ({
                    contextIndex: a.contextIndex,
                    resolution: a.resolution,
                    pageIndex: a.pageIndex,
                    preferredChunkIndexes: a.preferredChunkIndexes,
                    contextTextChars: String(a.contextText || "").length,
                    injectedChars: a.injectedChars,
                  })),
                },
              }
            : {}),
          cutSignals: readResults.map((e) => ({
            callId: e.callId,
            mode: e.content?.mode ?? null,
            signals: cutSignalsOf(e.content),
          })),
          rollbacks: events.filter((e) => e.type === "message_rollback").length,
          events,
        };
      };

      const turns: any[] = [];
      const turn1Text = `${entry.question}\n\n${turnSuffix}`;
      let selection:
        | { contexts: SelectedTextContext[]; anchors: any[] }
        | undefined;
      if (entry.selections?.length) {
        const contexts: SelectedTextContext[] = entry.selections.map((s) => ({
          text: s.text,
          source: "pdf",
          paperContext: ref,
          contextItemId: ref.contextItemId,
          pageIndex: s.pdf_page - 1,
        }));
        if (!(globalThis as any).ztoolkit)
          (globalThis as any).ztoolkit = Zotero.LLMForZotero.data.ztoolkit;
        selection = {
          contexts,
          anchors: await resolveSelectedTextAnchors({
            selectedTextContexts: contexts,
            paperContexts: [ref],
          }),
        };
      }
      const first = await runTurn(1, turn1Text, undefined, selection);
      turns.push(first);
      // The panel stores a selection turn's user message with its selected
      // text and rebuilds history from it (chat.ts buildHistoryMessageForLLM
      // -> reconstructRetryPayload): the selected-text block plus the
      // question, without resolved anchors.
      const turn1History = selection
        ? buildQuestionWithSelectedTextContexts(
            selection.contexts.map((c) => c.text),
            selection.contexts.map((c) => c.source),
            turn1Text,
            {
              selectedTextContexts: selection.contexts,
              selectedTextPaperContexts: selection.contexts.map(
                (c) => c.paperContext,
              ),
              includePaperAttribution: true,
            },
          )
        : turn1Text;
      if (entry.turn2) {
        // Turn 2 continues the same conversation with turn 1 as history.
        turns.push(
          await runTurn(2, `${entry.turn2}\n\n${turnSuffix}`, [
            { role: "user", content: turn1History },
            { role: "assistant", content: first.answer },
          ]),
        );
      }
      for (const t of turns) {
        if (t.outcome !== "completed" && !t.error)
          failures.push({
            turn: t.turn,
            stage: "assert",
            message: `outcome ${t.outcome}`,
          });
        else if (!t.answer && !t.error)
          failures.push({
            turn: t.turn,
            stage: "assert",
            message: "empty answer",
          });
      }
      await write(`${condition}__${entry.id}.json`, {
        variant,
        model: credentials!.model,
        id: caseId,
        condition,
        questionId: entry.id,
        kind: entry.kind,
        question: entry.question,
        turn2: entry.turn2,
        ...(entry.selections?.length
          ? {
              selections: entry.selections.map((s) => ({
                pdf_page: s.pdf_page,
                textChars: s.text.length,
              })),
            }
          : {}),
        ...(entry.pages_needed !== undefined
          ? { pagesNeeded: entry.pages_needed }
          : {}),
        turns,
        ...(failures.length ? { failures } : {}),
      });
      summary.push({
        id: caseId,
        variant,
        kind: entry.kind,
        turns: turns.map((t) => ({
          turn: t.turn,
          outcome: t.outcome,
          error: t.error ?? null,
          elapsedMs: t.elapsedMs,
          requests: t.requests.length,
          peakInputTokens: t.peakInputTokens,
          totalInputTokens: t.totalInputTokens,
          totalOutputTokens: t.totalOutputTokens,
          toolCalls: t.toolCalls.length,
          paperReadModes: t.paperReadModes,
          largestToolResultChars: t.largestToolResultChars,
          largestToolResultTool: t.largestToolResultTool,
          cutSignalCount: t.cutSignals.reduce(
            (s: number, c: any) => s + c.signals.length,
            0,
          ),
          answerChars: t.answer.length,
        })),
        failed: failures.length > 0,
      });
      // Written after every case so an aborted flight keeps its rows.
      await write("summary.json", summary);
      if (!soft && failures.length)
        throw new Error(
          failures.map((f) => `turn ${f.turn}: ${f.message}`).join("; "),
        );
    });
  }
});
