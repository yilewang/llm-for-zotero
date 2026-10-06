/**
 * The authoritative quote gate.
 *
 * One assistant message's registered quotes go in, and what the panel is
 * allowed to display comes out: which citations survive, which are demoted,
 * and what secondary evidence an open PDF could still supply.
 */
import { getAllOpenReaders } from "../../../services/pdf/zoteroReaderTabs";
import {
  buildQuoteSourceIndex,
  collectDisplayedQuoteVerificationRequests,
  finalizeAssistantQuoteCitations,
  finalizeAssistantQuoteCitationsCooperatively,
  type QuoteSecondaryEvidence,
} from "../../../services/quotes/quoteCitations";
import type { QuoteCitation } from "../../../shared/types";
import { paragraphCitationIds } from "../../../services/quotes/paragraphCitations";
import { verifyCompleteQuoteInLivePdfJs } from "../../../services/pdf/livePdfSelectionLocator";
import type { Message } from "../types";
import { buildQuoteExpandedMarkdown } from "../quoteRenderPlan";
import {
  buildQuoteValidationEvidenceSignature,
  cacheQuoteValidationDecision,
  getCachedQuoteValidationDecision,
  getOrBuildCachedQuoteSourceIndex,
  noteQuoteValidationDecisionComputed,
  quoteValidationCacheKey,
  QUOTE_VALIDATION_POLICY_VERSION,
} from "./caches";
import {
  hasOpenEndedQuoteSourceScope,
  registeredQuoteCitationsForReview,
  shouldRequireBodyEvidenceQuoteSearch,
  type AssistantQuoteFinalizationOptions,
  type QuoteSourceEvidence,
} from "./sourceEvidence";

function quoteDisplayOverridesEqual(
  left: Message["quoteDisplayOverride"],
  right: Message["quoteDisplayOverride"],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.markdown !== right.markdown) return false;
  const leftCitations = left.quoteCitations || [];
  const rightCitations = right.quoteCitations || [];
  return (
    leftCitations.length === rightCitations.length &&
    leftCitations.every(
      (citation, index) =>
        JSON.stringify(citation) === JSON.stringify(rightCitations[index]),
    )
  );
}

