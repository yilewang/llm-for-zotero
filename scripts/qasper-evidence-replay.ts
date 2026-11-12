/**
 * Offline replay of evidence-mode ranking against QASPER gold evidence.
 *
 * Decision aid for C2 in docs/plans/2026-10-14-haiku-agent-fixes.md
 * (Revision 1): does demoting figure/table captions and appendix chunks in an
 * evidence read help or hurt? No model calls, no Zotero, no product change.
 * The answer (no demotion) is now the shipped rule in `priorShiftFor`.
 *
 * Each paper's text is the Zotero full-text cache (`.zotero-ft-cache`) the
 * benchmark's Zotero wrote next to the PDF: the same PDF-worker text the
 * plugin chunked in the run (the script checks its chunk count against the
 * run's `pluginChunks` when `--papers` is given). The text goes through the
 * shipped path — `ensurePDFTextCached` with a stubbed PDF worker, then
 * `buildPaperRetrievalCandidates` in evidence mode with a query plan from
 * `buildRetrievalQueryPlan` — exactly as a `paper_read` targeted read with
 * semantic search off (the benchmark ran lexical-only).
 *
 * Variants (`--variants`, comma list):
 *   production      the ranking as the checked-out code ships it, untouched.
 *   mostly-caption  caption/appendix kinds are demoted only when the chunk is
 *                   short: at most `--caption-max-words` words (see below).
 *   none            caption/appendix kinds are never demoted.
 * Reference lists and chunks under 12 words stay demoted in every variant:
 * `priorShiftFor` checks those on the text, before it looks at the kind
 * (and the `references` kind is never relabelled).
 *
 * A variant is applied by relabelling the chunk kind (figure-caption,
 * table-caption, appendix → body) in a copy of the paper's chunk metadata.
 * Inside `buildPaperRetrievalCandidates` the kind only feeds `priorShiftFor`
 * (where these kinds are demoted and `body` is neutral) and
 * `isBodyEvidenceSection` (which already counts these kinds as body), so the
 * relabel changes the demotion and nothing else.
 *
 * The relabel can only remove a demotion. Run on code that still demotes
 * these kinds (base commit 73ba3334, where the C2 numbers came from) the
 * three variants differ; on code that no longer demotes them all three
 * equal `production`, which then reproduces the `none` numbers.
 *
 * Gold evidence "found": a returned chunk contains a gold evidence paragraph.
 * Both sides are normalized (QASPER's BIBREF/FIGREF/... placeholders, LaTeX
 * `$...$`, "FLOAT SELECTED:" and line-break hyphens removed; lower-cased;
 * split into [a-z0-9] tokens), then a chunk contains a paragraph when the
 * paragraph's token string is a substring of the chunk's, or when at least
 * 60% of the paragraph's distinct content tokens (stopwords and one-letter
 * tokens dropped) occur in the chunk and the paragraph has at least 5 of
 * them. A question counts when any of its annotators' evidence paragraphs is
 * contained in some chunk of the paper ("locatable"); recall@k is the share
 * of those questions where a top-k chunk contains one of them.
 *
 * Usage (from the repository root):
 *
 *   npx tsx scripts/qasper-evidence-replay.ts \
 *     --gold <gold.json> --sample <sample.jsonl> --storage <zotero storage dir> \
 *     [--papers <out/qasper/papers>] [--agent-records <out/qasper/raw/D>] \
 *     [--variants production,mostly-caption,none] [--topk 3,5] \
 *     [--caption-max-words 100] [--json <out.json>]
 *
 * `--agent-records` adds a second query set: the agent's own paper_read
 * targeted queries (with any queryVariants it passed), evaluated at the topK
 * the agent asked for and at 3 and 5. The live run's query plans for calls
 * without variants came from a model call the replay cannot repeat, so the
 * script also reports how often the `production` replay returns exactly the
 * chunks the live call returned (only for live lists of the full topK size:
 * a shorter list left out passages the conversation had already seen).
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildPaperRetrievalCandidates,
  ensurePDFTextCached,
} from "../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import { buildRetrievalQueryPlan } from "../src/services/retrieval/retrievalQueryPlan";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import type {
  PdfChunkKind,
  PdfContext,
} from "../src/services/paperContent/types";

type Variant = "production" | "mostly-caption" | "none";
const ALL_VARIANTS: Variant[] = ["production", "mostly-caption", "none"];
const RELABELLED_KINDS = new Set<PdfChunkKind>([
  "figure-caption",
  "table-caption",
  "appendix",
]);

/**
 * Default word ceiling for a "mostly caption" chunk. Chosen from the chunk
 * length distribution (printed by the script) before any recall was looked
 * at; see the report for the numbers.
 */
