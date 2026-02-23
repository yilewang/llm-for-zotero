import { assert } from "chai";
import {
  fileUrlToPath,
  pathToFileUrl,
  toFileUrl,
} from "../src/utils/pathFileUrl";

describe("pathFileUrl", function () {
  it("should convert POSIX path to file URL", function () {
    assert.equal(
      toFileUrl("/tmp/my file.md"),
      "file:///tmp/my%20file.md",
    );
  });

  it("should convert Windows path to file URL", function () {
    assert.equal(
      toFileUrl("C:\\Users\\alice\\doc.txt"),
      "file:///C:/Users/alice/doc.txt",
    );
  });

  it("should return file URL unchanged", function () {
    assert.equal(
      toFileUrl("file:///tmp/demo.txt"),
      "file:///tmp/demo.txt",
    );
  });

  it("should parse file URL back to path", function () {
    assert.equal(fileUrlToPath("file:///tmp/a%20b.txt"), "/tmp/a b.txt");
  });

  it("pathToFileUrl should alias toFileUrl", function () {
    assert.equal(pathToFileUrl("/tmp/x"), toFileUrl("/tmp/x"));
  });
});
