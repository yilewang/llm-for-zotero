import { assert } from "chai";
import type {
  ChatAttachment,
  PaperContextRef,
} from "../src/modules/contextPanel/types";
import {
  resolvePdfModeModelInputs,
  type PdfPaperModelInputDeps,
} from "../src/modules/contextPanel/setupHandlers/controllers/pdfPaperModelInputController";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "../src/modules/contextPanel/pdfSupportMessages";

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

  it("blocks PDF-mode papers for non-native providers", async function () {
    const deps = createDeps({ getModelPdfSupport: () => "none" });

    const result = await resolvePdfModeModelInputs({
      deps,
      paperContexts: [paperContext],
      selectedBaseFiles: [],
      selectedImageCountForBudget: 0,
      profile: { model: "openai-compatible", authMode: "api_key" },
      currentModelName: "openai-compatible",
    });

    assert.isFalse(result.ok);
    assert.deepInclude(deps.statuses, {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
  });

  it("blocks direct uploaded PDFs for non-native providers", async function () {
    const deps = createDeps({ getModelPdfSupport: () => "none" });

    const result = await resolvePdfModeModelInputs({
      deps,
      paperContexts: [],
      selectedBaseFiles: [directPdf],
      selectedImageCountForBudget: 0,
      profile: {
        model: "openai-compatible",
        authMode: "api_key",
      },
      currentModelName: "openai-compatible",
    });

    assert.isFalse(result.ok);
    assert.deepInclude(deps.statuses, {
      message: FULL_PDF_UNSUPPORTED_MESSAGE,
      level: "error",
    });
  });
});
