import { ToolInputRejection } from "../tools/execution/failure";
import { quoteTokenPattern } from "../../services/quotes/quoteTokenIds";

const QUOTE_TOKEN = quoteTokenPattern("quote");
/**
 * A leading enumerator ("1.", "2)", "3.1", "IV.", "A.") is presentation, not
 * the section's name; numbered headings are ordinary in reviews.
 */
const HEADING_ENUMERATOR =
  /^(?:\d+(?:\.\d+)*[.):]?|[ivxlcdm]+[.):]|[a-z][.):])\s+/i;
/**
 * A quoted span is a direct quotation when it is a run of prose. A quoted
 * name, identifier, or term of a few words is ordinary writing and needs no
 * quote token.
 */
const QUOTED_SPAN = /(?:^|[\s(])["\u201c]([^"\u201d\n]+)["\u201d]/gm;
const DIRECT_QUOTATION_MIN_WORDS = 5;
/** How much of each offending quotation a rejection shows the model. */
const QUOTATION_PREVIEW_CHARS = 60;
const QUOTATION_PREVIEW_COUNT = 3;

export function normalizeHeading(value: string): string {
  return value
    .trim()
    .replace(HEADING_ENUMERATOR, "")
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ");
}

/** Blockquotes and quoted runs of prose, in document order. */
function findDirectQuotations(markdown: string): string[] {
  const found: Array<{ index: number; text: string }> = [];
  for (const match of markdown.matchAll(/^\s*>\s+(\S.*)$/gm)) {
    found.push({ index: match.index, text: match[1] });
  }
  for (const match of markdown.matchAll(QUOTED_SPAN)) {
    const words = match[1].trim().split(/\s+/).filter(Boolean);
    if (words.length >= DIRECT_QUOTATION_MIN_WORDS) {
      found.push({ index: match.index, text: match[1] });
    }
  }
  return found
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.text.replace(/\s+/g, " ").trim());
}

function previewQuotation(text: string): string {
  return text.length > QUOTATION_PREVIEW_CHARS
    ? `${text.slice(0, QUOTATION_PREVIEW_CHARS).trimEnd()}…`
    : text;
}

export function collectHeadings(markdown: string): Set<string> {
  const headings = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) headings.add(normalizeHeading(match[1]));
  }
  return headings;
}

function hasCoverageDisclosure(headings: ReadonlySet<string>): boolean {
  const values = [...headings];
  const hasScope = values.some((heading) => /\bscope\b/.test(heading));
  const hasLimitations = values.some((heading) =>
    /\blimit(?:ation|ations|s)\b/.test(heading),
  );
  return hasScope && hasLimitations;
}

export function collectMissingSections(params: {
  headings: ReadonlySet<string>;
  requiredSections: readonly string[];
  requiresCoverageSection: boolean;
}): string[] {
  const coverageSatisfied = hasCoverageDisclosure(params.headings);
  const required = params.requiredSections
    .map(normalizeHeading)
    .filter((heading) => heading !== "references");
  if (params.requiresCoverageSection) required.push("scope and limitations");
  return [...new Set(required)].filter((heading) => {
    if (heading === "scope and limitations" && coverageSatisfied) return false;
    return !params.headings.has(heading);
  });
}

export function collectDocumentDraftIssues(params: {
  markdown: string;
  requiredSections: readonly string[];
  requiresCoverageSection: boolean;
  validateQuotes?: boolean;
}): string[] {
  const issues: string[] = [];
  const missing = collectMissingSections({
    headings: collectHeadings(params.markdown),
    requiredSections: params.requiredSections,
    requiresCoverageSection: params.requiresCoverageSection,
  });
  if (missing.length) {
    issues.push(
      `Document is missing required sections: ${missing.join(", ")}. Add each as a heading with that wording.`,
    );
  }
  const quotations =
    params.validateQuotes === false
      ? []
      : findDirectQuotations(params.markdown.replace(QUOTE_TOKEN, ""));
  if (quotations.length) {
    const shown = quotations
      .slice(0, QUOTATION_PREVIEW_COUNT)
      .map((text) => `"${previewQuotation(text)}"`)
      .join("; ");
    const more =
      quotations.length > QUOTATION_PREVIEW_COUNT
        ? `; and ${quotations.length - QUOTATION_PREVIEW_COUNT} more`
        : "";
    issues.push(
      `Direct quotations must use internal [[quote:Q1]] tokens and host-verifiable quote mappings. Paraphrase or map: ${shown}${more}`,
    );
  }
  return issues;
}

export function assertDocumentDraftValid(params: {
  markdown: string;
  requiredSections: readonly string[];
  requiresCoverageSection: boolean;
  validateQuotes?: boolean;
}): void {
  const issues = collectDocumentDraftIssues(params);
  if (issues.length) {
    throw new ToolInputRejection(
      `Document validation failed:\n- ${issues.join("\n- ")}`,
    );
  }
}

export function stripHandwrittenReferences(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let suppressedDepth = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      if (suppressedDepth && depth <= suppressedDepth) {
        suppressedDepth = 0;
        if (kept.length && kept.at(-1) !== "") kept.push("");
      }
      if (normalizeHeading(heading[2]) === "references") {
        suppressedDepth = depth;
        while (kept.at(-1) === "") kept.pop();
        continue;
      }
    }
    if (!suppressedDepth) kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();
  return kept.join("\n");
}
