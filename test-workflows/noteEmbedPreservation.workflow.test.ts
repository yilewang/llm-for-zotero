import "./hostSurfaceBootstrap";
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestNoteFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { innermostToolResult } from "../src/agent/contracts/toolResultEnvelope";
import {
  clearPlanDocumentConversationRowsInTransaction,
  savePlanDocumentInTransaction,
} from "../src/agent/documents/store";
import { savePlanDocumentAsNote } from "../src/agent/documents/actions";
import type { PlanDocument } from "../src/agent/documents/types";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";
import { noteHtmlToModelText } from "../src/services/notes/noteRendering";

/**
 * Zotero note embeds through AI note edits, against the real note store.
 *
 * A note holds a citation chip and a PDF highlight exactly as Zotero's own
 * editor writes them (`Zotero.EditorInstance.createNoteFromAnnotations`), a
 * picture backed by a real embedded-image attachment, and a second copy of
 * the citation. Every route the model can edit through — a full rewrite,
 * precise patches, a selection, an append, a finalized document, a batch —
 * must put each item back byte for byte. Every check reloads the note from
 * Zotero; tool results are never the evidence.
 */

declare const IOUtils: any;
declare const PathUtils: any;

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBc8AAAAASUVORK5CYII=";
const TOKEN = (kind: string) =>
  new RegExp(`\\{\\{${kind}:([0-9a-f]{6,8})(?:[ \\t][^\\n]*?)?\\}\\}`);

function occurrences(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0;
}

function rootOpeningTag(html: string): string {
  const match = html.match(/^<div\b[^>]*\bdata-schema-version="[^"]*"[^>]*>/);
  assert.isOk(match, `the note keeps Zotero's root container:\n${html}`);
  return match![0];
}

function registeredItems(html: string): Array<{ uris: string[] }> {
  const attr = rootOpeningTag(html).match(/\bdata-citation-items="([^"]*)"/);
  assert.isOk(attr, "the root carries a citation registry");
  return JSON.parse(decodeURIComponent(attr![1]));
}

/** Every citation chip's cited URIs and pages, in document order. */
function chipCitations(
  html: string,
): Array<{ html: string; uris: string[]; locator?: string }> {
  return Array.from(
    html.matchAll(
      /<span class="citation" data-citation="([^"]*)">[\s\S]*?<\/span>\)<\/span>/g,
    ),
    (match) => {
      const data = JSON.parse(decodeURIComponent(match[1]));
      return {
        html: match[0],
        uris: data.citationItems.flatMap(
          (item: { uris: string[] }) => item.uris,
        ),
        locator: data.citationItems[0]?.locator,
      };
    },
  );
}

async function nativeHtml(note: Zotero.Item): Promise<string> {
  await note.reload(["note"], true);
  return note.getNote();
}

