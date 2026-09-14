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

function getResponseDocumentWindow(): Window | null {
  return (
    (Services as any).wm?.getMostRecentWindow?.(
      "llmforzotero:response-document",
    ) || null
  );
}

async function waitForResponseDocument(): Promise<Window> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const win = getResponseDocumentWindow();
    const root = win?.document?.getElementById(
      "llmforzotero-standalone-response-document-root",
    );
    if (win && !win.closed && root?.textContent?.trim()) return win;
    await Zotero.Promise.delay(25);
  }
  throw new Error("Timed out waiting for the larger response view");
}

function clickResponseExpand(
  root: Element,
  assistantTimestamp: number,
): HTMLButtonElement {
  const button = root.querySelector(
    `.llm-message-action-expand[data-assistant-timestamp="${assistantTimestamp}"]`,
  ) as HTMLButtonElement | null;
  assert.isOk(button, "larger-view footer action should be rendered");
  const order = Array.from(button!.parentElement?.children || []).map(
    (node) => (node as HTMLElement).dataset.responseAction || "retry",
  );
  assert.deepEqual(order.slice(-2), ["delete", "expand"]);
  button!.click();
  return button!;
}

function assertResponseOnlyDocument(
  win: Window,
  modelName: string,
  answerText: string,
  promptText: string,
): void {
  const doc = win.document;
  const root = doc.getElementById(
    "llmforzotero-standalone-response-document-root",
  );
  assert.isOk(root, "response document root should exist");
  assert.equal(doc.title, `Response from ${modelName}`);
  assert.equal(
    root!.querySelector(".llm-response-document-window-title")?.textContent,
    `Response from ${modelName}`,
  );
  assert.include(root!.textContent || "", answerText);
  assert.notInclude(root!.textContent || "", promptText);
  assert.isNull(root!.querySelector("#llm-input"));
  assert.isNull(root!.querySelector(".llm-agent-reasoning"));
  assert.isNull(root!.querySelector(".llm-agent-trace"));
  assert.isNull(root!.querySelector(".llm-standalone-sidebar"));
}

describe("workflow: per-response larger document view", function () {
  this.timeout(60_000);
  const api = getWorkflowTestApi();
  const fixtures: WorkflowTestFixture[] = [];

  afterEach(async function () {
    getResponseDocumentWindow()?.close();
    await api.closeStandalone();
    while (fixtures.length) {
      const fixture = fixtures.pop();
      if (fixture) await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("opens one completed embedded-panel response without surrounding chat UI", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Larger Response Panel Paper",
      pdfTitle: "Larger Response Panel PDF",
    });
    fixtures.push(fixture);
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const prompt = "PANEL_PROMPT_MUST_NOT_APPEAR";
    const answer = "Panel answer shown in the larger response view.";
    const seeded = await api.seedPanelStoredTurn(
      panel.panelId,
      prompt,
      answer,
      {
        modelName: "Workflow Model",
      },
    );
    const host = Zotero.getMainWindow().document.querySelector(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    );
    assert.isOk(host, "workflow panel host should be mounted");

    const button = clickResponseExpand(host!, seeded.assistantTimestamp);
    assert.equal(button.title, "Open response in larger view");
    const responseWin = await waitForResponseDocument();
    assertResponseOnlyDocument(responseWin, "Workflow Model", answer, prompt);
  });

  it("opens one completed standalone-chat response without the standalone chat shell", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Larger Response Standalone Paper",
      pdfTitle: "Larger Response Standalone PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);
    const prompt = "STANDALONE_PROMPT_MUST_NOT_APPEAR";
    const answer = "Standalone answer shown in the larger response view.";
    const assistantTimestamp = Date.now();
    await api.seedStandaloneConversation([
      { role: "user", text: prompt, timestamp: assistantTimestamp - 1 },
      {
        role: "assistant",
        text: answer,
        timestamp: assistantTimestamp,
        modelName: "Standalone Workflow Model",
      },
    ]);
    const standaloneWin = (Zotero as any).LLMForZotero?.data
      ?.standaloneWindow as Window | undefined;
    const content = standaloneWin?.document?.querySelector(
      ".llm-standalone-content",
    );
    assert.isOk(content, "standalone chat content should be mounted");

    clickResponseExpand(content!, assistantTimestamp);
    const responseWin = await waitForResponseDocument();
    assertResponseOnlyDocument(
      responseWin,
      "Standalone Workflow Model",
      answer,
      prompt,
    );
  });
});
