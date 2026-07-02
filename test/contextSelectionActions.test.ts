import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  addZoteroItemsAsDefaultContext,
  type ContextSelectionActionDeps,
} from "../src/modules/contextPanel/contextSelectionActions";
import {
  selectedPaperContextCache,
  selectedPaperPreviewExpandedCache,
} from "../src/modules/contextPanel/state";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

function makeAttachment(params: {
  id: number;
  parentID: number;
  title?: string;
  contentType?: string;
  filename?: string;
}): Zotero.Item {
  const title = params.title || `Attachment ${params.id}`;
  return {
    id: params.id,
    key: `A${params.id}`,
    libraryID: 1,
    parentID: params.parentID,
    attachmentContentType: params.contentType || "application/pdf",
    attachmentFilename: params.filename || title,
    isAttachment: () => true,
    isRegularItem: () => false,
    getField: (field: string) => (field === "title" ? title : ""),
  } as unknown as Zotero.Item;
}

function makeNote(params: {
  id: number;
  parentItemID?: number;
  parentID?: number;
}): Zotero.Item {
  return {
    id: params.id,
    key: `N${params.id}`,
    libraryID: 1,
    parentItemID: params.parentItemID,
    parentID: params.parentID,
    isAttachment: () => false,
    isRegularItem: () => false,
    isNote: () => true,
    getField: () => "",
  } as unknown as Zotero.Item;
}

function makeRegular(params: {
  id: number;
  title?: string;
  bestAttachment?: Zotero.Item | null;
  onBestAttachment?: () => void;
}): Zotero.Item {
  return {
    id: params.id,
    key: `P${params.id}`,
    libraryID: 1,
    firstCreator: "Tester",
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => [],
    getBestAttachment: async () => {
      params.onBestAttachment?.();
      return params.bestAttachment || null;
    },
    getField: (field: string) => {
      switch (field) {
        case "title":
          return params.title || `Paper ${params.id}`;
        case "firstCreator":
          return "Tester";
        case "year":
          return "2026";
        default:
          return "";
      }
    },
  } as unknown as Zotero.Item;
}

function installItems(items: Zotero.Item[]): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  globalScope.Zotero = {
    ...(originalZotero || {}),
    Items: {
      get: (id: number) => byId.get(id) || null,
    },
  };
}

function makeDeps(ownerItemId: number): ContextSelectionActionDeps {
  return {
    item: { id: ownerItemId } as Zotero.Item,
    resolveAutoLoadedPaperContext: () => null,
    getManualPaperContextsForItem: () =>
      selectedPaperContextCache.get(ownerItemId) || [],
    isPaperContextMineru: () => false,
    getTextContextConversationKey: () => null,
    updatePaperPreviewPreservingScroll: () => undefined,
    updateSelectedTextPreviewPreservingScroll: () => undefined,
  };
}

describe("default Zotero item context selection", function () {
  afterEach(function () {
    selectedPaperContextCache.clear();
    selectedPaperPreviewExpandedCache.clear();
    globalScope.Zotero = originalZotero;
  });

  it("adds the regular item's Zotero best supported attachment instead of the first child", async function () {
    const ownerItemId = 9301;
    const firstPdf = makeAttachment({
      id: 101,
      parentID: 100,
      title: "First PDF",
    });
    const bestMarkdown = makeAttachment({
      id: 102,
      parentID: 100,
      title: "Best Markdown",
      contentType: "text/markdown",
      filename: "best.md",
    });
    const parent = makeRegular({
      id: 100,
      title: "Best Source Paper",
      bestAttachment: bestMarkdown,
    });
    installItems([parent, firstPdf, bestMarkdown]);

    const result = await addZoteroItemsAsDefaultContext(makeDeps(ownerItemId), [
      parent,
    ]);

    assert.isTrue(result.changed);
    const selected = selectedPaperContextCache.get(ownerItemId) || [];
    assert.lengthOf(selected, 1);
    assert.include(selected[0] as PaperContextRef, {
      itemId: 100,
      contextItemId: 102,
      title: "Best Source Paper",
      attachmentTitle: "Best Markdown",
      contentSourceMode: "markdown",
    });
  });

  it("dedupes selected child rows by parent before adding the parent's best attachment", async function () {
    const ownerItemId = 9302;
    let bestAttachmentCalls = 0;
    const childPdf = makeAttachment({ id: 201, parentID: 200 });
    const childMarkdown = makeAttachment({
      id: 202,
      parentID: 200,
      contentType: "text/markdown",
      filename: "child.md",
    });
    const bestPdf = makeAttachment({
      id: 203,
      parentID: 200,
      title: "Best PDF",
    });
    const childNote = makeNote({ id: 204, parentItemID: 200 });
    const parent = makeRegular({
      id: 200,
      bestAttachment: bestPdf,
      onBestAttachment: () => {
        bestAttachmentCalls += 1;
      },
    });
    installItems([parent, childPdf, childMarkdown, bestPdf, childNote]);

    const result = await addZoteroItemsAsDefaultContext(makeDeps(ownerItemId), [
      childPdf,
      childMarkdown,
      childNote,
    ]);

    assert.isTrue(result.changed);
    assert.equal(bestAttachmentCalls, 1);
    const selected = selectedPaperContextCache.get(ownerItemId) || [];
    assert.lengthOf(selected, 1);
    assert.include(selected[0] as PaperContextRef, {
      itemId: 200,
      contextItemId: 203,
    });
  });

  it("skips unsupported best attachments and standalone notes", async function () {
    const ownerItemId = 9303;
    const image = makeAttachment({
      id: 302,
      parentID: 300,
      contentType: "image/png",
      filename: "image.png",
    });
    const parent = makeRegular({
      id: 300,
      bestAttachment: image,
    });
    const standaloneNote = makeNote({ id: 301 });
    installItems([parent, image, standaloneNote]);

    const result = await addZoteroItemsAsDefaultContext(makeDeps(ownerItemId), [
      parent,
      standaloneNote,
    ]);

    assert.isFalse(result.changed);
    assert.equal(result.statusLevel, "warning");
    assert.isUndefined(selectedPaperContextCache.get(ownerItemId));
  });
});