export async function applyAssistantMessageQuoteGate(
  assistantMessage: Message,
  markdown: string,
  quoteCitations: QuoteCitation[] | undefined,
  evidence: QuoteSourceEvidence,
  options: AssistantQuoteFinalizationOptions,
  preparedSourceIndex?: ReturnType<typeof buildQuoteSourceIndex>,
  secondaryEvidence: readonly QuoteSecondaryEvidence[] = [],
  cooperativeOptions?: {
    yieldToMain: () => Promise<void>;
    shouldContinue?: () => boolean;
  },
): Promise<boolean> {
  const requireBodyEvidenceQuotes = shouldRequireBodyEvidenceQuoteSearch({
    assistantMarkdown: markdown,
    pairedUserMessage: options.pairedUserMessage,
    runtimeRequest: options.runtimeRequest,
  });
  const sourceEvidenceComplete =
    evidence.complete && !hasOpenEndedQuoteSourceScope(options);
  const evidenceSignature = buildQuoteValidationEvidenceSignature(evidence);
  const reviewCitations = registeredQuoteCitationsForReview(
    markdown,
    quoteCitations,
  );
  const validationSignature = evidenceSignature
    ? [
        `policy:${QUOTE_VALIDATION_POLICY_VERSION}`,
        evidenceSignature,
        sourceEvidenceComplete ? "complete" : "defer",
        requireBodyEvidenceQuotes ? "body" : "all",
        markdown,
        ...reviewCitations.map((citation) => JSON.stringify(citation)),
        ...secondaryEvidence.map((entry) =>
          [
            "secondary",
            entry.quoteKey,
            entry.contextItemId,
            entry.status,
            entry.status === "matched"
              ? entry.certificate.documentFingerprint
              : entry.status === "absent" ||
                  entry.status === "literal-not-found"
                ? entry.documentFingerprint
                : entry.reason,
            entry.status === "matched" ? entry.certificate.pageIndex : "",
            entry.status === "matched"
              ? entry.certificate.sourceMatchPageOccurrence
              : "",
            entry.status === "matched"
              ? entry.certificate.sourceMatchKind || "exact"
              : "",
            entry.status === "matched"
              ? entry.certificate.verificationMode || ""
              : "",
          ].join("\u241f"),
        ),
      ].join("\u241e")
    : null;
  const cacheKey = validationSignature
    ? quoteValidationCacheKey(validationSignature)
    : null;
  let finalized = cacheKey
    ? getCachedQuoteValidationDecision(cacheKey, validationSignature!)
    : null;
  if (!finalized) {
    noteQuoteValidationDecisionComputed();
    // Registered anchors identify what to review; their own text is never
    // evidence for that review. Expand the same deduplicated occurrences the
    // user sees so bare anchors and handwritten quotes take one path.
    const reviewMarkdown = buildQuoteExpandedMarkdown(
      { markdown, quoteCitations },
      { preserveParagraphCitations: true },
    );
    // Preserve paragraph source bindings while reviewing the separate cards.
    // These records never enter the independent evidence sources below.
    const paragraphIds = paragraphCitationIds(markdown);
    const paragraphCitations = quoteCitations?.filter((citation) =>
      paragraphIds.has(citation.id),
    );
    const independentIndex =
      preparedSourceIndex ||
      (evidenceSignature
        ? getOrBuildCachedQuoteSourceIndex(
            evidenceSignature,
            evidence.sourceTexts,
          )
        : buildQuoteSourceIndex({ sourceTexts: evidence.sourceTexts }));
    const sourceIndex = {
      ...independentIndex,
      quoteCitations: [],
      sources: independentIndex.sources.filter(
        (source) => source.origin !== "quote-citation",
      ),
    };
    finalized = cooperativeOptions
      ? await finalizeAssistantQuoteCitationsCooperatively(
          {
            markdown: reviewMarkdown,
            quoteCitations: paragraphCitations,
            sourceIndex,
            requireBodyEvidenceQuotes,
            quoteSourceReview: {
              sourceEvidenceComplete,
            },
            secondaryEvidence,
          },
          cooperativeOptions,
        )
      : finalizeAssistantQuoteCitations({
          markdown: reviewMarkdown,
          quoteCitations: paragraphCitations,
          sourceIndex,
          requireBodyEvidenceQuotes,
          quoteSourceReview: {
            sourceEvidenceComplete,
          },
          secondaryEvidence,
        });
    if (!finalized) return false;
    if (cacheKey && validationSignature) {
      cacheQuoteValidationDecision(cacheKey, validationSignature, finalized);
    }
  }
  const finalizedQuoteCitations = finalized.quoteCitations.length
    ? finalized.quoteCitations
    : undefined;
  const displayChanged =
    finalized.markdown !== markdown ||
    JSON.stringify(finalizedQuoteCitations || []) !==
      JSON.stringify(quoteCitations || []);
  const nextOverride = displayChanged
    ? {
        markdown: finalized.markdown,
        quoteCitations: finalizedQuoteCitations,
      }
    : undefined;
  const changed = !quoteDisplayOverridesEqual(
    assistantMessage.quoteDisplayOverride,
    nextOverride,
  );
  assistantMessage.quoteDisplayOverride = nextOverride;
  return changed;
}

export async function collectLivePdfQuoteSecondaryEvidence(params: {
  markdown: string;
  sourceIndex: ReturnType<typeof buildQuoteSourceIndex>;
  yieldToMain: () => Promise<void>;
  shouldContinue: () => boolean;
}): Promise<QuoteSecondaryEvidence[]> {
  // Route each request to whichever open reader holds its attachment, so the
  // verdict does not depend on which tab happens to be focused.
  const readersByItemId = new Map<number, any>();
  for (const reader of getAllOpenReaders()) {
    const readerItemId = Math.floor(
      Number(reader?._item?.id || reader?.itemID || 0),
    );
    if (readerItemId && !readersByItemId.has(readerItemId)) {
      readersByItemId.set(readerItemId, reader);
    }
  }
  if (!readersByItemId.size) return [];
  const requests = collectDisplayedQuoteVerificationRequests({
    markdown: params.markdown,
    sourceIndex: params.sourceIndex,
  }).filter((request) => readersByItemId.has(request.contextItemId));
  const out: QuoteSecondaryEvidence[] = [];
  for (const request of requests) {
    if (!params.shouldContinue()) break;
    const verification = await verifyCompleteQuoteInLivePdfJs(
      readersByItemId.get(request.contextItemId),
      request.contextItemId,
      request.quoteText,
      {
        yieldToMain: params.yieldToMain,
        shouldContinue: params.shouldContinue,
        allowInlineMathLocator:
          request.verificationMode === "inline-math-locator",
      },
    );
    if (verification.status === "matched") {
      out.push({
        quoteKey: request.quoteKey,
        contextItemId: request.contextItemId,
        status: "matched",
        certificate: verification.certificate,
      });
    } else if (verification.status === "literal-not-found") {
      out.push({
        quoteKey: request.quoteKey,
        contextItemId: request.contextItemId,
        status: "literal-not-found",
        documentFingerprint: verification.documentFingerprint,
      });
    } else {
      out.push({
        quoteKey: request.quoteKey,
        contextItemId: request.contextItemId,
        status: "defer",
        reason: verification.reason,
      });
    }
  }
  return out;
}
