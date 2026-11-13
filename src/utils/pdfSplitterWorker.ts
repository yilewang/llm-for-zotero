import { EncryptedPDFError, PDFDocument } from "pdf-lib";
import { readPdfOutline, type PdfOutlineResult } from "./pdfOutline";

// Bundled as a separate worker. No Zotero globals, file paths, or OS executables.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
let source: PDFDocument | undefined;
scope.onmessage = async ({ data }) => {
  const { id, action } = data;
  try {
    if (action === "open") {
      source = await PDFDocument.load(data.bytes, { updateMetadata: false });
      const pageCount = source.getPageCount();
      if (pageCount < 1) throw new Error("The PDF contains no pages.");
      scope.postMessage({ id, pageCount });
    } else if (action === "outline") {
      // Its own document: an outline read never disturbs an open split.
      const doc = await PDFDocument.load(data.bytes, {
        updateMetadata: false,
        ignoreEncryption: true,
      });
      const result: PdfOutlineResult = doc.isEncrypted
        ? { status: "encrypted" }
        : {
            status: "ok",
            pageCount: doc.getPageCount(),
            entries: readPdfOutline(doc),
          };
      scope.postMessage({ id, ...result });
    } else if (action === "extract") {
      if (!source) throw new Error("No PDF is open.");
      const { startPage, endPage } = data;
      if (
        !Number.isInteger(startPage) ||
        !Number.isInteger(endPage) ||
        startPage < 1 ||
        endPage < startPage ||
        endPage > source.getPageCount()
      ) {
        throw new Error("Invalid PDF page range.");
      }
      const output = await PDFDocument.create();
      const pages = await output.copyPages(
        source,
        Array.from(
          { length: endPage - startPage + 1 },
          (_, i) => startPage - 1 + i,
        ),
      );
      for (const page of pages) output.addPage(page);
      const bytes = await output.save();
      scope.postMessage({ id, bytes: bytes.buffer }, [
        bytes.buffer as ArrayBuffer,
      ]);
    } else throw new Error("Unknown PDF splitter request.");
  } catch (error) {
    // pdf-lib's ES5 build can lose the Error subclass prototype.
    const encrypted =
      error instanceof EncryptedPDFError ||
      (error instanceof Error &&
        error.message === new EncryptedPDFError().message);
    const detail = error instanceof Error ? error.message : String(error);
    scope.postMessage({
      id,
      error:
        action === "outline"
          ? `Unable to read the PDF's bookmarks: ${detail}`
          : encrypted
            ? "This PDF is encrypted. Save an unencrypted copy before parsing it with MinerU."
            : `Unable to prepare PDF for MinerU: ${detail}`,
    });
  }
};
