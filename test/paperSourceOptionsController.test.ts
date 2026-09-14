import { assert } from "chai";
import { describe, it } from "mocha";
import {
  buildPaperSourceOptions,
  canRevealMineruCacheForSourceOption,
  filterPaperSourceOptionsForWebChat,
  resolvePaperPdfSupportForConversation,
  shouldDowngradePdfSourceForConversation,
  resolveMineruSourceOptionState,
} from "../src/modules/contextPanel/setupHandlers/controllers/paperSourceOptionsController";
import { getContextSourceModeDescriptor } from "../src/modules/contextPanel/contextSourceModes";
import type {
  PaperContentSourceMode,
  PaperContextRef,
} from "../src/modules/contextPanel/types";
import type { PdfSupport } from "../src/providers";

function makeParentItem(params: {
  id: number;
  attachmentIds: number[];
  title?: string;
}): Zotero.Item {
  return {
    id: params.id,
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => params.attachmentIds,
    getField: (field: string) => {
      if (field === "title") return params.title || "Parent paper";
      if (field === "firstCreator") return "Chandra";
      if (field === "year") return "2025";
      return "";
    },
  } as unknown as Zotero.Item;
}

function makeAttachment(params: {
  id: number;
  parentID: number;
  filename: string;
  contentType: string;
  title?: string;
}): Zotero.Item {
  return {
    id: params.id,
    parentID: params.parentID,
    attachmentFilename: params.filename,
    attachmentContentType: params.contentType,
    isAttachment: () => true,
    isRegularItem: () => false,
    getField: (field: string) =>
      field === "title" ? params.title || params.filename : "",
  } as unknown as Zotero.Item;
}

function buildOptionsForItems(params: {
  paperContext: PaperContextRef;
  items: Zotero.Item[];
  webChatMode?: boolean;
  mineruCachedIds?: number[];
  pdfSupport?: PdfSupport;
}) {
  const itemsById = new Map(params.items.map((item) => [item.id, item]));
  return buildPaperSourceOptions({
    paperContext: params.paperContext,
    getItemById: (itemId) => itemsById.get(itemId) || null,
    webChatMode: params.webChatMode === true,
    pdfSupport: params.pdfSupport || "native",
    isMineruEnabled: true,
    getItemStatus: (contextItemId) =>
      params.mineruCachedIds?.includes(contextItemId)
        ? { status: "cached" }
        : undefined,
    isPaperContextMineru: () => false,
    mineruAvailableIds: new Set(params.mineruCachedIds || []),
    fullPdfUnsupportedMessage: "PDF unsupported",
    mineruDisabledParsingMessage: "enable MinerU",
    translate: (text) => text,
  });
}

