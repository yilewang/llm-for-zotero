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

function diagnosticsMessage(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe("workflow: cross-paper conversation isolation", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    while (fixtures.length) {
      const fixture = fixtures.pop();
      if (fixture) await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  it("keeps paper B mounted when paper A's delayed trace finishes", async function () {
    const paperA = await api.createPaperWithPdfFixture({
      title: "Workflow Delayed Trace Paper A",
      pdfTitle: "Workflow Delayed Trace PDF A",
    });
    const paperB = await api.createPaperWithPdfFixture({
      title: "Workflow Delayed Trace Paper B",
      pdfTitle: "Workflow Delayed Trace PDF B",
    });
    fixtures.push(paperA, paperB);

    const panel = await api.renderPanelForItem(paperA.parentItemId);
    const paperAMarker = "workflow paper A delayed trace marker";
    const paperBMarker = "workflow paper B active marker";
    const paperBAppendMarker = "workflow paper B post-trace append";
    const result = await api.exerciseStaleAgentTracePanelIsolation({
      panelId: panel.panelId,
      paperBItemId: paperB.parentItemId,
      paperAMarker,
      paperBMarker,
      paperBAppendMarker,
      runId: `workflow-delayed-trace-${Date.now()}`,
    });

    assert.notEqual(
      result.paperAConversationKey,
      result.paperBConversationKey,
      diagnosticsMessage(result),
    );
    assert.isTrue(result.traceCached, diagnosticsMessage(result));
    for (const diagnostics of [
      result.beforeTraceResolution,
      result.afterTraceResolution,
      result.afterPaperBAppend,
    ]) {
      assert.equal(
        diagnostics.activeItemId,
        paperB.parentItemId,
        diagnosticsMessage(diagnostics),
      );
      assert.equal(
        diagnostics.conversationKey,
        result.paperBConversationKey,
        diagnosticsMessage(diagnostics),
      );
      assert.equal(
        diagnostics.panelConversationKey,
        result.paperBConversationKey,
        diagnosticsMessage(diagnostics),
      );
      assert.include(
        diagnostics.messageText || "",
        paperBMarker,
        diagnosticsMessage(diagnostics),
      );
      assert.notInclude(
        diagnostics.messageText || "",
        paperAMarker,
        diagnosticsMessage(diagnostics),
      );
      assert.deepEqual(
        diagnostics.composerPaperContextKeys,
        [`${paperB.parentItemId}:${paperB.pdfAttachmentId}`],
        diagnosticsMessage(diagnostics),
      );
      assert.equal(
        diagnostics.contextSnapshot?.ownerItemId,
        paperB.parentItemId,
        diagnosticsMessage(diagnostics),
      );
      assert.equal(
        diagnostics.contextSnapshot?.paperContext?.title,
        "Workflow Delayed Trace Paper B",
        diagnosticsMessage(diagnostics),
      );
    }
    assert.include(
      result.afterPaperBAppend.messageText || "",
      paperBAppendMarker,
      diagnosticsMessage(result),
    );
    assert.equal(
      result.paperAMessageRowsAfterPaperBAppend,
      result.paperAMessageRowsBeforePaperBAppend,
      diagnosticsMessage(result),
    );
    assert.equal(
      result.paperBMessageRowsAfterPaperBAppend,
      result.paperBMessageRowsBeforePaperBAppend + 1,
      diagnosticsMessage(result),
    );
  });
});
