import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { registerPreparedLibraryActions } from "../src/agent/tools/preparedLibraryActions";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  actionFixture,
  classifiedFixture,
} from "../test/helpers/semanticIntent";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import {
  createAgentRun,
  appendAgentRunEvent,
  finishAgentRun,
} from "../src/agent/store/traceStore";
import { readLatestActionContractCheckpoint } from "../src/agent/contracts/workflowCheckpoint";
import { getAgentRunTrace } from "../src/agent/store/traceStore";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";

describe("workflow: interrupted native batch", function () {
  this.timeout(60000);
  it("reloads durable progress and dispatches only the unfinished native item", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const mode = getOriginalAgentPermissionMode();
    const papers: Zotero.Item[] = [];
    const runId = `batch-recovery:${Date.now()}`;
    let succeeded = false;
    try {
      for (let i = 0; i < 3; i++) {
        const paper = new Zotero.Item("journalArticle");
        paper.libraryID = libraryID;
        paper.setField("title", `Batch recovery ${i}`);
        await paper.saveTx();
        papers.push(paper);
      }
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("auto");
      const action = {
        ...actionFixture("apply_tags", { tags: ["workflow-recovered"] })
          .actionIntents[0],
        coverage: "all" as const,
        targetSelectors: papers
          .slice(0, 2)
          .map((paper) => ({ kind: "item_id" as const, value: paper.id })),
      };
      const request = resolvedAgentRequest({
        conversationKey: papers[0].id,
        mode: "agent",
        libraryID,
        activeItemId: papers[0].id,
        userText: "Tag these two papers workflow-recovered",
        classifiedIntent: classifiedFixture({
          writeDisposition: "required",
          actionIntents: [action],
        }),
      });
      const gateway = new ZoteroGateway();
      const contracts = new ActionContractService(gateway);
      const registry = new AgentToolRegistry(contracts);
      registry.register(
        (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
          "library_update",
        ),
      );
      registerPreparedLibraryActions(registry, gateway);
      request.actionContract = await contracts.createContract(request);
      request.actionProgress = contracts.createProgress(request.actionContract);
      request.actionPreparation = { state: "ready", issues: [] };
      await createAgentRun({
        runId,
        conversationKey: request.conversationKey,
        mode: "agent",
        modelName: "native-batch",
        status: "running",
        createdAt: Date.now(),
      });
      let seq = 0;
      const context = {
        request,
        runId,
        item: papers[0],
        currentAnswerText: "",
        modelName: "native-batch",
        checkpointActionProgress: async () => {
          await appendAgentRunEvent(runId, ++seq, {
            type: "provider_event",
            providerType: "agent_action_contract",
            payload: {
              contract: request.actionContract,
              progress: request.actionProgress,
            },
          });
        },
      };
      const first = await registry.getNextWorkflowStep(request);
      assert.equal(first.kind, "action");
      if (first.kind !== "action") return;
      assert.deepEqual((first.prepared.call.arguments as any).itemIds, [
        papers[0].id,
      ]);
      const initial = await registry.prepareExecution(
        first.prepared.call,
        context,
        { checkpointedWorkflow: true },
      );
      assert.equal(initial.kind, "result");
      if (initial.kind === "result")
        assert.isTrue(
          initial.execution.result.ok,
          JSON.stringify(initial.execution.result.content),
        );
      await context.checkpointActionProgress();
      const second = await registry.getNextWorkflowStep(request);
      assert.equal(second.kind, "action");
      if (second.kind !== "action") return;
      assert.deepEqual((second.prepared.call.arguments as any).itemIds, [
        papers[1].id,
      ]);
      const nativeTarget = Zotero.Items.get(papers[1].id);
      const original = nativeTarget.saveTx;
      let interruptedSaves = 0;
      nativeTarget.saveTx = async () => {
        interruptedSaves++;
        throw new Error("Injected item save interruption");
      };
      try {
        const failed = await registry.prepareExecution(
          second.prepared.call,
          context,
          { checkpointedWorkflow: true },
        );
        assert.equal(failed.kind, "result");
        if (failed.kind === "result")
          assert.isFalse(
            failed.execution.result.ok,
            JSON.stringify(failed.execution.result),
          );
      } finally {
        nativeTarget.saveTx = original;
        await papers[1].reload(undefined, true);
      }
      assert.equal(
        interruptedSaves,
        1,
        "The native save interruption must fire",
      );
      const persistedTaggedIds = await Zotero.DB.columnQueryAsync(
        "SELECT itemID FROM itemTags JOIN tags USING (tagID) WHERE name=? AND itemID IN (?, ?) ORDER BY itemID",
        ["workflow-recovered", papers[0].id, papers[1].id],
      );
      assert.deepEqual(
        persistedTaggedIds,
        [papers[0].id],
        "Only the first item persisted",
      );
      await context.checkpointActionProgress();
      await papers[0].reload(undefined, true);
      assert.isTrue(papers[0].hasTag("workflow-recovered"));
      assert.isFalse(
        Zotero.Items.get(papers[1].id).hasTag("workflow-recovered"),
      );
      const trace = await getAgentRunTrace(runId);
      const checkpoint = readLatestActionContractCheckpoint(
        trace.events.map((event) => event.payload),
      );
      assert.isOk(checkpoint);
      request.actionContract = checkpoint!.contract;
      request.actionProgress = checkpoint!.progress;
      const retry = await registry.getNextWorkflowStep(request);
      assert.equal(retry.kind, "action");
      if (retry.kind !== "action") return;
      assert.deepEqual(
        (retry.prepared.call.arguments as any).itemIds,
        [papers[1].id],
        "Do not resubmit the already verified item",
      );
      const result = await registry.prepareExecution(
        retry.prepared.call,
        context,
        { checkpointedWorkflow: true },
      );
      assert.equal(result.kind, "result");
      await papers[1].reload(undefined, true);
      await papers[2].reload(undefined, true);
      assert.isTrue(
        Zotero.Items.get(papers[1].id).hasTag("workflow-recovered"),
      );
      assert.isFalse(papers[2].hasTag("workflow-recovered"));
      assert.equal(
        (await registry.getNextWorkflowStep(request)).kind,
        "complete",
      );
      succeeded = true;
    } finally {
      await finishAgentRun(
        runId,
        succeeded ? "completed" : "failed",
        "Native batch test finished",
      );
      setOriginalAgentPermissionMode(mode);
      await Zotero.DB.executeTransaction(async () => {
        for (const paper of papers) await paper.erase();
      });
    }
  });
});