describe("paper source MinerU option state", function () {
  it("builds source options with a valid PDF and a legacy linked sibling", function () {
    const parent = makeParentItem({ id: 1, attachmentIds: [11, 12] });
    const localPdf = makeAttachment({
      id: 11,
      parentID: 1,
      filename: "paper.pdf",
      contentType: "application/pdf",
    });
    const legacyPdf = makeAttachment({
      id: 12,
      parentID: 1,
      filename: "",
      contentType: "application/octet-stream",
    });
    Object.defineProperties(legacyPdf, {
      attachmentFilename: {
        get() {
          throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH");
        },
      },
      attachmentPath: { value: "F:\\legacy\\paper.PDF" },
    });
    const options = buildOptionsForItems({
      paperContext: { itemId: 1, contextItemId: 11, title: "Parent paper" },
      items: [parent, localPdf, legacyPdf],
    });
    assert.includeMembers(
      options.map((option) => option.paperContext.contextItemId),
      [11, 12],
    );
    assert.isTrue(
      options.some(
        (option) =>
          option.paperContext.contextItemId === 12 &&
          option.paperContext.attachmentTitle === "paper.PDF",
      ),
    );
  });

  it("uses local-path PDF support only for Claude Code and Codex conversations", function () {
    assert.equal(
      resolvePaperPdfSupportForConversation({
        basePdfSupport: "none",
        isClaudeCode: true,
        isCodex: false,
      }),
      "local_path",
    );
    assert.equal(
      resolvePaperPdfSupportForConversation({
        basePdfSupport: "native",
        isClaudeCode: false,
        isCodex: false,
      }),
      "native",
    );
  });

  it("retains purple PDF sources across Claude/Codex model switches only", function () {
    assert.isFalse(
      shouldDowngradePdfSourceForConversation({
        basePdfSupport: "none",
        isClaudeCode: true,
        isCodex: false,
      }),
    );
    assert.isFalse(
      shouldDowngradePdfSourceForConversation({
        basePdfSupport: "none",
        isClaudeCode: false,
        isCodex: true,
      }),
    );
    assert.isTrue(
      shouldDowngradePdfSourceForConversation({
        basePdfSupport: "none",
        isClaudeCode: false,
        isCodex: false,
      }),
    );
  });

  it("enables the PDF source for local-path agent runtimes", function () {
    const parent = makeParentItem({ id: 10, attachmentIds: [20] });
    const attachment = makeAttachment({
      id: 20,
      parentID: 10,
      filename: "paper.pdf",
      contentType: "application/pdf",
    });

    const options = buildOptionsForItems({
      paperContext: {
        itemId: 10,
        contextItemId: 20,
        title: "Paper",
      },
      items: [parent, attachment],
      pdfSupport: "local_path",
    });

    const pdf = options.find((option) => option.mode === "pdf");
    assert.isDefined(pdf);
    assert.isUndefined(pdf?.disabledReason);
  });

  it("offers Text and raw PDF sources for a standalone PDF attachment", function () {
    const attachment = makeAttachment({
      id: 30,
      parentID: 0,
      filename: "standalone.pdf",
      contentType: "application/pdf",
      title: "Standalone PDF",
    });

    const options = buildOptionsForItems({
      paperContext: {
        itemId: 30,
        contextItemId: 30,
        title: "Standalone PDF",
      },
      items: [attachment],
      pdfSupport: "local_path",
    });

    assert.deepEqual(
      options.map((option) => option.mode),
      ["mineru", "text", "pdf"],
    );
    assert.deepEqual(
      options.map((option) => [
        option.paperContext.itemId,
        option.paperContext.contextItemId,
      ]),
      [
        [30, 30],
        [30, 30],
        [30, 30],
      ],
    );
    assert.isUndefined(
      options.find((option) => option.mode === "pdf")?.disabledReason,
    );
    assert.isDefined(options.find((option) => option.mode === "text"));
  });

  it("describes source modes with one shared descriptor", function () {
    const expectations: Array<{
      mode: PaperContentSourceMode;
      badge: string;
      humanLabel: string;
      cssClassName: string;
      isReaderNavigable: boolean;
      isTextLikeAttachment: boolean;
    }> = [
      {
        mode: "pdf",
        badge: "PDF",
        humanLabel: "PDF file",
        cssClassName: "llm-paper-context-chip-pdf",
        isReaderNavigable: true,
        isTextLikeAttachment: false,
      },
      {
        mode: "text",
        badge: "Text",
        humanLabel: "extracted text",
        cssClassName: "llm-paper-context-chip-text",
        isReaderNavigable: true,
        isTextLikeAttachment: false,
      },
      {
        mode: "mineru",
        badge: "MD",
        humanLabel: "MinerU",
        cssClassName: "llm-paper-context-chip-mineru",
        isReaderNavigable: true,
        isTextLikeAttachment: false,
      },
      {
        mode: "markdown",
        badge: "MD",
        humanLabel: "Markdown attachment",
        cssClassName: "llm-paper-context-chip-mineru",
        isReaderNavigable: false,
        isTextLikeAttachment: true,
      },
      {
        mode: "html",
        badge: "HTML",
        humanLabel: "HTML attachment",
        cssClassName: "llm-paper-context-chip-html",
        isReaderNavigable: false,
        isTextLikeAttachment: true,
      },
      {
        mode: "txt",
        badge: "TXT",
        humanLabel: "TXT attachment",
        cssClassName: "llm-paper-context-chip-text",
        isReaderNavigable: false,
        isTextLikeAttachment: true,
      },
      {
        mode: "docx",
        badge: "DOCX",
        humanLabel: "Word attachment",
        cssClassName: "llm-paper-context-chip-text",
        isReaderNavigable: false,
        isTextLikeAttachment: true,
      },
    ];

    for (const expected of expectations) {
      const descriptor = getContextSourceModeDescriptor(expected.mode);
      assert.equal(descriptor?.badgeLabel, expected.badge);
      assert.equal(descriptor?.humanLabel, expected.humanLabel);
      assert.equal(descriptor?.cssClassName, expected.cssClassName);
      assert.equal(descriptor?.isReaderNavigable, expected.isReaderNavigable);
      assert.equal(
        descriptor?.isTextLikeAttachment,
        expected.isTextLikeAttachment,
      );
      assert.isString(descriptor?.sourceTitle);
      assert.isString(descriptor?.attachmentSourceTypeLabel);
    }
  });

  it("filters webchat source options to PDF rows only", function () {
    const filtered = filterPaperSourceOptionsForWebChat([
      { mode: "mineru", label: "MinerU" },
      { mode: "text", label: "Extracted text" },
      { mode: "pdf", label: "PDF" },
      { mode: "markdown", label: "Markdown attachment" },
      { mode: "html", label: "HTML attachment" },
      { mode: "txt", label: "TXT attachment" },
      { mode: "docx", label: "Word attachment" },
    ]);

    assert.deepEqual(filtered, [{ mode: "pdf", label: "PDF" }]);
  });

  it("offers an action MD row and keeps extracted text when MinerU is missing", function () {
    const state = resolveMineruSourceOptionState({
      hasUsableMineru: false,
    });

    assert.deepEqual(state, {
      state: "idle",
      action: "start",
      hideTextSource: false,
    });
  });

  it("selects MD and hides extracted text when MinerU is cached", function () {
    const state = resolveMineruSourceOptionState({
      hasUsableMineru: true,
    });

    assert.deepEqual(state, {
      state: "cached",
      action: "select",
      hideTextSource: true,
    });
  });

  it("treats a just-cached processing status as a usable MinerU source", function () {
    const state = resolveMineruSourceOptionState({
      hasUsableMineru: false,
      itemStatus: { status: "cached" },
    });

    assert.deepEqual(state, {
      state: "cached",
      action: "select",
      hideTextSource: true,
    });
  });

  it("turns a running parse into a pause action", function () {
    const state = resolveMineruSourceOptionState({
      hasUsableMineru: false,
      itemStatus: { status: "processing" },
    });

    assert.deepEqual(state, {
      state: "processing",
      action: "pause",
      hideTextSource: false,
    });
  });

  it("keeps extracted text hidden for a reparse over an existing cache", function () {
    const processing = resolveMineruSourceOptionState({
      hasUsableMineru: true,
      itemStatus: { status: "processing" },
    });
    const failed = resolveMineruSourceOptionState({
      hasUsableMineru: true,
      itemStatus: { status: "failed" },
    });

    assert.deepEqual(processing, {
      state: "processing",
      action: "pause",
      hideTextSource: true,
    });
    assert.deepEqual(failed, {
      state: "failed",
      action: "retry",
      hideTextSource: true,
    });
  });

  it("turns a failed missing-cache parse into a retry while keeping text available", function () {
    const state = resolveMineruSourceOptionState({
      hasUsableMineru: false,
      itemStatus: { status: "failed" },
    });

    assert.deepEqual(state, {
      state: "failed",
      action: "retry",
      hideTextSource: false,
    });
  });

  it("builds MinerU, extracted text, and PDF options for a PDF child attachment", function () {
    const parent = makeParentItem({ id: 10, attachmentIds: [11] });
    const pdf = makeAttachment({
      id: 11,
      parentID: 10,
      filename: "paper.pdf",
      contentType: "application/pdf",
      title: "paper.pdf",
    });

    const options = buildOptionsForItems({
      paperContext: { itemId: 10, contextItemId: 11, title: "Parent paper" },
      items: [parent, pdf],
    });

    assert.deepEqual(
      options.map((option) => option.mode),
      ["mineru", "text", "pdf"],
    );
    assert.deepEqual(
      options.map((option) => option.badge),
      ["MD", "Text", "PDF"],
    );
    assert.deepEqual(
      options.map((option) => option.paperContext.contextItemId),
      [11, 11, 11],
    );
  });

  it("exposes cache reveal only for cached selectable MinerU rows", function () {
    const parent = makeParentItem({ id: 10, attachmentIds: [11] });
    const pdf = makeAttachment({
      id: 11,
      parentID: 10,
      filename: "paper.pdf",
      contentType: "application/pdf",
      title: "paper.pdf",
    });

    const cachedOptions = buildOptionsForItems({
      paperContext: { itemId: 10, contextItemId: 11, title: "Parent paper" },
      items: [parent, pdf],
      mineruCachedIds: [11],
    });
    const cachedMineruOption = cachedOptions.find(
      (option) => option.mode === "mineru",
    );

    assert.isOk(cachedMineruOption);
    assert.isTrue(canRevealMineruCacheForSourceOption(cachedMineruOption!));
    assert.isFalse(
      canRevealMineruCacheForSourceOption({
        mode: "mineru",
        mineruState: "idle",
        mineruAction: "start",
      }),
    );
    assert.isFalse(
      canRevealMineruCacheForSourceOption({
        mode: "mineru",
        mineruState: "processing",
        mineruAction: "pause",
      }),
    );
    assert.isFalse(
      canRevealMineruCacheForSourceOption({
        mode: "mineru",
        mineruState: "failed",
        mineruAction: "retry",
      }),
    );
    assert.isFalse(
      canRevealMineruCacheForSourceOption({
        mode: "mineru",
        mineruState: "cached",
        mineruAction: "select",
        disabledReason: "disabled",
      }),
    );
    assert.isFalse(
      canRevealMineruCacheForSourceOption({
        mode: "pdf",
      }),
    );
    assert.isFalse(
      canRevealMineruCacheForSourceOption({
        mode: "text",
      }),
    );
  });

  it("builds one option for each supported text-like child attachment", function () {
    const parent = makeParentItem({ id: 20, attachmentIds: [21, 22, 23, 24] });
    const markdown = makeAttachment({
      id: 21,
      parentID: 20,
      filename: "test.md",
      contentType: "text/markdown",
      title: "test",
    });
    const html = makeAttachment({
      id: 22,
      parentID: 20,
      filename: "page.html",
      contentType: "text/html",
    });
    const txt = makeAttachment({
      id: 23,
      parentID: 20,
      filename: "notes.txt",
      contentType: "text/plain",
    });
    const docx = makeAttachment({
      id: 24,
      parentID: 20,
      filename: "draft.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const options = buildOptionsForItems({
      paperContext: { itemId: 20, contextItemId: 21, title: "Parent paper" },
      items: [parent, markdown, html, txt, docx],
    });

    assert.deepEqual(
      options.map((option) => option.mode),
      ["markdown", "html", "txt", "docx"],
    );
    assert.deepEqual(
      options.map((option) => option.badge),
      ["MD", "HTML", "TXT", "DOCX"],
    );
    assert.deepEqual(
      options.map((option) => option.paperContext.contentSourceMode),
      ["markdown", "html", "txt", "docx"],
    );
  });

  it("omits unsupported child attachments", function () {
    const parent = makeParentItem({ id: 30, attachmentIds: [31] });
    const image = makeAttachment({
      id: 31,
      parentID: 30,
      filename: "figure.png",
      contentType: "image/png",
    });

    const options = buildOptionsForItems({
      paperContext: { itemId: 30, contextItemId: 31, title: "Parent paper" },
      items: [parent, image],
    });

    assert.deepEqual(options, []);
  });

  it("keeps WebChat source options PDF-only", function () {
    const parent = makeParentItem({ id: 40, attachmentIds: [41, 42] });
    const pdf = makeAttachment({
      id: 41,
      parentID: 40,
      filename: "paper.pdf",
      contentType: "application/pdf",
    });
    const markdown = makeAttachment({
      id: 42,
      parentID: 40,
      filename: "test.md",
      contentType: "text/markdown",
    });

    const options = buildOptionsForItems({
      paperContext: { itemId: 40, contextItemId: 41, title: "Parent paper" },
      items: [parent, pdf, markdown],
      webChatMode: true,
    });

    assert.deepEqual(
      options.map((option) => option.mode),
      ["pdf"],
    );
  });
});
