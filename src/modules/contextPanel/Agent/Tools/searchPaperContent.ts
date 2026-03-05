import { estimateTextTokens } from "../../../../utils/modelInputCap";
import { pdfTextCache } from "../../state";
import { ensurePDFTextCached } from "../../pdfContext";
import {
  SEARCH_PAPER_CONTENT_DEFAULT_TOKEN_BUDGET,
  SEARCH_PAPER_CONTENT_MAX_SNIPPETS,
  SEARCH_PAPER_CONTENT_MIN_TOKEN_BUDGET,
} from "../config";
import { normalizePaperToolTarget } from "../ToolInfra/shared";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  ResolvedAgentToolTarget,
} from "../ToolInfra/types";

export function validateSearchPaperContentCall(
  call: AgentToolCall,
): AgentToolCall | null {
  if (call.name !== "search_paper_content") return null;
  const normalizedTarget = normalizePaperToolTarget(call.target);
  if (!normalizedTarget) return null;
  const query = (call.query || "").trim();
  if (!query) return null;
  return {
    name: "search_paper_content",
    target: normalizedTarget,
    query,
  };
}

export async function executeSearchPaperContentCall(
  ctx: AgentToolExecutionContext,
  call: AgentToolCall,
  target: ResolvedAgentToolTarget,
): Promise<AgentToolExecutionResult> {
  if (!target.paperContext) {
    return {
      name: "search_paper_content",
      targetLabel: target.targetLabel,
      ok: false,
      traceLines: [
        target.error || `Tool target was unavailable: ${target.targetLabel}.`,
      ],
      groundingText: "",
      addedPaperContexts: [],
      estimatedTokens: 0,
      truncated: false,
    };
  }

  const query = (call.query || "").trim();
  if (!query) {
    return {
      name: "search_paper_content",
      targetLabel: target.targetLabel,
      ok: false,
      traceLines: ["Search skipped because no query was provided."],
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

  if (!extractable || !pdfContext?.chunks.length) {
    const groundingText = [
      "Agent Tool Result",
      "- Tool: search_paper_content",
      `- Target: ${target.targetLabel}`,
      `- Query: ${query}`,
      "- Extractable full text available: no",
      "",
      "[No extractable PDF text available. Content search could not be performed.]",
    ].join("\n");
    return {
      name: "search_paper_content",
      targetLabel: target.targetLabel,
      ok: true,
      traceLines: [
        `No extractable text for ${target.targetLabel}; content search unavailable.`,
      ],
      groundingText,
      addedPaperContexts: [target.paperContext],
      estimatedTokens: estimateTextTokens(groundingText),
      truncated: false,
    };
  }

  const lowerQuery = query.toLowerCase();
  const tokenBudget =
    Number.isFinite(ctx.toolTokenCap) && Number(ctx.toolTokenCap) > 0
      ? Math.max(SEARCH_PAPER_CONTENT_MIN_TOKEN_BUDGET, Number(ctx.toolTokenCap))
      : SEARCH_PAPER_CONTENT_DEFAULT_TOKEN_BUDGET;

  type MatchEntry = { sectionLabel: string; chunkIndex: number; text: string };
  const matches: MatchEntry[] = [];

  for (let i = 0; i < pdfContext.chunks.length; i++) {
    const chunk = pdfContext.chunks[i]!;
    if (chunk.toLowerCase().includes(lowerQuery)) {
      const meta = pdfContext.chunkMeta?.[i];
      matches.push({
        sectionLabel: meta?.sectionLabel || meta?.chunkKind || "unknown",
        chunkIndex: i,
        text: chunk,
      });
    }
  }

  if (!matches.length) {
    const groundingText = [
      "Agent Tool Result",
      "- Tool: search_paper_content",
      `- Target: ${target.targetLabel}`,
      `- Query: ${query}`,
      "- Matches found: 0",
      "",
      `[No chunks matched the search query "${query}" in the extracted paper text.]`,
    ].join("\n");
    return {
      name: "search_paper_content",
      targetLabel: target.targetLabel,
      ok: true,
      traceLines: [`Found 0 matches for "${query}" in ${target.targetLabel}.`],
      groundingText,
      addedPaperContexts: [target.paperContext],
      estimatedTokens: estimateTextTokens(groundingText),
      truncated: false,
    };
  }

  // Select matches within token budget
  const headerTokens = estimateTextTokens(
    [
      "Agent Tool Result",
      "- Tool: search_paper_content",
      `- Target: ${target.targetLabel}`,
      `- Query: ${query}`,
      `- Matches found: ${matches.length}`,
      "",
    ].join("\n"),
  );
  let remainingBudget = tokenBudget - headerTokens;
  const selectedSnippets: MatchEntry[] = [];
  let truncated = false;

  for (const match of matches) {
    if (selectedSnippets.length >= SEARCH_PAPER_CONTENT_MAX_SNIPPETS) {
      truncated = true;
      break;
    }
    const snippetTokens = estimateTextTokens(match.text) + 10; // +10 for label overhead
    if (remainingBudget <= 0) {
      truncated = true;
      break;
    }
    selectedSnippets.push(match);
    remainingBudget -= snippetTokens;
  }

  if (selectedSnippets.length < matches.length) truncated = true;

  const snippetLines: string[] = [];
  for (const snippet of selectedSnippets) {
    snippetLines.push(`[Section: ${snippet.sectionLabel}]`);
    snippetLines.push(snippet.text.trim());
    snippetLines.push("");
  }

  const groundingLines = [
    "Agent Tool Result",
    "- Tool: search_paper_content",
    `- Target: ${target.targetLabel}`,
    `- Query: ${query}`,
    `- Matches found: ${matches.length}`,
    `- Snippets returned: ${selectedSnippets.length}`,
    `- Truncated: ${truncated ? "yes" : "no"}`,
    "",
    "Matching Snippets:",
    ...snippetLines,
  ];

  const groundingText = groundingLines.join("\n");
  const estimatedTokens = estimateTextTokens(groundingText);

  return {
    name: "search_paper_content",
    targetLabel: target.targetLabel,
    ok: true,
    traceLines: [
      `Found ${matches.length} match${matches.length !== 1 ? "es" : ""} for "${query}" in ${target.targetLabel}.`,
    ],
    groundingText,
    addedPaperContexts: [target.paperContext],
    estimatedTokens,
    truncated,
  };
}
