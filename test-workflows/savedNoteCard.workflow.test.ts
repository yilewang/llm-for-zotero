import "./hostSurfaceBootstrap";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
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
import type { AgentToolContext } from "../src/agent/types";

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
  // Auto and yolo run the note create through the same path; test one of them.
  for (const mode of ["safe", "auto"] as const) {
    it(`${mode === "safe" ? "reviews" : "creates"} in ${mode}, shows native content, and opens the exact note`, async function () {
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
        const context: AgentToolContext = {
          request: resolvedAgentRequest({
            conversationKey: parent.id,
            mode: "agent",
            userText: "Create one child note on this paper",
            activeItemId: parent.id,
            libraryID: parent.libraryID,
            executionContext: {
              version: 1,
              executionId: `direct-saved-note-${mode}:${Date.now()}`,
              conversationKey: parent.id,
              conversationGeneration: 0,
              chatLibraryID: parent.libraryID,
              permissionOwner: "original_agent",
              workspaceSnapshot: {
                selectedPapers: [],
                selectedCollections: [],
              },
              configuredAccess: {
                libraryIDs: [parent.libraryID],
                outputDirectories: [],
              },
            },
          }),
          item: parent,
          modelName: "workflow",
          currentAnswerText: "",
          runId: `direct-saved-note-run-${mode}:${Date.now()}`,
        };
        let execution = await registry.prepareExecution(
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
        if (mode === "safe") {
          assert.equal(execution.kind, "confirmation");
          await parent.reload(undefined as never, true);
          assert.isEmpty(parent.getNotes(), "Safe review precedes mutation");
          if (execution.kind !== "confirmation") return;
          execution = await execution.execute({ approved: true });
        }
        assert.equal(execution.kind, "result");
        if (execution.kind !== "result") return;
        const result = execution.execution.result;
        assert.isTrue(result.ok, JSON.stringify(result.content));
        assert.isTrue(
          result.actionReceipts!.some(
            (receipt) => receipt.status === "applied",
          ),
        );
        await parent.reload(undefined as never, true);
        assert.lengthOf(parent.getNotes(), 1);
        const note = Zotero.Items.get(parent.getNotes()[0]);
        await note.reload(undefined as never, true);
        assert.include(note.getNote(), "Native saved note");
        assert.equal(
          note.getNoteTitle(),
          "Native saved note",
          "the content heading, not export metadata, must title the native note",
        );
        const panel = await api.renderPanelForItem(parent.id);
        root = api.renderToolResultForPanel(panel.panelId, result, {});
        assert.exists(root);
        assert.lengthOf(
          root!.querySelectorAll(".llm-plan-document-card"),
          0,
          "a restored note-only turn shows no second document card",
        );
        assert.lengthOf(
          root!.querySelectorAll(".llm-plan-container"),
          1,
          "the note and what the turn did are one card, not two",
        );
        const cards = root!.querySelectorAll<HTMLElement>(
          ".llm-agent-action-summary-card",
        );
        assert.lengthOf(cards, 1, "one turn states its outcome once");
        const card = cards[0];
        assert.equal(
          card.dataset.mode,
          "note",
          "a turn whose only action was the note is that note",
        );
        assert.include(card.className, "llm-saved-note-card");
        assert.lengthOf(
          root!.querySelectorAll(".llm-saved-note-destination"),
          0,
          "the standalone saved-note card is not rendered beside it",
        );
        assert.isNull(
          card.closest(".llm-agent-activity-details"),
          "the deliverable must not disappear inside collapsed activity",
        );
        assert.equal(
          card.querySelector(".llm-plan-title")?.textContent,
          note.getNoteTitle(),
          "the card is titled with the note Zotero actually stored",
        );
        assert.equal(
          card.querySelector(".llm-plan-header .llm-plan-status")?.textContent,
          "Saved",
        );
        assert.include(
          (
            [
              ...card.querySelectorAll(".llm-paper-context-chip-text"),
            ] as Element[]
          ).map((chip) => chip.textContent),
          `Saved note destination ${mode}`,
          "the row names the paper the note landed on",
        );
        const row = card.querySelector<HTMLDetailsElement>(
          "details.llm-agent-action-row",
        )!;
        assert.exists(row, "the note is the body of the turn's one row");
        assert.isTrue(row.open, "the note the reader came for is already open");
        const preview = card.querySelector<HTMLElement>(".llm-note-preview")!;
        assert.exists(preview, "the open row shows the note it wrote");
        assert.isNull(
          card.querySelector("textarea"),
          "no approval, cancellation or draft editor after creation",
        );
        assert.deepEqual(
          ([...card.querySelectorAll("button")] as HTMLButtonElement[]).map(
            (button) => button.textContent,
          ),
          ["Open note"],
          "a saved note offers the way in, and no approval controls",
        );
        assert.equal(preview.querySelector("strong")?.textContent, "formatted");
        assert.notMatch(
          preview.textContent || "",
          /<\/?div\b|&(?:quot|#0?39|amp);/,
        );
        assert.notInclude(preview.textContent, "Model response:");
        assert.lengthOf(preview.querySelectorAll("li"), 2);
        assert.include(
          preview.querySelector("blockquote")!.textContent,
          "A saved quotation.",
        );
        const open = (
          [
            ...card.querySelectorAll<HTMLButtonElement>(
              "button.llm-plan-action",
            ),
          ] as HTMLButtonElement[]
        ).find((button) => button.textContent === "Open note")!;
        assert.exists(open, "the row opens the exact note it wrote");
        open.click();
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
