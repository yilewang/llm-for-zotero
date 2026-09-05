import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { evaluateActionContract } from "../src/agent/contracts/actionEvaluation";
import type {
  AgentActionIntent,
  AgentActionEvidence,
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
  AgentToolDefinition,
} from "../src/agent/types";
import type {
  LibraryMutationOperation,
  LibraryMutationState,
} from "../src/agent/services/libraryMutation/contracts";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

type FakeItemState = {
  tags: string[];
  collections: number[];
  fields: Record<string, string>;
  libraryID?: number;
  kind?: "regular" | "attachment" | "note" | "annotation";
  deleted?: boolean;
  noteHtml?: string;
  parentItemId?: number | null;
  annotation?: boolean;
};

function createHarness() {
  const directMembers = new Map<number, number[]>([
    [10, [90]],
    [11, [1, 2, 3]],
    [12, [50, 51]],
  ]);
  const items = new Map<number, FakeItemState>();
  const collections = new Map([
    [
      10,
      {
        collectionId: 10,
        libraryID: 1,
        name: "Parent",
        path: "Parent",
        parentCollectionId: null,
        deleted: false,
      },
    ],
    [
      11,
      {
        collectionId: 11,
        libraryID: 1,
        name: "Leaf",
        path: "Parent/Leaf",
        parentCollectionId: 10,
        deleted: false,
      },
    ],
    [
      12,
      {
        collectionId: 12,
        libraryID: 1,
        name: "Sibling",
        path: "Parent/Sibling",
        parentCollectionId: 10,
        deleted: false,
      },
    ],
  ]);
  const settings = new Map<string, unknown>();
  const gateway = {
    getCollectionSummary(collectionId: number) {
      const collection = collections.get(collectionId);
      return collection
        ? {
            collectionId: collection.collectionId,
            libraryID: collection.libraryID,
            name: collection.name,
            path: collection.path,
          }
        : null;
    },
    getCollectionNativeState(collectionId: number) {
      const collection = collections.get(collectionId);
      return collection
        ? {
            exists: true,
            name: collection.name,
            parentCollectionId: collection.parentCollectionId,
            deleted: collection.deleted,
          }
        : {
            exists: false,
            name: "",
            parentCollectionId: null,
            deleted: false,
          };
    },
    listCollectionSummaries(libraryID: number) {
      return [...collections.values()]
        .filter((entry) => entry.libraryID === libraryID && !entry.deleted)
        .map(({ collectionId, name, path }) => ({
          collectionId,
          libraryID,
          name,
          path,
        }));
    },
    listCurrentCollectionSummaries(libraryID: number) {
      return this.listCollectionSummaries(libraryID);
    },
    listCurrentCollectionTargetIds(params: { collectionId: number }) {
      return [...(directMembers.get(params.collectionId) || [])];
    },
    async listCurrentLibraryTargetIds() {
      return [...items.keys()];
    },
    async listCollectionPaperTargets(params: { collectionId: number }) {
      return {
        papers: (directMembers.get(params.collectionId) || []).map(
          (itemId) => ({ itemId }),
        ),
      };
    },
    async listCollectionItemTargets(params: { collectionId: number }) {
      return {
        items: (directMembers.get(params.collectionId) || []).map((itemId) => ({
          itemId,
        })),
      };
    },
    getItem(itemId: number) {
      const state = items.get(itemId);
      if (!state) return null;
      return {
        id: itemId,
        libraryID: state.libraryID ?? 1,
        parentID: state.parentItemId ?? false,
        deleted: state.deleted,
        isRegularItem: () => !state.kind || state.kind === "regular",
        isAttachment: () => state.kind === "attachment",
        isNote: () => state.kind === "note" || state.noteHtml !== undefined,
        isAnnotation: () =>
          state.kind === "annotation" || state.annotation === true,
        getNote: () => state.noteHtml || "",
        getTags: () => state.tags.map((tag) => ({ tag })),
        getCollections: () => state.collections,
      } as unknown as Zotero.Item;
    },
    getEditableArticleMetadata(item: Zotero.Item | null | undefined) {
      if (!item) return null;
      const state = items.get(Number(item.id));
      return state ? { fields: state.fields, creators: [] } : null;
    },
    getSettingNativeState(key: string) {
      return settings.has(key)
        ? { exists: true, value: settings.get(key) }
        : { exists: false, value: undefined };
    },
  };
  return {
    collections,
    directMembers,
    gateway,
    items,
    settings,
    service: new ActionContractService(gateway),
  };
}

