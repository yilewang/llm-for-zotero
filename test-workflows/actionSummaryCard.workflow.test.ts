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
import type {
  AgentRunEventRecord,
  AgentToolContext,
  AgentToolResult,
} from "../src/agent/types";

/**
 * A turn that wrote a note and also changed the library, in the running
 * application.
 *
 * The panel used to answer such a turn with a stack: a saved-note card, and a
 * separate list of what the turn did. It is now one card whose note is a row
 * the reader can fold open, and whose chips are the way back to the paper, the
 * tag and the collection the turn actually touched. Both halves of that are
 * only true against a live Zotero: the chips are drawn from the receipts the
 * installed tools journal, and clicking one has to move the real items pane
 * and the real collection tree.
 */
describe("workflow: one action card for a mixed turn", function () {
  this.timeout(120000);

  afterEach(function () {
    assert.lengthOf(
      Zotero.getMainWindow().document.querySelectorAll(
        '[data-llm-workflow-test="true"]',
      ),
      0,
      "action-card tests must not leave panel hosts for later workflows",
    );
  });

  it("puts command actions after the final answer and toggles their literal source", async function () {
    const workflow = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "Action footer workflow");
    await parent.saveTx();
    const command = "printf '%s\\n' '<script> & ```'\n  printf 'second line'";
    // Recorded command evidence exercises presentation without executing a shell command.
    const events: AgentRunEventRecord[] = [
      {
        runId: "action-footer",
        seq: 1,
        eventType: "tool_result",
        createdAt: Date.now(),
        payload: {
          type: "tool_result",
          callId: "command",
          name: "run_command",
          ok: true,
          content: { command, exitCode: 0 },
          actionReceipts: [
            {
              version: 2,
              id: "command",
              proposalId: "command",
              operation: "command_execute",
              capability: "command.execute",
              proofDomain: "execution",
              verification: "execution_only",
              status: "observed",
              requestedTargets: [],
              appliedTargets: [],
              alreadySatisfiedTargets: [],
              rejectedTargets: [],
              reasons: [],
              verifiedFacts: [],
            },
            {
              version: 2,
              id: "tag",
              proposalId: "tag",
              operation: "apply_tags",
              capability: "zotero.tags",
              proofDomain: "zotero_state",
              verification: "verified",
              status: "applied",
              requestedTargets: [`item:${parent.id}`],
              appliedTargets: [`item:${parent.id}`],
              alreadySatisfiedTargets: [],
              rejectedTargets: [],
              reasons: [],
              verifiedFacts: [],
              normalizedParameters: { tags: ["Reviewed"] },
            },
          ],
        },
      },
      {
        runId: "action-footer",
        seq: 2,
        eventType: "final",
        createdAt: Date.now(),
        payload: {
          type: "final",
          text: "The final answer comes before the action card.",
        },
      },
    ];
    try {
      await workflow.openStandaloneForItem(parent.id);
      await workflow.resizeStandaloneWindow(900, 700);
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      // Rebuild from serialized trace events as history rendering does.
      for (const recorded of [events, JSON.parse(JSON.stringify(events))]) {
        for (const pendingEvents of [recorded.slice(0, -1), recorded]) {
          await workflow.seedStandaloneConversation([
            { role: "user", text: "Run the command" },
            {
              role: "assistant",
              text: "The answer is still arriving.",
              runMode: "agent",
              streaming: true,
              pendingAgentTraceEvents: pendingEvents,
            },
          ]);
          assert.isNull(
            win.document.querySelector(".llm-agent-action-summary-card"),
            "receipts and an early final event never interrupt streaming",
          );
          assert.include(
            win.document.querySelector(".llm-assistant-answer")!.textContent!,
            "The answer is still arriving.",
          );
          assert.equal(
            win.document
              .querySelector(".llm-assistant-actions")!
              .getBoundingClientRect().height,
            0,
            "the hidden outcome reserves no space while streaming",
          );
        }
        await workflow.seedStandaloneConversation([
          { role: "user", text: "Run the command" },
          {
            role: "assistant",
            text: "The final answer comes before the action card.",
            runMode: "agent",
            streaming: false,
            pendingAgentTraceEvents: recorded,
          },
        ]);
        const doc = win.document;
        const card = doc.querySelector<HTMLElement>(
          ".llm-agent-action-summary-card",
        )!;
        const answer = doc.querySelector<HTMLElement>(".llm-assistant-answer")!;
        assert.exists(card);
        assert.exists(answer);
        assert.isNull(
          card.closest(".llm-agent-activity"),
          "the outcome is outside the trace",
        );
        assert.isTrue(
          Boolean(answer.compareDocumentPosition(card) & 4),
          "the answer precedes the card",
        );
        assert.isAtLeast(
          card.getBoundingClientRect().top -
            answer.getBoundingClientRect().bottom,
          16,
          "the answer has a clear gap before its outcome card",
        );
        const title = card.querySelector<HTMLElement>(".llm-plan-title")!;
        const icon = title.querySelector<HTMLElement>(
          ".llm-agent-action-summary-icon",
        )!;
        assert.exists(icon);
        assert.strictEqual(title.firstChild, icon);
        assert.equal(title.textContent, "What this turn did");
        assert.equal(icon.getAttribute("aria-hidden"), "true");
        assert.include(
          win.getComputedStyle(icon)!.maskImage,
          "action-turn-summary.svg",
        );
        assert.isAbove(icon.getBoundingClientRect().width, 0);
        const titleRect = title.getBoundingClientRect();
        const badgeRect = card
          .querySelector(".llm-plan-status")!
          .getBoundingClientRect();
        assert.closeTo(
          titleRect.top + titleRect.height / 2,
          badgeRect.top + badgeRect.height / 2,
          1,
          "the icon heading and action count align vertically",
        );
        assert.lengthOf(
          doc.querySelectorAll(".llm-agent-action-summary-card"),
          1,
        );
        const panel = card.closest<HTMLElement>(".llm-panel")!;
        const originalScale = panel.style.getPropertyValue("--llm-font-scale");
        try {
          for (const scale of ["1", "1.3"]) {
            panel.style.setProperty("--llm-font-scale", scale);
            const answerSize = parseFloat(
              win.getComputedStyle(answer)!.fontSize,
            );
            const cardSize = parseFloat(win.getComputedStyle(card)!.fontSize);
            assert.isBelow(
              cardSize,
              answerSize,
              "the outcome is smaller than the answer",
            );
            assert.isAtLeast(
              cardSize,
              answerSize * 0.85,
              "compact text remains readable",
            );
            for (const label of Array.from(
              card.querySelectorAll<HTMLElement>(
                ".llm-plan-title, .llm-plan-status, .llm-agent-action-verb-word-inline, .llm-agent-process-chip-label, .llm-paper-context-chip-text, .llm-tag-chip-title",
              ),
            ) as HTMLElement[]) {
              assert.equal(
                win.getComputedStyle(label)!.fontSize,
                `${cardSize}px`,
                `${label.className} matches the compact card at scale ${scale}`,
              );
            }
          }
        } finally {
          if (originalScale)
            panel.style.setProperty("--llm-font-scale", originalScale);
          else panel.style.removeProperty("--llm-font-scale");
        }
        const row = card.querySelector<HTMLDetailsElement>(
          "details.llm-agent-action-row",
        )!;
        assert.exists(row);
        assert.isFalse(row.open);
        row.querySelector("summary")!.click();
        await Zotero.Promise.delay(50);
        assert.isTrue(row.open);
        const pre = row.querySelector<HTMLPreElement>(
          "pre.llm-agent-action-command",
        )!;
        assert.exists(pre);
        assert.equal(pre.querySelector("code")!.textContent, command);
        assert.isNull(pre.querySelector("script"));
        assert.isAbove(pre.getBoundingClientRect().height, 0);
        assert.equal(win.getComputedStyle(pre)!.whiteSpace, "pre");
        assert.equal(win.getComputedStyle(pre)!.borderTopWidth, "1px");
        assert.equal(
          win.getComputedStyle(pre.querySelector("code")!)!.fontSize,
          win.getComputedStyle(card)!.fontSize,
        );
        const expandedHeight = row.getBoundingClientRect().height;
        row.querySelector("summary")!.click();
        await Zotero.Promise.delay(50);
        assert.isFalse(row.open, "clicking again collapses the command");
        assert.isBelow(
          row.getBoundingClientRect().height,
          expandedHeight,
          "the closed disclosure removes the code from the visible layout",
        );
        row.querySelector("summary")!.click();
        await Zotero.Promise.delay(50);
        assert.lengthOf(
          row.querySelectorAll("pre.llm-agent-action-command"),
          1,
        );
      }
      const longEvents = Array.from({ length: 32 }, (_, index) => {
        const event = JSON.parse(JSON.stringify(events[0]));
        event.seq = index + 1;
        event.payload.callId = `command-${index}`;
        event.payload.actionReceipts = [
          {
            ...event.payload.actionReceipts[0],
            id: `command-${index}`,
            proposalId: `command-${index}`,
          },
        ];
        return event;
      });
      for (const width of [900, 520]) {
        await workflow.resizeStandaloneWindow(width, 700);
        await workflow.seedStandaloneConversation([
          {
            role: "assistant",
            text: "Finished the requested workflow.",
            runMode: "agent",
            streaming: false,
            pendingAgentTraceEvents: longEvents,
          },
        ]);
        const card = win.document.querySelector<HTMLElement>(
          ".llm-agent-action-summary-card",
        )!;
        const list = card.querySelector<HTMLElement>(
          ".llm-agent-action-summary-list",
        )!;
        const toggle = card.querySelector<HTMLButtonElement>(
          ".llm-agent-action-summary-toggle",
        )!;
        assert.exists(toggle);
        assert.equal(toggle.getAttribute("aria-controls"), list.id);
        assert.isTrue(list.hidden);
        assert.equal(win.getComputedStyle(list)!.display, "none");
        const collapsedHeight = card.getBoundingClientRect().height;
        assert.isBelow(
          collapsedHeight,
          120,
          "32 actions start as a compact header",
        );
        toggle.focus();
        assert.strictEqual(win.document.activeElement, toggle);
        toggle.click();
        assert.equal(toggle.getAttribute("aria-expanded"), "true");
        assert.isAbove(list.getBoundingClientRect().height, 300);
        toggle.click();
        assert.isTrue(list.hidden);
        assert.closeTo(card.getBoundingClientRect().height, collapsedHeight, 1);
      }
    } finally {
      await workflow.closeStandalone();
      await parent.eraseTx();
      await workflow.reset();
    }
  });

  it("folds the note into one card and its chips move the live pane", async function () {
    const api = (Zotero as any).LLMForZotero.api;
    const workflow = api.workflowTest as WorkflowTestApi;
    const pane = Zotero.getActiveZoteroPane();
    const originalMode = getOriginalAgentPermissionMode();
    const libraryID = Zotero.Libraries.userLibraryID;
    const stamp = Date.now();
    const tag = `action-card-tag-${stamp}`;
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = libraryID;
    parent.setField("title", `Mixed turn paper ${stamp}`);
    await parent.saveTx();
    const collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID = libraryID;
    collection.name = `Mixed turn collection ${stamp}`;
    await collection.saveTx();
    let root: HTMLElement | null = null;
    try {
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("yolo");
      const gateway = new ZoteroGateway();
      const contracts = new ActionContractService(gateway);
      const registry = new AgentToolRegistry(contracts);
      // The installed plugin's own tool closures, with its initialized
      // toolkit, persistence and journal — not a test-bundle copy.
      for (const name of ["note_write", "library_update"])
        registry.register(api.agent.getToolDefinition(name));
      const context: AgentToolContext = {
        request: resolvedAgentRequest({
          conversationKey: parent.id,
          mode: "agent",
          userText: "Note this paper, tag it, and file it",
          activeItemId: parent.id,
          libraryID,
          executionContext: {
            version: 1,
            executionId: `mixed-turn:${stamp}`,
            conversationKey: parent.id,
            conversationGeneration: 0,
            chatLibraryID: libraryID,
            permissionOwner: "original_agent",
            workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
            configuredAccess: {
              libraryIDs: [libraryID],
              outputDirectories: [],
            },
          },
        }),
        item: parent,
        modelName: "workflow",
        currentAnswerText: "",
        runId: `mixed-turn-run:${stamp}`,
      };
      let callCount = 0;
      async function call(
        name: string,
        args: Record<string, unknown>,
      ): Promise<AgentToolResult> {
        let execution = await registry.prepareExecution(
          { id: `${name}-${++callCount}`, name, arguments: args },
          context,
          { callerKind: "model" },
        );
        if (execution.kind === "confirmation")
          execution = await execution.execute({ approved: true });
        assert.equal(execution.kind, "result", `${name} must reach a result`);
        if (execution.kind !== "result")
          throw new Error(`${name} did not execute`);
        const result = execution.execution.result;
        assert.isTrue(result.ok, JSON.stringify(result.content));
        return result;
      }
      async function waitFor<T>(
        read: () => T | null | undefined | false,
        what: string,
      ): Promise<T> {
        const deadline = Date.now() + 10000;
        for (;;) {
          const value = read();
          if (value) return value as T;
          if (Date.now() > deadline)
            throw new Error(`Timed out waiting for ${what}`);
          await Zotero.Promise.delay(25);
        }
      }

      const noteResult = await call("note_write", {
        mode: "create",
        target: "item",
        targetItemId: parent.id,
        content: "# Mixed turn note\n\nWhat the turn wrote down.",
      });
      const tagResult = await call("library_update", {
        kind: "tags",
        action: "add",
        itemIds: [parent.id],
        tags: [tag],
      });
      await parent.reload(undefined as never, true);
      assert.lengthOf(parent.getNotes(), 1, "the turn wrote one child note");
      const note = Zotero.Items.get(parent.getNotes()[0]);
      await note.reload(undefined as never, true);
      assert.include(
        parent.getTags().map((entry) => entry.tag),
        tag,
        "the turn tagged the real paper",
      );

      const panel = await workflow.renderPanelForItem(parent.id);
      root = workflow.renderToolResultForPanel(panel.panelId, tagResult, {
        priorResults: [noteResult],
        userText: "Note this paper and tag it",
      });
      const mixed = root!.querySelectorAll<HTMLElement>(
        ".llm-agent-action-summary-card",
      );
      assert.lengthOf(mixed, 1, "a turn states what it did once");
      const card = mixed[0];
      assert.equal(
        card.dataset.mode,
        "action",
        "a note beside another action is one of the things the turn did",
      );
      assert.equal(
        card.querySelector(".llm-plan-header .llm-plan-status")?.textContent,
        "2 actions",
      );
      assert.lengthOf(
        root!.querySelectorAll(".llm-saved-note-card, .llm-note-change-card"),
        0,
        "the note is inside the card, not beside it",
      );
      const rows = card.querySelectorAll<HTMLDetailsElement>(
        "details.llm-agent-action-row",
      );
      assert.lengthOf(rows, 1, "the note write is the row with a body");
      const row = rows[0];
      assert.isFalse(row.open, "a row beside other actions starts folded");
      assert.isNull(
        card.querySelector(".llm-note-preview"),
        "a folded row reads nothing back from disk",
      );
      assert.include(
        ([...card.querySelectorAll(".llm-note-context-chip")] as Element[]).map(
          (chip) => chip.textContent,
        ),
        note.getNoteTitle(),
        "the row names the note it wrote",
      );
      // The note write's receipt targets the note's paper, and the tag's
      // receipt targets the same paper, so both land on one row: the paper
      // once, then the note it wrote and the tag it applied.
      assert.deepEqual(
        (
          [
            ...row.querySelectorAll<HTMLElement>(
              ".llm-agent-action-summary-item .llm-selected-context",
            ),
          ] as HTMLElement[]
        ).map((chip) =>
          chip.classList.contains("llm-paper-context-chip")
            ? "paper"
            : chip.classList.contains("llm-note-context-chip")
              ? "note"
              : chip.classList.contains("llm-tag-context-chip")
                ? "tag"
                : chip.className,
        ),
        ["paper", "note", "tag"],
      );
      const tagTitle = (
        [
          ...card.querySelectorAll<HTMLElement>(".llm-tag-chip-title"),
        ] as HTMLElement[]
      ).find((chip) => chip.textContent === tag)!;
      assert.exists(tagTitle, "the row names the tag it applied");
      // A chip is a link only where this window can take the reader. The tag's
      // destination is Zotero's own tag selector, which exists only while the
      // tag pane is mounted, so the chip follows what the live window offers.
      assert.equal(
        tagTitle
          .closest(".llm-tag-context-chip")!
          .classList.contains("llm-agent-action-link"),
        typeof (pane as any).tagSelector?.handleTagSelected === "function",
        "the tag chip links exactly when the live tag selector can be filtered",
      );

      row.querySelector("summary")!.click();
      const preview = await waitFor(
        () => card.querySelector<HTMLElement>(".llm-note-preview"),
        "the note preview the opened row builds",
      );
      assert.isTrue(row.open, "clicking the row's summary opens it");
      assert.isAbove(
        preview.getBoundingClientRect().height,
        0,
        "the opened row shows the note on screen",
      );
      assert.include(preview.textContent, "What the turn wrote down.");

      root!.remove();
      root = null;
      const moveResult = await call("library_update", {
        kind: "collections",
        action: "add",
        itemIds: [parent.id],
        targetCollectionId: collection.id,
      });
      await parent.reload(undefined as never, true);
      assert.include(
        parent.getCollections(),
        collection.id,
        "the turn filed the real paper",
      );

      root = workflow.renderToolResultForPanel(panel.panelId, moveResult, {
        priorResults: [noteResult, tagResult],
        userText: "Note this paper, tag it, and file it",
      });
      const filed = root!.querySelector<HTMLElement>(
        ".llm-agent-action-summary-card",
      )!;
      const pill = filed.querySelector<HTMLElement>(
        ".llm-plan-header .llm-plan-status",
      )!;
      assert.equal(pill.textContent, "3 actions");

      // The collection is opened first, so the paper chip is clicked from
      // inside a collection: the reader must be shown the paper where they are
      // already looking, not thrown back out to My Library.
      const collectionChip = filed.querySelector<HTMLElement>(
        ".llm-collection-context-chip",
      )!;
      assert.exists(collectionChip, "the turn's destination has a chip");
      assert.include(
        collectionChip.className,
        "llm-agent-action-link",
        "a collection the receipt identified is a way in",
      );
      assert.include(collectionChip.textContent, collection.name);
      const getSelectedCollectionId = () =>
        typeof pane.getSelectedCollections === "function"
          ? pane.getSelectedCollections(true)?.[0]
          : pane.getSelectedCollection(true);
      collectionChip.click();
      await waitFor(
        () => getSelectedCollectionId() === collection.id,
        "the collection tree to select the collection the chip names",
      );

      const paperChip = filed.querySelector<HTMLElement>(
        ".llm-paper-context-chip.llm-agent-action-link",
      )!;
      assert.exists(paperChip, "the paper the turn acted on is a way in");
      assert.include(
        paperChip.textContent,
        `Mixed turn paper ${stamp}`,
        "the chip names the paper by what the library calls it",
      );
      paperChip.click();
      await waitFor(
        () => pane.getSelectedItems().some((item) => item.id === parent.id),
        "the items pane to select the paper the chip names",
      );
      assert.equal(
        getSelectedCollectionId(),
        collection.id,
        "opening a paper leaves the reader in the collection they were in",
      );
      assert.notEqual(
        pill.dataset.status,
        "error",
        `a live navigation must not report a missing target: ${pill.textContent}`,
      );
    } finally {
      root?.remove();
      setOriginalAgentPermissionMode(originalMode);
      await workflow.reset();
      try {
        await (pane.collectionsView as any)?.selectLibrary?.(libraryID);
      } catch {
        /* The reader's own view is restored where the tree allows it. */
      }
      await parent.eraseTx();
      await collection.eraseTx();
      try {
        const tagID = Zotero.Tags.getID(tag);
        if (tagID)
          await (Zotero.Tags as any).removeFromLibrary(libraryID, tagID);
      } catch {
        /* Leave no fixture tag behind, but never fail the run over one. */
      }
    }
  });
});
