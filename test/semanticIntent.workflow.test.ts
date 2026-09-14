import { ModelSemanticReferenceResolver } from "../src/agent/model/semanticReferenceResolver";
import { assert } from "chai";
import { detectTurnIntent } from "../src/agent/model/semanticIntentService";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const interpretation = {
  decisions: {
    constraints: [],
    noteDestination: "none",
    conversationOnly: false,
    reading: { source: "document_text", coverage: "targeted" },
    literature: "none",
    bulk: false,
    continuation: "new",
    questions: [],
  },
  paperTargetIntent: "active",
  deliverableIntent: "chat",
  externalSearchIntent: "none",
  schemaVersion: 1,
  taskKind: "write",
  requestedScopes: ["single-paper"],
  selections: [],
  retrievalIntent: "none",
  wantedSections: [],
  writeDisposition: "required",
  actionIntents: [
    {
      operation: "move_to_collection",
      coverage: "one",
      targetKind: "papers",
      scopeRole: "destination",
      scope: {
        kind: "collection",
        path: "Bayesian",
        includeDescendants: false,
      },
    },
  ],
};

describe("Semantic intent to native action contract", function () {
  it("corrects a source-paper reference that confuses an active note with an active paper", async function () {
    let calls = 0;
    const result = await detectTurnIntent(
      resolvedAgentRequest({
        conversationKey: 3,
        mode: "agent",
        libraryID: 1,
        userText:
          "Read the supplied paper and replace note 3 with a reading note.",
        activeItemId: 3,
        activeNoteContext: {
          noteId: 3,
          title: "Note",
          noteKind: "item",
          noteText: "Original",
        },
        selectedPaperContexts: [
          {
            libraryID: 1,
            itemId: 1,
            contextItemId: 2,
            title: "Supplied paper",
          },
        ],
        model: "test",
        apiBase: "https://example.invalid",
        apiKey: "fixture",
      }),
      [],
      {
        llmCall: async () => ({
          text: JSON.stringify({
            ...interpretation,
            paperTargetIntent: ++calls === 1 ? "active" : "added",
            decisions: {
              ...interpretation.decisions,
              noteDestination: "zotero",
              materialOutputs: [
                {
                  id: "reading_note",
                  description: "Reading note",
                  afterActions: [],
                  sourceActionIndexes: [],
                  requiredEvidence: "body",
                },
              ],
            },
            actionIntents: [
              {
                operation: "note_edit",
                coverage: "one",
                targetKind: "items",
                contentFrom: "reading_note",
                parameters: { targetNoteId: 3, noteMode: "edit" },
              },
            ],
          }),
          completion: { status: "complete" },
        }),
      },
    );
    assert.equal(calls, 2);
    assert.equal(result.classifiedIntent?.paperTargetIntent, "added");
  });
  it("recovers a literal-reference reply missing its native-name evidence once", async function () {
    let calls = 0;
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      userText: "move this paper to Bayesian folder",
      model: "test",
      apiBase: "https://example.invalid",
      apiKey: "fixture",
    });
    const result = await new ModelSemanticReferenceResolver().resolve(
      {
        request,
        entity: "collection",
        description: "Bayesian folder",
        referenceKind: "literal",
        candidates: [
          { id: 5, libraryID: 1, label: "Bayesian", details: "Bayesian" },
        ],
      },
      {
        llmCall: async () => ({
          text: JSON.stringify({
            state: "resolved",
            ids: [5],
            reason: "The named collection",
            ...(++calls === 2
              ? { literalEvidence: [{ id: 5, quote: "Bayesian" }] }
              : {}),
          }),
          completion: { status: "complete" },
        }),
      },
    );
    assert.equal(calls, 2);
    assert.equal(result.state, "resolved");
    if (result.state === "resolved")
      assert.deepEqual(result.literalEvidence, [{ id: 5, quote: "Bayesian" }]);
  });
  it("does not accept collection IDs invented while interpreting a named destination", async function () {
    let calls = 0;
    const invented = {
      ...interpretation,
      actionIntents: [
        {
          ...interpretation.actionIntents[0],
          parameters: { destinationCollectionId: 6 },
        },
      ],
    };
    const result = await detectTurnIntent(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        userText: "File this paper in Bayesian",
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com",
        apiKey: "fixture",
      }),
      [],
      {
        llmCall: async () => ({
          text: JSON.stringify(++calls === 1 ? invented : interpretation),
          completion: { status: "complete" },
        }),
      },
    );
    assert.equal(calls, 2);
    assert.isUndefined(
      result.classifiedIntent?.actionIntents[0].parameters
        ?.destinationCollectionId,
    );
  });

  it("provides the full action-reference schema to the semantic model", async function () {
    let prompt = "";
    await detectTurnIntent(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        userText: "File this paper",
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com",
        apiKey: "fixture",
      }),
      [],
      {
        llmCall: async (params) => {
          prompt = params.prompt || "";
          return {
            text: JSON.stringify(interpretation),
            completion: { status: "complete" },
          };
        },
      },
    );
    assert.include(prompt, '"collectionName":{"type":"string"');
    assert.include(prompt, '"scope":{"type":"object"');
    assert.include(prompt, '"destinationCollectionId":{"type":"integer"');
  });

  it("retains bounded rejected-response diagnostics without granting authority or exposing the configured key", async function () {
    const invalid = {
      ...interpretation,
      actionIntents: [
        {
          operation: "unknown",
          parameters: { filePath: "secret-fixture-key" },
        },
      ],
    };
    const result = await detectTurnIntent(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        userText: "File this paper",
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com",
        apiKey: "secret-fixture-key",
      }),
      [],
      {
        llmCall: async () => ({
          text: JSON.stringify(invalid),
          completion: { status: "complete" },
        }),
      },
    );
    assert.isNull(result.classifiedIntent);
    assert.lengthOf(result.rejectedResponses!, 2);
    assert.notInclude(JSON.stringify(result), "secret-fixture-key");
  });

  it("gives bounded schema feedback without accepting an invalid action constraint", async function () {
    const prompts: string[] = [];
    const invalid = {
      ...interpretation,
      actionIntents: [
        {
          ...interpretation.actionIntents[0],
          constraints: { collectionMode: "add" },
        },
      ],
    };
    const result = await detectTurnIntent(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        userText: "请将本文放入 Bayesian，保留其他归属",
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com",
        apiKey: "fixture",
      }),
      [],
      {
        llmCall: async (params) => {
          prompts.push(params.prompt || "");
          return {
            text: JSON.stringify(
              prompts.length === 1 ? invalid : interpretation,
            ),
            completion: { status: "complete" },
          };
        },
      },
    );
    assert.lengthOf(prompts, 2);
    assert.include(prompts[1], "Schema recovery");
    assert.equal(
      result.classifiedIntent?.actionIntents[0].scope?.path,
      "Bayesian",
    );
  });

  it("recovers an incomplete filing interpretation before asking the user for an already supplied destination", async function () {
    const prompts: string[] = [];
    const incomplete = {
      ...interpretation,
      actionIntents: [
        {
          operation: "move_to_collection",
          coverage: "one",
          targetKind: "papers",
          scopeRole: "source",
        },
      ],
    };
    const result = await detectTurnIntent(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        userText: "File this paper in Bayesian",
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com",
        apiKey: "fixture",
      }),
      [],
      {
        llmCall: async (params) => {
          prompts.push(params.prompt || "");
          return {
            text: JSON.stringify(
              prompts.length === 1 ? incomplete : interpretation,
            ),
            completion: { status: "complete" },
          };
        },
      },
    );
    assert.lengthOf(prompts, 2);
    assert.include(prompts[1], "destination");
    assert.equal(
      result.classifiedIntent?.actionIntents[0].scope?.path,
      "Bayesian",
    );
  });

  it("reports the provider status when semantic transport fails without exposing credentials", async function () {
    const result = await detectTurnIntent(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        userText: "File this paper",
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com",
        apiKey: "secret-test-key",
      }),
      [],
      {
        llmCall: async () => {
          throw new Error("401 Unauthorized");
        },
      },
    );
    assert.equal(result.failureStatus, 401);
    assert.isNull(result.classifiedIntent);
    assert.notInclude(JSON.stringify(result), "secret-test-key");
  });

  for (const userText of [
    "move this paper to Bayesian folder",
    "move this paper to Bayesian collection",
  ]) {
    it(`resolves the active paper and destination for: ${userText}`, async function () {
      const request = resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        activeItemId: 41,
        userText,
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com",
        apiKey: "test",
      });
      const classified = await detectTurnIntent(
        request,
        [
          {
            id: "organize",
            description: "Organize papers",
            version: 1,

            contexts: ["any"],
            activation: "auto",
            instruction: "",
            source: "system",
          },
        ],
        {
          llmCall: async () => ({
            text: JSON.stringify(interpretation),
            completion: { status: "complete" },
          }),
        },
      );
      assert.deepEqual(
        classified.classifiedIntent?.actionIntents.map(
          (action) => action.operation,
        ),
        ["move_to_collection"],
      );
      request.classifiedIntent = classified.classifiedIntent!;
      const item = {
        id: 41,
        libraryID: 1,
        isRegularItem: () => true,
        getField: () => "Current paper",
        getCollections: () => [],
      };
      const service = new ActionContractService({
        getItem: (id: number) => (id === 41 ? item : null),
        listCollectionSummaries: () => [
          { collectionId: 7, libraryID: 1, name: "Bayesian", path: "Bayesian" },
        ],
        listCurrentCollectionTargetIds: () => [],
      } as any);
      const contract = await service.createContract(request);
      assert.equal(contract.obligations[0].operation, "move_to_collection");
      assert.equal(contract.obligations[0].scope?.collectionId, 7);
      assert.deepEqual(
        contract.obligations[0].targetBoundary?.frozenTargetIds,
        [41],
      );
    });
  }
  it("interprets actions without any installed skills", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 2,
      mode: "agent",
      libraryID: 1,
      userText: "Put this in Bayesian",
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com",
      apiKey: "test",
    });
    const result = await detectTurnIntent(request, [], {
      llmCall: async () => ({
        text: JSON.stringify(interpretation),
        completion: { status: "complete" },
      }),
    });
    assert.equal(
      result.classifiedIntent?.actionIntents[0].operation,
      "move_to_collection",
    );
  });
  it("reports which semantic schema failed without exposing model output", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 2,
      mode: "agent",
      userText: "File this paper",
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com",
      apiKey: "test",
    });
    const result = await detectTurnIntent(request, [], {
      llmCall: async () => ({
        text: JSON.stringify({ ...interpretation, decisions: undefined }),
        completion: { status: "complete" },
      }),
    });
    assert.equal(result.failureStage, "decisions");
    assert.isNull(result.classifiedIntent);
  });

  it("specifies the complete action schema to the live interpreter", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 3,
      mode: "agent",
      userText: "File this paper",
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com",
      apiKey: "test",
    });
    let prompt = "";
    await detectTurnIntent(request, [], {
      llmCall: async (params) => {
        prompt = params.prompt;
        return {
          text: JSON.stringify(interpretation),
          completion: { status: "complete" },
        };
      },
    });
    assert.include(prompt, '"writeDisposition":"none|required|uncertain"');
    assert.include(prompt, '"actionIntents":[');
    assert.include(prompt, '"decisions":{');
  });

  it("resolves semantic destination names and proves an unfiled paper has no source to remove", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 4,
      mode: "agent",
      libraryID: 1,
      activeItemId: 41,
      userText: "arbitrary wording",
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com",
      apiKey: "test",
    });
    const result = await detectTurnIntent(request, [], {
      llmCall: async () => ({
        text: JSON.stringify({
          ...interpretation,
          actionIntents: [
            {
              operation: "move_to_collection",
              coverage: "one",
              targetKind: "papers",
              scopeRole: "destination",
              parameters: { collectionName: "Bayesian" },
              constraints: { collectionMode: "move" },
            },
          ],
        }),
        completion: { status: "complete" },
      }),
    });
    request.classifiedIntent = result.classifiedIntent!;
    const item = {
      id: 41,
      libraryID: 1,
      isRegularItem: () => true,
      getField: () => "Current paper",
      getCollections: () => [],
    };
    const service = new ActionContractService({
      getItem: () => item,
      listCollectionSummaries: () => [
        { collectionId: 7, libraryID: 1, name: "Bayesian", path: "Bayesian" },
      ],
    } as any);
    const contract = await service.createContract(request);
    assert.equal(
      contract.obligations[0].parameters?.destinationCollectionId,
      7,
    );
    assert.isUndefined(contract.obligations[0].parameters?.collectionName);
    assert.isUndefined(contract.obligations[0].constraints?.collectionMode);
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [41],
    );
  });
});

