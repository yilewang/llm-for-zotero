import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

const ASSISTANT_TEXT = [
  "Intro sentence outside the selection.",
  "",
  "## Heading",
  "",
  "First paragraph with **bold** words.",
  "",
  "```text",
  "alpha line",
  "beta line",
  "```",
  "",
  "Paragraph between the code blocks.",
  "",
  "```python",
  "def f(x):",
  "    return x * 2",
  "print(f(3))",
  "```",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| left | right |",
  "",
  "Inline math $x^2$ stays inline.",
  "",
  "Final sentence after everything.",
].join("\n");

describe("workflow: assistant selection saved as a note", function () {
  this.timeout(60000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    if (fixture) {
      await api.cleanupFixture(fixture);
      fixture = null;
    }
    await api.reset();
  });

  async function run(
    selection: "full" | "code",
    codeStart?: string,
    codeEnd?: string,
  ) {
    fixture = await api.createPaperWithPdfFixture({
      title: "Selection Note Paper",
      pdfTitle: "Selection Note PDF",
      pages: ["Selection note page."],
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    return api.exerciseAssistantSelectionNoteSave({
      panelId: panel.panelId,
      assistantText: ASSISTANT_TEXT,
      selection,
      codeStart,
      codeEnd,
    });
  }

  it("keeps a long selection across code blocks, with its structure, in the extracted text and the note", async function () {
    const result = await run("full");
    const message = JSON.stringify(result, null, 2);
    assert.isTrue(result.bubbleHasContentBar, message);
    assert.isAtLeast(result.rangeCount, 2, message);
    const text = result.extracted;
    // The answer renderer shifts "##" down to an h3, so the DOM yields "###".
    assert.match(text, /^#{2,3} Heading$/m, message);
    assert.include(text, "```text\nalpha line\nbeta line\n```", message);
    assert.include(text, "```python", message);
    assert.include(text, "    return x * 2", message);
    assert.match(text, /\| left \| right \|/, message);
    assert.include(text, "$x^2$", message);
    assert.include(text, "Final sentence after everything.", message);
    assert.notMatch(text, /^text$/m, message);
    assert.notInclude(text, "⧉", message);
    assert.notInclude(text, "Intro sentence outside the selection.", message);

    const html = result.noteHtml;
    assert.match(html, /<h[23]/, message);
    assert.match(html, /<pre/, message);
    assert.include(html, "return x * 2", message);
    assert.match(html, /<table|right/, message);
    assert.include(html, "Final sentence after everything.", message);
    assert.notInclude(html, "Intro sentence outside the selection.", message);
  });

  it("returns only the selected lines, fenced, for a selection inside one code body", async function () {
    const result = await run("code", "return x * 2", "print(f(3))");
    const message = JSON.stringify(result, null, 2);
    assert.equal(
      result.extracted,
      "```python\nreturn x * 2\nprint(f(3))\n```",
      message,
    );
  });
});
