import { assert } from "chai";
import { getBlockedCodexAppServerChatAttachments } from "../src/modules/contextPanel/codexAppServerAttachmentPolicy";
import type { ChatAttachment } from "../src/modules/contextPanel/types";

describe("codex app-server attachment policy", function () {
  it("blocks direct pinned PDFs but allows generated PDF-mode paper attachments", function () {
    const directPdf: ChatAttachment = {
      id: "file-1",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      category: "pdf",
    };
    const generatedPdfPaper: ChatAttachment = {
      id: "pdf-paper-34-1",
      name: "paper.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      category: "pdf",
      storedPath: "/tmp/paper.pdf",
    };

    assert.deepEqual(
      getBlockedCodexAppServerChatAttachments([directPdf, generatedPdfPaper]),
      [directPdf],
    );
  });
});
