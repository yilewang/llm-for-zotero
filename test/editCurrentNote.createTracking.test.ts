import { canonicalNoteHtml } from "../src/utils/noteHtml";
import { assert } from "chai";
import { readFileSync } from "node:fs";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { setOriginalAgentPermissionMode } from "../src/agent/originalAgentPermissionMode";
import { revertActions } from "../src/agent/services/changeReverter";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";
import { createRenamedTool } from "../src/agent/tools/facade";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import type { AgentToolContext } from "../src/agent/types";
import {
  containsVisualFigureFences,
  resolveSvgFigureRasterSize,
} from "../src/modules/contextPanel/figureExport";
import {
  createAssistantResponseNote,
  createNoteFromChatHistory,
  normalizeNoteSourceText,
  stripNoteHtml,
} from "../src/modules/contextPanel/notes";
import {
  getTrackedAssistantNoteForParent,
  rememberAssistantNoteForParent,
} from "../src/modules/contextPanel/prefHelpers";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import {
  actionFixture,
  classifiedFixture,
  semanticFixture,
} from "./helpers/semanticIntent";

describe("editCurrentNote create tracking", function () {
  it("only defers notes that contain supported visual figure fences", function () {
    assert.isFalse(containsVisualFigureFences("Plain text"));
    assert.isFalse(
      containsVisualFigureFences("```ts\nconst svg = '<svg />';\n```"),
    );
    assert.isTrue(
      containsVisualFigureFences('```svg\n<svg viewBox="0 0 10 10" />\n```'),
    );
    assert.isTrue(
      containsVisualFigureFences("```mermaid\ngraph TD\nA-->B\n```"),
    );
  });

  const baseContext: AgentToolContext = {
    request: {
      classifiedIntent: classifiedFixture(),
      conversationKey: 91,
      mode: "agent",
      userText: "save this note",
      activeItemId: 9,
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
    journalFallbackApproved: true,
  };

  const globalScope = globalThis as typeof globalThis & {
    ztoolkit?: {
      log?: (...args: unknown[]) => void;
    };
    Zotero?: {
      Prefs?: {
        get?: (key: string, global?: boolean) => unknown;
        set?: (key: string, value: unknown, global?: boolean) => void;
      };
      Items?: {
        get?: (id: number) => Zotero.Item | null;
      };
      Item?: new (itemType: string) => Zotero.Item;
      Attachments?: {
        importEmbeddedImage?: (params: {
          blob: Blob;
          parentItemID: number;
          saveOptions?: { notifierQueue?: unknown };
        }) => Promise<{ key: string } | null>;
      };
      Notifier?: {
        Queue: new () => unknown;
        commit: (queue: unknown) => Promise<void>;
      };
    };
    IOUtils?: {
      read?: (path: string) => Promise<Uint8Array>;
    };
  };
  const originalZotero = globalScope.Zotero;
  const originalZtoolkit = globalScope.ztoolkit;
  const originalIOUtils = globalScope.IOUtils;
  const prefStore = new Map<string, unknown>();
  const savedItems = new Map<number, Zotero.Item>();
  const parentNoteIds: number[] = [];
  const importedImageParents: number[] = [];
  const importedImagePaths: string[] = [];
  const importedImageMimeTypes: string[] = [];
  const importedImageByteSizes: number[] = [];
  const importedImageNotifierQueues: unknown[] = [];
  const committedNotifierQueues: unknown[] = [];
  let nextNoteId = 100;
  let parentItem: Zotero.Item;

  class MockNoteItem {
    id = 0;
    libraryID = 0;
    key = "NOTEKEY";
    itemTypeID = 1;
    parentID?: number;
    dateAdded = "";
    dateModified = "";
    version = 0;
    deleted = false;
    readonly saveOptionsHistory: Array<{ notifierQueue?: unknown }> = [];
    wrapOnReload = false;
    private noteHtml = "";

    constructor(itemType: string) {
      assert.equal(itemType, "note");
    }

    isNote() {
      return true;
    }

    isAttachment() {
      return false;
    }

    setNote(html: string) {
      this.noteHtml = html;
    }

    getNote() {
      return this.noteHtml;
    }

    getField(field: string) {
      if (field === "dateAdded") return this.dateAdded;
      if (field === "dateModified") return this.dateModified;
      return "";
    }

    getNoteTitle() {
      return "";
    }

    getDisplayTitle() {
      return "";
    }

    async loadPrimaryData() {}

    async saveTx(options: { notifierQueue?: unknown } = {}) {
      this.saveOptionsHistory.push(options);
      if (!this.id) {
        this.id = nextNoteId++;
        this.dateAdded = "2026-08-28 10:00:00";
      }
      this.version += 1;
      this.dateModified = `2026-08-28 10:00:0${this.version}`;
      savedItems.set(this.id, this as unknown as Zotero.Item);
      if (this.parentID && !parentNoteIds.includes(this.id)) {
        parentNoteIds.push(this.id);
      }
      return this.id;
    }

    async reload() {
      if (
        this.wrapOnReload &&
        !this.noteHtml.startsWith('<div class="zotero-note ')
      ) {
        this.noteHtml = `<div class="zotero-note znv3">${this.noteHtml}</div>`;
      }
    }
  }

  function childNotes(parentId = 9): MockNoteItem[] {
    return Array.from(savedItems.values()).filter(
      (item) => (item as any).isNote?.() && item.parentID === parentId,
    ) as unknown as MockNoteItem[];
  }

  function saveExistingNote(
    id: number,
    parentID: number | undefined,
    html: string,
  ): MockNoteItem {
    const note = new MockNoteItem("note");
    note.id = id;
    note.libraryID = 1;
    note.parentID = parentID;
    note.setNote(html);
    savedItems.set(id, note as unknown as Zotero.Item);
    if (parentID && !parentNoteIds.includes(id)) {
      parentNoteIds.push(id);
    }
    nextNoteId = Math.max(nextNoteId, id + 1);
    return note;
  }

  beforeEach(function () {
    prefStore.clear();
    savedItems.clear();
    parentNoteIds.splice(0);
    importedImageParents.splice(0);
    importedImagePaths.splice(0);
    importedImageMimeTypes.splice(0);
    importedImageByteSizes.splice(0);
    importedImageNotifierQueues.splice(0);
    committedNotifierQueues.splice(0);
    nextNoteId = 100;
    parentItem = {
      id: 9,
      libraryID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      getNotes: () => [...parentNoteIds],
      getDisplayTitle: () => "Parent Paper",
    } as unknown as Zotero.Item;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
      Utilities: { generateObjectKey: () => `KEY${nextNoteId}` },
      Items: {
        getByLibraryAndKey: (libraryID: number, key: string) =>
          [...savedItems.values()].find(
            (item) => item.libraryID === libraryID && item.key === key,
          ) || null,
        get: (id: number) =>
          savedItems.get(id) || (id === 9 ? parentItem : null),
      },
      Item: MockNoteItem as unknown as new (itemType: string) => Zotero.Item,
      Notifier: {
        Queue: class {},
        commit: async (queue) => {
          committedNotifierQueues.push(queue);
        },
      },
      Attachments: {
        importEmbeddedImage: async ({ blob, parentItemID, saveOptions }) => {
          importedImageParents.push(parentItemID);
          importedImageMimeTypes.push(blob.type);
          importedImageByteSizes.push(blob.size);
          importedImageNotifierQueues.push(saveOptions?.notifierQueue);
          return { key: `IMG${parentItemID}_${importedImageParents.length}` };
        },
      },
    };
    globalScope.IOUtils = {
      read: async (path: string) => {
        importedImagePaths.push(path);
        return new Uint8Array([1, 2, 3, 4]);
      },
    };
    globalScope.ztoolkit = {
      ...(originalZtoolkit || {}),
      log: () => {},
    };
  });

  afterEach(function () {
    if (originalZtoolkit) {
      globalScope.ztoolkit = originalZtoolkit;
    } else {
      delete globalScope.ztoolkit;
    }
    if (originalZotero) {
      globalScope.Zotero = originalZotero;
    } else {
      delete globalScope.Zotero;
    }
    if (originalIOUtils) {
      globalScope.IOUtils = originalIOUtils;
    } else {
      delete globalScope.IOUtils;
    }
  });

  it("copies an existing note without adding provenance or rewriting its native formatting", async function () {
    const html = readFileSync("test/fixtures/live-synthetic-note.html", "utf8");
    const original = saveExistingNote(80, 9, html);
    const tool = createEditCurrentNoteTool({
      getItem: (id: number) => savedItems.get(id),
    } as never);
    const validated = tool.validate({
      mode: "create",
      target: "standalone",
      sourceNoteId: 80,
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) return;
    await tool.planInvocation!(validated.value, baseContext);
    assert.equal(
      tool.describeAction!(validated.value, baseContext)[0].parameters
        ?.expectedText,
      stripNoteHtml(html),
    );
    const result = (await tool.execute(validated.value, baseContext))
      .content as any;
    const copy = savedItems.get(result.noteId)!;
    assert.notEqual(copy.id, original.id);
    assert.isUndefined(copy.parentID);
    assert.equal(copy.getNote(), html);
    assert.equal(original.getNote(), html);
    assert.equal((copy.getNote().match(/Model response:/g) || []).length, 1);
  });

  it("rejects ambiguous or non-create source-note copying before writing", function () {
    const tool = createEditCurrentNoteTool({} as never);
    for (const args of [
      { mode: "create", sourceNoteId: 80, content: "Conflicting rewrite" },
      {
        mode: "edit",
        sourceNoteId: 80,
        patches: [{ find: "a", replace: "b" }],
      },
      { mode: "append", sourceNoteId: 80, content: "Append" },
    ])
      assert.isFalse(tool.validate(args).ok, JSON.stringify(args));
  });

  it("rejects copying a missing source or a note from another library", async function () {
    const note = saveExistingNote(80, undefined, "<p>Private source</p>");
    note.libraryID = 2;
    const tool = createEditCurrentNoteTool({
      getItem: (id: number) => savedItems.get(id),
    } as never);
    for (const sourceNoteId of [80, 404]) {
      const input = tool.validate({
        mode: "create",
        target: "standalone",
        sourceNoteId,
      });
      assert.isTrue(input.ok);
      if (!input.ok) continue;
      let error = "";
      try {
        await tool.planInvocation!(input.value, baseContext);
      } catch (e) {
        error = String(e);
      }
      assert.match(error, /source note.*(?:library|available)/i);
      assert.equal(savedItems.size, 1);
    }
  });

  it("does not remember agent-created HTML notes for response-menu appends", async function () {
    const tool = createEditCurrentNoteTool({
      getItem: (id: number) =>
        id === 9
          ? ({
              id: 9,
              libraryID: 1,
              isRegularItem: () => true,
              isAttachment: () => false,
            } as unknown as Zotero.Item)
          : savedItems.get(id) || null,
    } as never);

    const result = (
      await tool.execute(
        {
          mode: "create",
          content: '<div style="color: red">Styled note</div>',
          _isHtml: true,
          target: "item",
        },
        baseContext,
      )
    ).content;
    assert.deepInclude(result, {
      status: "created",
      noteId: 100,
      title: "",
      // Present-but-undefined: this note asked for no collections. The key
      // exists so the manual (image) branch reports where a note landed,
      // matching the mutation-service branch.
      collections: undefined,
      createdNoteReceipt: {
        schemaVersion: 1,
        operation: "created",
        note: {
          itemId: 100,
          libraryID: 1,
          key: "KEY100",
          noteKind: "item",
          parentItemId: 9,
          dateAdded: "2026-08-28 10:00:00",
          dateModified: "2026-08-28 10:00:01",
          version: 1,
        },
      },
    });

    const tracked = getTrackedAssistantNoteForParent(9);
    assert.isNull(tracked);
    const cards = tool.presentation?.buildResultCards?.(result);
    assert.lengthOf(
      cards || [],
      1,
      "a verified creation displays its saved note",
    );
    assert.equal((cards![0] as any).kind, "saved_note");
    assert.equal((cards![0] as any).note.itemId, 100);
    assert.include((cards![0] as any).bodyHtml, "Styled note");
    assert.isNull(
      tool.presentation!.buildResultCards!({ status: "created", noteId: 100 }),
      "a narrative without a native creation receipt is not a saved card",
    );
    savedItems.get(100)!.deleted = true;
    assert.isNull(
      tool.presentation!.buildResultCards!(result),
      "a deleted note is not advertised as available",
    );
  });

  for (const mode of ["create", "edit", "append"] as const) {
    it(`saves the editable review payload for note ${mode} without duplicating append content`, async function () {
      const existing = saveExistingNote(50, 9, "<p>Existing body</p>");
      const tool = createEditCurrentNoteTool(new ZoteroGateway());
      const validated = tool.validate({
        mode,
        content: "Proposed body",
        target: "item",
        targetNoteId: 50,
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const action = await tool.createPendingAction!(
        validated.value,
        baseContext,
      );
      const field = action.fields.find(
        (entry) => entry.type === "textarea" && entry.id === "content",
      );
      assert.exists(field, "every note review offers an editable payload");
      assert.equal((field as { value: string }).value, "Proposed body");
      assert.equal(
        existing.getNote(),
        "<p>Existing body</p>",
        "preview never writes",
      );
      const edited = await tool.applyConfirmation!(
        validated.value,
        { content: "Human edited body" },
        baseContext,
      );
      assert.isTrue(edited.ok);
      if (!edited.ok) return;
      await tool.execute(edited.value, baseContext);
      const saved =
        mode === "create"
          ? childNotes(9).find((note) => note.id !== 50)!
          : existing;
      assert.include(saved.getNote(), "Human edited body");
      assert.notInclude(saved.getNote(), "Proposed body");
      assert.equal(
        (saved.getNote().match(/Existing body/g) || []).length,
        mode === "append" ? 1 : 0,
      );
    });
  }

  for (const mode of ["auto", "yolo", "safe"] as const) {
    it(`replaces exact HTML in ${mode} when the user prohibits creating a new note`, async function () {
      (globalScope.Zotero as unknown as { DB: ChangeJournalTestDb }).DB =
        new ChangeJournalTestDb();
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode(mode);
      const before = "<p>Existing note, not a new note.</p>";
      const existing = saveExistingNote(60, 9, before);
      const html =
        "<h1>HTML review probe</h1><p>A <strong>formatted</strong> result.</p><blockquote><p>Quoted test text.</p></blockquote><ul><li>First point</li><li>Second point</li></ul>";
      const gateway = new ZoteroGateway();
      const contracts = new ActionContractService(gateway);
      const registry = new AgentToolRegistry(contracts);
      registry.register(
        createRenamedTool({
          tool: createEditCurrentNoteTool(gateway),
          name: "note_write",
          description: "Write a note",
        }),
      );
      const request = resolvedAgentRequest({
        classifiedIntent: classifiedFixture(),
        ...baseContext.request,
        userText: `Replace the content of existing note 60 with this exact HTML: ${html}. Do not create a new note.`,
      });
      request.classifiedIntent = actionFixture(
        "note_edit",
        { targetNoteId: 60 },
        {
          constraints: [
            {
              kind: "deny_effects",
              effects: ["create"],
              domains: ["zotero_library"],
              operations: ["note_create", "save_note", "save_notes_batch"],
              description: "No new notes",
            },
          ],
        },
      );
      request.actionContract = await contracts.createContract(request);
      request.actionProgress = contracts.createProgress(request.actionContract);
      let execution = await registry.prepareExecution(
        {
          id: `html-${mode}`,
          name: "note_write",
          arguments: { mode: "edit", targetNoteId: 60, content: html },
        },
        { ...baseContext, request },
      );
      assert.equal(execution.kind, mode === "safe" ? "confirmation" : "result");
      if (execution.kind === "confirmation") {
        assert.equal(existing.getNote(), before);
        const field = execution.action.fields.find(
          (field) => field.type === "textarea",
        );
        assert.equal(field?.value, html);
        execution = await execution.execute({
          approved: true,
          data: { content: html },
        });
      }
      assert.equal(execution.kind, "result");
      if (execution.kind !== "result") return;
      assert.isTrue(
        execution.execution.result.ok,
        JSON.stringify(execution.execution.result.content),
      );
      assert.equal(existing.getNote(), html);
      assert.lengthOf(childNotes(), 1, "no new note is created");
      assert.equal(
        execution.execution.result.actionReceipts?.[0].status,
        "applied",
      );
    });

    it(`prepares a first-occurrence patch before ${mode} authorization and preserves the native HTML`, async function () {
      (globalScope.Zotero as unknown as { DB: ChangeJournalTestDb }).DB =
        new ChangeJournalTestDb();
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode(mode);
      const before =
        readFileSync(
          new URL("./fixtures/live-synthetic-note.html", import.meta.url),
          "utf8",
        ).trim() +
        "<p>The paper&#039;s text also contains &#x2014;, &amp;lt;literal&amp;gt;, &lt;tag&gt; and variable_name.</p>" +
        '<ol start="3"><li>copper-limitation</li></ol>' +
        '<p><img data-attachment-key="FIGURE1" /></p>';
      const existing = saveExistingNote(60, 9, before);
      const gateway = new ZoteroGateway();
      const contracts = new ActionContractService(gateway);
      const registry = new AgentToolRegistry(contracts);
      registry.register(
        createRenamedTool({
          tool: createEditCurrentNoteTool(gateway),
          name: "note_write",
          description: "Write a note",
        }),
      );
      const request = resolvedAgentRequest({
        ...baseContext.request,
        userText:
          'In note 60, replace only the first occurrence of "copper-limitation" with "copper-limitation (reviewed)". Preserve every other character and section.',
        classifiedIntent: {
          semantic: semanticFixture(),
          type: "note",
          actionIntents: [
            {
              operation: "note_edit",
              capability: "zotero.notes",
              proofDomain: "zotero_state",
              coverage: "one",
              targetKind: "items",
              parameters: { targetNoteId: 60 },
            },
          ],
        },
      });
      request.actionContract = await contracts.createContract(request);
      request.actionProgress = contracts.createProgress(request.actionContract);
      let result = await registry.prepareExecution(
        {
          id: `patch-${mode}`,
          name: "note_write",
          arguments: {
            mode: "edit",
            targetNoteId: 60,
            patches: [
              {
                find: "copper-limitation",
                replace: "copper-limitation (reviewed)",
              },
            ],
          },
        },
        { ...baseContext, request },
      );
      assert.equal(result.kind, mode === "safe" ? "confirmation" : "result");
      if (result.kind === "confirmation") {
        assert.equal(existing.getNote(), before, "review must not write");
        const diff = result.action.fields.find(
          (field) => field.type === "diff_preview",
        );
        assert.isOk(diff);
        if (diff?.type === "diff_preview") {
          assert.equal(
            diff.before,
            normalizeNoteSourceText(before),
            "both sides use the same readable Markdown representation",
          );
          assert.equal(
            diff.after,
            diff.before.replace(
              "copper-limitation",
              "copper-limitation (reviewed)",
            ),
            "a one-word edit does not appear as a whole-note rewrite",
          );
        }
        result = await result.execute({ approved: true });
      }
      assert.equal(result.kind, "result");
      if (result.kind !== "result") return;
      assert.isTrue(
        result.execution.result.ok,
        JSON.stringify(result.execution.result.content),
      );
      assert.equal(
        result.execution.result.actionReceipts?.[0].verification,
        "verified",
        "a native HTML edit is not complete merely because the tool returned ok",
      );
      assert.equal(
        existing.getNote(),
        before.replace("copper-limitation", "copper-limitation (reviewed)"),
      );
      assert.include(
        result.execution.result.actionReceipts?.[0].normalizedParameters
          ?.expectedText || "",
        "copper-limitation (reviewed)",
        "verification must bind the prepared content, not an empty placeholder",
      );
      assert.equal(
        result.execution.result.actionReceipts?.[0].normalizedParameters
          ?.expectedText,
        stripNoteHtml(
          before.replace("copper-limitation", "copper-limitation (reviewed)"),
        ),
        "the receipt must describe the exact native HTML payload without a second Markdown rendering",
      );
    });
  }

  it("prepares a patch for direct execution without a review-card callback", async function () {
    const before = "<p>copper-limitation first. copper-limitation second.</p>";
    const existing = saveExistingNote(60, 9, before);
    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const validated = tool.validate({
      mode: "edit",
      targetNoteId: 60,
      patches: [
        { find: "copper-limitation", replace: "copper-limitation (reviewed)" },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.execute(validated.value, baseContext);
    assert.equal(
      existing.getNote(),
      before.replace("copper-limitation", "copper-limitation (reviewed)"),
    );
  });

  for (const example of [
    ...["\n", "\n\n", "\r\n", "\r\n\r\n"].map((separator) => ({
      name: `paragraph selection with ${JSON.stringify(separator)}`,
      before: "<p>First paragraph</p><p>Second paragraph</p><p>Keep me.</p>",
      find: `First paragraph${separator}Second paragraph`,
      replacement: "Replacement",
      after: "<p>Replacement</p><p>Keep me.</p>",
    })),
    {
      name: "line breaks and nested blocks",
      before: "<div><h2>Heading</h2><p>First<br/>Second</p></div><p>After</p>",
      find: "Heading\nFirst\nSecond\nAfter",
      replacement: "Combined",
      after: "<div><h2>Combined</h2></div>",
    },
    {
      name: "list items and inline formatting around a multiline match",
      before:
        "<ol><li>Before <em>alpha</em></li><li><strong>beta</strong> after</li></ol>",
      find: "alpha\nbeta",
      replacement: "delta",
      after:
        "<ol><li>Before <em>delta</em></li><li><strong></strong> after</li></ol>",
    },
    {
      name: "images inside and outside a multiline selection",
      before:
        '<p>Start<img data-attachment-key="IMAGE001"/></p><p>End</p><p><img data-attachment-key="IMAGE002"/>Keep</p>',
      find: "Start\nEnd",
      replacement: "Changed",
      after:
        '<p>Changed<img data-attachment-key="IMAGE001"/></p><p><img data-attachment-key="IMAGE002"/>Keep</p>',
    },
    {
      name: "multiline Unicode entities and first-occurrence selection",
      before: "<p>&#x1F9E0; A &amp; B</p><p>C</p><p>🧠 A &amp; B</p><p>C</p>",
      find: "🧠 A & B\nC",
      replacement: "Result",
      after: "<p>Result</p><p>🧠 A &amp; B</p><p>C</p>",
    },
    {
      name: "serialized newlines alongside paragraph boundaries",
      before: "<p>First</p>\r\n<p>Second</p>",
      find: "First\n\nSecond",
      replacement: "Result",
      after: "<p>Result</p>",
    },
    {
      name: "visible text rather than an attribute",
      before: '<p title="copper-limitation">copper-limitation</p>',
      find: "copper-limitation",
      replacement: "reviewed limitation",
      after: '<p title="copper-limitation">reviewed limitation</p>',
    },
    {
      name: "UTF-16 offsets after an astral entity",
      before: "<p>&#x1F9E0; A &amp; B</p>",
      find: "A & B",
      replacement: "C & D",
      after: "<p>&#x1F9E0; C &amp; D</p>",
    },
    {
      name: "balanced inline markup across a match",
      before: "<p>alpha <em>beta</em> gamma.</p>",
      find: "alpha beta",
      replacement: "delta",
      after: "<p>delta<em></em> gamma.</p>",
    },
  ]) {
    it(`patches ${example.name} without damaging the native note`, async function () {
      const existing = saveExistingNote(60, 9, example.before);
      const tool = createEditCurrentNoteTool(new ZoteroGateway());
      const validated = tool.validate({
        mode: "edit",
        targetNoteId: 60,
        patches: [{ find: example.find, replace: example.replacement }],
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      await tool.execute(validated.value, baseContext);
      assert.equal(existing.getNote(), example.after);
    });
  }

  it("prepares a patch copied from the Markdown note reader with explicit format", async function () {
    const before =
      "<p>Items marked <strong>Discussion-only (ours)</strong> are our proposals.</p>";
    const existing = saveExistingNote(60, 9, before);
    const gateway = new ZoteroGateway();
    const reading = gateway.getStandaloneNoteContent({ noteId: 60 })!;
    const tool = createEditCurrentNoteTool(gateway);
    const validated = tool.validate({
      mode: "edit",
      targetNoteId: 60,
      patches: [
        {
          find: reading.noteText,
          findFormat: "markdown",
          replace: "These proposals are ours.",
        },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const action = await tool.createPendingAction!(
      validated.value,
      baseContext,
    );
    assert.equal(action.mode, "review");
    assert.equal(existing.getNote(), before);
    assert.isTrue(
      action.fields.some(
        (field) =>
          field.type === "diff_preview" &&
          field.after.includes("These proposals are ours."),
      ),
    );
  });

  it("reviews and applies multiline Markdown from the note reader without rewriting surrounding HTML", async function () {
    const before =
      "<h2>Topic</h2><p><strong>First</strong> paragraph.</p><p>Second paragraph.</p>";
    const existing = saveExistingNote(60, 9, before);
    const gateway = new ZoteroGateway();
    const reading = gateway.getStandaloneNoteContent({ noteId: 60 })!;
    const tool = createEditCurrentNoteTool(gateway);
    const validated = tool.validate({
      mode: "edit",
      targetNoteId: 60,
      patches: [
        {
          find: reading.noteText,
          findFormat: "markdown",
          replace: "Revised summary.",
        },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.planInvocation!(validated.value, baseContext);
    const review = await tool.createPendingAction!(
      validated.value,
      baseContext,
    );
    assert.equal(
      existing.getNote(),
      before,
      "Preparing review must not mutate the note",
    );
    assert.equal(review.mode, "review");
    const approved = await tool.applyConfirmation!(
      validated.value,
      {},
      baseContext,
    );
    assert.isTrue(approved.ok);
    if (!approved.ok) return;
    await tool.execute(approved.value, baseContext);
    assert.equal(existing.getNote(), "<h2>Revised summary.</h2>");
  });

  it("does not match across a paragraph boundary that is missing from the selection", async function () {
    const before = "<p>alpha</p><p>beta</p>";
    const existing = saveExistingNote(60, 9, before);
    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const input = tool.validate({
      mode: "edit",
      targetNoteId: 60,
      patches: [{ find: "alphabeta", replace: "changed" }],
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    let error: unknown;
    try {
      await tool.execute(input.value, baseContext);
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /patch.*not found/i);
    assert.equal(existing.getNote(), before);
  });

  it("rejects a missing patch match without flattening or changing the note", async function () {
    const before =
      "<h2>Research</h2><p>copper-limitation</p><blockquote>Keep this quote.</blockquote>";
    const existing = saveExistingNote(60, 9, before);
    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const validated = tool.validate({
      mode: "edit",
      targetNoteId: 60,
      patches: [
        { find: "copper-limitation (reviewed)", replace: "copper-limitation" },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    let error: unknown;
    try {
      await tool.execute(validated.value, baseContext);
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /patch.*not found/i);
    assert.equal(existing.getNote(), before);
    assert.isEmpty(existing.saveOptionsHistory);
  });

  it("does not rebase a prepared edit when the native note changes before execution", async function () {
    const existing = saveExistingNote(60, 9, "<p>Original text</p>");
    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const validated = tool.validate({
      mode: "edit",
      targetNoteId: 60,
      patches: [{ find: "Original", replace: "Edited" }],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.planInvocation!(validated.value, baseContext);
    existing.setNote("<p>Concurrent user revision</p>");
    await tool.planInvocation!(validated.value, baseContext);
    let error: unknown;
    try {
      await tool.execute(validated.value, baseContext);
    } catch (caught) {
      error = caught;
    }
    assert.match(String(error), /changed after preparation/);
    assert.equal(existing.getNote(), "<p>Concurrent user revision</p>");
  });

  it("preserves a styled note rewrite when execution skips the review card", async function () {
    const existing = saveExistingNote(
      60,
      9,
      '<p style="color:red">Original text</p>',
    );
    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const html = '<p style="color:blue"><strong>Revised text</strong></p>';
    const validated = tool.validate({
      mode: "edit",
      targetNoteId: 60,
      content: html,
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.execute(validated.value, baseContext);
    assert.equal(existing.getNote(), html);
  });

  it("preserves styled HTML when note creation skips the review card", async function () {
    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const validated = tool.validate({
      mode: "create",
      content:
        '<div style="color: rgb(180, 20, 20)"><strong>Styled note</strong></div>',
      target: "item",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    await tool.execute(validated.value, baseContext);

    assert.lengthOf(childNotes(9), 1);
    assert.include(
      childNotes(9)[0].getNote(),
      'style="color: rgb(180, 20, 20)"',
    );
    assert.include(childNotes(9)[0].getNote(), "<strong>Styled note</strong>");
  });

  it("still renders a Markdown note containing inline HTML emphasis", async function () {
    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const validated = tool.validate({
      mode: "create",
      target: "item",
      targetItemId: 9,
      content: "# Research\n\nA <em>formatted</em> note.",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.execute(validated.value, baseContext);
    const html = childNotes()[0].getNote();
    assert.include(html, "<h1>Research</h1>");
    assert.include(html, "<em>formatted</em>");
    assert.notInclude(html, "# Research");
  });

  it("agent create makes a new item note even when a response-save note is tracked", async function () {
    const trackedNote = saveExistingNote(50, 9, "<p>Tracked response save</p>");
    rememberAssistantNoteForParent(9, 50);

    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const result = (
      await tool.execute(
        {
          mode: "create",
          content: "Agent-created note",
          target: "item",
        },
        baseContext,
      )
    ).content;

    assert.equal((result as any).status, "created");
    assert.equal(trackedNote.getNote(), "<p>Tracked response save</p>");
    assert.equal(getTrackedAssistantNoteForParent(9)?.id, 50);
    assert.lengthOf(childNotes(9), 2);
    assert.include(childNotes(9)[1].getNote(), "Agent-created note");
  });

  it("agent create attaches to the only selected paper when no active item exists", async function () {
    const tool = createEditCurrentNoteTool(new ZoteroGateway());
    const result = (
      await tool.execute(
        {
          mode: "create",
          content: "Selected-paper note",
          target: "item",
        },
        {
          ...baseContext,
          request: resolvedAgentRequest({
            ...baseContext.request,
            activeItemId: undefined,
            libraryID: 1,
            selectedPaperContexts: [
              {
                itemId: 9,
                contextItemId: 9,
                title: "Parent Paper",
              },
            ],
          }),
        },
      )
    ).content;

    assert.equal((result as any).status, "created");
    assert.lengthOf(childNotes(9), 1);
    assert.include(childNotes(9)[0].getNote(), "Selected-paper note");
  });

  it("append mode appends to an explicit note ID", async function () {
    const existing = saveExistingNote(60, 9, "<p>Existing body</p>");
    const tool = createEditCurrentNoteTool(new ZoteroGateway());

    const result = (
      await tool.execute(
        {
          mode: "append",
          targetNoteId: 60,
          content: "Appended body",
        },
        baseContext,
      )
    ).content;

    assert.equal((result as any).status, "appended");
    assert.equal((result as any).noteId, 60);
    assert.include(existing.getNote(), "Existing body");
    assert.include(existing.getNote(), "<hr/>");
    assert.include(existing.getNote(), "Appended body");
  });

  it("journals Zotero's reloaded append HTML so immediate undo does not conflict", async function () {
    const db = new ChangeJournalTestDb();
    (globalScope.Zotero as unknown as { DB: ChangeJournalTestDb }).DB = db;
    await initAgentChangeJournal();
    const existing = saveExistingNote(60, 9, "<p>Existing body</p>");
    existing.wrapOnReload = true;
    const gateway = new ZoteroGateway();
    const tool = createEditCurrentNoteTool(gateway);

    await tool.execute(
      {
        mode: "append",
        targetNoteId: 60,
        content: "Appended body",
      },
      baseContext,
    );
    const persistedHtml = existing.getNote();
    const [action] = await listJournalActions({
      conversationKey: baseContext.request.conversationKey,
      limit: 1,
    });
    const postcondition = JSON.parse(
      action.steps[0].expectedPostconditionJson || "{}",
    ) as { checksum?: string };

    assert.equal(
      postcondition.canonicalChecksum,
      await sha256Text(canonicalNoteHtml(persistedHtml)),
    );
    const reverted = await revertActions({
      actions: [action],
      zoteroGateway: gateway,
      context: baseContext,
    });
    assert.equal(reverted.reverted, 1);
    assert.include(existing.getNote(), "Existing body");
    assert.notInclude(existing.getNote(), "Appended body");
  });

  it("append mode refuses ambiguous child-note targets", async function () {
    saveExistingNote(61, 9, "<p>First note</p>");
    saveExistingNote(62, 9, "<p>Second note</p>");
    const tool = createEditCurrentNoteTool(new ZoteroGateway());

    let error: unknown;
    try {
      await tool.execute(
        {
          mode: "append",
          content: "Ambiguous append",
          targetItemId: 9,
        },
        baseContext,
      );
    } catch (err) {
      error = err;
    }

    assert.instanceOf(error, Error);
    assert.match(String((error as Error).message), /multiple child notes/);
  });

  it("assistant response note saves create fresh item notes", async function () {
    const first = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "First question",
      contentText: "First response",
      modelName: "gpt-5.4",
    });
    const second = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Second question",
      contentText: "Second response",
      modelName: "gpt-5.4",
    });

    assert.equal(first.status, "created");
    assert.equal(second.status, "created");
    assert.lengthOf(childNotes(9), 2);
    assert.isNull(getTrackedAssistantNoteForParent(9));
    assert.include(childNotes(9)[0].getNote(), "First question");
    assert.include(childNotes(9)[0].getNote(), "First response");
    assert.include(childNotes(9)[1].getNote(), "Second question");
    assert.include(childNotes(9)[1].getNote(), "Second response");
  });

  it("response-menu note creation embeds generated images as Zotero note attachments", async function () {
    const result = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Generate a spine figure.",
      contentText: "Generated a figure.",
      modelName: "Codex",
      generatedImages: [
        {
          id: "img-1",
          label: "spine.png",
          path: "/tmp/spine.png",
        },
      ],
    });

    assert.equal(result.status, "created");
    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), "Generate a spine figure.");
    assert.include(note.getNote(), "Generated a figure.");
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), "Generated image embedded");
    assert.notInclude(note.getNote(), "spine.png</p>");
    assert.deepEqual(importedImageParents, [100]);
    assert.deepEqual(importedImagePaths, ["/tmp/spine.png"]);
    assert.lengthOf(note.saveOptionsHistory, 2);
    assert.isOk(note.saveOptionsHistory[0].notifierQueue);
    assert.strictEqual(
      note.saveOptionsHistory[0].notifierQueue,
      note.saveOptionsHistory[1].notifierQueue,
    );
    assert.deepEqual(importedImageNotifierQueues, [
      note.saveOptionsHistory[0].notifierQueue,
    ]);
    assert.deepEqual(committedNotifierQueues, [
      note.saveOptionsHistory[0].notifierQueue,
    ]);
  });

  it("response-menu generated images attach to the newly created item note", async function () {
    await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "First question",
      contentText: "First response",
      modelName: "Codex",
    });

    const result = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Second question",
      contentText: "Second response",
      modelName: "Codex",
      generatedImages: [
        {
          id: "img-2",
          label: "diagram.png",
          path: "/tmp/diagram.png",
        },
      ],
    });

    assert.equal(result.status, "created");
    assert.lengthOf(childNotes(9), 2);
    const note = childNotes(9)[1];
    assert.notInclude(note.getNote(), "First response");
    assert.include(note.getNote(), "Second question");
    assert.include(note.getNote(), "Second response");
    assert.include(note.getNote(), 'data-attachment-key="IMG101_1"');
    assert.deepEqual(importedImageParents, [101]);
  });

  it("response-menu note creation converts SVG fences into PNG note attachments", async function () {
    let rasterizedSvg = "";
    const pngBytes = new Uint8Array([137, 80, 78, 71, 1]);

    const result = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Render this SVG.",
      contentText: [
        "Before.",
        "",
        "```svg",
        '<svg width="10" height="10"/>',
        "```",
        "",
        "After.",
      ].join("\n"),
      modelName: "Codex",
      figureRender: {
        doc: {} as Document,
        rasterizeSvgToPngBytes: async (_doc, svgMarkup) => {
          rasterizedSvg = svgMarkup;
          return pngBytes;
        },
      },
    });

    assert.equal(result.status, "created");
    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), "Before.");
    assert.include(note.getNote(), "After.");
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), '<pre class="lang-svg">');
    assert.notInclude(note.getNote(), "&lt;svg");
    assert.include(rasterizedSvg, '<svg xmlns="http://www.w3.org/2000/svg"');
    assert.deepEqual(importedImageParents, [100]);
    assert.deepEqual(importedImageMimeTypes, ["image/png"]);
    assert.deepEqual(importedImageByteSizes, [pngBytes.length]);
    assert.deepEqual(importedImagePaths, []);
  });

  it("rasterizes tiny SVG figures at readable note-export dimensions", function () {
    assert.deepEqual(
      resolveSvgFigureRasterSize('<svg width="12" height="8"></svg>'),
      { width: 1600, height: 1067 },
    );
    assert.deepEqual(
      resolveSvgFigureRasterSize(
        '<svg width="100%" height="100%" viewBox="0 0 12 8"></svg>',
      ),
      { width: 1600, height: 1067 },
    );
    assert.deepEqual(
      resolveSvgFigureRasterSize('<svg width="800" height="480"></svg>'),
      { width: 1600, height: 960 },
    );
  });

  it("response-menu note creation converts Mermaid fences into PNG note attachments", async function () {
    let renderedMermaidSource = "";
    let rasterizedSvg = "";

    await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Render this diagram.",
      contentText: ["```mermaid", "flowchart TD", "  A --> B", "```"].join(
        "\n",
      ),
      modelName: "Codex",
      figureRender: {
        doc: {} as Document,
        renderMermaidSvg: async (source) => {
          renderedMermaidSource = source;
          return '<svg width="12" height="8"><rect width="12" height="8"/></svg>';
        },
        rasterizeSvgToPngBytes: async (_doc, svgMarkup) => {
          rasterizedSvg = svgMarkup;
          return new Uint8Array([137, 80, 78, 71, 2]);
        },
      },
    });

    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), '<pre class="lang-mermaid">');
    assert.notInclude(note.getNote(), "flowchart TD");
    assert.equal(renderedMermaidSource, "flowchart TD\n  A --> B");
    assert.include(rasterizedSvg, "<svg");
    assert.deepEqual(importedImageParents, [100]);
    assert.deepEqual(importedImageMimeTypes, ["image/png"]);
  });

  it("standalone response notes embed generated images", async function () {
    await createAssistantResponseNote({
      destination: { kind: "standalone", libraryID: 1 },
      queryText: "Generate a standalone figure.",
      contentText: "Standalone generated figure.",
      modelName: "Codex",
      generatedImages: [
        {
          id: "img-standalone",
          label: "standalone.png",
          path: "/tmp/standalone.png",
        },
      ],
    });

    const note = Array.from(savedItems.values()).find(
      (item) => (item as any).isNote?.() && !item.parentID,
    ) as unknown as MockNoteItem | undefined;
    assert.isOk(note);
    assert.include(note!.getNote(), "Generate a standalone figure.");
    assert.include(note!.getNote(), "Standalone generated figure.");
    assert.include(note!.getNote(), 'data-attachment-key="IMG100_1"');
    assert.deepEqual(importedImageParents, [100]);
  });

  it("keeps complete response text and reports a warning when an image cannot be embedded", async function () {
    globalScope.Zotero!.Attachments!.importEmbeddedImage = async () => null;

    const result = await createAssistantResponseNote({
      destination: { kind: "item", item: parentItem },
      queryText: "Generate a figure.",
      contentText: "The complete answer remains available.",
      modelName: "Codex",
      generatedImages: [
        {
          id: "img-missing",
          label: "missing.png",
          path: "/tmp/missing.png",
        },
      ],
    });

    const note = childNotes(9)[0];
    assert.include(note.getNote(), "Generate a figure.");
    assert.include(note.getNote(), "The complete answer remains available.");
    assert.notInclude(note.getNote(), "Preparing note figures");
    assert.deepEqual(result.warnings, [
      "1 generated image(s) could not be embedded",
    ]);
  });

  it("chat-history text export finalizes authoritative creation metadata", async function () {
    await createNoteFromChatHistory(parentItem, [
      {
        role: "user",
        text: "What is the main result?",
        timestamp: 1,
      },
      {
        role: "assistant",
        text: "The complete text-only answer.",
        timestamp: 2,
        modelName: "Codex",
      },
    ]);

    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.lengthOf(note.saveOptionsHistory, 2);
    assert.include(note.getNote(), "What is the main result?");
    assert.include(note.getNote(), "The complete text-only answer.");
    assert.notInclude(note.getNote(), "Preparing chat history export");
  });

  it("chat-history note export embeds assistant generated images and keeps user screenshots", async function () {
    await createNoteFromChatHistory(parentItem, [
      {
        role: "user",
        text: "Please make a diagram.",
        timestamp: 1,
        screenshotImages: ["data:image/png;base64,USERINPUT"],
      },
      {
        role: "assistant",
        text: "",
        timestamp: 2,
        modelName: "Codex",
        generatedImages: [
          {
            id: "img-history",
            label: "history.png",
            src: "file:///tmp/history.png",
          },
        ],
      },
    ]);

    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), "Please make a diagram.");
    assert.include(note.getNote(), 'src="data:image/png;base64,USERINPUT"');
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), "Generated image embedded");
    assert.notInclude(note.getNote(), "history.png</p>");
    assert.deepEqual(importedImageParents, [100]);
    assert.deepEqual(importedImagePaths, ["/tmp/history.png"]);
  });

  it("chat-history note export converts visual fences into PNG note attachments", async function () {
    let renderedMermaidSource = "";

    await createNoteFromChatHistory(
      parentItem,
      [
        {
          role: "user",
          text: "Please show a flowchart.",
          timestamp: 1,
        },
        {
          role: "assistant",
          text: ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n"),
          timestamp: 2,
          modelName: "Codex",
        },
      ],
      {
        figureRender: {
          doc: {} as Document,
          renderMermaidSvg: async (source) => {
            renderedMermaidSource = source;
            return '<svg width="12" height="8"><rect width="12" height="8"/></svg>';
          },
          rasterizeSvgToPngBytes: async () =>
            new Uint8Array([137, 80, 78, 71, 3]),
        },
      },
    );

    assert.lengthOf(childNotes(9), 1);
    const note = childNotes(9)[0];
    assert.include(note.getNote(), "Please show a flowchart.");
    assert.include(note.getNote(), 'data-attachment-key="IMG100_1"');
    assert.notInclude(note.getNote(), '<pre class="lang-mermaid">');
    assert.notInclude(note.getNote(), "flowchart LR");
    assert.equal(renderedMermaidSource, "flowchart LR\n  A --> B");
    assert.deepEqual(importedImageParents, [100]);
  });
});
