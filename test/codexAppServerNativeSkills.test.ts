import { assert } from "chai";
import {
  buildCodexNativeSkillInstructionBlock,
  buildCodexNativeSkillRequest,
  clearCodexNativeSkillClassifierCache,
  resolveCodexNativeSkills,
} from "../src/codexAppServer/nativeSkills";
import {
  BUILTIN_SKILL_FILES,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";
import type { AgentSkill } from "../src/agent/skills/skillLoader";

function makeSkill(
  id: string,
  pattern: RegExp,
  instruction: string,
): AgentSkill {
  return {
    id,
    description: `${id} description`,
    version: 1,
    patterns: [pattern],
    contexts: ["any"],
    activation: "auto",
    instruction,
    source: "system",
  };
}

describe("Codex native skills", function () {
  afterEach(function () {
    setUserSkills([]);
    clearCodexNativeSkillClassifierCache();
  });

  it("includes forced skill IDs even when classifier returns no match", async function () {
    setUserSkills([
      makeSkill("write-note", /write note/i, "Write-note instructions."),
      makeSkill("compare-papers", /compare/i, "Compare instructions."),
    ]);

    let classifierCalls = 0;
    const resolved = await resolveCodexNativeSkills({
      scope: {
        conversationKey: 1,
        libraryID: 7,
        kind: "global",
      },
      userText: "Tag this paper.",
      model: "gpt-5.4",
      apiBase: "",
      skillContext: { forcedSkillIds: ["write-note"] },
      detectSkillIntentImpl: async () => {
        classifierCalls += 1;
        return [];
      },
    });

    assert.deepEqual(resolved.matchedSkillIds, ["write-note"]);
    assert.equal(classifierCalls, 0);
    assert.include(resolved.instructionBlock, "Skill: write-note");
    assert.include(resolved.instructionBlock, "Write-note instructions.");
  });

  it("uses deterministic regex matching without a classifier call", async function () {
    setUserSkills([
      makeSkill("write-note", /note/i, "Write-note instructions."),
      makeSkill("compare-papers", /compare/i, "Compare instructions."),
    ]);

    let classifierCalls = 0;
    const resolved = await resolveCodexNativeSkills({
      scope: {
        conversationKey: 1,
        libraryID: 7,
        kind: "global",
      },
      userText: "Please compare these papers.",
      model: "",
      apiBase: "",
      detectSkillIntentImpl: async () => {
        classifierCalls += 1;
        return ["write-note"];
      },
    });

    assert.deepEqual(resolved.matchedSkillIds, ["compare-papers"]);
    assert.equal(classifierCalls, 0);
    assert.include(resolved.instructionBlock, "Skill: compare-papers");
    assert.notInclude(resolved.instructionBlock, "Skill: write-note");
  });

  it("uses cached classifier fallback for ambiguous multilingual skill turns", async function () {
    setUserSkills([
      makeSkill("write-note", /write note/i, "Write-note instructions."),
    ]);
    let classifierCalls = 0;
    const params = {
      scope: {
        conversationKey: 1,
        libraryID: 7,
        kind: "global" as const,
        activeNoteId: 42,
        activeNoteTitle: "Draft",
      },
      userText: "帮我整理一下",
      model: "gpt-5.4",
      apiBase: "",
      detectSkillIntentImpl: async () => {
        classifierCalls += 1;
        return ["write-note"];
      },
    };

    const first = await resolveCodexNativeSkills(params);
    const second = await resolveCodexNativeSkills(params);

    assert.deepEqual(first.matchedSkillIds, ["write-note"]);
    assert.deepEqual(second.matchedSkillIds, ["write-note"]);
    assert.equal(classifierCalls, 1);
    assert.equal(second.resolutionSource, "cache");
  });

  it("returns no instruction block when no skills are loaded", async function () {
    setUserSkills([]);

    const resolved = await resolveCodexNativeSkills({
      scope: {
        conversationKey: 1,
        libraryID: 7,
        kind: "global",
      },
      userText: "Summarize my library.",
      model: "gpt-5.4",
      apiBase: "",
    });

    assert.deepEqual(resolved.matchedSkillIds, []);
    assert.equal(resolved.instructionBlock, "");
  });

  it("uses the same context-count eligibility for native paper and library turns", async function () {
    setUserSkills([
      parseSkill(BUILTIN_SKILL_FILES["simple-paper-qa.md"]),
      parseSkill(BUILTIN_SKILL_FILES["library-analysis.md"]),
    ]);

    const paperTurn = await resolveCodexNativeSkills({
      scope: {
        conversationKey: 1,
        libraryID: 7,
        kind: "paper",
        paperItemID: 42,
        activeContextItemId: 99,
        paperTitle: "Paper",
      },
      userText: "summarize this paper",
      model: "",
      apiBase: "",
    });
    assert.deepEqual(paperTurn.matchedSkillIds, ["simple-paper-qa"]);

    const libraryTurn = await resolveCodexNativeSkills({
      scope: {
        conversationKey: 1,
        libraryID: 7,
        kind: "global",
      },
      userText: "summarize my library",
      model: "",
      apiBase: "",
    });
    assert.deepEqual(libraryTurn.matchedSkillIds, ["library-analysis"]);
  });

  it("builds native request context from scope and UI context", function () {
    const request = buildCodexNativeSkillRequest({
      scope: {
        conversationKey: 123,
        libraryID: 7,
        kind: "paper",
        paperItemID: 42,
        activeContextItemId: 99,
        paperTitle: "Native Skills Paper",
        activeNoteId: 55,
        activeNoteKind: "item",
        activeNoteTitle: "Draft note",
      },
      userText: "Analyze figure 1.",
      model: "gpt-5.4",
      apiBase: "",
      skillContext: {
        selectedTexts: ["Figure caption"],
        screenshots: ["data:image/png;base64,AAAA"],
      },
    });

    assert.equal(request.authMode, "codex_app_server");
    assert.equal(request.providerProtocol, "codex_responses");
    assert.equal(request.activeItemId, 42);
    assert.deepEqual(request.selectedPaperContexts, [
      {
        itemId: 42,
        contextItemId: 99,
        title: "Native Skills Paper",
      },
    ]);
    assert.equal(request.activeNoteContext?.noteId, 55);
    assert.deepEqual(request.selectedTexts, ["Figure caption"]);
    assert.deepEqual(request.screenshots, ["data:image/png;base64,AAAA"]);
  });

  it("omits the skill block when matched IDs do not resolve to loaded skills", function () {
    assert.equal(
      buildCodexNativeSkillInstructionBlock(["missing-skill"], []),
      "",
    );
  });
});