async function waitFor<T>(
  read: () => T | null | undefined | false,
  label: string,
  timeout = 15000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await Zotero.Promise.delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("workflow: note embeds survive AI note edits", function () {
  this.timeout(120000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestNoteFixture;
  let parent: Zotero.Item;
  let annotation: Zotero.Item;
  /** Zotero's own serialization of the highlight, its citation, and root. */
  let zotero: { root: string; highlight: string; citation: string };
  const erase: Zotero.Item[] = [];
  const conversationKeys: number[] = [];
  let runSequence = 0;

  async function regularItem(
    title: string,
    lastName: string,
    year: string,
  ): Promise<Zotero.Item> {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", title);
    item.setField("date", year);
    item.setCreators([
      { firstName: "Test", lastName, creatorType: "author" } as any,
    ]);
    await item.saveTx();
    erase.push(item);
    return item;
  }

  /** A note under the parent paper holding all four embedded items. */
  async function createEmbedNote() {
    const note = new Zotero.Item("note");
    note.libraryID = parent.libraryID;
    note.parentID = parent.id;
    note.setNote("<p>Embed fixture</p>");
    await note.saveTx();
    erase.push(note);
    const win = Zotero.getMainWindow() as any;
    const pixels = Uint8Array.from(win.atob(PIXEL_PNG), (c: string) =>
      c.charCodeAt(0),
    );
    const image = await (Zotero.Attachments as any).importEmbeddedImage({
      blob: new win.Blob([pixels], { type: "image/png" }),
      parentItemID: note.id,
    });
    const imageHtml = `<img alt="Figure one" data-attachment-key="${image.key}" width="1" height="1">`;
    note.setNote(
      `${zotero.root}<h1>Embed preservation note</h1>\n` +
        `<p>Intro paragraph alpha.</p>\n` +
        `<p>${zotero.highlight} ${zotero.citation} anchors the first claim.</p>\n` +
        `<p>Image paragraph follows. ${imageHtml}</p>\n` +
        `<p>A repeated citation ${zotero.citation} closes the argument.</p>\n` +
        `<p>Closing paragraph omega.</p>\n</div>`,
    );
    await note.saveTx();
    const html = await nativeHtml(note);
    // Saving is not an editor round trip: Zotero stores what it was given.
    assert.equal(occurrences(html, zotero.highlight), 1);
    assert.equal(occurrences(html, zotero.citation), 2);
    assert.equal(occurrences(html, imageHtml), 1);
    assert.isTrue(html.startsWith(zotero.root));
    return { note, image, imageHtml, html };
  }

  function noteWriteTool() {
    return (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
      "note_write",
    );
  }

  function toolContext(
    note: Zotero.Item,
    request: Record<string, unknown> = {},
  ) {
    return {
      runId: `note-embeds:${note.key}:${++runSequence}`,
      request: {
        conversationKey: note.id,
        mode: "agent" as const,
        libraryID: note.libraryID,
        userText: "Edit this note",
        activeItemId: note.id,
        ...request,
      },
      item: note,
      modelName: "workflow",
      currentAnswerText: "",
    };
  }

  /** Validate, prepare, preview, and execute one note_write call. */
  async function noteWrite(
    note: Zotero.Item,
    args: Record<string, unknown>,
    request: Record<string, unknown> = {},
  ) {
    const tool = noteWriteTool();
    const validated = tool.validate(args);
    assert.isTrue(validated.ok, JSON.stringify(validated));
    const context = toolContext(note, request);
    await tool.planInvocation(validated.value, context);
    const review = await tool.createPendingAction(validated.value, context);
    const output = await tool.execute(validated.value, context);
    return {
      review,
      result: innermostToolResult(output.content ?? output) as Record<
        string,
        any
      >,
    };
  }

  /** The note as the model reads it, from the native note. */
  async function modelText(note: Zotero.Item): Promise<string> {
    return noteHtmlToModelText(await nativeHtml(note));
  }

  function assertAllItemsKept(
    html: string,
    imageHtml: string,
    citationCopies = 2,
  ) {
    assert.equal(occurrences(html, zotero.highlight), 1, "highlight kept");
    assert.equal(
      occurrences(html, zotero.citation),
      citationCopies,
      "citation copies kept byte-equal",
    );
    assert.equal(occurrences(html, imageHtml), 1, "image kept byte-equal");
    assert.equal(rootOpeningTag(html), zotero.root, "root registry kept");
    assert.equal(occurrences(html, "data-schema-version"), 1, "one root");
  }

  before(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    await initAgentChangeJournal();
    fixture = await api.createItemNoteFixture({
      title: "Embed preservation paper",
      pdfTitle: "Embed preservation PDF",
      noteHtml: "<p>Unused fixture note.</p>",
    });
    parent = Zotero.Items.get(fixture.parentItemId) as Zotero.Item;
    parent.setField("date", "2020");
    parent.setCreators([
      { firstName: "Ada", lastName: "Okafor", creatorType: "author" } as any,
    ]);
    await parent.saveTx();
    annotation = new Zotero.Item("annotation");
    annotation.libraryID = parent.libraryID;
    annotation.parentID = fixture.pdfAttachmentId;
    (annotation as any).annotationType = "highlight";
    (annotation as any).annotationText = "Representations drift over weeks";
    (annotation as any).annotationColor = "#ffd400";
    (annotation as any).annotationPageLabel = "42";
    (annotation as any).annotationSortIndex = "00000|000000|00080";
    (annotation as any).annotationPosition = JSON.stringify({
      pageIndex: 0,
      rects: [[72, 698, 230, 712]],
    });
    await annotation.saveTx();
    // Zotero's own serializer: what dragging the highlight into a note writes.
    const draft = await (
      Zotero as any
    ).EditorInstance.createNoteFromAnnotations([annotation], {
      noSave: true,
      noHeader: true,
    });
    const built: string = draft.getNote();
    const root = built.match(
      /^<div data-citation-items="[^"]*" data-schema-version="\d+">/,
    )?.[0];
    const highlight = built.match(
      /<span class="highlight" data-annotation="[^"]*">[^<]*<\/span>/,
    )?.[0];
    const citation = built.match(
      /<span class="citation" data-citation="[^"]*">\(<span class="citation-item">[^<]*<\/span>\)<\/span>/,
    )?.[0];
    assert.isOk(root && highlight && citation, built);
    zotero = { root: root!, highlight: highlight!, citation: citation! };
    assert.include(zotero.citation, "Okafor, 2020, p. 42");
    assert.deepEqual(
      registeredItems(built).map((entry) => entry.uris),
      [[Zotero.URI.getItemURI(parent)]],
    );
  });

  after(async function () {
    await api.reset();
    for (const item of erase.reverse())
      if (Zotero.Items.get(item.id))
        await item.eraseTx().catch(() => undefined);
    if (annotation && Zotero.Items.get(annotation.id))
      await annotation.eraseTx().catch(() => undefined);
    for (const key of conversationKeys)
      await Zotero.DB.executeTransaction(() =>
        clearPlanDocumentConversationRowsInTransaction(key),
      );
    if (fixture) await api.cleanupFixture(fixture);
  });

  it("a full rewrite that moves an item and changes text keeps every item byte-equal", async function () {
    const { note, imageHtml } = await createEmbedNote();
    const text = await modelText(note);
    const imageToken = text.match(TOKEN("image"))![0];
    const content = text
      .replace("Intro paragraph alpha.", "Intro paragraph rewritten by AI.")
      .replace(` ${imageToken}`, "")
      .replace(
        "Closing paragraph omega.",
        `Closing paragraph omega. ${imageToken}`,
      );
    assert.notEqual(content, text);
    const { result, review } = await noteWrite(note, {
      mode: "edit",
      targetNoteId: note.id,
      content,
    });
    const html = await nativeHtml(note);
    assertAllItemsKept(html, imageHtml);
    assert.include(html, "Intro paragraph rewritten by AI.");
    assert.notInclude(html, "Intro paragraph alpha.");
    assert.isAbove(
      html.indexOf(imageHtml),
      html.indexOf("Closing paragraph omega."),
      "the image moved to the closing paragraph",
    );
    assert.equal(result.noteChange.state, "applied");
    // Nothing was deleted, so neither the preview nor the result says so.
    assert.notMatch(result.noteChange.description, /delet/i);
    assert.notMatch(review.description, /delet/i);
  });

  it("a patch and an append with a new citation keep every item and register the new work in the one root", async function () {
    const { note, imageHtml } = await createEmbedNote();
    const cited = await regularItem("Second cited paper", "Lindqvist", "2019");
    const patched = await noteWrite(note, {
      mode: "edit",
      targetNoteId: note.id,
      patches: [
        {
          find: "Closing paragraph omega.",
          replace: "Closing paragraph patched.",
        },
      ],
    });
    let html = await nativeHtml(note);
    assertAllItemsKept(html, imageHtml);
    assert.include(html, "Closing paragraph patched.");
    assert.notMatch(patched.result.noteChange.description, /delet/i);

    const before = html;
    const appended = await noteWrite(note, {
      mode: "append",
      targetNoteId: note.id,
      content: `Appended claim {{cite item=${cited.id} page=3}}.`,
    });
    html = await nativeHtml(note);
    assert.equal(occurrences(html, zotero.highlight), 1);
    assert.equal(occurrences(html, zotero.citation), 2);
    assert.equal(occurrences(html, imageHtml), 1);
    assert.notInclude(html, "{{cite");
    assert.equal(occurrences(html, "data-schema-version"), 1, "one root");
    assert.isTrue(html.trimEnd().endsWith("</div>"));
    const chips = chipCitations(html);
    const added = chips.filter((chip) => chip.html !== zotero.citation);
    assert.lengthOf(added, 1, html);
    assert.lengthOf(added[0].uris, 1);
    assert.equal(added[0].locator, "3");
    const resolved = await (Zotero.URI as any).getURIItem(added[0].uris[0]);
    assert.equal(resolved?.id, cited.id, "the new chip resolves to the item");
    assert.isAbove(html.indexOf(added[0].html), html.indexOf("Appended claim"));
    // The existing root gains the work; its earlier entry is untouched.
    const registry = registeredItems(html);
    assert.deepEqual(registry[0], registeredItems(before)[0]);
    assert.deepEqual(
      registry.map((entry) => entry.uris),
      [[Zotero.URI.getItemURI(parent)], [Zotero.URI.getItemURI(cited)]],
    );
    assert.notMatch(appended.result.noteChange.description, /delet/i);
  });

  it("refuses a full rewrite that drops an item without removeEmbeds and leaves the note unchanged", async function () {
    const { note } = await createEmbedNote();
    const before = await nativeHtml(note);
    const text = await modelText(note);
    const highlightToken = text.match(TOKEN("highlight"))![0];
    const tool = noteWriteTool();
    const validated = tool.validate({
      mode: "edit",
      targetNoteId: note.id,
      content: text.replace(highlightToken, ""),
    });
    assert.isTrue(validated.ok);
    let failure: unknown;
    try {
      await tool.execute(validated.value, toolContext(note));
    } catch (error) {
      failure = error;
    }
    assert.match(String(failure), /would delete 1 embedded item/);
    assert.equal(await nativeHtml(note), before, "the note is unchanged");
  });

  it("removeEmbeds with one kept placeholder deletes exactly one copy of a duplicated citation", async function () {
    const { note, imageHtml } = await createEmbedNote();
    const text = await modelText(note);
    const match = text.match(TOKEN("citation"))!;
    const id = match[1];
    const last = text.lastIndexOf(match[0]);
    assert.notEqual(last, text.indexOf(match[0]), "two placeholders");
    const content =
      text.slice(0, last).trimEnd() + text.slice(last + match[0].length);
    const { result, review } = await noteWrite(note, {
      mode: "edit",
      targetNoteId: note.id,
      content,
      removeEmbeds: [id],
    });
    const html = await nativeHtml(note);
    assertAllItemsKept(html, imageHtml, 1);
    assert.isBelow(
      html.indexOf(zotero.citation),
      html.indexOf("anchors the first claim"),
      "the kept copy is the first one",
    );
    assert.include(result.noteChange.description, "deleted 1 embedded item");
    assert.include(review.description, "deletes 1 embedded item");
  });

  for (const route of ["patch", "selection"] as const)
    it(`${route}: removeEmbeds with the placeholder omitted deletes only the listed chip in the edited range`, async function () {
      const { note, imageHtml } = await createEmbedNote();
      const before = await nativeHtml(note);
      const text = await modelText(note);
      const token = text.match(TOKEN("citation"))!;
      const id = token[1];
      const range = `${token[0]} anchors the first claim.`;
      const replacement = "Anchors the first claim.";
      assert.equal(occurrences(text, range), 1, text);
      const { result } =
        route === "patch"
          ? await noteWrite(note, {
              mode: "edit",
              targetNoteId: note.id,
              patches: [{ find: range, replace: replacement }],
              removeEmbeds: [id],
            })
          : await noteWrite(
              note,
              {
                mode: "edit",
                targetNoteId: note.id,
                selection: { index: 1, replacement },
                removeEmbeds: [id],
              },
              {
                // A selection holds the note's visible text: the chip label.
                selectedTexts: [
                  "(Okafor, 2020, p. 42) anchors the first claim.",
                ],
                selectedTextSources: ["note-edit"],
                selectedTextNoteContexts: [
                  {
                    noteItemId: note.id,
                    noteKind: "item",
                    parentItemId: parent.id,
                  },
                ],
                activeNoteContext: {
                  noteId: note.id,
                  title: note.getNoteTitle(),
                  noteKind: "item",
                  parentItemId: parent.id,
                  noteText: before,
                  noteHtml: before,
                },
              },
            );
      const html = await nativeHtml(note);
      // The copy in the edited paragraph is gone; the other copy stays.
      assertAllItemsKept(html, imageHtml, 1);
      assert.include(html, replacement);
      assert.isAbove(
        html.indexOf(zotero.citation),
        html.indexOf("A repeated citation"),
        "the surviving copy is the one outside the edited range",
      );
      assert.equal(
        rootOpeningTag(html),
        rootOpeningTag(before),
        "root registry unchanged",
      );
      assert.include(result.noteChange.description, "deleted 1 embedded item");
    });

  it("patch: removeEmbeds with the placeholder kept leaves the chip in place and reports no deletion", async function () {
    const { note, imageHtml } = await createEmbedNote();
    const text = await modelText(note);
    const token = text.match(TOKEN("citation"))!;
    const { result, review } = await noteWrite(note, {
      mode: "edit",
      targetNoteId: note.id,
      patches: [
        {
          find: `${token[0]} anchors the first claim.`,
          replace: `${token[0]} anchors the first claim, as patched.`,
        },
      ],
      removeEmbeds: [token[1]],
    });
    const html = await nativeHtml(note);
    assertAllItemsKept(html, imageHtml);
    assert.include(html, "anchors the first claim, as patched.");
    assert.notMatch(result.noteChange.description, /delet/i);
    assert.notMatch(review.description, /delet/i);
  });

  for (const route of ["patch", "selection"] as const)
    it(`${route}: a retyped label shared by two works still cites the work of the rewritten paragraph`, async function () {
      const first = await regularItem(
        "First shared-label work",
        "Berg",
        "2018",
      );
      const second = await regularItem(
        "Second shared-label work",
        "Berg",
        "2018",
      );
      const chip = (item: Zotero.Item) => {
        const citation = {
          citationItems: [
            { uris: [Zotero.URI.getItemURI(item)], locator: "5" },
          ],
          properties: {},
        };
        const withData = JSON.parse(JSON.stringify(citation));
        withData.citationItems[0].itemData = (
          Zotero.Utilities as any
        ).Item.itemToCSLJSON(item);
        return `<span class="citation" data-citation="${encodeURIComponent(
          JSON.stringify(citation),
        )}">${(Zotero as any).EditorInstanceUtilities.formatCitation(withData)}</span>`;
      };
      const firstChip = chip(first);
      const secondChip = chip(second);
      const label = "(Berg, 2018, p. 5)";
      assert.include(firstChip, "Berg, 2018, p. 5");
      assert.include(secondChip, "Berg, 2018, p. 5");
      const root = `<div data-citation-items="${encodeURIComponent(
        JSON.stringify(
          [first, second].map((item) => ({
            uris: [Zotero.URI.getItemURI(item)],
            itemData: (Zotero.Utilities as any).Item.itemToCSLJSON(item),
          })),
        ),
      )}" data-schema-version="9">`;
      const note = new Zotero.Item("note");
      note.libraryID = parent.libraryID;
      note.parentID = parent.id;
      note.setNote(
        `${root}<h1>Shared label note</h1>\n<p>First lab reported drift ${firstChip}.</p>\n<p>Second lab reported stability ${secondChip}.</p>\n</div>`,
      );
      await note.saveTx();
      erase.push(note);
      const before = await nativeHtml(note);
      const paragraph = `Second lab reported stability ${label}.`;
      const rewrite = `Second lab reported long-term stability ${label}.`;
      const { result } =
        route === "patch"
          ? await noteWrite(note, {
              mode: "edit",
              targetNoteId: note.id,
              patches: [{ find: paragraph, replace: rewrite }],
            })
          : await noteWrite(
              note,
              {
                mode: "edit",
                targetNoteId: note.id,
                selection: { index: 1, replacement: rewrite },
              },
              {
                selectedTexts: [paragraph],
                selectedTextSources: ["note-edit"],
                selectedTextNoteContexts: [
                  {
                    noteItemId: note.id,
                    noteKind: "item",
                    parentItemId: parent.id,
                  },
                ],
                activeNoteContext: {
                  noteId: note.id,
                  title: note.getNoteTitle(),
                  noteKind: "item",
                  parentItemId: parent.id,
                  noteText: before,
                  noteHtml: before,
                },
              },
            );
      const html = await nativeHtml(note);
      assert.equal(occurrences(html, firstChip), 1, html);
      assert.equal(occurrences(html, secondChip), 1, html);
      assert.notInclude(html, `stability ${label}`, "no plain-text label");
      const rewritten = html.indexOf("Second lab reported long-term stability");
      assert.isAbove(rewritten, -1, html);
      assert.isBelow(html.indexOf(firstChip), html.indexOf("Second lab"));
      assert.isAbove(html.indexOf(secondChip), rewritten);
      assert.equal(rootOpeningTag(html), root);
      assert.notMatch(result.noteChange.description, /delet/i);
    });

  it("a finalized document with a citation request saves a chip, and re-saves after an editor round trip, a retitled work, and the editor's refresh of it", async function () {
    const now = Date.now();
    const documentId = `note-embeds-document:${parent.key}:${now}`;
    const visibleHtml = `<h1>Document embed save</h1><p>The drift claim holds {{cite item=${parent.id} page=4}}.</p>`;
    const document: PlanDocument = {
      version: 2,
      documentId,
      documentVersion: 1,
      conversationKey: parent.id,
      title: "Document embed save",
      documentKind: "custom",
      integrityPolicy: "authored",
      origin: {
        kind: "direct",
        runId: `note-embeds-document:${now}`,
        sourceMessageTimestamp: now,
      },
      visibleMarkdown: `# Document embed save\n\nThe drift claim holds {{cite item=${parent.id} page=4}}.`,
      visibleHtml,
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
      contentHash: await sha256Text(documentId),
      createdAt: now,
    };
    conversationKeys.push(parent.id);
    await Zotero.DB.executeTransaction(() =>
      savePlanDocumentInTransaction({
        document,
        outbox: {
          version: 1,
          outboxId: `outbox:${documentId}`,
          documentId,
          conversationKey: parent.id,
          messageTimestamp: now,
          visibleMarkdown: document.visibleMarkdown,
          status: "delivered",
          attemptCount: 1,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const target = { parentItemId: parent.id, libraryID: parent.libraryID };
    const saved = await savePlanDocumentAsNote(documentId, target);
    assert.isTrue(saved.created);
    const note = Zotero.Items.get(saved.itemId) as Zotero.Item;
    erase.push(note);
    const stored = await nativeHtml(note);
    assert.notInclude(stored, "{{cite");
    const chips = chipCitations(stored);
    assert.lengthOf(chips, 1, stored);
    assert.equal(chips[0].locator, "4");
    assert.deepEqual(chips[0].uris, [Zotero.URI.getItemURI(parent)]);
    assert.deepEqual(
      registeredItems(stored).map((entry) => entry.uris),
      [[Zotero.URI.getItemURI(parent)]],
    );

    /** Open the saved note in Zotero's note editor, let it load, close it. */
    async function editorRoundTrip(settled: () => Promise<boolean>) {
      const win = Zotero.getMainWindow() as any;
      const editor = await (Zotero.Notes as any).open(note.id);
      assert.isOk(editor, "the note editor opened");
      await editor._initPromise;
      // The editor rendered this note, citation chip included.
      await waitFor(() => {
        const body = editor._iframeWindow?.document?.body;
        return (
          body?.textContent?.includes("The drift claim holds") &&
          body.querySelector(".citation")
        );
      }, "the note editor to render the note");
      const deadline = Date.now() + 15000;
      while (!(await settled()) && Date.now() < deadline)
        await Zotero.Promise.delay(100);
      await Zotero.Promise.delay(2000);
      win.Zotero_Tabs.close(editor.tabID);
      await waitFor(
        () => !(Zotero.Notes as any)._editorInstances.includes(editor),
        "the note editor to close",
      );
      await Zotero.Promise.delay(500);
      return nativeHtml(note);
    }

    // (a) An editor round trip of the note as saved.
    const afterEditor = await editorRoundTrip(async () => true);
    let resaved: Awaited<ReturnType<typeof savePlanDocumentAsNote>> | undefined;
    let failure: unknown;
    try {
      resaved = await savePlanDocumentAsNote(documentId, target);
    } catch (error) {
      failure = error;
    }
    assert.isUndefined(
      failure,
      `re-save after the editor round trip threw: ${String(failure)}\nbefore:\n${stored}\nafter:\n${afterEditor}`,
    );
    assert.isFalse(resaved!.created);
    assert.equal(resaved!.itemId, note.id);

    // (b) The cited work's title changes; the saved note is still this one.
    parent.setField("title", "Embed preservation paper, retitled");
    await parent.saveTx();
    const retitled = await savePlanDocumentAsNote(documentId, target);
    assert.isFalse(retitled.created);
    assert.equal(retitled.itemId, note.id);

    // (c) The editor opens the note of the retitled work: Zotero refreshes
    // that work's CSL data in the root registry and saves. The chip and the
    // registered work are unchanged, so the re-save returns the same note.
    const beforeRefresh = await nativeHtml(note);
    const registeredTitle = async () =>
      registeredItems(await nativeHtml(note))[0] as {
        itemData?: { title?: string };
      };
    const refreshed = await editorRoundTrip(
      async () =>
        (await registeredTitle()).itemData?.title ===
        "Embed preservation paper, retitled",
    );
    assert.equal(
      (await registeredTitle()).itemData?.title,
      "Embed preservation paper, retitled",
      `the editor refreshed the root registry:\n${refreshed}`,
    );
    assert.notEqual(refreshed, beforeRefresh, "the editor saved the note");
    assert.deepEqual(
      chipCitations(refreshed).map((chip) => chip.html),
      chipCitations(beforeRefresh).map((chip) => chip.html),
      "the chip is byte-identical",
    );
    assert.deepEqual(
      registeredItems(refreshed).map((entry) => entry.uris),
      [[Zotero.URI.getItemURI(parent)]],
    );
    let refreshedSave:
      | Awaited<ReturnType<typeof savePlanDocumentAsNote>>
      | undefined;
    try {
      refreshedSave = await savePlanDocumentAsNote(documentId, target);
    } catch (error) {
      failure = error;
    }
    assert.isUndefined(
      failure,
      `re-save after the editor refreshed the retitled work threw: ${String(failure)}\nbefore:\n${beforeRefresh}\nafter:\n${refreshed}`,
    );
    assert.isFalse(refreshedSave!.created);
    assert.equal(refreshedSave!.itemId, note.id);
    assert.equal(
      await nativeHtml(note),
      refreshed,
      "the re-save wrote nothing",
    );

    // A note whose visible text really changed is still refused.
    note.setNote(
      refreshed.replace("The drift claim holds", "The drift claim fails"),
    );
    await note.saveTx();
    let refused: unknown;
    try {
      await savePlanDocumentAsNote(documentId, target);
    } catch (error) {
      refused = error;
    }
    assert.match(String(refused), /no longer matches this exact document/);
    await parent.reload(["childItems"], true);
    assert.lengthOf(
      parent
        .getNotes()
        .filter((id) =>
          (Zotero.Items.get(id) as Zotero.Item)
            .getNote()
            .includes("Document embed save"),
        ),
      1,
      "exactly one document note",
    );
  });

  it("a batch note with a citation request is written with a chip", async function () {
    const paper = await regularItem("Batch target paper", "Moreau", "2021");
    await paper.reload(["childItems"], true);
    const notesBefore = paper.getNotes();
    const tool = (Zotero as any).LLMForZotero.api.agent.getToolDefinition(
      "note_write_batch",
    );
    const validated = tool.validate({
      notes: [
        {
          targetItemId: paper.id,
          content: `Batch summary cites {{cite item=${paper.id} page=2}}.`,
        },
      ],
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    conversationKeys.push(paper.id);
    const context = {
      runId: `note-embeds-batch:${paper.key}`,
      request: {
        conversationKey: paper.id,
        mode: "agent" as const,
        libraryID: paper.libraryID,
        userText: "Write a summary note on this paper",
        metadata: { sourceMessageTimestamp: Date.now() },
      },
      item: null,
      modelName: "workflow",
      currentAnswerText: "",
    };
    await tool.planInvocation(validated.value, context);
    await tool.execute(validated.value, context);
    await paper.reload(["childItems"], true);
    const created = paper
      .getNotes()
      .filter((id) => !notesBefore.includes(id))
      .map((id) => Zotero.Items.get(id) as Zotero.Item);
    erase.push(...created);
    assert.lengthOf(created, 1);
    const html = await nativeHtml(created[0]);
    assert.notInclude(html, "{{cite");
    const chips = chipCitations(html);
    assert.lengthOf(chips, 1, html);
    assert.equal(chips[0].locator, "2");
    assert.deepEqual(chips[0].uris, [Zotero.URI.getItemURI(paper)]);
    assert.deepEqual(
      registeredItems(html).map((entry) => entry.uris),
      [[Zotero.URI.getItemURI(paper)]],
    );
  });
});