function tagIntent(
  operation: "apply_tags" | "remove_tags" | "set_item_tags" = "apply_tags",
): AgentActionIntent {
  return {
    capability: "zotero.tags",
    operation,
    proofDomain: "zotero_state",
    coverage: "all",
    targetKind: "papers",
    parameters: { tags: ["topic:drift"] },
    scope: { kind: "collection", includeDescendants: false },
  };
}

function requestWithIntents(
  actionIntents: AgentActionIntent[],
  options: {
    disposition?: "none" | "required" | "uncertain";
    selectedCollection?: number;
    selectedCollections?: number[];
    userText?: string;
    activeItemId?: number;
    activePaperContext?: import("../src/shared/types").PaperContextRef;
    selectedPaperContexts?: import("../src/shared/types").PaperContextRef[];
  } = {},
): AgentRuntimeRequest {
  const selectedCollection = options.selectedCollection ?? 11;
  const selectedCollections =
    options.selectedCollections ||
    (selectedCollection > 0 ? [selectedCollection] : []);
  const input: AgentRuntimeRequestInput = {
    conversationKey: 1,
    mode: "agent",
    userText: options.userText || "test action",
    model: "test",
    libraryID: 1,
    activeItemId: options.activeItemId,
    activePaperContext: options.activePaperContext,
    selectedPaperContexts: options.selectedPaperContexts,
    selectedCollectionContexts: selectedCollections.length
      ? selectedCollections.map((collectionId) => ({
          collectionId,
          libraryID: 1,
          name:
            collectionId === 11
              ? "Leaf"
              : collectionId === 12
                ? "Sibling"
                : "Parent",
        }))
      : [],
    classifiedIntent: {
      retrievalIntent: "none",
      wantedSections: [],
      writeDisposition:
        options.disposition || (actionIntents.length ? "required" : "none"),
      actionInterpretationSource: "classifier",
      actionIntents,
    },
  };
  return resolvedAgentRequest(input);
}

function mutationTool(): AgentToolDefinition<any, unknown> {
  return {
    spec: {
      name: "library_update",
      description: "test",
      inputSchema: { type: "object" },
      mutability: "write",
      requiresConfirmation: true,
    },
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => ({ content: {}, effect: "applied" }),
  };
}

function mutationEvidence(
  operationValue: LibraryMutationOperation,
  preState: LibraryMutationState,
  postState: LibraryMutationState,
  journalStepId: string,
  effect: AgentActionEvidence["effect"] = "applied",
): AgentActionEvidence[] {
  return [
    {
      version: 1,
      proofDomain: "zotero_state",
      operationValue,
      preState,
      postState,
      journalStepId,
      effect,
    },
  ];
}

