import { assert } from "chai";
import type {
  ChatAttachment,
  PaperContextRef,
} from "../src/modules/contextPanel/types";
import {
  resolvePdfModeModelInputs,
  type PdfPaperModelInputDeps,
} from "../src/modules/contextPanel/setupHandlers/controllers/pdfPaperModelInputController";

describe("pdfPaperModelInputController", function () {
  const paperContext: PaperContextRef = {
    itemId: 10,
    contextItemId: 20,
    title: "Paper",
    attachmentTitle: "Paper PDF",
  };
  const directPdf: ChatAttachment = {
    id: "direct-pdf",
    name: "direct.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    category: "pdf",
    storedPath: "/tmp/direct.pdf",
  };
  const paperPdf: ChatAttachment = {
    id: "paper-pdf",
    name: "paper.pdf",
    mimeType: "application/pdf",
    sizeBytes: 20,
    category: "pdf",
    storedPath: "/tmp/paper.pdf",
  };

  function createDeps(
    overrides: Partial<PdfPaperModelInputDeps> = {},
  ): PdfPaperModelInputDeps & {
    statuses: Array<{ message: string; level: string }>;
  } {
    const statuses: Array<{ message: string; level: string }> = [];
    return {
      statuses,
      setStatusMessage: (message, level) => {
        statuses.push({ message, level });
      },
      logError: () => undefined,
      isScreenshotUnsupportedModel: () => false,
      getModelPdfSupport: () => "native",
      resolvePdfPaperAttachments: async () => [paperPdf],
      renderPdfPagesAsImages: async () => ["data:image/png;base64,PAGE"],
      uploadPdfForProvider: async () => ({
        systemMessageContent: "uploaded context",
        label: "Uploaded PDF",
      }),
      resolvePdfBytes: async () => new Uint8Array([1, 2, 3]),
      ...overrides,
    };
  }

  it("uses the same generated paper PDF as display and model input for native providers", async function () {
    const deps = createDeps({ getModelPdfSupport: () => "native" });

    const result = await resolvePdfModeModelInputs({
      deps,
      paperContexts: [paperContext],
      selectedBaseFiles: [directPdf],
      selectedImageCountForBudget: 0,
      profile: { model: "gpt-5.4", authMode: "api_key" },
      currentModelName: "gpt-5.4",
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.selectedFiles, [directPdf, paperPdf]);
    assert.deepEqual(result.modelFiles, [directPdf, paperPdf]);
    assert.deepEqual(result.pdfPageImageDataUrls, []);
    assert.deepEqual(result.pdfUploadSystemMessages, []);
  });

  it("renders PDF-mode papers as page images while preserving display attachments for vision providers", async function () {
    const deps = createDeps({ getModelPdfSupport: () => "vision" });

    const result = await resolvePdfModeModelInputs({
      deps,
      paperContexts: [paperContext],
      selectedBaseFiles: [directPdf],
      selectedImageCountForBudget: 0,
      profile: { model: "vision-compatible", authMode: "api_key" },
      currentModelName: "vision-compatible",
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.selectedFiles, [directPdf, paperPdf]);
    assert.deepEqual(result.modelFiles, [directPdf]);
    assert.deepEqual(result.pdfPageImageDataUrls, [
      "data:image/png;base64,PAGE",
    ]);
    assert.deepInclude(deps.statuses, {
      message:
        "This provider cannot read PDFs directly. Sending the Zotero PDF as page images.",
      level: "warning",
    });
  });

  it("converts upload-provider paper PDFs into system messages only", async function () {
    const deps = createDeps({ getModelPdfSupport: () => "upload" });

    const result = await resolvePdfModeModelInputs({
      deps,
      paperContexts: [paperContext],
      selectedBaseFiles: [],
      selectedImageCountForBudget: 0,
      profile: {
        model: "kimi-k2.5",
        authMode: "api_key",
        apiBase: "https://api.moonshot.cn/v1",
        apiKey: "test-key",
      },
      currentModelName: "kimi-k2.5",
    });

    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.selectedFiles, [paperPdf]);
    assert.deepEqual(result.modelFiles, []);
    assert.deepEqual(result.pdfUploadSystemMessages, ["uploaded context"]);
  });
});
