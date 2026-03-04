import { estimateTextTokens } from "../../../../utils/modelInputCap";
import { pdfTextCache } from "../../state";
import { ensurePDFTextCached } from "../../pdfContext";
import { sanitizeText } from "../../textUtils";
import { validateSinglePaperToolCall } from "../ToolInfra/shared";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  ResolvedAgentToolTarget,
} from "../ToolInfra/types";

const REFERENCE_HEADING_PATTERNS = [
  /^(?:\d+[\].)]\s+)?references$/i,
  /^(?:\d+[\].)]\s+)?bibliography$/i,
  /^(?:\d+[\].)]\s+)?works cited$/i,
  /^(?:\d+[\].)]\s+)?literature cited$/i,
  /^(?:\d+[\].)]\s+)?references and notes$/i,
  /^(?:[ivxlcdm]+[\].)]\s+)?references$/i,
  /^(?:[ivxlcdm]+[\].)]\s+)?bibliography$/i,
];

function normalizeInlineWhitespace(value: string): string {
  return sanitizeText(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isReferenceHeading(paragraph: string): boolean {
  const firstLine = sanitizeText(paragraph || "")
    .split(/\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return false;
  return REFERENCE_HEADING_PATTERNS.some((pattern) => pattern.test(firstLine));
}

function locateReferenceStartIndex(paragraphs: string[]): number {
  const preferredFloor = Math.max(0, Math.floor(paragraphs.length * 0.4));
  for (let index = paragraphs.length - 1; index >= preferredFloor; index -= 1) {
    if (isReferenceHeading(paragraphs[index])) return index;
  }
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    if (isReferenceHeading(paragraphs[index])) return index;
  }
  return -1;
}

function looksLikeReferenceEntry(text: string): boolean {
  const normalized = normalizeInlineWhitespace(text);
  if (!normalized) return false;
  const tokenCount = normalized.split(/\s+/).length;
  if (tokenCount < 4) return false;
  return (
    /\b(?:19|20)\d{2}[a-z]?\b/.test(normalized) ||
    /\bdoi\b/i.test(normalized) ||
    /https?:\/\//i.test(normalized) ||
    /^\[\d+\]/.test(normalized) ||
    /^\d{1,3}[.)]/.test(normalized)
  );
}

function splitReferenceEntries(sectionText: string): string[] {
  const paragraphs = sectionText
    .split(/\n\s*\n/)
    .map((paragraph) => normalizeInlineWhitespace(paragraph))
    .filter(Boolean);
  const paragraphEntries = paragraphs.filter(looksLikeReferenceEntry);
  if (paragraphEntries.length >= 2) {
    return paragraphEntries;
  }

  const lines = sectionText
    .split(/\n/)
    .map((line) => normalizeInlineWhitespace(line))
    .filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    if (isReferenceHeading(line)) continue;
    const startsNewEntry =
      /^\[\d+\]/.test(line) ||
      /^\d{1,3}[.)]/.test(line) ||
      /^[A-Z][A-Za-z'`.-]+(?:,\s*[A-Z][A-Za-z'`.-]+)*.*\b(?:19|20)\d{2}[a-z]?\b/.test(
        line,
      );
    if (startsNewEntry && current) {
      if (looksLikeReferenceEntry(current)) out.push(current);
      current = line;
      continue;
    }
    current = current ? `${current} ${line}` : line;
  }
  if (current && looksLikeReferenceEntry(current)) {
    out.push(current);
  }
  return out;
}

function extractReferenceEntries(fullText: string): {
  sectionFound: boolean;
  entries: string[];
} {
  const paragraphs = fullText
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => sanitizeText(paragraph).trim())
    .filter(Boolean);
  if (!paragraphs.length) return { sectionFound: false, entries: [] };
  const referenceStart = locateReferenceStartIndex(paragraphs);
  if (referenceStart < 0) {
    return { sectionFound: false, entries: [] };
  }
  const sectionText = paragraphs
    .slice(referenceStart + 1)
    .join("\n\n")
    .trim();
  if (!sectionText) {
    return { sectionFound: true, entries: [] };
  }
  return {
    sectionFound: true,
    entries: splitReferenceEntries(sectionText),
  };
}

function selectReferenceEntries(
  entries: string[],
  toolTokenCap?: number,
): { selected: string[]; truncated: boolean } {
  const maxTokens = Math.floor(Number(toolTokenCap));
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return {
      selected: entries.slice(0, 12),
      truncated: entries.length > 12,
    };
  }
  const selected: string[] = [];
  let usedTokens = 0;
  for (const [index, entry] of entries.entries()) {
    const entryText = `${index + 1}. ${entry}`;
    const nextTokens = usedTokens + estimateTextTokens(entryText);
    if (selected.length && nextTokens > maxTokens) break;
    if (!selected.length && nextTokens > maxTokens) {
      return { selected: [], truncated: true };
    }
    if (nextTokens > maxTokens) break;
    selected.push(entry);
    usedTokens = nextTokens;
  }
  return {
    selected,
    truncated: selected.length < entries.length,
  };
}

export function validateReadReferencesCall(
  call: AgentToolCall,
): AgentToolCall | null {
  return validateSinglePaperToolCall("read_references", call);
}

export async function executeReadReferencesCall(
  ctx: AgentToolExecutionContext,
  _call: AgentToolCall,
  target: ResolvedAgentToolTarget,
): Promise<AgentToolExecutionResult> {
  if (!target.paperContext) {
    return {
      name: "read_references",
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
  const fullText = extractable ? pdfContext?.chunks.join("\n\n") || "" : "";
  const { sectionFound, entries } = extractReferenceEntries(fullText);
  const { selected, truncated } = selectReferenceEntries(
    entries,
    ctx.toolTokenCap,
  );
  const renderedReferences = selected.length
    ? selected.map((entry, index) => `${index + 1}. ${entry}`).join("\n")
    : !extractable
      ? "[No extractable PDF text available. References could not be read from the paper body.]"
      : sectionFound
        ? entries.length
          ? "[The references section was detected, but no entries fit inside the current tool budget.]"
          : "[A references section heading was found, but no reference entries were extracted reliably.]"
        : "[No references or bibliography section heading was detected in the extracted paper text.]";
  const groundingLines = [
    "Agent Tool Result",
    "- Tool: read_references",
    `- Target: ${target.targetLabel}`,
    `- Extractable full text available: ${extractable ? "yes" : "no"}`,
    `- References section found: ${sectionFound ? "yes" : "no"}`,
    `- Reference entries returned: ${selected.length}`,
    `- Truncated: ${truncated ? "yes" : "no"}`,
    "",
    "References:",
    renderedReferences,
  ];
  const groundingText = groundingLines.join("\n");
  const traceLines = [
    selected.length
      ? `Loaded ${selected.length} reference entr${selected.length === 1 ? "y" : "ies"} for ${target.targetLabel}.`
      : extractable
        ? `No reference list could be extracted for ${target.targetLabel}.`
        : `References were unavailable because text extraction failed for ${target.targetLabel}.`,
  ];

  return {
    name: "read_references",
    targetLabel: target.targetLabel,
    ok: true,
    traceLines,
    groundingText,
    addedPaperContexts: [target.paperContext],
    estimatedTokens: estimateTextTokens(groundingText),
    truncated,
  };
}
