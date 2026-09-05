import { assert } from "chai";
import {
  extractManagedBlock,
  spliceManagedBlock,
  hashSkillForUpgrade,
  hashBody,
  getSkillCustomizationNotice,
} from "../src/agent/skills/managedBlock";

const BEGIN = "<!-- LLM-FOR-ZOTERO:MANAGED-BEGIN -->";
const END = "<!-- LLM-FOR-ZOTERO:MANAGED-END -->";

describe("extractManagedBlock", function () {
  it("returns the block and surrounding content when markers are present", function () {
    const raw = `---\nid: foo\n---\n\nIntro text.\n${BEGIN}\nmanaged content\n${END}\n\nTrailing user section.\n`;
    const { block, before, after } = extractManagedBlock(raw);
    assert.isNotNull(block);
    assert.equal(block, "\nmanaged content\n");
    assert.include(before, "Intro text.");
    assert.include(after, "Trailing user section.");
  });

  it("returns null block when markers are missing", function () {
    const raw = "---\nid: foo\n---\n\nJust some content with no markers.\n";
    const { block, before, after } = extractManagedBlock(raw);
    assert.isNull(block);
    assert.equal(before, raw);
    assert.equal(after, "");
  });

  it("returns null block when end marker precedes begin marker", function () {
    const raw = `${END}\nweird\n${BEGIN}\n`;
    const { block } = extractManagedBlock(raw);
    assert.isNull(block);
  });

  it("returns null block when only the begin marker is present", function () {
    const raw = `Intro.\n${BEGIN}\nmissing end\n`;
    const { block } = extractManagedBlock(raw);
    assert.isNull(block);
  });
});

describe("spliceManagedBlock", function () {
  it("replaces the managed block while preserving content outside markers", function () {
    const onDisk = `Header stays.\n${BEGIN}\nold managed\n${END}\nFooter stays.\n`;
    const result = spliceManagedBlock(onDisk, "\nnew managed content\n");
    assert.isNotNull(result);
    assert.include(result as string, "Header stays.");
    assert.include(result as string, "Footer stays.");
    assert.include(result as string, "new managed content");
    assert.notInclude(result as string, "old managed");
  });

  it("returns null when the on-disk file has no markers", function () {
    const onDisk = "No markers here.\n";
    assert.isNull(spliceManagedBlock(onDisk, "new block"));
  });

  it("preserves user customizations appended after the managed block", function () {
    const onDisk = `${BEGIN}\noriginal\n${END}\n\n## Your customizations\n\nMy overrides.\n`;
    const result = spliceManagedBlock(onDisk, "\nnew\n");
    assert.isNotNull(result);
    assert.include(result as string, "## Your customizations");
    assert.include(result as string, "My overrides.");
    assert.include(result as string, "new");
    assert.notInclude(result as string, "original");
  });

  it("is idempotent when re-applying the same block", function () {
    const onDisk = `Pre.\n${BEGIN}\nA\n${END}\nPost.\n`;
    const once = spliceManagedBlock(onDisk, "\nB\n") as string;
    const twice = spliceManagedBlock(once, "\nB\n") as string;
    assert.equal(once, twice);
  });
});

describe("hashSkillForUpgrade", function () {
  it("hashes only the managed block when markers are present", function () {
    const a = `USER CONTENT A\n${BEGIN}\nmanaged\n${END}\nUSER TAIL A\n`;
    const b = `USER CONTENT B — different\n${BEGIN}\nmanaged\n${END}\nUSER TAIL B\n`;
    // Same managed block → same hash even though outside content differs.
    assert.equal(
      hashSkillForUpgrade(a, "fallback"),
      hashSkillForUpgrade(b, "fallback"),
    );
  });

  it("falls back to whole-body hash when markers are missing", function () {
    const a = "no markers here\n";
    const b = "no markers here — but different\n";
    assert.notEqual(
      hashSkillForUpgrade(a, "fallback-a"),
      hashSkillForUpgrade(b, "fallback-b"),
    );
    // Same input + same fallback → same hash.
    assert.equal(
      hashSkillForUpgrade(a, "fallback-a"),
      hashSkillForUpgrade(a, "fallback-a"),
    );
  });
});

describe("getSkillCustomizationNotice", function () {
  it("returns the banner when user content follows the managed block", function () {
    const instruction = `Intro.\n${BEGIN}\nmanaged defaults\n${END}\n\n## Your customizations\n\nFilename pattern: \`{citekey}.md\`\n`;
    const notice = getSkillCustomizationNotice(instruction);
    assert.isString(notice);
    assert.include(notice || "", "USER CUSTOMIZATIONS");
    assert.include(notice || "", "OVERRIDE");
  });

  it("returns null when nothing follows the managed block", function () {
    const instruction = `Intro.\n${BEGIN}\nmanaged defaults\n${END}`;
    assert.isNull(getSkillCustomizationNotice(instruction));
  });

  it("returns null when only whitespace follows the managed block", function () {
    const instruction = `Intro.\n${BEGIN}\nmanaged defaults\n${END}\n\n   \n`;
    assert.isNull(getSkillCustomizationNotice(instruction));
  });

  it("returns null when the instruction has no managed markers", function () {
    assert.isNull(
      getSkillCustomizationNotice("A fully user-authored skill body."),
    );
  });
});

// Algorithm-stability lock: djb2 output must stay bit-identical, because the
// OBSOLETE_SKILL_FILES.bootstrapRawHashes in userSkills.ts store historical
// hashes computed against prior shipped raw content. If this test fails, the
// hash algorithm has drifted and every stored hash is wrong.
describe("hashBody stability", function () {
  it("produces a fixed djb2 hash for a known string", function () {
    assert.equal(hashBody(""), "45h");
    assert.equal(hashBody("a"), "3t3a");
    assert.equal(hashBody("hello world\n"), "1q0wj57");
  });
});
