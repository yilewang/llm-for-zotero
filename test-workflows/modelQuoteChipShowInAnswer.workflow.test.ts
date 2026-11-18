/**
 * A composer chip quoting a model response shows its words in the answer
 * when clicked, as "Show in answer" does from Task progress.
 */
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

const OLDER = [
  "Place cells change their firing fields over days.",
  "This drift is slower in familiar environments than in novel ones.",
];
const NEWER = [
  "Synaptic turnover is one candidate mechanism.",
  "Drift is slower in familiar environments, as noted before.",
];

describe("workflow: model quote chip shows its text in the answer", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;
  let panelId = "";

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Model Quote Paper",
      pdfTitle: "Model Quote PDF",
      pages: ["Model quote page."],
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

  it("lights a quote that runs across two paragraphs of its answer", async function () {
    const result = await api.exerciseModelQuoteChipShowInAnswer({
      panelId,
      answers: [OLDER, NEWER],
      quote: "over days. This drift is slower",
    });
    const message = JSON.stringify(result);
    assert.equal(result.litAnswerIndex, 0, message);
    assert.equal(result.litText, "over days.|This drift is slower", message);
    assert.equal(
      result.statusText,
      "Showing the quoted text in the answer",
      message,
    );
    assert.isFalse(result.chipExpanded, message);
  });

  it("lights the newest answer when two hold the quote", async function () {
    const result = await api.exerciseModelQuoteChipShowInAnswer({
      panelId,
      answers: [OLDER, NEWER],
      quote: "slower in familiar environments",
    });
    const message = JSON.stringify(result);
    assert.equal(result.litAnswerIndex, 1, message);
    assert.equal(result.litText, "slower in familiar environments", message);
  });

  it("expands the chip and says so when the quote is not in the chat", async function () {
    const result = await api.exerciseModelQuoteChipShowInAnswer({
      panelId,
      answers: [OLDER],
      quote: "words no answer holds",
    });
    const message = JSON.stringify(result);
    assert.equal(result.litText, "", message);
    assert.equal(
      result.statusText,
      "Couldn't find the quoted text in the chat",
      message,
    );
    assert.isTrue(result.chipExpanded, message);
  });
});
