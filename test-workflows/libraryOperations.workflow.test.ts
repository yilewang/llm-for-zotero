import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import {
  getOrCreateZoteroMcpBearerToken,
  ZOTERO_MCP_ENDPOINT_PATH,
} from "../src/agent/mcp/server";
import { replayLibraryInverse } from "../test/helpers/replayLibraryInverse";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { createLibrarySearchTool } from "../src/agent/tools/read/librarySearch";
import { createSavedSearchTool } from "../src/agent/tools/write/savedSearches";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { buildActionCallDigest } from "../src/agent/authorization/proposal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;
declare const IOUtils: any;

/**
 * Every capability added in Stages 0–6, exercised against a REAL Zotero
 * library rather than a fake.
 *
 * This suite exists because a fully green unit suite has twice hidden a
 * completely non-functional capability in this project. Unit tests here use
 * hand-written stand-ins for `Zotero.Search`, `Zotero.ItemFields`,
 * `Zotero.Tags` and the rest — so they prove the code does what I *believe*
 * those APIs do. Only running against Zotero proves the belief.
 *
 * Assertions read Zotero's own database and the filesystem, never the agent's
 * prose.
 */
describe("library operations against real Zotero", function () {
  this.timeout(120000);

  const SUFFIX = `wf${Date.now()}`;
  const created = {
    items: [] as number[],
    collections: [] as number[],
    searches: [] as number[],
    tags: [] as string[],
  };

  function gateway() {
    return new ZoteroGateway();
  }

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  async function makeCollection(name: string, parentID?: number) {
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID();
    collection.name = `${name}-${SUFFIX}`;
    if (parentID) collection.parentID = parentID;
    await collection.saveTx();
    created.collections.push(collection.id);
    return collection;
  }

  async function makeItem(itemType = "journalArticle", title = "Paper") {
    const item = new Zotero.Item(itemType);
    item.libraryID = libraryID();
    item.setField("title", `${title}-${SUFFIX}`);
    await item.saveTx();
    created.items.push(item.id);
    return item;
  }

  after(async function () {
    // Leave the user's library as we found it.
    for (const id of created.searches) {
      try {
        const s = Zotero.Searches.get(id);
        if (s) await s.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const id of created.items) {
      try {
        const item = Zotero.Items.get(id);
        if (item) await item.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const id of created.collections) {
      try {
        const c = Zotero.Collections.get(id);
        if (c) await c.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const tag of created.tags) {
      try {
        const tagID = Zotero.Tags.getID(tag);
        if (tagID) await Zotero.Tags.removeFromLibrary(libraryID(), [tagID]);
      } catch {
        /* best effort */
      }
    }
  });

  it("reports metadata-only members in the collection tree", async function () {
    const collection = await makeCollection("Metadata-only count");
    const paper = await makeItem("journalArticle", "Without PDF");
    paper.addToCollection(collection.id);
    await paper.saveTx();
    const tool =
      Zotero.LLMForZotero.api.agent.getToolDefinition("library_search");
    const parsed = tool.validate({
      entity: "collections",
      mode: "list",
      view: "tree",
      libraryID: libraryID(),
    });
    assert.isTrue(parsed.ok);
    const result = await tool.execute(parsed.value, {
      request: {
        conversationKey: paper.id,
        libraryID: libraryID(),
        mode: "agent",
        userText: "List collections",
      },
      item: paper,
      modelName: "workflow",
      currentAnswerText: "",
    });
    const node = result.collections.find(
      (value: { collectionId: number }) => value.collectionId === collection.id,
    );
    assert.equal(node?.paperCount, 1);
    assert.equal(node?.descendantPaperCount, 1);
  });

  it("keeps note discovery inside the requested collection before limiting results", async function () {
    const inside = await makeCollection("Notes-Inside");
    const outside = await makeCollection("Notes-Outside");
    const parent = await makeItem("journalArticle", "Note parent");
    parent.addToCollection(inside.id);
    await parent.saveTx();
    const notes: any[] = [];
    for (const target of [outside, inside, parent]) {
      const note = new Zotero.Item("note");
      note.libraryID = libraryID();
      if (target === parent) note.parentID = parent.id;
      else note.addToCollection(target.id);
      note.setNote(`<h1>Scoped note ${SUFFIX}</h1>`);
      await note.saveTx();
      created.items.push(note.id);
      notes.push(note);
    }
    // Use the installed query owner and its subscribed native index. A second
    // bundled gateway would cache this early fixture without the app's events.
    const tool =
      Zotero.LLMForZotero.api.agent.getToolDefinition("library_search");
    const context = {
      request: {
        conversationKey: parent.id,
        libraryID: libraryID(),
        mode: "agent",
        userText: "Find notes in this collection",
      },
      item: parent,
      currentAnswerText: "",
      modelName: "workflow",
    };
    for (const mode of ["list", "search"] as const) {
      const parsed = tool.validate({
        entity: "notes",
        mode,
        libraryID: libraryID(),
        text: SUFFIX,
        filters: { collectionId: inside.id },
        limit: 50,
      });
      assert.isTrue(parsed.ok);
      if (!parsed.ok) continue;
      const result = (await tool.execute(
        parsed.value,
        context as never,
      )) as any;
      assert.sameMembers(
        result.results.map((row: any) => row.itemId),
        mode === "list" ? [notes[1].id] : [notes[1].id, notes[2].id],
      );
      assert.isTrue(
        result.results.every((row: any) =>
          row.collectionIds.includes(inside.id),
        ),
      );
      const limited = (await tool.execute(
        { ...parsed.value, limit: 1 },
        context as never,
      )) as any;
      assert.lengthOf(limited.results, 1);
      assert.include([notes[1].id, notes[2].id], limited.results[0].itemId);
    }
  });

  describe("MCP active library resolution", function () {
    it("reads the selected Zotero library when libraryID is omitted", async function () {
      const collection = await makeCollection("McpScopeProbe");
      const EndpointClass = Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
      assert.isFunction(EndpointClass);

      const [status, , body] = await new EndpointClass().init({
        method: "POST",
        headers: {
          Authorization: `Bearer ${getOrCreateZoteroMcpBearerToken()}`,
        },
        data: {
          jsonrpc: "2.0",
          id: 423,
          method: "tools/call",
          params: {
            name: "library_search",
            arguments: {
              entity: "collections",
              mode: "list",
              view: "tree",
            },
          },
        },
      });
      const payload = JSON.parse(body);
      const content = JSON.parse(payload.result.content[0].text);

      assert.equal(status, 200);
      assert.equal(content.ok, true);
      assert.include(
        JSON.stringify(content.result),
        collection.name,
        "the headerless MCP call must read native state from the selected library",
      );
    });
  });

  // ── Stage 0a/0b ───────────────────────────────────────────────────────────

  describe("collection delete is a trash, not an erase", function () {
    it("puts the collection AND its subcollections in deletedCollections", async function () {
      const parent = await makeCollection("Trash-Parent");
      const child = await makeCollection("Trash-Child", parent.id);

      await gateway().deleteCollection({ collectionId: parent.id });

      // The row must still exist -- eraseTx would have removed it entirely.
      const stillThere = await Zotero.DB.valueQueryAsync(
        "SELECT COUNT(*) FROM collections WHERE collectionID=?",
        [parent.id],
      );
      assert.equal(
        Number(stillThere),
        1,
        "the collection must survive a delete",
      );

      const trashed = await Zotero.DB.columnQueryAsync(
        `SELECT collectionID FROM deletedCollections WHERE collectionID IN (?, ?)`,
        [parent.id, child.id],
      );
      const trashedIds = (trashed || []).map(Number);
      assert.include(trashedIds, parent.id, "parent must be in the trash");
      assert.include(trashedIds, child.id, "subcollections travel with it");
    });

    it("restores the original collection id, not a rebuilt lookalike", async function () {
      const parent = await makeCollection("Restore-Parent");
      const child = await makeCollection("Restore-Child", parent.id);
      const g = gateway();

      await g.deleteCollection({ collectionId: parent.id });
      const result = await g.restoreCollections({ collectionIds: [parent.id] });
      assert.isAtLeast(result.restoredCount, 1);

      const remaining = await Zotero.DB.columnQueryAsync(
        `SELECT collectionID FROM deletedCollections WHERE collectionID IN (?, ?)`,
        [parent.id, child.id],
      );
      assert.lengthOf(
        remaining || [],
        0,
        "parent and descendants both come back",
      );
      // The old undo rebuilt the collection, minting a new id and stranding
      // everything that referenced the old one.
      assert.isOk(Zotero.Collections.get(parent.id));
    });

    it("leaves items in the library unless asked to take them", async function () {
      const collection = await makeCollection("Keep-Items");
      const item = await makeItem();
      item.addToCollection(collection.id);
      await item.saveTx();

      await gateway().deleteCollection({ collectionId: collection.id });

      const fresh = Zotero.Items.get(item.id);
      assert.isFalse(Boolean(fresh.deleted), "items stay out of the trash");
    });
  });

  // ── Stage 5: collection rename / move ─────────────────────────────────────

  describe("collections are renameable and movable", function () {
    it("renames in place, keeping the id items reference", async function () {
      const collection = await makeCollection("Rename-Me");
      const originalId = collection.id;

      const result = await gateway().updateCollection({
        collectionId: originalId,
        name: `Renamed-${SUFFIX}`,
      });

      assert.equal(result.status, "updated");
      assert.equal(result.collectionId, originalId);
      assert.equal(
        Zotero.Collections.get(originalId).name,
        `Renamed-${SUFFIX}`,
      );
    });

    it("moves under a new parent and back to the top level", async function () {
      const a = await makeCollection("Move-A");
      const b = await makeCollection("Move-B");
      const g = gateway();

      await g.updateCollection({
        collectionId: b.id,
        parentCollectionId: a.id,
      });
      assert.equal(Zotero.Collections.get(b.id).parentID, a.id);

      await g.updateCollection({
        collectionId: b.id,
        parentCollectionId: null,
      });
      assert.isNotOk(Zotero.Collections.get(b.id).parentID);
    });

    it("refuses a move that would detach the subtree from the library", async function () {
      const parent = await makeCollection("Cycle-Parent");
      const child = await makeCollection("Cycle-Child", parent.id);

      const result = await gateway().updateCollection({
        collectionId: parent.id,
        parentCollectionId: child.id,
      });

      assert.notEqual(result.status, "updated");
      assert.equal(Zotero.Collections.get(parent.id).parentID, false);
    });
  });

  // ── Stage 0g: true move ───────────────────────────────────────────────────

  describe("moving items between collections", function () {
    it("adds without removing, by default", async function () {
      const from = await makeCollection("Add-From");
      const to = await makeCollection("Add-To");
      const item = await makeItem();
      item.addToCollection(from.id);
      await item.saveTx();

      await gateway().addItemsToCollections({
        assignments: [{ itemId: item.id, targetCollectionId: to.id }],
      });

      const rows = await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID=?",
        [item.id],
      );
      assert.sameMembers((rows || []).map(Number), [from.id, to.id]);
    });

    it("actually removes the source when mode is move", async function () {
      const from = await makeCollection("Move-From");
      const to = await makeCollection("Move-To");
      const item = await makeItem();
      item.addToCollection(from.id);
      await item.saveTx();

      await gateway().addItemsToCollections({
        assignments: [{ itemId: item.id, targetCollectionId: to.id }],
        mode: "move",
        from: from.id,
      });

      const rows = await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID=?",
        [item.id],
      );
      // The whole point: "move" used to leave the item in both.
      assert.sameMembers((rows || []).map(Number), [to.id]);
    });

    it("keeps every destination when one item has several in one call", async function () {
      const from = await makeCollection("Multi-From");
      const d1 = await makeCollection("Multi-D1");
      const d2 = await makeCollection("Multi-D2");
      const item = await makeItem();
      item.addToCollection(from.id);
      await item.saveTx();

      await gateway().addItemsToCollections({
        assignments: [
          { itemId: item.id, targetCollectionId: d1.id },
          { itemId: item.id, targetCollectionId: d2.id },
        ],
        mode: "move",
        from: "all",
      });

      const rows = await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID=?",
        [item.id],
      );
      // Pairwise handling would let the second assignment undo the first.
      assert.sameMembers((rows || []).map(Number), [d1.id, d2.id]);
    });

    it("restores the exact prior membership on undo", async function () {
      const a = await makeCollection("Undo-A");
      const b = await makeCollection("Undo-B");
      const dest = await makeCollection("Undo-Dest");
      const item = await makeItem();
      item.addToCollection(a.id);
      item.addToCollection(b.id);
      await item.saveTx();

      const service = new LibraryMutationService(gateway());
      const context = {
        request: { conversationKey: 1, libraryID: libraryID() },
      } as never;
      const outcome = await service.executeOperation(
        {
          type: "move_to_collection",
          itemIds: [item.id],
          targetCollectionId: dest.id,
          mode: "move",
          from: "all",
        },
        context,
      );

      await replayLibraryInverse(service, outcome, context);
      const rows = await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID=?",
        [item.id],
      );
      // The old inverse emitted remove_from_collection, which would have
      // unfiled the item entirely instead of restoring a and b.
      assert.sameMembers((rows || []).map(Number), [a.id, b.id]);
    });

    it("files an unfiled paper, refuses its annotation with the reason, and never reports the batch unverified", async function () {
      // The live reorganization filed 253 papers, then sent a highlight its
      // own script had counted as unfiled. Zotero holds only top-level items in
      // collections; the refusal used to make the receipt "unverified", which
      // blocked the run. Here the installed library_update runs against a real
      // paper, a real PDF and a real highlight on it.
      const api = Zotero.LLMForZotero.api;
      const workflow = api.workflowTest as WorkflowTestApi;
      const originalMode = getOriginalAgentPermissionMode();
      const destination = await makeCollection("Annotated-Dest");
      const paper = await makeItem("journalArticle", "Annotated unfiled paper");
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      pdf.addPage([612, 792]).drawText("Representational drift.", {
        x: 72,
        y: 700,
        size: 12,
        font,
      });
      const pdfPath = PathUtils.join(
        Zotero.getTempDirectory().path,
        `annotated-${SUFFIX}.pdf`,
      );
      await IOUtils.write(pdfPath, await pdf.save());
      const attachment = await Zotero.Attachments.importFromFile({
        file: pdfPath,
        parentItemID: paper.id,
      });
      const annotation = new Zotero.Item("annotation");
      annotation.libraryID = libraryID();
      annotation.parentID = attachment.id;
      annotation.annotationType = "highlight";
      annotation.annotationText = "Representational drift.";
      annotation.annotationComment =
        "the authors claim that representations drift";
      annotation.annotationColor = "#ffd400";
      annotation.annotationPageLabel = "1";
      annotation.annotationSortIndex = "00000|000000|00080";
      annotation.annotationPosition = JSON.stringify({
        pageIndex: 0,
        rects: [[72, 698, 230, 712]],
      });
      await annotation.saveTx();
      const reason = `Item ${annotation.id} is an annotation inside an attachment; only top-level items can be filed into collections.`;
      const membership = async (itemId: number) =>
        (
          (await Zotero.DB.columnQueryAsync(
            "SELECT collectionID FROM collectionItems WHERE itemID=?",
            [itemId],
          )) || []
        ).map(Number);
      let root: HTMLElement | null = null;
      try {
        assert.isTrue(annotation.isAnnotation());
        assert.deepEqual(
          await membership(paper.id),
          [],
          "the paper is unfiled",
        );
        await initAgentChangeJournal();
        setOriginalAgentPermissionMode("yolo");
        const registry = new AgentToolRegistry(
          new ActionContractService(gateway()),
        );
        registry.register(api.agent.getToolDefinition("library_update"));
        const context: AgentToolContext = {
          request: resolvedAgentRequest({
            conversationKey: paper.id,
            mode: "agent",
            userText: "Sort my unfiled papers into topic folders",
            libraryID: libraryID(),
            executionContext: {
              version: 1,
              executionId: `unfileable:${SUFFIX}`,
              conversationKey: paper.id,
              conversationGeneration: 0,
              chatLibraryID: libraryID(),
              permissionOwner: "original_agent",
              workspaceSnapshot: {
                selectedPapers: [],
                selectedCollections: [],
              },
              configuredAccess: {
                libraryIDs: [libraryID()],
                outputDirectories: [],
              },
            },
          }),
          item: paper,
          modelName: "workflow",
          currentAnswerText: "",
          runId: `unfileable-run:${SUFFIX}`,
        };
        const file = async (
          callId: string,
          args: Record<string, unknown>,
        ): Promise<AgentToolResult> => {
          let execution = await registry.prepareExecution(
            {
              id: callId,
              name: "library_update",
              arguments: { kind: "collections", action: "add", ...args },
            },
            context,
            { callerKind: "model" },
          );
          if (execution.kind === "confirmation")
            execution = await execution.execute({ approved: true });
          assert.equal(execution.kind, "result");
          if (execution.kind !== "result") throw new Error("unreachable");
          const result = execution.execution.result;
          assert.isTrue(result.ok, JSON.stringify(result.content));
          return result;
        };

        // The paper and its highlight in one batch, as the reorganization
        // sent them.
        const batch = await file("file-batch", {
          assignments: [
            { itemId: paper.id, targetCollectionId: destination.id },
            { itemId: annotation.id, targetCollectionId: destination.id },
          ],
        });
        assert.deepEqual(await membership(paper.id), [destination.id]);
        assert.deepEqual(await membership(annotation.id), []);
        const [batchReceipt] = batch.actionReceipts!;
        assert.equal(batchReceipt.status, "partial");
        assert.equal(batchReceipt.verification, "verified");
        assert.deepEqual(batchReceipt.appliedTargets, [`item:${paper.id}`]);
        assert.deepEqual(batchReceipt.rejectedTargets, [
          `item:${annotation.id}`,
        ]);
        assert.equal(batchReceipt.reasons[0], reason);

        // The highlight moved on its own, out of every folder.
        const direct = await file("move-annotation", {
          mode: "move",
          from: "all",
          itemIds: [annotation.id],
          targetCollectionId: destination.id,
        });
        assert.deepEqual(await membership(annotation.id), []);
        const [directReceipt] = direct.actionReceipts!;
        assert.equal(directReceipt.status, "failed");
        assert.equal(directReceipt.verification, "not_applicable");
        assert.deepEqual(directReceipt.rejectedTargets, [
          `item:${annotation.id}`,
        ]);
        assert.deepEqual(directReceipt.reasons, [reason]);

        // What the reader sees: the paper's row, the refused highlight on a
        // row of its own beneath it with the reason, and no "Unverified".
        const panel = await workflow.renderPanelForItem(paper.id);
        root = workflow.renderToolResultForPanel(panel.panelId, direct, {
          priorResults: [batch],
          userText: "Sort my unfiled papers into topic folders",
        });
        assert.exists(root);
        const card = root!.querySelector<HTMLElement>(
          ".llm-agent-action-summary-card",
        );
        assert.exists(card, "the filed paper is reported");
        const skipped = [
          ...card!.querySelectorAll<HTMLElement>(".llm-at-row-skip"),
        ] as HTMLElement[];
        assert.lengthOf(skipped, 1, card!.textContent || "");
        assert.include(skipped[0].textContent || "", reason);
        assert.notInclude(
          root!.textContent || "",
          "Unverified",
          "a refused annotation is not an unverified change",
        );
      } finally {
        root?.remove();
        setOriginalAgentPermissionMode(originalMode);
        await workflow.reset();
        for (const item of [annotation, attachment]) {
          try {
            if (Zotero.Items.get(item.id)) await item.eraseTx();
          } catch {
            /* best effort; the paper's own cleanup takes its children */
          }
        }
        await IOUtils.remove(pdfPath, { ignoreAbsent: true });
      }
    });
  });

  // ── Stage 1: the search vocabulary ────────────────────────────────────────

  describe("advanced search conditions", function () {
    it("preserves isRequired through both search tools and native persistence", async function () {
      const included = await makeItem(
        "journalArticle",
        "RequiredClause SharedClause",
      );
      const excluded = await makeItem("journalArticle", "SharedClause");
      const g = gateway();
      const conditions = [
        {
          condition: "title",
          operator: "contains",
          value: "RequiredClause",
          isRequired: true,
        },
        {
          condition: "title",
          operator: "contains",
          value: `SharedClause-${SUFFIX}`,
        },
      ];
      const query = createLibrarySearchTool(g).validate({
        entity: "items",
        mode: "search",
        conditions,
        joinMode: "any",
      });
      assert.isTrue(query.ok);
      if (!query.ok) return;
      const result = await g.searchItemsByConditions({
        libraryID: libraryID(),
        conditions: query.value.conditions!,
        joinMode: query.value.joinMode,
      });
      assert.include(
        result.items.map((item) => item.itemId),
        included.id,
      );
      assert.notInclude(
        result.items.map((item) => item.itemId),
        excluded.id,
      );

      const parsed = createSavedSearchTool(g).validate({
        action: "save",
        name: `RequiredClause-${SUFFIX}`,
        conditions,
        joinMode: "any",
      });
      assert.isTrue(parsed.ok);
      if (!parsed.ok || parsed.value.operation.type !== "save_saved_search")
        return;
      const saved = await g.saveSavedSearch({
        ...parsed.value.operation,
        libraryID: libraryID(),
      });
      created.searches.push(saved.savedSearchId);
      if (Zotero.SearchConditions.get("groupStart")) {
        // Zotero 10 dropped the `required` column; the mandatory clause is
        // the one left outside the nested OR group.
        const rows = await Zotero.DB.queryAsync(
          "SELECT condition, operator, value FROM savedSearchConditions WHERE savedSearchID=? ORDER BY searchConditionID",
          [saved.savedSearchId],
        );
        assert.deepEqual(
          rows.map((row: any) => [row.condition, row.operator, row.value]),
          [
            ["joinMode", "all", null],
            ["title", "contains", "RequiredClause"],
            ["groupStart", "true", null],
            ["joinMode", "any", null],
            ["title", "contains", `SharedClause-${SUFFIX}`],
            ["groupEnd", "true", null],
          ],
        );
      } else {
        const required = await Zotero.DB.valueQueryAsync(
          "SELECT required FROM savedSearchConditions WHERE savedSearchID=? AND condition=? AND value=?",
          [saved.savedSearchId, "title", "RequiredClause"],
        );
        assert.equal(Number(required), 1, "the mandatory clause must persist");
      }
      const savedIds = (
        await Zotero.Searches.get(saved.savedSearchId).search()
      ).map(Number);
      assert.include(savedIds, included.id);
      assert.notInclude(savedIds, excluded.id);
    });

    it("returns the same ids as a raw Zotero.Search", async function () {
      const item = await makeItem("journalArticle", "ConditionProbe");

      const raw = new Zotero.Search({ libraryID: libraryID() });
      raw.addCondition("title", "contains", `ConditionProbe-${SUFFIX}`);
      const rawIds: number[] = await raw.search();

      const viaTool = await gateway().searchItemsByConditions({
        libraryID: libraryID(),
        conditions: [
          {
            condition: "title",
            operator: "contains",
            value: `ConditionProbe-${SUFFIX}`,
          },
        ],
      });

      assert.include(rawIds.map(Number), item.id);
      assert.sameMembers(
        viaTool.items.map((entry) => entry.itemId),
        rawIds.map(Number),
      );
    });

    it("rejects a bad operator with the ones that condition accepts", async function () {
      let message = "";
      try {
        await gateway().searchItemsByConditions({
          libraryID: libraryID(),
          // The exact pairing that silently broke every year-filtered search.
          conditions: [
            { condition: "year", operator: "isGreaterThan", value: "2020" },
          ],
        });
      } catch (error) {
        message = String((error as Error)?.message || error);
      }
      assert.include(message, "Valid operators");
    });

    it("lists the trash, which nothing could enumerate before", async function () {
      const item = await makeItem("journalArticle", "TrashProbe");
      item.deleted = true;
      await item.saveTx();

      const result = await gateway().listItemsByFilters({
        libraryID: libraryID(),
        filters: { deleted: true },
      });
      assert.include(
        result.items.map((entry) => entry.itemId),
        item.id,
        "a trashed item must be reachable, or restore is unusable",
      );
    });
  });

  // ── Stage 0f: the year-filter regression ──────────────────────────────────

  describe("a text search combined with a year filter", function () {
    it("returns matches instead of always reporting none", async function () {
      const item = await makeItem("journalArticle", "YearProbe");
      item.setField("date", "2021-05-01");
      await item.saveTx();

      const result = await gateway().searchAllLibraryItems({
        libraryID: libraryID(),
        query: `YearProbe-${SUFFIX}`,
        filters: { yearFrom: 2020, yearTo: 2023 },
      });

      // Before the fix this was ALWAYS zero, on every library.
      assert.isAtLeast(result.totalCount, 1);
      assert.include(
        result.items.map((entry) => entry.itemId),
        item.id,
      );
    });

    it("still excludes items outside the range", async function () {
      const item = await makeItem("journalArticle", "OldProbe");
      item.setField("date", "1999-01-01");
      await item.saveTx();

      const result = await gateway().searchAllLibraryItems({
        libraryID: libraryID(),
        query: `OldProbe-${SUFFIX}`,
        filters: { yearFrom: 2020 },
      });
      assert.notInclude(
        result.items.map((entry) => entry.itemId),
        item.id,
      );
    });
  });

  // ── W1: filters next to conditions, and pages past a limit ────────────────

  describe("library_search filters and paging", function () {
    // Full-text words are letters only, so the run suffix is spelled out.
    const WORD = `drift${SUFFIX.replace(/\d/g, (digit) =>
      String.fromCharCode(97 + Number(digit)),
    )}`;

    function searchTool() {
      return Zotero.LLMForZotero.api.agent.getToolDefinition("library_search");
    }

    async function runSearch(args: Record<string, unknown>) {
      const tool = searchTool();
      const parsed = tool.validate({ libraryID: libraryID(), ...args });
      assert.isTrue(parsed.ok, JSON.stringify(parsed));
      return (await tool.execute(parsed.value, {
        request: {
          conversationKey: 1,
          libraryID: libraryID(),
          mode: "agent",
          userText: "Search the library",
        },
        item: null,
        modelName: "workflow",
        currentAnswerText: "",
      } as never)) as any;
    }

    async function attachIndexedText(parentItemID: number, body: string) {
      const path = PathUtils.join(
        Zotero.getTempDirectory().path,
        `fulltext-${parentItemID}-${SUFFIX}.txt`,
      );
      await IOUtils.writeUTF8(path, body);
      const attachment = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID,
      });
      await IOUtils.remove(path, { ignoreAbsent: true });
      created.items.push(attachment.id);
      await Zotero.Fulltext.indexItems([attachment.id]);
      return attachment;
    }

    /** Walks every page with offset and returns each page's result. */
    async function walk(args: Record<string, unknown>) {
      const pages: any[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined && pages.length < 20) {
        const page = await runSearch({ ...args, offset });
        pages.push(page);
        offset = page.nextOffset;
      }
      return pages;
    }

    it("keeps a full-text match to filters.collectionId", async function () {
      const collection = await makeCollection("Fulltext-Scope");
      const inside = await makeItem("journalArticle", "Fulltext inside");
      const outside = await makeItem("journalArticle", "Fulltext outside");
      const insideNoHit = await makeItem("journalArticle", "Fulltext no hit");
      for (const paper of [inside, insideNoHit]) {
        paper.addToCollection(collection.id);
        await paper.saveTx();
      }
      const insidePdf = await attachIndexedText(inside.id, `About ${WORD}.`);
      const outsidePdf = await attachIndexedText(outside.id, `Also ${WORD}.`);
      await attachIndexedText(insideNoHit.id, "Nothing relevant here.");

      // Native readback: the word is indexed on both attachments, and the
      // collection holds the two papers that were filed.
      const raw = new Zotero.Search({ libraryID: libraryID() });
      raw.addCondition("fulltextContent", "contains", WORD);
      assert.sameMembers((await raw.search()).map(Number), [
        insidePdf.id,
        outsidePdf.id,
      ]);
      const members = (
        (await Zotero.DB.columnQueryAsync(
          "SELECT itemID FROM collectionItems WHERE collectionID=?",
          [collection.id],
        )) || []
      ).map(Number);
      assert.sameMembers(members, [inside.id, insideNoHit.id]);

      const conditions = [
        { condition: "fulltextContent", operator: "contains", value: WORD },
      ];
      const unscoped = await runSearch({
        entity: "items",
        mode: "search",
        conditions,
        resolveToParents: true,
      });
      assert.sameMembers(
        unscoped.results.map((row: any) => row.itemId),
        [inside.id, outside.id],
      );

      const scoped = await runSearch({
        entity: "items",
        mode: "search",
        conditions,
        resolveToParents: true,
        filters: { collectionId: collection.id },
      });
      assert.deepEqual(
        scoped.results.map((row: any) => row.itemId),
        [inside.id],
      );
      assert.equal(scoped.totalCount, 1);
      assert.isFalse(scoped.limited);
    });

    it("reports the true notes total past the limit and pages every note", async function () {
      const parent = await makeItem("journalArticle", "Paged notes parent");
      const noteIds: number[] = [];
      for (let index = 0; index < 7; index += 1) {
        const note = new Zotero.Item("note");
        note.libraryID = libraryID();
        if (index % 2) note.parentID = parent.id;
        note.setNote(`<h1>Paged note ${index} ${WORD}</h1>`);
        await note.saveTx();
        created.items.push(note.id);
        noteIds.push(note.id);
      }
      // Native readback of what a notes search should find.
      const raw = new Zotero.Search({ libraryID: libraryID() });
      raw.addCondition("itemType", "is", "note");
      raw.addCondition("quicksearch-everything", "contains", WORD);
      assert.sameMembers((await raw.search()).map(Number), noteIds);

      const args = { entity: "notes", mode: "search", text: WORD, limit: 3 };
      const pages = await walk(args);
      assert.equal(pages.length, 3);
      assert.deepEqual(
        pages.map((page) => page.totalCount),
        [7, 7, 7],
      );
      assert.deepEqual(
        pages.map((page) => page.limited),
        [true, true, false],
      );
      assert.deepEqual(
        pages.map((page) => page.returnedCount),
        [3, 3, 1],
      );
      const seen = pages.flatMap((page) =>
        page.results.map((row: any) => row.itemId),
      );
      assert.lengthOf(seen, 7, "no note appears on two pages");
      assert.sameMembers(seen, noteIds);
    });

    it("pages the standalone notes list so every note appears exactly once", async function () {
      const collection = await makeCollection("Paged-Note-List");
      const noteIds: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const note = new Zotero.Item("note");
        note.libraryID = libraryID();
        note.addToCollection(collection.id);
        note.setNote(`<h1>Listed note ${index} ${SUFFIX}</h1>`);
        await note.saveTx();
        created.items.push(note.id);
        noteIds.push(note.id);
      }
      // Native readback: the collection holds exactly these standalone notes.
      const native = (
        (await Zotero.DB.columnQueryAsync(
          "SELECT itemID FROM collectionItems WHERE collectionID=?",
          [collection.id],
        )) || []
      )
        .map(Number)
        .filter((id: number) => Zotero.Items.get(id)?.isNote());
      assert.sameMembers(native, noteIds);

      const pages = await walk({
        entity: "notes",
        mode: "list",
        filters: { collectionId: collection.id },
        limit: 2,
      });
      assert.equal(pages.length, 3);
      assert.deepEqual(
        pages.map((page) => page.totalCount),
        [5, 5, 5],
      );
      assert.deepEqual(
        pages.map((page) => page.limited),
        [true, true, false],
      );
      assert.deepEqual(
        pages.map((page) => page.nextOffset),
        [2, 4, undefined],
      );
      const seen = pages.flatMap((page) =>
        page.results.map((row: any) => row.itemId),
      );
      assert.lengthOf(seen, 5, "no note appears on two pages");
      assert.sameMembers(seen, noteIds);
    });

    it("reports the true tag total past the limit and pages every tag", async function () {
      const holder = await makeItem("journalArticle", "Paged tags holder");
      const prefix = `tagpage-${SUFFIX}`;
      const names = Array.from({ length: 5 }, (_v, i) => `${prefix}-${i}`);
      for (const name of names) {
        holder.addTag(name);
        created.tags.push(name);
      }
      await holder.saveTx();
      // Native readback: Zotero holds exactly these five tags for the prefix.
      const native = (await Zotero.Tags.getAll(libraryID()))
        .map((tag: { tag: string }) => tag.tag)
        .filter((name: string) => name.startsWith(prefix));
      assert.sameMembers(native, names);

      const pages = await walk({
        entity: "tags",
        mode: "search",
        text: prefix,
        limit: 2,
      });
      assert.equal(pages.length, 3);
      assert.deepEqual(
        pages.map((page) => page.totalCount),
        [5, 5, 5],
      );
      assert.deepEqual(
        pages.map((page) => page.limited),
        [true, true, false],
      );
      assert.deepEqual(
        pages.map((page) => page.nextOffset),
        [2, 4, undefined],
      );
      const seen = pages.flatMap((page) =>
        page.results.map((row: any) => row.name),
      );
      assert.lengthOf(seen, 5, "no tag appears on two pages");
      assert.sameMembers(seen, names);
    });

    /** Zotero's own duplicate set for an item, read straight from its engine. */
    async function nativeDuplicateSet(itemID: number): Promise<number[]> {
      const engine = new Zotero.Duplicates(libraryID());
      const search = await engine.getSearchObject();
      const table = Object.values(
        search.conditions as Record<string, any>,
      ).find((condition: any) => condition.condition === "tempTable")?.value;
      try {
        await search.search();
        return engine.getSetItemsByItemID(itemID).map(Number);
      } finally {
        if (table) await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${table}`);
      }
    }

    async function makeDoiItem(title: string, doi: string) {
      const item = await makeItem("journalArticle", title);
      item.setField("DOI", doi);
      await item.saveTx();
      return item;
    }

    it("groups a metadata-only item with its PDF twin as one duplicate group", async function () {
      const doi = `10.5555/${SUFFIX}.twin`;
      const bare = await makeDoiItem("Duplicate twin record", doi);
      const withPdf = await makeDoiItem("Duplicate twin with file", doi);
      const pdf = await PDFDocument.create();
      pdf.addPage([612, 792]);
      const pdfPath = PathUtils.join(
        Zotero.getTempDirectory().path,
        `duplicate-twin-${SUFFIX}.pdf`,
      );
      await IOUtils.write(pdfPath, await pdf.save());
      const attachment = await Zotero.Attachments.importFromFile({
        file: pdfPath,
        parentItemID: withPdf.id,
      });
      await IOUtils.remove(pdfPath, { ignoreAbsent: true });
      created.items.push(attachment.id);

      // Native readback: only one twin has a file, and Zotero's own engine
      // puts both in one set.
      assert.lengthOf(Zotero.Items.get(bare.id).getAttachments(), 0);
      assert.deepEqual(Zotero.Items.get(withPdf.id).getAttachments(), [
        attachment.id,
      ]);
      assert.sameMembers(await nativeDuplicateSet(bare.id), [
        bare.id,
        withPdf.id,
      ]);

      const pages = await walk({
        entity: "items",
        mode: "duplicates",
        limit: 50,
      });
      const groups = pages.flatMap((page) => page.results);
      const ours = groups.filter((group: any) =>
        group.papers.some((paper: any) =>
          [bare.id, withPdf.id].includes(paper.itemId),
        ),
      );
      assert.lengthOf(ours, 1, "both twins sit in a single group");
      assert.sameMembers(
        ours[0].papers.map((paper: any) => paper.itemId),
        [bare.id, withPdf.id],
      );
      assert.equal(ours[0].matchReason, `Same DOI: ${doi.toLowerCase()}`);
      const byId = new Map(
        ours[0].papers.map((paper: any) => [paper.itemId, paper]),
      );
      assert.lengthOf((byId.get(bare.id) as any).attachments, 0);
      assert.deepEqual(
        (byId.get(withPdf.id) as any).attachments.map(
          (entry: any) => entry.contextItemId,
        ),
        [attachment.id],
      );
    });

    it("reports the true duplicate group total and pages every group once", async function () {
      const baseline = (
        await runSearch({ entity: "items", mode: "duplicates", limit: 1 })
      ).totalCount as number;
      const pairs: Array<[number, number]> = [];
      for (let index = 0; index < 7; index += 1) {
        const doi = `10.5555/${SUFFIX}.page${index}`;
        const first = await makeDoiItem(`Paged duplicate ${index} first`, doi);
        const second = await makeDoiItem(
          `Paged duplicate ${index} second`,
          doi,
        );
        pairs.push([first.id, second.id]);
      }
      // Native readback: Zotero's engine pairs each fixture, and only it.
      for (const pair of pairs) {
        assert.sameMembers(await nativeDuplicateSet(pair[0]), pair);
      }

      const total = baseline + 7;
      const pages = await walk({
        entity: "items",
        mode: "duplicates",
        limit: 3,
      });
      const pageCount = Math.ceil(total / 3);
      assert.lengthOf(pages, pageCount);
      for (const [index, page] of pages.entries()) {
        const isLast = index === pageCount - 1;
        assert.equal(page.totalCount, total);
        assert.equal(page.totalGroups, total);
        assert.equal(page.offset, index * 3);
        assert.equal(page.limited, !isLast);
        assert.equal(page.nextOffset, isLast ? undefined : (index + 1) * 3);
      }
      assert.equal(pages[0].returnedCount, Math.min(3, total));
      const groups = pages.flatMap((page) => page.results);
      assert.lengthOf(groups, total);
      const allIds = groups.flatMap((group: any) =>
        group.papers.map((paper: any) => paper.itemId),
      );
      assert.equal(
        new Set(allIds).size,
        allIds.length,
        "no item appears in two groups or on two pages",
      );
      for (const pair of pairs) {
        const group = groups.find((entry: any) =>
          entry.papers.some((paper: any) => paper.itemId === pair[0]),
        );
        assert.exists(group);
        assert.sameMembers(
          group.papers.map((paper: any) => paper.itemId),
          pair,
        );
      }
    });

    it("returns the next rows on text-search page 2", async function () {
      const ids: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        ids.push((await makeItem("journalArticle", `PageProbe ${index}`)).id);
      }
      const text = `PageProbe`;
      const all = await runSearch({
        entity: "items",
        mode: "search",
        text: `${text} ${SUFFIX}`,
        limit: 50,
      });
      const allIds = all.results.map((row: any) => row.itemId);
      assert.sameMembers(allIds, ids);
      assert.equal(all.totalCount, 5);

      const pageArgs = {
        entity: "items",
        mode: "search",
        text: `${text} ${SUFFIX}`,
        limit: 2,
      };
      const first = await runSearch({ ...pageArgs });
      const second = await runSearch({ ...pageArgs, offset: 2 });
      assert.deepEqual(
        first.results.map((row: any) => row.itemId),
        allIds.slice(0, 2),
      );
      assert.deepEqual(
        second.results.map((row: any) => row.itemId),
        allIds.slice(2, 4),
      );
      assert.equal(second.totalCount, 5);
      assert.isTrue(second.limited);
      assert.equal(second.nextOffset, 4);
      const last = await runSearch({ ...pageArgs, offset: 4 });
      assert.deepEqual(
        last.results.map((row: any) => row.itemId),
        allIds.slice(4),
      );
      assert.isFalse(last.limited);
    });
  });

  // ── Stage 2: metadata beyond the allowlist ────────────────────────────────

  describe("metadata fields", function () {
    it("writes a base field under its type-specific name", async function () {
      const item = await makeItem("bookSection", "BookSection");

      await gateway().updateArticleMetadata({
        item,
        metadata: { publicationTitle: `Handbook-${SUFFIX}` } as never,
      });

      const fresh = Zotero.Items.get(item.id);
      // publicationTitle is stored as bookTitle on a bookSection. The old
      // guard called this invalid; setField maps it happily.
      assert.equal(fresh.getField("bookTitle"), `Handbook-${SUFFIX}`);
    });

    it("reads that base field back rather than returning empty", async function () {
      const item = await makeItem("bookSection", "ReadBack");
      item.setField("bookTitle", `ReadBackHandbook-${SUFFIX}`);
      await item.saveTx();

      const snapshot = gateway().getEditableArticleMetadata(item);
      assert.equal(
        snapshot?.fields.publicationTitle,
        `ReadBackHandbook-${SUFFIX}`,
      );
    });

    it("writes a field that was outside the old 18-name allowlist", async function () {
      const item = await makeItem("book", "PageCount");

      await gateway().updateArticleMetadata({
        item,
        metadata: { numPages: "312" } as never,
      });

      assert.equal(Zotero.Items.get(item.id).getField("numPages"), "312");
    });

    it("refuses a field the type does not have, naming what it accepts", async function () {
      const item = await makeItem("journalArticle", "BadField");
      let message = "";
      try {
        await gateway().updateArticleMetadata({
          item,
          metadata: { numPages: "312" } as never,
        });
      } catch (error) {
        message = String((error as Error)?.message || error);
      }
      assert.include(message, "numPages");
      assert.include(message, "Fields this item type accepts");
    });

    it("lists the real field set for an item type", function () {
      const result = gateway().listItemTypes({ itemType: "thesis" });
      assert.lengthOf(result.itemTypes, 1);
      assert.includeMembers(result.itemTypes[0].fields || [], [
        "title",
        "university",
      ]);
    });
  });

  // ── W1: a metadata write lands on the object it names ─────────────────────

  describe("metadata writes through library_update", function () {
    function contextFor(item: { id: number }, userText: string) {
      return {
        request: resolvedAgentRequest({
          conversationKey: item.id,
          mode: "agent",
          userText,
          libraryID: libraryID(),
          activeItemId: item.id,
          executionContext: {
            version: 1,
            executionId: `metadata-target:${SUFFIX}:${item.id}`,
            conversationKey: item.id,
            conversationGeneration: 0,
            chatLibraryID: libraryID(),
            permissionOwner: "original_agent",
            workspaceSnapshot: {
              selectedPapers: [],
              selectedCollections: [],
            },
            configuredAccess: {
              libraryIDs: [libraryID()],
              outputDirectories: [],
            },
          },
        }),
        item: Zotero.Items.get(item.id),
        modelName: "workflow",
        currentAnswerText: "",
        runId: `metadata-target-run:${SUFFIX}:${item.id}`,
      } as AgentToolContext;
    }

    async function withMode<T>(
      mode: "safe" | "yolo",
      body: (registry: AgentToolRegistry) => Promise<T>,
    ): Promise<T> {
      const originalMode = getOriginalAgentPermissionMode();
      try {
        await initAgentChangeJournal();
        setOriginalAgentPermissionMode(mode);
        const registry = new AgentToolRegistry(
          new ActionContractService(gateway()),
        );
        registry.register(
          Zotero.LLMForZotero.api.agent.getToolDefinition("library_update"),
        );
        return await body(registry);
      } finally {
        setOriginalAgentPermissionMode(originalMode);
      }
    }

    async function attachTextFile(parentItemID: number, name: string) {
      const path = PathUtils.join(
        Zotero.getTempDirectory().path,
        `${name}-${SUFFIX}.txt`,
      );
      await IOUtils.writeUTF8(path, "attachment body");
      const attachment = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID,
      });
      await IOUtils.remove(path, { ignoreAbsent: true });
      created.items.push(attachment.id);
      return attachment;
    }

    it("edits a child attachment's title on the attachment, leaving its parent alone", async function () {
      const paper = await makeItem("journalArticle", "AttachmentParent");
      const attachment = await attachTextFile(paper.id, "attachment-title");
      const parentTitle = paper.getField("title");
      const newTitle = `Renamed attachment-${SUFFIX}`;

      const result = await withMode("yolo", async (registry) => {
        const execution = await registry.prepareExecution(
          {
            id: "attachment-title",
            name: "library_update",
            arguments: {
              kind: "metadata",
              itemId: attachment.id,
              metadata: { title: newTitle },
            },
          },
          contextFor(paper, "Rename this attachment"),
          { callerKind: "model" },
        );
        assert.equal(execution.kind, "result");
        if (execution.kind !== "result") throw new Error("unreachable");
        return execution.execution.result;
      });

      assert.isTrue(result.ok, JSON.stringify(result.content));
      // Independent native readback, not the tool's account.
      assert.equal(Zotero.Items.get(attachment.id).getField("title"), newTitle);
      assert.equal(
        Zotero.Items.get(paper.id).getField("title"),
        parentTitle,
        "the parent was never the target",
      );
      const [receipt] = result.actionReceipts || [];
      assert.equal(receipt?.verification, "verified");
    });

    it("refuses a metadata edit on a standalone note, naming note_write, and changes nothing", async function () {
      const paper = await makeItem("journalArticle", "OpenPaper");
      const paperTitle = paper.getField("title");
      const note = new Zotero.Item("note");
      note.libraryID = libraryID();
      note.setNote("<p>standalone note body</p>");
      await note.saveTx();
      created.items.push(note.id);

      const result = await withMode("yolo", async (registry) => {
        const execution = await registry.prepareExecution(
          {
            id: "note-metadata",
            name: "library_update",
            arguments: {
              kind: "metadata",
              itemId: note.id,
              metadata: { title: `Should not land-${SUFFIX}` },
            },
          },
          // The open paper is what the old fallback wrote instead.
          contextFor(paper, "Retitle that note"),
          { callerKind: "model" },
        );
        assert.equal(execution.kind, "result");
        if (execution.kind !== "result") throw new Error("unreachable");
        return execution.execution.result;
      });

      assert.isFalse(result.ok);
      assert.include(JSON.stringify(result.content), "note_write");
      assert.equal(Zotero.Items.get(paper.id).getField("title"), paperTitle);
      assert.equal(
        Zotero.Items.get(note.id).getNote(),
        "<p>standalone note body</p>",
      );
    });

    it("shows a book's edition and series rows on the Safe-mode card, then applies them", async function () {
      const book = await makeItem("book", "EditionSeries");
      book.setField("edition", "1");
      book.setField("series", `Old Series-${SUFFIX}`);
      await book.saveTx();
      const workflow = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
      const doc: Document = Zotero.getMainWindow().document;
      const newSeries = `New Series-${SUFFIX}`;

      try {
        const result = await withMode("safe", async (registry) => {
          const execution = await registry.prepareExecution(
            {
              id: "edition-series",
              name: "library_update",
              arguments: {
                kind: "metadata",
                itemId: book.id,
                metadata: { edition: "2", series: newSeries },
              },
            },
            contextFor(book, "Set the edition and series"),
            { callerKind: "model" },
          );
          assert.equal(execution.kind, "confirmation", "Safe mode asks first");
          if (execution.kind !== "confirmation") throw new Error("unreachable");

          const panel = await workflow.renderPanelForItem(book.id);
          const pending = workflow.renderPendingActionForPanel(panel.panelId, {
            requestId: "edition-series-card",
            action: execution.action,
          });
          const card = doc.querySelector<HTMLElement>(
            '[data-request-id="edition-series-card"]',
          )!;
          assert.exists(card);
          const rows = (
            [
              ...card.querySelectorAll<HTMLElement>(
                ".llm-agent-hitl-review-item",
              ),
            ] as HTMLElement[]
          ).map((row) => ({
            label:
              row.querySelector(".llm-agent-hitl-review-label")?.textContent ||
              "",
            text: row.textContent || "",
          }));
          assert.deepEqual(
            rows.map((row) => row.label),
            ["Edition", "Series"],
            "every changed field has a row",
          );
          assert.include(rows[1].text, `Old Series-${SUFFIX}`);
          assert.include(rows[1].text, newSeries);
          assert.equal(
            Zotero.Items.get(book.id).getField("edition"),
            "1",
            "the card itself writes nothing",
          );

          card.querySelector<HTMLButtonElement>('[data-kind="save"]')!.click();
          const resolution = await pending;
          assert.isTrue(resolution.approved);
          const applied = await execution.execute(resolution);
          assert.equal(applied.kind, "result");
          if (applied.kind !== "result") throw new Error("unreachable");
          return applied.execution.result;
        });

        assert.isTrue(result.ok, JSON.stringify(result.content));
        const fresh = Zotero.Items.get(book.id);
        assert.equal(fresh.getField("edition"), "2");
        assert.equal(fresh.getField("series"), newSeries);
      } finally {
        await workflow.reset();
      }
    });

    it("shows a named item's before values on the literature-search card and writes that item, not the open paper", async function () {
      const paperA = await makeItem("journalArticle", "OpenPaperA");
      paperA.setField("date", "2020");
      paperA.setField("DOI", `10.1/a-${SUFFIX}`);
      await paperA.saveTx();
      const paperB = await makeItem("journalArticle", "NamedPaperB");
      paperB.setField("date", "2020");
      await paperB.saveTx();
      const aTitle = paperA.getField("title");
      const bTitle = paperB.getField("title");
      const newTitle = `Corrected B-${SUFFIX}`;
      const newDoi = `10.1/b-${SUFFIX}`;

      // Paper A is open and is the turn's paper; the call names paper B.
      const base = contextFor(paperA, "Fix the other paper's metadata");
      const context = {
        ...base,
        request: resolvedAgentRequest({
          ...base.request,
          selectedPaperContexts: [
            { itemId: paperA.id, contextItemId: paperA.id, title: aTitle },
          ],
        }),
      } as AgentToolContext;
      const search =
        Zotero.LLMForZotero.api.agent.getToolDefinition("literature_search");
      const input = { workflow: "review", mode: "metadata", itemId: paperB.id };
      // A translator result for B, as the network lookup would return it.
      const searchResult: AgentToolResult = {
        callId: "lit-named",
        name: "literature_search",
        ok: true,
        actionReceipts: [],
        content: {
          workflow: "review",
          mode: "metadata",
          results: [
            {
              source: "Zotero translator",
              title: newTitle,
              patch: { title: newTitle, date: "2020", DOI: newDoi },
            },
          ],
        },
      };

      const card = await search.createResultReviewAction(
        input,
        searchResult,
        context,
      );
      const diff = card?.fields.find(
        (field: { id: string }) => field.id === "metadataDiff",
      ) as { rows: Array<{ key: string; before?: string; after: string }> };
      assert.exists(diff, "the high-confidence card shows a diff");
      assert.deepEqual(
        diff.rows.map((row) => [row.key, row.before, row.after]),
        [
          ["title", bTitle, newTitle],
          ["DOI", "", newDoi],
        ],
        "before values are paper B's, and no row is hidden by paper A's",
      );

      const resolved = await search.resolveResultReview(
        input,
        searchResult,
        { approved: true, actionId: "apply_direct" },
        context,
      );
      assert.equal(resolved.kind, "invoke_tool");
      const call = resolved.call as {
        name: string;
        arguments: Record<string, unknown>;
        inheritedApproval: Record<string, unknown>;
      };
      assert.equal(call.arguments.itemId, paperB.id);

      const result = await withMode("safe", async (registry) => {
        const execution = await registry.prepareExecution(
          { id: "lit-named-apply", name: call.name, arguments: call.arguments },
          context,
          {
            callerKind: "model",
            inheritedApproval: {
              ...call.inheritedApproval,
              approvedCallDigest: buildActionCallDigest(
                call.name,
                call.arguments,
              ),
            } as never,
          },
        );
        assert.equal(execution.kind, "result", "the card was the approval");
        if (execution.kind !== "result") throw new Error("unreachable");
        return execution.execution.result;
      });

      assert.isTrue(result.ok, JSON.stringify(result.content));
      // Independent native readback, not the tool's account.
      const freshB = Zotero.Items.get(paperB.id);
      assert.equal(freshB.getField("title"), newTitle);
      assert.equal(freshB.getField("DOI"), newDoi);
      const freshA = Zotero.Items.get(paperA.id);
      assert.equal(freshA.getField("title"), aTitle, "the open paper is left");
      assert.equal(freshA.getField("DOI"), `10.1/a-${SUFFIX}`);
      const [receipt] = result.actionReceipts || [];
      assert.equal(receipt?.verification, "verified");
    });
  });

  describe("merging duplicate groups with one approval", function () {
    function contextFor(item: { id: number }, userText: string) {
      return {
        request: resolvedAgentRequest({
          conversationKey: item.id,
          mode: "agent",
          userText,
          libraryID: libraryID(),
          activeItemId: item.id,
          executionContext: {
            version: 1,
            executionId: `merge-groups:${SUFFIX}:${item.id}`,
            conversationKey: item.id,
            conversationGeneration: 0,
            chatLibraryID: libraryID(),
            permissionOwner: "original_agent",
            workspaceSnapshot: {
              selectedPapers: [],
              selectedCollections: [],
            },
            configuredAccess: {
              libraryIDs: [libraryID()],
              outputDirectories: [],
            },
          },
        }),
        item: Zotero.Items.get(item.id),
        modelName: "workflow",
        currentAnswerText: "",
        runId: `merge-groups-run:${SUFFIX}:${item.id}`,
      } as AgentToolContext;
    }

    async function withMode<T>(
      mode: "safe" | "yolo",
      body: (registry: AgentToolRegistry) => Promise<T>,
    ): Promise<T> {
      const originalMode = getOriginalAgentPermissionMode();
      try {
        await initAgentChangeJournal();
        setOriginalAgentPermissionMode(mode);
        const registry = new AgentToolRegistry(
          new ActionContractService(gateway()),
        );
        registry.register(
          Zotero.LLMForZotero.api.agent.getToolDefinition("library_delete"),
        );
        return await body(registry);
      } finally {
        setOriginalAgentPermissionMode(originalMode);
      }
    }

    async function addNote(parentItemID: number) {
      const note = new Zotero.Item("note");
      note.libraryID = libraryID();
      note.parentID = parentItemID;
      note.setNote(`<p>note on ${parentItemID}</p>`);
      await note.saveTx();
      created.items.push(note.id);
      return note;
    }

    async function addAttachment(parentItemID: number) {
      const path = PathUtils.join(
        Zotero.getTempDirectory().path,
        `merge-${parentItemID}-${SUFFIX}.txt`,
      );
      await IOUtils.writeUTF8(path, `attachment body ${parentItemID}`);
      const attachment = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID,
      });
      await IOUtils.remove(path, { ignoreAbsent: true });
      created.items.push(attachment.id);
      return attachment;
    }

    /** A master and its duplicates, all one title so they are duplicates. */
    async function makeGroup(name: string, duplicates: number) {
      const master = await makeItem("journalArticle", name);
      const others = [];
      for (let index = 0; index < duplicates; index += 1)
        others.push(await makeItem("journalArticle", name));
      return { master, others };
    }

    function groupArgs(group: {
      master: { id: number };
      others: Array<{ id: number }>;
    }) {
      return {
        masterItemId: group.master.id,
        otherItemIds: group.others.map((item) => item.id),
      };
    }

    function trashed(itemId: number): boolean {
      return Boolean(Zotero.Items.get(itemId)?.deleted);
    }

    it("merges three groups from one card: every master kept, every duplicate trashed, children moved", async function () {
      const groups = [
        await makeGroup("MergeGroupOne", 2),
        await makeGroup("MergeGroupTwo", 1),
        await makeGroup("MergeGroupThree", 1),
      ];
      const note = await addNote(groups[0].others[0].id);
      const attachment = await addAttachment(groups[0].others[1].id);
      const secondNote = await addNote(groups[1].others[0].id);
      const secondAttachment = await addAttachment(groups[2].others[0].id);
      const workflow = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
      const doc: Document = Zotero.getMainWindow().document;

      try {
        const result = await withMode("safe", async (registry) => {
          const execution = await registry.prepareExecution(
            {
              id: "merge-three-groups",
              name: "library_delete",
              arguments: { mode: "merge", groups: groups.map(groupArgs) },
            },
            contextFor(groups[0].master, "Merge these duplicates"),
            { callerKind: "model" },
          );
          assert.equal(execution.kind, "confirmation", "one card for all");
          if (execution.kind !== "confirmation") throw new Error("unreachable");

          const panel = await workflow.renderPanelForItem(groups[0].master.id);
          const pending = workflow.renderPendingActionForPanel(panel.panelId, {
            requestId: "merge-three-groups-card",
            action: execution.action,
          });
          const card = doc.querySelector<HTMLElement>(
            '[data-request-id="merge-three-groups-card"]',
          )!;
          assert.exists(card);
          const checklists = [
            ...card.querySelectorAll<HTMLElement>(".llm-agent-hitl-checklist"),
          ] as HTMLElement[];
          assert.deepEqual(
            checklists.map((list) =>
              (
                [
                  ...list.querySelectorAll<HTMLInputElement>(
                    ".llm-agent-hitl-checklist-checkbox",
                  ),
                ] as HTMLInputElement[]
              ).map((box) => Number(box.value)),
            ),
            groups.map((group) => group.others.map((item) => item.id)),
            "each group lists its own duplicates",
          );
          assert.equal(
            (card.textContent || "").split("not fully reversible").length - 1,
            1,
            "the irreversibility warning appears once",
          );
          assert.isFalse(
            trashed(groups[0].others[0].id),
            "the card writes nothing",
          );

          card.querySelector<HTMLButtonElement>('[data-kind="save"]')!.click();
          const resolution = await pending;
          assert.isTrue(resolution.approved);
          const applied = await execution.execute(resolution);
          assert.equal(applied.kind, "result", "one approval runs every group");
          if (applied.kind !== "result") throw new Error("unreachable");
          return applied.execution.result;
        });

        assert.isTrue(result.ok, JSON.stringify(result.content));
        // Independent native readback, not the tool's account.
        for (const group of groups) {
          const master = Zotero.Items.get(group.master.id);
          assert.exists(master);
          assert.isFalse(Boolean(master.deleted), "the master is kept");
          for (const other of group.others)
            assert.isTrue(trashed(other.id), `duplicate ${other.id} trashed`);
        }
        assert.equal(Zotero.Items.get(note.id).parentID, groups[0].master.id);
        assert.equal(
          Zotero.Items.get(attachment.id).parentID,
          groups[0].master.id,
        );
        assert.equal(
          Zotero.Items.get(secondNote.id).parentID,
          groups[1].master.id,
        );
        assert.equal(
          Zotero.Items.get(secondAttachment.id).parentID,
          groups[2].master.id,
        );
        const receipts = result.actionReceipts || [];
        assert.lengthOf(receipts, 3, "one receipt per group");
        assert.deepEqual(
          receipts.map((receipt) => receipt.verification),
          ["verified", "verified", "verified"],
        );
      } finally {
        await workflow.reset();
      }
    });

    it("leaves an unchecked duplicate untrashed, and a group with nothing checked unmerged", async function () {
      const first = await makeGroup("MergeUncheckOne", 2);
      const second = await makeGroup("MergeUncheckTwo", 1);
      const kept = first.others[1];
      const workflow = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
      const doc: Document = Zotero.getMainWindow().document;

      try {
        const result = await withMode("safe", async (registry) => {
          const execution = await registry.prepareExecution(
            {
              id: "merge-unchecked",
              name: "library_delete",
              arguments: {
                mode: "merge",
                groups: [groupArgs(first), groupArgs(second)],
              },
            },
            contextFor(first.master, "Merge these duplicates"),
            { callerKind: "model" },
          );
          assert.equal(execution.kind, "confirmation");
          if (execution.kind !== "confirmation") throw new Error("unreachable");

          const panel = await workflow.renderPanelForItem(first.master.id);
          const pending = workflow.renderPendingActionForPanel(panel.panelId, {
            requestId: "merge-unchecked-card",
            action: execution.action,
          });
          const card = doc.querySelector<HTMLElement>(
            '[data-request-id="merge-unchecked-card"]',
          )!;
          const uncheck = (itemId: number) => {
            const box = card.querySelector<HTMLInputElement>(
              `.llm-agent-hitl-checklist-checkbox[value="${itemId}"]`,
            )!;
            box.checked = false;
            box.dispatchEvent(new Event("change", { bubbles: true }));
          };
          uncheck(kept.id);
          uncheck(second.others[0].id);
          const save =
            card.querySelector<HTMLButtonElement>('[data-kind="save"]')!;
          assert.isFalse(
            save.disabled,
            "a group left with nothing checked does not block the others",
          );
          save.click();
          const resolution = await pending;
          assert.isTrue(resolution.approved);
          const applied = await execution.execute(resolution);
          assert.equal(applied.kind, "result");
          if (applied.kind !== "result") throw new Error("unreachable");
          return applied.execution.result;
        });

        assert.isTrue(result.ok, JSON.stringify(result.content));
        assert.isTrue(trashed(first.others[0].id), "the checked one merged");
        assert.isFalse(trashed(kept.id), "the unchecked duplicate stays");
        assert.isFalse(
          trashed(second.others[0].id),
          "the unchecked group merged nothing",
        );
        assert.isFalse(Boolean(Zotero.Items.get(second.master.id).deleted));
      } finally {
        await workflow.reset();
      }
    });

    it("reports exact per-group results when a group fails mid-batch, keeps earlier merges, and retries only the rest", async function () {
      const groups = [
        await makeGroup("MergeFailOne", 1),
        await makeGroup("MergeFailTwo", 2),
        await makeGroup("MergeFailThree", 1),
      ];
      const vanishing = groups[1].others[0];
      // The duplicate disappears while the batch runs, after the first
      // group's real merge and before the second group starts.
      const realMerge = Zotero.Items.merge;
      let merges = 0;
      Zotero.Items.merge = async function (...args: unknown[]) {
        const merged = await realMerge.apply(Zotero.Items, args);
        merges += 1;
        if (merges === 1) await Zotero.Items.get(vanishing.id).eraseTx();
        return merged;
      };
      let result: AgentToolResult;
      try {
        result = await withMode("yolo", async (registry) => {
          const execution = await registry.prepareExecution(
            {
              id: "merge-fails-midway",
              name: "library_delete",
              arguments: { mode: "merge", groups: groups.map(groupArgs) },
            },
            contextFor(groups[0].master, "Merge these duplicates"),
            { callerKind: "model" },
          );
          assert.equal(execution.kind, "result");
          if (execution.kind !== "result") throw new Error("unreachable");
          return execution.execution.result;
        });
      } finally {
        Zotero.Items.merge = realMerge;
      }

      const content = result.content as {
        groups: Array<{ masterItemId: number; status: string; error?: string }>;
        remainingGroups: Array<{
          masterItemId: number;
          otherItemIds: number[];
        }>;
      };
      assert.isTrue(result.ok, JSON.stringify(result.content));
      assert.equal(result.effect, "partial");
      assert.deepEqual(
        content.groups.map((group) => [group.masterItemId, group.status]),
        [
          [groups[0].master.id, "merged"],
          [groups[1].master.id, "failed"],
          [groups[2].master.id, "not_run"],
        ],
      );
      assert.include(content.groups[1].error, String(vanishing.id));
      assert.deepEqual(
        content.remainingGroups,
        [groupArgs(groups[1]), groupArgs(groups[2])],
        "exactly the groups that did not merge",
      );
      // Native state: the first group stays merged; nothing after it moved.
      assert.isTrue(trashed(groups[0].others[0].id));
      assert.isFalse(trashed(groups[1].others[1].id));
      assert.isFalse(trashed(groups[2].others[0].id));
      const receipts = result.actionReceipts || [];
      assert.lengthOf(receipts, 3);
      assert.equal(receipts[0].verification, "verified");
      assert.notEqual(receipts[1].verification, "verified");
      assert.notEqual(receipts[2].verification, "verified");

      // A retry that repeats the merged group is refused before any write.
      const repeated = await withMode("yolo", async (registry) => {
        const execution = await registry.prepareExecution(
          {
            id: "merge-retry-repeats",
            name: "library_delete",
            arguments: {
              mode: "merge",
              groups: [
                groupArgs(groups[0]),
                {
                  masterItemId: groups[1].master.id,
                  otherItemIds: [groups[1].others[1].id],
                },
              ],
            },
          },
          contextFor(groups[0].master, "Merge the rest"),
          { callerKind: "model" },
        );
        if (execution.kind !== "result") throw new Error("unreachable");
        return execution.execution.result;
      });
      assert.isFalse(repeated.ok);
      assert.include(JSON.stringify(repeated.content), "already in the trash");
      assert.isFalse(
        trashed(groups[1].others[1].id),
        "the refusal wrote nothing",
      );

      // The retry of the remaining groups merges exactly those.
      const retried = await withMode("yolo", async (registry) => {
        const execution = await registry.prepareExecution(
          {
            id: "merge-retry-rest",
            name: "library_delete",
            arguments: {
              mode: "merge",
              groups: [
                {
                  masterItemId: groups[1].master.id,
                  otherItemIds: [groups[1].others[1].id],
                },
                groupArgs(groups[2]),
              ],
            },
          },
          contextFor(groups[0].master, "Merge the rest"),
          { callerKind: "model" },
        );
        if (execution.kind !== "result") throw new Error("unreachable");
        return execution.execution.result;
      });
      assert.isTrue(retried.ok, JSON.stringify(retried.content));
      assert.isTrue(trashed(groups[1].others[1].id));
      assert.isTrue(trashed(groups[2].others[0].id));
      assert.isFalse(Boolean(Zotero.Items.get(groups[1].master.id).deleted));
      assert.isFalse(Boolean(Zotero.Items.get(groups[2].master.id).deleted));
    });
  });

  // ── Stage 2e: create / reparent / relate ──────────────────────────────────

  describe("creating and restructuring items", function () {
    it("creates an item of a type the agent could not produce before", async function () {
      const result = await gateway().createItems({
        libraryID: libraryID(),
        items: [
          {
            itemType: "thesis",
            fields: { title: `Thesis-${SUFFIX}`, university: "Test U" },
            tags: [`wf-tag-${SUFFIX}`],
          },
        ],
      });

      assert.equal(result.createdCount, 1);
      const itemId = result.items[0].itemId as number;
      created.items.push(itemId);
      created.tags.push(`wf-tag-${SUFFIX}`);

      const item = Zotero.Items.get(itemId);
      assert.equal(Zotero.ItemTypes.getName(item.itemTypeID), "thesis");
      assert.equal(item.getField("university"), "Test U");
    });

    it("moves a note onto a paper and detaches it again", async function () {
      const paper = await makeItem();
      const note = new Zotero.Item("note");
      note.libraryID = libraryID();
      note.setNote("<p>workflow note</p>");
      await note.saveTx();
      created.items.push(note.id);

      const g = gateway();
      await g.reparentItems({
        assignments: [{ itemId: note.id, parentItemId: paper.id }],
      });
      assert.equal(Zotero.Items.get(note.id).parentID, paper.id);

      await g.reparentItems({
        assignments: [{ itemId: note.id, parentItemId: null }],
      });
      assert.isNotOk(Zotero.Items.get(note.id).parentID);
    });

    it("relates two items on both sides", async function () {
      const a = await makeItem("journalArticle", "RelA");
      const b = await makeItem("journalArticle", "RelB");

      await gateway().relateItems({
        itemId: a.id,
        relatedItemIds: [b.id],
        action: "add",
      });

      const freshA = Zotero.Items.get(a.id);
      const freshB = Zotero.Items.get(b.id);
      // Zotero relations are bidirectional; writing one side leaves the pair
      // inconsistent.
      assert.include(freshA.relatedItems, freshB.key);
      assert.include(freshB.relatedItems, freshA.key);
    });
  });

  // ── Stage 5: tags as objects ──────────────────────────────────────────────

  describe("tags as library objects", function () {
    it("renames a tag everywhere it is used, in one call", async function () {
      const oldTag = `old-tag-${SUFFIX}`;
      const newTag = `new-tag-${SUFFIX}`;
      created.tags.push(oldTag, newTag);

      const one = await makeItem("journalArticle", "TagOne");
      const two = await makeItem("journalArticle", "TagTwo");
      for (const item of [one, two]) {
        item.addTag(oldTag);
        await item.saveTx();
      }

      const result = await gateway().updateLibraryTag({
        libraryID: libraryID(),
        action: "rename",
        tag: oldTag,
        newTag,
      });
      assert.equal(result.status, "applied");

      for (const item of [one, two]) {
        const tags = Zotero.Items.get(item.id)
          .getTags()
          .map((entry: { tag: string }) => entry.tag);
        assert.include(tags, newTag);
        assert.notInclude(tags, oldTag);
      }
      assert.isNotOk(Zotero.Tags.getID(oldTag), "the old tag is gone");
    });

    it("replaces an item's whole tag set rather than adding to it", async function () {
      const keep = `set-keep-${SUFFIX}`;
      const drop = `set-drop-${SUFFIX}`;
      created.tags.push(keep, drop);

      const item = await makeItem("journalArticle", "TagSet");
      item.addTag(drop);
      await item.saveTx();

      await gateway().setItemTags({
        assignments: [{ itemId: item.id, tags: [keep] }],
      });

      const tags = Zotero.Items.get(item.id)
        .getTags()
        .map((entry: { tag: string }) => entry.tag);
      // Add-only assignment is why "exactly these 20 tags" drifted.
      assert.deepEqual(tags, [keep]);
    });
  });

  // ── Stage 5: saved searches ───────────────────────────────────────────────

  describe("saved searches", function () {
    it("creates one that Zotero can run", async function () {
      const item = await makeItem("journalArticle", "SavedProbe");

      const saved = await gateway().saveSavedSearch({
        libraryID: libraryID(),
        name: `Saved-${SUFFIX}`,
        conditions: [
          {
            condition: "title",
            operator: "contains",
            value: `SavedProbe-${SUFFIX}`,
          },
        ],
      });
      created.searches.push(saved.savedSearchId);
      assert.equal(saved.status, "created");

      const conditionRows = await Zotero.DB.valueQueryAsync(
        "SELECT COUNT(*) FROM savedSearchConditions WHERE savedSearchID=?",
        [saved.savedSearchId],
      );
      assert.isAtLeast(Number(conditionRows), 1, "conditions must persist");

      // Running it must find the item, or the saved search is decoration.
      const search = Zotero.Searches.get(saved.savedSearchId);
      const ids: number[] = await search.search();
      assert.include(ids.map(Number), item.id);
    });

    it("lists saved searches with their conditions", function () {
      const listed = gateway().listSavedSearches(libraryID());
      const mine = listed.find((entry) => entry.name === `Saved-${SUFFIX}`);
      assert.isOk(mine, "the saved search must be discoverable");
      assert.isAtLeast(mine?.conditions.length || 0, 1);
    });
  });

  // ── Stage 6: real citations ───────────────────────────────────────────────

  describe("citations through Zotero's own CSL engine", function () {
    it("formats a bibliography entry containing the real author and year", async function () {
      const item = await makeItem("journalArticle", "CiteProbe");
      item.setCreators([
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
      ]);
      item.setField("date", "1843");
      item.setField("publicationTitle", "Notes");
      await item.saveTx();

      // The synchronous formatter needs the citation style registry, which
      // the cite tool awaits for the caller before reaching this gateway call.
      await (Zotero as any).Styles.init();
      const result = gateway().formatBibliography({ itemIds: [item.id] });

      // The whole point: this comes from Zotero, not from the model's memory.
      assert.include(result.output, "Lovelace");
      assert.include(result.output, "1843");
      assert.isOk(result.styleTitle);
    });

    it("refuses an uninstalled style rather than approximating it", function () {
      assert.throws(
        () =>
          gateway().formatBibliography({
            itemIds: created.items.slice(0, 1),
            styleId: "http://example.com/styles/not-real",
          }),
        /not installed/,
      );
    });

    it("lists the installed styles", function () {
      const styles = gateway().listCitationStyles();
      assert.isAtLeast(styles.length, 1);
      assert.isOk(styles[0].id);
    });
  });

  // ── Stage 6: settings ─────────────────────────────────────────────────────

  describe("preferences", function () {
    it("reads and writes an allowlisted preference", async function () {
      const g = gateway();
      const before = Zotero.Prefs.get("recursiveCollections");
      try {
        const result = await g.updateSetting({
          key: "recursiveCollections",
          value: !before,
        });
        assert.equal(result.status, "updated");
        assert.equal(Zotero.Prefs.get("recursiveCollections"), !before);
      } finally {
        Zotero.Prefs.set("recursiveCollections", before);
      }
    });

    it("refuses anything outside the allowlist", async function () {
      const result = await gateway().updateSetting({
        key: "sync.storage.password",
        value: "nope",
      });
      // Zotero.Prefs also holds sync credentials and the data directory.
      assert.equal(result.status, "refused");
    });
  });
});
