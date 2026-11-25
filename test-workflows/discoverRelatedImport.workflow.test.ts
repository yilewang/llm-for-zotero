import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { discoverRelatedAction } from "../src/agent/actions/discoverRelated";
import type { ActionExecutionContext } from "../src/agent/actions";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { createDelegatingTool } from "../src/agent/tools/facade";
import { createLibraryReadTool } from "../src/agent/tools/read/libraryRead";
import { createLiteratureSearchTool } from "../src/agent/tools/read/literatureSearch";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { fail, ok } from "../src/agent/tools/shared";
import { createImportIdentifiersTool } from "../src/agent/tools/write/importIdentifiers";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: discover related papers card", function () {
  this.timeout(90000);
  it("imports the papers checked across its tabs when the user clicks Import selected", async function () {
    const native = Zotero as any;
    const api = native.LLMForZotero.api.workflowTest as WorkflowTestApi;
    const stamp = Date.now();
    const doi = (id: string) => `10.1000/related-import-${stamp}-${id}`;
    const work = (id: string) => ({
      id: `https://openalex.org/${id}`,
      display_name: `Related import candidate ${id}`,
      doi: `https://doi.org/${doi(id)}`,
      publication_year: 2024,
      cited_by_count: 3,
    });
    const seed = new Zotero.Item("journalArticle");
    seed.libraryID = Zotero.Libraries.userLibraryID;
    seed.setField("title", "Related import seed fixture");
    seed.setField("DOI", doi("seed"));
    await seed.saveTx();
    const libraryID = seed.libraryID;
    const importedItems = async () =>
      (await Zotero.Items.getAll(libraryID)).filter((item: Zotero.Item) =>
        String(item.getField("DOI") || "").startsWith(
          `10.1000/related-import-${stamp}-W`,
        ),
      );
    const originalFetch = globalThis.fetch;
    const originalSearch = native.Translate.Search;
    const translated: string[] = [];
    const panel = await api.renderPanelForItem(seed.id);
    try {
      await initAgentChangeJournal();
      // OpenAlex: the seed work, its related and referenced works, and the
      // works that cite it.
      globalThis.fetch = (async (input: string) => {
        const url = decodeURIComponent(String(input));
        let body: unknown;
        if (url.includes("/works/https://doi.org/"))
          body = {
            ...work("W1"),
            related_works: ["W11", "W12", "W13"].map(
              (id) => `https://openalex.org/${id}`,
            ),
            referenced_works: ["W21"].map((id) => `https://openalex.org/${id}`),
          };
        else if (url.includes("filter=cites:"))
          body = { results: ["W31", "W32"].map(work) };
        else if (url.includes("filter=openalex:")) {
          const ids = /openalex:([^&]+)/.exec(url)![1].split("|");
          body = { results: ids.map(work) };
        } else body = { results: [] };
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }) as unknown as typeof fetch;
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
      // The production tools, composed the way the built-in registry
      // composes them (its module reaches skill markdown, which workflow
      // bundles cannot load).
      const gateway = new ZoteroGateway();
      const registry = new AgentToolRegistry(
        new ActionContractService(gateway),
      );
      registry.register(createLibraryReadTool(gateway));
      registry.register(createLiteratureSearchTool(gateway));
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

      let cards = 0;
      const events: unknown[] = [];
      // The slash action from the paper panel, as the action runner starts it.
      const ctx: ActionExecutionContext = {
        registry,
        conversationKey: seed.id,
        zoteroGateway: gateway,
        libraryID,
        confirmationMode: "native_ui",
        onProgress: (event) => events.push(event),
        requestContext: {
          mode: "paper",
          activeItemId: seed.id,
          actionEntryPoint: "action_ui",
        } as ActionExecutionContext["requestContext"],
        requestConfirmation: async (requestId, action) => {
          cards++;
          const waiting = api.renderPendingActionForPanel(panel.panelId, {
            requestId,
            action,
          });
          const card = Zotero.getMainWindow().document.querySelector(
            `[data-request-id="${requestId}"]`,
          )!;
          assert.exists(card, "the related papers card appears");
          const rows = () =>
            Array.from(
              card.querySelectorAll<HTMLInputElement>(
                ".llm-search-results-list input.llm-search-results-checkbox",
              ),
            ) as HTMLInputElement[];
          // Start from nothing, then keep one recommendation and one citing
          // paper, as a user picking papers would.
          const selectAll = card.querySelector<HTMLInputElement>(
            ".llm-search-select-all-checkbox",
          )!;
          if (selectAll.checked) selectAll.click();
          assert.isTrue(rows().every((row) => !row.checked));
          rows()[1].click();
          const citationsTab = (
            Array.from(
              card.querySelectorAll(".llm-search-mode-tab"),
            ) as HTMLButtonElement[]
          ).find((tab) => tab.textContent?.trim() === "Citations")!;
          citationsTab.click();
          rows()[0].click();
          const importButton = card.querySelector<HTMLButtonElement>(
            '[data-action-id="import"]',
          )!;
          assert.isFalse(importButton.disabled);
          importButton.click();
          return waiting;
        },
      };
      const result = await discoverRelatedAction.execute(
        { itemId: seed.id },
        ctx,
      );

      assert.equal(cards, 1, JSON.stringify({ result, events }));
      assert.sameMembers(
        (await importedItems()).map((item: Zotero.Item) =>
          String(item.getField("DOI")),
        ),
        [doi("W12"), doi("W31")],
        `only the two checked papers are in the library: ${JSON.stringify({ result, events, translated })}`,
      );
      assert.isTrue(result.ok, JSON.stringify(result));
      assert.equal(
        result.output?.imported,
        2,
        "the summary counts the papers that reached Zotero",
      );
      assert.deepInclude(
        events,
        {
          type: "step_done",
          step: "Reviewing and importing papers",
          summary: "Imported 2 papers",
        },
        "the card's progress line reports the imported papers",
      );
    } finally {
      globalThis.fetch = originalFetch;
      native.Translate.Search = originalSearch;
      for (const item of await importedItems()) await item.eraseTx();
      await api.reset();
      await seed.eraseTx();
    }
  });
});
