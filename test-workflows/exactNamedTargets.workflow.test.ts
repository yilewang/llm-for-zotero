import {
  semanticContractFixture,
  classifiedFixture,
  semanticResponseFixture,
} from "../test/helpers/semanticIntent";
import { assert } from "chai";
import { detectTurnIntent } from "../src/agent/model/semanticIntentService";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import type { AgentActionIntent, AgentToolContext } from "../src/agent/types";

describe("workflow: exact named library targets", function () {
  this.timeout(60000);
  it("creates and populates two future destinations from one frozen request without confirmation", async function () {
    const originalMode = getOriginalAgentPermissionMode();
    const libraryID = Zotero.Libraries.userLibraryID;
    const parent = new Zotero.Collection();
    parent.libraryID = libraryID;
    parent.name = `Created destination workflow ${Date.now()}`;
    await parent.saveTx();
    const items: Zotero.Item[] = [];
    const names = ["Geometry", "Memory"];
    try {
      for (const label of [
        "Geometry paper",
        "Memory paper",
        "Shared",
        "Sentinel",
      ]) {
        const item = new Zotero.Item("journalArticle");
        item.libraryID = libraryID;
        item.setField("title", label);
        item.setTags([{ tag: "preserved" }]);
        item.setCollections([parent.id]);
        await item.saveTx();
        items.push(item);
      }
      const intents: AgentActionIntent[] = names.flatMap((name, index) => [
        {
          capability: "zotero.collections",
          operation: "create_collection",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "items",
          parameters: { collectionName: name, parentCollectionId: parent.id },
        },
        {
          capability: "zotero.collections",
          operation: "move_to_collection",
          proofDomain: "zotero_state",
          coverage: "some",
          targetKind: "papers",
          targetSelectors: [items[index].id, items[2].id].map((value) => ({
            kind: "item_id",
            value,
          })),
          scopeRole: "destination",
          scope: {
            kind: "collection",
            path: `${parent.name}/${name}`,
            includeDescendants: false,
          },
        },
      ]);
      const request = resolvedAgentRequest({
        conversationKey: items[0].id,
        mode: "agent",
        conversationKind: "library",
        libraryID,
        userText: `Create Geometry and Memory under "${parent.name}" (${parent.id}). Add existing papers ${items[0].id} and ${items[2].id} to Geometry, and ${items[1].id} and ${items[2].id} to Memory. Preserve every pre-existing membership and tag. Do not create any papers or notes.`,
        classifiedIntent: classifiedFixture({
          retrievalIntent: "none",
          wantedSections: [],
          writeDisposition: "required",
          actionInterpretationSource: "semantic",
          actionIntents: intents,
        }),
      });
      const contracts = new ActionContractService(new ZoteroGateway());
      request.actionContract = await contracts.createContract(request);
      request.actionProgress = contracts.createProgress(request.actionContract);
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("auto");
      const registry = new AgentToolRegistry(contracts);
      for (const name of ["collection_update", "library_update"])
        registry.register(
          (Zotero as any).LLMForZotero.api.agent.getToolDefinition(name),
        );
      const context: AgentToolContext = {
        request,
        item: null,
        modelName: "workflow",
        currentAnswerText: "",
      };
      const execute = async (name: string, args: Record<string, unknown>) => {
        const execution = await registry.prepareExecution(
          { id: `${name}-${Date.now()}`, name, arguments: args },
          context,
          { callerKind: "model" },
        );
        assert.equal(
          execution.kind,
          "result",
          "clear filing runs without approval",
        );
        if (execution.kind !== "result") throw new Error("Unexpected review");
        assert.isTrue(
          execution.execution.result.ok,
          JSON.stringify(execution.execution.result.content),
        );
        assert.isTrue(
          execution.execution.result.actionReceipts!.every(
            (receipt) => receipt.verification === "verified",
          ),
        );
      };
      const destinationIds: number[] = [];
      for (const name of names) {
        await execute("collection_update", {
          action: "create",
          libraryID,
          name,
          parentCollectionId: parent.id,
        });
        const matches = Zotero.Collections.getByParent(parent.id).filter(
          (entry) => entry.name === name,
        );
        assert.lengthOf(matches, 1);
        destinationIds.push(matches[0].id);
      }
      for (const [index, targetCollectionId] of destinationIds.entries())
        await execute("library_update", {
          kind: "collections",
          action: "add",
          libraryID,
          targetCollectionId,
          itemIds: [items[index].id, items[2].id],
        });
      for (const item of items) await item.reload(undefined, true);
      assert.sameMembers(items[0].getCollections(), [
        parent.id,
        destinationIds[0],
      ]);
      assert.sameMembers(items[1].getCollections(), [
        parent.id,
        destinationIds[1],
      ]);
      assert.sameMembers(items[2].getCollections(), [
        parent.id,
        ...destinationIds,
      ]);
      assert.deepEqual(items[3].getCollections(), [parent.id]);
      for (const item of items)
        assert.deepEqual(
          item.getTags().map((tag) => tag.tag),
          ["preserved"],
        );
      assert.isTrue(
        request.actionProgress!.obligations.every(
          (entry) => entry.status === "fulfilled",
        ),
      );
      const mergeRequest = resolvedAgentRequest({
        conversationKey: items[0].id,
        mode: "agent",
        conversationKind: "library",
        libraryID,
        userText: `Merge Geometry (${destinationIds[0]}) and Memory (${destinationIds[1]}) into geometry_memory under ${parent.id}. Preserve every paper, tag and unrelated membership; remove the old collection names.`,
        classifiedIntent: classifiedFixture({
          retrievalIntent: "none",
          wantedSections: [],
          writeDisposition: "required",
          actionInterpretationSource: "semantic",
          actionIntents: [
            {
              capability: "zotero.collections",
              proofDomain: "zotero_state",
              operation: "update_collection",
              coverage: "one",
              targetKind: "items",
              parameters: {
                collectionId: destinationIds[0],
                collectionName: "geometry_memory",
              },
            },
            {
              capability: "zotero.collections",
              proofDomain: "zotero_state",
              operation: "move_to_collection",
              coverage: "all",
              targetKind: "papers",
              scope: {
                kind: "collection",
                path: `${parent.name}/Memory`,
                includeDescendants: false,
              },
              scopeRole: "source",
              parameters: { destinationCollectionId: destinationIds[0] },
            },
            {
              capability: "zotero.collections",
              proofDomain: "zotero_state",
              operation: "delete_collection",
              coverage: "one",
              targetKind: "items",
              parameters: {
                collectionId: destinationIds[1],
                deleteItems: false,
              },
            },
          ],
        }),
      });
      mergeRequest.actionContract =
        await contracts.createContract(mergeRequest);
      mergeRequest.actionProgress = contracts.createProgress(
        mergeRequest.actionContract,
      );
      context.request = mergeRequest;
      await execute("collection_update", {
        action: "rename",
        libraryID,
        collectionId: destinationIds[0],
        newName: "geometry_memory",
      });
      await execute("library_update", {
        kind: "collections",
        action: "add",
        libraryID,
        targetCollectionId: destinationIds[0],
        itemIds: [items[1].id, items[2].id],
      });
      await execute("collection_update", {
        action: "delete",
        libraryID,
        collectionId: destinationIds[1],
        deleteItems: false,
      });
      const survivors = Zotero.Collections.getByParent(parent.id).filter(
        (collection) => !collection.deleted,
      );
      assert.deepEqual(
        survivors.map((collection) => collection.name),
        ["geometry_memory"],
      );
      assert.sameMembers(
        survivors[0].getChildItems(true),
        items.slice(0, 3).map((item) => item.id),
      );
      for (const item of items) {
        await item.reload(undefined, true);
        assert.isFalse(Boolean(item.deleted));
        assert.include(item.getCollections(), parent.id);
        assert.deepEqual(
          item.getTags().map((tag) => tag.tag),
          ["preserved"],
        );
      }
      assert.deepEqual(items[3].getCollections(), [parent.id]);
      assert.isTrue(
        mergeRequest.actionProgress!.obligations.every(
          (entry) => entry.status === "fulfilled",
        ),
      );
    } finally {
      setOriginalAgentPermissionMode(originalMode);
      for (const item of items) await item.eraseTx();
      for (const child of Zotero.Collections.getByParent(parent.id))
        await child.eraseTx();
      await parent.eraseTx();
    }
  });

  for (const mode of ["auto", "yolo"] as const) {
    it(`${mode} replaces tags on the named papers without confirmation or touching the sentinel`, async function () {
      const originalMode = getOriginalAgentPermissionMode();
      const items: Zotero.Item[] = [];
      try {
        for (const label of ["Geometry", "Memory", "Sentinel"]) {
          const item = new Zotero.Item("journalArticle");
          item.libraryID = Zotero.Libraries.userLibraryID;
          item.setField(
            "title",
            `${label} exact targets ${mode} ${Date.now()}`,
          );
          item.setTags([{ tag: "original" }]);
          await item.saveTx();
          items.push(item);
        }
        const targets = items.slice(0, 2);
        const targetSelectors = targets.map((item) =>
          mode === "auto"
            ? { kind: "title", value: String(item.getField("title")) }
            : { kind: "item_key", value: item.key },
        );
        const request = resolvedAgentRequest({
          conversationKey: items[2].id,
          mode: "agent",
          conversationKind: "library",
          libraryID: items[0].libraryID,
          userText:
            mode === "auto"
              ? `Apply exactly these tags to each of the papers titled "${targetSelectors[0].value}", "${targetSelectors[1].value}": coding, drift. Replace their old tags with this exact set. Do not tag any other paper.`
              : `Set exactly these tags on only the papers with item keys ${targetSelectors.map((s) => s.value).join(", ")}: coding, drift. Replace their previous tags; do not change any other item or field.`,
          model: "gpt-5.4",
          apiBase: "https://api.openai.com/v1",
          apiKey: "workflow-placeholder",
          providerProtocol: "openai_chat_compat",
        });
        const routing = await detectTurnIntent(
          request,
          [
            {
              id: "workflow-library",
              description: "Library operations",
              version: 1,
              patterns: [],
              contexts: ["any"],
              activation: "auto",
              instruction: "",
              source: "system",
            },
          ],
          {
            llmCall: async (params) => ({
              text: JSON.stringify(
                semanticResponseFixture({
                  taskKind: "write",
                  writeDisposition: "required",
                  actionIntents: [
                    {
                      operation: "set_item_tags",
                      coverage: "some",
                      targetKind: "papers",
                      targetSelectors,
                      parameters: { tags: ["coding", "drift"] },
                    },
                  ],
                }),
              ),
              completion: { status: "complete" },
            }),
          },
        );
        assert.equal(
          routing.classifiedIntent?.actionInterpretationSource,
          "semantic",
        );
        request.classifiedIntent = routing.classifiedIntent!;
        const contracts = new ActionContractService(new ZoteroGateway());
        request.actionContract = await contracts.createContract(request);
        assert.deepEqual(
          request.actionContract.obligations[0].targetBoundary?.frozenTargetIds,
          targets.map((item) => item.id),
        );
        request.actionProgress = contracts.createProgress(
          request.actionContract,
        );
        await initAgentChangeJournal();
        setOriginalAgentPermissionMode(mode);
        const registry = new AgentToolRegistry(contracts);
        registry.register(
          (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
            "library_update",
          ),
        );
        const context: AgentToolContext = {
          request,
          item: null,
          modelName: "workflow",
          currentAnswerText: "",
        };
        const execution = await registry.prepareExecution(
          {
            id: `named-${mode}`,
            name: "library_update",
            arguments: {
              kind: "tags",
              action: "set",
              ...(mode === "yolo"
                ? {
                    itemIds: targets.map((item) => item.id),
                    tags: ["coding", "drift"],
                  }
                : {
                    assignments: targets.map((item) => ({
                      itemId: item.id,
                      tags: ["coding", "drift"],
                    })),
                  }),
            },
          },
          context,
          { callerKind: "model" },
        );
        assert.equal(
          execution.kind,
          "result",
          "exact requested writes require no mode-based review",
        );
        if (execution.kind !== "result") return;
        assert.isTrue(
          execution.execution.result.ok,
          JSON.stringify(execution.execution.result.content),
        );
        assert.isTrue(
          execution.execution.result.actionReceipts!.some(
            (receipt) => receipt.status === "applied",
          ),
        );
        for (const item of items) await item.reload(undefined, true);
        for (const item of targets)
          assert.sameMembers(
            item.getTags().map((tag) => tag.tag),
            ["coding", "drift"],
          );
        assert.deepEqual(
          items[2].getTags().map((tag) => tag.tag),
          ["original"],
        );
      } finally {
        setOriginalAgentPermissionMode(originalMode);
        for (const item of items) await item.eraseTx();
      }
    });
  }

  it("moves an exact named subset atomically when the destination membership already exists", async function () {
    const originalMode = getOriginalAgentPermissionMode();
    const items: Zotero.Item[] = [];
    const collections: Zotero.Collection[] = [];
    try {
      for (const label of ["Source", "Destination", "Unrelated"]) {
        const collection = new Zotero.Collection();
        collection.libraryID = Zotero.Libraries.userLibraryID;
        collection.name = `${label} exact move ${Date.now()}`;
        await collection.saveTx();
        collections.push(collection);
      }
      for (const label of ["Target", "Sentinel"]) {
        const item = new Zotero.Item("journalArticle");
        item.libraryID = collections[0].libraryID;
        item.setField("title", `${label} exact move ${Date.now()}`);
        item.setCollections(collections.map((collection) => collection.id));
        await item.saveTx();
        items.push(item);
      }
      const request = resolvedAgentRequest({
        conversationKey: items[0].id,
        mode: "agent",
        conversationKind: "library",
        libraryID: items[0].libraryID,
        userText: `Move the paper titled "${items[0].getField("title")}" from "${collections[0].name}" to "${collections[1].name}". Preserve all other memberships.`,
        classifiedIntent: classifiedFixture({
          retrievalIntent: "none",
          wantedSections: [],
          writeDisposition: "required",
          actionInterpretationSource: "semantic",
          actionIntents: [
            {
              operation: "move_to_collection",
              capability: "zotero.collections",
              proofDomain: "zotero_state",
              coverage: "one",
              targetKind: "items",
              targetSelectors: [
                { kind: "title", value: String(items[0].getField("title")) },
              ],
              scope: {
                kind: "collection",
                path: collections[0].name,
                includeDescendants: false,
              },
              scopeRole: "source",
              parameters: {
                destinationCollectionId: collections[1].id,
                sourceCollectionId: collections[0].id,
              },
              constraints: { collectionMode: "move" },
            },
          ],
        }),
      });
      const contracts = new ActionContractService(new ZoteroGateway());
      request.actionContract = await contracts.createContract(request);
      request.actionProgress = contracts.createProgress(request.actionContract);
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("yolo");
      const registry = new AgentToolRegistry(contracts);
      registry.register(
        (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
          "library_update",
        ),
      );
      const execution = await registry.prepareExecution(
        {
          id: "move-subset",
          name: "library_update",
          arguments: {
            kind: "collections",
            action: "add",
            mode: "move",
            itemIds: [items[0].id],
            from: collections[0].id,
            targetCollectionId: collections[1].id,
          },
        },
        { request, item: null, modelName: "workflow", currentAnswerText: "" },
        { callerKind: "model" },
      );
      assert.equal(execution.kind, "result");
      if (execution.kind !== "result") return;
      assert.isTrue(
        execution.execution.result.ok,
        JSON.stringify(execution.execution.result.content),
      );
      assert.isTrue(
        execution.execution.result.actionReceipts!.some(
          (receipt) => receipt.status === "applied",
        ),
      );
      for (const item of items) await item.reload(undefined, true);
      assert.sameMembers(
        items[0].getCollections(),
        collections.slice(1).map((collection) => collection.id),
      );
      assert.sameMembers(
        items[1].getCollections(),
        collections.map((collection) => collection.id),
      );
    } finally {
      setOriginalAgentPermissionMode(originalMode);
      for (const item of items) await item.eraseTx();
      for (const collection of collections) await collection.eraseTx();
    }
  });
});