const DEFAULT_CAPTION_MAX_WORDS = 100;

type Options = {
  gold: string;
  sample?: string;
  storage: string;
  papers?: string;
  agentRecords?: string;
  variants: Variant[];
  topK: number[];
  captionMaxWords: number;
  json?: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    gold: "",
    storage: "",
    variants: ALL_VARIANTS,
    topK: [3, 5],
    captionMaxWords: DEFAULT_CAPTION_MAX_WORDS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--gold":
        options.gold = value();
        break;
      case "--sample":
        options.sample = value();
        break;
      case "--storage":
        options.storage = value();
        break;
      case "--papers":
        options.papers = value();
        break;
      case "--agent-records":
        options.agentRecords = value();
        break;
      case "--variants":
        options.variants = value()
          .split(",")
          .map((entry) => entry.trim() as Variant);
        for (const variant of options.variants) {
          if (!ALL_VARIANTS.includes(variant)) {
            throw new Error(`Unknown variant ${variant}`);
          }
        }
        break;
      case "--topk":
        options.topK = value()
          .split(",")
          .map((entry) => Math.floor(Number(entry)))
          .filter((entry) => entry > 0);
        break;
      case "--caption-max-words":
        options.captionMaxWords = Math.floor(Number(value()));
        break;
      case "--json":
        options.json = value();
        break;
      default:
        throw new Error(`Unknown argument ${arg}`);
    }
  }
  if (!options.gold || !options.storage) {
    throw new Error("--gold and --storage are required");
  }
  return options;
}

// ── Gold evidence matching ───────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "the of and to in a is for on that with as by we are this be an at from " +
    "or it which our was were has have not can these their its than also " +
    "into such but all more two one each been other they use used using " +
    "between both only when where how what there may will would so if"
  ).split(" "),
);

