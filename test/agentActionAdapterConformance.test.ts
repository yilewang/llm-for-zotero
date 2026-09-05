import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { libraryMutationHandlers } from "../src/agent/services/libraryMutation/handlerRegistry";
import { capabilityForLibraryMutation } from "../src/agent/services/libraryMutation/handlerOperations";
import type { LibraryMutationOperationType } from "../src/agent/services/libraryMutation/handlerDefinition";
import type { AgentRuntimeRequest, AgentToolContext } from "../src/agent/types";

const AGENT_ADAPTER_FAMILIES = [
  "openai_chat_compat",
  "responses_api",
  "anthropic_messages",
  "gemini_native",
  "ollama_native",
  "codex_responses",
] as const;

function createRegistry(executed: { value: boolean }): AgentToolRegistry {
  const registry = new AgentToolRegistry(
    new ActionContractService({
      getCollectionSummary: () => null,
      listCollectionSummaries: () => [],
      listCollectionPaperTargets: async () => ({ papers: [] }),
      listCollectionItemTargets: async () => ({ items: [] }),
      getItem: () => null,
      getEditableArticleMetadata: () => null,
    }),
  );
  registry.register({
    spec: {
      name: "library_update",
      description: "update library",
      inputSchema: { type: "object" },
      mutability: "write",
      requiresConfirmation: false,
    },
    validate: (input) => ({ ok: true, value: input as never }),
    describeAction: () => [
      {
        id: "remove_tags:adapter-conformance",
        proofDomain: "zotero_state",
        capability: "zotero.tags",
        operation: "remove_tags",
        parameters: { tags: ["reviewed"] },
        source: "library_mutation",
        operationValue: {
          type: "remove_tags",
          itemIds: [1],
          tags: ["reviewed"],
        },
        requestedTargets: ["item:1"],
        destinationCollectionIds: [],
      },
    ],
    execute: async () => {
      executed.value = true;
      return { content: { ok: true }, effect: "applied" as const };
    },
  });
  return registry;
}

describe("Agent action adapter conformance", function () {
  for (const providerProtocol of AGENT_ADAPTER_FAMILIES) {
    it(`enforces the shared typed contract for ${providerProtocol}`, async function () {
      const executed = { value: false };
      const registry = createRegistry(executed);
      const request: AgentRuntimeRequest = {
        conversationKey: 1,
        mode: "agent",
        userText: 'Add the tag "reviewed" to this paper.',
        providerProtocol,
        actionContract: {
          version: 2,
          id: `contract:${providerProtocol}`,
          writeDisposition: "required",
          interpretationSource: "classifier",
          obligations: [
            {
              id: `obligation:${providerProtocol}`,
              proofDomain: "zotero_state",
              capability: "zotero.tags",
              operation: "apply_tags",
              coverage: "one",
              targetKind: "papers",
              parameters: { tags: ["reviewed"] },
              targetBoundary: {
                kind: "selection",
                libraryID: 1,
                frozenTargetIds: [1],
                scopeDigest: "item:1",
              },
            },
          ],
        },
      };
      const context: AgentToolContext = {
        request,
        item: null,
        currentAnswerText: "",
        modelName: providerProtocol,
      };

      const prepared = await registry.prepareExecution(
        {
          id: `call:${providerProtocol}`,
          name: "library_update",
          arguments: {},
        },
        context,
        { callerKind: "model" },
      );

      assert.equal(prepared.kind, "result");
      if (prepared.kind !== "result") return;
      assert.isFalse(prepared.execution.result.ok);
      assert.isFalse(executed.value);
      assert.include(
        JSON.stringify(prepared.execution.result.content),
        "does not match",
      );
    });
  }

  it("matches every canonical mutation verb only to that exact verb", async function () {
    const contracts = new ActionContractService({
      getCollectionSummary: () => null,
      listCollectionSummaries: () => [],
      listCollectionPaperTargets: async () => ({ papers: [] }),
      listCollectionItemTargets: async () => ({ items: [] }),
      getItem: () => null,
      getEditableArticleMetadata: () => null,
    });
    const operationTypes = Object.keys(
      libraryMutationHandlers,
    ) as LibraryMutationOperationType[];
    for (let index = 0; index < operationTypes.length; index += 1) {
      const operation = operationTypes[index];
      const adjacent = operationTypes[(index + 1) % operationTypes.length];
      const contract = {
        version: 2 as const,
        id: `contract:${operation}`,
        writeDisposition: "required" as const,
        interpretationSource: "classifier" as const,
        obligations: [
          {
            id: `obligation:${operation}`,
            operation,
            proofDomain: "zotero_state" as const,
            capability: capabilityForLibraryMutation(operation),
            coverage: "one" as const,
            targetKind: "items" as const,
          },
        ],
      };
      const prepared = {
        mutability: "write" as const,
        hasExplicitAdapter: true,
        proposals: [
          {
            id: `proposal:${adjacent}`,
            operation: adjacent,
            proofDomain: "zotero_state" as const,
            capability: capabilityForLibraryMutation(adjacent),
            source: "library_mutation" as const,
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        operations: [],
        requestedTargets: [],
        destinationCollectionIds: [],
        alreadySatisfiedTargets: [],
        verifiedFacts: [],
      };
      const rejection = await contracts.validateScope(contract, prepared);
      assert.include(rejection?.message || "", "does not match");
      prepared.proposals[0] = {
        ...prepared.proposals[0],
        id: `proposal:${operation}`,
        operation,
        capability: capabilityForLibraryMutation(operation),
      };
      assert.isNull(await contracts.validateScope(contract, prepared));
    }
  });
});
