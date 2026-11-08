import { createNoteWriteTool } from "../src/agent/tools/write/noteWrite";
import { composeRetrievalCandidateInvalidation } from "./helpers/hostSurfaces";
import { assert } from "chai";
import { createHash } from "node:crypto";
import { innermostToolResult } from "../src/agent/contracts/toolResultEnvelope";
import { verifyNoteWriteTarget } from "../src/agent/contracts/actionOperationEvidence";
import {
  exportPlanDocumentMarkdown,
  savePlanDocumentAsNote,
} from "../src/agent/documents/actions";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";
import { canonicalNoteHtml } from "../src/utils/noteHtml";

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
  let reloadCalls: number;
  let corruptReloadsFrom: number;
  let restoreRetrievalInvalidator: (() => void) | null = null;

  before(function () {
    // Note mutations invalidate cached paper context, which reaches the
    // panel's retrieval cache through a host surface bridge the plugin
    // composes at startup.
    restoreRetrievalInvalidator = composeRetrievalCandidateInvalidation();
  });

  after(function () {
    restoreRetrievalInvalidator?.();
    restoreRetrievalInvalidator = null;
  });

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
    reloadCalls = 0;
    corruptReloadsFrom = Number.POSITIVE_INFINITY;
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
      collections: number[] = [];
      dateAdded = "2026-09-07 00:00:00";
      addToCollection(collectionId: number) {
        if (!this.collections.includes(collectionId))
          this.collections.push(collectionId);
      }
      getCollections() {
        return [...this.collections];
      }
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
        reloadCalls++;
        // A forced read-back can disagree with the in-memory note when the
        // native write never reached the database.
        this.html =
          reloadCalls >= corruptReloadsFrom
            ? "<h1>Summary</h1><p>Truncated by another client.</p>"
            : this.stored;
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
      Collections: {
        get: (id: number) =>
          id === 7 || id === 8
            ? { id, libraryID: 1, deleted: false, name: `Folder ${id}` }
            : false,
      },
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
  /** Direct Agent execution context: no semantic contract, only a run identity. */
  function directContext(runId: string | undefined) {
    return {
      request: {
        conversationKey: 42,
        libraryID: 1,
        executionContext: {
          version: 1,
          executionId: "direct-execution-42",
        },
      },
      runId,
    } as any;
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
    const tool = createNoteWriteTool(gateway);
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
  it("allows a direct finalized document to enter the shared note lifecycle without semantic state", async function () {
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = directContext("summary-run");

    await tool.planInvocation(input.value, context);
    const proposals = await tool.describeAction!(input.value, context);

    assert.equal(proposals[0].parameters?.documentId, document.documentId);
    assert.equal(proposals[0].parameters?.contentHash, document.contentHash);
    assert.include(
      proposals[0].parameters?.expectedText || "",
      "Exact durable summary.",
    );
  });
  it("binds the note proposal to its destination and note mode", async function () {
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = directContext("summary-run");

    await tool.planInvocation(input.value, context);
    const proposals = await tool.describeAction!(input.value, context);

    assert.equal(proposals[0].parameters?.targetItemId, 42);
    assert.equal(proposals[0].parameters?.noteMode, "create");
  });
  it("freezes the exact material reference in the note proposal", async function () {
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = directContext("summary-run");

    await tool.planInvocation(input.value, context);
    const proposals = await tool.describeAction!(input.value, context);

    assert.equal(proposals[0].parameters?.documentId, document.documentId);
    assert.equal(proposals[0].parameters?.documentVersion, 1);
    assert.equal(proposals[0].parameters?.contentHash, document.contentHash);
  });
  it("saves a direct finalized document in a later run of the same conversation", async function () {
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    // The generate turn finalized the document; the save turn is a new run.
    const saving = {
      ...directContext("a-later-run"),
      journalFallbackApproved: true,
    };

    await tool.planInvocation(input.value, saving);
    const proposals = await tool.describeAction!(input.value, saving);
    assert.equal(proposals[0].parameters?.contentHash, document.contentHash);

    const result: any = await tool.execute(input.value, saving);
    assert.equal(result.effect, "applied");
    assert.equal(notes.size, 1);
    assert.include(
      notes.get([...notes.keys()][0]).getNote(),
      "Exact durable summary.",
    );
  });
  it("carries native note verification on the finalized-document create path", async function () {
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = {
      ...directContext("summary-run"),
      journalFallbackApproved: true,
    };

    await tool.planInvocation(input.value, context);
    const result: any = await tool.execute(input.value, context);

    // The receipt reads native evidence from the innermost tool result.
    const saved: any = innermostToolResult(result.content);
    assert.equal(saved.noteVerification?.noteId, saved.noteId);
    assert.isTrue(saved.noteVerification?.matches);
    assert.equal(saved.noteVerification?.expectedHtml, document.visibleHtml);
  });
  it("refuses a note write when the approved material content changed", async function () {
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
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "edit",
      targetNoteId: note.id,
      documentId: document.documentId,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = {
      ...directContext("summary-run"),
      journalFallbackApproved: true,
    };

    await tool.planInvocation(input.value, context);
    document.contentHash = "sha256:rewritten-content";

    await rejects(tool.execute(input.value, context), /content hash/i);
    assert.equal(note.getNote(), "<p>Original</p>");
    assert.equal(imageImports, 0);
  });
  it("refuses a note write when the approved material version changed", async function () {
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
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "edit",
      targetNoteId: note.id,
      documentId: document.documentId,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = {
      ...directContext("summary-run"),
      journalFallbackApproved: true,
    };

    await tool.planInvocation(input.value, context);
    document.documentVersion = 2;

    await rejects(tool.execute(input.value, context), /version/i);
    assert.equal(note.getNote(), "<p>Original</p>");
    assert.equal(imageImports, 0);
  });
  it("refuses a finalized document that is not a direct version 2 document", async function () {
    document.origin = {
      kind: "planned",
      planId: "plan-1",
      planRevision: 1,
      executionId: "execution-1",
      parentTaskId: "task-1",
      contractDigest: "digest-1",
    };
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;

    await rejects(
      tool.planInvocation(input.value, directContext("summary-run")),
      /not a direct version 2 Agent document/,
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
    const tool = createNoteWriteTool(gateway);
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
  it("saves a document's citation requests as Zotero citation chips, and proves them on retry", async function () {
    globals.Zotero.URI = {
      getItemURI: (item: { key: string }) =>
        `http://zotero.org/users/local/abc/items/${item.key}`,
    };
    globals.Zotero.Utilities.Item = {
      itemToCSLJSON: () => ({
        title: "Paper",
        author: [{ family: "Smith" }],
        issued: { "date-parts": [[2020]] },
      }),
    };
    document.visibleHtml =
      "<h1>Summary</h1><p>Turnover drives drift {{cite item=42 page=7}}.</p>";
    const saved = await savePlanDocumentAsNote(document.documentId);
    const html = notes.get(saved.itemId).getNote();
    assert.match(
      html,
      /^<div data-citation-items="[^"]+" data-schema-version="9">/,
    );
    assert.include(
      html,
      '>(<span class="citation-item">Smith, 2020, p. 7</span>)</span>.',
    );
    assert.notInclude(html, "{{cite");
    const retried = await savePlanDocumentAsNote(document.documentId);
    assert.isFalse(retried.created);
    assert.equal(retried.itemId, saved.itemId);
    assert.isTrue(retried.noteVerification?.matches);
  });

  /** The cited paper's metadata as Zotero reports it right now. */
  function citedMetadata(family: string) {
    globals.Zotero.URI = {
      getItemURI: (item: { key: string }) =>
        `http://zotero.org/users/local/abc/items/${item.key}`,
    };
    globals.Zotero.Utilities.Item = {
      itemToCSLJSON: () => ({
        title: "Paper",
        author: [{ family }],
        issued: { "date-parts": [[2020]] },
      }),
    };
  }

  it("recognizes a saved citation note after the cited paper's metadata changed", async function () {
    citedMetadata("Smith");
    document.visibleHtml =
      "<h1>Summary</h1><p>Turnover drives drift {{cite item=42 page=7}}.</p>";
    const target = { parentItemId: 42, libraryID: 1 };
    const saved = await savePlanDocumentAsNote(document.documentId, target);
    const stored = notes.get(saved.itemId).getNote();

    // The user corrects the author after the note was saved. The note keeps
    // the label it was written with; the retry must still recognize it.
    citedMetadata("Jones");
    const retried = await savePlanDocumentAsNote(document.documentId, target);
    assert.isFalse(retried.created);
    assert.equal(retried.itemId, saved.itemId);
    assert.equal(notes.size, 1);
    assert.equal(notes.get(saved.itemId).getNote(), stored);
    // The proof is the forced read-back whose hash the save recorded.
    assert.isTrue(retried.noteVerification?.matches);
    assert.equal(retried.noteVerification?.expectedHtml, stored);

    // The receipt accepts that proof for the same note_write proposal.
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    const context = directContext("summary-run");
    await tool.planInvocation(input.value, context);
    const [proposal] = await tool.describeAction!(input.value, context);
    const receipt = await verifyNoteWriteTarget(
      proposal,
      {
        result: {
          noteId: retried.itemId,
          noteVerification: retried.noteVerification,
        },
      },
      gateway,
    );
    assert.deepEqual(receipt.targets, [`item:${saved.itemId}`]);
  });

  /** What Zotero's note editor writes back after refreshing a work's CSL data. */
  function editorRefresh(html: string, title: string): string {
    return html
      .replace(/data-citation-items="([^"]*)"/, (_match, value: string) => {
        const entries = JSON.parse(decodeURIComponent(value));
        for (const entry of entries) entry.itemData.title = title;
        return `data-citation-items="${encodeURIComponent(JSON.stringify(entries))}"`;
      })
      .replace(/(<\/(?:h1|p)>)/g, "$1\n");
  }

  it("recognizes a saved citation note after Zotero's editor refreshed the retitled work", async function () {
    citedMetadata("Smith");
    document.visibleHtml =
      "<h1>Summary</h1><p>Turnover drives drift {{cite item=42 page=7}}.</p>";
    const target = { parentItemId: 42, libraryID: 1 };
    const saved = await savePlanDocumentAsNote(document.documentId, target);
    const note = notes.get(saved.itemId);
    const refreshed = editorRefresh(note.getNote(), "Paper, retitled");
    assert.notEqual(refreshed, note.getNote());
    note.stored = refreshed;
    const retried = await savePlanDocumentAsNote(document.documentId, target);
    assert.isFalse(retried.created);
    assert.equal(retried.itemId, saved.itemId);
    assert.equal(notes.size, 1);
    assert.equal(note.getNote(), refreshed, "the retry leaves the note alone");
    assert.isTrue(retried.noteVerification?.matches);
  });

  it("still refuses a refreshed citation note whose chip was edited", async function () {
    citedMetadata("Smith");
    document.visibleHtml =
      "<h1>Summary</h1><p>Turnover drives drift {{cite item=42 page=7}}.</p>";
    const saved = await savePlanDocumentAsNote(document.documentId);
    const note = notes.get(saved.itemId);
    note.stored = editorRefresh(note.getNote(), "Paper, retitled").replace(
      "Smith, 2020, p. 7",
      "Smith, 2020, p. 8",
    );
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /no longer matches this exact document/,
    );
  });

  it("keeps judging a version 1 binding by the full root registry", async function () {
    citedMetadata("Smith");
    document.visibleHtml =
      "<h1>Summary</h1><p>Turnover drives drift {{cite item=42 page=7}}.</p>";
    const saved = await savePlanDocumentAsNote(document.documentId);
    const note = notes.get(saved.itemId);
    state = {
      ...state,
      savedNote: {
        ...state.savedNote,
        nativeContentHash: await sha256Text(canonicalNoteHtml(note.getNote())),
        nativeContentHashVersion: 1,
      },
    };
    const retried = await savePlanDocumentAsNote(document.documentId);
    assert.isFalse(retried.created);
    assert.equal(retried.itemId, saved.itemId);
    note.stored = editorRefresh(note.getNote(), "Paper, retitled");
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /no longer matches this exact document/,
    );
  });

  it("recognizes a saved citation note after the cited paper was deleted", async function () {
    citedMetadata("Smith");
    document.visibleHtml =
      "<h1>Summary</h1><p>Turnover drives drift {{cite item=42 page=7}}.</p>";
    const saved = await savePlanDocumentAsNote(document.documentId);
    const items = globals.Zotero.Items;
    globals.Zotero.Items = {
      ...items,
      get: (id: number) => (id === 42 ? false : items.get(id)),
      getByLibraryAndKey: (lib: number, key: string) =>
        key === "PAPER42" ? false : items.getByLibraryAndKey(lib, key),
    };
    const retried = await savePlanDocumentAsNote(document.documentId);
    assert.isFalse(retried.created);
    assert.equal(retried.itemId, saved.itemId);
    assert.isTrue(retried.noteVerification?.matches);
  });

  it("still refuses a changed citation note even though its hash cannot be rebuilt", async function () {
    citedMetadata("Smith");
    document.visibleHtml =
      "<h1>Summary</h1><p>Turnover drives drift {{cite item=42 page=7}}.</p>";
    const saved = await savePlanDocumentAsNote(document.documentId);
    notes.get(saved.itemId).stored = "<p>Rewritten by the user</p>";
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /no longer matches this exact document/,
    );
  });

  it("proves a citation-free document on retry against its own body", async function () {
    const saved = await savePlanDocumentAsNote(document.documentId);
    const retried = await savePlanDocumentAsNote(document.documentId);
    assert.isFalse(retried.created);
    assert.equal(retried.itemId, saved.itemId);
    assert.isTrue(retried.noteVerification?.matches);
    assert.equal(retried.noteVerification?.expectedHtml, document.visibleHtml);
  });

  it("judges a binding older than stored hashes without making citations", async function () {
    // Bindings without a stored hash predate citation requests: their note
    // holds the document's HTML as written, and the cited item may be gone.
    // The retry compares against that HTML as it did before citations
    // existed, so a missing cited item can never turn it into a citation
    // error.
    document.visibleHtml = "<p>Text {{cite item=999 page=7}}.</p>";
    const legacy = new globals.Zotero.Item("note");
    legacy.key = "LEGACY01";
    legacy.primaryLoaded = true;
    legacy.setNote(document.visibleHtml);
    await legacy.saveTx();
    state = {
      version: 1,
      documentId: document.documentId,
      savedNote: { libraryID: 1, itemKey: "LEGACY01" },
      updatedAt: 1,
    };
    let failure: unknown;
    try {
      await savePlanDocumentAsNote(document.documentId);
    } catch (error) {
      failure = error;
    }
    assert.notMatch(String(failure), /cite|citation|Zotero paper/i);
    assert.equal(notes.size, 1, "a retry never creates a replacement");
    assert.equal(state.savedNote.itemKey, "LEGACY01");
  });

  it("refuses a document citation of an item that cannot be cited, reserving nothing", async function () {
    document.visibleHtml = "<p>Text {{cite item=999 page=7}}.</p>";
    await rejects(
      savePlanDocumentAsNote(document.documentId),
      /999 is not a Zotero paper or book/,
    );
    assert.equal(notes.size, 0);
    assert.isUndefined(state?.pendingNote);
  });

  it("does not record a document as saved when the final read-back disagrees", async function () {
    const target = { parentItemId: 42, libraryID: 1 };
    // Calibrate against a healthy save so the corruption lands on the last
    // forced read-back whatever the persistence internals do.
    await savePlanDocumentAsNote(document.documentId, target);
    const readBacksPerSave = reloadCalls;
    state = undefined;
    notes.clear();

    corruptReloadsFrom = reloadCalls + readBacksPerSave;
    await rejects(
      savePlanDocumentAsNote(document.documentId, target),
      /does not match the finalized content/,
    );
    assert.isUndefined(state?.savedNote);
    assert.isDefined(state?.pendingNote);

    corruptReloadsFrom = Number.POSITIVE_INFINITY;
    const retried = await savePlanDocumentAsNote(document.documentId, target);
    assert.isTrue(retried.noteVerification?.matches);
    assert.equal(notes.size, 1);
  });
  it("does not promote a reserved note whose read-back cannot be verified", async function () {
    const target = { parentItemId: 42, libraryID: 1 };
    failAssociation = true;
    await rejects(
      savePlanDocumentAsNote(document.documentId, target),
      /Association storage unavailable/,
    );
    failAssociation = false;
    const reserved = JSON.parse(JSON.stringify(state));
    assert.isUndefined(reserved.savedNote);

    // Calibrate the already-reserved branch, then replay it from the same
    // unpromoted state with its last read-back corrupted.
    const before = reloadCalls;
    const satisfied = await savePlanDocumentAsNote(document.documentId, target);
    assert.isFalse(satisfied.created);
    const readBacks = reloadCalls - before;
    state = reserved;

    corruptReloadsFrom = reloadCalls + readBacks;
    await rejects(
      savePlanDocumentAsNote(document.documentId, target),
      /no longer matches this exact document/,
    );
    assert.isUndefined(state?.savedNote);
  });
  it("saves a finalized document as a standalone note filed in collections, and its retry finds the same note", async function () {
    const target = {
      standalone: true as const,
      libraryID: 1,
      collectionIds: [7, 8],
    };
    const saved = await savePlanDocumentAsNote(document.documentId, target);
    const note = notes.get(saved.itemId);
    assert.isTrue(saved.created);
    assert.isUndefined(note.parentID);
    assert.deepEqual(note.getCollections(), [7, 8]);
    assert.equal(note.getNote(), document.visibleHtml);
    const retried = await savePlanDocumentAsNote(document.documentId, target);
    assert.isFalse(retried.created);
    assert.equal(retried.itemId, saved.itemId);
    assert.equal(notes.size, 1);
  });
  it("finds the same standalone note when its association failed after the save", async function () {
    const target = {
      standalone: true as const,
      libraryID: 1,
      collectionIds: [7],
    };
    failAssociation = true;
    await rejects(
      savePlanDocumentAsNote(document.documentId, target),
      /Association storage/,
    );
    const reservedKey = state.pendingNote.itemKey;
    assert.isUndefined(state.pendingNote.parentItemId);
    failAssociation = false;
    state = JSON.parse(JSON.stringify(state));
    const recovered = await savePlanDocumentAsNote(document.documentId, target);
    assert.isFalse(recovered.created);
    assert.equal(recovered.itemKey, reservedKey);
    assert.equal(notes.size, 1);
    assert.equal(state.savedNote.itemKey, reservedKey);
  });
  it("refuses a standalone save into a collection that does not exist, reserving nothing", async function () {
    await rejects(
      savePlanDocumentAsNote(document.documentId, {
        standalone: true,
        libraryID: 1,
        collectionIds: [99],
      }),
      /Collection 99/,
    );
    assert.equal(notes.size, 0);
    assert.isUndefined(state?.pendingNote);
  });
  it("refuses a standalone retry of a document already saved under a parent", async function () {
    await savePlanDocumentAsNote(document.documentId, {
      parentItemId: 42,
      libraryID: 1,
    });
    await rejects(
      savePlanDocumentAsNote(document.documentId, {
        standalone: true,
        libraryID: 1,
      }),
      /different parent/,
    );
    assert.equal(notes.size, 1);
  });
  it("refuses a retry whose saved note left a requested collection", async function () {
    const target = {
      standalone: true as const,
      libraryID: 1,
      collectionIds: [7],
    };
    const saved = await savePlanDocumentAsNote(document.documentId, target);
    notes.get(saved.itemId).collections = [];
    await rejects(
      savePlanDocumentAsNote(document.documentId, target),
      /no longer matches this exact document/,
    );
    assert.equal(notes.size, 1);
  });
  it("saves a finalized document through note_write as a standalone note in a collection", async function () {
    const gateway = {
      getItem: (id: number) => globals.Zotero.Items.get(id),
    } as any;
    const tool = createNoteWriteTool(gateway);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      target: "standalone",
      collections: [7],
    });
    assert.isTrue(input.ok, input.ok ? "" : input.error);
    if (!input.ok) return;
    const context = {
      ...directContext("summary-run"),
      journalFallbackApproved: true,
    };
    await tool.planInvocation(input.value, context);
    const proposals = await tool.describeAction!(input.value, context);
    assert.deepEqual(proposals[0].destinationCollectionIds, [7]);
    const result: any = await tool.execute(input.value, context);
    assert.equal(result.effect, "applied");
    const saved: any = innermostToolResult(result.content);
    const note = notes.get(saved.noteId);
    assert.isUndefined(note.parentID);
    assert.deepEqual(note.getCollections(), [7]);
    const verification = await verifyNoteWriteTarget(
      proposals[0],
      result.content,
      gateway,
    );
    assert.isNotNull(verification.targets, verification.reason);
  });
  it("refuses a finalized document create that names both a parent and collections", function () {
    const tool = createNoteWriteTool({} as any);
    const input = tool.validate({
      mode: "create",
      documentId: document.documentId,
      targetItemId: 42,
      collections: [7],
    });
    assert.isFalse(input.ok);
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
