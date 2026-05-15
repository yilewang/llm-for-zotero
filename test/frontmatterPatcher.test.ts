import { assert } from "chai";
import { patchSkillFrontmatter } from "../src/agent/skills/frontmatterPatcher";

describe("patchSkillFrontmatter", function () {
  it("preserves unknown frontmatter keys added by the user", function () {
    const onDisk = [
      "---",
      "id: foo",
      "description: old description",
      "version: 1",
      "match: /custom user regex/i",
      "tags: [a, b]",
      "priority: high",
      "---",
      "",
      "Body content.",
      "",
    ].join("\n");
    const shipped = [
      "---",
      "id: foo",
      "description: new shipped description",
      "version: 2",
      "match: /shipped regex/i",
      "---",
      "",
      "Shipped body.",
      "",
    ].join("\n");

    const result = patchSkillFrontmatter(onDisk, shipped);
    assert.isNotNull(result);
    const patched = result as string;
    assert.include(patched, "tags: [a, b]");
    assert.include(patched, "priority: high");
    assert.include(patched, "match: /custom user regex/i");
    assert.notInclude(patched, "match: /shipped regex/i");
    assert.include(patched, "description: new shipped description");
    assert.include(patched, "version: 2");
    assert.notInclude(patched, "description: old description");
    assert.notInclude(patched, "version: 1\n");
    assert.include(patched, "Body content.");
  });

  it("leaves the instruction body untouched", function () {
    const onDisk = [
      "---",
      "id: foo",
      "version: 1",
      "description: old",
      "---",
      "",
      "User customized body.",
      "Second line.",
      "",
    ].join("\n");
    const shipped = [
      "---",
      "id: foo",
      "version: 2",
      "description: new",
      "---",
      "Different body.",
    ].join("\n");

    const patched = patchSkillFrontmatter(onDisk, shipped) as string;
    assert.include(patched, "User customized body.");
    assert.include(patched, "Second line.");
    assert.notInclude(patched, "Different body.");
  });

  it("returns null when on-disk version is already current or newer", function () {
    const onDisk = "---\nid: foo\nversion: 3\ndescription: x\n---\nbody";
    const shipped = "---\nid: foo\nversion: 2\ndescription: y\n---\nbody";
    assert.isNull(patchSkillFrontmatter(onDisk, shipped));
  });

  it("returns null when the file has no frontmatter block", function () {
    const onDisk = "Just body, no markers at all.\n";
    const shipped = "---\nid: foo\nversion: 2\ndescription: y\n---\nbody";
    assert.isNull(patchSkillFrontmatter(onDisk, shipped));
  });

  it("inserts description and version when missing on disk", function () {
    const onDisk = [
      "---",
      "id: foo",
      "match: /user pattern/",
      "---",
      "body",
    ].join("\n");
    const shipped = [
      "---",
      "id: foo",
      "description: new",
      "version: 2",
      "---",
      "shipped body",
    ].join("\n");

    const patched = patchSkillFrontmatter(onDisk, shipped) as string;
    assert.include(patched, "description: new");
    assert.include(patched, "version: 2");
    assert.include(patched, "match: /user pattern/");
    assert.include(patched, "body");
  });

  it("preserves user-customized match: patterns over shipped patterns", function () {
    const onDisk = [
      "---",
      "id: foo",
      "version: 1",
      "description: x",
      "match: /only user pattern/i",
      "---",
      "body",
    ].join("\n");
    const shipped = [
      "---",
      "id: foo",
      "version: 2",
      "description: x",
      "match: /shipped pattern A/i",
      "match: /shipped pattern B/i",
      "---",
      "body",
    ].join("\n");

    const patched = patchSkillFrontmatter(onDisk, shipped) as string;
    assert.include(patched, "match: /only user pattern/i");
    assert.notInclude(patched, "match: /shipped pattern A/i");
    assert.notInclude(patched, "match: /shipped pattern B/i");
  });

  it("adds missing shipped contexts without replacing user-defined contexts", function () {
    const onDisk = [
      "---",
      "id: foo",
      "version: 1",
      "description: old",
      "match: /user pattern/i",
      "---",
      "body",
    ].join("\n");
    const shipped = [
      "---",
      "id: foo",
      "version: 2",
      "description: new",
      "contexts: single-paper",
      "activation: auto",
      "match: /shipped pattern/i",
      "---",
      "body",
    ].join("\n");

    const patched = patchSkillFrontmatter(onDisk, shipped) as string;
    assert.include(patched, "contexts: single-paper");
    assert.include(patched, "match: /user pattern/i");

    const customContexts = onDisk.replace(
      "match: /user pattern/i",
      "contexts: paper-set\nmatch: /user pattern/i",
    );
    const customPatched = patchSkillFrontmatter(
      customContexts,
      shipped,
    ) as string;
    assert.include(customPatched, "contexts: paper-set");
    assert.notInclude(customPatched, "contexts: single-paper");
  });
});
