import { assert } from "chai";
import { readAttachmentFilename } from "../src/utils/attachmentFilename";

describe("readAttachmentFilename", function () {
  it("preserves a working getter, including literal backslashes and case", function () {
    assert.equal(
      readAttachmentFilename({
        attachmentFilename: "Notes\\Draft.PDF",
        get attachmentPath() {
          throw new Error("The fallback should not be read");
        },
      }),
      "Notes\\Draft.PDF",
    );
  });

  const paths = [
    ["F:\\legacy\\papers\\论文.PDF", "论文.PDF"],
    ["C:/legacy/paper.pdf", "paper.pdf"],
    ["\\\\server\\share\\paper.pdf", "paper.pdf"],
    ["/home/researcher/paper.pdf", "paper.pdf"],
    ["storage:paper.pdf", "paper.pdf"],
    ["attachments:papers/paper.pdf", "paper.pdf"],
    ["attachments:papers\\paper.pdf", "paper.pdf"],
    ["legacy/paper.pdf", "paper.pdf"],
    ["paper.pdf", "paper.pdf"],
    ["storage:", ""],
    ["F:\\legacy\\", ""],
  ];

  for (const [path, filename] of paths) {
    it(`recovers filename metadata from ${JSON.stringify(path)} when the getter throws`, function () {
      assert.equal(
        readAttachmentFilename({
          get attachmentFilename() {
            throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH");
          },
          attachmentPath: path,
        }),
        filename,
      );
    });
  }

  it("uses path metadata when a filename is absent or empty", function () {
    assert.equal(
      readAttachmentFilename({ attachmentPath: "storage:paper.pdf" }),
      "paper.pdf",
    );
    assert.equal(
      readAttachmentFilename({
        attachmentFilename: "",
        attachmentPath: "storage:paper.pdf",
      }),
      "paper.pdf",
    );
  });

  it("returns no filename for missing or unreadable metadata", function () {
    for (const item of [
      null,
      undefined,
      {},
      { attachmentFilename: 42, attachmentPath: 42 },
    ]) {
      assert.equal(readAttachmentFilename(item), "");
    }
    assert.equal(
      readAttachmentFilename({
        get attachmentFilename() {
          throw new Error("unavailable");
        },
        get attachmentPath() {
          throw new Error("unavailable");
        },
      }),
      "",
    );
  });
});
