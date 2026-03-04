import { callLLM } from "../../../../utils/llmClient";
import { estimateTextTokens } from "../../../../utils/modelInputCap";
import { pdfTextCache } from "../../state";
import {
  buildPaperRetrievalCandidates,
  ensurePDFTextCached,
  formatSuggestedEvidenceCitation,
  renderClaimEvidencePack,
} from "../../pdfContext";
import { sanitizeText } from "../../textUtils";
import { validateSinglePaperToolCall } from "./shared";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  ResolvedAgentToolTarget,
} from "./types";
import type { PaperContextCandidate } from "../../types";

const RAW_EVIDENCE_TOP_K = 12;
/** Default cap when no token budget is provided (pure count limit). */
const DEFAULT_EVIDENCE_TOP_K = 8;
/** Hard safety ceiling to avoid pathological responses (budget should control normally). */
const MAX_EVIDENCE_TOP_K = 12;
const ENABLE_FIND_CLAIM_EVIDENCE_VERIFIER = false;

type EvidenceVerifierLabel =
  | "supports"
  | "partially supports"
  | "contradicts"
  | "background only"
  | "irrelevant";

type EvidenceVerifierAssessment =
  | "supported"
  | "partially supported"
  | "unsupported"
  | "contradictory"
  | "unclear";

type EvidenceVerifierResult = {
  assessment: EvidenceVerifierAssessment;
  reasoningNote: string;
  bestSnippetIndexes: number[];
  rejectedSnippetIndexes: number[];
  snippetJudgments: EvidenceVerifierSnippetJudgment[];
};

type EvidenceVerifierSnippetJudgment = {
  index: number;
  label: EvidenceVerifierLabel;
  note?: string;
};

