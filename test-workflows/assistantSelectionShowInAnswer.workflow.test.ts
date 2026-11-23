/**
 * Text the user selects in an answer and quotes is literally in the chat:
 * clicking its composer chip must always light those same words, whatever
 * the answer draws them with (bold, list items, links, code, typeset maths).
 * The chip itself keeps the selection as Markdown for the model.
 */
import { assert } from "chai";
import { renderMarkdown } from "../src/utils/markdown";
import {
  findQuoteAroundGaps,
  foldAnswerWords,
} from "../src/modules/contextPanel/answerQuoteHighlight";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

const compact = (text: string) => text.replace(/\s+/g, "");

const LIST_ANSWER = [
  "- **Sessions:** Data came from 11 sessions in 5 mice, totaling **4,741 layer 2/3 PPC neurons**.",
  "- **Performance breakdown:** Across those 11 sessions, 4 were classified as high-performance (>70% correct) and 7 as low-performance ($\\le$70% correct).",
  "- **When recording started:** Recording began once mice consistently exceeded 70% accuracy at a 1.5- or 2-s delay.",
].join("\n");

describe("workflow: selected answer text shows in the answer", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  let panelId = "";

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Selection Trace Paper",
      pdfTitle: "Selection Trace PDF",
      pages: ["Selection trace page."],
    });
    panelId = (await api.renderPanelForItem(fixture.parentItemId)).panelId;
  });

  afterEach(async function () {
    if (fixture) {
      await api.cleanupFixture(fixture);
      fixture = null;
    }
    await api.reset();
  });

  it("lights a bold list item with maths in it", async function () {
    const result = await api.exerciseAssistantSelectionShowInAnswer({
      panelId,
      markdown: LIST_ANSWER,
      startText: "Performance breakdown:",
      endText: "correct).",
    });
    const message = JSON.stringify(result);
    // The chip keeps Markdown for the model.
    assert.include(result.chipText, "**Performance breakdown:**", message);
    assert.include(result.chipText, "$\\le$", message);
    assert.equal(
      result.statusText,
      "Showing the quoted text in the answer",
      message,
    );
    assert.equal(
      compact(result.litText),
      compact(
        "Performance breakdown: Across those 11 sessions, 4 were classified as high-performance (>70% correct) and 7 as low-performance (70% correct).",
      ),
      message,
    );
  });

  it("lights a selection that runs across two list items", async function () {
    const result = await api.exerciseAssistantSelectionShowInAnswer({
      panelId,
      markdown: LIST_ANSWER,
      startText: "4,741 layer",
      endText: "high-performance",
    });
    const message = JSON.stringify(result);
    assert.equal(
      result.statusText,
      "Showing the quoted text in the answer",
      message,
    );
    assert.equal(
      compact(result.litText),
      compact(
        "4,741 layer 2/3 PPC neurons. Performance breakdown: Across those 11 sessions, 4 were classified as high-performance",
      ),
      message,
    );
  });

  it("lights a selection with a link and inline code", async function () {
    const result = await api.exerciseAssistantSelectionShowInAnswer({
      panelId,
      markdown:
        "The raw traces are in the [shared dataset](https://example.org/data), decoded with `fit_decoder()` *per session*.",
      startText: "The raw",
      endText: "session",
    });
    const message = JSON.stringify(result);
    assert.equal(
      result.statusText,
      "Showing the quoted text in the answer",
      message,
    );
    assert.equal(
      compact(result.litText),
      compact(
        "The raw traces are in the shared dataset, decoded with fit_decoder() per session",
      ),
      message,
    );
  });

  it("lights the main chat from a chip quoted into a side chat", async function () {
    const side = await api.renderSidePanelForItem({
      itemId: fixture!.parentItemId,
      mode: "paper",
    });
    const result = await api.exerciseAssistantSelectionShowInAnswer({
      panelId,
      markdown: LIST_ANSWER,
      startText: "Performance breakdown:",
      endText: "correct).",
      sideChatPanelId: side.panelId,
    });
    const message = JSON.stringify(result);
    assert.include(result.chipText, "**Performance breakdown:**", message);
    assert.equal(
      result.statusText,
      "Showing the quoted text in the answer",
      message,
    );
    assert.equal(
      compact(result.litText),
      compact(
        "Performance breakdown: Across those 11 sessions, 4 were classified as high-performance (>70% correct) and 7 as low-performance (70% correct).",
      ),
      message,
    );
  });

  it("typesets inline maths right before a number but keeps money as text", function () {
    assert.include(renderMarkdown("low ($\\le$70% correct)"), "katex");
    assert.include(renderMarkdown("about $\\sim$5 trials"), "katex");
    assert.notInclude(renderMarkdown("It costs $5-$10 per month."), "katex");
    assert.notInclude(renderMarkdown("Prices: $5,$10 and $20."), "katex");
  });

  it("finds a cited sentence around maths typeset right before a number", function () {
    // The drawn words, the typeset "≤" left out as the highlighter does.
    const drawn = foldAnswerWords(
      "Across sessions, 7 were classified as low-performance (70% correct) by the criterion.",
    );
    const span = findQuoteAroundGaps(
      drawn,
      "7 were classified as low-performance ($\\le$70% correct) by the criterion.",
    );
    assert.isNotNull(span);
    assert.equal(
      drawn.slice(span![0], span![1]),
      "7 were classified as low-performance (70% correct) by the criterion.",
    );
  });
});