describe("Action Contract V2", function () {
  it("resolves unscoped item boundaries by operation semantics and exact resource type", async function () {
    const { service, items } = createHarness();
    items.set(42, { tags: [], collections: [], fields: {}, kind: "regular" });
    items.set(60, { tags: [], collections: [], fields: {}, kind: "regular" });
    items.set(700, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: 42,
    });
    items.set(900, {
      tags: [],
      collections: [],
      fields: {},
      kind: "attachment",
      parentItemId: 42,
    });
    const activePaperContext = {
      itemId: 42,
      contextItemId: 900,
      title: "Paper 42",
    };
    const makeIntent = (
      operation: AgentActionIntent["operation"],
      targetKind: AgentActionIntent["targetKind"],
      targetItemId?: number,
    ): AgentActionIntent => ({
      capability:
        operation === "update_metadata"
          ? "zotero.metadata"
          : operation.includes("attachment")
            ? "zotero.attachments"
            : operation === "apply_tags"
              ? "zotero.tags"
              : "zotero.collections",
      operation,
      proofDomain: "zotero_state",
      coverage: "one",
      targetKind,
      parameters: targetItemId ? { targetItemId } : undefined,
    });
    const boundaryFor = async (
      intent: AgentActionIntent,
      activeItemId: number,
    ) =>
      (
        await service.createContract(
          requestWithIntents([intent], {
            selectedCollection: 0,
            activeItemId,
            activePaperContext,
            selectedPaperContexts: [
              activePaperContext,
              { itemId: 60, contextItemId: 60, title: "Added" },
            ],
          }),
        )
      ).obligations[0].targetBoundary?.frozenTargetIds;

    for (const operation of [
      "rename_attachment",
      "relink_attachment",
      "delete_attachment",
    ] as const) {
      assert.deepEqual(
        await boundaryFor(makeIntent(operation, "items"), 900),
        [900],
      );
      assert.deepEqual(
        await boundaryFor(makeIntent(operation, "items"), 999),
        [900],
      );
    }
    assert.deepEqual(
      await boundaryFor(makeIntent("update_metadata", "papers"), 900),
      [42],
    );
    assert.deepEqual(
      await boundaryFor(makeIntent("update_metadata", "items"), 700),
      [42],
    );
    assert.deepEqual(
      await boundaryFor(makeIntent("move_to_collection", "items"), 700),
      [42],
    );
    assert.deepEqual(
      await boundaryFor(makeIntent("apply_tags", "items"), 999),
      [42],
    );
    assert.deepEqual(
      await boundaryFor(makeIntent("update_metadata", "papers", 60), 900),
      [60],
    );
    const addedFallback = await service.createContract(
      requestWithIntents([makeIntent("update_metadata", "papers")], {
        selectedCollection: 0,
        activeItemId: 999,
        selectedPaperContexts: [
          { itemId: 60, contextItemId: 60, title: "Added" },
        ],
      }),
    );
    assert.deepEqual(
      addedFallback.obligations[0].targetBoundary?.frozenTargetIds,
      [60],
    );

    items.set(901, {
      tags: [],
      collections: [],
      fields: {},
      kind: "attachment",
      libraryID: 2,
    });
    const rejectionMessage = async (promise: Promise<unknown>) => {
      try {
        await promise;
        assert.fail("expected contract construction to reject");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    assert.match(
      await rejectionMessage(
        service.createContract(
          requestWithIntents([makeIntent("rename_attachment", "items", 901)], {
            selectedCollection: 0,
          }),
        ),
      ),
      /different Zotero library/,
    );
    assert.match(
      await rejectionMessage(
        service.createContract(
          requestWithIntents([makeIntent("update_metadata", "items", 900)], {
            selectedCollection: 0,
          }),
        ),
      ),
      /valid regular bibliographic item/,
    );
  });

  it("keeps a valid standalone note or attachment for collection membership", async function () {
    const { service, items } = createHarness();
    items.set(701, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: null,
    });
    items.set(702, {
      tags: [],
      collections: [],
      fields: {},
      kind: "attachment",
      parentItemId: null,
    });
    const intent: AgentActionIntent = {
      capability: "zotero.collections",
      operation: "move_to_collection",
      proofDomain: "zotero_state",
      coverage: "one",
      targetKind: "items",
    };
    for (const itemId of [701, 702]) {
      const contract = await service.createContract(
        requestWithIntents([intent], {
          selectedCollection: 0,
          activeItemId: itemId,
        }),
      );
      assert.deepEqual(
        contract.obligations[0].targetBoundary?.frozenTargetIds,
        [itemId],
      );
    }
  });

  it("authorizes the unresolved union of multiple selected source collections", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [2, 3]);
    const contract = await service.createContract(
      requestWithIntents([tagIntent()], {
        selectedCollections: [11, 12],
      }),
    );
    const progress = service.createProgress(contract);
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [3, 2, 1, 2],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    assert.isNull(
      await service.validateScope(contract, prepared, { progress }),
    );

    const evidenceItems = [1, 2, 3].map((itemId) => ({
      itemId,
      exists: true,
      tags: ["topic:drift"],
    }));
    const receipts = service.finalize(
      contract,
      prepared,
      {
        ok: true,
        effect: "applied",
        actionEvidence: mutationEvidence(
          operation,
          {
            version: 1,
            operation: "apply_tags",
            items: evidenceItems.map((item) => ({ ...item, tags: [] })),
          },
          {
            version: 1,
            operation: "apply_tags",
            items: evidenceItems,
          },
          "journal-union",
        ),
      },
      progress,
    );

    assert.lengthOf(receipts, 2);
    assert.deepEqual(receipts[0].requestedTargets, ["item:2", "item:1"]);
    assert.deepEqual(receipts[1].requestedTargets, ["item:3", "item:2"]);
    service.applyReceipts(progress, receipts);
    assert.deepEqual(
      progress.obligations.map((entry) => entry.status),
      ["fulfilled", "fulfilled"],
    );
  });

  it("accepts one compatible proposal per source collection", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [3, 4]);
    const contract = await service.createContract(
      requestWithIntents([tagIntent()], {
        selectedCollections: [11, 12],
      }),
    );
    const prepared = await service.prepare(mutationTool(), {
      operations: [
        {
          type: "apply_tags",
          itemIds: [2, 1],
          tags: ["topic:drift"],
        },
        {
          type: "apply_tags",
          itemIds: [4, 3],
          tags: ["topic:drift"],
        },
      ],
    });

    assert.isNull(
      await service.validateScope(contract, prepared, {
        progress: service.createProgress(contract),
      }),
    );
  });

  it("assigns only unresolved source collections and emits receipts for that same assignment", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [3, 4]);
    const contract = await service.createContract(
      requestWithIntents([tagIntent()], {
        selectedCollections: [11, 12],
      }),
    );
    const progress = service.createProgress(contract);
    Object.assign(progress.obligations[0], {
      status: "fulfilled",
      verifiedTargetIds: ["item:1", "item:2"],
      unresolvedTargetIds: [],
    });
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [4, 3],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });

    assert.isNull(
      await service.validateScope(contract, prepared, { progress }),
    );
    const receipts = service.finalize(
      contract,
      prepared,
      {
        ok: true,
        effect: "applied",
        actionEvidence: mutationEvidence(
          operation,
          {
            version: 1,
            operation: "apply_tags",
            items: [3, 4].map((itemId) => ({
              itemId,
              exists: true,
              tags: [],
            })),
          },
          {
            version: 1,
            operation: "apply_tags",
            items: [3, 4].map((itemId) => ({
              itemId,
              exists: true,
              tags: ["topic:drift"],
            })),
          },
          "journal-unresolved",
        ),
      },
      progress,
    );

    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].obligationId, contract.obligations[1].id);
    assert.deepEqual(receipts[0].requestedTargets, ["item:4", "item:3"]);
  });

  it("keeps exact destination validation independent from source collection unioning", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [3, 4]);
    const sourceIntent: AgentActionIntent = {
      capability: "zotero.collections",
      operation: "move_to_collection",
      proofDomain: "zotero_state",
      coverage: "all",
      targetKind: "items",
      scopeRole: "source",
      scope: { kind: "collection", includeDescendants: false },
    };
    const destinationIntent: AgentActionIntent = {
      ...sourceIntent,
      coverage: "one",
      scopeRole: "destination",
      scope: {
        kind: "collection",
        path: "Parent",
        includeDescendants: false,
      },
    };
    const contract = await service.createContract(
      requestWithIntents([sourceIntent, destinationIntent], {
        selectedCollections: [11, 12],
      }),
    );
    const operation: LibraryMutationOperation = {
      type: "move_to_collection",
      itemIds: [1, 2, 3, 4],
      targetCollectionId: 10,
    };
    const prepared = await service.prepare(mutationTool(), { operation });

    assert.isNull(
      await service.validateScope(contract, prepared, {
        progress: service.createProgress(contract),
      }),
    );
    const wrongDestination = await service.prepare(mutationTool(), {
      operation: { ...operation, targetCollectionId: 12 },
    });
    assert.include(
      (
        await service.validateScope(contract, wrongDestination, {
          progress: service.createProgress(contract),
        })
      )?.message || "",
      "destination must be exact collection 10",
    );
  });

  it("rejects drift in either assigned source collection independently", async function () {
    for (const changedCollectionId of [11, 12]) {
      const { service, directMembers } = createHarness();
      directMembers.set(11, [1, 2]);
      directMembers.set(12, [3, 4]);
      const contract = await service.createContract(
        requestWithIntents([tagIntent()], {
          selectedCollections: [11, 12],
        }),
      );
      directMembers.get(changedCollectionId)!.push(99);
      const prepared = await service.prepare(mutationTool(), {
        operation: {
          type: "apply_tags",
          itemIds: [1, 2, 3, 4],
          tags: ["topic:drift"],
        },
      });
      assert.include(
        (
          await service.validateScope(contract, prepared, {
            progress: service.createProgress(contract),
          })
        )?.message || "",
        "changed after planning",
      );
    }
  });

  it("rejects a multi-collection proposal atomically when any target is outside the assigned union", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [3, 4]);
    const contract = await service.createContract(
      requestWithIntents([tagIntent()], {
        selectedCollections: [11, 12],
      }),
    );
    const prepared = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 3, 99],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (
        await service.validateScope(contract, prepared, {
          progress: service.createProgress(contract),
        })
      )?.rejectedTargets,
      ["item:99"],
    );
  });
  it("rejects remove and replace proposals for an add-tag obligation", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    for (const operation of [
      {
        type: "remove_tags" as const,
        itemIds: [1, 2, 3],
        tags: ["topic:drift"],
      },
      {
        type: "set_item_tags" as const,
        assignments: [1, 2, 3].map((itemId) => ({
          itemId,
          tags: ["topic:drift"],
        })),
      },
    ]) {
      const prepared = await service.prepare(mutationTool(), { operation });
      const rejection = await service.validateScope(contract, prepared);
      assert.include(rejection?.message || "", operation.type);
      assert.include(rejection?.message || "", "does not match");
    }
  });

  it("rejects every model-originated write for a no-write contract", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([], { disposition: "none" }),
    );
    const prepared = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1],
        tags: ["topic:drift"],
      },
    });
    assert.include(
      (await service.validateScope(contract, prepared))?.message || "",
      "authorizes no mutations",
    );
  });

  it("binds top-level and explicitly nested collection creation precisely", async function () {
    const { service } = createHarness();
    for (const testCase of [
      {
        collectionName: "ACV2 Methods",
        scope: {
          kind: "collection" as const,
          path: "ACV2 Methods",
          includeDescendants: false,
        },
        selectedCollection: 0,
        userText: 'Create top-level collection "ACV2 Methods".',
        expectedParentId: null,
      },
      {
        collectionName: "Methods",
        selectedCollection: 10,
        userText: 'Create a collection named "Methods" under this collection.',
        expectedParentId: 10,
      },
    ]) {
      const contract = await service.createContract(
        requestWithIntents(
          [
            {
              capability: "zotero.collections",
              operation: "create_collection",
              proofDomain: "zotero_state",
              coverage: "one",
              targetKind: "items",
              parameters: { collectionName: testCase.collectionName },
              scope: testCase.scope,
            },
          ],
          testCase,
        ),
      );

      const obligation = contract.obligations[0];
      assert.isUndefined(obligation.scope);
      assert.equal(
        obligation.parameters?.parentCollectionId,
        testCase.expectedParentId,
      );
    }
  });

  it("requires an explicit proposal when a mixed tool plans a concrete write", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const prepared = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [],
      },
      { mode: "write" },
    );

    assert.isNull(await service.validateScope(contract, prepared));
    assert.include(
      (
        await service.validateScope(contract, prepared, {
          concreteWrite: true,
        })
      )?.message || "",
      "did not produce a typed action proposal",
    );
  });

  it("freezes exact direct membership and rejects sibling and partial targets", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [1, 2, 3],
    );
    assert.match(
      contract.obligations[0].targetBoundary?.scopeDigest || "",
      /^v1:/,
    );

    const widened = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3, 50],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (await service.validateScope(contract, widened))?.rejectedTargets,
      ["item:50"],
    );

    const partial = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (await service.validateScope(contract, partial))?.missingTargets,
      ["item:3"],
    );
  });

  it("freezes a whole-library obligation before the first write", async function () {
    const { service, items } = createHarness();
    for (const itemId of [1, 2, 3]) {
      items.set(itemId, { tags: [], collections: [], fields: {} });
    }
    const intent = { ...tagIntent(), scope: undefined };
    const contract = await service.createContract({
      ...requestWithIntents([intent], { selectedCollection: 0 }),
      libraryID: 1,
    });

    assert.equal(contract.obligations[0].targetBoundary?.kind, "library");
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [1, 2, 3],
    );

    const widened = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3, 50],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (await service.validateScope(contract, widened))?.rejectedTargets,
      ["item:50"],
    );

    const partial = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (await service.validateScope(contract, partial))?.missingTargets,
      ["item:3"],
    );
  });

  it("revalidates frozen membership immediately before execution", async function () {
    const { service, directMembers } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    directMembers.set(11, [1, 2, 3, 4]);
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [1, 2, 3],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    assert.include(
      (await service.validateScope(contract, prepared))?.message || "",
      "changed after planning",
    );
  });

  it("closes an add-tag obligation only after native state verifies every target", async function () {
    const { service, items } = createHarness();
    items.set(1, { tags: [], collections: [11], fields: {} });
    items.set(2, {
      tags: ["topic:drift"],
      collections: [11],
      fields: {},
    });
    items.set(3, { tags: [], collections: [11], fields: {} });
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const progress = service.createProgress(contract);
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [1, 2, 3],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    items.get(1)!.tags.push("topic:drift");
    items.get(3)!.tags.push("topic:drift");
    const receipts = service.finalize(contract, prepared, {
      ok: true,
      effect: "partial",
      content: { actionId: "journal-1" },
      actionEvidence: mutationEvidence(
        operation,
        {
          version: 1,
          operation: "apply_tags",
          items: [
            { itemId: 1, exists: true, tags: [] },
            { itemId: 2, exists: true, tags: ["topic:drift"] },
            { itemId: 3, exists: true, tags: [] },
          ],
        },
        {
          version: 1,
          operation: "apply_tags",
          items: [1, 2, 3].map((itemId) => ({
            itemId,
            exists: true,
            tags: ["topic:drift"],
          })),
        },
        "journal-1:1",
        "partial",
      ),
    });
    service.applyReceipts(progress, receipts);
    assert.deepEqual(receipts[0].appliedTargets, [
      "item:1",
      "item:2",
      "item:3",
    ]);
    assert.deepEqual(receipts[0].alreadySatisfiedTargets, []);
    assert.equal(receipts[0].verification, "verified");
    assert.equal(
      evaluateActionContract(contract, receipts, progress).state,
      "satisfied",
    );
  });

  it("binds and verifies collection create, update, and delete result IDs", async function () {
    const { service, collections } = createHarness();
    const cases: Array<{
      intent: AgentActionIntent;
      operation: LibraryMutationOperation;
      mutate: () => unknown;
      preState: LibraryMutationState;
      postState: LibraryMutationState;
      journalStepId: string;
      target: string;
    }> = [
      {
        intent: {
          capability: "zotero.collections",
          operation: "create_collection",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "items",
          parameters: { collectionName: "Methods" },
        },
        operation: { type: "create_collection", name: "Methods", libraryID: 1 },
        mutate: () =>
          collections.set(20, {
            collectionId: 20,
            libraryID: 1,
            name: "Methods",
            path: "Methods",
            parentCollectionId: null,
            deleted: false,
          }),
        preState: { version: 1, operation: "create_collection" },
        postState: {
          version: 1,
          operation: "create_collection",
          collections: [
            {
              collectionId: 20,
              exists: true,
              name: "Methods",
              parentCollectionId: null,
              deleted: false,
            },
          ],
        },
        journalStepId: "journal-create:1",
        target: "collection:20",
      },
      {
        intent: {
          capability: "zotero.collections",
          operation: "update_collection",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "items",
          parameters: { collectionId: 12, collectionName: "Methods 2" },
        },
        operation: {
          type: "update_collection",
          collectionId: 12,
          name: "Methods 2",
        },
        mutate: () => {
          collections.get(12)!.name = "Methods 2";
        },
        preState: {
          version: 1,
          operation: "update_collection",
          collections: [
            {
              collectionId: 12,
              exists: true,
              name: "Sibling",
              parentCollectionId: 10,
              deleted: false,
            },
          ],
        },
        postState: {
          version: 1,
          operation: "update_collection",
          collections: [
            {
              collectionId: 12,
              exists: true,
              name: "Methods 2",
              parentCollectionId: 10,
              deleted: false,
            },
          ],
        },
        journalStepId: "journal-update:1",
        target: "collection:12",
      },
      {
        intent: {
          capability: "zotero.collections",
          operation: "delete_collection",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "items",
          parameters: { collectionId: 12 },
        },
        operation: { type: "delete_collection", collectionId: 12 },
        mutate: () => {
          collections.get(12)!.deleted = true;
        },
        preState: {
          version: 1,
          operation: "delete_collection",
          collections: [
            {
              collectionId: 12,
              exists: true,
              name: "Methods 2",
              parentCollectionId: 10,
              deleted: false,
            },
          ],
        },
        postState: {
          version: 1,
          operation: "delete_collection",
          collections: [
            {
              collectionId: 12,
              exists: true,
              name: "Methods 2",
              parentCollectionId: 10,
              deleted: true,
            },
          ],
        },
        journalStepId: "journal-delete:1",
        target: "collection:12",
      },
    ];
    for (const entry of cases) {
      const contract = await service.createContract(
        requestWithIntents([entry.intent], { selectedCollection: 0 }),
      );
      const prepared = await service.prepare(mutationTool(), {
        operation: entry.operation,
      });
      assert.isNull(await service.validateScope(contract, prepared));
      if (
        entry.operation.type === "update_collection" ||
        entry.operation.type === "delete_collection"
      ) {
        const wrongTarget = await service.prepare(mutationTool(), {
          operation: { ...entry.operation, collectionId: 11 },
        });
        assert.include(
          (await service.validateScope(contract, wrongTarget))?.message || "",
          "does not match",
        );
      }
      entry.mutate();
      const receipts = service.finalize(contract, prepared, {
        ok: true,
        effect: "applied",
        content: { actionId: entry.journalStepId.split(":")[0] },
        actionEvidence: mutationEvidence(
          entry.operation,
          entry.preState,
          entry.postState,
          entry.journalStepId,
        ),
      });
      assert.equal(receipts[0].verification, "verified");
      assert.deepEqual(receipts[0].appliedTargets, [entry.target]);
      assert.equal(
        evaluateActionContract(contract, receipts).state,
        "satisfied",
      );
    }
  });

  it("requires file readback identity and keeps execution proof separate", async function () {
    const { service } = createHarness();
    const fileTool: AgentToolDefinition<any, unknown> = {
      ...mutationTool(),
      describeAction: (input) => [
        {
          id: `file_write:${input.filePath}`,
          proofDomain: "file_state",
          capability: "file.write",
          operation: "file_write",
          source: "file_io",
          parameters: { filePath: input.filePath },
          requestedTargets: [`file:${input.filePath}`],
          destinationCollectionIds: [],
        },
      ],
    };
    const fileContract = await service.createContract(
      requestWithIntents(
        [
          {
            capability: "file.write",
            operation: "file_write",
            proofDomain: "file_state",
            coverage: "one",
            targetKind: "items",
            parameters: { filePath: "/tmp/acv2.md" },
          },
        ],
        { selectedCollection: 0 },
      ),
    );
    const preparedFile = await service.prepare(fileTool, {
      filePath: "/tmp/acv2.md",
    });
    const noReadback = service.finalize(fileContract, preparedFile, {
      ok: true,
      effect: "applied",
      content: { filePath: "/tmp/acv2.md" },
    });
    assert.equal(noReadback[0].verification, "unverified");
    const verified = service.finalize(fileContract, preparedFile, {
      ok: true,
      effect: "applied",
      content: {
        filePath: "/tmp/acv2.md",
        exists: true,
        expectedContentHash: "abc",
        contentHash: "abc",
      },
    });
    assert.equal(verified[0].verification, "verified");
    assert.equal(verified[0].evidenceRef, "sha256:abc");

    const command = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [
          {
            id: "command:true",
            proofDomain: "execution",
            capability: "command.execute",
            operation: "command_execute",
            source: "command",
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
      },
      {},
    );
    assert.include(
      (await service.validateScope(fileContract, command))?.message || "",
      "does not match",
    );
  });

  it("closes Zotero-note and file-export obligations independently", async function () {
    const { service, items } = createHarness();
    items.set(700, {
      tags: [],
      collections: [],
      fields: {},
      noteHtml: "<h2>Summary</h2><p>Grounded body.</p>",
    });
    const contract = await service.createContract(
      requestWithIntents(
        [
          {
            capability: "zotero.notes",
            operation: "note_create",
            proofDomain: "zotero_state",
            coverage: "one",
            targetKind: "items",
            parameters: { noteMode: "create" },
          },
          {
            capability: "file.write",
            operation: "file_write",
            proofDomain: "file_state",
            coverage: "one",
            targetKind: "items",
            parameters: { filePath: "/tmp/mixed-note.md" },
          },
        ],
        { selectedCollection: 0 },
      ),
    );
    const notePrepared = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [
          {
            id: "note_create:700",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            source: "zotero_native",
            parameters: {
              noteMode: "create",
              expectedText: "Grounded body.",
            },
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
      },
      {},
    );
    const noteReceipts = service.finalize(contract, notePrepared, {
      ok: true,
      effect: "applied",
      content: { actionId: "note-step", result: { noteId: 700 } },
    });
    assert.equal(
      evaluateActionContract(contract, noteReceipts).state,
      "pending",
    );

    const filePrepared = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [
          {
            id: "file_write:/tmp/mixed-note.md",
            proofDomain: "file_state",
            capability: "file.write",
            operation: "file_write",
            source: "file_io",
            parameters: { filePath: "/tmp/mixed-note.md" },
            requestedTargets: ["file:/tmp/mixed-note.md"],
            destinationCollectionIds: [],
          },
        ],
      },
      {},
    );
    const fileReceipts = service.finalize(contract, filePrepared, {
      ok: true,
      effect: "applied",
      content: {
        filePath: "/tmp/mixed-note.md",
        exists: true,
        expectedContentHash: "mixed-hash",
        contentHash: "mixed-hash",
      },
    });
    assert.equal(
      evaluateActionContract(contract, fileReceipts).state,
      "pending",
    );
    assert.equal(
      evaluateActionContract(contract, [...noteReceipts, ...fileReceipts])
        .state,
      "satisfied",
    );
  });

  it("applies replayed receipts idempotently by obligation and journal identity", async function () {
    const { service, items } = createHarness();
    for (const itemId of [1, 2, 3]) {
      items.set(itemId, {
        tags: ["topic:drift"],
        collections: [11],
        fields: {},
      });
    }
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const progress = service.createProgress(contract);
    const prepared = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3],
        tags: ["topic:drift"],
      },
    });
    const receipts = service.finalize(contract, prepared, {
      ok: true,
      effect: "applied",
      content: { actionId: "journal-once" },
    });
    service.applyReceipts(progress, receipts);
    service.applyReceipts(progress, receipts);
    assert.lengthOf(progress.appliedReceiptKeys, 1);
    assert.deepEqual(progress.obligations[0].journalStepIds, ["journal-once"]);
  });

  it("treats cancellation as terminal without a corrective retry", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const prepared = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3],
        tags: ["topic:drift"],
      },
    });
    const receipts = service.finalize(contract, prepared, {
      ok: false,
      cancelled: true,
      reason: "User denied action",
    });
    assert.equal(receipts[0].verification, "not_applicable");
    const evaluation = evaluateActionContract(contract, receipts);
    assert.equal(evaluation.state, "cancelled");
    assert.isUndefined(evaluation.correction);
  });

  it("keeps a verified success satisfied when a redundant retry is cancelled", async function () {
    const { service, items } = createHarness();
    for (const itemId of [1, 2, 3]) {
      items.set(itemId, {
        tags: ["topic:drift"],
        collections: [11],
        fields: {},
      });
    }
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [1, 2, 3],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    const satisfiedState: LibraryMutationState = {
      version: 1,
      operation: "apply_tags",
      items: [1, 2, 3].map((itemId) => ({
        itemId,
        exists: true,
        tags: ["topic:drift"],
      })),
    };
    const success = service.finalize(contract, prepared, {
      ok: true,
      effect: "none",
      content: { actionId: "journal-success" },
      actionEvidence: mutationEvidence(
        operation,
        satisfiedState,
        satisfiedState,
        "journal-success:1",
        "none",
      ),
    });
    const cancelled = service.finalize(contract, prepared, {
      ok: false,
      cancelled: true,
      reason: "User denied redundant action",
    });
    const progress = service.createProgress(contract);
    service.applyReceipts(progress, success);
    service.applyReceipts(progress, cancelled);
    assert.equal(progress.obligations[0].status, "already_satisfied");
    const duplicate = await service.validateScope(contract, prepared, {
      progress,
    });
    assert.include(duplicate?.message || "", "already verified");
    assert.equal(
      evaluateActionContract(contract, [...success, ...cancelled], progress)
        .state,
      "satisfied",
    );
  });
});
