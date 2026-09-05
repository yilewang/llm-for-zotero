import { assert } from "chai";
import { createZoteroMetadataResolver } from "../src/services/zoteroMetadata/resolver";
import {
  projectLibraryReadMetadata,
  projectPaperMetadata,
} from "../src/services/zoteroMetadata/projections";
import type { PaperContextRef } from "../src/shared/types";

type FakeItemOptions = {
  id: number;
  itemTypeID: number;
  itemType: string;
  libraryID?: number;
  key?: string;
  parentID?: number;
  fields?: Record<string, string>;
  creators?: Array<Record<string, unknown>>;
  attachment?: { filename: string; contentType: string };
  note?: boolean;
  version?: number;
};

function fakeItem(options: FakeItemOptions): Zotero.Item {
  const fields = options.fields || {};
  return {
    id: options.id,
    itemTypeID: options.itemTypeID,
    itemType: options.itemType,
    libraryID: options.libraryID || 1,
    key: options.key || `KEY${options.id}`,
    parentID: options.parentID,
    version: options.version,
    attachmentFilename: options.attachment?.filename,
    attachmentContentType: options.attachment?.contentType,
    isRegularItem: () => !options.attachment && !options.note,
    isAttachment: () => Boolean(options.attachment),
    isNote: () => Boolean(options.note),
    getField: (fieldName: string) => fields[fieldName] || "",
    getDisplayTitle: () => fields.title || `Item ${options.id}`,
    getCreatorsJSON: () => options.creators || [],
    getNoteTitle: () => fields.title || `Note ${options.id}`,
    getFilename: () => options.attachment?.filename || "",
    toJSON: () => ({
      itemType: options.itemType,
      ...fields,
      creators: options.creators || [],
    }),
  } as unknown as Zotero.Item;
}

