import {
  classifiedFixture,
  semanticFixture,
} from "../test/helpers/semanticIntent";
import { assert } from "chai";
import { createSearchLiteratureOnlineTool } from "../src/agent/tools/read/searchLiteratureOnline";
import { createLiteratureReviewTool } from "../src/agent/tools/read/reviewLiterature";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";

describe("workflow: expandable ranked discovery", function () {
  this.timeout(60000);
  it("expands twice in the native paper card, preserves unchecked rows, and never imports on Find more", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Expandable discovery fixture",
      pages: ["Disposable discovery fixture."],
    });
    const originalFetch = globalThis.fetch;
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const context: AgentToolContext = {
        request: resolvedAgentRequest({
          conversationKey: fixture.parentItemId,
          activeItemId: fixture.parentItemId,
          libraryID: Zotero.Items.get(fixture.parentItemId).libraryID,
          mode: "agent",
          userText:
            "Find three relevant papers and let me review before importing",
          classifiedIntent: classifiedFixture({
            externalSearchIntent: "literature",
            semantic: semanticFixture({
              literature: "select_then_import",
              requestedCount: 3,
            }),
          }),
        }),
        runId: `discovery-workflow-${fixture.parentItemId}`,
        resourceSignature: `paper-${fixture.parentItemId}`,
        item: Zotero.Items.get(fixture.parentItemId),
        currentAnswerText: "",
        modelName: "workflow",
      };
      const before = (await Zotero.Items.getAll(context.request.libraryID!))
        .map((item) => item.id)
        .sort();
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          results: Array.from({ length: 12 }, (_, i) => ({
            id: `https://openalex.org/W${i + 1}`,
            display_name: `Discovery candidate ${i + 1}`,
            doi: `https://doi.org/10.1000/discovery-${i + 1}`,
            publication_year: 2024,
          })),
        }),
      })) as typeof fetch;
      const gateway = {
        resolveMetadataItem: () => null,
        getEditableArticleMetadata: () => null,
        getCollectionSummary: () => null,
      };
      const search = createSearchLiteratureOnlineTool(gateway as never);
      const searchInput = search.validate({
        mode: "search",
        query: "discovery fixture",
        workflow: "answer",
        limit: 12,
      });
      if (!searchInput.ok) throw new Error(searchInput.error);
      const candidates = (await search.execute(
        searchInput.value,
        context,
      )) as any;
      const review = createLiteratureReviewTool(gateway as never);
      let continuation: { sessionId?: string; revision?: number } = {};
      for (let batch = 0; batch < 3; batch++) {
        const parsed = review.validate({
          ...continuation,
          selections: [1, 2, 3].map((i) => ({
            candidateSetId: candidates.candidateSetId,
            candidateIndex: batch * 3 + i,
            reason: "Shares the measured population coding method.",
          })),
        });
        if (!parsed.ok) throw new Error(parsed.error);
        const content = await review.execute(parsed.value, context);
        const result: AgentToolResult = {
          name: "literature_review",
          callId: `review-${batch}`,
          ok: true,
          actionReceipts: [],
          content,
        };
        const action = (await review.createResultReviewAction!(
          parsed.value,
          result,
          context,
        ))!;
        const requestId = `expandable-discovery-${batch}`;
        const waiting = api.renderPendingActionForPanel(panel.panelId, {
          requestId,
          action,
        });
        const card = doc.querySelector<HTMLElement>(
          `[data-request-id="${requestId}"]`,
        )!;
        const rows = Array.from(
          card.querySelectorAll<HTMLInputElement>(
            ".llm-search-results-list input[type=checkbox]",
          ),
        );
        assert.lengthOf(rows, (batch + 1) * 3);
        if (batch === 0) rows[0].click();
        else
          assert.isFalse(
            rows[0].checked,
            "an unchecked paper stays unchecked across expansion",
          );
        const more = card.querySelector<HTMLButtonElement>(
          ".llm-search-load-more-btn",
        )!;
        assert.equal(more.textContent, "Find 3 more");
        assert.isAbove(more.getBoundingClientRect().width, 0);
        if (batch < 2) more.click();
        else
          card
            .querySelector<HTMLButtonElement>('[data-kind="cancel"]')!
            .click();
        const resolution = await waiting;
        assert.equal(resolution.actionId, batch < 2 ? "find_more" : "cancel");
        const outcome = await review.resolveResultReview!(
          parsed.value,
          result,
          resolution,
          context,
        );
        if (batch < 2) {
          assert.equal(outcome.kind, "deliver");
          if (outcome.kind !== "deliver")
            throw new Error("Did not continue discovery");
          continuation = outcome.toolMessageContent as typeof continuation;
        } else assert.equal(outcome.kind, "stop");
      }
      assert.deepEqual(
        (await Zotero.Items.getAll(context.request.libraryID!))
          .map((item) => item.id)
          .sort(),
        before,
        "discovery does not create library items",
      );
    } finally {
      globalThis.fetch = originalFetch;
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
  it("runs the empty slash shortcut and structured custom limit with three tabs and preserved selections on Load more", async function () {
    const addonApi = (Zotero as any).LLMForZotero.api;
    const api = addonApi.workflowTest as WorkflowTestApi;
    const agent = addonApi.agent as ReturnType<
      typeof import("../src/agent").getAgentApi
    >;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Discovery command fixture",
      pages: ["Disposable discovery command fixture."],
    });
    const search = agent.getToolDefinition("search_literature_online")!;
    assert.exists(search);
    const searches: Array<{ mode: string; limit: number }> = [];
    agent.registerTool({
      ...search,
      execute: async (input: any) => {
        searches.push({ mode: input.mode, limit: input.limit });
        return {
          results: Array.from({ length: input.limit }, (_, i) => ({
            title: `${input.mode} candidate ${i + 1}`,
            doi: `10.1000/${input.mode}-${i + 1}`,
            year: 2024,
          })),
        };
      },
    });
    const doc = Zotero.getMainWindow().document;
    const waitFor = async <T>(
      read: () => T | null,
      description: string,
    ): Promise<T> => {
      for (let i = 0; i < 200; i++) {
        const value = read();
        if (value) return value;
        await Zotero.Promise.delay(25);
      }
      throw new Error(`Timed out waiting for ${description}`);
    };
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const libraryID = Zotero.Items.get(fixture.parentItemId).libraryID;
      const before = (await Zotero.Items.getAll(libraryID))
        .map((item) => item.id)
        .sort();
      for (const limit of [20, 3]) {
        searches.length = 0;
        const input = doc.querySelector<HTMLTextAreaElement>("#llm-input")!;
        let structuredRun: Promise<unknown> | undefined;
        if (limit === 20) {
          input.value = "/discover_related";
          input.dispatchEvent(
            new doc.defaultView!.Event("input", { bubbles: true }),
          );
          doc.querySelector<HTMLButtonElement>("#llm-send")!.click();
        } else {
          structuredRun = agent.runAction(
            "discover_related",
            { limit, scope: "current" },
            {
              libraryID,
              conversationKey: fixture.parentItemId,
              requestContext: { activeItemId: fixture.parentItemId },
              confirmationMode: "native_ui",
              requestConfirmation: async (requestId, action) => {
                const resolution = await api.renderPendingActionForPanel(
                  panel.panelId,
                  { requestId, action },
                );
                doc.querySelector(`[data-request-id="${requestId}"]`)?.remove();
                return resolution;
              },
            },
          );
        }
        const card = await waitFor(
          () =>
            doc
              .querySelector<HTMLElement>(".llm-search-mode-tabs")
              ?.closest<HTMLElement>("[data-request-id]") || null,
          "direct discovery card",
        );
        assert.notInclude(input.value, "papers relevant to");
        assert.deepEqual(searches.map((entry) => entry.mode).sort(), [
          "citations",
          "recommendations",
          "references",
        ]);
        assert.isTrue(searches.every((entry) => entry.limit === limit));
        assert.deepEqual(
          Array.from(card.querySelectorAll(".llm-search-mode-tab")).map(
            (tab) => tab.textContent,
          ),
          ["Recommendations", "References", "Citations"],
        );
        const rows = () =>
          Array.from(
            card.querySelectorAll<HTMLInputElement>(
              ".llm-search-results-list input[type=checkbox]",
            ),
          );
        assert.lengthOf(rows(), limit);
        assert.isTrue(rows().every((row) => row.checked));
        rows()[0].click();
        card
          .querySelector<HTMLButtonElement>('[data-mode-id="references"]')!
          .click();
        assert.isTrue(rows().every((row) => !row.checked));
        rows()[0].click();
        const more = card.querySelector<HTMLButtonElement>(
          ".llm-search-load-more-btn",
        )!;
        assert.equal(more.textContent, "Load more");
        more.click();
        const expanded = await waitFor(() => {
          const next = doc
            .querySelector<HTMLElement>(".llm-search-mode-tabs")
            ?.closest<HTMLElement>("[data-request-id]");
          return next &&
            next.querySelectorAll(
              ".llm-search-results-list input[type=checkbox]",
            ).length ===
              limit + 20
            ? next
            : null;
        }, `expanded discovery card at limit ${limit}`);
        assert.equal(
          expanded.querySelector(".llm-search-mode-tab-active")?.textContent,
          "References",
        );
        const expandedRows = () =>
          Array.from(
            expanded.querySelectorAll<HTMLInputElement>(
              ".llm-search-results-list input[type=checkbox]",
            ),
          );
        assert.lengthOf(expandedRows(), limit + 20);
        assert.isTrue(expandedRows()[0].checked);
        assert.isTrue(
          expandedRows()
            .slice(1)
            .every((row) => !row.checked),
        );
        expanded
          .querySelector<HTMLButtonElement>('[data-mode-id="recommendations"]')!
          .click();
        assert.isFalse(expandedRows()[0].checked);
        assert.isTrue(
          expandedRows()
            .slice(1, limit)
            .every((row) => row.checked),
        );
        assert.isTrue(
          expandedRows()
            .slice(limit)
            .every((row) => !row.checked),
        );
        assert.isTrue(
          searches.slice(3).every((entry) => entry.limit === limit + 20),
        );
        expanded
          .querySelector<HTMLButtonElement>('[data-kind="cancel"]')!
          .click();
        await waitFor(
          () => (!doc.querySelector(".llm-search-mode-tabs") ? true : null),
          "cancel to close discovery",
        );
        await structuredRun;
      }
      assert.deepEqual(
        (await Zotero.Items.getAll(libraryID)).map((item) => item.id).sort(),
        before,
        "Load more and Cancel must not import papers",
      );
    } finally {
      doc.querySelector<HTMLButtonElement>('[data-kind="cancel"]')?.click();
      agent.registerTool(search);
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
