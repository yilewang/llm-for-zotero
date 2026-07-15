import type { PaperContextRef } from "./types";
import type { PdfContext } from "../modules/contextPanel/types";
import { estimateTextTokens } from "../utils/modelInputCap";
import { callLLM, type ChatParams } from "../utils/llmClient";

export type ExhaustiveReadStatus = "complete" | "partial" | "unreadable";

export type ExhaustiveSourceChunk = {
  paperKey: string;
  paperTitle: string;
  chunkIndex: number;
  text: string;
  sectionLabel?: string;
  sourceStart?: number;
  sourceEnd?: number;
};

export type ExhaustiveBatchInput = {
  paperContext: PaperContextRef;
  paperKey: string;
  paperTitle: string;
  documentFingerprint: string;
  batchIndex: number;
  batchCount: number;
  question: string;
  chunks: ExhaustiveSourceChunk[];
  signal?: AbortSignal;
};

export type ExhaustiveBatchOutput = {
  digest: string;
  relevantChunkIds: number[];
};

export type ExhaustiveBatchAnalyzer = (
  input: ExhaustiveBatchInput,
) => Promise<ExhaustiveBatchOutput>;

export type ExhaustiveBatchCompletionInput = {
  prompt: string;
  systemMessages: string[];
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
};

export type ExhaustiveBatchCompletion = (
  input: ExhaustiveBatchCompletionInput,
) => Promise<string>;

export type FullReadPaperResult = {
  paperContext: PaperContextRef;
  paperKey: string;
  documentFingerprint: string;
  status: ExhaustiveReadStatus;
  processedChunks: number;
  totalChunks: number;
  missingChunkRanges: string[];
  digests: Array<{
    batchIndex: number;
    chunkIndexes: number[];
    digest: string;
  }>;
  exactEvidence: ExhaustiveSourceChunk[];
  warnings: string[];
};

export type FullReadCoverageReceipt = {
  text: string;
  complete: boolean;
  processedChunks: number;
  totalChunks: number;
  missingChunkRanges: string[];
  paperCount: number;
  completePaperCount: number;
};

export type ExhaustiveDocumentReadResult = {
  status: ExhaustiveReadStatus;
  papers: FullReadPaperResult[];
  receipt: FullReadCoverageReceipt;
  contextText: string;
  warnings: string[];
};

type PaperInput = {
  paperContext: PaperContextRef;
  pdfContext?: PdfContext;
};

type LlmBatchConfig = Pick<
  ChatParams,
  "model" | "apiBase" | "apiKey" | "authMode" | "providerProtocol" | "reasoning"
>;

export type ExhaustiveDocumentReaderParams = {
  papers: PaperInput[];
  question: string;
  batchTokenBudget: number;
  finalTokenBudget: number;
  retryCount?: number;
  analyzeBatch?: ExhaustiveBatchAnalyzer;
  llm?: LlmBatchConfig;
  signal?: AbortSignal;
  onProgress?: (progress: {
    paperIndex: number;
    paperCount: number;
    batchIndex: number;
    batchCount: number;
  }) => void;
};

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildDocumentFingerprint(
  paperContext: PaperContextRef,
  pdfContext: PdfContext,
): string {
  const signature = [
    paperContext.itemId,
    paperContext.contextItemId,
    pdfContext.sourceType || "unknown",
    pdfContext.chunks.length,
    pdfContext.fullLength,
    pdfContext.chunks.map((chunk) => `${chunk.length}:${chunk}`).join("|"),
  ].join("::");
  return hashText(signature);
}

function buildSourceChunks(
  paperContext: PaperContextRef,
  pdfContext: PdfContext,
): ExhaustiveSourceChunk[] {
  const paperKey = `${paperContext.itemId}:${paperContext.contextItemId}`;
  return pdfContext.chunks.map((text, chunkIndex) => {
    const meta = pdfContext.chunkMeta?.[chunkIndex];
    return {
      paperKey,
      paperTitle: paperContext.title,
      chunkIndex,
      text,
      sectionLabel: meta?.sectionLabel,
      sourceStart: meta?.sourceStart,
      sourceEnd: meta?.sourceEnd,
    };
  });
}

function partitionChunks(
  chunks: ExhaustiveSourceChunk[],
  tokenBudget: number,
): ExhaustiveSourceChunk[][] {
  const budget = Math.max(1, Math.floor(tokenBudget));
  const batches: ExhaustiveSourceChunk[][] = [];
  let current: ExhaustiveSourceChunk[] = [];
  let currentTokens = 0;
  for (const chunk of chunks) {
    const chunkTokens = Math.max(1, estimateTextTokens(chunk.text));
    if (current.length && currentTokens + chunkTokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(chunk);
    currentTokens += chunkTokens;
  }
  if (current.length) batches.push(current);
  return batches;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates = [
    text.trim(),
    text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || "",
    text.match(/\{[\s\S]*\}/)?.[0] || "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next extraction shape.
    }
  }
  return null;
}

