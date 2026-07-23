import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(here, "..", path), "utf8");
}

describe("quote card UI contract", function () {
  it("defines expandable quote-card styling", function () {
    const css = source("addon/content/zoteroPane.css");
    const quoteCardRuleStart = css.indexOf(".llm-quote-card {");
    const quoteCardRuleEnd = css.indexOf("}", quoteCardRuleStart);
    const quoteCardRule = css.slice(quoteCardRuleStart, quoteCardRuleEnd);

    assert.include(css, ".llm-quote-card");
    assert.isAtLeast(quoteCardRuleStart, 0);
    assert.isAbove(quoteCardRuleEnd, quoteCardRuleStart);
    assert.include(quoteCardRule, "margin: 10px 0");
    assert.include(css, ".llm-quote-card-content");
    assert.include(css, ".llm-quote-card-body");
    assert.include(css, '.llm-quote-card[data-expanded="false"]');
    assert.include(css, "-webkit-line-clamp: 2");
    assert.include(css, '.llm-quote-card[data-expanded="false"]:hover');
    assert.include(css, "--llm-quote-card-rail");
    assert.include(css, "--llm-quote-card-rail: var(--color-accent)");
    assert.include(css, "border-left: 3px solid var(--llm-quote-card-rail)");
    assert.include(css, "border: none");
    assert.include(css, "justify-content: flex-end");
    assert.include(css, "background: transparent");
    assert.include(css, "background: var(--llm-quote-card-surface)");
  });

  it("isolates message layout and paint work while scrolling", function () {
    const css = source("addon/content/zoteroPane.css");
    const messageRuleStart = css.indexOf(".llm-message-wrapper {");
    const messageRuleEnd = css.indexOf("}", messageRuleStart);
    const messageRule = css.slice(messageRuleStart, messageRuleEnd);

    assert.isAtLeast(messageRuleStart, 0);
    assert.isAbove(messageRuleEnd, messageRuleStart);
    assert.include(messageRule, "contain: layout paint style");
  });

  it("defines noninteractive amber styling for not-source quote cards", function () {
    const css = source("addon/content/zoteroPane.css");

    assert.include(css, '.llm-quote-card[data-quote-status="not-source"]');
    assert.include(css, '.llm-quote-card[data-quote-status="unverified"]');
    assert.include(css, "--llm-quote-card-rail: #f59e0b");
    assert.include(css, "font-style: normal");
    assert.include(css, "cursor: default");
    assert.include(
      css,
      '.llm-quote-card[data-quote-status="not-source"] .llm-quote-card-content',
    );
    assert.include(css, "padding-bottom: 8px");
  });

  it("defaults quote cards to the collapsed visual state", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(
      renderSource,
      'wrapper.dataset.expanded = interactive ? "false" : "true"',
    );
    assert.include(
      renderSource,
      'content.setAttribute("aria-expanded", "false")',
    );
    assert.notInclude(renderSource, 'title.textContent = "Evidence quote"');
  });

  it("keeps rejected cards expanded and noninteractive", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "wrapper.dataset.quoteStatus = status");
    assert.include(renderSource, 'const interactive = status === "verified"');
    assert.include(
      renderSource,
      'wrapper.dataset.expanded = interactive ? "false" : "true"',
    );
    assert.include(renderSource, "if (!interactive) {");
    assert.include(
      renderSource,
      'type QuoteCardStatus = "verified" | "unverified" | "not-source"',
    );
    assert.notInclude(
      renderSource,
      "markQuoteCardUnverifiedAfterNavigationFailure",
    );
  });

  it("keeps the not-source card non-interactive without a visible label", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );
    const notSourceBranchStart = renderSource.indexOf(
      'if (params.occurrence.trust === "not-source-quote")',
    );
    const nextBranchStart = renderSource.indexOf(
      "const extractedCitation = extractStandalonePaperSourceLabel(",
      notSourceBranchStart,
    );
    const notSourceBranch = renderSource.slice(
      notSourceBranchStart,
      nextBranchStart,
    );

    assert.include(renderSource, 'status: "not-source"');
    assert.include(renderSource, "if (!interactive) {");
    assert.include(renderSource, "citationContent?: Node");
    assert.include(renderSource, "if (params.citationContent)");
    assert.isAtLeast(notSourceBranchStart, 0);
    assert.isAbove(nextBranchStart, notSourceBranchStart);
    assert.notInclude(notSourceBranch, "citationContent");
    assert.notInclude(renderSource, "Related source:");
  });

  it("keeps citation activation separate from quote-card toggling", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "createQuoteCardElement");
    assert.include(renderSource, 'textSpan.setAttribute("role", "button")');
    assert.include(renderSource, "handleCitationMouseDown");
    assert.include(renderSource, "event.stopPropagation();");
    assert.include(renderSource, "toggleExpanded();");
    assert.include(renderSource, 'wrapper.addEventListener("click"');
    assert.include(
      renderSource,
      ".llm-citation-row, .llm-citation-inline-wrap",
    );
  });

  it("renders completed quote-card bodies lazily through the markdown renderer", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "renderQuoteCardBodyMarkdown");
    assert.include(renderSource, "renderRenderedMarkdownInto(container");
    assert.include(renderSource, "appendQuoteCardBodyContent");
    assert.include(renderSource, "body.classList.add");
    assert.include(renderSource, "const ensureBodyRendered = () =>");
    assert.include(renderSource, "if (bodyRendered) return");
    assert.include(renderSource, "if (expanded) ensureBodyRendered()");
    assert.notInclude(
      renderSource,
      'body.textContent = sanitizeText(params.quoteText || "").trim();',
    );
  });

  it("renders collapsed quote-card previews as lightweight plain text", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "buildQuoteCardPreviewText");
    assert.include(
      renderSource,
      "preview.textContent =\n    buildQuoteCardPreviewText(params.quoteText)",
    );
    assert.notInclude(renderSource, "renderQuoteCardPreviewMarkdown");
  });

  it("does not construct a hidden preview for rejected quote cards", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );
    const noninteractiveStart = renderSource.indexOf("if (!interactive) {");
    const noninteractiveEnd = renderSource.indexOf(
      "const preview = params.ownerDoc.createElement",
      noninteractiveStart,
    );
    const noninteractiveBranch = renderSource.slice(
      noninteractiveStart,
      noninteractiveEnd,
    );

    assert.isAtLeast(noninteractiveStart, 0);
    assert.isAbove(noninteractiveEnd, noninteractiveStart);
    assert.include(noninteractiveBranch, "ensureBodyRendered()");
    assert.include(noninteractiveBranch, "content.appendChild(body)");
    assert.include(noninteractiveBranch, "return wrapper");
    assert.notInclude(noninteractiveBranch, "llm-quote-card-preview");
  });

  it("renders immediately visible quote bodies in one Markdown batch", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );
    const batchStart = renderSource.indexOf(
      "function renderImmediateQuoteBodiesBatch(",
    );
    const batchEnd = renderSource.indexOf(
      "function textContainsQuoteCitationPlaceholder(",
      batchStart,
    );
    const batchSource = renderSource.slice(batchStart, batchEnd);

    assert.isAtLeast(batchStart, 0);
    assert.isAbove(batchEnd, batchStart);
    assert.include(batchSource, "buildQuoteBodyBatchMarkdown(immediate)");
    assert.include(batchSource, "renderRenderedMarkdownInto(");
    assert.include(
      batchSource,
      "renderedBlockquotes.length !== immediate.length",
    );
    assert.include(
      renderSource,
      "immediateQuoteBodies.get(occurrence.occurrenceId) || null",
    );
  });

  it("preserves rendered blockquote DOM for quote-card display without changing lookup text", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "quoteContent?: DocumentFragment | null");
    assert.include(renderSource, "buildQuoteCardBodyContentFromBlockquote");
    assert.include(
      renderSource,
      "const displayedQuoteContent = buildQuoteCardBodyContentFromBlockquote",
    );
    assert.include(renderSource, "quoteContent: displayedQuoteContent");
    assert.include(renderSource, "quoteText: lookupQuoteText");
    assert.include(renderSource, "paragraphQuoteText: trustedQuoteText");
    assert.notInclude(
      renderSource,
      "quoteText = trustedQuoteCitation.quoteText;\n    const lookupQuoteText",
    );
  });

  it("renders quote placeholders from display text while keeping source text for lookup", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "getQuoteCitationDisplayText");
    assert.include(renderSource, "displayQuoteText");
    assert.include(
      renderSource,
      "const displayText = getQuoteCitationDisplayText",
    );
    assert.include(renderSource, "quoteText: displayText");
    assert.include(
      renderSource,
      "paragraphQuoteText: params.quoteCitation.quoteText",
    );
    assert.include(
      renderSource,
      "const lookupText = resolveQuoteCitationLookupText",
    );
  });

  it("sanitizes quote-card display and rejects short locator-only lookup text", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );
    const navigationSource = source(
      "src/modules/contextPanel/quoteNavigationText.ts",
    );

    assert.include(renderSource, "stripQuoteCitationAnchorsFromDisplayText");
    assert.include(
      renderSource,
      "stripQuoteCitationAnchorsFromDisplayText(\n    citation.displayQuoteText || citation.quoteText",
    );
    assert.include(renderSource, "resolveQuoteCitationLookupText");
    assert.include(navigationSource, "normalizeQuoteCitationNavigationText");
    assert.include(navigationSource, "hasShortPrefixBeforeQuoteLookupText");
    assert.include(navigationSource, "isLowCoverageQuoteLocator");
    assert.include(
      navigationSource,
      "return isLowCoverageQuoteLocator(sourceMatchText, quoteText)",
    );
    assert.include(
      navigationSource,
      '.replace(/(^|\\n)\\s{0,3}#{1,6}\\s+/g, "$1")',
    );
  });

  it("does not toggle expanded quote cards during text selection or context menu", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "hasActiveQuoteCardTextSelection");
    assert.include(renderSource, "quoteCardPointerMoved");
    assert.include(renderSource, "shouldSuppressQuoteCardToggle");
    assert.include(renderSource, 'wrapper.addEventListener("contextmenu"');
    assert.include(renderSource, 'wrapper.addEventListener("mouseup"');
  });

  it("renders trusted anchors and fallback blockquotes through the quote-card component", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "createFallbackQuoteCardElement");
    assert.include(renderSource, "replaceBlockquoteWithFallbackQuoteCard");
    assert.include(renderSource, "citationContent.textContent = citationLabel");
    assert.include(
      renderSource,
      "citationLabel: extractedCitation.sourceLabel",
    );
    assert.include(renderSource, 'navigationMode: "trusted-quote"');
    assert.include(renderSource, 'navigationMode: "untrusted-quote"');
    assert.include(renderSource, "citationContent: citationElement");
    assert.notInclude(renderSource, 'citationContent.textContent = "Quote"');
    assert.notInclude(
      renderSource,
      "rendering unanchored source-backed quote card",
    );
    assert.include(renderSource, "citationContent: citationElement");
    assert.notInclude(
      renderSource,
      "citationEl.parentNode?.removeChild(citationEl);",
    );
    assert.include(
      renderSource,
      'params.quoteCitationId\n    ? "llm-quote-card llm-quote-citation-anchor"\n    : "llm-quote-card"',
    );
    assert.include(renderSource, "wrapper.dataset.quoteOccurrenceId");
  });

  it("starts a cited legacy quote occurrence verified and clickable", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );
    const untrustedStart = renderSource.indexOf(
      'navigationMode: "untrusted-quote"',
      renderSource.indexOf("function createQuoteRenderOccurrenceElement"),
    );
    const untrustedEnd = renderSource.indexOf(
      "function textContainsQuoteCitationPlaceholder",
      untrustedStart,
    );
    const untrustedBranch = renderSource.slice(untrustedStart, untrustedEnd);

    assert.isAtLeast(untrustedStart, 0);
    assert.isAbove(untrustedEnd, untrustedStart);
    assert.include(untrustedBranch, 'status: "verified"');
    assert.notInclude(untrustedBranch, 'status: "unverified"');
  });

  it("starts a cited legacy fallback blockquote verified and clickable", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );
    const fallbackStart = renderSource.indexOf(
      "function createFallbackQuoteCardElement",
    );
    const fallbackEnd = renderSource.indexOf(
      "function createQuoteCitationAnchorElement",
      fallbackStart,
    );
    const fallbackRenderer = renderSource.slice(fallbackStart, fallbackEnd);

    assert.isAtLeast(fallbackStart, 0);
    assert.isAbove(fallbackEnd, fallbackStart);
    assert.include(renderSource, 'const status = params.status || "verified"');
    assert.notInclude(fallbackRenderer, 'status: "unverified"');
    assert.notInclude(fallbackRenderer, 'status: "not-source"');
  });

  it("lifts rendered quote cards out of markdown paragraphs", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "liftQuoteCardsOutOfParagraph");
    assert.include(renderSource, 'classList?.contains("llm-quote-card")');
    assert.include(renderSource, 'parent?.tagName.toLowerCase() === "p"');
    assert.include(renderSource, "parent.replaceChild(replacement, paragraph)");
  });

  it("separates the cache-only quote gate from background warming", function () {
    const chatSource = source("src/modules/contextPanel/chat.ts");

    assert.include(chatSource, "warmPageTextCacheForAttachment");
    assert.include(chatSource, "getCachedPageTextForAttachment");
    assert.include(chatSource, 'sourceMatchSource: "pdf-page-text"');
    assert.include(chatSource, "ensureQuoteSourceTextCachedForPaper");
    assert.include(chatSource, "assistantMarkdownNeedsQuoteSourceSearch");
    assert.include(chatSource, "await ensurePDFTextCached(contextItem");
    assert.include(chatSource, 'paper.contentSourceMode || ""');
    assert.include(chatSource, "!hasCachedQuoteSourceText(contextItemId) &&");
    assert.include(chatSource, "pdfTextCache.has(contextItemId)");
    assert.include(
      chatSource,
      "const evidence = buildCachedQuoteSourceEvidenceForPaperContexts(",
    );
    assert.include(chatSource, "await warmQuoteSourceCachesForPaperContexts(");
    assert.include(chatSource, "pendingQuoteValidations");
    assert.include(chatSource, "startConversationQuoteValidation");
    assert.include(chatSource, "scheduleAssistantMessageQuoteValidation(");
  });

  it("decorates citation blockquotes after all assistant markdown surfaces are mounted", function () {
    const chatSource = source("src/modules/contextPanel/chat.ts");
    const answerRenderStart = chatSource.indexOf(
      "if (hasAnswerText && !agentUsesInterleavedText)",
    );
    const headerInsertion = chatSource.indexOf(
      "for (let i = bubbleHeaderNodes.length - 1; i >= 0; i -= 1)",
    );
    const generatedImagesRender = chatSource.indexOf(
      "if (hasGeneratedImages)",
      headerInsertion,
    );
    const finalDecoration = chatSource.indexOf(
      "decorateCompletedAssistantCitationLinks({",
      headerInsertion,
    );

    assert.isAtLeast(answerRenderStart, 0);
    assert.isAbove(headerInsertion, answerRenderStart);
    assert.isAbove(generatedImagesRender, headerInsertion);
    assert.isAbove(finalDecoration, generatedImagesRender);
    assert.notInclude(
      chatSource.slice(answerRenderStart, headerInsertion),
      "decorateAssistantCitationLinks({",
    );
  });

  it("awaits quote finalization in agent completion paths", function () {
    const agentSource = source(
      "src/modules/contextPanel/agentMode/agentEngine.ts",
    );

    assert.include(
      agentSource,
      "await deps.finalizeAssistantQuoteCitations(\n      assistantMessage,\n      userMessage,\n      runtimeRequest,",
    );
    assert.include(
      agentSource,
      "await deps.finalizeAssistantQuoteCitations(\n      assistantMessage,\n      retryPair.userMessage,\n      runtimeRequest,",
    );
  });
});
