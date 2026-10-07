import { transformParagraphCitations } from "../../services/quotes/paragraphCitations";
import type { QuoteCitation } from "../../shared/types";
import type { Message } from "./types";
import {
  bindQuoteCitationToDisplayedText,
  hasVerifiedQuoteLocation,
  findAdjacentStandaloneQuoteCitation,
  normalizeQuoteCitations,
  parseStructuredBlockquoteQuoteBinding,
  QUOTE_CITATION_PATTERN,
  sanitizeInvalidStructuredSourceMarkers,
  stripQuoteCitationAnchorsFromDisplayText,
} from "../../services/quotes/quoteCitations";
import { splitQuoteAtEllipsisInOrder } from "../../services/quotes/quoteTextSearch";
import {
  normalizeWrappedCitationLabel,
  parseStandaloneCitationLabel,
} from "../../services/quotes/citationLabelParser";
import { resolveQuoteCitationLookupText } from "./quoteNavigationText";
import { quoteTokenPattern } from "../../services/quotes/quoteTokenIds";

export const PARAGRAPH_CITATION_TOKEN_PATTERN = /LLMPAPERCITE(\d+)END/g;

export const QUOTE_RENDER_OCCURRENCE_PATTERN =
  quoteTokenPattern("quote-occurrence");

const FENCED_CODE_PATTERN = /^[ \t]*(```|~~~)/;

export type QuoteRenderTrust =
  | "trusted-anchor"
  | "verified-source"
  | "legacy-inferred"
  | "unverified-source-label"
  | "not-source-quote";

export type QuoteRenderSource =
  | "structured-anchor"
  | "verified-markdown"
  | "legacy-markdown"
  | "fallback-dom"
  | "quote-review";

export type QuoteRenderDiagnosticKind =
  | "unresolved-anchor"
  | "verified-source"
  | "legacy-inferred"
  | "plain-blockquote";

export type QuoteRenderDiagnostic = {
  kind: QuoteRenderDiagnosticKind;
  message: string;
  quoteText?: string;
  citationLabel?: string;
  quoteCitationId?: string;
};

export type QuoteRenderOccurrence = {
  occurrenceId: string;
  quoteCitationId?: string;
  quoteCitation?: QuoteCitation;
  displayText: string;
  lookupText: string;
  citationLabel: string;
  trust: QuoteRenderTrust;
  source: QuoteRenderSource;
  contextItemId?: number;
  itemId?: number;
  pageHintIndex?: number;
  pageHintLabel?: string;
};

export type QuoteRenderPlan = {
  displayMarkdown: string;
  occurrences: QuoteRenderOccurrence[];
  diagnostics: QuoteRenderDiagnostic[];
  paragraphCitations: QuoteCitation[][];
};

export type BuildQuoteRenderPlanInput = {
  markdown: string;
  quoteCitations?: QuoteCitation[] | undefined | null;
  /**
   * Legacy citation-looking Markdown blockquotes are paper-source UI only.
   * Web-attributed answers disable this inference and keep ordinary quotes as
   * ordinary blockquotes; explicit structured paper anchors still render.
   */
  allowLegacyInference?: boolean;
};

export function getMessageQuoteDisplay(
  message: Pick<Message, "text" | "quoteCitations" | "quoteDisplayOverride">,
): { markdown: string; quoteCitations?: QuoteCitation[] } {
  return (
    message.quoteDisplayOverride || {
      markdown: message.text || "",
      quoteCitations: message.quoteCitations,
    }
  );
}

function normalizeMultilineText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMarkdownLineEndings(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "";
}

function stripBlockquoteMarker(line: string): string {
  return line.replace(/^[ \t]*(?:>[ \t]?)+/, "");
}

function occurrenceToken(occurrenceId: string): string {
  return `[[quote-occurrence:${occurrenceId}]]`;
}

function isDuplicateQuoteRepresentation(
  left: QuoteRenderOccurrence,
  right: QuoteRenderOccurrence,
): boolean {
  return Boolean(
    left.quoteCitationId &&
    left.quoteCitationId === right.quoteCitationId &&
    normalizeMultilineText(left.displayText) ===
      normalizeMultilineText(right.displayText) &&
    ((left.source === "verified-markdown" &&
      right.source === "structured-anchor") ||
      (left.source === "structured-anchor" &&
        right.source === "verified-markdown")),
  );
}

function normalizeQuoteRenderOccurrences(
  markdown: string,
  occurrences: QuoteRenderOccurrence[],
): Pick<QuoteRenderPlan, "displayMarkdown" | "occurrences"> {
  if (!markdown || !QUOTE_RENDER_OCCURRENCE_PATTERN.test(markdown)) {
    QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
    return { displayMarkdown: markdown, occurrences };
  }
  QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
  const byId = new Map(
    occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const displayedOccurrences: QuoteRenderOccurrence[] = [];

  let result = "";
  let cursor = 0;
  let appendedOccurrence = false;
  let lastOccurrenceStart = 0;
  let previousOccurrence: QuoteRenderOccurrence | undefined;
  const appendText = (text: string): void => {
    if (!text) return;
    if (!appendedOccurrence) {
      result += text;
      return;
    }
    const withoutLeadingHorizontalSpace = text.replace(/^[ \t]+/, "");
    if (!withoutLeadingHorizontalSpace.trim()) return;
    if (/^\r?\n[ \t]*\r?\n/.test(withoutLeadingHorizontalSpace)) {
      result += withoutLeadingHorizontalSpace;
    } else if (/^\r?\n/.test(withoutLeadingHorizontalSpace)) {
      result += `\n\n${withoutLeadingHorizontalSpace.replace(/^\r?\n/, "")}`;
    } else {
      result += `\n\n${withoutLeadingHorizontalSpace}`;
    }
    appendedOccurrence = false;
  };

  for (const match of markdown.matchAll(QUOTE_RENDER_OCCURRENCE_PATTERN)) {
    const start = match.index || 0;
    const token = match[0];
    const between = markdown.slice(cursor, start);
    const occurrence = byId.get(match[1]);
    if (
      occurrence &&
      previousOccurrence &&
      !between.trim() &&
      isDuplicateQuoteRepresentation(previousOccurrence, occurrence)
    ) {
      // Both syntaxes have now been bound to the same complete quote. Keep
      // its structured occurrence without waiting for background validation.
      if (occurrence.source === "structured-anchor") {
        result = result.slice(0, lastOccurrenceStart) + token;
        displayedOccurrences[displayedOccurrences.length - 1] = occurrence;
        previousOccurrence = occurrence;
      }
      cursor = start + token.length;
      continue;
    }
    appendText(between);
    result = result.replace(/[ \t]+$/, "");
    if (result.trim() && !/\n[ \t]*\n[ \t]*$/.test(result)) {
      result += /\n[ \t]*$/.test(result) ? "\n" : "\n\n";
    }
    lastOccurrenceStart = result.length;
    result += token;
    if (occurrence) displayedOccurrences.push(occurrence);
    previousOccurrence = occurrence;
    appendedOccurrence = true;
    cursor = start + token.length;
  }
  appendText(markdown.slice(cursor));
  QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
  return { displayMarkdown: result, occurrences: displayedOccurrences };
}

function buildOccurrenceId(index: number): string {
  return `QO_${index.toString(36)}`;
}

function createNotSourceOccurrence(params: {
  quoteText: string;
  occurrenceIndex: number;
}): QuoteRenderOccurrence {
  return {
    occurrenceId: buildOccurrenceId(params.occurrenceIndex),
    displayText: params.quoteText,
    lookupText: params.quoteText,
    citationLabel: "Not a source quote",
    trust: "not-source-quote",
    source: "quote-review",
  };
}

function createOccurrenceFromCitation(
  citation: QuoteCitation,
  occurrenceIndex: number,
): QuoteRenderOccurrence {
  const displayText =
    stripQuoteCitationAnchorsFromDisplayText(
      citation.displayQuoteText || citation.quoteText,
    ) || citation.quoteText;
  const lookupText = resolveQuoteCitationLookupText(citation);
  return {
    occurrenceId: buildOccurrenceId(occurrenceIndex),
    quoteCitationId: citation.id,
    quoteCitation: citation,
    displayText,
    lookupText,
    citationLabel: citation.citationLabel,
    trust: hasVerifiedQuoteLocation(citation)
      ? "trusted-anchor"
      : "unverified-source-label",
    source: "structured-anchor",
    contextItemId: citation.contextItemId,
    itemId: citation.itemId,
    pageHintIndex: citation.pageHintIndex,
    pageHintLabel: citation.pageHintLabel,
  };
}

function parseSourceLabel(value: string): string {
  const parsed = parseStandaloneCitationLabel(value);
  return parsed ? normalizeWrappedCitationLabel(value) : "";
}

function containsStructuredQuoteAnchor(value: string): boolean {
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  const matched = QUOTE_CITATION_PATTERN.test(value);
  QUOTE_CITATION_PATTERN.lastIndex = 0;
  return matched;
}

function splitTrailingCitationLine(quoteLines: string[]): {
  quoteText: string;
  citationLabel: string;
} | null {
  if (quoteLines.length < 2) return null;
  const tail = normalizeMultilineText(quoteLines[quoteLines.length - 1] || "");
  const citationLabel = parseSourceLabel(tail);
  if (!citationLabel) return null;
  const quoteText = normalizeMultilineText(quoteLines.slice(0, -1).join("\n"));
  return quoteText ? { quoteText, citationLabel } : null;
}

function splitTrailingNotSourceLine(
  quoteLines: string[],
): { quoteText: string } | null {
  if (quoteLines.length < 2) return null;
  const tail = normalizeMultilineText(quoteLines[quoteLines.length - 1] || "");
  if (tail !== "Not a source quote") return null;
  const quoteText = normalizeMultilineText(quoteLines.slice(0, -1).join("\n"));
  return quoteText ? { quoteText } : null;
}

function parseLeadingCitationLine(value: string): {
  citationLabel: string;
  remainder: string;
} | null {
  const text = normalizeMultilineText(value);
  if (!text.startsWith("(")) return null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char !== ")") continue;
    depth -= 1;
    if (depth !== 0) continue;
    const candidate = text.slice(0, index + 1);
    const citationLabel = parseSourceLabel(candidate);
    if (!citationLabel) return null;
    return {
      citationLabel,
      remainder: normalizeMultilineText(text.slice(index + 1)),
    };
  }
  return null;
}

function createLegacyOccurrence(params: {
  quoteText: string;
  citationLabel: string;
  occurrenceIndex: number;
  verifiedCitation?: QuoteCitation;
}): QuoteRenderOccurrence {
  const citationLabel = normalizeWrappedCitationLabel(params.citationLabel);
  const citation = params.verifiedCitation;
  return {
    occurrenceId: buildOccurrenceId(params.occurrenceIndex),
    quoteCitationId: citation?.id,
    quoteCitation: citation,
    displayText: params.quoteText,
    lookupText: citation
      ? resolveQuoteCitationLookupText(citation)
      : params.quoteText,
    citationLabel: citation?.citationLabel || citationLabel,
    trust: citation
      ? hasVerifiedQuoteLocation(citation)
        ? "verified-source"
        : "unverified-source-label"
      : "legacy-inferred",
    source: citation ? "verified-markdown" : "legacy-markdown",
    contextItemId: citation?.contextItemId,
    itemId: citation?.itemId,
    pageHintIndex: citation?.pageHintIndex,
    pageHintLabel: citation?.pageHintLabel,
  };
}

export function buildQuoteRenderPlan(
  input: BuildQuoteRenderPlanInput,
): QuoteRenderPlan {
  const quoteCitations = normalizeQuoteCitations(input.quoteCitations);
  const citationsById = new Map(
    quoteCitations.map((citation) => [citation.id, citation]),
  );
  const occurrences: QuoteRenderOccurrence[] = [];
  const diagnostics: QuoteRenderDiagnostic[] = [];

  const nextOccurrenceIndex = () => occurrences.length;
  const pushOccurrence = (occurrence: QuoteRenderOccurrence): string => {
    occurrences.push(occurrence);
    return occurrenceToken(occurrence.occurrenceId);
  };
  const findVerifiedLegacyCitation = (
    quoteText: string,
    citationLabel: string,
  ): QuoteCitation | undefined => {
    const normalizedQuote = normalizeMultilineText(
      stripQuoteCitationAnchorsFromDisplayText(quoteText),
    );
    const normalizedLabel = normalizeWrappedCitationLabel(
      parseStandaloneCitationLabel(citationLabel)?.sourceLabel || citationLabel,
    );
    if (!normalizedQuote || !normalizedLabel) return undefined;
    return quoteCitations.find((citation) => {
      if (
        normalizeWrappedCitationLabel(citation.citationLabel) !==
        normalizedLabel
      ) {
        return false;
      }
      return [
        citation.quoteText,
        citation.displayQuoteText,
        citation.sourceMatchText,
      ].some(
        (candidate) =>
          normalizeMultilineText(
            stripQuoteCitationAnchorsFromDisplayText(candidate || ""),
          ) === normalizedQuote,
      );
    });
  };

  const replaceStructuredAnchors = (segment: string): string => {
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    const replaced = segment.replace(
      QUOTE_CITATION_PATTERN,
      (token, id: string) => {
        const citation = citationsById.get(id);
        if (!citation) {
          diagnostics.push({
            kind: "unresolved-anchor",
            message: "Quote anchor did not have a matching citation record.",
            quoteCitationId: id,
          });
          return "";
        }
        return pushOccurrence(
          createOccurrenceFromCitation(citation, nextOccurrenceIndex()),
        );
      },
    );
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    return replaced;
  };

  const paragraphCitations: QuoteCitation[][] = [];
  const inlineMarkdown = transformParagraphCitations(
    input.markdown || "",
    (ids) => {
      const citations = ids.flatMap((id) =>
        citationsById.get(id) ? [citationsById.get(id)!] : [],
      );
      if (!citations.length) return "";
      paragraphCitations.push(citations);
      return `LLMPAPERCITE${paragraphCitations.length - 1}END`;
    },
  );
  const markdown = normalizeMarkdownLineEndings(
    sanitizeInvalidStructuredSourceMarkers(inlineMarkdown || ""),
  );
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCED_CODE_PATTERN.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    if (!/^[ \t]*>/.test(line)) {
      out.push(replaceStructuredAnchors(line));
      continue;
    }

    const blockStart = index;
    const quoteLines: string[] = [];
    while (index < lines.length && /^[ \t]*>/.test(lines[index])) {
      quoteLines.push(stripBlockquoteMarker(lines[index]));
      index += 1;
    }

    const blockquoteMarkdown = quoteLines.join("\n");
    const adjacentAnchor = !containsStructuredQuoteAnchor(blockquoteMarkdown)
      ? findAdjacentStandaloneQuoteCitation({
          markdownLines: lines,
          followingLineStartIndex: index,
        })
      : null;
    const adjacentCitation = adjacentAnchor
      ? citationsById.get(adjacentAnchor.quoteCitationId)
      : undefined;
    const adjacentBinding = adjacentCitation
      ? bindQuoteCitationToDisplayedText(adjacentCitation, blockquoteMarkdown)
      : undefined;
    if (adjacentAnchor && adjacentBinding) {
      out.push(
        pushOccurrence(
          createOccurrenceFromCitation(adjacentBinding, nextOccurrenceIndex()),
        ),
      );
      index = adjacentAnchor.lineIndex;
      continue;
    }
    if (containsStructuredQuoteAnchor(blockquoteMarkdown)) {
      const structuredBinding =
        parseStructuredBlockquoteQuoteBinding(quoteLines);
      if (structuredBinding?.quoteText) {
        const citation = citationsById.get(structuredBinding.quoteCitationId);
        const displayedSegments = splitQuoteAtEllipsisInOrder(
          structuredBinding.quoteText,
        );
        const quoteSegments =
          displayedSegments.length > 1
            ? displayedSegments
            : [structuredBinding.quoteText];
        const rebounds = citation
          ? quoteSegments.map((quoteText) =>
              bindQuoteCitationToDisplayedText(citation, quoteText),
            )
          : [];
        if (
          rebounds.length &&
          rebounds.every((rebound): rebound is QuoteCitation =>
            Boolean(rebound),
          )
        ) {
          out.push(
            ...rebounds.map((rebound) =>
              pushOccurrence(
                createOccurrenceFromCitation(rebound, nextOccurrenceIndex()),
              ),
            ),
          );
          index -= 1;
          continue;
        }

        diagnostics.push({
          kind: "unresolved-anchor",
          message:
            "Visible quote could not be bound completely to its structured citation evidence.",
          quoteText: structuredBinding.quoteText,
          citationLabel:
            citation?.citationLabel || structuredBinding.citationLabel,
          quoteCitationId: structuredBinding.quoteCitationId,
        });
        out.push(
          [
            structuredBinding.quoteText,
            citation?.citationLabel || structuredBinding.citationLabel || "",
          ]
            .filter(Boolean)
            .join("\n")
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        );
        index -= 1;
        continue;
      }
      const replacedBlockquote = normalizeMultilineText(
        replaceStructuredAnchors(blockquoteMarkdown),
      );
      if (replacedBlockquote) out.push(replacedBlockquote);
      index -= 1;
      continue;
    }

    const notSource = splitTrailingNotSourceLine(quoteLines);
    if (notSource) {
      out.push(
        pushOccurrence(
          createNotSourceOccurrence({
            quoteText: notSource.quoteText,
            occurrenceIndex: nextOccurrenceIndex(),
          }),
        ),
      );
      index -= 1;
      continue;
    }

    const tail =
      input.allowLegacyInference === false
        ? null
        : splitTrailingCitationLine(quoteLines);
    if (tail) {
      const occurrence = createLegacyOccurrence({
        quoteText: tail.quoteText,
        citationLabel: tail.citationLabel,
        occurrenceIndex: nextOccurrenceIndex(),
        verifiedCitation: findVerifiedLegacyCitation(
          tail.quoteText,
          tail.citationLabel,
        ),
      });
      diagnostics.push({
        kind:
          occurrence.trust === "verified-source"
            ? "verified-source"
            : "legacy-inferred",
        message:
          occurrence.trust === "verified-source"
            ? "Legacy Markdown blockquote verified from trailing citation."
            : "Legacy Markdown blockquote inferred from trailing citation.",
        quoteText: occurrence.lookupText,
        citationLabel: occurrence.citationLabel,
      });
      out.push(pushOccurrence(occurrence));
      index -= 1;
      continue;
    }

    let cursor = index;
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    const leading =
      input.allowLegacyInference !== false && cursor < lines.length
        ? parseLeadingCitationLine(lines[cursor])
        : null;
    const quoteText = normalizeMultilineText(quoteLines.join("\n"));
    if (quoteText && leading?.citationLabel) {
      const occurrence = createLegacyOccurrence({
        quoteText,
        citationLabel: leading.citationLabel,
        occurrenceIndex: nextOccurrenceIndex(),
        verifiedCitation: findVerifiedLegacyCitation(
          quoteText,
          leading.citationLabel,
        ),
      });
      diagnostics.push({
        kind:
          occurrence.trust === "verified-source"
            ? "verified-source"
            : "legacy-inferred",
        message:
          occurrence.trust === "verified-source"
            ? "Legacy Markdown blockquote verified from adjacent citation."
            : "Legacy Markdown blockquote inferred from adjacent citation.",
        quoteText: occurrence.lookupText,
        citationLabel: occurrence.citationLabel,
      });
      out.push(pushOccurrence(occurrence));
      if (leading.remainder) out.push(leading.remainder);
      index = cursor;
      continue;
    }

    diagnostics.push({
      kind: "plain-blockquote",
      message: "Blockquote did not have a parseable source label.",
      quoteText,
    });
    out.push(...lines.slice(blockStart, index));
    index -= 1;
  }

  return {
    ...normalizeQuoteRenderOccurrences(out.join("\n"), occurrences),
    diagnostics,
    paragraphCitations,
  };
}

export function expandQuoteRenderPlanToMarkdown(
  plan: QuoteRenderPlan,
  options: { preserveParagraphCitations?: boolean } = {},
): string {
  const byId = new Map(
    plan.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
  const expanded = plan.displayMarkdown.replace(
    QUOTE_RENDER_OCCURRENCE_PATTERN,
    (_token, id: string) => {
      const occurrence = byId.get(id);
      if (!occurrence) return "";
      const quoteLines = normalizeMultilineText(occurrence.displayText)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `${quoteLines}\n>\n> ${occurrence.citationLabel}`;
    },
  );
  QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
  return expanded.replace(
    PARAGRAPH_CITATION_TOKEN_PATTERN,
    (_token, index: string) => {
      const citations = plan.paragraphCitations[Number(index)] || [];
      if (options.preserveParagraphCitations)
        return citations.length
          ? `[[cite:${citations.map((citation) => citation.id).join(",")}]]`
          : "";
      return [
        ...new Set(citations.map((citation) => citation.citationLabel)),
      ].join("; ");
    },
  );
}

export function buildQuoteDisplayMarkdown(
  input: BuildQuoteRenderPlanInput,
): string {
  return buildQuoteRenderPlan(input).displayMarkdown;
}

export function buildQuoteExpandedMarkdown(
  input: BuildQuoteRenderPlanInput,
  options: { preserveParagraphCitations?: boolean } = {},
): string {
  return expandQuoteRenderPlanToMarkdown(buildQuoteRenderPlan(input), options);
}
