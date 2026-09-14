import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(here, "..", path), "utf8");
}

describe("standalone response document window", function () {
  it("uses the established reading size and a response-only root", function () {
    const markup = source("addon/content/standaloneResponseDocument.xhtml");

    assert.match(markup, /\bwidth="980"/);
    assert.match(markup, /\bheight="900"/);
    assert.include(
      markup,
      'id="llmforzotero-standalone-response-document-root"',
    );
    assert.notInclude(markup, "llm-input");
    assert.notInclude(markup, "llm-history");
  });

  it("renders only the final rich response content and generated images", function () {
    const windowSource = source(
      "src/modules/contextPanel/standaloneResponseDocumentWindow.ts",
    );

    assert.include(windowSource, "renderAssistantRichText");
    const shared = source("src/modules/contextPanel/assistantRichText.ts");
    assert.include(shared, "renderRenderedMarkdownInto");
    assert.include(shared, "renderQuoteCitationPlaceholders");
    assert.include(shared, "decorateAssistantCitationLinks");
    assert.include(shared, "decorateWebSourceIndicators");
    assert.include(windowSource, "renderAssistantGeneratedImagesInto");
    assert.include(windowSource, "Response from ${model}");
    assert.notInclude(windowSource, "reasoningSummary");
    assert.notInclude(windowSource, "renderAgentTrace");
  });

  it("places the larger-view action immediately after delete", function () {
    const chatSource = source("src/modules/contextPanel/chat.ts");
    const deleteAction = chatSource.indexOf(
      'className: "llm-message-action-delete"',
    );
    const expandAction = chatSource.indexOf(
      "appendAssistantResponseExpandAction({",
      deleteAction,
    );

    assert.isAtLeast(deleteAction, 0);
    assert.isAbove(expandAction, deleteAction);
  });
});