export function createExhaustiveBatchAnalyzer(
  complete: ExhaustiveBatchCompletion,
): ExhaustiveBatchAnalyzer {
  return async (input) => {
    const source = input.chunks
      .map(
        (chunk) =>
          `[chunk ${chunk.chunkIndex}${chunk.sectionLabel ? `; section=${chunk.sectionLabel}` : ""}]\n${chunk.text}`,
      )
      .join("\n\n");
    const raw = await complete({
      prompt: [
        "Read every supplied source chunk and create a grounded batch digest for later synthesis.",
        'Return strict JSON only: {"digest":"...","relevantChunkIds":[0]}.',
        "The digest must cover the batch broadly, not only the query-relevant sentences.",
        "Only return chunk IDs that appear in this batch.",
        `User question: ${input.question}`,
        "",
        source,
      ].join("\n"),
      maxTokens: 700,
      temperature: 0,
      signal: input.signal,
      systemMessages: [
        "You are an exhaustive document-reading worker. Return JSON only and never invent missing text.",
      ],
    });
    const parsed = extractJsonObject(raw);
    const digest = normalizeText(parsed?.digest);
    if (!digest) throw new Error("The exhaustive reader returned no digest");
    const relevantChunkIds = Array.isArray(parsed?.relevantChunkIds)
      ? parsed.relevantChunkIds
          .map((value) => Math.floor(Number(value)))
          .filter((value) => Number.isFinite(value))
      : [];
    return { digest, relevantChunkIds };
  };
}

function createLlmBatchAnalyzer(
  config: LlmBatchConfig,
): ExhaustiveBatchAnalyzer {
  return createExhaustiveBatchAnalyzer((input) =>
    callLLM({
      ...config,
      ...input,
    }),
  );
}

function missingRanges(total: number, processed: Set<number>): string[] {
  const ranges: string[] = [];
  let start = -1;
  for (let index = 0; index <= total; index += 1) {
    const missing = index < total && !processed.has(index);
    if (missing && start < 0) start = index;
    if (!missing && start >= 0) {
      const end = index - 1;
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = -1;
    }
  }
  return ranges;
}

function compactContextText(
  papers: FullReadPaperResult[],
  receiptText: string,
  tokenBudget: number,
): string {
  const header = ["Exhaustive Full-Text Reading:", receiptText, ""].join("\n");
  const records = papers.flatMap((paper) =>
    paper.digests.map((digest) => ({ paper, digest })),
  );
  const evidence = papers.flatMap((paper) => paper.exactEvidence);
  const availableChars = Math.max(800, Math.floor(tokenBudget * 3.2));
  const digestChars = Math.max(
    120,
    Math.floor((availableChars * 0.65) / Math.max(1, records.length)),
  );
  const digestText = records
    .map(
      ({ paper, digest }) =>
        `Paper: ${paper.paperContext.title}\nBatch ${digest.batchIndex + 1}; chunks ${digest.chunkIndexes.join(", ")}\n${digest.digest.slice(0, digestChars)}`,
    )
    .join("\n\n");
  let text = `${header}${digestText}`.trim();
  for (const chunk of evidence) {
    const block = `\n\nExact source excerpt [${chunk.paperTitle}; chunk ${chunk.chunkIndex}]:\n${chunk.text}`;
    if (estimateTextTokens(text + block) > tokenBudget) break;
    text += block;
  }
  if (estimateTextTokens(text) <= tokenBudget) return text;
  return text.slice(0, availableChars).trim();
}