function normalizeForMatch(text: string): string {
  return text
    .replace(/FLOAT SELECTED:/g, " ")
    .replace(
      /\b(?:BIBREF|FIGREF|TABREF|SECREF|EQREF|INLINEFORM|DISPLAYFORM)\d+\b/g,
      " ",
    )
    .replace(/\$[^$]*\$/g, " ")
    .replace(/([A-Za-z])-\s*\n\s*([a-z])/g, "$1$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function contentTokens(normalized: string): Set<string> {
  return new Set(
    normalized
      .split(" ")
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  );
}

type PreparedText = { normalized: string; tokens: Set<string> };

function prepare(text: string): PreparedText {
  const normalized = normalizeForMatch(text);
  return { normalized, tokens: contentTokens(normalized) };
}

const OVERLAP_THRESHOLD = 0.6;
const MIN_OVERLAP_TOKENS = 5;

function chunkContainsGold(chunk: PreparedText, gold: PreparedText): boolean {
  if (!gold.normalized) return false;
  if (` ${chunk.normalized} `.includes(` ${gold.normalized} `)) return true;
  if (gold.tokens.size < MIN_OVERLAP_TOKENS) return false;
  let shared = 0;
  for (const token of gold.tokens) if (chunk.tokens.has(token)) shared += 1;
  return shared / gold.tokens.size >= OVERLAP_THRESHOLD;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

type GoldQuestion = {
  questionId: string;
  paperId: string;
  question: string;
  evidence: string[];
};

function loadQuestions(options: Options): GoldQuestion[] {
  const gold = JSON.parse(fs.readFileSync(options.gold, "utf8")) as Record<
    string,
    {
      qas?: Array<{
        question: string;
        question_id: string;
        answers?: Array<{ answer?: { evidence?: string[] } }>;
      }>;
    }
  >;
  const sampled = options.sample
    ? new Set(
        fs
          .readFileSync(options.sample, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map(
            (line) => (JSON.parse(line) as { question_id: string }).question_id,
          ),
      )
    : null;
  const questions: GoldQuestion[] = [];
  for (const [paperId, paper] of Object.entries(gold)) {
    for (const qa of paper.qas || []) {
      if (sampled && !sampled.has(qa.question_id)) continue;
      const evidence = Array.from(
        new Set(
          (qa.answers || []).flatMap((answer) =>
            (answer.answer?.evidence || []).filter((entry) => entry.trim()),
          ),
        ),
      );
      questions.push({
        questionId: qa.question_id,
        paperId,
        question: qa.question,
        evidence,
      });
    }
  }
  return questions;
}

/** paperId → `.zotero-ft-cache` path, found by the PDF stored beside it. */
function indexFullText(storage: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const key of fs.readdirSync(storage)) {
    const dir = path.join(storage, key);
    const cache = path.join(dir, ".zotero-ft-cache");
    if (!fs.existsSync(cache)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.toLowerCase().endsWith(".pdf")) {
        const stem = name.slice(0, -4);
        index.set(stem, cache);
        // arXiv downloads may carry a version suffix (1708.00160v2.pdf).
        const unversioned = stem.replace(/v\d+$/, "");
        if (!index.has(unversioned)) index.set(unversioned, cache);
      }
    }
  }
  return index;
}

// ── The shipped text path, offline ───────────────────────────────────────────

const PDF_TEXT_BY_ITEM = new Map<number, string>();

function installGlobals(): void {
  const silent = () => undefined;
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    // MinerU off: the benchmark papers were read from the PDF worker.
    Prefs: { get: () => undefined, set: silent },
    Items: { get: () => null },
    PDFWorker: {
      getFullText: async (id: number) => ({
        text: PDF_TEXT_BY_ITEM.get(id) || "",
      }),
    },
    debug: silent,
    logError: silent,
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    log: silent,
    getGlobal: (name: string) =>
      (globalThis as unknown as Record<string, unknown>)[name],
  };
}

function mockPdfAttachment(id: number): Zotero.Item {
  return {
    id,
    parentID: null,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    getField: () => "",
  } as unknown as Zotero.Item;
}

async function loadPaperContext(
  id: number,
  text: string,
): Promise<PdfContext | undefined> {
  PDF_TEXT_BY_ITEM.set(id, text);
  await ensurePDFTextCached(mockPdfAttachment(id));
  return pdfTextCache.get(id);
}

function wordCount(text: string): number {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.split(" ").length : 0;
}

function contextForVariant(
  ctx: PdfContext,
  variant: Variant,
  captionMaxWords: number,
): PdfContext {
  if (variant === "production" || !ctx.chunkMeta) return ctx;
  const chunkMeta = ctx.chunkMeta.map((meta, index) => {
    if (!meta.chunkKind || !RELABELLED_KINDS.has(meta.chunkKind)) return meta;
    const keepDemotion =
      variant === "mostly-caption" &&
      wordCount(ctx.chunks[index]) <= captionMaxWords;
    return keepDemotion ? meta : { ...meta, chunkKind: "body" as const };
  });
  return { ...ctx, chunkMeta };
}

async function rank(params: {
  paperRef: PaperContextRef;
  ctx: PdfContext;
  query: string;
  variants?: string[];
  topK: number;
}): Promise<number[]> {
  const queryPlan = buildRetrievalQueryPlan({
    query: params.query,
    ...(params.variants?.length ? { queryVariants: params.variants } : {}),
  });
  // What RetrievalService.retrieveEvidence passes for one paper.
  queryPlan.quoteAnchorPolicy = "none";
  const candidates = await buildPaperRetrievalCandidates(
    params.paperRef,
    params.ctx,
    params.query,
    { queryPlan },
    {
      topK: params.topK,
      mode: "evidence",
      queryPlan,
      disableEmbeddings: true,
    },
  );
  return candidates.map((candidate) => candidate.chunkIndex);
}

