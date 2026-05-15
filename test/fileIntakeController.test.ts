import { assert } from "chai";
import type { PdfSupport } from "../src/providers";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "../src/modules/contextPanel/pdfSupportMessages";
import type { ChatAttachment } from "../src/modules/contextPanel/types";
import { createFileIntakeController } from "../src/modules/contextPanel/setupHandlers/controllers/fileIntakeController";

describe("fileIntakeController", function () {
  const item = { id: 42 } as Zotero.Item;

  function makeFile(
    name: string,
    type: string,
    bytes: Uint8Array = new Uint8Array([1, 2, 3]),
  ): File {
    return new File([bytes], name, { type, lastModified: 123 });
  }

  function createController(pdfSupport: PdfSupport) {
    const selectedFileAttachmentCache = new Map<number, ChatAttachment[]>();
    const selectedImageCache = new Map<number, string[]>();
    const statuses: Array<{ message: string; level: string }> = [];
    const persisted: Array<{ fileName: string; bytes: Uint8Array }> = [];
    const controller = createFileIntakeController({
      body: {} as Element,
      getItem: () => item,
      getCurrentModel: () => "gpt-5.4",
      getCurrentPdfSupport: () => pdfSupport,
      isScreenshotUnsupportedModel: () => false,
      optimizeImageDataUrl: async (_win, dataUrl) => dataUrl,
      persistAttachmentBlob: async (fileName, bytes) => {
        persisted.push({ fileName, bytes });
        return {
          storedPath: `/tmp/${fileName}`,
          contentHash: `hash-${fileName}`,
        };
      },
      selectedImageCache,
      selectedFileAttachmentCache,
      updateImagePreview: () => undefined,
      updateFilePreview: () => undefined,
      scheduleAttachmentGc: () => undefined,
      setStatusMessage: (message, level) => {
        statuses.push({ message, level });
      },
    });
    return {
      ...controller,
      selectedFileAttachmentCache,
      statuses,
      persisted,
    };
  }

  it("rejects PDF uploads before persistence for non-native providers", async function () {
    const controller = createController("none");

    await controller.processIncomingFiles([
      makeFile("paper.pdf", "application/pdf"),
    ]);

    assert.deepEqual(
      controller.selectedFileAttachmentCache.get(item.id),
      undefined,
    );
    assert.lengthOf(controller.persisted, 0);
    assert.deepEqual(controller.statuses.at(-1), {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
  });

  it("keeps direct PDF upload available for native PDF providers", async function () {
    const controller = createController("native");

    await controller.processIncomingFiles([
      makeFile("paper.pdf", "application/pdf"),
    ]);

    const files = controller.selectedFileAttachmentCache.get(item.id) || [];
    assert.lengthOf(files, 1);
    assert.deepInclude(files[0], {
      name: "paper.pdf",
      mimeType: "application/pdf",
      category: "pdf",
      storedPath: "/tmp/paper.pdf",
      contentHash: "hash-paper.pdf",
    });
    assert.lengthOf(controller.persisted, 1);
    assert.deepEqual(controller.statuses.at(-1), {
      message: "Uploaded 1 attachment(s)",
      level: "ready",
    });
  });
});
