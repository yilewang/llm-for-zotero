import type { PaperContextRef } from "./types";
import type { PdfContext } from "../modules/contextPanel/types";
import {
  estimateTextTokens,
  sliceTextToTokenBudget,
} from "../utils/modelInputCap";
import { callLLM, type ChatParams } from "../utils/llmClient";

export type ExhaustiveReadStatus = "complete" | "partial" | "unreadable";

const NO_EXTRACTABLE_TEXT_COVERAGE = "no extractable text";

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
  | "model"
  | "apiBase"
  | "apiKey"
  | "authMode"
  | "providerProtocol"
  | "reasoning"
  | "profileOverride"
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

type CompactContextPart = {
  prefix: string;
  text: string;
};

const MIN_COMPACT_DIGEST_CHARS = 24;

function formatIndexRanges(indexes: number[]): string {
  if (!indexes.length) return "-";
  const sorted = Array.from(new Set(indexes)).sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = start;
  for (let index = 1; index < sorted.length; index += 1) {
    const value = sorted[index];
    if (value === end + 1) {
      end = value;
      continue;
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    start = value;
    end = value;
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(",");
}

function compactBalancedText(text: string, maxChars: number): string {
  const budget = Math.max(0, Math.floor(maxChars));
  if (!budget || !text) return "";
  if (text.length <= budget) return text;
  if (budget < 5) return text.slice(0, budget);
  const contentBudget = budget - 1;
  const leadingChars = Math.ceil(contentBudget * 0.7);
  const trailingChars = contentBudget - leadingChars;
  return `${text.slice(0, leadingChars)}…${text.slice(-trailingChars)}`;
}

function allocateFairCharacterBudgets(
  parts: CompactContextPart[],
  maxChars: number,
  minimumCharsPerPart = 1,
): number[] {
  const allocations = parts.map(() => 0);
  let remaining = Math.max(0, Math.floor(maxChars));
  let active = parts
    .map((part, index) => ({ index, length: part.text.length }))
    .filter((part) => part.length > 0);

  // Give every non-empty record its minimum share before expanding any one.
  for (const part of active) {
    if (!remaining) break;
    const granted = Math.min(part.length, minimumCharsPerPart, remaining);
    allocations[part.index] = granted;
    remaining -= granted;
  }
  active = active.filter((part) => allocations[part.index] < part.length);

  while (remaining > 0 && active.length) {
    const fairShare = Math.max(1, Math.floor(remaining / active.length));
    const nextActive: typeof active = [];
    for (const part of active) {
      if (!remaining) {
        nextActive.push(part);
        continue;
      }
      const available = part.length - allocations[part.index];
      const granted = Math.min(available, fairShare, remaining);
      allocations[part.index] += granted;
      remaining -= granted;
      if (allocations[part.index] < part.length) nextActive.push(part);
    }
    active = nextActive;
  }
  return allocations;
}

function compactContextText(
  papers: FullReadPaperResult[],
  receiptText: string,
  tokenBudget: number,
): string {
  const header = ["Exhaustive Full-Text Reading:", receiptText].join("\n");
  const digestParts: CompactContextPart[] = [];
  const allEvidenceParts: CompactContextPart[] = [];
  for (const [paperIndex, paper] of papers.entries()) {
    const paperNumber = paperIndex + 1;
    if (paper.digests.length) {
      digestParts.push({
        prefix: `P${paperNumber}=`,
        text: paper.paperContext.title,
      });
    }
    for (const digest of paper.digests) {
      digestParts.push({
        prefix: `P${paperNumber}B${digest.batchIndex + 1}C${formatIndexRanges(digest.chunkIndexes)}=`,
        text: digest.digest,
      });
    }
    for (const chunk of paper.exactEvidence) {
      allEvidenceParts.push({
        prefix: `P${paperNumber}C${chunk.chunkIndex}=`,
        text: chunk.text,
      });
    }
  }
  let evidenceParts = allEvidenceParts;

  const render = (
    digestAllocations: number[],
    evidenceAllocations: number[],
  ): string => {
    const sections = [header];
    if (digestParts.length) {
      sections.push(
        [
          "Digest map (P=paper, B=batch, C=source chunks):",
          ...digestParts.map(
            (part, index) =>
              `${part.prefix}${compactBalancedText(part.text, digestAllocations[index] || 0)}`,
          ),
        ].join("\n"),
      );
    }
    if (evidenceParts.length) {
      sections.push(
        [
          "Exact evidence map (P=paper, C=source chunk):",
          ...evidenceParts.map(
            (part, index) =>
              `${part.prefix}${compactBalancedText(part.text, evidenceAllocations[index] || 0)}`,
          ),
        ].join("\n"),
      );
    }
    return sections.join("\n\n").trim();
  };

  let fixedText = render(
    digestParts.map(() => 0),
    evidenceParts.map(() => 0),
  );
  const minimumDigestContentChars = digestParts.reduce(
    (sum, part) => sum + Math.min(part.text.length, MIN_COMPACT_DIGEST_CHARS),
    0,
  );
  const preferredMaxChars = Math.max(800, Math.floor(tokenBudget * 3.2));
  const hardMaxChars = Math.max(800, Math.floor(tokenBudget * 4));
  if (
    evidenceParts.length &&
    fixedText.length + minimumDigestContentChars > preferredMaxChars
  ) {
    // Exact excerpts are optional supporting material. Never let their labels
    // crowd out a digest from a successfully processed source batch.
    evidenceParts = [];
    fixedText = render(
      digestParts.map(() => 0),
      [],
    );
  }
  if (fixedText.length + minimumDigestContentChars > hardMaxChars) {
    throw new Error(
      "The full-read synthesis budget is too small to preserve its coverage receipt and every batch digest. Increase the model input-token cap or read fewer papers.",
    );
  }
  const maxChars = Math.min(
    hardMaxChars,
    Math.max(preferredMaxChars, fixedText.length + minimumDigestContentChars),
  );
  const contentBudget = Math.max(0, maxChars - fixedText.length);
  const digestContentLength = digestParts.reduce(
    (sum, part) => sum + part.text.length,
    0,
  );
  const evidenceContentLength = evidenceParts.reduce(
    (sum, part) => sum + part.text.length,
    0,
  );
  let evidenceBudget = evidenceParts.length
    ? Math.min(evidenceContentLength, Math.floor(contentBudget * 0.25))
    : 0;
  evidenceBudget = Math.min(
    evidenceBudget,
    Math.max(0, contentBudget - minimumDigestContentChars),
  );
  let digestBudget = Math.min(
    digestContentLength,
    contentBudget - evidenceBudget,
  );
  let unallocatedBudget = contentBudget - digestBudget - evidenceBudget;
  const extraDigestBudget = Math.min(
    unallocatedBudget,
    digestContentLength - digestBudget,
  );
  digestBudget += extraDigestBudget;
  unallocatedBudget -= extraDigestBudget;
  evidenceBudget += Math.min(
    unallocatedBudget,
    evidenceContentLength - evidenceBudget,
  );

  const rendered = render(
    allocateFairCharacterBudgets(
      digestParts,
      digestBudget,
      MIN_COMPACT_DIGEST_CHARS,
    ),
    allocateFairCharacterBudgets(evidenceParts, evidenceBudget),
  );
  // The char allocations above assume ~4 chars/token; CJK content weighs
  // double, so clamp the final digest to the real token budget.
  return estimateTextTokens(rendered) <= tokenBudget
    ? rendered
    : sliceTextToTokenBudget(rendered, tokenBudget);
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
        missingChunkRanges: [NO_EXTRACTABLE_TEXT_COVERAGE],
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
      `- Missing coverage: ${missingChunkRanges.length ? missingChunkRanges.join("; ") : "none"}`,
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
