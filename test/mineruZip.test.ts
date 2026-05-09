import { assert } from "chai";
import { strToU8, zipSync } from "fflate";
import {
  describeMineruZipInspectionFailure,
  inspectMineruZipBytes,
} from "../src/utils/mineruZip";

describe("mineruZip", function () {
  it("extracts a stored ZIP containing full.md", function () {
    const zipBytes = zipSync({
      "full.md": [strToU8("# Title\nbody"), { level: 0 }],
    });

    const result = inspectMineruZipBytes(zipBytes);
    assert.isTrue(result.ok);
    if (!result.ok) {
      throw new Error("Expected ZIP inspection to succeed");
    }

    assert.equal(result.mdContent, "# Title\nbody");
    assert.lengthOf(result.files, 1);
    assert.equal(result.files[0].relativePath, "full.md");
  });

  it("extracts a deflated ZIP with multiple entries", function () {
    const zipBytes = zipSync({
      "full.md": strToU8("compressed markdown"),
      "images/fig1.png": new Uint8Array([1, 2, 3, 4]),
    });

    const result = inspectMineruZipBytes(zipBytes);
    assert.isTrue(result.ok);
    if (!result.ok) {
      throw new Error("Expected deflated ZIP inspection to succeed");
    }

    assert.equal(result.mdContent, "compressed markdown");
    assert.sameMembers(
      result.files.map((file) => file.relativePath),
      ["full.md", "images/fig1.png"],
    );
  });

  it("extracts nested files and prefers full.md as the Markdown payload", function () {
    const zipBytes = zipSync({
      "summary.md": strToU8("fallback"),
      "nested/full.md": strToU8("preferred markdown"),
      "images/figure-1.png": new Uint8Array([9, 8, 7]),
      "content_list.json": strToU8('{"ok":true}'),
    });

    const result = inspectMineruZipBytes(zipBytes);
    assert.isTrue(result.ok);
    if (!result.ok) {
      throw new Error("Expected nested ZIP inspection to succeed");
    }

    assert.equal(result.mdContent, "preferred markdown");
    assert.includeMembers(result.entryNames, [
      "summary.md",
      "nested/full.md",
      "images/figure-1.png",
      "content_list.json",
    ]);
  });

  it("reports a non-ZIP payload explicitly", function () {
    const result = inspectMineruZipBytes(strToU8("<html>not a zip</html>"));
    assert.isFalse(result.ok);
    if (result.ok) {
      throw new Error("Expected ZIP inspection to fail");
    }

    assert.equal(result.reason, "not_zip");
    assert.equal(
      describeMineruZipInspectionFailure(result),
      "Downloaded result is not a ZIP archive",
    );
  });

  it("reports empty Markdown as a failure", function () {
    const zipBytes = zipSync({
      "full.md": strToU8(""),
      "images/figure-1.png": new Uint8Array([1, 2, 3]),
    });

    const result = inspectMineruZipBytes(zipBytes);
    assert.isFalse(result.ok);
    if (result.ok) {
      throw new Error("Expected ZIP inspection to fail for empty markdown");
    }

    assert.equal(result.reason, "md_empty");
    assert.match(describeMineruZipInspectionFailure(result), /empty/i);
  });

  it("reports whitespace-only Markdown as a failure", function () {
    const zipBytes = zipSync({
      "full.md": strToU8("   \n  \n  "),
    });

    const result = inspectMineruZipBytes(zipBytes);
    assert.isFalse(result.ok);
    if (result.ok) {
      throw new Error(
        "Expected ZIP inspection to fail for whitespace-only markdown",
      );
    }

    assert.equal(result.reason, "md_empty");
  });

  it("reports ZIPs that do not contain Markdown", function () {
    const zipBytes = zipSync({
      "images/figure-1.png": new Uint8Array([1, 2, 3]),
      "content_list.json": strToU8('{"images":1}'),
    });

    const result = inspectMineruZipBytes(zipBytes);
    assert.isFalse(result.ok);
    if (result.ok) {
      throw new Error("Expected ZIP inspection to fail");
    }

    assert.equal(result.reason, "md_missing");
    assert.equal(
      describeMineruZipInspectionFailure(result),
      "ZIP extracted, but no Markdown file was found",
    );
  });

  it("maps archive corruption to a different message than non-ZIP payloads", function () {
    const validZip = zipSync({
      "full.md": strToU8("hello"),
    });
    const truncatedZip = validZip.subarray(0, validZip.length - 12);

    const nonZip = inspectMineruZipBytes(strToU8("access denied"));
    const corrupt = inspectMineruZipBytes(truncatedZip);

    assert.isFalse(nonZip.ok);
    assert.isFalse(corrupt.ok);
    if (nonZip.ok || corrupt.ok) {
      throw new Error("Expected both ZIP inspections to fail");
    }

    assert.equal(corrupt.reason, "zip_extract_failed");
    assert.notEqual(
      describeMineruZipInspectionFailure(nonZip),
      describeMineruZipInspectionFailure(corrupt),
    );
    assert.match(
      describeMineruZipInspectionFailure(corrupt),
      /^Failed to extract ZIP entries/,
    );
  });
});
