/**
 * The library-analysis skill describes what library results show the model:
 * a result sized to the request, its paper ledger and passages, and a handle
 * for everything it left out. It names no field the views omit.
 */
import { assert } from "chai";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";
import { LIBRARY_ANALYSIS_PAGING_GUIDANCE } from "../src/agent/tools/read/contextRead";

describe("library-analysis skill", function () {
  const raw = BUILTIN_SKILL_FILES["library-analysis.md"];
  const skill = parseSkill(raw);

  it("reads library_retrieve's paperMatches as the ledger and its snippets as the body evidence", function () {
    assert.include(skill.instruction, "`paperMatches` as the paper ledger");
    assert.include(skill.instruction, "snippets as the body evidence");
  });

  it("pages what a sized result left out with context_read, and names no field the views omit", function () {
    assert.include(skill.instruction, "`omitted`");
    // MCP hides context_read, so its paging step lives in context_read's
    // guidance for this skill, not in the body (#541).
    assert.notInclude(raw, "context_read");
    assert.include(LIBRARY_ANALYSIS_PAGING_GUIDANCE.instruction, "`omitted`");
    assert.include(
      LIBRARY_ANALYSIS_PAGING_GUIDANCE.instruction,
      "`context_read` with its `toolResultHandle` pages the rest",
    );
    assert.notMatch(
      raw,
      /synthesis digest|evidenceLedgerText|surroundingText/i,
    );
  });

  it("ships as version 6", function () {
    assert.equal(skill.version, 6);
  });
});
