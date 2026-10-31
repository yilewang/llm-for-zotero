import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { revertActions } from "../src/agent/services/changeReverter";
import { BATCH_ITEMS_TABLE } from "../src/agent/store/batchItemStore";
import {
  clearPlanDocumentConversationRowsInTransaction,
  loadDocumentActionState,
  savePlanDocumentInTransaction,
} from "../src/agent/documents/store";
import type { PlanDocument } from "../src/agent/documents/types";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

/**
 * W5-B against real Zotero: a finalized document saved as a standalone note
 * in a collection, a batch append stopped and resumed, and an item type
 * change with its undo. Every assertion reads Zotero's own database.
 */
describe("workflow: notes and item type (W5-B)", function () {
  this.timeout(120000);

  const SUFFIX = `w5b${Date.now()}`;
  const created = { items: [] as number[], collections: [] as number[] };

  function libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  function contextFor(
    conversationKey: number,
    userText: string,
    extra: Partial<AgentToolContext> = {},
  ): AgentToolContext {
    return {
      request: resolvedAgentRequest({
        conversationKey,
        mode: "agent",
        userText,
        libraryID: libraryID(),
        executionContext: {
          version: 1,
          executionId: `w5b:${SUFFIX}:${conversationKey}`,
          conversationKey,
          conversationGeneration: 0,
          chatLibraryID: libraryID(),
          permissionOwner: "original_agent",
          workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
          configuredAccess: {
            libraryIDs: [libraryID()],
            outputDirectories: [],
          },
        },
      }),
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
      runId: `w5b-run:${SUFFIX}:${conversationKey}`,
      ...extra,
    } as AgentToolContext;
  }

  async function withRegistry<T>(
    mode: "safe" | "yolo",
    tools: string[],
    body: (registry: AgentToolRegistry) => Promise<T>,
  ): Promise<T> {
    const originalMode = getOriginalAgentPermissionMode();
    try {
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode(mode);
      const registry = new AgentToolRegistry(
        new ActionContractService(new ZoteroGateway()),
      );
      for (const name of tools)
        registry.register(
          Zotero.LLMForZotero.api.agent.getToolDefinition(name),
        );
      return await body(registry);
    } finally {
      setOriginalAgentPermissionMode(originalMode);
    }
  }

  async function runTool(
    registry: AgentToolRegistry,
    name: string,
    args: Record<string, unknown>,
    context: AgentToolContext,
  ): Promise<AgentToolResult> {
    let prepared = await registry.prepareExecution(
      { id: `${name}:${Math.random()}`, name, arguments: args },
      context,
      { callerKind: "model" },
    );
    if (prepared.kind === "confirmation")
      prepared = await prepared.execute({ approved: true });
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") throw new Error("unreachable");
    return prepared.execution.result;
  }

  async function makeCollection(name: string) {
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID();
    collection.name = `${name}-${SUFFIX}`;
    await collection.saveTx();
    created.collections.push(collection.id);
    return collection;
  }

  async function makeNote(html: string) {
    const note = new Zotero.Item("note");
    note.libraryID = libraryID();
    note.setNote(html);
    await note.saveTx();
    created.items.push(note.id);
    return note;
  }

  /** The note's HTML as the database holds it. */
  async function storedNote(noteId: number): Promise<string> {
    return String(
      await Zotero.DB.valueQueryAsync(
        "SELECT note FROM itemNotes WHERE itemID = ?",
        [noteId],
      ),
    );
  }

  after(async function () {
    for (const id of created.items.reverse()) {
      try {
        const item = Zotero.Items.get(id);
        if (item) await item.eraseTx();
      } catch {
        /* best effort */
      }
    }
    for (const id of created.collections) {
      try {
        const collection = Zotero.Collections.get(id);
        if (collection) await collection.eraseTx();
      } catch {
        /* best effort */
      }
    }
  });

  describe("a finalized document saved as a standalone note", function () {
    let document: PlanDocument;
    let originalQuery: typeof Zotero.DB.queryAsync;

    beforeEach(async function () {
      originalQuery = Zotero.DB.queryAsync;
      const now = Date.now();
      const conversationKey = 9_100_000 + (now % 100_000);
      document = {
        version: 2,
        documentId: `w5b-document:${SUFFIX}:${now}`,
        documentVersion: 1,
        conversationKey,
        title: "Standalone document",
        documentKind: "custom",
        integrityPolicy: "authored",
        origin: {
          kind: "direct",
          runId: `w5b-document-run:${now}`,
          sourceMessageTimestamp: now,
        },
        visibleMarkdown: `# Standalone document\n\nFiled ${SUFFIX}-${now}.`,
        visibleHtml: `<h1>Standalone document</h1><p>Filed ${SUFFIX}-${now}.</p>`,
        citationBundle: {
          clusters: [],
          bibliographyEntries: [],
          style: { id: "apa", title: "APA" },
          locale: "en-US",
        },
        assets: [],
        verifiedQuotes: [],
        coverageItems: [],
        validation: {
          integrityValidated: true,
          groundingReviewed: "not_run",
          quoteVerified: "not_applicable",
          issues: [],
        },
        contentHash: await sha256Text(`w5b-document:${now}`),
        createdAt: now,
      };
      await Zotero.DB.executeTransaction(() =>
        savePlanDocumentInTransaction({
          document,
          outbox: {
            version: 1,
            outboxId: `w5b-outbox:${now}`,
            documentId: document.documentId,
            conversationKey,
            messageTimestamp: now,
            visibleMarkdown: document.visibleMarkdown,
            status: "delivered",
            attemptCount: 1,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
    });

    afterEach(async function () {
      Zotero.DB.queryAsync = originalQuery;
      const state = await loadDocumentActionState(document.documentId);
      const binding = state?.savedNote || state?.pendingNote;
      const saved =
        binding &&
        Zotero.Items.getByLibraryAndKey(binding.libraryID, binding.itemKey);
      if (saved) await saved.eraseTx();
      await Zotero.DB.executeTransaction(() =>
        clearPlanDocumentConversationRowsInTransaction(
          document.conversationKey,
        ),
      );
    });

    it("files the note in the collection, and a retry after a lost checkpoint finds the same note", async function () {
      const folder = await makeCollection("Standalone document folder");
      const args = {
        mode: "create",
        documentId: document.documentId,
        target: "standalone",
        collections: [folder.id],
      };
      const context = contextFor(document.conversationKey, "Save it");
      // The first save loses the checkpoint that records the note as saved.
      (Zotero.DB as any).queryAsync = function (sql: string, ...rest: any[]) {
        if (
          sql.includes(
            "INSERT OR REPLACE INTO llm_for_zotero_plan_document_action_state",
          ) &&
          JSON.parse(rest[0][1]).savedNote
        )
          throw new Error("Injected document checkpoint failure");
        return (originalQuery as any).call(this, sql, ...rest);
      };
      const first = await withRegistry("yolo", ["note_write"], (registry) =>
        runTool(registry, "note_write", args, context),
      );
      Zotero.DB.queryAsync = originalQuery;
      assert.isFalse(first.ok, "the lost checkpoint fails the first save");
      const pending = (await loadDocumentActionState(document.documentId))!
        .pendingNote!;
      assert.isUndefined(pending.parentItemId);

      const retried = await withRegistry("yolo", ["note_write"], (registry) =>
        runTool(registry, "note_write", args, context),
      );
      assert.isTrue(retried.ok, JSON.stringify(retried.content));
      const result = retried.content as { noteId: number; status: string };
      assert.equal(result.status, "already_satisfied");

      // Native readback: one note with this body, standalone, in the folder.
      const rows = await Zotero.DB.queryAsync(
        "SELECT itemID, parentItemID FROM itemNotes WHERE note LIKE ?",
        [`%${document.visibleHtml}%`],
      );
      assert.lengthOf(rows, 1, "exactly one saved document note");
      assert.equal(rows[0].itemID, result.noteId);
      assert.isNull(rows[0].parentItemID);
      assert.equal(
        Zotero.Items.getByLibraryAndKey(pending.libraryID, pending.itemKey).id,
        result.noteId,
        "the retry found the reserved note",
      );
      const memberships = await Zotero.DB.columnQueryAsync(
        "SELECT collectionID FROM collectionItems WHERE itemID = ?",
        [result.noteId],
      );
      assert.deepEqual(memberships, [folder.id]);
      assert.equal(
        (await loadDocumentActionState(document.documentId))!.savedNote!
          .itemKey,
        pending.itemKey,
      );
      const [receipt] = retried.actionReceipts || [];
      assert.notEqual(receipt?.verification, "unverified");
    });
  });

  describe("note_write_batch mode:'append'", function () {
    it("appends to three notes once across a Stop after one and a resume, survives a lost checkpoint, and undoes all three", async function () {
      const notes = [
        await makeNote("<p>First batch note.</p>"),
        await makeNote("<p>Second batch note.</p>"),
        await makeNote("<p>Third batch note.</p>"),
      ];
      const before = await Promise.all(
        notes.map((note) => storedNote(note.id)),
      );
      const addition = (index: number) => `Follow-up ${index + 1} ${SUFFIX}`;
      const count = (html: string, text: string) => html.split(text).length - 1;
      const conversationKey = notes[0].id;
      // Stop lands between notes, once the first append is in the library.
      const signal = {
        get aborted() {
          return Zotero.Items.get(notes[0].id).getNote().includes(addition(0));
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      const first = await withRegistry(
        "yolo",
        ["note_write_batch"],
        (registry) =>
          runTool(
            registry,
            "note_write_batch",
            {
              mode: "append",
              notes: notes.map((note, index) => ({
                targetNoteId: note.id,
                content: addition(index),
              })),
            },
            contextFor(conversationKey, "Add a follow-up to each note", {
              signal: signal as never,
            }),
          ),
      );
      assert.isTrue(first.ok, JSON.stringify(first.content));
      const batchId = (first.content as { stopped?: string }).stopped?.match(
        /batch (\S+);/,
      )?.[1];
      assert.exists(batchId, JSON.stringify(first.content));
      assert.equal(count(await storedNote(notes[0].id), addition(0)), 1);
      assert.equal(await storedNote(notes[1].id), before[1]);
      assert.equal(await storedNote(notes[2].id), before[2]);
      const [receipt] = first.actionReceipts || [];
      assert.include(
        receipt?.verifiedFacts || [],
        `appended_note:item:${notes[0].id}`,
        JSON.stringify(first.actionReceipts),
      );
      const statuses = async () =>
        (await Zotero.DB.columnQueryAsync(
          `SELECT status FROM ${BATCH_ITEMS_TABLE} WHERE batch_id = ? ORDER BY position`,
          [batchId],
        )) as string[];
      assert.deepEqual(await statuses(), ["saved", "pending", "pending"]);

      const resumed = await withRegistry(
        "yolo",
        ["note_write_batch"],
        (registry) =>
          runTool(
            registry,
            "note_write_batch",
            { resumeBatchId: batchId },
            contextFor(conversationKey, "Continue"),
          ),
      );
      assert.isTrue(resumed.ok, JSON.stringify(resumed.content));
      for (const [index, note] of notes.entries())
        assert.equal(
          count(await storedNote(note.id), addition(index)),
          1,
          `note ${index + 1} holds its follow-up once`,
        );
      assert.deepEqual(await statuses(), ["saved", "saved", "saved"]);
      // The result names each note it appended to, for a client with no card.
      const rows = JSON.stringify(resumed.content);
      for (const note of notes.slice(1))
        assert.include(rows, `"noteId":${note.id}`);

      // A checkpoint lost after the native append: the row reads pending,
      // and the frozen after-checksum proves the append already landed.
      await Zotero.DB.queryAsync(
        `UPDATE ${BATCH_ITEMS_TABLE} SET status = 'pending' WHERE batch_id = ? AND position = 3`,
        [batchId],
      );
      const again = await withRegistry(
        "yolo",
        ["note_write_batch"],
        (registry) =>
          runTool(
            registry,
            "note_write_batch",
            { resumeBatchId: batchId },
            contextFor(conversationKey, "Continue"),
          ),
      );
      assert.isTrue(again.ok, JSON.stringify(again.content));
      assert.equal(count(await storedNote(notes[2].id), addition(2)), 1);
      assert.deepEqual(await statuses(), ["saved", "saved", "saved"]);

      // One undo restores every note the batch appended to.
      const actions = await listJournalActions({ conversationKey });
      const batchActions = actions.filter(
        (action) => action.toolName === "note_write_batch",
      );
      assert.lengthOf(
        new Set(batchActions.map((action) => action.actionId)),
        1,
        "the resumes continue the batch's one action",
      );
      const undone = await revertActions({
        actions: [batchActions[0]],
        zoteroGateway: new ZoteroGateway(),
        context: contextFor(conversationKey, "Undo that"),
      });
      assert.equal(undone.reverted, 1, JSON.stringify(undone));
      for (const [index, note] of notes.entries())
        assert.notInclude(await storedNote(note.id), addition(index));
    });
  });

  describe("note_write_batch mode:'append' with a citation", function () {
    it("registers the cited work in the target note's one root, and a lost checkpoint does not append it twice", async function () {
      const paper = new Zotero.Item("journalArticle");
      paper.libraryID = libraryID();
      paper.setField("title", `Cited paper ${SUFFIX}`);
      paper.setField("date", "2021");
      paper.setCreators([
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
      ]);
      await paper.saveTx();
      created.items.push(paper.id);
      const note = await makeNote(
        '<div data-schema-version="9"><p>Rooted note.</p></div>',
      );
      const uri = Zotero.URI.getItemURI(paper);
      const args = {
        mode: "append",
        notes: [
          {
            targetNoteId: note.id,
            content: `Drift is cited {{cite item=${paper.id} page=4}} ${SUFFIX}.`,
          },
        ],
      };
      const applied = await withRegistry(
        "yolo",
        ["note_write_batch"],
        (registry) =>
          runTool(
            registry,
            "note_write_batch",
            args,
            contextFor(note.id, "Add a cited follow-up"),
          ),
      );
      assert.isTrue(applied.ok, JSON.stringify(applied.content));
      const html = await storedNote(note.id);
      assert.equal(
        html.split("data-schema-version").length - 1,
        1,
        `one root: ${html}`,
      );
      const registry = html.match(/data-citation-items="([^"]+)"/);
      assert.exists(registry, html);
      assert.include(decodeURIComponent(registry![1]), uri);
      assert.include(html, 'class="citation"');
      assert.notInclude(html, "{{cite");
      const [receipt] = applied.actionReceipts || [];
      assert.equal(receipt?.verification, "verified", JSON.stringify(receipt));
      assert.include(
        receipt?.verifiedFacts || [],
        `appended_note:item:${note.id}`,
        JSON.stringify(receipt),
      );

      // A checkpoint lost after the native append: the frozen after-checksum
      // must equal the note as written, or the resume would append again.
      const batchId = String(
        await Zotero.DB.valueQueryAsync(
          `SELECT batch_id FROM ${BATCH_ITEMS_TABLE} WHERE item_key = ?`,
          [`item:${note.id}`],
        ),
      );
      await Zotero.DB.queryAsync(
        `UPDATE ${BATCH_ITEMS_TABLE} SET status = 'pending' WHERE batch_id = ?`,
        [batchId],
      );
      const again = await withRegistry(
        "yolo",
        ["note_write_batch"],
        (registry) =>
          runTool(
            registry,
            "note_write_batch",
            { resumeBatchId: batchId },
            contextFor(note.id, "Continue"),
          ),
      );
      assert.isTrue(again.ok, JSON.stringify(again.content));
      assert.equal(
        await storedNote(note.id),
        html,
        "nothing is appended twice",
      );
    });
  });

  describe("change_item_type through library_update", function () {
    /** The item's type, fields and creators as the database holds them. */
    async function storedRecord(itemId: number) {
      const itemTypeID = await Zotero.DB.valueQueryAsync(
        "SELECT itemTypeID FROM items WHERE itemID = ?",
        [itemId],
      );
      const fieldRows = await Zotero.DB.queryAsync(
        `SELECT fieldID, value FROM itemData JOIN itemDataValues USING (valueID)
         WHERE itemID = ?`,
        [itemId],
      );
      const fields: Record<string, string> = {};
      for (const row of fieldRows)
        fields[Zotero.ItemFields.getName(row.fieldID)] = String(row.value);
      const creators = (
        await Zotero.DB.queryAsync(
          `SELECT firstName, lastName, fieldMode, creatorTypeID, orderIndex
           FROM itemCreators JOIN creators USING (creatorID)
           WHERE itemID = ? ORDER BY orderIndex`,
          [itemId],
        )
      ).map((row: any) => ({
        firstName: row.firstName,
        lastName: row.lastName,
        fieldMode: row.fieldMode,
        creatorType: Zotero.CreatorTypes.getName(row.creatorTypeID),
      }));
      return {
        itemType: Zotero.ItemTypes.getName(itemTypeID),
        fields,
        creators,
      };
    }

    it("names the dropped fields on the card and in the result, and undo restores type, fields and creators exactly", async function () {
      const paper = new Zotero.Item("journalArticle");
      paper.libraryID = libraryID();
      paper.setField("title", `Type change ${SUFFIX}`);
      paper.setField("publicationTitle", "Journal of Drift");
      paper.setField("volume", "12");
      paper.setField("issue", "3");
      paper.setField("pages", "45-67");
      paper.setField("date", "2020-05-01");
      paper.setField("ISSN", "1234-5678");
      paper.setCreators([
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
        { creatorType: "reviewedAuthor", firstName: "Bea", lastName: "Revs" },
      ]);
      await paper.saveTx();
      created.items.push(paper.id);
      const before = await storedRecord(paper.id);
      const workflow = Zotero.LLMForZotero.api.workflowTest as WorkflowTestApi;
      const doc: Document = Zotero.getMainWindow().document;
      const context = contextFor(paper.id, "Make this a book");
      try {
        const result = await withRegistry(
          "safe",
          ["library_update"],
          async (registry) => {
            const execution = await registry.prepareExecution(
              {
                id: "item-type-change",
                name: "library_update",
                arguments: {
                  kind: "metadata",
                  itemId: paper.id,
                  itemType: "book",
                },
              },
              context,
              { callerKind: "model" },
            );
            assert.equal(
              execution.kind,
              "confirmation",
              "Safe mode asks first",
            );
            if (execution.kind !== "confirmation")
              throw new Error("unreachable");
            const panel = await workflow.renderPanelForItem(paper.id);
            const pending = workflow.renderPendingActionForPanel(
              panel.panelId,
              { requestId: "item-type-card", action: execution.action },
            );
            const card = doc.querySelector<HTMLElement>(
              '[data-request-id="item-type-card"]',
            )!;
            assert.exists(card);
            const labels = (
              [
                ...card.querySelectorAll<HTMLElement>(
                  ".llm-agent-hitl-review-label",
                ),
              ] as HTMLElement[]
            ).map((label) => label.textContent || "");
            assert.equal(labels[0], "Item type");
            assert.includeMembers(labels, ["Journal", "Issue"]);
            assert.include(card.textContent || "", "Journal of Drift");
            assert.equal(
              (await storedRecord(paper.id)).itemType,
              "journalArticle",
              "the card itself writes nothing",
            );
            card
              .querySelector<HTMLButtonElement>('[data-kind="save"]')!
              .click();
            const resolution = await pending;
            assert.isTrue(resolution.approved);
            const applied = await execution.execute(resolution);
            if (applied.kind !== "result") throw new Error("unreachable");
            return applied.execution.result;
          },
        );
        assert.isTrue(result.ok, JSON.stringify(result.content));
        const dropped = (
          result.content as {
            result: { result: { droppedFields: string[] } };
          }
        ).result.result.droppedFields;
        // The result names exactly what the database lost. This type has no
        // base-mapped field, so comparing names is exact; the bookSection case
        // below covers a mapped field, which moves to another name.
        const after = await storedRecord(paper.id);
        assert.equal(after.itemType, "book");
        assert.sameMembers(
          dropped,
          Object.keys(before.fields).filter(
            (field) => !(field in after.fields) && !after.fields[field],
          ),
        );
        assert.includeMembers(dropped, ["publicationTitle", "issue"]);
        // Zotero remapped the creator type book does not have.
        assert.deepEqual(
          after.creators.map((creator: any) => creator.creatorType),
          ["author", "contributor"],
        );
        const [receipt] = result.actionReceipts || [];
        assert.equal(receipt?.operation, "change_item_type");
        assert.equal(receipt?.verification, "verified");

        const actions = await listJournalActions({ runId: context.runId });
        assert.lengthOf(actions, 1);
        const undone = await revertActions({
          actions,
          zoteroGateway: new ZoteroGateway(),
          context,
        });
        assert.equal(undone.reverted, 1, JSON.stringify(undone));
        assert.deepEqual(await storedRecord(paper.id), before);
      } finally {
        await workflow.reset();
      }
    });

    it("moves a base-mapped field instead of dropping it: journalArticle to bookSection keeps publicationTitle as bookTitle, and undo restores the exact record", async function () {
      const paper = new Zotero.Item("journalArticle");
      paper.libraryID = libraryID();
      paper.setField("title", `Mapped type change ${SUFFIX}`);
      paper.setField("publicationTitle", "Journal of Drift");
      paper.setField("volume", "12");
      paper.setField("date", "2020-05-01");
      paper.setCreators([
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
      ]);
      await paper.saveTx();
      created.items.push(paper.id);
      const before = await storedRecord(paper.id);
      const context = contextFor(paper.id, "Make this a book section");
      const result = await withRegistry(
        "yolo",
        ["library_update"],
        (registry) =>
          runTool(
            registry,
            "library_update",
            { kind: "metadata", itemId: paper.id, itemType: "bookSection" },
            context,
          ),
      );
      assert.isTrue(result.ok, JSON.stringify(result.content));
      const dropped = (
        result.content as {
          result: { result: { droppedFields: string[] } };
        }
      ).result.result.droppedFields;
      const after = await storedRecord(paper.id);
      assert.equal(after.itemType, "bookSection");
      // Zotero mapped publicationTitle onto bookTitle, so nothing was lost.
      assert.equal(after.fields.bookTitle, "Journal of Drift");
      assert.notInclude(dropped, "publicationTitle", JSON.stringify(dropped));
      // `volume` exists on bookSection, so it is kept as well.
      assert.equal(after.fields.volume, "12");
      assert.notInclude(dropped, "volume");
      const [receipt] = result.actionReceipts || [];
      assert.equal(receipt?.verification, "verified");

      const actions = await listJournalActions({ runId: context.runId });
      assert.lengthOf(actions, 1);
      const undone = await revertActions({
        actions,
        zoteroGateway: new ZoteroGateway(),
        context,
      });
      assert.equal(undone.reverted, 1, JSON.stringify(undone));
      assert.deepEqual(await storedRecord(paper.id), before);
    });
  });
});