describe("unified Zotero metadata resolver", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  function installZotero(items: Zotero.Item[]) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const fieldNames = new Map<number, string>([
      [1, "title"],
      [2, "abstractNote"],
      [3, "date"],
      [4, "citationKey"],
      [5, "DOI"],
      [6, "publicationTitle"],
      [7, "journalAbbreviation"],
      [8, "publisher"],
      [9, "proceedingsTitle"],
      [10, "conferenceName"],
      [11, "bookTitle"],
    ]);
    const fieldIds = new Map(
      Array.from(fieldNames.entries()).map(([id, name]) => [name, id]),
    );
    globalThis.Zotero = {
      Items: { get: (itemId: number) => byId.get(itemId) || null },
      ItemTypes: {
        getName: (itemTypeId: number) =>
          itemTypeId === 1
            ? "journalArticle"
            : itemTypeId === 2
              ? "conferencePaper"
              : itemTypeId === 3
                ? "bookSection"
                : itemTypeId === 14
                  ? "attachment"
                  : "note",
      },
      ItemFields: {
        getID: (name: string) => fieldIds.get(name) || false,
        getName: (id: number) => fieldNames.get(id) || "",
        getFieldIDFromTypeAndBase: (
          itemTypeId: number,
          baseFieldId: number,
        ) => {
          if (baseFieldId === 6 && itemTypeId === 2) return 9;
          if (baseFieldId === 6 && itemTypeId === 3) return 11;
          return baseFieldId;
        },
        getItemTypeFields: (itemTypeId: number) => {
          if (itemTypeId === 2) return [1, 2, 3, 4, 5, 8, 9, 10];
          if (itemTypeId === 3) return [1, 2, 3, 4, 5, 8, 11];
          return [1, 2, 3, 4, 5, 6, 7, 8];
        },
      },
    } as unknown as typeof Zotero;
  }

  function paperRef(itemId: number, contextItemId = itemId): PaperContextRef {
    return {
      itemId,
      contextItemId,
      title: "Stored stale title",
      firstCreator: "Stored Author",
      year: "1999",
      citationKey: "stored-key",
    };
  }

  it("preserves concrete container and event field provenance", function () {
    const conference = fakeItem({
      id: 20,
      itemTypeID: 2,
      itemType: "conferencePaper",
      fields: {
        title: "Conference Work",
        date: "2025-04-02",
        proceedingsTitle: "Proceedings of the Example Society",
        conferenceName: "ExampleConf 2025",
        publisher: "Example Publisher",
        DOI: "10.1000/example",
      },
      creators: [
        {
          creatorType: "author",
          firstName: "Ada",
          lastName: "Example",
          fieldMode: 0,
        },
      ],
    });
    installZotero([conference]);

    const resolution = createZoteroMetadataResolver().resolvePaperMetadata(
      paperRef(20),
    );
    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    const bibliography = resolution.value.bibliographicItem?.bibliography;
    assert.deepEqual(bibliography?.containerTitle, {
      value: "Proceedings of the Example Society",
      sourceField: "proceedingsTitle",
    });
    assert.deepEqual(bibliography?.eventTitle, {
      value: "ExampleConf 2025",
      sourceField: "conferenceName",
    });
    assert.notEqual(
      bibliography?.containerTitle?.value,
      conference.getField("publisher"),
    );
  });

  it("maps bookTitle as a container without flattening its source", function () {
    const section = fakeItem({
      id: 30,
      itemTypeID: 3,
      itemType: "bookSection",
      fields: { title: "A Chapter", bookTitle: "A Collected Volume" },
    });
    installZotero([section]);

    const resolution = createZoteroMetadataResolver().resolvePaperMetadata(
      paperRef(30),
    );
    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.deepEqual(
      resolution.value.bibliographicItem?.bibliography.containerTitle,
      { value: "A Collected Volume", sourceField: "bookTitle" },
    );
  });

  it("preserves personal and corporate creator shapes", function () {
    const article = fakeItem({
      id: 35,
      itemTypeID: 1,
      itemType: "journalArticle",
      fields: { title: "Mixed Creators" },
      creators: [
        {
          creatorType: "author",
          firstName: "Ada",
          lastName: "Example",
          fieldMode: 0,
        },
        {
          creatorType: "author",
          name: "Example Research Consortium",
          fieldMode: 1,
        },
      ],
    });
    installZotero([article]);

    const resolution = createZoteroMetadataResolver().resolvePaperMetadata(
      paperRef(35),
    );
    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.deepEqual(resolution.value.bibliographicItem?.creators, [
      {
        creatorType: "author",
        firstName: "Ada",
        lastName: "Example",
        fieldMode: 0,
      },
      {
        creatorType: "author",
        name: "Example Research Consortium",
        fieldMode: 1,
      },
    ]);
  });

  it("does not promote publisher fields or probe unsupported event fields", function () {
    const requestedFields: string[] = [];
    const article = fakeItem({
      id: 36,
      itemTypeID: 1,
      itemType: "journalArticle",
      fields: { title: "Publisher Only", publisher: "Example Publisher" },
    });
    article.getField = (fieldName: string) => {
      requestedFields.push(fieldName);
      if (fieldName === "conferenceName" || fieldName === "meetingName") {
        throw new Error(`Unsupported field ${fieldName}`);
      }
      return fieldName === "title"
        ? "Publisher Only"
        : fieldName === "publisher"
          ? "Example Publisher"
          : "";
    };
    installZotero([article]);

    const resolution = createZoteroMetadataResolver().resolvePaperMetadata(
      paperRef(36),
    );
    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    const bibliography = resolution.value.bibliographicItem?.bibliography;
    assert.notProperty(bibliography, "containerTitle");
    assert.notProperty(bibliography, "eventTitle");
    assert.notInclude(requestedFields, "publisher");
    assert.notInclude(requestedFields, "conferenceName");
    assert.notInclude(requestedFields, "meetingName");
  });

  it("does not restore cleared live fields from the stored paper ref", function () {
    const article = fakeItem({
      id: 40,
      itemTypeID: 1,
      itemType: "journalArticle",
      fields: {},
    });
    installZotero([article]);
    const ref = paperRef(40);
    const resolver = createZoteroMetadataResolver();

    const projected = projectPaperMetadata(
      resolver.resolvePaperMetadata(ref),
      ref,
    );
    assert.equal(projected.source, "live");
    assert.notProperty(projected, "title");
    assert.notProperty(projected, "firstCreator");
    assert.notProperty(projected, "year");
    assert.notProperty(projected, "citationKey");
  });

  it("uses the thin stored ref only when the live primary item is missing", function () {
    installZotero([]);
    const ref = paperRef(404);
    const projected = projectPaperMetadata(
      createZoteroMetadataResolver().resolvePaperMetadata(ref),
      ref,
    );
    assert.equal(projected.source, "stored_fallback");
    assert.equal(projected.title, "Stored stale title");
    assert.equal(projected.firstCreator, "Stored Author");
  });

  it("validates attachment relationships without inferring a selection subject", function () {
    const parent = fakeItem({
      id: 50,
      itemTypeID: 1,
      itemType: "journalArticle",
      fields: { title: "Parent Paper" },
    });
    const attachment = fakeItem({
      id: 501,
      itemTypeID: 14,
      itemType: "attachment",
      parentID: 50,
      fields: { title: "Translated PDF" },
      attachment: {
        filename: "translated.pdf",
        contentType: "application/pdf",
      },
    });
    installZotero([parent, attachment]);
    const resolver = createZoteroMetadataResolver();
    const ref = paperRef(50, 501);

    const parentSelection = resolver.resolvePaperMetadata(ref);
    const attachmentSelection = resolver.resolvePaperMetadata(ref);
    assert.deepEqual(parentSelection, attachmentSelection);
    if (parentSelection.status !== "resolved") return;
    assert.notProperty(parentSelection.value, "subjectItem");
    assert.equal(parentSelection.value.contentSource?.identity.itemId, 501);

    const explicit = resolver.resolveItemMetadata(501, {
      detail: "complete",
      includeSystemMetadata: true,
    });
    assert.equal(explicit.status, "resolved");
    if (explicit.status !== "resolved") return;
    assert.equal(explicit.value.kind, "attachment");
    assert.equal(explicit.value.identity.itemId, 501);
    assert.equal(projectLibraryReadMetadata(explicit.value).kind, "attachment");
  });

  it("keeps a cleared live parent title distinct from its child attachment title", function () {
    const parent = fakeItem({
      id: 42,
      itemTypeID: 1,
      itemType: "journalArticle",
      fields: {},
    });
    const attachment = fakeItem({
      id: 101,
      itemTypeID: 14,
      itemType: "attachment",
      parentID: 42,
      fields: { title: "Full Text PDF" },
      attachment: {
        filename: "paper.pdf",
        contentType: "application/pdf",
      },
    });
    installZotero([parent, attachment]);
    const ref = paperRef(42, 101);

    const projected = projectPaperMetadata(
      createZoteroMetadataResolver().resolvePaperMetadata(ref),
      ref,
    );

    assert.equal(projected.source, "live");
    assert.notProperty(projected, "title");
    assert.deepInclude(projected.contentSource || {}, {
      itemId: 101,
      parentItemId: 42,
      title: "Full Text PDF",
    });
    assert.notEqual(projected.title, ref.title);
  });

  it("resolves a standalone attachment without fabricating bibliography", function () {
    const attachment = fakeItem({
      id: 551,
      itemTypeID: 14,
      itemType: "attachment",
      fields: { title: "Standalone PDF" },
      attachment: {
        filename: "standalone.pdf",
        contentType: "application/pdf",
      },
    });
    installZotero([attachment]);

    const resolution = createZoteroMetadataResolver().resolvePaperMetadata(
      paperRef(551),
    );
    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.notProperty(resolution.value, "bibliographicItem");
    assert.equal(resolution.value.contentSource?.identity.itemId, 551);
    assert.equal(resolution.value.contentSource?.filename, "standalone.pdf");
  });

  it("keeps parent bibliography when a child attachment is missing", function () {
    const parent = fakeItem({
      id: 56,
      itemTypeID: 1,
      itemType: "journalArticle",
      fields: { title: "Available Parent" },
    });
    installZotero([parent]);

    const resolution = createZoteroMetadataResolver().resolvePaperMetadata(
      paperRef(56, 999),
    );
    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.equal(
      resolution.value.bibliographicItem?.bibliography.title?.value,
      "Available Parent",
    );
    assert.notProperty(resolution.value, "contentSource");
    assert.equal(resolution.warnings[0]?.code, "missing_content_source");
  });

  it("keeps live bibliography when the content-source relationship is invalid", function () {
    const parent = fakeItem({
      id: 60,
      itemTypeID: 1,
      itemType: "journalArticle",
      fields: { title: "Right Parent" },
    });
    const unrelated = fakeItem({
      id: 601,
      itemTypeID: 14,
      itemType: "attachment",
      parentID: 999,
      fields: { title: "Wrong Child" },
      attachment: { filename: "wrong.pdf", contentType: "application/pdf" },
    });
    installZotero([parent, unrelated]);

    const resolution = createZoteroMetadataResolver().resolvePaperMetadata(
      paperRef(60, 601),
    );
    assert.equal(resolution.status, "resolved");
    if (resolution.status !== "resolved") return;
    assert.equal(
      resolution.value.bibliographicItem?.bibliography.title?.value,
      "Right Parent",
    );
    assert.notProperty(resolution.value, "contentSource");
    assert.equal(
      resolution.warnings[0]?.code,
      "invalid_content_source_relationship",
    );
  });

  it("does not convert unexpected Zotero read failures into stored fallback", function () {
    const article = fakeItem({
      id: 70,
      itemTypeID: 1,
      itemType: "journalArticle",
      fields: { title: "Unreadable" },
    });
    article.getField = () => {
      throw new Error("Zotero read failed");
    };
    installZotero([article]);

    assert.throws(
      () => createZoteroMetadataResolver().resolvePaperMetadata(paperRef(70)),
      /Zotero read failed/,
    );
  });
});
