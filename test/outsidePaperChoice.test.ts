import { assert } from "chai";
import { buildActionCallDigest } from "../src/agent/authorization/proposal";
import type {
  AgentModelAdapter,
  AgentStepParams,
} from "../src/agent/model/adapter";
import { AgentRuntime } from "../src/agent/runtime";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import type { AgentToolRegistry } from "../src/agent/tools/registry";
import type {
  AgentEvent,
  AgentModelStep,
  AgentPendingAction,
  AgentToolContext,
  AgentToolResult,
  PreparedToolExecution,
  PreparedToolExecutionOptions,
} from "../src/agent/types";
import { paperSourceId } from "../src/webAccess/paperSources";
import {
  createBatchLibrary,
  installBatchJournal,
  type BatchLibrary,
} from "./helpers/batchFixtures";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * A literature review that needs papers outside the library asks the user,
 * on the paper selection card, whether to import and cite them or to cite
 * them without importing (maintainer decision, 2026-10-29). The review flag
 * on literature_search marks the discovery; only then does the card show
 * both choices, and the choice sets which outside papers a document of the
 * run may cite.
 */
describe("the selection card's choice to import and cite or cite without importing", function () {
  const RUN_ID = "outside-choice-run";
  const originalFetch = globalThis.fetch;
  let restoreJournal: () => void;
  let library: BatchLibrary;
  let registry: AgentToolRegistry;
  let callCount = 0;

  const doiOf = (index: number) => `10.1000/candidate-${index}`;

  beforeEach(async function () {
    restoreJournal = await installBatchJournal();
    (globalThis.Zotero as unknown as { Prefs: unknown }).Prefs = {
      get: () => "auto",
    };
    clearAgentToolResultHandleStore();
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 12 }, (_, i) => ({
          id: `https://openalex.org/W${i + 1}`,
          display_name: `Candidate ${i + 1}`,
          doi: `https://doi.org/${doiOf(i + 1)}`,
          publication_year: 2020 + (i % 5),
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

  function makeContext(): AgentToolContext {
    const request = resolvedAgentRequest({
      conversationKey: library.conversationKey,
      libraryID: 1,
      mode: "agent",
      userText: "Write a literature review on population coding.",
    });
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
    forLiteratureReview: boolean,
  ) {
    const result = await run(
      "literature_search",
      {
        mode: "search",
        workflow: "review",
        query: "population coding",
        limit: 12,
        ...(forLiteratureReview ? { forLiteratureReview: true } : {}),
      },
      context,
    );
    assert.isTrue(result.ok, JSON.stringify(result.content));
    return result.content as {
      candidateSetId: string;
      sessionId: string;
      revision: number;
    };
  }

  /** Shows the card for these candidates of the search's saved set. */
  async function showCard(
    context: AgentToolContext,
    found: { candidateSetId: string; sessionId: string },
    candidateIndexes: number[],
    revision = 0,
  ) {
    const reviewArgs = {
      sessionId: found.sessionId,
      revision,
      ...(revision ? {} : { count: candidateIndexes.length }),
      selections: candidateIndexes.map((candidateIndex) => ({
        candidateSetId: found.candidateSetId,
        candidateIndex,
        reason: "Relevant population-coding evidence.",
      })),
    };
    const reviewed = await run("literature_review", reviewArgs, context);
    assert.isTrue(reviewed.ok, JSON.stringify(reviewed.content));
    const review = registry.getTool("literature_review")!;
    const input = review.validate(reviewArgs);
    if (!input.ok) throw new Error(input.error);
    const card = (await review.createResultReviewAction!(
      input.value,
      reviewed,
      context,
    )) as AgentPendingAction;
    const list = card.fields[0];
    if (list.type !== "paper_result_list") throw new Error("No paper card");
    return {
      card,
      list,
      resolve: (actionId: string, selectedPaperIds: string[]) =>
        review.resolveResultReview!(
          input.value,
          reviewed,
          { approved: true, actionId, data: { selectedPaperIds } },
          context,
        ),
    };
  }

  it("takes the review flag only with workflow:'review'", function () {
    const tool = registry.getTool("literature_search")!;
    const parsed = (args: Record<string, unknown>) => {
      const result = tool.validate({
        mode: "search",
        query: "population coding",
        ...args,
      });
      if (!result.ok) throw new Error(result.error);
      return result.value as { forLiteratureReview?: true };
    };
    assert.isTrue(
      parsed({ workflow: "review", forLiteratureReview: true })
        .forLiteratureReview,
    );
    assert.notProperty(
      parsed({
        workflow: "answer",
        forLiteratureReview: true,
        need: "not_in_scope_or_library",
        gap: "The library has no population-coding papers.",
      }),
      "forLiteratureReview",
    );
    assert.notProperty(parsed({ workflow: "review" }), "forLiteratureReview");
  });

  it("shows a review's card with both visible submit choices", async function () {
    const context = makeContext();
    const found = await search(context, true);
    const { card, list } = await showCard(context, found, [3, 1, 4]);
    assert.deepEqual(
      card.actions?.map((action) => [action.id, action.footer === true]),
      [
        ["cite", true],
        ["import", false],
        ["cancel", false],
      ],
    );
    assert.equal(card.actions?.[0].label, "Cite {count} without importing");
    assert.equal(card.actions?.[0].style, "secondary");
    assert.equal(card.actions?.[1].style, "primary");
    assert.deepEqual(card.selectionAction, {
      fieldId: "selectedPaperIds",
      verb: "Import and cite",
    });
    assert.equal(card.defaultActionId, "import");
    assert.equal(card.cancelActionId, "cancel");
    assert.equal(list.loadMoreActionId, "find_more");
    assert.deepEqual(list.visibleForActionIds, ["cite", "import"]);
    assert.deepEqual(list.minSelectedByAction, [
      { actionId: "cite", min: 1 },
      { actionId: "import", min: 1 },
    ]);
  });

  it("leaves a find-papers card unchanged without the flag", async function () {
    const context = makeContext();
    const found = await search(context, false);
    const { card, list, resolve } = await showCard(context, found, [3, 1, 4]);
    assert.deepEqual(
      card.actions?.map((action) => action.id),
      ["import", "cancel"],
    );
    assert.isTrue(card.actions?.every((action) => !action.footer));
    assert.equal(card.actions?.[0].label, "Import selected");
    assert.equal(card.confirmLabel, "Import selected");
    assert.deepEqual(card.selectionAction, {
      fieldId: "selectedPaperIds",
      verb: "Import",
    });
    assert.equal(list.loadMoreActionId, "find_more");
    assert.deepEqual(list.visibleForActionIds, ["import"]);
    assert.deepEqual(list.minSelectedByAction, [
      { actionId: "import", min: 1 },
    ]);
    // Cite without importing is a review's choice only.
    let refused: unknown;
    try {
      await resolve("cite", [list.rows[0].id]);
    } catch (error) {
      refused = error;
    }
    assert.match(String(refused), /Unknown discovery action/);
  });

  it("cites the ticked papers without importing, a Find more row included", async function () {
    const context = makeContext();
    const found = await search(context, true);
    const first = await showCard(context, found, [3, 1, 4]);
    // Find more: the user keeps two papers and asks for more.
    const more = await first.resolve("find_more", [
      first.list.rows[0].id,
      first.list.rows[2].id,
    ]);
    assert.equal(more.kind, "deliver");
    const second = await showCard(context, found, [7, 9, 10], 1);
    const rows = second.list.rows;
    assert.lengthOf(rows, 6);
    const findMoreRow = rows.find((row) => row.title === "Candidate 9")!;
    const outcome = await second.resolve("cite", [
      rows.find((row) => row.title === "Candidate 3")!.id,
      findMoreRow.id,
    ]);
    if (outcome.kind !== "deliver") throw new Error("Cite did not deliver");
    const content = outcome.toolMessageContent as {
      papers: Array<Record<string, unknown>>;
      nextStep: string;
    };
    const ids = [
      paperSourceId(`doi:${doiOf(3)}`),
      paperSourceId(`doi:${doiOf(9)}`),
    ];
    assert.deepEqual(
      content.papers.map((paper) => paper.paperId),
      ids,
    );
    assert.deepInclude(content.papers[1], {
      title: "Candidate 9",
      year: 2023,
      doi: doiOf(9),
    });
    assert.include(content.nextStep, "literature_read");
    assert.include(content.nextStep, "submit_document by its paperId");
    assert.include(content.nextStep, "do not import them");
    // The ticked papers are the run's record and its only citable ones.
    assert.deepEqual(context.request.outsidePaperSelection, ids);
    assert.deepEqual(
      context.request.outsidePaperRecords?.map((record) => [
        record.paperId,
        record.depth,
      ]),
      ids.map((id) => [id, "metadata"]),
    );
    assert.deepEqual(library.importedIdentifiers, [], "nothing is imported");

    // A same-turn import of a cited paper is refused, pointing to later.
    const refused = await prepare(
      "library_import",
      { kind: "identifiers", identifiers: [doiOf(9)] },
      context,
    );
    if (refused.kind !== "result") throw new Error("Expected a refusal");
    assert.isTrue(refused.execution.result.inputRejected);
    const error = String(
      (refused.execution.result.content as { error?: unknown }).error,
    );
    assert.include(
      error,
      "chose to cite 10.1000/candidate-9 without importing",
    );
    assert.include(
      error,
      "Cite it by paperId; import it later, when the user asks.",
    );
    assert.deepEqual(library.importedIdentifiers, []);
  });

  it("imports and cites: no outside paper is citable, and the run reads the imports next", async function () {
    const context = makeContext();
    const found = await search(context, true);
    const { list, resolve } = await showCard(context, found, [3, 1, 4]);
    const outcome = await resolve("import", [list.rows[0].id]);
    if (outcome.kind !== "invoke_tool")
      throw new Error("The card did not import");
    assert.isUndefined(outcome.terminalText, "the run goes on to cite");
    assert.include(outcome.nextStep!, "paper_read");
    assert.include(outcome.nextStep!, "libraryID and itemKey");
    assert.deepEqual(context.request.outsidePaperSelection, []);
    assert.deepEqual(outcome.call.arguments, {
      kind: "identifiers",
      identifiers: [doiOf(3)],
      libraryID: 1,
      targetCollectionId: undefined,
    });
  });

  it("keeps a find-papers card's Import ending the run", async function () {
    const context = makeContext();
    const found = await search(context, false);
    const { list, resolve } = await showCard(context, found, [3, 1, 4]);
    const outcome = await resolve("import", [list.rows[0].id]);
    if (outcome.kind !== "invoke_tool")
      throw new Error("The card did not import");
    assert.equal(
      outcome.terminalText?.onSuccess,
      "Imported the selected papers into Zotero.",
    );
    assert.isUndefined(outcome.nextStep);
    assert.deepEqual(context.request.outsidePaperSelection, []);
  });

  it("delivers the import with its next step to the model, which goes on", async function () {
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
    let importResult = "";
    const steps: Array<(params: AgentStepParams) => AgentModelStep> = [
      () =>
        callStep("literature_search", {
          mode: "search",
          workflow: "review",
          forLiteratureReview: true,
          query: "population coding",
          limit: 12,
        }),
      () =>
        callStep("literature_review", {
          sessionId,
          revision: 0,
          count: 2,
          selections: [2, 5].map((candidateIndex) => ({
            candidateSetId,
            candidateIndex,
            reason: "Relevant population-coding evidence.",
          })),
        }),
      (params) => {
        importResult = JSON.stringify(
          [...params.messages]
            .reverse()
            .find((message) => message.role === "tool")?.content,
        );
        return {
          kind: "final",
          text: "Done.",
          assistantMessage: { role: "assistant", content: "Done." },
        };
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
    const outcome = await runtime.runTurn({
      request: {
        conversationKey: library.conversationKey,
        mode: "agent",
        userText: "Write a literature review on population coding.",
        libraryID: 1,
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1/responses",
        apiKey: "test",
      },
      onEvent: async (event: AgentEvent) => {
        if (event.type !== "confirmation_required") return;
        const list = event.action.fields[0];
        if (list.type !== "paper_result_list")
          throw new Error("Not a paper card");
        runtime.resolveConfirmation(event.requestId, {
          approved: true,
          actionId: "import",
          data: { selectedPaperIds: [list.rows[1].id] },
        });
      },
    });
    assert.equal(outcome.kind, "completed");
    assert.equal(stepIndex, steps.length, "the model ran after the import");
    assert.deepEqual(library.importedIdentifiers, [doiOf(5)]);
    assert.include(importResult, "Read the imported items with paper_read");
  });

  it("runs the card's import under the approval it mints", async function () {
    const context = makeContext();
    const found = await search(context, true);
    const { list, resolve } = await showCard(context, found, [3, 1, 4]);
    const outcome = await resolve("import", [list.rows[1].id]);
    if (outcome.kind !== "invoke_tool")
      throw new Error("The card did not import");
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
    assert.deepEqual(library.importedIdentifiers, [doiOf(1)]);
  });
});
