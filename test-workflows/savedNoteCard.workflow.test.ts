import {
  semanticContractFixture,
  classifiedFixture,
  semanticResponseFixture,
} from "../test/helpers/semanticIntent";
import { assert } from "chai";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import type { AgentActionContract, AgentToolContext } from "../src/agent/types";

describe("workflow: create then show saved note", function () {
  this.timeout(60000);
  afterEach(function () {
    assert.lengthOf(
      Zotero.getMainWindow().document.querySelectorAll(
        '[data-llm-workflow-test="true"]',
      ),
      0,
      "saved-note tests must not leave panel hosts for later workflows",
    );
  });
  for (const mode of ["safe", "auto", "yolo"] as const) {
    it(`creates without confirmation in ${mode}, shows native content, and opens the exact note`, async function () {
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      const originalMode = getOriginalAgentPermissionMode();
      const parent = new Zotero.Item("journalArticle");
      parent.libraryID = Zotero.Libraries.userLibraryID;
      parent.setField("title", `Saved note destination ${mode}`);
      await parent.saveTx();
      let root: HTMLElement | null = null;
      try {
        await initAgentChangeJournal();
        setOriginalAgentPermissionMode(mode);
        const gateway = new ZoteroGateway();
        const contracts = new ActionContractService(gateway);
        const registry = new AgentToolRegistry(contracts);
        // Use the installed plugin's real tool closure, including its initialized
        // toolkit, persistence and journal, not an isolated test-bundle copy.
        registry.register(
          (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
            "note_write",
          ),
        );
        const contract: AgentActionContract = semanticContractFixture({
          version: 3,
          id: `saved-note-${mode}`,
          hardConstraints: [],
          writeDisposition: "required",
          interpretationSource: "semantic",
          obligations: [
            {
              id: "create-note",
              operation: "note_create",
              proofDomain: "zotero_state",
              capability: "zotero.notes",
              coverage: "one",
              targetKind: "items",
              parameters: { noteMode: "create" },
            },
          ],
        });
        const context: AgentToolContext = {
          request: {
            conversationKey: parent.id,
            mode: "agent",
            userText: "Create one child note on this paper",
            activeItemId: parent.id,
            libraryID: parent.libraryID,
            actionContract: contract,
            actionProgress: contracts.createProgress(contract),
          },
          item: parent,
          modelName: "workflow",
          currentAnswerText: "",
        };
        const execution = await registry.prepareExecution(
          {
            id: "save-note",
            name: "note_write",
            arguments: {
              mode: "create",
              target: "item",
              targetItemId: parent.id,
              content:
                "# Native saved note\n\nA **formatted** result.\n\n- First\n- Second\n\n> A saved quotation.",
            },
          },
          context,
          { callerKind: "model" },
        );
        assert.equal(
          execution.kind,
          "result",
          "creation must never wait for draft approval",
        );
        if (execution.kind !== "result") return;
        const result = execution.execution.result;
        assert.isTrue(result.ok, JSON.stringify(result.content));
        assert.isTrue(
          result.actionReceipts!.some(
            (receipt) => receipt.status === "applied",
          ),
        );
        await parent.reload(undefined, true);
        assert.lengthOf(parent.getNotes(), 1);
        const note = Zotero.Items.get(parent.getNotes()[0]);
        await note.reload(undefined, true);
        assert.include(note.getNote(), "Native saved note");
        assert.equal(
          note.getNoteTitle(),
          "Native saved note",
          "the content heading, not export metadata, must title the native note",
        );
        const panel = await api.renderPanelForItem(parent.id);
        root = api.renderToolResultForPanel(panel.panelId, result, {
          documentId: "duplicate-note-document",
          actionContract: contract,
        });
        assert.exists(root);
        assert.lengthOf(
          root!.querySelectorAll(".llm-plan-container"),
          1,
          "a restored semantic note-only turn has one card, not a second document",
        );
        const card = root!.querySelector<HTMLElement>(".llm-saved-note-card")!;
        assert.exists(
          card,
          "the successful tool result must expose a saved-note card",
        );
        assert.equal(card.dataset.noteId, String(note.id));
        assert.isNull(
          card.closest(".llm-agent-activity-details"),
          "the deliverable must not disappear inside collapsed activity",
        );
        assert.isNull(
          card.querySelector("textarea, button"),
          "no approval, cancellation or draft editor after creation",
        );
        assert.equal(
          card.querySelector(".llm-plan-status")?.textContent,
          "Saved",
        );
        assert.equal(card.querySelector("strong")?.textContent, "formatted");
        assert.notMatch(
          card.textContent || "",
          /<\/?div\b|&(?:quot|#0?39|amp);/,
        );
        assert.notInclude(card.textContent, "Model response:");
        assert.lengthOf(card.querySelectorAll("li"), 2);
        assert.include(
          card.querySelector("blockquote")!.textContent,
          "A saved quotation.",
        );
        const link = card.querySelector<HTMLAnchorElement>(
          ".llm-saved-note-destination",
        )!;
        assert.include(link.textContent, `Saved note destination ${mode}`);
        assert.include(link.href, `/items/${note.key}`);
        link.click();
        const deadline = Date.now() + 5000;
        while (
          !Zotero.getActiveZoteroPane()
            .getSelectedItems()
            .some((item) => item.id === note.id) &&
          Date.now() < deadline
        )
          await Zotero.Promise.delay(25);
        assert.deepEqual(
          Zotero.getActiveZoteroPane()
            .getSelectedItems()
            .map((item) => item.id),
          [note.id],
        );
      } finally {
        root?.remove();
        setOriginalAgentPermissionMode(originalMode);
        await api.reset();
        await parent.eraseTx();
      }
    });
  }
});
