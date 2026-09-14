import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import { assert } from "chai";
import { createHash } from "node:crypto";
import {
  exportPlanDocumentMarkdown,
  savePlanDocumentAsNote,
} from "../src/agent/documents/actions";

/** Exercises the actual document decoder, save action and native note persistence boundary. */
describe("durable document note association", function () {
  const globals = globalThis as any;
  let original: any;
  let notes: Map<number, any>;
  let state: any;
  let failAssociation: boolean;
  let nextId: number;
  let inTransaction: boolean;
  let document: any;
  let originalIO: any;
  let originalToolkit: any;
  let failFinalization: boolean;
  let requireAtomicState: boolean;
  let imageImports: number;
  beforeEach(function () {
    original = globals.Zotero;
    originalIO = globals.IOUtils;
    originalToolkit = globals.ztoolkit;
    globals.IOUtils = { write: async () => undefined };
    globals.ztoolkit = { log: () => undefined };
    notes = new Map();
    state = undefined;
    failAssociation = false;
    nextId = 100;
    inTransaction = false;
    failFinalization = false;
    requireAtomicState = false;
    imageImports = 0;
    document = {
      version: 2,
      documentId: "summary-document",
      documentVersion: 1,
      conversationKey: 42,
      documentKind: "custom",
      integrityPolicy: "authored",
      origin: {
        kind: "direct",
        runId: "summary-run",
        sourceMessageTimestamp: 1,
      },
      title: "Paper summary",
      visibleMarkdown: "# Summary\n\nExact durable summary.",
      visibleHtml: "<h1>Summary</h1><p>Exact durable summary.</p>",
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
      contentHash: "sha256:document-content",
      createdAt: 1,
    };
    class Note {
      id = 0;
      key = "";
      primaryLoaded = false;
      async loadPrimaryData() {
        this.primaryLoaded = true;
      }
      libraryID = 1;
      parentID?: number;
      deleted = false;
      html = "";
      stored = "";
      dateAdded = "2026-09-07 00:00:00";
      isNote() {
        return true;
      }
      isAttachment() {
        return false;
      }
      getNote() {
        return this.html;
      }
      setNote(html: string) {
        if (this.key && !this.primaryLoaded)
          throw new Error(
            "UnloadedDataException: primaryData not loaded for reserved key",
          );
        this.html = html;
      }
      getField(name: string) {
        return name === "title"
          ? "Summary"
          : name === "dateAdded"
            ? this.dateAdded
            : "";
      }
      getDisplayTitle() {
        return "Summary";
      }
      getNoteTitle() {
        return "Summary";
      }
      async saveTx() {
        return globals.Zotero.DB.executeTransaction(async () => {
          if (!this.id) {
            this.id = nextId++;
            this.key ||= `NOTE${this.id}`;
          }
          this.stored = this.html;
          notes.set(this.id, this);
          return this.id;
        });
      }
      async reload() {
        this.html = this.stored;
      }
    }
    const parent = {
      id: 42,
      key: "PAPER42",
      libraryID: 1,
      deleted: false,
      isRegularItem: () => true,
      isNote: () => false,
      isAttachment: () => false,
    };
    globals.Zotero = {
      Utilities: { generateObjectKey: () => `NOTE${nextId}` },
      Item: Note,
      Libraries: { userLibraryID: 1 },
      Items: {
        get: (id: number) => (id === 42 ? parent : notes.get(id)),
        getByLibraryAndKey: (_lib: number, key: string) =>
          key === "PAPER42"
            ? parent
            : [...notes.values()].find((note) => note.key === key),
      },
      DB: {
        executeTransaction: async (callback: () => Promise<unknown>) => {
          if (inTransaction)
            throw new Error(
              "Nested Zotero transaction would wait on its owner",
            );
          inTransaction = true;
          const priorNotes = new Map(notes);
          const priorState = state;
          try {
            return await callback();
          } catch (error) {
            notes = priorNotes;
            state = priorState;
            throw error;
          } finally {
            inTransaction = false;
          }
        },
        queryAsync: async (sql: string, args: any[]) => {
          if (
            sql.includes(
              "INSERT OR REPLACE INTO llm_for_zotero_plan_document_action_state",
            )
          ) {
            const next = JSON.parse(args[1]);
            if (requireAtomicState) assert.isTrue(inTransaction);
            if (failAssociation && next.savedNote)
              throw new Error("Association storage unavailable");
            if (failFinalization && next.pendingNote?.finalized)
              throw new Error("Finalization checkpoint unavailable");
            state = next;
            return [];
          }
          if (sql.includes("llm_for_zotero_plan_document_action_state"))
            return state ? [{ payloadJson: JSON.stringify(state) }] : [];
          if (sql.includes("FROM llm_for_zotero_plan_documents"))
            return [{ payloadJson: JSON.stringify(document) }];
          return [];
        },
      },
    };
  });
  afterEach(function () {
    globals.Zotero = original;
    globals.IOUtils = originalIO;
    globals.ztoolkit = originalToolkit;
  });
  async function rejects(task: Promise<unknown>, message: RegExp) {
    let failure: unknown;
    try {
      await task;
    } catch (error) {
      failure = error;
    }
    assert.match(String(failure), message);
  }
  function addFigure() {
    const bytes = new Uint8Array([1, 2, 3]);
    globals.IOUtils.read = async () => bytes;
    globals.Zotero.Attachments = {
      importEmbeddedImage: async () => {
        imageImports++;
        return { key: "IMAGE001" };
      },
    };
    document.assets = [
      {
        assetId: "figure-1",
        contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        mimeType: "image/png",
        byteLength: bytes.length,
        caption: "Requested figure",
        durablePath: "/virtual/figure.png",
        provenance: {
          origin: "generated",
          generator: "test",
          generatorVersion: "1",
          evidenceRefs: [],
        },
      },
    ];
  }
  it("prepares the exact stored document instead of asking the model to rewrite its body", async function () {
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createEditCurrentNoteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = {
      request: {
        conversationKey: 42,
        libraryID: 1,
        actionContract: {
          id: "workflow",
          obligations: [
            {
              id: "save",
              operation: "note_create",
              contentFrom: "summary",
              targetBoundary: { frozenTargetIds: [42] },
            },
          ],
        },
        actionProgress: {
          contractId: "workflow",
          materialOutputs: [
            {
              outputId: "summary",
              documentId: document.documentId,
              documentVersion: 1,
              contentHash: document.contentHash,
            },
          ],
        },
      },
    } as any;
    await tool.planInvocation(input.value, context);
    const proposals = await tool.describeAction!(input.value, context);
    assert.equal(proposals[0].parameters?.documentId, document.documentId);
    assert.equal(proposals[0].parameters?.contentHash, document.contentHash);
    assert.include(
      proposals[0].parameters?.expectedText || "",
      "Exact durable summary.",
    );
  });
  it("embeds finalized document figures when replacing an existing note", async function () {
    addFigure();
    const note = new globals.Zotero.Item("note");
    note.key = "EXISTING";
    await note.loadPrimaryData();
    note.setNote("<p>Original</p>");
    await note.saveTx();
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
      getActiveNoteSnapshot: () => ({
        noteId: note.id,
        title: "Note",
        libraryID: 1,
        html: note.getNote(),
        text: "Original",
      }),
    } as any;
    const tool = createEditCurrentNoteTool(gateway);
    const input = tool.validate({
      mode: "edit",
      targetNoteId: note.id,
      documentId: document.documentId,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = {
      journalFallbackApproved: true,
      request: {
        conversationKey: 42,
        libraryID: 1,
        actionContract: {
          id: "workflow",
          obligations: [
            {
              operation: "note_edit",
              contentFrom: "summary",
              targetBoundary: { frozenTargetIds: [note.id] },
            },
          ],
        },
        actionProgress: {
          contractId: "workflow",
          materialOutputs: [
            {
              outputId: "summary",
              documentId: document.documentId,
              documentVersion: 1,
              contentHash: document.contentHash,
            },
          ],
        },
      },
    } as any;
    await tool.planInvocation(input.value, context);
    const result = await tool.execute(input.value, context);
    assert.equal(result.effect, "applied");
    assert.equal(imageImports, 1);
    assert.include(note.getNote(), 'data-attachment-key="IMAGE001"');
    assert.include(note.getNote(), "Exact durable summary.");
    assert.notInclude(note.getNote(), "Original");
  });
  it("does not duplicate a native note when recording its association fails", async function () {
    failAssociation = true;
    let error: unknown;
    try {
      await savePlanDocumentAsNote(document.documentId);
    } catch (failure) {
      error = failure;
    }
    assert.include(String(error), "Association storage unavailable");
    failAssociation = false;
    const saved = await savePlanDocumentAsNote(document.documentId);
    const retried = await savePlanDocumentAsNote(document.documentId);
    assert.equal(
      notes.size,
      1,
      "Retry must not leave an unassociated duplicate note",
    );
    assert.equal(saved.itemId, retried.itemId);
    assert.isFalse(retried.created);
    assert.equal(notes.get(saved.itemId).getNote(), document.visibleHtml);
  });
  it("binds a requested parent even when the summary contains no citation cluster", async function () {
    const saved = await savePlanDocumentAsNote(document.documentId, {
      parentItemId: 42,
      libraryID: 1,
    });
    assert.equal(notes.get(saved.itemId).parentID, 42);
  });
  it("preserves a pending native identity across failure, export, state reload and retry", async function () {
    failAssociation = true;
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /Association storage/,
    );
    assert.equal(notes.size, 1);
    const reservedKey = state.pendingNote.itemKey;
    await exportPlanDocumentMarkdown(
      document.documentId,
      "/virtual/summary.md",
    );
    assert.equal(state.pendingNote?.itemKey, reservedKey);
    state = JSON.parse(JSON.stringify(state));
    failAssociation = false;
    const recovered = await savePlanDocumentAsNote(document.documentId);
    assert.equal(notes.size, 1);
    assert.equal(recovered.itemKey, reservedKey);
    assert.isFalse(recovered.created);
    assert.isUndefined(state.pendingNote);
    assert.equal(state.lastExportedName, "summary.md");
  });
  it("retains export metadata written while native save notifications are pending", async function () {
    let notifyReady!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    globals.Zotero.Notifier = {
      Queue: class {},
      commit: async () => {
        notifyReady();
        await resumed;
      },
    };
    const save = savePlanDocumentAsNote(document.documentId);
    await ready;
    try {
      await exportPlanDocumentMarkdown(
        document.documentId,
        "/virtual/during-save.md",
      );
    } finally {
      resume();
    }
    const saved = await save;
    assert.equal(state.savedNote.itemKey, saved.itemKey);
    assert.equal(state.lastExportedName, "during-save.md");
    assert.isNumber(state.lastExportedAt);
    assert.equal(notes.size, 1);
  });
  it("runs action-state writes atomically without nesting native save transactions", async function () {
    requireAtomicState = true;
    await savePlanDocumentAsNote(document.documentId);
    await exportPlanDocumentMarkdown(
      document.documentId,
      "/virtual/summary.md",
    );
    assert.equal(notes.size, 1);
  });
  it("serializes concurrent saves of the same document", async function () {
    const results = await Promise.all([
      savePlanDocumentAsNote(document.documentId),
      savePlanDocumentAsNote(document.documentId),
    ]);
    assert.equal(notes.size, 1);
    assert.equal(results[0].itemId, results[1].itemId);
    assert.deepEqual(
      results.map((result) => result.created),
      [true, false],
    );
  });
  it("does not mark fallback text complete when the figure checkpoint fails", async function () {
    addFigure();
    failFinalization = true;
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /Finalization checkpoint/,
    );
    assert.equal(notes.size, 1);
    assert.isUndefined(state.savedNote);
    assert.isFalse(state.pendingNote.finalized);
    const reservedKey = state.pendingNote.itemKey;
    failFinalization = false;
    state = JSON.parse(JSON.stringify(state));
    await rejects(savePlanDocumentAsNote(document.documentId), /incomplete/);
    assert.equal(state.pendingNote.itemKey, reservedKey);
    assert.equal(notes.size, 1);
    assert.equal(imageImports, 1, "Recovery must not import the figure again");
  });
  it("recovers a fully persisted figure without importing it twice", async function () {
    addFigure();
    failAssociation = true;
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /Association storage/,
    );
    const key = state.pendingNote.itemKey;
    assert.isTrue(state.pendingNote.finalized);
    failAssociation = false;
    state = JSON.parse(JSON.stringify(state));
    const saved = await savePlanDocumentAsNote(document.documentId);
    assert.equal(saved.itemKey, key);
    assert.isFalse(saved.created);
    assert.include(
      notes.get(saved.itemId).getNote(),
      'data-attachment-key="IMAGE001"',
    );
    assert.equal(imageImports, 1);
    assert.equal(notes.size, 1);
  });
  it("blocks recovery when a requested figure could not be imported", async function () {
    addFigure();
    globals.Zotero.Attachments.importEmbeddedImage = async () => null;
    await rejects(savePlanDocumentAsNote(document.documentId), /incomplete/);
    await rejects(savePlanDocumentAsNote(document.documentId), /incomplete/);
    assert.equal(notes.size, 1);
    assert.isUndefined(state.savedNote);
  });
  it("does not promote a reservation changed during native persistence", async function () {
    globals.Zotero.Notifier = {
      Queue: class {},
      commit: async () => {
        state.pendingNote = { ...state.pendingNote, itemKey: "OTHER001" };
      },
    };
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /reservation.*changed/i,
    );
    assert.equal(state.pendingNote.itemKey, "OTHER001");
    assert.isUndefined(state.savedNote);
    assert.equal(notes.size, 1);
  });
  it("does not recreate a deleted note or treat a lookup failure as absence", async function () {
    const saved = await savePlanDocumentAsNote(document.documentId);
    notes.get(saved.itemId).deleted = true;
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /removed or changed/,
    );
    globals.Zotero.Items.getByLibraryAndKey = () => {
      throw new Error("Lookup unavailable");
    };
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /Lookup unavailable/,
    );
    assert.equal(notes.size, 1);
  });
  it("rejects a changed parent on document-card recovery without an explicit target", async function () {
    const saved = await savePlanDocumentAsNote(document.documentId, {
      parentItemId: 42,
      libraryID: 1,
    });
    notes.get(saved.itemId).parentID = 43;
    await rejects(savePlanDocumentAsNote(document.documentId), /parent/);
    assert.equal(notes.size, 1);
  });
  it("refuses to report an externally changed saved note as the original document", async function () {
    const saved = await savePlanDocumentAsNote(document.documentId);
    notes.get(saved.itemId).stored = "<p>Different content</p>";
    let error: unknown;
    try {
      await savePlanDocumentAsNote(document.documentId);
    } catch (failure) {
      error = failure;
    }
    assert.instanceOf(error, Error);
    assert.equal(notes.size, 1);
  });
});
