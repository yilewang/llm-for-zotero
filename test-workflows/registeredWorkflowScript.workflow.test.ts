import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
} from "../src/agent/store/traceStore";
import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import {
  actionFixture,
  classifiedFixture,
} from "../test/helpers/semanticIntent";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import type { AgentToolContext } from "../src/agent/types";

describe("workflow: registered operation script", function () {
  this.timeout(60000);
  it("composes collection creation and filing through authorization, native receipts, and durable journals", async function () {
    const mode = getOriginalAgentPermissionMode();
    const libraryID = Zotero.Libraries.userLibraryID;
    const source = new Zotero.Collection();
    source.libraryID = libraryID;
    source.name = `Workflow script source ${Date.now()}`;
    await source.saveTx();
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = libraryID;
    paper.setField("title", "Registered operation paper");
    paper.setCollections([source.id]);
    await paper.saveTx();
    const sentinel = new Zotero.Item("journalArticle");
    sentinel.libraryID = libraryID;
    sentinel.setField("title", "Unrelated script sentinel");
    sentinel.setCollections([source.id]);
    await sentinel.saveTx();
    let destination: Zotero.Collection | undefined;
    const runId = `native-workflow-script:${paper.key}`;
    let succeeded = false;
    try {
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("auto");
      const name = `Registered destination ${Date.now()}`;
      const create = actionFixture("create_collection", {
        collectionName: name,
        parentCollectionId: source.id,
      }).actionIntents[0];
      const file = {
        ...actionFixture("move_to_collection", { collectionName: name })
          .actionIntents[0],
        dependsOn: [0],
        targetSelectors: [{ kind: "item_id" as const, value: paper.id }],
      };
      const request = resolvedAgentRequest({
        conversationKey: paper.id,
        mode: "agent",
        libraryID,
        activeItemId: paper.id,
        userText: `Create ${name} under collection ${source.id} and add paper ${paper.id}. Preserve its other memberships.`,
        classifiedIntent: classifiedFixture({
          writeDisposition: "required",
          actionIntents: [create, file],
        }),
      });
      const contracts = new ActionContractService(new ZoteroGateway());
      request.actionContract = await contracts.createContract(request);
      request.actionProgress = contracts.createProgress(request.actionContract);
      request.actionPreparation = { state: "ready", issues: [] };
      const registry = new AgentToolRegistry(contracts);
      const agent = (Zotero as any).LLMForZotero.api.agent;
      for (const tool of ["collection_update", "library_update"])
        registry.register(agent.getToolDefinition(tool));
      await createAgentRun({
        runId,
        conversationKey: paper.id,
        mode: "agent",
        modelName: "native-workflow",
        status: "running",
        createdAt: Date.now(),
      });
      let checkpointSequence = 0;
      let sequence = 0;
      const context: AgentToolContext = {
        request,
        runId,
        item: paper,
        currentAnswerText: "",
        modelName: "native-workflow",
        checkpointActionProgress: async () => {
          await appendAgentRunEvent(runId, ++checkpointSequence, {
            type: "provider_event",
            providerType: "agent_action_contract",
            payload: {
              contract: request.actionContract,
              progress: request.actionProgress,
            },
          });
        },
        invokeRegisteredOperation: async (tool, args) => {
          const prepared = await registry.prepareExecution(
            { id: `registered:${++sequence}`, name: tool, arguments: args },
            context,
            { callerKind: "model" },
          );
          assert.equal(
            prepared.kind,
            "result",
            "Each explicit operation is independently authorized",
          );
          if (prepared.kind !== "result")
            throw new Error("Unexpected operation confirmation");
          return prepared.execution.result;
        },
      };
      const script = agent.getToolDefinition("workflow_script");
      const input = script.validate({
        description:
          "Create destination and file the paper through registered operations",
        script: `if (typeof Zotero !== "undefined" || typeof globalThis.Components !== "undefined") throw new Error("Unexpected native globals");
const creation = await env.invoke("collection_update", {action:"create",name:${JSON.stringify(name)},parentCollectionId:${source.id},libraryID:${libraryID}});
if (!creation.ok) throw new Error(JSON.stringify(creation.content));
const receipt=creation.actionReceipts.find(entry=>entry.operation==="create_collection"&&entry.verification==="verified");
const destinationId=Number(receipt.appliedTargets[0].split(":")[1]);
for (const id of [${paper.id}]) {
  const filing=await env.invoke("library_update",{kind:"collections",action:"add",itemIds:[id],targetCollectionId:destinationId});
  if (!filing.ok) throw new Error(JSON.stringify(filing.content));
}
return destinationId;`,
      });
      assert.isTrue(input.ok, JSON.stringify(input));
      if (!input.ok) return;
      const result = await script.execute(input.value, context);
      assert.isUndefined(result.content.error, JSON.stringify(result.content));
      destination = Zotero.Collections.get(result.content.returnValue);
      assert.isOk(destination);
      assert.equal(destination!.name, name);
      await paper.reload(undefined, true);
      await sentinel.reload(undefined, true);
      assert.sameMembers(paper.getCollections(), [source.id, destination!.id]);
      assert.sameMembers(sentinel.getCollections(), [source.id]);
      assert.lengthOf(result.content.operations, 2);
      assert.isTrue(
        result.content.operations.every(
          (operation: any) =>
            operation.ok &&
            operation.actionReceipts.some(
              (receipt: any) => receipt.verification === "verified",
            ),
        ),
      );
      assert.isTrue(
        request.actionProgress.obligations.every(
          (entry) => entry.status === "fulfilled",
        ),
      );
      const journals = await listJournalActions({ runId, limit: 10 });
      assert.isAtLeast(
        journals.length,
        2,
        "Every registered effect has durable journal evidence",
      );
      succeeded = true;
    } finally {
      await finishAgentRun(
        runId,
        succeeded ? "completed" : "failed",
        "Native script test finished",
      );
      setOriginalAgentPermissionMode(mode);
      await Zotero.DB.executeTransaction(async () => {
        if (destination) await destination.erase({ deleteItems: false });
        await paper.erase();
        await sentinel.erase();
        await source.erase({ deleteItems: false });
      });
    }
  });
});