function normalizeEvidenceText(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeEvidenceText(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function evidenceSimilarity(a: string, b: string): number {
  const tokensA = tokenizeEvidenceText(a);
  const tokensB = tokenizeEvidenceText(b);
  if (!tokensA.size || !tokensB.size) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function dedupeEvidenceCandidates(
  candidates: PaperContextCandidate[],
): PaperContextCandidate[] {
  const deduped: PaperContextCandidate[] = [];
  for (const candidate of candidates) {
    const currentAnchor = normalizeEvidenceText(
      candidate.anchorText || candidate.chunkText,
    );
    const isDuplicate = deduped.some((existing) => {
      const existingAnchor = normalizeEvidenceText(
        existing.anchorText || existing.chunkText,
      );
      if (!currentAnchor || !existingAnchor) return false;
      if (currentAnchor === existingAnchor) return true;
      if (
        currentAnchor.length >= 48 &&
        existingAnchor.length >= 48 &&
        (currentAnchor.includes(existingAnchor) ||
          existingAnchor.includes(currentAnchor))
      ) {
        return true;
      }
      return evidenceSimilarity(currentAnchor, existingAnchor) >= 0.82;
    });
    if (!isDuplicate) {
      deduped.push(candidate);
    }
  }
  return deduped;
}

function queryAsksAboutReferences(question: string): boolean {
  return /\b(?:reference|references|bibliography|cite|cites|citation|citations|prior work|related work)\b/i.test(
    question,
  );
}

function queryAsksAboutFigures(question: string): boolean {
  return /\b(?:figure|fig\.?|table|caption|plot|diagram|visualization)\b/i.test(
    question,
  );
}

function filterEvidenceCandidates(
  candidates: PaperContextCandidate[],
  question: string,
): PaperContextCandidate[] {
  const wantsReferences = queryAsksAboutReferences(question);
  const wantsFigures = queryAsksAboutFigures(question);
  const filtered = candidates.filter((candidate) => {
    switch (candidate.chunkKind) {
      case "references":
        return wantsReferences;
      case "figure-caption":
      case "table-caption":
        return wantsFigures;
      case "appendix":
        return false;
      default:
        return true;
    }
  });
  return filtered.length ? filtered : candidates;
}

function selectEvidenceCandidates(
  candidates: PaperContextCandidate[],
  toolTokenCap?: number,
): { selected: PaperContextCandidate[]; truncated: boolean } {
  const deduped = dedupeEvidenceCandidates(candidates);
  const maxTokens = Math.floor(Number(toolTokenCap));
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    // No budget provided — fall back to a fixed count cap.
    return {
      selected: deduped.slice(0, DEFAULT_EVIDENCE_TOP_K),
      truncated: deduped.length > DEFAULT_EVIDENCE_TOP_K,
    };
  }

  // Budget-aware selection: include as many snippets as the token budget
  // allows, up to the hard safety ceiling.
  const selected: PaperContextCandidate[] = [];
  let usedTokens = 0;
  for (const candidate of deduped) {
    if (selected.length >= MAX_EVIDENCE_TOP_K) break;
    const nextTokens = usedTokens + candidate.estimatedTokens;
    if (selected.length && nextTokens > maxTokens) break;
    if (!selected.length && candidate.estimatedTokens > maxTokens) {
      return { selected: [], truncated: true };
    }
    if (nextTokens > maxTokens) break;
    selected.push(candidate);
    usedTokens = nextTokens;
  }
  return {
    selected,
    truncated: selected.length < deduped.length,
  };
}

function findJsonObject(raw: string): string {
  const source = sanitizeText(raw || "");
  const start = source.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return "";
}

function normalizeVerifierLabel(value: unknown): EvidenceVerifierLabel {
  const normalized = normalizeEvidenceText(String(value || "")).toLowerCase();
  switch (normalized) {
    case "supports":
    case "partially supports":
    case "contradicts":
    case "background only":
    case "irrelevant":
      return normalized;
    default:
      return "irrelevant";
  }
}

function normalizeVerifierAssessment(
  value: unknown,
): EvidenceVerifierAssessment {
  const normalized = normalizeEvidenceText(String(value || "")).toLowerCase();
  switch (normalized) {
    case "supported":
    case "partially supported":
    case "unsupported":
    case "contradictory":
    case "unclear":
      return normalized;
    default:
      return "unclear";
  }
}

function normalizeVerifierIndexes(
  value: unknown,
  maxIndex: number,
): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const entry of value) {
    const parsed = Number(entry);
    if (!Number.isFinite(parsed)) continue;
    const normalized = Math.floor(parsed);
    if (normalized < 1 || normalized > maxIndex || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function verifyClaimEvidence(params: {
  question: string;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  paperLabel: string;
  candidates: PaperContextCandidate[];
}): Promise<EvidenceVerifierResult | null> {
  if (!ENABLE_FIND_CLAIM_EVIDENCE_VERIFIER || !params.candidates.length) {
    return null;
  }
  const snippetLines = params.candidates.map((candidate, index) => {
    return [
      `Snippet ${index + 1}`,
      `Citation: ${formatSuggestedEvidenceCitation(
        {
          itemId: candidate.itemId,
          contextItemId: candidate.contextItemId,
          title: candidate.title,
          citationKey: candidate.citationKey,
          firstCreator: candidate.firstCreator,
          year: candidate.year,
        },
        candidate,
      )}`,
      `Excerpt: ${normalizeEvidenceText(candidate.chunkText)}`,
    ].join("\n");
  });
  const prompt = [
    "You are verifying whether retrieved snippets support a claim from one paper.",
    `Paper: ${params.paperLabel}`,
    `Claim or query: ${normalizeEvidenceText(params.question)}`,
    "",
    "Classify each snippet as exactly one of:",
    '- "supports"',
    '- "partially supports"',
    '- "contradicts"',
    '- "background only"',
    '- "irrelevant"',
    "",
    "Return JSON only with this shape:",
    '{"assessment":"supported|partially supported|unsupported|contradictory|unclear","reasoningNote":"...","bestSnippetIndexes":[1],"rejectedSnippetIndexes":[2],"snippetJudgments":[{"index":1,"label":"supports","note":"..."}]}',
    "",
    "Snippets:",
    snippetLines.join("\n\n"),
  ].join("\n");
  try {
    const raw = await callLLM({
      prompt,
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      temperature: 0,
      maxTokens: 500,
    });
    const jsonText = findJsonObject(raw);
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const bestSnippetIndexes = normalizeVerifierIndexes(
      parsed.bestSnippetIndexes,
      params.candidates.length,
    );
    const rejectedSnippetIndexes = normalizeVerifierIndexes(
      parsed.rejectedSnippetIndexes,
      params.candidates.length,
    );
    const snippetJudgments = Array.isArray(parsed.snippetJudgments)
      ? parsed.snippetJudgments
          .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const typed = entry as Record<string, unknown>;
            const index = Number(typed.index);
            if (!Number.isFinite(index)) return null;
            const normalizedIndex = Math.floor(index);
            if (
              normalizedIndex < 1 ||
              normalizedIndex > params.candidates.length
            ) {
              return null;
            }
            const note =
              typeof typed.note === "string" && typed.note.trim()
                ? typed.note.trim()
                : undefined;
            const judgment: EvidenceVerifierSnippetJudgment = {
              index: normalizedIndex,
              label: normalizeVerifierLabel(typed.label),
            };
            if (note) {
              judgment.note = note;
            }
            return judgment;
          })
          .filter(
            (
              entry,
            ): entry is EvidenceVerifierSnippetJudgment => entry !== null,
          )
      : [];
    return {
      assessment: normalizeVerifierAssessment(parsed.assessment),
      reasoningNote:
        typeof parsed.reasoningNote === "string" && parsed.reasoningNote.trim()
          ? parsed.reasoningNote.trim()
          : "Verifier output was unavailable.",
      bestSnippetIndexes,
      rejectedSnippetIndexes,
      snippetJudgments,
    };
  } catch (err) {
    ztoolkit.log("LLM: find_claim_evidence verifier failed", err);
    return null;
  }
}

export function validateFindClaimEvidenceCall(
  call: AgentToolCall,
): AgentToolCall | null {
  return validateSinglePaperToolCall("find_claim_evidence", call);
}

export async function executeFindClaimEvidenceCall(
  ctx: AgentToolExecutionContext,
  _call: AgentToolCall,
  target: ResolvedAgentToolTarget,
): Promise<AgentToolExecutionResult> {
  if (!target.paperContext) {
    return {
      name: "find_claim_evidence",
      targetLabel: target.targetLabel,
      ok: false,
      traceLines: [target.error || `Tool target was unavailable: ${target.targetLabel}.`],
      groundingText: "",
      addedPaperContexts: [],
      estimatedTokens: 0,
      truncated: false,
    };
  }

  const claimOrQuery = sanitizeText(ctx.question || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!claimOrQuery) {
    return {
      name: "find_claim_evidence",
      targetLabel: target.targetLabel,
      ok: false,
      traceLines: ["Claim-evidence lookup was skipped because the query was empty."],
      groundingText: "",
      addedPaperContexts: [],
      estimatedTokens: 0,
      truncated: false,
    };
  }

  if (target.contextItem) {
    await ensurePDFTextCached(target.contextItem);
  }
  const pdfContext = target.contextItem
    ? pdfTextCache.get(target.contextItem.id)
    : undefined;
  const extractable = Boolean(pdfContext?.chunks.length);
  const candidates = extractable
    ? await buildPaperRetrievalCandidates(
        target.paperContext,
        pdfContext,
        claimOrQuery,
        {
          apiBase: ctx.apiBase,
          apiKey: ctx.apiKey,
        },
        { topK: RAW_EVIDENCE_TOP_K, mode: "evidence" },
      )
    : [];
  const filteredCandidates = filterEvidenceCandidates(candidates, claimOrQuery);
  const { selected, truncated } = selectEvidenceCandidates(
    filteredCandidates,
    ctx.toolTokenCap,
  );
  const verifierResult = await verifyClaimEvidence({
    question: claimOrQuery,
    model: undefined,
    apiBase: ctx.apiBase,
    apiKey: ctx.apiKey,
    paperLabel: target.targetLabel,
    candidates: selected,
  });
  const evidencePack = selected.length
    ? renderClaimEvidencePack({
        paper: target.paperContext,
        candidates: selected,
      })
    : "";
  const emptyReason = !extractable
    ? "[No extractable PDF text available. Evidence lookup could not inspect the paper body.]"
    : filteredCandidates.length && !selected.length
      ? "[Relevant evidence snippets existed, but none fit inside the current tool budget.]"
      : "[No matching evidence snippets were retrieved from the extracted paper text.]";
  const groundingLines = [
    "Agent Tool Result",
    "- Tool: find_claim_evidence",
    `- Target: ${target.targetLabel}`,
    `- Claim or query: ${claimOrQuery}`,
    `- Extractable full text available: ${extractable ? "yes" : "no"}`,
    `- Evidence snippets returned: ${selected.length}`,
    `- Truncated: ${truncated ? "yes" : "no"}`,
    verifierResult
      ? `- Claim assessment: ${verifierResult.assessment}`
      : "- Claim assessment: not verified by a second model pass",
    "",
    selected.length ? evidencePack : emptyReason,
    verifierResult
      ? [
          "",
          "Verifier Summary:",
          `- Assessment: ${verifierResult.assessment}`,
          `- Reasoning note: ${verifierResult.reasoningNote}`,
          `- Best supporting snippets: ${
            verifierResult.bestSnippetIndexes.length
              ? verifierResult.bestSnippetIndexes.join(", ")
              : "none"
          }`,
          `- Rejected snippets: ${
            verifierResult.rejectedSnippetIndexes.length
              ? verifierResult.rejectedSnippetIndexes.join(", ")
              : "none"
          }`,
        ].join("\n")
      : "",
  ];
  const groundingText = groundingLines.join("\n");
  const traceLines = [
    selected.length
      ? `Retrieved ${selected.length} evidence snippet${selected.length === 1 ? "" : "s"} for ${target.targetLabel}.`
      : extractable
        ? `No strong evidence snippets were found for ${target.targetLabel}.`
        : `Evidence lookup could not read text for ${target.targetLabel}.`,
  ];

  return {
    name: "find_claim_evidence",
    targetLabel: target.targetLabel,
    ok: true,
    traceLines,
    groundingText,
    addedPaperContexts: [target.paperContext],
    estimatedTokens: estimateTextTokens(groundingText),
    truncated,
  };
}
