import { assert } from "chai";
import { buildActionCallDigest } from "../src/agent/authorization/proposal";
import type {
  AgentModelAdapter,
  AgentStepParams,
} from "../src/agent/model/adapter";
import { AgentRuntime } from "../src/agent/runtime";
import { identifyLiteratureCandidates } from "../src/agent/services/literatureDiscovery";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { ToolInputRejection } from "../src/agent/tools/execution/failure";
import type { AgentToolRegistry } from "../src/agent/tools/registry";
import type {
  AgentEvent,
  AgentModelStep,
  AgentToolContext,
  AgentToolResult,
  PreparedToolExecution,
  PreparedToolExecutionOptions,
} from "../src/agent/types";
import {
  createBatchLibrary,
  installBatchJournal,
  type BatchLibrary,
} from "./helpers/batchFixtures";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * A request that only asks to find or recommend papers imports nothing the
 * user did not choose on the paper selection card. The model chooses
 * discovery by opening one (literature_search workflow:'review'); from then
 * on the host refuses a direct import of its candidates, in every permission
 * mode, before anything runs. The card's own Import, and an explicit import
 * request (workflow:'answer'), still import.
 */
describe("discovered papers enter Zotero only through the selection card", function () {
  const MODES = ["safe", "auto", "yolo"] as const;
  const RUN_ID = "discovery-run";
  const originalFetch = globalThis.fetch;
  let restoreJournal: () => void;
  let library: BatchLibrary;
  let registry: AgentToolRegistry;
  let mode: (typeof MODES)[number];
  let callCount = 0;

  beforeEach(async function () {
    restoreJournal = await installBatchJournal();
    mode = "auto";
    (globalThis.Zotero as unknown as { Prefs: unknown }).Prefs = {
      get: () => mode,
    };
    clearAgentToolResultHandleStore();
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 12 }, (_, i) => ({
          id: `https://openalex.org/W${i + 1}`,
          display_name: `Candidate ${i + 1}`,
          doi: `https://doi.org/10.1000/candidate-${i + 1}`,
          publication_year: 2024,
        })),
      }),
    })) as typeof fetch;
    library = createBatchLibrary([]);
    registry = createBuiltInToolRegistry({
      zoteroGateway: library.zoteroGateway as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    clearAgentToolResultHandleStore();
    restoreJournal();
  });

  function makeContext(
    extra: Partial<AgentToolContext> = {},
    userText = "Find three papers on population coding for me.",
  ): AgentToolContext {
    const request = resolvedAgentRequest({
      conversationKey: library.conversationKey,
      libraryID: 1,
      mode: "agent",
      userText,
    });
    // An ordinary agent turn: the in-plugin agent owns permission.
    request.executionContext = {
      version: 1,
      executionId: RUN_ID,
      conversationKey: library.conversationKey,
      conversationGeneration: 0,
      chatLibraryID: 1,
      permissionOwner: "original_agent",
      workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
      configuredAccess: { libraryIDs: [1], outputDirectories: [] },
    };
    return {
      request,
      runId: RUN_ID,
      resourceSignature: "paper-A",
      item: null,
      currentAnswerText: "",
      modelName: "test",
      ...extra,
    };
  }

  function prepare(
    name: string,
    args: Record<string, unknown>,
    context: AgentToolContext,
    options: PreparedToolExecutionOptions = { callerKind: "model" },
  ): Promise<PreparedToolExecution> {
    return registry.prepareExecution(
      { id: `${name}-${++callCount}`, name, arguments: args },
      context,
      options,
    );
  }

  /** Runs a call to its result, approving a Safe confirmation as shown. */
  async function run(
    name: string,
    args: Record<string, unknown>,
    context: AgentToolContext,
    options?: PreparedToolExecutionOptions,
  ): Promise<AgentToolResult> {
    let prepared = await prepare(name, args, context, options);
    if (prepared.kind === "confirmation")
      prepared = await prepared.execute({ approved: true });
    if (prepared.kind !== "result")
      throw new Error(`${name} never reached a result`);
    return prepared.execution.result;
  }

  async function search(
    context: AgentToolContext,
    workflow: "review" | "answer",
  ) {
    const result = await run(
      "literature_search",
      {
        mode: "search",
        workflow,
        query: "population coding",
        limit: 12,
        need: "not_in_scope_or_library",
        gap: "The library has no other population-coding papers.",
      },
      context,
    );
    assert.isTrue(result.ok, JSON.stringify(result.content));
    return result.content as {
      candidateSetId: string;
      sessionId?: string;
      reviewRequired: boolean;
    };
  }

  for (const permission of MODES) {
    it(`refuses a direct import of a discovery's candidates before it runs in ${permission}`, async function () {
      mode = permission;
      const context = makeContext();
      const found = await search(context, "review");
      assert.isTrue(found.reviewRequired);
      const prepared = await prepare(
        "library_import",
        {
          kind: "identifiers",
          identifiers: [
            "10.1000/candidate-2",
            "https://doi.org/10.1000/CANDIDATE-5",
          ],
        },
        context,
      );
      assert.equal(
        prepared.kind,
        "result",
        "the refusal comes before any confirmation card",
      );
      if (prepared.kind !== "result") return;
      const result = prepared.execution.result;
      assert.isFalse(result.ok);
      assert.isTrue(result.inputRejected, JSON.stringify(result.content));
      const error = String((result.content as { error?: unknown }).error);
      assert.include(error, "paper selection card");
      assert.include(error, "literature_review");
      assert.include(error, found.sessionId!);
      assert.include(error, "10.1000/candidate-2");
      assert.deepEqual(library.importedIdentifiers, [], "nothing ran");
    });
  }

  it("imports the papers the user chose on the selection card, and no others", async function () {
    const context = makeContext();
    const found = await search(context, "review");
    const reviewArgs = {
      selections: [3, 1, 4].map((candidateIndex) => ({
        candidateSetId: found.candidateSetId,
        candidateIndex,
        reason: "Relevant population-coding evidence.",
      })),
      count: 3,
    };
    const reviewed = await run("literature_review", reviewArgs, context);
    assert.isTrue(reviewed.ok, JSON.stringify(reviewed.content));
    const review = registry.getTool("literature_review")!;
    const input = review.validate(reviewArgs);
    if (!input.ok) throw new Error(input.error);
    const card = await review.createResultReviewAction!(
      input.value,
      reviewed,
      context,
    );
    const list = card!.fields[0];
    if (list.type !== "paper_result_list") throw new Error("No paper card");
    const outcome = await review.resolveResultReview!(
      input.value,
      reviewed,
      {
        approved: true,
        actionId: "import",
        data: { selectedPaperIds: [list.rows[0].id, list.rows[2].id] },
      },
      context,
    );
    if (outcome.kind !== "invoke_tool")
      throw new Error("The card did not import");
    // The runtime runs the card's import under the approval the host mints
    // for that exact call.
    const imported = await run(
      outcome.call.name,
      outcome.call.arguments as Record<string, unknown>,
      context,
      {
        callerKind: "action",
        inheritedApproval: {
          ...outcome.call.inheritedApproval!,
          approvedCallDigest: buildActionCallDigest(
            outcome.call.name,
            outcome.call.arguments,
          ),
        },
      },
    );
    assert.notOk(imported.inputRejected, JSON.stringify(imported.content));
    assert.deepEqual(library.importedIdentifiers, [
      "10.1000/candidate-3",
      "10.1000/candidate-4",
    ]);
    // The paper the user left unchecked stays out of the library.
    const unchosen = await prepare(
      "library_import",
      { kind: "identifiers", identifiers: ["10.1000/candidate-1"] },
      context,
    );
    assert.equal(unchosen.kind, "result");
    if (unchosen.kind === "result")
      assert.isTrue(unchosen.execution.result.inputRejected);
    assert.deepEqual(library.importedIdentifiers, [
      "10.1000/candidate-3",
      "10.1000/candidate-4",
    ]);
  });

  for (const permission of MODES) {
    it(`imports directly on the explicit-import route (workflow:'answer') in ${permission}`, async function () {
      mode = permission;
      const context = makeContext(
        {},
        "Find and import 3 papers on population coding.",
      );
      const found = await search(context, "answer");
      assert.isFalse(found.reviewRequired);
      const result = await run(
        "library_import",
        {
          kind: "identifiers",
          identifiers: [
            "10.1000/candidate-2",
            "10.1000/candidate-5",
            "10.1000/candidate-7",
          ],
        },
        context,
      );
      assert.notOk(result.inputRejected, JSON.stringify(result.content));
      assert.deepEqual(library.importedIdentifiers, [
        "10.1000/candidate-2",
        "10.1000/candidate-5",
        "10.1000/candidate-7",
      ]);
    });
  }

  it("still imports an identifier the discovery never found", async function () {
    const context = makeContext();
    await search(context, "review");
    const result = await run(
      "library_import",
      { kind: "identifiers", identifiers: ["10.9999/named-by-the-user"] },
      context,
    );
    assert.notOk(result.inputRejected, JSON.stringify(result.content));
    assert.deepEqual(library.importedIdentifiers, [
      "10.9999/named-by-the-user",
    ]);
  });

  it("leaves a caller that has no selection card to its own controls", async function () {
    // MCP clients are never offered literature_review; they present the
    // candidates themselves and keep their own permission controls.
    const context = makeContext({
      isToolVisible: (spec) => spec.name !== "literature_review",
    });
    await search(context, "review");
    const result = await run(
      "library_import",
      { kind: "identifiers", identifiers: ["10.1000/candidate-2"] },
      context,
    );
    assert.notOk(result.inputRejected, JSON.stringify(result.content));
    assert.deepEqual(library.importedIdentifiers, ["10.1000/candidate-2"]);
  });

  // arXiv-provider results carry only an abs URL; other providers carry a
  // DataCite 10.48550 DOI or an arXiv open-access link. Imports name the same
  // paper by arXiv id or DOI.
  describe("recognizing a discovery's candidates by normalized identity", function () {
    const arxivCandidate = {
      title: "Arxiv Paper",
      sourceUrl: "http://arxiv.org/abs/2301.00001v1",
    };
    async function refuses(
      candidate: Record<string, unknown>,
      identifier: string,
    ): Promise<boolean> {
      const context = makeContext();
      await identifyLiteratureCandidates(
        { mode: "search", results: [candidate] },
        context,
        true,
      );
      const tool = registry.getTool("library_import")!;
      const input = tool.validate({
        kind: "identifiers",
        identifiers: [identifier],
      });
      if (!input.ok) throw new Error(input.error);
      try {
        await tool.planInvocation!(input.value, context);
        return false;
      } catch (error) {
        if (error instanceof ToolInputRejection) return true;
        throw error;
      }
    }
    for (const [label, candidate, identifier] of [
      ["an arXiv abs URL by arxiv: id", arxivCandidate, "arxiv:2301.00001"],
      [
        "an arXiv abs URL by versioned arXiv: id",
        arxivCandidate,
        "arXiv:2301.00001v1",
      ],
      [
        "a DOI by a DOI:-prefixed uppercase DOI",
        { doi: "10.1000/abc" },
        "DOI: 10.1000/ABC",
      ],
      [
        "a DOI by a doi:-prefixed DOI",
        { doi: "https://doi.org/10.1000/abc" },
        "doi:10.1000/abc",
      ],
      [
        "a 10.48550 arXiv DOI by arXiv id",
        { doi: "10.48550/arXiv.2301.00001" },
        "2301.00001",
      ],
      [
        "an arXiv open-access link by arXiv id",
        {
          title: "Open access",
          doi: "10.1000/oa",
          openAccessUrl: "https://arxiv.org/pdf/2301.00003v2",
        },
        "arxiv:2301.00003",
      ],
    ] as const) {
      it(`refuses importing ${label}`, async function () {
        assert.isTrue(await refuses(candidate, identifier));
      });
    }
    it("imports a different arXiv id", async function () {
      assert.isFalse(await refuses(arxivCandidate, "arxiv:2301.00002"));
    });
  });

  it("delivers the refusal to the model, which then shows the card that imports the user's choice", async function () {
    let candidateSetId = "";
    let sessionId = "";
    const searchTool = registry.getTool("literature_search")!;
    const executeSearch = searchTool.execute;
    searchTool.execute = async (input, context) => {
      const result = (await executeSearch(input, context)) as {
        candidateSetId: string;
        sessionId: string;
      };
      candidateSetId = result.candidateSetId;
      sessionId = result.sessionId;
      return result;
    };
    const callStep = (name: string, args: unknown): AgentModelStep => {
      const calls = [{ id: `call-${++callCount}`, name, arguments: args }];
      return {
        kind: "tool_calls",
        calls,
        assistantMessage: { role: "assistant", content: "", tool_calls: calls },
      };
    };
    const lastToolText = (params: AgentStepParams) =>
      JSON.stringify(
        [...params.messages]
          .reverse()
          .find((message) => message.role === "tool")?.content,
      );
    const steps: Array<(params: AgentStepParams) => AgentModelStep> = [
      () =>
        callStep("literature_search", {
          mode: "search",
          workflow: "review",
          query: "population coding",
          limit: 12,
          need: "not_in_scope_or_library",
          gap: "The library has no other population-coding papers.",
        }),
      // The model imports instead of showing the card.
      () =>
        callStep("library_import", {
          kind: "identifiers",
          identifiers: ["10.1000/candidate-8", "10.1000/candidate-2"],
        }),
      (params) => {
        const refusal = lastToolText(params);
        assert.include(refusal, "paper selection card");
        assert.include(refusal, "literature_review");
        return callStep("literature_review", {
          sessionId,
          revision: 0,
          count: 3,
          selections: [8, 2, 10].map((candidateIndex) => ({
            candidateSetId,
            candidateIndex,
            reason: "Relevant population-coding evidence.",
          })),
        });
      },
    ];
    let stepIndex = 0;
    const adapter: AgentModelAdapter = {
      getCapabilities: () => ({
        streaming: false,
        toolCalls: true,
        multimodal: false,
        fileInputs: false,
        reasoning: false,
      }),
      supportsTools: () => true,
      runStep: async (params) => {
        const step = steps[stepIndex++];
        if (!step) throw new Error(`Unexpected model step ${stepIndex}`);
        return step(params);
      },
    };
    const runtime = new AgentRuntime({
      registry,
      adapterFactory: () => adapter,
    });
    const cards: string[] = [];
    const outcome = await runtime.runTurn({
      request: {
        conversationKey: library.conversationKey,
        mode: "agent",
        userText: "Find three papers on population coding for me.",
        libraryID: 1,
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1/responses",
        apiKey: "test",
      },
      onEvent: async (event: AgentEvent) => {
        if (event.type !== "confirmation_required") return;
        cards.push(event.action.toolName);
        assert.deepEqual(
          library.importedIdentifiers,
          [],
          "nothing is imported before the user chooses",
        );
        const list = event.action.fields[0];
        if (list.type !== "paper_result_list")
          throw new Error("Not a paper card");
        assert.deepEqual(
          list.rows.map((row) => row.title),
          ["Candidate 8", "Candidate 2", "Candidate 10"],
        );
        runtime.resolveConfirmation(event.requestId, {
          approved: true,
          actionId: "import",
          data: { selectedPaperIds: [list.rows[0].id] },
        });
      },
    });
    assert.equal(outcome.kind, "completed");
    assert.equal(stepIndex, steps.length);
    assert.deepEqual(cards, ["literature_review"]);
    assert.deepEqual(library.importedIdentifiers, ["10.1000/candidate-8"]);
  });
});
