import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

describe("quote anchor leak boundaries", function () {
  it("renders assistant bubbles through the quote-anchor display helper", function () {
    const chatSource = source("src/modules/contextPanel/chat.ts");

    assert.include(
      chatSource,
      "const safeText = buildAssistantDisplayMarkdownForRender(msg);",
    );
    assert.notInclude(chatSource, "const safeText = sanitizeText(msg.text);");
    assert.notInclude(
      chatSource,
      "renderRenderedMarkdownInto(bubble, sanitizeText(msg.text",
    );
  });

  it("renders agent trace markdown through the quote-anchor display helper", function () {
    const traceSource = source("src/modules/contextPanel/agentTrace/render.ts");

    assert.include(traceSource, "buildAgentTraceMarkdownForRender(");
    assert.include(traceSource, "itemEntry.text,");
    assert.include(
      traceSource,
      "renderRenderedMarkdownInto(inlineEl, inlineText",
    );
    assert.notInclude(
      traceSource,
      "renderRenderedMarkdownInto(inlineEl, itemEntry.text",
    );
    assert.notInclude(traceSource, "inlineEl.textContent = itemEntry.text");
  });

  it("copies and exports quote anchors with unresolved placeholders omitted", function () {
    const chatSource = source("src/modules/contextPanel/chat.ts");
    const notesSource = source("src/modules/contextPanel/notes.ts");
    const menuSource = source(
      "src/modules/contextPanel/setupHandlers/controllers/menuActionController.ts",
    );

    assert.include(menuSource, "target.quoteCitations");
    assert.include(chatSource, "buildQuoteExpandedMarkdown(");
    assert.include(notesSource, "buildQuoteExpandedMarkdown(");
    assert.include(chatSource, "buildQuoteDisplayMarkdown(");
    assert.notInclude(
      chatSource,
      "replaceQuoteCitationPlaceholdersForMarkdown(",
    );
    assert.notInclude(
      notesSource,
      "replaceQuoteCitationPlaceholdersForMarkdown(",
    );
    assert.notInclude(chatSource, "[quote unavailable]");
    assert.notInclude(notesSource, "[quote unavailable]");
  });

  it("renders citation continuation remainders as Markdown instead of raw text", function () {
    const citationSource = source(
      "src/modules/contextPanel/assistantCitationLinks.ts",
    );

    assert.include(
      citationSource,
      "extractLeadingPaperSourceLabelWithRemainder(",
    );
    assert.include(
      citationSource,
      "renderRenderedMarkdownInto(container, safeText, ownerDoc);",
    );
    assert.include(citationSource, "replacementText: citationRemainder");
    assert.notInclude(citationSource, "remainderEl.textContent");
    assert.notInclude(citationSource, "params.citationEl.textContent");
  });
});
