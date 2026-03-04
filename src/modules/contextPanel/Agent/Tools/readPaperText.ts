import { pdfTextCache } from "../../state";
import {
  buildTruncatedFullPaperContext,
  ensurePDFTextCached,
} from "../../pdfContext";
import { validateSinglePaperToolCall } from "./shared";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  ResolvedAgentToolTarget,
} from "./types";

export function validateReadPaperTextCall(
  call: AgentToolCall,
): AgentToolCall | null {
  return validateSinglePaperToolCall("read_paper_text", call);
}

export async function executeReadPaperTextCall(
  ctx: AgentToolExecutionContext,
  _call: AgentToolCall,
  target: ResolvedAgentToolTarget,
): Promise<AgentToolExecutionResult> {
  if (!target.paperContext) {
    return {
      name: "read_paper_text",
      targetLabel: target.targetLabel,
      ok: false,
      traceLines: [target.error || `Tool target was unavailable: ${target.targetLabel}.`],
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
  const fullPaper = buildTruncatedFullPaperContext(
    target.paperContext,
    pdfContext,
    {
      maxTokens:
        Number.isFinite(ctx.toolTokenCap) && Number(ctx.toolTokenCap) > 0
          ? Math.max(1, Math.floor(Number(ctx.toolTokenCap)))
          : Number.MAX_SAFE_INTEGER,
    },
  );
  const extractable = Boolean(pdfContext?.chunks.length);
  const groundingLines = [
    "Agent Tool Result",
    "- Tool: read_paper_text",
    `- Target: ${target.targetLabel}`,
    `- Extractable full text available: ${extractable ? "yes" : "no"}`,
    `- Returned full text excerpt: ${extractable && fullPaper.text.includes("Paper Text:") ? "yes" : "no"}`,
    `- Truncated: ${fullPaper.truncated ? "yes" : "no"}`,
    `- Estimated tool tokens: ${fullPaper.estimatedTokens}`,
    "",
    fullPaper.text,
  ];
  const traceLines = [
    extractable
      ? `Loaded full text for ${target.targetLabel}${fullPaper.truncated ? " (truncated by tool budget)." : "."}`
      : `Full text unavailable for ${target.targetLabel}; using metadata only.`,
  ];

  return {
    name: "read_paper_text",
    targetLabel: target.targetLabel,
    ok: true,
    traceLines,
    groundingText: groundingLines.join("\n"),
    addedPaperContexts: [target.paperContext],
    estimatedTokens: fullPaper.estimatedTokens,
    truncated: fullPaper.truncated,
  };
}