async function analyzeWithRetries(params: {
  analyzer: ExhaustiveBatchAnalyzer;
  input: ExhaustiveBatchInput;
  retryCount: number;
}): Promise<ExhaustiveBatchOutput> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= params.retryCount; attempt += 1) {
    try {
      return await params.analyzer(params.input);
    } catch (error) {
      lastError = error;
      if (params.input.signal?.aborted) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function readDocumentsExhaustively(
  params: ExhaustiveDocumentReaderParams,
): Promise<ExhaustiveDocumentReadResult> {
  const analyzer =
    params.analyzeBatch ||
    (params.llm ? createLlmBatchAnalyzer(params.llm) : null);
  if (!analyzer) {
    throw new Error(
      "An exhaustive batch analyzer or LLM configuration is required",
    );
  }
  const retryCount = Number.isFinite(params.retryCount)
    ? Math.max(0, Math.floor(params.retryCount as number))
    : 1;
  const paperResults: FullReadPaperResult[] = [];
  const warnings: string[] = [];

  for (const [paperIndex, paper] of params.papers.entries()) {
    if (params.signal?.aborted) throw new Error("Aborted");
    const paperKey = `${paper.paperContext.itemId}:${paper.paperContext.contextItemId}`;
    const pdfContext = paper.pdfContext;
    if (!pdfContext?.chunks.length) {
      const warning = `${paper.paperContext.title}: no extractable full text was available.`;
      warnings.push(warning);
      paperResults.push({
        paperContext: paper.paperContext,
        paperKey,
        documentFingerprint: "unreadable",
        status: "unreadable",
        processedChunks: 0,
        totalChunks: 0,
        missingChunkRanges: [],
        digests: [],
        exactEvidence: [],
        warnings: [warning],
      });
      continue;
    }
    const sourceChunks = buildSourceChunks(paper.paperContext, pdfContext);
    const batches = partitionChunks(sourceChunks, params.batchTokenBudget);
    const documentFingerprint = buildDocumentFingerprint(
      paper.paperContext,
      pdfContext,
    );
    const processed = new Set<number>();
    const digests: FullReadPaperResult["digests"] = [];
    const exactEvidence: ExhaustiveSourceChunk[] = [];
    const paperWarnings: string[] = [];

    for (const [batchIndex, chunks] of batches.entries()) {
      if (params.signal?.aborted) throw new Error("Aborted");
      params.onProgress?.({
        paperIndex,
        paperCount: params.papers.length,
        batchIndex,
        batchCount: batches.length,
      });
      const input: ExhaustiveBatchInput = {
        paperContext: paper.paperContext,
        paperKey,
        paperTitle: paper.paperContext.title,
        documentFingerprint,
        batchIndex,
        batchCount: batches.length,
        question: params.question,
        chunks,
        signal: params.signal,
      };
      try {
        const output = await analyzeWithRetries({
          analyzer,
          input,
          retryCount,
        });
        if (!normalizeText(output.digest)) {
          throw new Error("The exhaustive reader returned no digest");
        }
        const allowed = new Set(chunks.map((chunk) => chunk.chunkIndex));
        const relevant = Array.from(
          new Set(
            output.relevantChunkIds.filter((chunkIndex) =>
              allowed.has(chunkIndex),
            ),
          ),
        );
        for (const chunk of chunks) processed.add(chunk.chunkIndex);
        for (const chunkIndex of relevant) {
          const chunk = chunks.find((entry) => entry.chunkIndex === chunkIndex);
          if (chunk) exactEvidence.push(chunk);
        }
        digests.push({
          batchIndex,
          chunkIndexes: chunks.map((chunk) => chunk.chunkIndex),
          digest: normalizeText(output.digest),
        });
      } catch (error) {
        if (params.signal?.aborted) throw error;
        const warning = `${paper.paperContext.title}: batch ${batchIndex + 1}/${batches.length} failed: ${error instanceof Error ? error.message : String(error)}`;
        paperWarnings.push(warning);
        warnings.push(warning);
      }
    }

    const missingChunkRanges = missingRanges(sourceChunks.length, processed);
    paperResults.push({
      paperContext: paper.paperContext,
      paperKey,
      documentFingerprint,
      status: missingChunkRanges.length ? "partial" : "complete",
      processedChunks: processed.size,
      totalChunks: sourceChunks.length,
      missingChunkRanges,
      digests,
      exactEvidence,
      warnings: paperWarnings,
    });
  }

  const processedChunks = paperResults.reduce(
    (sum, paper) => sum + paper.processedChunks,
    0,
  );
  const totalChunks = paperResults.reduce(
    (sum, paper) => sum + paper.totalChunks,
    0,
  );
  const missingChunkRanges = paperResults.flatMap((paper) =>
    paper.missingChunkRanges.map(
      (range) => `${paper.paperContext.title}: ${range}`,
    ),
  );
  const completePaperCount = paperResults.filter(
    (paper) => paper.status === "complete",
  ).length;
  const complete =
    paperResults.length > 0 && completePaperCount === paperResults.length;
  const status: ExhaustiveReadStatus = complete
    ? "complete"
    : paperResults.every((paper) => paper.status === "unreadable")
      ? "unreadable"
      : "partial";
  const receipt: FullReadCoverageReceipt = {
    text: [
      "Full-text reading receipt:",
      `- Status: ${status}`,
      `- Papers complete: ${completePaperCount}/${paperResults.length}`,
      `- Source coverage: ${processedChunks}/${totalChunks} chunks`,
      `- Missing ranges: ${missingChunkRanges.length ? missingChunkRanges.join("; ") : "none"}`,
    ].join("\n"),
    complete,
    processedChunks,
    totalChunks,
    missingChunkRanges,
    paperCount: paperResults.length,
    completePaperCount,
  };
  return {
    status,
    papers: paperResults,
    receipt,
    contextText: compactContextText(
      paperResults,
      receipt.text,
      Math.max(256, params.finalTokenBudget),
    ),
    warnings,
  };
}