describe("permission mode in semantic prompts", function () {
  let originalZotero: typeof globalThis.Zotero;
  beforeEach(function () {
    originalZotero = globalThis.Zotero;
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  function stubMode(mode: "safe" | "auto" | "yolo") {
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) =>
          key.endsWith("originalAgentPermissionMode") ? mode : undefined,
      },
    } as never;
  }

  async function interpreterPrompt(mode: "safe" | "auto" | "yolo") {
    stubMode(mode);
    let prompt = "";
    await detectTurnIntent(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        libraryID: 1,
        userText: "File this paper",
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com",
        apiKey: "fixture",
      }),
      [],
      {
        llmCall: async (params) => {
          prompt = params.prompt || "";
          return {
            text: JSON.stringify(interpretation),
            completion: { status: "complete" },
          };
        },
      },
    );
    return prompt;
  }

  it("tells the interpreter the mode and asks yolo for assumptions instead of questions", async function () {
    const yolo = await interpreterPrompt("yolo");
    assert.include(yolo, "- Permission mode: yolo");
    assert.include(yolo, "list each choice in decisions.assumptions");
    assert.include(
      yolo,
      "Do not emit decisions.questions for ordinary ambiguity",
    );
    const safe = await interpreterPrompt("safe");
    assert.include(safe, "- Permission mode: safe");
    assert.notInclude(safe, "Do not emit decisions.questions");
    // The literal response envelope is what the model copies. Leaving
    // assumptions out of it contradicts the instruction to fill it in.
    for (const prompt of [yolo, safe])
      assert.include(prompt, '"questions":[],"assumptions":[]');
  });

  it("tells the reference resolver to pick the best-supported candidate in yolo", async function () {
    const prompts: Record<string, string> = {};
    for (const mode of ["yolo", "safe"] as const) {
      stubMode(mode);
      await new ModelSemanticReferenceResolver().resolve(
        {
          request: resolvedAgentRequest({
            conversationKey: 1,
            mode: "agent",
            libraryID: 1,
            userText: "File this in the reading folder",
            model: "deepseek-chat",
            apiBase: "https://api.deepseek.com",
            apiKey: "fixture",
          }),
          entity: "collection",
          description: "reading folder",
          candidates: [
            { id: 5, libraryID: 1, label: "Reading", details: "Reading" },
            {
              id: 6,
              libraryID: 1,
              label: "Reading 2025",
              details: "Reading 2025",
            },
          ],
        },
        {
          llmCall: async (params) => {
            prompts[mode] = params.prompt || "";
            return {
              text: JSON.stringify({
                state: "resolved",
                ids: [5],
                reason: "closest",
              }),
              completion: { status: "complete" },
            };
          },
        },
      );
    }
    assert.include(prompts.yolo, "select the best-supported one");
    assert.notInclude(prompts.safe, "select the best-supported one");
  });
});
