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

    assert.include(css, ".llm-quote-card");
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

  it("defaults quote cards to the collapsed visual state", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, 'wrapper.dataset.expanded = "false"');
    assert.include(
      renderSource,
      'content.setAttribute("aria-expanded", "false")',
    );
    assert.notInclude(renderSource, 'title.textContent = "Evidence quote"');
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

  it("renders completed quote-card bodies through the markdown renderer", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "renderQuoteCardBodyMarkdown");
    assert.include(renderSource, "renderRenderedMarkdownInto(container");
    assert.include(renderSource, "appendQuoteCardBodyContent");
    assert.include(renderSource, "body.classList.add");
    assert.notInclude(
      renderSource,
      'body.textContent = sanitizeText(params.quoteText || "").trim();',
    );
  });

  it("renders collapsed quote-card previews through the markdown renderer", function () {
    const renderSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(renderSource, "renderQuoteCardPreviewMarkdown");
    assert.include(renderSource, "preview.classList.add");
    assert.notInclude(
      renderSource,
      "preview.textContent = buildQuotePreviewText(params.quoteText);",
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
      "const lookupText = getQuoteCitationLookupText",
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

  it("warms local paper text before final quote verification", function () {
    const chatSource = source("src/modules/contextPanel/chat.ts");

    assert.include(chatSource, "warmPageTextCacheForAttachment");
    assert.include(chatSource, 'sourceMatchSource: "pdf-page-text"');
    assert.include(chatSource, "ensureQuoteSourceTextCachedForPaper");
    assert.include(chatSource, "assistantMarkdownNeedsQuoteSourceSearch");
    assert.include(chatSource, "await ensurePDFTextCached(contextItem");
    assert.include(chatSource, 'paper.contentSourceMode || ""');
    assert.include(chatSource, "!hasCachedQuoteSourceText(contextItemId) &&");
    assert.include(chatSource, "pdfTextCache.has(contextItemId)");
    assert.include(chatSource, "await buildQuoteSourceTextsForPaperContexts");
    assert.include(chatSource, "await finalizeAssistantMessageQuoteCitations");
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
      "await deps.finalizeAssistantQuoteCitations(assistantMessage, userMessage)",
    );
    assert.include(
      agentSource,
      "await deps.finalizeAssistantQuoteCitations(\n      assistantMessage",
    );
  });
});
