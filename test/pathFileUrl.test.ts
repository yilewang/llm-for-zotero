import { assert } from "chai";
import {
  fileUrlToPath,
  pathToFileUrl,
  toFileUrl,
} from "../src/utils/pathFileUrl";

describe("pathFileUrl", function () {
  it("should convert POSIX path to file URL", function () {
    assert.equal(toFileUrl("/tmp/my file.md"), "file:///tmp/my%20file.md");
  });

  it("should convert Windows path to file URL", function () {
    assert.equal(
      toFileUrl("C:\\Users\\alice\\doc.txt"),
      "file:///C:/Users/alice/doc.txt",
    );
  });

  it("should return file URL unchanged", function () {
    assert.equal(toFileUrl("file:///tmp/demo.txt"), "file:///tmp/demo.txt");
  });

  it("should parse file URL back to path", function () {
    assert.equal(fileUrlToPath("file:///tmp/a%20b.txt"), "/tmp/a b.txt");
  });

  it("should encode reserved filename characters in POSIX file URLs", function () {
    assert.equal(toFileUrl("/tmp/a#b.txt"), "file:///tmp/a%23b.txt");
    assert.equal(toFileUrl("/tmp/a?b.txt"), "file:///tmp/a%3Fb.txt");
    assert.equal(fileUrlToPath("file:///tmp/a%23b.txt"), "/tmp/a#b.txt");
    assert.equal(fileUrlToPath("file:///tmp/a%3Fb.txt"), "/tmp/a?b.txt");
  });

  it("should parse Windows file URL back to native path", function () {
    assert.equal(
      fileUrlToPath("file:///C:/Users/alice/doc.txt"),
      "C:\\Users\\alice\\doc.txt",
    );
  });

  it("should round-trip UNC paths", function () {
    assert.equal(
      toFileUrl("\\\\server\\share\\folder\\doc.txt"),
      "file://server/share/folder/doc.txt",
    );
    assert.equal(
      fileUrlToPath("file://server/share/folder/doc.txt"),
      "\\\\server\\share\\folder\\doc.txt",
    );
  });

  it("should parse previously malformed UNC file URLs defensively", function () {
    assert.equal(
      fileUrlToPath("file:////server/share/folder/doc.txt"),
      "\\\\server\\share\\folder\\doc.txt",
    );
  });

  it("should reject relative paths", function () {
    assert.isUndefined(toFileUrl("notes/demo.txt"));
  });

  it("pathToFileUrl should alias toFileUrl", function () {
    assert.equal(pathToFileUrl("/tmp/x"), toFileUrl("/tmp/x"));
  });
});
