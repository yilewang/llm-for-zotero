import { assert } from "chai";
import {
  buildCodexNativeSkillInstructionBlock,
  buildCodexNativeSkillRequest,
  clearCodexNativeSkillClassifierCache,
  resolveExplicitCodexNativeSkillIds,
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

  it("resolves only known explicit skill IDs in the user's selection order", function () {
    setUserSkills([
      makeSkill("write-note", /write note/i, "Write-note instructions."),
      makeSkill("compare-papers", /compare/i, "Compare instructions."),
    ]);

    assert.deepEqual(
      resolveExplicitCodexNativeSkillIds([
        "missing-skill",
        "compare-papers",
        "write-note",
        "compare-papers",
      ]),
      ["compare-papers", "write-note"],
    );
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

  it("activates compare-papers for native collection-scoped comparison turns", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["compare-papers.md"])]);

    const resolved = await resolveCodexNativeSkills({
      scope: {
        conversationKey: 1,
        libraryID: 7,
        kind: "global",
      },
      userText: "compare the methods of all papers in this folder",
      model: "",
      apiBase: "",
      skillContext: {
        selectedCollectionContexts: [
          {
            collectionId: 4,
            name: "Computational_Psychiatry",
            libraryID: 7,
          },
        ],
      },
    });

    assert.deepEqual(resolved.matchedSkillIds, ["compare-papers"]);
    assert.include(
      resolved.instructionBlock,
      "A selected Zotero collection/folder is also a valid comparison corpus",
    );
  });

  it("activates evidence-based-qa for native collection-scoped evidence turns", async function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"])]);

    const resolved = await resolveCodexNativeSkills({
      scope: {
        conversationKey: 1,
        libraryID: 7,
        kind: "global",
      },
      userText: "find evidence in these papers for this claim",
      model: "",
      apiBase: "",
      skillContext: {
        selectedCollectionContexts: [
          {
            collectionId: 4,
            name: "Computational_Psychiatry",
            libraryID: 7,
          },
        ],
      },
    });

    assert.deepEqual(resolved.matchedSkillIds, ["evidence-based-qa"]);
    assert.include(
      resolved.instructionBlock,
      "For a selected collection/folder or whole-library evidence question",
    );
    assert.include(resolved.instructionBlock, "for exact presence/absence");
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
    assert.deepEqual(
      request.turnPaperScope.papers.map(({ paper, roles }) => ({
        itemId: paper.itemId,
        contextItemId: paper.contextItemId,
        title: paper.title,
        roles,
      })),
      [
        {
          itemId: 42,
          contextItemId: 99,
          title: "Native Skills Paper",
          roles: ["active"],
        },
      ],
    );
    assert.equal(request.activeNoteContext?.noteId, 55);
    assert.deepEqual(request.selectedTexts, ["Figure caption"]);
    assert.deepEqual(request.screenshots, ["data:image/png;base64,AAAA"]);
  });

  it("carries raw PDF identity into skill routing and makes its policy final", function () {
    const localDocument = {
      kind: "local_pdf" as const,
      sourceKey: "zotero-pdf:42:99" as const,
      itemId: 42,
      contextItemId: 99,
      title: "Native Skills Paper",
      name: "paper.pdf",
      mimeType: "application/pdf" as const,
      absolutePath: "/papers/paper.pdf",
    };
    const request = buildCodexNativeSkillRequest({
      scope: {
        conversationKey: 123,
        libraryID: 7,
        kind: "paper",
        paperItemID: 42,
        activeContextItemId: 99,
        paperTitle: "Native Skills Paper",
      },
      userText: "Summarize this paper.",
      model: "gpt-5.6-sol",
      apiBase: "",
      skillContext: {
        pdfPaperContexts: [
          {
            itemId: 42,
            contextItemId: 99,
            title: "Native Skills Paper",
            contentSourceMode: "pdf",
          },
        ],
        localDocuments: [localDocument],
      },
    });
    const block = buildCodexNativeSkillInstructionBlock(
      ["simple-paper-qa"],
      [makeSkill("simple-paper-qa", /summarize/i, "Call paper_read overview.")],
      { rawPdfMode: true },
    );

    assert.deepEqual(
      request.turnPaperScope.papers
        .filter((entry) => entry.roles.includes("raw_pdf"))
        .map(({ paper }) => [paper.itemId, paper.contextItemId]),
      [[42, 99]],
    );
    assert.deepEqual(request.localDocuments, [
      { paperKey: "7:42:99", resource: localDocument },
    ]);
    assert.include(block, "Call paper_read overview.");
    assert.include(block, "overrides conflicting paper-reading routes");
    assert.notInclude(
      block,
      "overrides ordinary paper-reading and skill guidance",
    );
    assert.match(
      block,
      /Raw PDF transport policy[\s\S]*Do not use `paper_read`[\s\S]*$/,
    );
  });

  it("omits the skill block when matched IDs do not resolve to loaded skills", function () {
    assert.equal(
      buildCodexNativeSkillInstructionBlock(["missing-skill"], []),
      "",
    );
  });

  it("flags user customizations after the managed block in the instruction block", function () {
    const managedBegin = "<!-- LLM-FOR-ZOTERO:MANAGED-BEGIN -->";
    const managedEnd = "<!-- LLM-FOR-ZOTERO:MANAGED-END -->";
    const customized = makeSkill(
      "write-note",
      /note/i,
      [
        managedBegin,
        "Default filename pattern: default-pattern.md",
        managedEnd,
        "",
        "## Your customizations",
        "",
        "Path pattern: `{papertitle}/{papertitle}.md`",
      ].join("\n"),
    );
    const plain = makeSkill(
      "simple-paper-qa",
      /summarize/i,
      [managedBegin, "Managed-only instructions.", managedEnd].join("\n"),
    );

    const block = buildCodexNativeSkillInstructionBlock(
      ["write-note", "simple-paper-qa"],
      [customized, plain],
    );

    const customizedSection = block.slice(
      block.indexOf("Skill: write-note"),
      block.indexOf("Skill: simple-paper-qa"),
    );
    const plainSection = block.slice(block.indexOf("Skill: simple-paper-qa"));
    assert.include(customizedSection, "USER CUSTOMIZATIONS");
    assert.include(customizedSection, "OVERRIDE any conflicting defaults");
    assert.notInclude(plainSection, "USER CUSTOMIZATIONS");
  });
});
