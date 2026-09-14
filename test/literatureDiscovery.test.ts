import { classifiedFixture, semanticFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { createSearchLiteratureOnlineTool } from "../src/agent/tools/read/searchLiteratureOnline";
import { createLiteratureReviewTool } from "../src/agent/tools/read/reviewLiterature";
import { clearAgentToolResultHandleStore } from "../src/agent/store/toolResultHandles";
import { AgentFinalAnswerController } from "../src/agent/finalization/finalAnswerController";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";

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
  const makeContext = (mode = "auto"): AgentToolContext => ({
    request: resolvedAgentRequest({
      conversationKey: 9901,
      libraryID: 1,
      mode: "agent",
      userText: "Find five papers relevant to the current paper.",
      metadata: { permissionMode: mode },
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

  async function search(context = makeContext()) {
    const tool = createSearchLiteratureOnlineTool(gateway as never);
    const input = tool.validate({
      mode: "search",
      workflow: "review",
      query: "population coding",
      limit: 12,
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

  for (const mode of ["safe", "auto", "yolo"]) {
    it(`preserves requested user selection before import in ${mode}`, async function () {
      const context = makeContext(mode);
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

    it(`lets the agent rank twelve candidates into five paper-only choices in ${mode}`, async function () {
      const context = makeContext(mode);
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
  }

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

  it("does not accept prose as completed discovery while a shortlist review is still required", async function () {
    const context = makeContext();
    const content = await search(context);
    const controller = new AgentFinalAnswerController(
      context.request,
      { evaluateFinal: async () => ({ kind: "accept" }) },
      [],
    );
    const first = await controller.evaluate({
      candidateText: "Here are some papers.",
      canCorrect: true,
      toolExecutionRecords: [{ name: "literature_search", ok: true, content }],
    });
    assert.equal(first.kind, "correct");
    if (first.kind === "correct")
      assert.include(first.correction, "literature_review");
    const second = await controller.evaluate({
      candidateText: "Here are some papers.",
      canCorrect: true,
      toolExecutionRecords: [{ name: "literature_search", ok: true, content }],
    });
    assert.equal(second.kind, "fail");
  });

  for (const [text, count] of [
    ["Find relevant papers for me", 5],
    ["Find three relevant papers for me", 3],
  ] as const) {
    it(`expands ${count} ranked choices from saved candidates and preserves selections`, async function () {
      const context = makeContext();
      context.request.userText = text;
      context.request.classifiedIntent = classifiedFixture({
        semantic: semanticFixture({
          literature: "discover",
          requestedCount: count,
        }),
      });
      const candidates = await search(context);
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

  it("keeps scholarly evidence search separate from discovery", async function () {
    const context = makeContext();
    context.request.userText =
      "What does recent research say about representational drift?";
    const tool = createSearchLiteratureOnlineTool(gateway as never);
    const parsed = tool.validate({
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

  it("requires the current expansion even when an earlier card was presented", async function () {
    const controller = new AgentFinalAnswerController(
      makeContext().request,
      { evaluateFinal: async () => ({ kind: "accept" }) },
      [],
    );
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
    context.request.classifiedIntent = classifiedFixture({
      externalSearchIntent: "literature",
      semantic: semanticFixture({
        literature: "discover",
        literatureMode: "references",
        requestedCount: 5,
      }),
    });
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls++;
      throw new Error("No keyword fallback allowed");
    }) as typeof fetch;
    const tool = createSearchLiteratureOnlineTool(gateway as never);
    const parsed = tool.validate({
      mode: "references",
      query: "A seed without a DOI",
      workflow: "answer",
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
