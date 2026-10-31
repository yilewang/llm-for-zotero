import { assert } from "chai";
import { createLiteratureSearchTool } from "../src/agent/tools/read/literatureSearch";
import { createLiteratureReviewTool } from "../src/agent/tools/read/reviewLiterature";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import { AgentFinalAnswerController } from "../src/agent/finalization/finalAnswerController";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";
import { literaturePaperIdentities } from "../src/agent/services/literatureDiscovery";
import { OUTSIDE_SEARCH_STOP_NOTE } from "../src/agent/tools/read/outsideSearchNeed";
import { clearOutsideSearchTurn } from "../src/agent/tools/read/outsideSearchLedger";

/** Every outside evidence search states why the library cannot hold it. */
const OUTSIDE_NEED = {
  need: "not_in_scope_or_library",
  gap: "The library lacks related work.",
} as const;
describe("ranked literature discovery workflow", function () {
  const originalFetch = globalThis.fetch;
  const originalZotero = globalThis.Zotero;
  const gateway = {
    resolveMetadataItem: () => null,
    getEditableArticleMetadata: () => null,
    getCollectionSummary: (id: number) =>
      id === 79
        ? {
            collectionId: 79,
            libraryID: 1,
            name: "Research",
            path: "Lab / Research",
          }
        : null,
  };
  const makeContext = (): AgentToolContext => ({
    request: resolvedAgentRequest({
      conversationKey: 9901,
      libraryID: 1,
      mode: "agent",
      userText: "Find five papers relevant to the current paper.",
    }),
    runId: "discovery-test-run",
    resourceSignature: "paper-A",
    item: null,
    currentAnswerText: "",
    modelName: "test",
  });
  const resultOf = (name: string, content: unknown): AgentToolResult => ({
    name,
    callId: "test-call",
    ok: true,
    actionReceipts: [],
    content,
  });
  beforeEach(function () {
    clearAgentToolResultHandleStore();
    clearOutsideSearchTurn("discovery-test-run");
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 12 }, (_, i) => ({
          id: `https://openalex.org/W${i + 1}`,
          display_name: `Candidate ${i + 1}`,
          doi: `https://doi.org/10.1000/candidate-${i + 1}`,
          publication_year: 2024,
          authorships: [{ author: { display_name: "Fixture Author" } }],
        })),
      }),
    })) as typeof fetch;
    // These fixtures assert the reviewed-shortlist card behavior of Safe
    // mode; stub the pref store so getOriginalAgentPermissionMode() resolves
    // deterministically instead of throwing on an absent globalThis.Zotero.
    globalThis.Zotero = { Prefs: { get: () => "safe" } } as never;
  });
  afterEach(function () {
    globalThis.fetch = originalFetch;
    globalThis.Zotero = originalZotero;
    clearAgentToolResultHandleStore();
  });

  // The runtime records the facade's validated (delegated) input.
  function validatedImportInput(identifiers: string[]) {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: gateway as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const parsed = registry
      .getTool("library_import")!
      .validate({ kind: "identifiers", identifiers });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  async function search(
    context = makeContext(),
    extra: Record<string, unknown> = {},
  ) {
    const tool = createLiteratureSearchTool(gateway as never);
    // A find-paper search states no reason (user decision 1a, 2026-10-20).
    const input = tool.validate({
      mode: "search",
      workflow: "review",
      query: "population coding",
      limit: 12,
      ...extra,
    });
    if (!input.ok) throw new Error(input.error);
    const content = (await tool.execute(input.value, context)) as any;
    assert.lengthOf(content.results, 12);
    assert.isString(content.candidateSetId);
    assert.isTrue(content.reviewRequired);
    assert.isNull(
      await tool.createResultReviewAction?.(
        input.value,
        resultOf("literature_search", content),
        context,
      ),
    );
    return content;
  }

  it(`preserves requested user selection before import`, async function () {
    const context = makeContext();
    context.request.userText =
      "Find five papers relevant to the current paper and import only the ones I select.";
    const candidates = await search(context);
    const tool = createLiteratureReviewTool(gateway as never);
    const input = tool.validate({
      selections: [1, 2, 3, 4, 5].map((candidateIndex) => ({
        candidateSetId: candidates.candidateSetId,
        candidateIndex,
        reason: "Relevant title and abstract",
      })),
    });
    if (!input.ok) throw new Error(input.error);
    const content = await tool.execute(input.value, context);
    const card = await tool.createResultReviewAction!(
      input.value,
      resultOf("literature_review", content),
      context,
    );
    assert.exists(card);
    assert.deepEqual(
      card!.actions!.map((action) => action.id),
      ["import", "cancel"],
    );
  });

  it(`lets the agent rank twelve candidates into five paper-only choices`, async function () {
    const context = makeContext();
    const candidates = await search(context);
    const tool = createLiteratureReviewTool(gateway as never);
    const ranked = [8, 2, 10, 4, 1];
    const input = tool.validate({
      selections: ranked.map((candidateIndex) => ({
        candidateSetId: candidates.candidateSetId,
        candidateIndex,
        reason: `Evidence-based relevance for candidate ${candidateIndex}`,
      })),
      targetCollectionId: 79,
    });
    if (!input.ok) throw new Error(input.error);
    const content = await tool.execute(input.value, context);
    const result = resultOf("literature_review", content);
    const card = await tool.createResultReviewAction!(
      input.value,
      result,
      context,
    );
    assert.exists(card);
    assert.deepEqual(
      card!.fields.map((field) => field.type),
      ["paper_result_list"],
    );
    assert.deepEqual(
      card!.actions!.map((action) => action.id),
      ["import", "cancel"],
    );
    assert.include(card!.description, "Lab / Research");
    const list = card!.fields[0];
    if (list.type !== "paper_result_list") throw new Error("Wrong field");
    assert.deepEqual(
      list.rows.map((row) => row.title),
      ranked.map((i) => `Candidate ${i}`),
    );
    assert.include(list.rows[0].body, "relevance");
    const approved = await tool.resolveResultReview!(
      input.value,
      result,
      {
        approved: true,
        actionId: "import",
        data: { selectedPaperIds: [list.rows[0].id, list.rows[2].id] },
      },
      context,
    );
    assert.equal(approved.kind, "invoke_tool");
    if (approved.kind !== "invoke_tool") return;
    assert.equal(approved.call.name, "library_import");
    assert.deepInclude(approved.call.arguments, {
      identifiers: ["10.1000/candidate-8", "10.1000/candidate-10"],
      libraryID: 1,
      targetCollectionId: 79,
    });
  });

  it("rejects wrong counts, duplicate candidates, unknown references, stale context and foreign destinations", async function () {
    const context = makeContext();
    const candidates = await search(context);
    const tool = createLiteratureReviewTool(gateway as never);
    const selections = [1, 2, 3, 4, 5].map((candidateIndex) => ({
      candidateSetId: candidates.candidateSetId,
      candidateIndex,
      reason: "Relevant evidence",
    }));
    for (const [args, changedContext] of [
      [{ selections: selections.slice(0, 4) }, context],
      [{ selections: [...selections.slice(0, 4), selections[0]] }, context],
      [
        {
          selections: selections.map((s) => ({
            ...s,
            candidateSetId: "trh_missing",
          })),
        },
        context,
      ],
      [{ selections }, { ...context, runId: "another-run" }],
      [{ selections, targetCollectionId: 12345 }, context],
    ] as const) {
      const input = tool.validate(args);
      if (!input.ok) continue;
      let rejected = false;
      try {
        await tool.execute(input.value, changedContext);
      } catch {
        rejected = true;
      }
      assert.isTrue(rejected, JSON.stringify(args));
    }
  });

  it("lets the model choose the card or its answer when prose follows a paper-finding search", async function () {
    // Live evals (2026-10-20): an evidence question opened a discovery with
    // workflow:'review', and the gate replaced a full answer with an
    // unrequested card. The correction offers both paths; the model, not a
    // host reading of the user's words, picks one.
    const context = makeContext();
    const content = await search(context);
    const controller = new AgentFinalAnswerController(context.request);
    const records = [{ name: "literature_search", ok: true, content }];
    const first = await controller.evaluate({
      candidateText: "Two later studies found the same effect.",
      canCorrect: true,
      toolExecutionRecords: records,
    });
    assert.equal(first.kind, "correct");
    if (first.kind === "correct") {
      // Path (a): the user asked for papers themselves; the card, as before.
      assert.include(
        first.correction,
        "If the user asked for papers themselves",
      );
      // A list the user asked for in chat is answered in chat (user
      // instructions come first, 2026-10-31).
      assert.include(
        first.correction,
        "and not for a list in chat, show them on the card:",
      );
      assert.include(
        first.correction,
        "Use the active discovery sessionId and revision",
      );
      assert.include(first.correction, "call literature_review");
      assert.include(first.correction, "Do not import silently");
      // Path (b): otherwise the answer is given again, without the card.
      assert.include(
        first.correction,
        "Otherwise, do not call literature_review: give your answer again as the final answer",
      );
    }
    // The model chose path (b): its answer is accepted, and the remaining
    // gates still run.
    const second = await controller.evaluate({
      candidateText: "Two later studies found the same effect.",
      canCorrect: true,
      toolExecutionRecords: records,
    });
    assert.equal(second.kind, "accept");
    // A third look (after a later gate's correction) still accepts.
    const third = await controller.evaluate({
      candidateText: "Two later studies found the same effect.",
      canCorrect: true,
      toolExecutionRecords: records,
    });
    assert.equal(third.kind, "accept");
  });

  it("closes a discovery when the model takes the card after the correction", async function () {
    // Path (a): the user asked for papers, so the model shows the card.
    const context = makeContext();
    const content = await search(context);
    const controller = new AgentFinalAnswerController(context.request);
    const first = await controller.evaluate({
      candidateText: "Here are some papers.",
      canCorrect: true,
      toolExecutionRecords: [{ name: "literature_search", ok: true, content }],
    });
    assert.equal(first.kind, "correct");
    const second = await controller.evaluate({
      candidateText: "Choose the papers to import on the card.",
      canCorrect: true,
      toolExecutionRecords: [
        { name: "literature_search", ok: true, content },
        {
          name: "literature_review",
          ok: true,
          content: { reviewRequired: true, discoveryPhase: "review" },
        },
      ],
    });
    assert.equal(second.kind, "accept");
  });

  it("accepts first-batch prose when no correction can be given before the card", async function () {
    const context = makeContext();
    const content = await search(context);
    const controller = new AgentFinalAnswerController(context.request);
    const decision = await controller.evaluate({
      candidateText: "Here are some papers.",
      canCorrect: false,
      toolExecutionRecords: [{ name: "literature_search", ok: true, content }],
    });
    // Finish-only step or last round: the card cannot follow, and failing
    // would only lose the answer.
    assert.equal(decision.kind, "accept");
  });

  it("keeps a Find more expansion card-only: prose is corrected once, then fails", async function () {
    // The user clicked Find more on a card, so prose is never the answer.
    const expanding = {
      name: "literature_review",
      ok: true,
      content: {
        reviewRequired: true,
        discoveryPhase: "expanding",
        sessionId: "trh_active",
        revision: 1,
        batchSize: 5,
      },
    };
    // An expansion's own further search carries the new revision.
    const expansionSearch = {
      name: "literature_search",
      ok: true,
      content: { reviewRequired: true, sessionId: "trh_active", revision: 1 },
    };
    for (const records of [[expanding], [expanding, expansionSearch]]) {
      const controller = new AgentFinalAnswerController(makeContext().request);
      const first = await controller.evaluate({
        candidateText: "Here are more papers.",
        canCorrect: true,
        toolExecutionRecords: records,
      });
      assert.equal(first.kind, "correct");
      if (first.kind === "correct") {
        assert.include(first.correction, "select only NEW papers");
        assert.notInclude(first.correction, "give your answer again");
      }
      const second = await controller.evaluate({
        candidateText: "Here are more papers.",
        canCorrect: true,
        toolExecutionRecords: records,
      });
      assert.equal(second.kind, "fail");
    }
  });

  it("does not close a discovery with a direct import of its candidates", async function () {
    // Only the selection card closes a discovery. The host refuses such an
    // import before it runs; were one recorded, it still would not count.
    const context = makeContext();
    const content = await search(context);
    const controller = new AgentFinalAnswerController(context.request);
    const toolExecutionRecords = [
      { name: "literature_search", ok: true, content },
      {
        name: "library_import",
        ok: true,
        input: validatedImportInput(["https://doi.org/10.1000/CANDIDATE-2"]),
        content: { succeeded: 1 },
      },
    ];
    const first = await controller.evaluate({
      candidateText: "Imported three papers into the new collection.",
      canCorrect: true,
      toolExecutionRecords,
    });
    assert.equal(first.kind, "correct");
    if (first.kind === "correct")
      assert.include(first.correction, "literature_review");
    // discoveryImportRefusal (the host refusing the import before it runs)
    // guards imports, not this gate: after the correction, a second prose
    // answer is the model's choice and is accepted.
    const second = await controller.evaluate({
      candidateText: "Imported three papers into the new collection.",
      canCorrect: true,
      toolExecutionRecords,
    });
    assert.equal(second.kind, "accept");
  });

  it("accepts an explicit import: an answer-workflow search, then library_import", async function () {
    // "Find and import three papers" opens no discovery, so it completes
    // without a card.
    const context = makeContext();
    context.request.userText =
      "Find and import three papers on population coding.";
    const content = await answerSearch(context);
    assert.isFalse(content.reviewRequired);
    const controller = new AgentFinalAnswerController(context.request);
    const verdict = await controller.evaluate({
      candidateText: "Imported three papers.",
      canCorrect: true,
      toolExecutionRecords: [
        { name: "literature_search", ok: true, content },
        {
          name: "library_import",
          ok: true,
          input: validatedImportInput([
            "10.1000/candidate-2",
            "10.1000/candidate-5",
            "10.1000/candidate-7",
          ]),
          content: { succeeded: 3 },
        },
      ],
    });
    assert.equal(verdict.kind, "accept");
  });

  it("closes a discovery when its selection card is shown", async function () {
    const context = makeContext();
    const content = await search(context);
    const controller = new AgentFinalAnswerController(context.request);
    const verdict = await controller.evaluate({
      candidateText: "Choose the papers to import on the card.",
      canCorrect: true,
      toolExecutionRecords: [
        { name: "literature_search", ok: true, content },
        {
          name: "literature_review",
          ok: true,
          content: { reviewRequired: true, discoveryPhase: "review" },
        },
      ],
    });
    assert.equal(verdict.kind, "accept");
  });

  for (const [label, record] of [
    [
      "an import of papers outside the candidate set",
      {
        name: "library_import",
        ok: true,
        input: { kind: "identifiers", identifiers: ["10.9999/unrelated"] },
      },
    ],
    [
      "a failed import of a candidate",
      {
        name: "library_import",
        ok: false,
        input: { kind: "identifiers", identifiers: ["10.1000/candidate-2"] },
      },
    ],
    [
      "a non-identifier import",
      {
        name: "library_import",
        ok: true,
        input: { kind: "files", filePaths: ["/tmp/candidate-2.pdf"] },
      },
    ],
  ] as const) {
    it(`still requires the card after ${label}`, async function () {
      const context = makeContext();
      const content = await search(context);
      const controller = new AgentFinalAnswerController(context.request);
      const verdict = await controller.evaluate({
        candidateText: "Imported the papers.",
        canCorrect: true,
        toolExecutionRecords: [
          { name: "literature_search", ok: true, content },
          record,
        ],
      });
      assert.equal(verdict.kind, "correct");
    });
  }

  // arXiv-provider results carry only an abs URL; other providers carry a
  // DataCite 10.48550 DOI. Recognizing an import of a discovery's candidates
  // by these identities is covered in discoveryImportSelection.test.ts.
  describe("paper identity across providers", function () {
    const arxivCandidate = {
      title: "Arxiv Paper",
      sourceUrl: "http://arxiv.org/abs/2301.00001v1",
    };
    it("dedupes versions of one arXiv paper and keeps distinct ids apart", function () {
      const shares = (a: Record<string, unknown>, b: Record<string, unknown>) =>
        literaturePaperIdentities(a).some((key) =>
          literaturePaperIdentities(b).includes(key),
        );
      assert.isTrue(
        shares(arxivCandidate, {
          sourceUrl: "https://arxiv.org/abs/2301.00001v2",
        }),
      );
      assert.isTrue(
        shares(arxivCandidate, { doi: "10.48550/arXiv.2301.00001" }),
      );
      // A result with an arxivId and the same paper's abs-URL-only form.
      assert.isTrue(
        shares(
          {
            title: "Arxiv Paper",
            arxivId: "2301.00001",
            sourceUrl: "http://arxiv.org/abs/2301.00001v1",
          },
          { sourceUrl: "https://arxiv.org/abs/2301.00001v3" },
        ),
      );
      assert.isTrue(
        shares(
          { arxivId: "2301.00001" },
          { sourceUrl: "https://arxiv.org/abs/2301.00001v3" },
        ),
      );
      assert.isFalse(
        shares(arxivCandidate, {
          sourceUrl: "http://arxiv.org/abs/2301.00002v1",
        }),
      );
      assert.isFalse(
        shares({ doi: "10.48550/arXiv.2301.00001" }, { arxivId: "2301.00011" }),
      );
    });
  });
  // The model passes the number the user asked for; five when unspecified.
  for (const [text, requested, count] of [
    ["Find three relevant papers for me", 3, 3],
    ["Find five relevant papers for me", 5, 5],
    ["Find relevant papers for me", undefined, 5],
  ] as const) {
    it(`expands ${count} ranked choices from saved candidates and preserves selections${requested === undefined ? " when no count is given" : ""}`, async function () {
      const context = makeContext();
      context.request.userText = text;
      const candidates = await search(
        context,
        requested === undefined ? {} : { count: requested },
      );
      const tool = createLiteratureReviewTool(gateway as never);
      const review = async (indices: number[], extra = {}) => {
        const parsed = tool.validate({
          selections: indices.map((candidateIndex) => ({
            candidateSetId: candidates.candidateSetId,
            candidateIndex,
            reason: "Relevant retrieved evidence",
          })),
          ...extra,
        });
        if (!parsed.ok) throw new Error(parsed.error);
        const content = (await tool.execute(parsed.value, context)) as any;
        const result = resultOf("literature_review", content);
        const card = await tool.createResultReviewAction!(
          parsed.value,
          result,
          context,
        );
        return { input: parsed.value, content, result, card: card! };
      };
      const first = await review(
        Array.from({ length: count }, (_, i) => i + 1),
      );
      const list = first.card.fields[0];
      if (list.type !== "paper_result_list")
        throw new Error("Missing paper list");
      assert.equal(list.loadMoreActionId, "find_more");
      const selected = [list.rows[0].id];
      const more = await tool.resolveResultReview!(
        first.input,
        first.result,
        {
          approved: true,
          actionId: "find_more",
          data: { selectedPaperIds: selected },
        },
        context,
      );
      assert.equal(
        more.kind,
        "deliver",
        "expansion must resume research, never import",
      );
      if (more.kind !== "deliver") return;
      const continuation = more.toolMessageContent as any;
      assert.equal(continuation.batchSize, count);
      assert.equal(continuation.reviewRequired, true);
      const second = await review(
        Array.from({ length: count }, (_, i) => count + i + 1),
        {
          sessionId: continuation.sessionId,
          revision: continuation.revision,
        },
      );
      const expanded = second.card.fields[0];
      if (expanded.type !== "paper_result_list")
        throw new Error("Missing paper list");
      assert.lengthOf(expanded.rows, count * 2);
      assert.deepEqual(
        expanded.rows.slice(0, count).map((r) => r.id),
        list.rows.map((r) => r.id),
      );
      assert.isTrue(expanded.rows[0].checked);
      assert.isFalse(expanded.rows[1].checked);
      assert.isTrue(expanded.rows[count].checked);
      const imported = await tool.resolveResultReview!(
        second.input,
        second.result,
        {
          approved: true,
          actionId: "import",
          data: { selectedPaperIds: [expanded.rows[count].id] },
        },
        context,
      );
      assert.equal(imported.kind, "invoke_tool");
      if (imported.kind === "invoke_tool") {
        assert.equal(imported.call.name, "library_import");
        assert.deepInclude(imported.call.arguments, {
          identifiers: [`10.1000/candidate-${count + 1}`],
        });
      }
    });
  }

  /** An answer-workflow search saves candidates without opening a discovery. */
  async function answerSearch(context: AgentToolContext) {
    const tool = createLiteratureSearchTool(gateway as never);
    const input = tool.validate({
      ...OUTSIDE_NEED,
      mode: "search",
      workflow: "answer",
      query: "population coding",
      limit: 12,
    });
    if (!input.ok) throw new Error(input.error);
    return (await tool.execute(input.value, context)) as any;
  }
  function reviewInput(
    candidateSetId: string,
    indices: number[],
    extra: Record<string, unknown> = {},
  ) {
    const parsed = createLiteratureReviewTool(gateway as never).validate({
      selections: indices.map((candidateIndex) => ({
        candidateSetId,
        candidateIndex,
        reason: "Relevant retrieved evidence",
      })),
      ...extra,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }

  it("shows the count literature_review asks for when the search opened no discovery", async function () {
    const context = makeContext();
    context.request.userText = "Find three relevant papers for me";
    const candidates = await answerSearch(context);
    const tool = createLiteratureReviewTool(gateway as never);
    const content = (await tool.execute(
      reviewInput(candidates.candidateSetId, [1, 2, 3], { count: 3 }),
      context,
    )) as any;
    assert.equal(content.batchSize, 3);
    assert.lengthOf(content.results, 3);
    const card = await tool.createResultReviewAction!(
      reviewInput(candidates.candidateSetId, [1, 2, 3], { count: 3 }),
      resultOf("literature_review", content),
      context,
    );
    const list = card!.fields[0];
    if (list.type !== "paper_result_list")
      throw new Error("Missing paper list");
    assert.lengthOf(list.rows, 3);
  });

  it("asks for five papers when no count is given", async function () {
    const context = makeContext();
    const candidates = await answerSearch(context);
    let error = "";
    try {
      await createLiteratureReviewTool(gateway as never).execute(
        reviewInput(candidates.candidateSetId, [1, 2, 3]),
        context,
      );
    } catch (reason) {
      error = String(reason);
    }
    assert.include(error, "Review requires 5 new ranked papers, not 3");
  });

  it("lets literature_review set the count before the first batch is shown", async function () {
    const context = makeContext();
    const candidates = await search(context);
    const content = (await createLiteratureReviewTool(gateway as never).execute(
      reviewInput(candidates.candidateSetId, [1, 2, 3], { count: 3 }),
      context,
    )) as any;
    assert.equal(content.batchSize, 3);
    assert.lengthOf(content.results, 3);
  });

  it("keeps the first batch's size for Find more", async function () {
    const context = makeContext();
    const candidates = await search(context, { count: 3 });
    const tool = createLiteratureReviewTool(gateway as never);
    const firstInput = reviewInput(candidates.candidateSetId, [1, 2, 3]);
    const first = (await tool.execute(firstInput, context)) as any;
    const more = await tool.resolveResultReview!(
      firstInput,
      resultOf("literature_review", first),
      { approved: true, actionId: "find_more", data: {} },
      context,
    );
    if (more.kind !== "deliver") throw new Error("Did not continue discovery");
    const continuation = more.toolMessageContent as any;
    assert.equal(continuation.batchSize, 3);
    // Find more may search again; that search stays a find-paper search,
    // which states no reason (user decision 1a, 2026-10-20).
    assert.include(
      continuation.nextStep,
      "A further search uses workflow:'review'.",
    );
    assert.notInclude(continuation.nextStep, "must set need");
    assert.notInclude(continuation.nextStep, OUTSIDE_SEARCH_STOP_NOTE);
    let error = "";
    try {
      await tool.execute(
        reviewInput(candidates.candidateSetId, [4, 5, 6, 7, 8], {
          sessionId: continuation.sessionId,
          revision: continuation.revision,
          count: 5,
        }),
        context,
      );
    } catch (reason) {
      error = String(reason);
    }
    assert.include(error, "batches of 3 papers");
  });

  it("accepts a count of 1 to 25 papers on both discovery tools", function () {
    const search = createLiteratureSearchTool(gateway as never);
    const review = createLiteratureReviewTool(gateway as never);
    const searchArgs = {
      mode: "search",
      workflow: "review",
      query: "x",
      ...OUTSIDE_NEED,
    };
    const reviewArgs = {
      selections: [
        { candidateSetId: "trh_abc", candidateIndex: 1, reason: "Relevant" },
      ],
    };
    for (const count of [1, 3, 25]) {
      const parsedSearch = search.validate({ ...searchArgs, count });
      assert.isTrue(parsedSearch.ok, `search count ${count}`);
      if (parsedSearch.ok) assert.equal(parsedSearch.value.count, count);
      const parsedReview = review.validate({ ...reviewArgs, count });
      assert.isTrue(parsedReview.ok, `review count ${count}`);
      if (parsedReview.ok) assert.equal(parsedReview.value.count, count);
    }
    for (const count of [0, 26, 2.5, "3", -1]) {
      assert.isFalse(
        search.validate({ ...searchArgs, count }).ok,
        `search ${count}`,
      );
      assert.isFalse(
        review.validate({ ...reviewArgs, count }).ok,
        `review ${count}`,
      );
    }
  });

  it("keeps scholarly evidence search separate from discovery", async function () {
    const context = makeContext();
    context.request.userText =
      "What does recent research say about representational drift?";
    const tool = createLiteratureSearchTool(gateway as never);
    const parsed = tool.validate({
      ...OUTSIDE_NEED,
      mode: "search",
      workflow: "answer",
      query: "representational drift",
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const content = (await tool.execute(parsed.value, context)) as any;
    assert.isFalse(content.reviewRequired);
    assert.isUndefined(content.sessionId);
    assert.isNull(
      await tool.createResultReviewAction!(
        parsed.value,
        resultOf("literature_search", content),
        context,
      ),
    );
  });

  it("names the workflow an explicit import takes in the model-visible description", function () {
    // A workflow:'review' search opens a discovery whose papers import only
    // through the card, so an explicit import must know to take 'answer'.
    // The long-form guidance is never selected in chat; the description is
    // what the model reads.
    const description = createLiteratureSearchTool(gateway as never).spec
      .description;
    assert.include(description, "and explicit imports (then library_import)");
    // Every search that informs an answer takes workflow:'answer', named
    // for the question live evals sent to the card (2026-10-20).
    assert.include(
      description,
      "Use workflow:'answer' for any search that informs an answer, including whether other studies found or tested something",
    );
    // Only a request for papers themselves takes workflow:'review', which
    // leads to the card; answer results carry no card branch.
    assert.include(
      description,
      "Use workflow:'review' when the user asks for papers themselves (find, recommend, suggest or list papers; with nothing attached, only if the library holds no relevant papers or the user asks for papers outside it); it leads to the selection card (literature_review); discovery never imports silently.",
    );
    assert.notInclude(description, "For a find or recommend request");
    assert.notInclude(description, "to choose from");
  });

  it("offers a discovery only the selection card in its next step", async function () {
    // A workflow:'review' search opened a discovery: the host refuses a
    // direct import of its candidates, so the next step offers no import
    // branch, only the card.
    const content = await search();
    const nextStep = String(content.nextStep);
    assert.notInclude(nextStep, "library_import", nextStep);
    assert.notMatch(nextStep, /skip the selection card/, nextStep);
    assert.include(nextStep, "Call literature_review with sessionId");
    assert.include(nextStep, content.sessionId);
    assert.include(
      nextStep,
      "Never import during discovery. If the user asked for papers themselves and not for a list in chat, finish with the card, not prose; otherwise answer without it.",
    );
    assert.notInclude(nextStep, "finish with prose instead of the card");
    // A discovery ends with the card, not an answer: no stop note.
    assert.include(nextStep, "A further search uses workflow:'review'.");
    assert.notInclude(nextStep, OUTSIDE_SEARCH_STOP_NOTE);
  });

  it("routes an unclassified answer-workflow search by the user's request", async function () {
    // Without a discovery session the model still chooses between the
    // selection card and a direct import right after this result.
    const context = makeContext();
    const tool = createLiteratureSearchTool(gateway as never);
    const parsed = tool.validate({
      ...OUTSIDE_NEED,
      mode: "search",
      workflow: "answer",
      query: "hippocampal replay",
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const content = (await tool.execute(parsed.value, context)) as any;
    assert.isFalse(content.reviewRequired);
    const nextStep = String(content.nextStep);
    // Answering is the default; the import branch follows, only for the
    // request that names it, then the turn's ledger and the stop note. No
    // card branch: it rode on every evidence result and led evidence
    // questions to the card.
    assert.match(
      nextStep,
      /^Unless the user asked to import papers or only to find or recommend them, answer the user's question from these results as supporting evidence; the turn's own papers remain the primary source\. /,
      nextStep,
    );
    assert.match(nextStep, /If the user asked to import/);
    assert.isAtLeast(nextStep.indexOf("library_import"), 0, nextStep);
    assert.notInclude(nextStep, "literature_review", nextStep);
    assert.notInclude(nextStep, "Otherwise answer");
    assert.include(
      nextStep,
      ` Outside searches this turn: 1 scholarly (queries: hippocampal replay). ${OUTSIDE_SEARCH_STOP_NOTE}`,
    );
    assert.isTrue(nextStep.endsWith(` ${OUTSIDE_SEARCH_STOP_NOTE}`), nextStep);
  });

  it("closes a search whose candidates cannot be saved with the stop note alone", async function () {
    // Without a conversation the candidates get no handle, so neither the
    // card nor an import can name them; the result still ends with the note.
    const context = makeContext();
    context.request.conversationKey = 0;
    const content = await answerSearch(context);
    assert.isUndefined(content.candidateSetId);
    assert.isFalse(content.reviewRequired);
    assert.equal(
      content.nextStep,
      `Outside searches this turn: 1 scholarly (queries: population coding). ${OUTSIDE_SEARCH_STOP_NOTE}`,
    );
  });

  it("closes an answer-workflow search without results with the stop note", async function () {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    })) as typeof fetch;
    const content = await answerSearch(makeContext());
    assert.lengthOf(content.results, 0);
    assert.isTrue(
      String(content.nextStep).endsWith(OUTSIDE_SEARCH_STOP_NOTE),
      content.nextStep,
    );
  });
  it("offers no card route to a caller that cannot see literature_review", async function () {
    // MCP clients never see literature_review; the routing must not send
    // them there. They over-search too, so they get the stop note alone.
    const context = makeContext();
    context.isToolVisible = (spec) => spec.name !== "literature_review";
    const tool = createLiteratureSearchTool(gateway as never);
    const parsed = tool.validate({
      ...OUTSIDE_NEED,
      mode: "search",
      workflow: "answer",
      query: "hippocampal replay",
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const content = (await tool.execute(parsed.value, context)) as any;
    assert.isString(content.candidateSetId);
    assert.equal(
      content.nextStep,
      `Outside searches this turn: 1 scholarly (queries: hippocampal replay). ${OUTSIDE_SEARCH_STOP_NOTE}`,
    );
    assert.notMatch(content.nextStep, /literature_review|selection card/);
  });

  it("opens no discovery for a review-workflow search from a caller that cannot see literature_review", async function () {
    const context = makeContext();
    context.isToolVisible = (spec) => spec.name !== "literature_review";
    const tool = createLiteratureSearchTool(gateway as never);
    const parsed = tool.validate({
      ...OUTSIDE_NEED,
      mode: "search",
      workflow: "review",
      query: "hippocampal replay",
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const content = (await tool.execute(parsed.value, context)) as any;
    assert.isFalse(content.reviewRequired);
    assert.isUndefined(content.sessionId);
    assert.equal(
      content.nextStep,
      `Outside searches this turn: 1 scholarly (queries: hippocampal replay). ${OUTSIDE_SEARCH_STOP_NOTE}`,
    );
    assert.notMatch(
      JSON.stringify(content),
      /literature_review|selection card/,
    );
  });

  it("requires the current expansion even when an earlier card was presented", async function () {
    const controller = new AgentFinalAnswerController(makeContext().request);
    const decision = await controller.evaluate({
      candidateText: "Done",
      canCorrect: true,
      toolExecutionRecords: [
        {
          name: "literature_review",
          ok: true,
          content: {
            reviewRequired: true,
            discoveryPhase: "expanding",
            sessionId: "trh_active",
            revision: 1,
            batchSize: 5,
          },
        },
      ],
    });
    assert.equal(decision.kind, "correct");
  });
  it("never substitutes keyword matches for an unavailable reference list", async function () {
    const context = makeContext();
    context.request.userText = "Find five papers cited by this paper";
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls++;
      throw new Error("No keyword fallback allowed");
    }) as typeof fetch;
    const tool = createLiteratureSearchTool(gateway as never);
    const parsed = tool.validate({
      ...OUTSIDE_NEED,
      mode: "references",
      query: "A seed without a DOI",
      workflow: "review",
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const result = (await tool.execute(parsed.value, context)) as any;
    assert.isEmpty(result.results);
    assert.equal(networkCalls, 0);
    assert.include(result.message, "reference");
    assert.isTrue(result.reviewRequired);
  });

  for (const outcome of ["no_more", "search_failed"] as const) {
    it(`preserves the shortlist on ${outcome} and prevents stale or duplicate expansion`, async function () {
      const context = makeContext();
      const candidates = await search(context);
      const tool = createLiteratureReviewTool(gateway as never);
      const show = async (indices: number[], extra = {}) => {
        const parsed = tool.validate({
          selections: indices.map((candidateIndex) => ({
            candidateSetId: candidates.candidateSetId,
            candidateIndex,
            reason: "Retrieved evidence",
          })),
          ...extra,
        });
        if (!parsed.ok) throw new Error(parsed.error);
        const content = (await tool.execute(parsed.value, context)) as any;
        const result = resultOf("literature_review", content);
        return {
          input: parsed.value,
          content,
          result,
          card: (await tool.createResultReviewAction!(
            parsed.value,
            result,
            context,
          ))!,
        };
      };
      const first = await show([1, 2, 3, 4, 5]);
      const more = await tool.resolveResultReview!(
        first.input,
        first.result,
        {
          approved: true,
          actionId: "find_more",
          data: { selectedPaperIds: [] },
        },
        context,
      );
      if (more.kind !== "deliver") throw new Error("Did not resume research");
      const next = more.toolMessageContent as any;
      for (const args of [
        { sessionId: next.sessionId, revision: 0 },
        { sessionId: next.sessionId, revision: next.revision },
      ]) {
        let rejected = false;
        try {
          await show([1, 6, 7, 8, 9], args);
        } catch {
          rejected = true;
        }
        assert.isTrue(
          rejected,
          "stale revisions and previously displayed papers are rejected",
        );
      }
      const failed = await show([], {
        sessionId: next.sessionId,
        revision: next.revision,
        outcome,
        shortfallReason:
          outcome === "no_more"
            ? "No additional relevant matches found."
            : "Provider unavailable.",
      });
      const list = failed.card.fields[0];
      if (list.type !== "paper_result_list") throw new Error("No list");
      assert.lengthOf(list.rows, 5);
      assert.isTrue(list.rows.every((row) => row.checked === false));
      if (outcome === "no_more") assert.isUndefined(list.loadMoreActionId);
      else {
        assert.equal(list.loadMoreLabel, "Retry finding more");
        const retry = await tool.resolveResultReview!(
          failed.input,
          failed.result,
          { approved: true, actionId: "find_more" },
          context,
        );
        if (retry.kind !== "deliver") throw new Error("No retry");
        const retried = retry.toolMessageContent as any;
        const expanded = await show([6, 7, 8, 9, 10], {
          sessionId: retried.sessionId,
          revision: retried.revision,
        });
        assert.lengthOf(expanded.content.results, 10);
        const cancelled = await tool.resolveResultReview!(
          expanded.input,
          expanded.result,
          { approved: false, actionId: "cancel" },
          context,
        );
        assert.equal(cancelled.kind, "stop");
        let rejected = false;
        try {
          await tool.resolveResultReview!(
            expanded.input,
            expanded.result,
            { approved: true, actionId: "import" },
            context,
          );
        } catch {
          rejected = true;
        }
        assert.isTrue(rejected, "a closed card cannot import");
      }
    });
  }
  it("does not merge distinct identified papers just because they share a title", async function () {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 12 }, (_, i) => ({
          id: `https://openalex.org/W${i + 1}`,
          display_name: "Editorial",
          doi: `https://doi.org/10.1000/editorial-${i + 1}`,
          publication_year: 2024,
        })),
      }),
    })) as typeof fetch;
    const context = makeContext();
    const candidates = await search(context);
    const review = createLiteratureReviewTool(gateway as never);
    const parsed = review.validate({
      selections: [1, 2, 3, 4, 5].map((candidateIndex) => ({
        candidateSetId: candidates.candidateSetId,
        candidateIndex,
        reason: "Distinct publication with retrieved evidence",
      })),
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const content = (await review.execute(parsed.value, context)) as any;
    assert.lengthOf(content.results, 5);
  });
});
