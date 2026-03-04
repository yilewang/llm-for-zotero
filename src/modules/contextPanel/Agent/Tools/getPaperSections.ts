import { estimateTextTokens } from "../../../../utils/modelInputCap";
import { pdfTextCache } from "../../state";
import { ensurePDFTextCached } from "../../pdfContext";
import { validateSinglePaperToolCall } from "../ToolInfra/shared";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  ResolvedAgentToolTarget,
} from "../ToolInfra/types";

export function validateGetPaperSectionsCall(
  call: AgentToolCall,
): AgentToolCall | null {
  return validateSinglePaperToolCall("get_paper_sections", call);
}

export async function executeGetPaperSectionsCall(
  _ctx: AgentToolExecutionContext,
  _call: AgentToolCall,
  target: ResolvedAgentToolTarget,
): Promise<AgentToolExecutionResult> {
  if (!target.paperContext) {
    return {
      name: "get_paper_sections",
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

  if (target.contextItem) {
    await ensurePDFTextCached(target.contextItem);
  }

  const pdfContext = target.contextItem
    ? pdfTextCache.get(target.contextItem.id)
    : undefined;
  const extractable = Boolean(pdfContext?.chunks.length);

  if (!extractable || !pdfContext?.chunkMeta?.length) {
    const groundingText = [
      "Agent Tool Result",
      "- Tool: get_paper_sections",
      `- Target: ${target.targetLabel}`,
      "- Extractable full text available: no",
      "",
      "[No extractable PDF text available. Section outline could not be built.]",
    ].join("\n");
    return {
      name: "get_paper_sections",
      targetLabel: target.targetLabel,
      ok: true,
      traceLines: [
        `No extractable text for ${target.targetLabel}; section outline unavailable.`,
      ],
      groundingText,
      addedPaperContexts: [target.paperContext],
      estimatedTokens: estimateTextTokens(groundingText),
      truncated: false,
    };
  }

  // Group chunks by section label, preserving order of first appearance
  type SectionEntry = {
    label: string;
    kind: string;
    chunkCount: number;
    firstChunkIndex: number;
    charCount: number;
  };
  const sectionMap = new Map<string, SectionEntry>();
  for (const meta of pdfContext.chunkMeta) {
    const label = meta.sectionLabel || meta.chunkKind || "unknown";
    const kind = meta.chunkKind || "unknown";
    const existing = sectionMap.get(label);
    if (existing) {
      existing.chunkCount += 1;
      existing.charCount += (meta.text || "").length;
    } else {
      sectionMap.set(label, {
        label,
        kind,
        chunkCount: 1,
        firstChunkIndex: meta.chunkIndex,
        charCount: (meta.text || "").length,
      });
    }
  }

  const sections = [...sectionMap.values()].sort(
    (a, b) => a.firstChunkIndex - b.firstChunkIndex,
  );

  const rows = sections.map((s) => {
    const approxWords = Math.round(s.charCount / 5);
    return `  ${s.label.padEnd(40)} | ${s.kind.padEnd(20)} | ${String(s.chunkCount).padStart(4)} chunks | ~${String(approxWords).padStart(5)} words`;
  });

  const tableHeader = `  ${"Section Label".padEnd(40)} | ${"Kind".padEnd(20)} | ${"Chunks".padStart(10)} | Est. Length`;
  const tableSep = `  ${"-".repeat(40)} | ${"-".repeat(20)} | ${"-".repeat(10)} | ${"-".repeat(12)}`;

  const sectionTableText = [tableHeader, tableSep, ...rows].join("\n");

  const groundingLines = [
    "Agent Tool Result",
    "- Tool: get_paper_sections",
    `- Target: ${target.targetLabel}`,
    `- Total sections detected: ${sections.length}`,
    `- Total chunks: ${pdfContext.chunkMeta.length}`,
    "",
    "Section Outline:",
    sectionTableText,
  ];

  const groundingText = groundingLines.join("\n");
  const estimatedTokens = estimateTextTokens(groundingText);

  return {
    name: "get_paper_sections",
    targetLabel: target.targetLabel,
    ok: true,
    traceLines: [
      `Found ${sections.length} section${sections.length !== 1 ? "s" : ""} in ${target.targetLabel}.`,
    ],
    groundingText,
    addedPaperContexts: [target.paperContext],
    estimatedTokens,
    truncated: false,
  };
}
