import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { buildActionCallDigest } from "../src/agent/authorization/proposal";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { createAgentExecutionContext } from "../src/agent/execution/context";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { createDelegatingTool } from "../src/agent/tools/facade";
import { createLiteratureSearchTool } from "../src/agent/tools/read/literatureSearch";
import { createLiteratureReviewTool } from "../src/agent/tools/read/reviewLiterature";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { fail, ok } from "../src/agent/tools/shared";
import { createImportIdentifiersTool } from "../src/agent/tools/write/importIdentifiers";
import type {
  AgentToolContext,
  AgentToolResult,
  PreparedToolExecution,
  PreparedToolExecutionOptions,
} from "../src/agent/types";
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
      })) as unknown as typeof fetch;
      const gateway = {
        resolveMetadataItem: () => null,
        getEditableArticleMetadata: () => null,
        getCollectionSummary: () => null,
      };
      const search = createLiteratureSearchTool(gateway as never);
      const searchInput = search.validate({
        mode: "search",
        query: "discovery fixture",
        workflow: "answer",
        limit: 12,
        need: "not_in_scope_or_library",
        gap: "The library has no other papers on this topic.",
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
          // The model passes the number the user asked for.
          ...(batch === 0 ? { count: 3 } : {}),
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
        ) as HTMLInputElement[];
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
  it("refuses a discovery's direct import in every mode, then its card imports only the user's choice, while an explicit import runs directly", async function () {
    const native = Zotero as any;
    const api = native.LLMForZotero.api.workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Discovery import fixture",
      pages: ["Disposable discovery import fixture."],
    });
    const libraryID = Zotero.Items.get(fixture.parentItemId).libraryID;
    const stamp = Date.now();
    const doi = (index: number) => `10.1000/discovery-import-${stamp}-${index}`;
    const originalFetch = globalThis.fetch;
    const originalSearch = native.Translate.Search;
    const originalMode = getOriginalAgentPermissionMode();
    const translated: string[] = [];
    const importedItems = async () =>
      (await Zotero.Items.getAll(libraryID)).filter((item: Zotero.Item) =>
        String(item.getField("DOI") || "").startsWith(
          `10.1000/discovery-import-${stamp}-`,
        ),
      );
    try {
      await initAgentChangeJournal();
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          results: Array.from({ length: 12 }, (_, i) => ({
            id: `https://openalex.org/W${stamp}${i + 1}`,
            display_name: `Discovery import candidate ${i + 1}`,
            doi: `https://doi.org/${doi(i + 1)}`,
            publication_year: 2024,
          })),
        }),
      })) as unknown as typeof fetch;
      // Only the network translator is substituted; Zotero's own ItemSaver
      // saves what the import resolves.
      native.Translate.Search = class {
        private identifier: Record<string, string> = {};
        setIdentifier(identifier: Record<string, string>) {
          this.identifier = identifier;
        }
        async getTranslators() {
          return [{}];
        }
        setTranslator() {}
        async translate() {
          const DOI = this.identifier.DOI;
          translated.push(DOI);
          return [
            {
              itemType: "journalArticle",
              title: `Imported ${DOI}`,
              DOI,
              attachments: [],
            },
          ];
        }
      };
      // The production tools; the built-in registry module reaches skill
      // markdown, which workflow bundles cannot load, so library_import's
      // identifier route is composed the way that module composes it.
      const gateway = new ZoteroGateway();
      const registry = new AgentToolRegistry(
        new ActionContractService(gateway),
      );
      registry.register(createLiteratureSearchTool(gateway));
      registry.register(createLiteratureReviewTool(gateway));
      const importIdentifiers = createImportIdentifiersTool(gateway);
      registry.register(
        createDelegatingTool({
          name: "library_import",
          label: "Import to Library",
          description: "Add items to Zotero by identifier.",
          executionClass: "external_effect",
          workCategory: "zotero_action",
          inputSchema: {
            type: "object",
            required: ["kind"],
            properties: { kind: { type: "string", enum: ["identifiers"] } },
          },
          delegates: [importIdentifiers],
          chooseDelegate(args) {
            const { kind, ...delegateArgs } = (args || {}) as Record<
              string,
              unknown
            >;
            return kind === "identifiers"
              ? ok({ tool: importIdentifiers, args: delegateArgs })
              : fail("kind must be identifiers");
          },
        }),
      );
      const turn = (runId: string, userText: string): AgentToolContext => {
        const request = resolvedAgentRequest({
          conversationKey: fixture.parentItemId,
          activeItemId: fixture.parentItemId,
          libraryID,
          mode: "agent",
          userText,
        });
        request.executionContext = createAgentExecutionContext(request, runId);
        return {
          request,
          runId,
          resourceSignature: `paper-${fixture.parentItemId}`,
          item: Zotero.Items.get(fixture.parentItemId),
          currentAnswerText: "",
          modelName: "workflow",
        };
      };
      let calls = 0;
      const prepare = (
        context: AgentToolContext,
        name: string,
        args: Record<string, unknown>,
        options: PreparedToolExecutionOptions = { callerKind: "model" },
      ): Promise<PreparedToolExecution> =>
        registry.prepareExecution(
          { id: `${name}-${++calls}`, name, arguments: args },
          context,
          options,
        );
      const run = async (
        context: AgentToolContext,
        name: string,
        args: Record<string, unknown>,
        options?: PreparedToolExecutionOptions,
      ): Promise<AgentToolResult> => {
        let prepared = await prepare(context, name, args, options);
        if (prepared.kind === "confirmation")
          prepared = await prepared.execute({ approved: true });
        if (prepared.kind !== "result")
          throw new Error(`${name} never reached a result`);
        return prepared.execution.result;
      };

      // A request that only asks to find papers opens a discovery.
      const discovery = turn(
        `discovery-import-${stamp}`,
        "Find three papers relevant to this paper for me.",
      );
      // A find-paper search states no reason (user decision 1a).
      const search = await run(discovery, "literature_search", {
        mode: "search",
        workflow: "review",
        query: "discovery import fixture",
        limit: 12,
      });
      const found = search.content as {
        candidateSetId: string;
        sessionId: string;
        revision: number;
      };
      assert.isString(found.sessionId, JSON.stringify(search.content));

      // Importing its candidates directly is refused before anything runs,
      // in Safe, Auto and YOLO alike.
      for (const mode of ["safe", "auto", "yolo"] as const) {
        setOriginalAgentPermissionMode(mode);
        const refused = await prepare(discovery, "library_import", {
          kind: "identifiers",
          identifiers: [doi(2), doi(5)],
          libraryID,
        });
        assert.equal(refused.kind, "result", `${mode}: no confirmation card`);
        if (refused.kind !== "result") continue;
        const result = refused.execution.result;
        assert.isTrue(
          result.inputRejected,
          `${mode}: ${JSON.stringify(result)}`,
        );
        assert.include(
          String((result.content as { error?: unknown }).error),
          `literature_review with sessionId '${found.sessionId}'`,
        );
      }
      assert.deepEqual(translated, [], "no refused identifier was resolved");
      assert.lengthOf(await importedItems(), 0);

      // The model shows the card instead, and the user chooses.
      setOriginalAgentPermissionMode("auto");
      const reviewArgs = {
        sessionId: found.sessionId,
        revision: found.revision,
        count: 3,
        selections: [3, 1, 4].map((candidateIndex) => ({
          candidateSetId: found.candidateSetId,
          candidateIndex,
          reason: "Shares the measured population coding method.",
        })),
      };
      const reviewed = await run(discovery, "literature_review", reviewArgs);
      assert.isTrue(reviewed.ok, JSON.stringify(reviewed.content));
      const review = registry.getTool("literature_review")!;
      const parsed = review.validate(reviewArgs);
      if (!parsed.ok) throw new Error(parsed.error);
      const action = (await review.createResultReviewAction!(
        parsed.value,
        reviewed,
        discovery,
      ))!;
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const requestId = `discovery-import-card-${stamp}`;
      const waiting = api.renderPendingActionForPanel(panel.panelId, {
        requestId,
        action,
      });
      const card = Zotero.getMainWindow().document.querySelector<HTMLElement>(
        `[data-request-id="${requestId}"]`,
      )!;
      assert.exists(card, "the paper selection card appears");
      const rows = Array.from(
        card.querySelectorAll<HTMLInputElement>(
          ".llm-search-results-list input[type=checkbox]",
        ),
      ) as HTMLInputElement[];
      assert.lengthOf(rows, 3);
      assert.isTrue(rows.every((row) => row.checked));
      rows[1].click();
      const importButton = card.querySelector<HTMLButtonElement>(
        '[data-action-id="import"]',
      )!;
      assert.equal(importButton.textContent, "Import 2 papers");
      importButton.click();
      const resolution = await waiting;
      assert.equal(resolution.actionId, "import");
      const outcome = await review.resolveResultReview!(
        parsed.value,
        reviewed,
        resolution,
        discovery,
      );
      if (outcome.kind !== "invoke_tool")
        throw new Error("The card's Import did not invoke library_import");
      // The runtime runs the card's import under the approval it mints for
      // that exact call.
      const imported = await run(
        discovery,
        outcome.call.name,
        outcome.call.arguments as Record<string, unknown>,
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
      assert.isTrue(imported.ok, JSON.stringify(imported.content));
      assert.deepEqual(translated, [doi(3), doi(4)]);
      assert.sameMembers(
        (await importedItems()).map((item: Zotero.Item) =>
          String(item.getField("DOI")),
        ),
        [doi(3), doi(4)],
        "only the papers the user kept checked are in the library",
      );

      // "Find and import" opens no discovery: its import runs directly.
      const explicit = turn(
        `explicit-import-${stamp}`,
        "Find and import two papers relevant to this paper.",
      );
      const answer = await run(explicit, "literature_search", {
        mode: "search",
        workflow: "answer",
        query: "discovery import fixture",
        limit: 12,
        need: "not_in_scope_or_library",
        gap: "The library has no other papers on this topic.",
      });
      assert.isFalse(
        (answer.content as { reviewRequired?: boolean }).reviewRequired,
      );
      const direct = await run(explicit, "library_import", {
        kind: "identifiers",
        identifiers: [doi(7), doi(9)],
        libraryID,
      });
      assert.notOk(direct.inputRejected, JSON.stringify(direct.content));
      assert.isTrue(direct.ok, JSON.stringify(direct.content));
      assert.deepEqual(translated, [doi(3), doi(4), doi(7), doi(9)]);

      // A literature review's card asks to import and cite or to cite
      // without importing; Cite without importing imports nothing.
      const reviewTurn = turn(
        `review-cite-${stamp}`,
        "Write a literature review on this topic.",
      );
      const reviewSearch = await run(reviewTurn, "literature_search", {
        mode: "search",
        workflow: "review",
        forLiteratureReview: true,
        query: "discovery import fixture",
        limit: 12,
      });
      const reviewFound = reviewSearch.content as {
        candidateSetId: string;
        sessionId: string;
        revision: number;
      };
      const citeArgs = {
        sessionId: reviewFound.sessionId,
        revision: reviewFound.revision,
        count: 3,
        selections: [2, 6, 8].map((candidateIndex) => ({
          candidateSetId: reviewFound.candidateSetId,
          candidateIndex,
          reason: "Shares the measured population coding method.",
        })),
      };
      const citeReviewed = await run(reviewTurn, "literature_review", citeArgs);
      assert.isTrue(citeReviewed.ok, JSON.stringify(citeReviewed.content));
      const citeParsed = review.validate(citeArgs);
      if (!citeParsed.ok) throw new Error(citeParsed.error);
      const citeAction = (await review.createResultReviewAction!(
        citeParsed.value,
        citeReviewed,
        reviewTurn,
      ))!;
      const citeRequestId = `review-cite-card-${stamp}`;
      const citeWaiting = api.renderPendingActionForPanel(panel.panelId, {
        requestId: citeRequestId,
        action: citeAction,
      });
      const citeCard =
        Zotero.getMainWindow().document.querySelector<HTMLElement>(
          `[data-request-id="${citeRequestId}"]`,
        )!;
      assert.exists(citeCard, "the review's selection card appears");
      assert.notExists(
        citeCard.querySelector('[data-kind="alternatives"]'),
        "both choices are visible, none under Alternatives",
      );
      const citeRows = Array.from(
        citeCard.querySelectorAll<HTMLInputElement>(
          ".llm-search-results-list input[type=checkbox]",
        ),
      ) as HTMLInputElement[];
      assert.lengthOf(citeRows, 3);
      citeRows[0].click();
      const citeButton = citeCard.querySelector<HTMLButtonElement>(
        '[data-action-id="cite"]',
      )!;
      const importAndCite =
        citeCard.querySelector<HTMLButtonElement>('[data-kind="save"]')!;
      assert.equal(citeButton.textContent, "Cite 2 without importing");
      assert.equal(importAndCite.textContent, "Import and cite 2 papers");
      citeButton.click();
      const citeResolution = await citeWaiting;
      assert.equal(citeResolution.actionId, "cite");
      const citeOutcome = await review.resolveResultReview!(
        citeParsed.value,
        citeReviewed,
        citeResolution,
        reviewTurn,
      );
      assert.equal(citeOutcome.kind, "deliver");
      assert.lengthOf(reviewTurn.request.outsidePaperSelection || [], 2);
      assert.deepEqual(
        translated,
        [doi(3), doi(4), doi(7), doi(9)],
        "Cite without importing imports nothing",
      );
    } finally {
      globalThis.fetch = originalFetch;
      native.Translate.Search = originalSearch;
      setOriginalAgentPermissionMode(originalMode);
      for (const item of await importedItems()) await item.eraseTx();
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
    const search = agent.getToolDefinition("literature_search")!;
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
    let cleanupRoot: HTMLElement | null = null;
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const root = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      )!;
      assert.exists(root, "workflow panel root");
      cleanupRoot = root;
      const libraryID = Zotero.Items.get(fixture.parentItemId).libraryID;
      const before = (await Zotero.Items.getAll(libraryID))
        .map((item) => item.id)
        .sort();
      for (const limit of [20, 3]) {
        searches.length = 0;
        const input = root.querySelector<HTMLTextAreaElement>("#llm-input")!;
        let structuredRun: Promise<unknown> | undefined;
        if (limit === 20) {
          input.value = "/discover_related";
          input.dispatchEvent(
            new doc.defaultView!.Event("input", { bubbles: true }),
          );
          root.querySelector<HTMLButtonElement>("#llm-send")!.click();
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
                root
                  .querySelector(`[data-request-id="${requestId}"]`)
                  ?.remove();
                return resolution;
              },
            },
          );
        }
        const card = await waitFor(
          () =>
            root
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
          (
            Array.from(
              card.querySelectorAll(".llm-search-mode-tab"),
            ) as Element[]
          ).map((tab) => tab.textContent),
          ["Recommendations", "References", "Citations"],
        );
        const rows = () =>
          Array.from(
            card.querySelectorAll<HTMLInputElement>(
              ".llm-search-results-list input[type=checkbox]",
            ),
          ) as HTMLInputElement[];
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
          const next = root
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
          ) as HTMLInputElement[];
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
          () => (!root.querySelector(".llm-search-mode-tabs") ? true : null),
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
      cleanupRoot
        ?.querySelector<HTMLButtonElement>('[data-kind="cancel"]')
        ?.click();
      agent.registerTool(search);
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
