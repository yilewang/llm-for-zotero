import { assert } from "chai";
import {
  BUILTIN_SKILL_FILES,
  getMatchedSkillIds,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";
import type {
  CollectionContextRef,
  PaperContextRef,
} from "../src/shared/types";

const paperA: PaperContextRef = {
  itemId: 10,
  contextItemId: 100,
  title: "Paper A",
};
const paperB: PaperContextRef = {
  itemId: 11,
  contextItemId: 101,
  title: "Paper B",
};
const collection: CollectionContextRef = {
  collectionId: 5,
  libraryID: 1,
  name: "Collection",
};

function loadBuiltInSkills(): void {
  setUserSkills(
    Object.values(BUILTIN_SKILL_FILES).map((raw) => parseSkill(raw)),
  );
}

describe("skill context eligibility", function () {
  afterEach(function () {
    setUserSkills([]);
  });

  it("activates simple-paper-qa only when exactly one paper is in context", function () {
    loadBuiltInSkills();

    assert.include(
      getMatchedSkillIds({
        userText: "summarize this paper",
        selectedPaperContexts: [paperA],
      }),
      "simple-paper-qa",
    );
    assert.notInclude(
      getMatchedSkillIds({ userText: "summarize my library" }),
      "simple-paper-qa",
    );
    assert.notInclude(
      getMatchedSkillIds({
        userText: "summarize these papers",
        selectedPaperContexts: [paperA, paperB],
      }),
      "simple-paper-qa",
    );
  });

  it("uses user wording to resolve one-paper plus collection context", function () {
    loadBuiltInSkills();

    const paperTargeted = getMatchedSkillIds({
      userText: "summarize this paper",
      selectedPaperContexts: [paperA],
      selectedCollectionContexts: [collection],
    });
    assert.include(paperTargeted, "simple-paper-qa");

    const collectionTargeted = getMatchedSkillIds({
      userText: "summarize this collection",
      selectedPaperContexts: [paperA],
      selectedCollectionContexts: [collection],
    });
    assert.include(collectionTargeted, "library-analysis");
    assert.notInclude(collectionTargeted, "simple-paper-qa");
  });

  it("routes paper sets and library corpora to their matching skills", function () {
    loadBuiltInSkills();

    assert.include(
      getMatchedSkillIds({
        userText: "compare these papers",
        selectedPaperContexts: [paperA, paperB],
      }),
      "compare-papers",
    );
    assert.include(
      getMatchedSkillIds({
        userText: "write a literature review",
        selectedPaperContexts: [paperA, paperB],
      }),
      "literature-review",
    );
    assert.include(
      getMatchedSkillIds({
        userText: "conduct a literature review on drift",
        selectedCollectionContexts: [collection],
      }),
      "literature-review",
    );
    assert.include(
      getMatchedSkillIds({
        userText: "give me statistics",
        selectedCollectionContexts: [collection],
      }),
      "library-analysis",
    );
  });

  it("keeps custom skills without contexts backward compatible", function () {
    setUserSkills([
      parseSkill(
        [
          "---",
          "id: custom-summary",
          "description: Custom summary",
          "version: 1",
          "match: /summarize/i",
          "---",
          "Custom instructions.",
        ].join("\n"),
      ),
    ]);

    assert.include(
      getMatchedSkillIds({ userText: "summarize anything" }),
      "custom-summary",
    );
  });
});