// ── Agent queries ────────────────────────────────────────────────────────────

type AgentRead = {
  questionId: string;
  query: string;
  queryVariants?: string[];
  topK: number;
  liveChunkIndexes?: number[];
};

function loadAgentReads(dir: string): AgentRead[] {
  const reads: AgentRead[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, name), "utf8"),
    ) as {
      question_id: string;
      events?: Array<Record<string, unknown>>;
    };
    const calls = new Map<string, AgentRead>();
    for (const event of record.events || []) {
      if (event.name !== "paper_read") continue;
      if (event.type === "tool_call") {
        const args = (event.args || {}) as Record<string, unknown>;
        if (args.mode !== "targeted" || typeof args.query !== "string")
          continue;
        if (Array.isArray(args.sections) && args.sections.length) continue;
        calls.set(String(event.callId), {
          questionId: record.question_id,
          query: args.query,
          queryVariants: Array.isArray(args.queryVariants)
            ? (args.queryVariants as string[])
            : undefined,
          // RetrievalService's per-paper default when the call names none.
          topK: Number.isFinite(Number(args.topK)) ? Number(args.topK) : 4,
        });
      } else if (event.type === "tool_result") {
        const call = calls.get(String(event.callId));
        if (!call) continue;
        try {
          const content = JSON.parse(String(event.content || "{}")) as {
            results?: Array<{ chunkIndex: number }>;
          };
          // A short list means passages already shown were left out, so
          // only a full-size list is comparable with a fresh ranking.
          if (content.results?.length === call.topK) {
            call.liveChunkIndexes = content.results.map(
              (result) => result.chunkIndex,
            );
          }
        } catch {
          // A truncated result in the record: no live comparison.
        }
      }
    }
    reads.push(...calls.values());
  }
  return reads;
}

