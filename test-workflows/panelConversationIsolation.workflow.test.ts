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

  for (const scenario of [
    {
      name: "pointer history search",
      activation: "pointer" as const,
      repetitions: 5,
    },
    {
      name: "delayed keyboard history search",
      activation: "keyboard" as const,
      delaySelection: true,
      repetitions: 5,
    },
    {
      name: "ordinary history row",
      activation: "history-row" as const,
      repetitions: 1,
    },
  ]) {
    it(`never mounts paper B into reader A after ${scenario.name}`, async function () {
      const selectedText = `workflow reader A selected text ${Date.now()}`;
      const paperA = await api.createPaperWithPdfFixture({
        title: `Workflow History Isolation Paper A ${scenario.name}`,
        pdfTitle: "Workflow History Isolation PDF A",
        pages: [selectedText],
      });
      const paperB = await api.createPaperWithPdfFixture({
        title: `Workflow History Isolation Paper B ${scenario.name}`,
        pdfTitle: "Workflow History Isolation PDF B",
        pages: ["paper B must never appear in reader A"],
      });
      fixtures.push(paperA, paperB);
      const panelA = await api.renderPanelForItem(paperA.pdfAttachmentId);
      const panelB = await api.renderPanelForItem(paperB.pdfAttachmentId);
      for (
        let repetition = 1;
        repetition <= scenario.repetitions;
        repetition += 1
      ) {
        const markerSuffix = `${Date.now()}-${repetition}`;
        const paperAMarker = `paper-a-history-marker-${markerSuffix}`;
        const paperBMarker = `paper-b-history-marker-${markerSuffix}`;
        const promptMarker = `paper-a-send-marker-${markerSuffix}`;

        const result = await api.exerciseCrossPaperHistoryReturnIsolation({
          panelAId: panelA.panelId,
          panelBId: panelB.panelId,
          paperAItemId: paperA.parentItemId,
          paperAAttachmentItemId: paperA.pdfAttachmentId,
          paperBItemId: paperB.parentItemId,
          paperAMarker,
          paperBMarker,
          promptMarker,
          selectedText,
          activation: scenario.activation,
          delaySelection: scenario.delaySelection,
        });

        assert.notEqual(
          result.paperAConversationKey,
          result.paperBConversationKey,
          diagnosticsMessage(result),
        );
        if (scenario.activation !== "history-row") {
          assert.equal(
            result.selectedLibraryItemID,
            paperB.parentItemId,
            diagnosticsMessage(result),
          );
        }
        assert.isFalse(
          result.foreignMutationObserved,
          diagnosticsMessage(result),
        );
        assert.equal(
          result.panelAConversationKey,
          result.paperAConversationKey,
          diagnosticsMessage(result),
        );
        assert.equal(
          result.panelABasePaperItemID,
          paperA.parentItemId,
          diagnosticsMessage(result),
        );
        assert.equal(
          result.panelARawContextItemID,
          paperA.pdfAttachmentId,
          diagnosticsMessage(result),
        );
        assert.include(
          result.panelAMessageText,
          paperAMarker,
          diagnosticsMessage(result),
        );
        assert.notInclude(
          result.panelAMessageText,
          paperBMarker,
          diagnosticsMessage(result),
        );
        assert.equal(
          result.requestConversationKey,
          result.paperAConversationKey,
          diagnosticsMessage(result),
        );
        assert.equal(
          result.requestItemID,
          paperA.parentItemId,
          diagnosticsMessage(result),
        );
        assert.isTrue(result.addTextStoredForA, diagnosticsMessage(result));
        assert.isFalse(result.addTextStoredForB, diagnosticsMessage(result));
        assert.equal(
          result.paperBMessageRowsAfter,
          result.paperBMessageRowsBefore,
          diagnosticsMessage(result),
        );
      }
    });
  }
});
