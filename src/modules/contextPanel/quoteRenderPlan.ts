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
  stripCitationLabelDecoration,
} from "../../services/quotes/citationLabelParser";
import { resolveQuoteCitationLookupText } from "./quoteNavigationText";
import { quoteTokenPattern } from "../../services/quotes/quoteTokenIds";

/**
 * A paragraph citation's placeholder carries its own ids, hex-encoded (ids
 * are ASCII), so a mark resolves to the citations of the text it was planned
 * from: the answer, or a trace segment with its own plan.
 */
export const PARAGRAPH_CITATION_TOKEN_PATTERN = /LLMPAPERCITE([0-9a-f]+)END/g;

export function paragraphCitationPlaceholder(ids: readonly string[]): string {
  const hex = Array.from(ids.join(" "), (char) =>
    char.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
  return `LLMPAPERCITE${hex}END`;
}

/** The ids of a placeholder, from its hex part. */
export function paragraphCitationPlaceholderIds(hex: string): string[] {
  return (hex.match(/[0-9a-f]{2}/g) || [])
    .map((pair) => String.fromCharCode(parseInt(pair, 16)))
    .join("")
    .split(" ")
    .filter(Boolean);
}

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
  /**
   * Makes occurrence ids unique across plans (`QO_<scope>.<n>`). A plan built
   * from a fragment of a larger answer, such as one trace segment, sets it so
   * its tokens never collide with the answer's own `QO_<n>` ids.
   */
  occurrenceIdScope?: string;
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

/**
 * The text and records an assistant answer's tokens, marks and numbers are
 * drawn from. A web-attributed answer is drawn from its own text, because its
 * web chips' offsets point into that text; a quote display override never
 * replaces it.
 */
export function getAssistantRenderDisplay(
  message: Pick<Message, "text" | "quoteCitations" | "quoteDisplayOverride">,
  options: { hasWebSources?: boolean } = {},
): { markdown: string; quoteCitations?: QuoteCitation[] } {
  return options.hasWebSources
    ? { markdown: message.text || "", quoteCitations: message.quoteCitations }
    : getMessageQuoteDisplay(message);
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

function buildOccurrenceId(index: number, scope?: string): string {
  return scope
    ? `QO_${scope}.${index.toString(36)}`
    : `QO_${index.toString(36)}`;
}

function createNotSourceOccurrence(params: {
  quoteText: string;
  occurrenceId: string;
}): QuoteRenderOccurrence {
  return {
    occurrenceId: params.occurrenceId,
    displayText: params.quoteText,
    lookupText: params.quoteText,
    citationLabel: "Not a source quote",
    trust: "not-source-quote",
    source: "quote-review",
  };
}

function createOccurrenceFromCitation(
  citation: QuoteCitation,
  occurrenceId: string,
): QuoteRenderOccurrence {
  const displayText =
    stripQuoteCitationAnchorsFromDisplayText(
      citation.displayQuoteText || citation.quoteText,
    ) || citation.quoteText;
  const lookupText = resolveQuoteCitationLookupText(citation);
  return {
    occurrenceId,
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
  return parsed
    ? normalizeWrappedCitationLabel(stripCitationLabelDecoration(value))
    : "";
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
  const wholeLineLabel = parseSourceLabel(text);
  if (wholeLineLabel) return { citationLabel: wholeLineLabel, remainder: "" };
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
  occurrenceId: string;
  verifiedCitation?: QuoteCitation;
}): QuoteRenderOccurrence {
  const citationLabel = normalizeWrappedCitationLabel(params.citationLabel);
  const citation = params.verifiedCitation;
  return {
    occurrenceId: params.occurrenceId,
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

/**
 * Bind a displayed quote to its citation, one complete occurrence per
 * ellipsis-separated segment. Every segment must bind, or none is returned.
 */
function bindDisplayedQuoteSegments(
  citation: QuoteCitation,
  quoteText: string,
): QuoteCitation[] | undefined {
  const displayedSegments = splitQuoteAtEllipsisInOrder(quoteText);
  const quoteSegments =
    displayedSegments.length > 1 ? displayedSegments : [quoteText];
  const rebounds = quoteSegments.map((segment) =>
    bindQuoteCitationToDisplayedText(citation, segment),
  );
  return rebounds.length &&
    rebounds.every((rebound): rebound is QuoteCitation => Boolean(rebound))
    ? rebounds
    : undefined;
}

/**
 * Shortest blockquote that may bind by containment; the same bound as the
 * rule that keeps a citation shown as a blockquote (selectUsedQuoteCitations).
 */
const MIN_BLOCKQUOTE_CONTAINMENT_CHARS = 24;

function collapseQuoteWhitespace(value: unknown): string {
  return normalizeMultilineText(value).replace(/\s+/g, " ").trim();
}

/**
 * A label-less blockquote whose text one citation's passage contains, bound
 * to that passage. Text that no passage contains (the model's own words),
 * short fragments, and text that binds to passages of different sources stay
 * unbound.
 */
function bindContainingQuoteCitation(
  quoteCitations: readonly QuoteCitation[],
  quoteLines: string[],
  quoteText: string,
): QuoteCitation | undefined {
  const block = collapseQuoteWhitespace(quoteLines.join(" "));
  if (block.length < MIN_BLOCKQUOTE_CONTAINMENT_CHARS) return undefined;
  const bound: QuoteCitation[] = [];
  for (const citation of quoteCitations) {
    if (!collapseQuoteWhitespace(citation.quoteText).includes(block)) continue;
    const rebound = bindQuoteCitationToDisplayedText(citation, quoteText);
    if (rebound) bound.push(rebound);
  }
  const sources = new Set(
    bound.map((citation) =>
      [
        citation.contextItemId ?? citation.itemId ?? "",
        normalizeWrappedCitationLabel(citation.citationLabel),
      ].join("\u241f"),
    ),
  );
  return sources.size === 1 ? bound[0] : undefined;
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

  const nextOccurrenceId = () =>
    buildOccurrenceId(occurrences.length, input.occurrenceIdScope);
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
          createOccurrenceFromCitation(citation, nextOccurrenceId()),
        );
      },
    );
    QUOTE_CITATION_PATTERN.lastIndex = 0;
    return replaced;
  };

  const paragraphCitations: QuoteCitation[][] = [];
  const inlineMarkdown = transformParagraphCitations(
    input.markdown || "",
    (ids, malformed) => {
      const citations = ids.flatMap((id) =>
        citationsById.get(id) ? [citationsById.get(id)!] : [],
      );
      // The reader never sees a removed id, so the plan records each one.
      for (const id of [
        ...ids.filter((entry) => !citationsById.has(entry)),
        ...malformed,
      ]) {
        diagnostics.push({
          kind: "unresolved-anchor",
          message:
            "Paragraph citation id did not have a matching citation record.",
          quoteCitationId: id,
        });
      }
      if (!citations.length) return "";
      paragraphCitations.push(citations);
      return paragraphCitationPlaceholder(
        citations.map((citation) => citation.id),
      );
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
    const adjacentBindings = adjacentCitation
      ? bindDisplayedQuoteSegments(
          adjacentCitation,
          splitTrailingCitationLine(quoteLines)?.quoteText ||
            blockquoteMarkdown,
        )
      : undefined;
    if (adjacentAnchor && adjacentBindings) {
      out.push(
        ...adjacentBindings.map((binding) =>
          pushOccurrence(
            createOccurrenceFromCitation(binding, nextOccurrenceId()),
          ),
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
        const rebounds = citation
          ? bindDisplayedQuoteSegments(citation, structuredBinding.quoteText)
          : undefined;
        if (rebounds) {
          out.push(
            ...rebounds.map((rebound) =>
              pushOccurrence(
                createOccurrenceFromCitation(rebound, nextOccurrenceId()),
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
            occurrenceId: nextOccurrenceId(),
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
        occurrenceId: nextOccurrenceId(),
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
        occurrenceId: nextOccurrenceId(),
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

    const containing =
      input.allowLegacyInference !== false && quoteText
        ? bindContainingQuoteCitation(quoteCitations, quoteLines, quoteText)
        : undefined;
    if (containing) {
      const occurrence = createLegacyOccurrence({
        quoteText,
        citationLabel: containing.citationLabel,
        occurrenceId: nextOccurrenceId(),
        verifiedCitation: containing,
      });
      diagnostics.push({
        kind:
          occurrence.trust === "verified-source"
            ? "verified-source"
            : "legacy-inferred",
        message:
          "Label-less Markdown blockquote bound to the quote citation that contains it.",
        quoteText,
        citationLabel: occurrence.citationLabel,
        quoteCitationId: containing.id,
      });
      out.push(pushOccurrence(occurrence));
      index -= 1;
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

/**
 * What an expanded answer does with its paragraph citations:
 * - "inline-labels": each run becomes its source labels in place;
 * - "line-labels": runs go, with the spaces before them, and each line ends
 *   with its deduplicated labels (table rows keep theirs in place);
 * - "omit": runs go, with the spaces before them;
 * - "preserve": runs stay as `[[cite:…]]` tokens of their known ids.
 */
export type ParagraphCitationExpansion =
  | "inline-labels"
  | "line-labels"
  | "omit"
  | "preserve";

export type ExpandQuoteRenderPlanOptions = {
  paragraphCitations?: ParagraphCitationExpansion;
};

const PARAGRAPH_CITATION_WITH_SPACE_PATTERN =
  /[ \t]*LLMPAPERCITE([0-9a-f]+)END/g;

/**
 * The answer-wide number of each paragraph citation: 1..N in order of first
 * appearance, the same numbers `indexAnswerCitations` gives the raw text.
 */
export function paragraphCitationNumbers(
  plan: Pick<QuoteRenderPlan, "paragraphCitations">,
): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const group of plan.paragraphCitations) {
    for (const citation of group) {
      if (!numbers.has(citation.id)) numbers.set(citation.id, numbers.size + 1);
    }
  }
  return numbers;
}

/**
 * Numbers for every mark of one bubble: an id the answer cites keeps its
 * answer-wide number; an id cited only elsewhere (trace text) continues after
 * the highest number already given, in the order it is asked for. `given`
 * holds numbers marks already show, so a later pass keeps them.
 */
export function createCitationNumberer(
  answerNumbers: ReadonlyMap<string, number>,
  given: Iterable<readonly [string, number]> = [],
): (id: string) => number {
  const numbers = new Map(answerNumbers);
  for (const [id, number] of given) {
    if (id && number > 0 && !numbers.has(id)) numbers.set(id, number);
  }
  let next = Math.max(0, ...numbers.values()) + 1;
  return (id) => {
    let number = numbers.get(id);
    if (!number) {
      number = next++;
      numbers.set(id, number);
    }
    return number;
  };
}

function expandParagraphCitations(
  markdown: string,
  plan: QuoteRenderPlan,
  mode: ParagraphCitationExpansion,
): string {
  const byId = new Map(
    plan.paragraphCitations.flat().map((citation) => [citation.id, citation]),
  );
  const citationsAt = (hex: string) =>
    paragraphCitationPlaceholderIds(hex).flatMap((id) =>
      byId.has(id) ? [byId.get(id)!] : [],
    );
  const labelsOf = (citations: QuoteCitation[]) => [
    ...new Set(citations.map((citation) => citation.citationLabel)),
  ];
  const inlineLabels = (text: string) =>
    text.replace(PARAGRAPH_CITATION_TOKEN_PATTERN, (_token, hex: string) =>
      labelsOf(citationsAt(hex)).join("; "),
    );
  if (mode === "inline-labels") return inlineLabels(markdown);
  if (mode === "preserve") {
    return markdown.replace(
      PARAGRAPH_CITATION_TOKEN_PATTERN,
      (_token, hex: string) => {
        const citations = citationsAt(hex);
        return citations.length
          ? `[[cite:${citations.map((citation) => citation.id).join(",")}]]`
          : "";
      },
    );
  }
  if (mode === "omit") {
    return markdown.replace(PARAGRAPH_CITATION_WITH_SPACE_PATTERN, "");
  }
  return markdown
    .split("\n")
    .map((line) => {
      // A table row keeps each cell's labels in its own cell.
      if (/^\s*\|/.test(line)) return inlineLabels(line);
      const citations: QuoteCitation[] = [];
      const stripped = line.replace(
        PARAGRAPH_CITATION_WITH_SPACE_PATTERN,
        (_token, hex: string) => {
          citations.push(...citationsAt(hex));
          return "";
        },
      );
      const labels = labelsOf(citations);
      if (!labels.length) return stripped;
      // A hard break (two trailing spaces) stays after the labels.
      const [, words, trailing] = /^(.*?)([ \t]*)$/.exec(stripped)!;
      return `${words} ${labels.join("; ")}${/ {2}/.test(trailing) ? "  " : ""}`;
    })
    .join("\n");
}

export function expandQuoteRenderPlanToMarkdown(
  plan: QuoteRenderPlan,
  options: ExpandQuoteRenderPlanOptions = {},
): string {
  const byId = new Map(
    plan.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const withCitations = expandParagraphCitations(
    plan.displayMarkdown,
    plan,
    options.paragraphCitations || "inline-labels",
  );
  QUOTE_RENDER_OCCURRENCE_PATTERN.lastIndex = 0;
  const expanded = withCitations.replace(
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
  return expanded;
}

export function buildQuoteDisplayMarkdown(
  input: BuildQuoteRenderPlanInput,
): string {
  return buildQuoteRenderPlan(input).displayMarkdown;
}

export function buildQuoteExpandedMarkdown(
  input: BuildQuoteRenderPlanInput,
  options: ExpandQuoteRenderPlanOptions = {},
): string {
  return expandQuoteRenderPlanToMarkdown(buildQuoteRenderPlan(input), options);
}

const boundOccurrences = new WeakMap<Element, QuoteRenderOccurrence[]>();

/**
 * Remember which plan a rendered element came from, so a later whole-bubble
 * pass resolves its occurrence tokens against that plan, not the answer's.
 */
export function bindQuoteRenderOccurrences(
  node: Element,
  occurrences: readonly QuoteRenderOccurrence[],
): void {
  boundOccurrences.set(node, [...occurrences]);
}

/** Occurrences bound to the nearest ancestor element of `node`, or null. */
export function getBoundQuoteRenderOccurrences(
  node: Node,
): QuoteRenderOccurrence[] | null {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === 1) {
      const bound = boundOccurrences.get(current as Element);
      if (bound) return bound;
    }
    current = current.parentNode;
  }
  return null;
}