// ── Report ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function describeLengths(label: string, counts: number[]): string {
  const sorted = [...counts].sort((a, b) => a - b);
  return `${label.padEnd(26)} n=${String(sorted.length).padStart(4)}  p10=${percentile(sorted, 0.1)}  p25=${percentile(sorted, 0.25)}  median=${percentile(sorted, 0.5)}  p75=${percentile(sorted, 0.75)}  p90=${percentile(sorted, 0.9)}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  installGlobals();
  const questions = loadQuestions(options);
  const fullText = indexFullText(options.storage);

  // Load every paper once through the shipped text path.
  const contexts = new Map<string, { ref: PaperContextRef; ctx: PdfContext }>();
  const chunkCountMismatches: string[] = [];
  const paperIds = Array.from(new Set(questions.map((q) => q.paperId)));
  let nextId = 1000;
  for (const paperId of paperIds) {
    const cachePath = fullText.get(paperId);
    if (!cachePath) continue;
    const id = nextId++;
    const ctx = await loadPaperContext(id, fs.readFileSync(cachePath, "utf8"));
    if (!ctx?.chunks.length) continue;
    contexts.set(paperId, {
      ref: { itemId: id + 50_000, contextItemId: id, title: paperId },
      ctx,
    });
    if (options.papers) {
      const recordPath = path.join(options.papers, `${paperId}.json`);
      if (fs.existsSync(recordPath)) {
        const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
          pluginChunks?: number;
        };
        if (record.pluginChunks !== ctx.chunks.length) {
          chunkCountMismatches.push(
            `${paperId}: run ${record.pluginChunks}, replay ${ctx.chunks.length}`,
          );
        }
      }
    }
  }

  // Chunk length distribution, the basis for the mostly-caption ceiling.
  const allLengths: number[] = [];
  const kindLengths: number[] = [];
  const kindCounts = new Map<string, number>();
  for (const { ctx } of contexts.values()) {
    ctx.chunks.forEach((chunk, index) => {
      const words = wordCount(chunk);
      allLengths.push(words);
      const kind = ctx.chunkMeta?.[index]?.chunkKind || "unknown";
      kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
      if (RELABELLED_KINDS.has(kind as PdfChunkKind)) kindLengths.push(words);
    });
  }

  const prepared = new Map<string, PreparedText[]>();
  for (const [paperId, { ctx }] of contexts) {
    prepared.set(paperId, ctx.chunks.map(prepare));
  }
  const goldChunks = (question: GoldQuestion): Set<number> => {
    const chunks = prepared.get(question.paperId) || [];
    const hits = new Set<number>();
    for (const evidence of question.evidence) {
      const gold = prepare(evidence);
      chunks.forEach((chunk, index) => {
        if (chunkContainsGold(chunk, gold)) hits.add(index);
      });
    }
    return hits;
  };

  const withEvidence = questions.filter((q) => q.evidence.length);
  const withText = withEvidence.filter((q) => contexts.has(q.paperId));
  const located = withText
    .map((question) => ({ question, gold: goldChunks(question) }))
    .filter((entry) => entry.gold.size > 0);
  let goldParagraphs = 0;
  let goldParagraphChunkMatches = 0;
  for (const question of withText) {
    const chunks = prepared.get(question.paperId) || [];
    for (const evidence of question.evidence) {
      const gold = prepare(evidence);
      const matches = chunks.filter((chunk) => chunkContainsGold(chunk, gold));
      if (matches.length) {
        goldParagraphs += 1;
        goldParagraphChunkMatches += matches.length;
      }
    }
  }

  // Question-text queries.
  const questionTable: Record<string, Record<number, number>> = {};
  const foundBy = new Map<string, Set<string>>();
  for (const variant of options.variants) {
    questionTable[variant] = {};
    for (const topK of options.topK) {
      let hits = 0;
      const found = new Set<string>();
      foundBy.set(`${variant}@${topK}`, found);
      for (const { question, gold } of located) {
        const paper = contexts.get(question.paperId)!;
        const ranked = await rank({
          paperRef: paper.ref,
          ctx: contextForVariant(paper.ctx, variant, options.captionMaxWords),
          query: question.question,
          topK,
        });
        if (ranked.some((index) => gold.has(index))) {
          hits += 1;
          found.add(question.questionId);
        }
      }
      questionTable[variant][topK] = hits;
    }
  }

  // Agent queries.
  let agentReport:
    | {
        reads: number;
        liveCompared: number;
        liveExact: number;
        table: Record<string, Record<string, number>>;
      }
    | undefined;
  if (options.agentRecords) {
    const goldByQuestion = new Map(
      located.map((entry) => [entry.question.questionId, entry] as const),
    );
    const reads = loadAgentReads(options.agentRecords).filter((read) =>
      goldByQuestion.has(read.questionId),
    );
    const table: Record<string, Record<string, number>> = {};
    let liveCompared = 0;
    let liveExact = 0;
    for (const variant of options.variants) {
      table[variant] = {};
      for (const topKLabel of ["asked", ...options.topK.map(String)]) {
        let hits = 0;
        for (const read of reads) {
          const entry = goldByQuestion.get(read.questionId)!;
          const paper = contexts.get(entry.question.paperId)!;
          const topK = topKLabel === "asked" ? read.topK : Number(topKLabel);
          const ranked = await rank({
            paperRef: paper.ref,
            ctx: contextForVariant(paper.ctx, variant, options.captionMaxWords),
            query: read.query,
            variants: read.queryVariants,
            topK,
          });
          if (ranked.some((index) => entry.gold.has(index))) hits += 1;
          if (
            variant === "production" &&
            topKLabel === "asked" &&
            read.liveChunkIndexes
          ) {
            liveCompared += 1;
            const live = [...read.liveChunkIndexes].sort((a, b) => a - b);
            const replay = [...ranked].sort((a, b) => a - b);
            if (live.join(",") === replay.join(",")) liveExact += 1;
          }
        }
        table[variant][topKLabel] = hits;
      }
    }
    agentReport = { reads: reads.length, liveCompared, liveExact, table };
  }

  // Print.
  const pct = (hits: number, total: number) =>
    total ? `${((100 * hits) / total).toFixed(1)}% (${hits}/${total})` : "n/a";
  console.log(`Questions in sample:               ${questions.length}`);
  console.log(`  with gold evidence:              ${withEvidence.length}`);
  console.log(`  of those, paper text available:  ${withText.length}`);
  console.log(`  of those, gold locatable:        ${located.length}`);
  console.log(
    `Papers loaded: ${contexts.size}; chunk-count mismatches vs run: ${
      options.papers ? chunkCountMismatches.length : "not checked"
    }`,
  );
  for (const mismatch of chunkCountMismatches) console.log(`  ${mismatch}`);
  console.log(
    `Gold paragraphs located: ${goldParagraphs}; chunks matched per located paragraph: ${(
      goldParagraphChunkMatches / Math.max(1, goldParagraphs)
    ).toFixed(2)}`,
  );
  console.log("");
  console.log("Chunk length in words (all papers):");
  console.log(`  ${describeLengths("all chunks", allLengths)}`);
  console.log(`  ${describeLengths("caption/appendix kinds", kindLengths)}`);
  console.log(
    `  kinds: ${Array.from(kindCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ")}`,
  );
  console.log(
    `  caption/appendix chunks at or under ${options.captionMaxWords} words: ${
      kindLengths.filter((words) => words <= options.captionMaxWords).length
    } of ${kindLengths.length}`,
  );
  console.log("");
  console.log("Recall of gold evidence, question text as the query:");
  for (const variant of options.variants) {
    console.log(
      `  ${variant.padEnd(15)} ${options.topK
        .map(
          (topK) =>
            `@${topK} ${pct(questionTable[variant][topK], located.length)}`,
        )
        .join("   ")}`,
    );
  }
  // Paired view: questions one variant finds and the other misses.
  const pairs: Array<[Variant, Variant]> = [
    ["production", "none"],
    ["production", "mostly-caption"],
    ["mostly-caption", "none"],
  ];
  for (const [a, b] of pairs) {
    if (!options.variants.includes(a) || !options.variants.includes(b)) {
      continue;
    }
    console.log(
      `  ${a} vs ${b}: ${options.topK
        .map((topK) => {
          const left = foundBy.get(`${a}@${topK}`)!;
          const right = foundBy.get(`${b}@${topK}`)!;
          const onlyLeft = [...left].filter((id) => !right.has(id)).length;
          const onlyRight = [...right].filter((id) => !left.has(id)).length;
          return `@${topK} only ${a} ${onlyLeft}, only ${b} ${onlyRight}`;
        })
        .join("; ")}`,
    );
  }
  if (agentReport) {
    console.log("");
    console.log(
      `Recall per agent paper_read targeted call (${agentReport.reads} calls on locatable questions):`,
    );
    for (const variant of options.variants) {
      console.log(
        `  ${variant.padEnd(15)} ${Object.entries(agentReport.table[variant])
          .map(([label, hits]) => `@${label} ${pct(hits, agentReport!.reads)}`)
          .join("   ")}`,
      );
    }
    console.log(
      `  replay 'production' equals the live result set in ${agentReport.liveExact} of ${agentReport.liveCompared} calls with a full-size recorded result`,
    );
  }

  if (options.json) {
    fs.writeFileSync(
      options.json,
      JSON.stringify(
        {
          options: { ...options },
          counts: {
            questions: questions.length,
            withEvidence: withEvidence.length,
            withText: withText.length,
            located: located.length,
            papers: contexts.size,
            chunkCountMismatches,
          },
          lengths: { all: allLengths, captionAppendix: kindLengths },
          questionTable,
          agentReport,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
