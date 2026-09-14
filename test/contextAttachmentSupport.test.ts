import { assert } from "chai";
import { describe, it } from "mocha";

import {
  isPdfContextAttachment,
  isSupportedContextAttachment,
  resolveContextAttachmentSupport,
  resolveContextAttachmentSupportFromMetadata,
} from "../src/modules/contextPanel/contextAttachmentSupport";

function attachment(input: {
  contentType?: string;
  filename?: string;
}): Zotero.Item {
  return {
    isAttachment: () => true,
    attachmentContentType: input.contentType || "",
    attachmentFilename: input.filename || "",
  } as unknown as Zotero.Item;
}

describe("contextAttachmentSupport", function () {
  it("classifies legacy linked attachments even when Zotero rejects their path", function () {
    for (const [filename, kind] of [
      ["paper.PDF", "pdf"],
      ["notes.MD", "text"],
    ]) {
      const item = attachment({ contentType: "application/octet-stream" });
      Object.defineProperties(item, {
        attachmentFilename: {
          get() {
            throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH");
          },
        },
        attachmentPath: { value: `F:\\legacy\\${filename}` },
      });
      assert.equal(resolveContextAttachmentSupport(item)?.kind, kind);
    }
  });

  it("still recognizes a PDF by MIME when both filename and path are unavailable", function () {
    const item = attachment({ contentType: "application/pdf" });
    Object.defineProperties(item, {
      attachmentFilename: {
        get() {
          throw new Error("unavailable");
        },
      },
      attachmentPath: {
        get() {
          throw new Error("unavailable");
        },
      },
    });
    assert.isTrue(isPdfContextAttachment(item));
  });

  it("recognizes PDFs by MIME type and extension", function () {
    assert.deepEqual(
      resolveContextAttachmentSupportFromMetadata({
        contentType: " application/pdf ",
        filename: "ignored.bin",
      }),
      {
        kind: "pdf",
        attachmentType: "pdf",
        readableVia: "paper_read",
      },
    );
    assert.deepEqual(
      resolveContextAttachmentSupportFromMetadata({
        contentType: "application/octet-stream",
        filename: "Supplement.PDF",
      }),
      {
        kind: "pdf",
        attachmentType: "pdf",
        readableVia: "paper_read",
      },
    );
  });

  it("recognizes text-like attachments by MIME type and extension", function () {
    const cases = [
      ["text/markdown", "source.bin", "markdown"],
      ["application/octet-stream", "notes.MD", "markdown"],
      ["text/html", "source.bin", "html"],
      ["application/xhtml+xml", "source.bin", "html"],
      ["application/octet-stream", "snapshot.HTML", "html"],
      ["text/plain", "source.bin", "txt"],
      ["application/octet-stream", "ocr.TXT", "txt"],
      [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "source.bin",
        "docx",
      ],
      ["application/octet-stream", "notes.DOCX", "docx"],
    ] as const;

    for (const [contentType, filename, mode] of cases) {
      assert.deepEqual(
        resolveContextAttachmentSupportFromMetadata({
          contentType,
          filename,
        }),
        {
          kind: "text",
          attachmentType: mode,
          contentSourceMode: mode,
          readableVia: "read_attachment",
        },
      );
    }
  });

  it("normalizes mixed case and whitespace metadata", function () {
    assert.deepEqual(
      resolveContextAttachmentSupportFromMetadata({
        contentType: " TEXT/X-MARKDOWN ",
        filename: " ignored.bin ",
      }),
      {
        kind: "text",
        attachmentType: "markdown",
        contentSourceMode: "markdown",
        readableVia: "read_attachment",
      },
    );
  });

  it("returns null for unsupported binary attachments", function () {
    assert.isNull(
      resolveContextAttachmentSupportFromMetadata({
        contentType: "application/zip",
        filename: "archive.zip",
      }),
    );
  });

  it("classifies Zotero item attachments through the same contract", function () {
    const pdf = attachment({
      contentType: "application/octet-stream",
      filename: "paper.pdf",
    });
    const markdown = attachment({
      contentType: "application/octet-stream",
      filename: "full.md",
    });
    const binary = attachment({
      contentType: "application/zip",
      filename: "archive.zip",
    });

    assert.isTrue(isSupportedContextAttachment(pdf));
    assert.isTrue(isPdfContextAttachment(pdf));
    assert.deepEqual(resolveContextAttachmentSupport(markdown), {
      kind: "text",
      attachmentType: "markdown",
      contentSourceMode: "markdown",
      readableVia: "read_attachment",
    });
    assert.isNull(resolveContextAttachmentSupport(binary));
  });
});
