import { assert } from "chai";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { buildVisibleTurnContextBlock } from "../src/agent/context/turnContextEnvelope";
import type { PaperContextRef } from "../src/shared/types";

describe("Agent turn Zotero metadata context", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("resolves live metadata once and renders one shared provider block", function () {
    const fields: Record<string, string> = {
      title: "Live Paper Title",
      date: "2026-08-28",
      citationKey: "live-key",
      DOI: "10.1000/live",
      publicationTitle: "Live Journal",
    };
    const item = {
      id: 7,
      libraryID: 1,
      key: "ITEMKEY",
      itemTypeID: 1,
      itemType: "journalArticle",
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      getField: (fieldName: string) => fields[fieldName] || "",
      getDisplayTitle: () => fields.title || "Untitled",
      getCreatorsJSON: () => [
        {
          creatorType: "author",
          firstName: "Live",
          lastName: "Author",
          fieldMode: 0,
        },
      ],
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      Items: { get: (itemId: number) => (itemId === 7 ? item : null) },
    } as unknown as typeof Zotero;
    const stored: PaperContextRef = {
      itemId: 7,
      contextItemId: 7,
      title: "Stored Title",
      firstCreator: "Stored Author",
      year: "1999",
      citationKey: "stored-key",
    };

    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Summarize this paper",
      conversationKind: "paper",
      libraryID: 1,
      activeItemId: 7,
      selectedPaperContexts: [stored],
    });
    const firstRender = buildVisibleTurnContextBlock(request);
    assert.equal(firstRender.split('title="Live Paper Title"').length - 1, 1);
    assert.include(firstRender, 'creators="Live Author"');
    assert.include(firstRender, 'citationKey="live-key"');
    assert.include(firstRender, 'doi="10.1000/live"');
    assert.include(firstRender, 'containerTitle="Live Journal"');
    assert.notInclude(firstRender, "Stored Title");
    assert.notInclude(firstRender, "Stored Author");

    fields.title = "";
    fields.citationKey = "";
    assert.equal(buildVisibleTurnContextBlock(request), firstRender);

    const retriedRequest = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Retry",
      conversationKind: "paper",
      libraryID: 1,
      activeItemId: 7,
      selectedPaperContexts: [stored],
    });
    const retryRender = buildVisibleTurnContextBlock(retriedRequest);
    assert.notInclude(retryRender, "Live Paper Title");
    assert.notInclude(retryRender, "Stored Title");
    assert.notInclude(retryRender, "live-key");
    assert.notInclude(retryRender, "stored-key");
  });

  function stubPaperWithAttachment(contentType: string) {
    const parent = {
      id: 7,
      libraryID: 1,
      key: "ITEMKEY",
      itemType: "journalArticle",
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      getField: (fieldName: string) =>
        fieldName === "title" ? "Paper Title" : "",
      getDisplayTitle: () => "Paper Title",
      getCreatorsJSON: () => [],
    } as unknown as Zotero.Item;
    const attachment = {
      id: 70,
      libraryID: 1,
      key: "ATTKEY01",
      itemType: "attachment",
      parentID: 7,
      attachmentContentType: contentType,
      attachmentFilename: "paper.pdf",
      isRegularItem: () => false,
      isAttachment: () => true,
      isNote: () => false,
      getField: () => "",
      getDisplayTitle: () => "Full Text",
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      Items: {
        get: (itemId: number) =>
          itemId === 7 ? parent : itemId === 70 ? attachment : null,
      },
      Libraries: { userLibraryID: 1, get: () => ({}) },
    } as unknown as typeof Zotero;
    return resolveAgentRuntimeRequest({
      conversationKey: 3,
      mode: "agent",
      userText: "Where is the formula?",
      conversationKind: "paper",
      libraryID: 1,
      activeItemId: 7,
      selectedPaperContexts: [
        { itemId: 7, contextItemId: 70, title: "Paper Title" },
      ],
    });
  }

  it("gives a PDF paper a link the model can extend to a page", function () {
    const rendered = buildVisibleTurnContextBlock(
      stubPaperWithAttachment("application/pdf"),
    );
    assert.include(
      rendered,
      'pdfLink="zotero://open-pdf/library/items/ATTKEY01"',
    );
    assert.include(rendered, "?page=N");
    assert.include(rendered, "0-based");
    // Every page mention becomes a link.
    assert.include(rendered, "Whenever the answer mentions a PDF page");
  });

  it("gives no PDF link to a paper whose content is not a PDF", function () {
    const rendered = buildVisibleTurnContextBlock(
      stubPaperWithAttachment("text/html"),
    );
    assert.notInclude(rendered, "pdfLink");
    assert.notInclude(rendered, "?page=N");
  });

  it("does not acquire ambient paper metadata for a collection scope", function () {
    let itemReads = 0;
    globalThis.Zotero = {
      Items: {
        get: () => {
          itemReads += 1;
          return null;
        },
      },
    } as unknown as typeof Zotero;

    const request = resolveAgentRuntimeRequest({
      conversationKey: 2,
      mode: "agent",
      userText: "Summarize this collection",
      conversationKind: "global",
      libraryID: 1,
      activeItemId: 7,
      selectedCollectionContexts: [
        { collectionId: 9, libraryID: 1, name: "Reading List" },
      ],
    });
    const rendered = buildVisibleTurnContextBlock(request);
    assert.equal(itemReads, 0);
    assert.include(rendered, 'name="Reading List"');
    assert.notInclude(rendered, "Paper 1:");
  });
});
