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
  TagContextRef,
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
const tag: TagContextRef = {
  name: "Stable",
  normalizedName: "stable",
  libraryID: 1,
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

  it("activates simple-paper-qa only for paper-targeted auto routes", function () {
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
    assert.include(
      getMatchedSkillIds({
        userText: "summarize these papers",
        selectedPaperContexts: [paperA, paperB],
      }),
      "simple-paper-qa",
    );
  });

  it("prefers library skills for collection and tag summary routes", function () {
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

    const tagTargeted = getMatchedSkillIds({
      userText: "summarize this tag",
      selectedPaperContexts: [paperA],
      selectedTagContexts: [tag],
    });
    assert.include(tagTargeted, "library-analysis");
    assert.notInclude(tagTargeted, "simple-paper-qa");
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
    assert.include(
      getMatchedSkillIds({
        userText: "give me statistics",
        selectedTagContexts: [tag],
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

  it("always honors explicitly forced slash skills", function () {
    loadBuiltInSkills();

    assert.deepEqual(
      getMatchedSkillIds({
        userText: "answer this without any attached paper context",
        forcedSkillIds: ["evidence-based-qa"],
      }),
      ["evidence-based-qa"],
    );
  });

  it("prefers evidence-based paper QA over simple paper QA for automatic overlaps", function () {
    loadBuiltInSkills();

    assert.deepEqual(
      getMatchedSkillIds({
        userText: "what method did they use in this paper",
        selectedPaperContexts: [paperA],
      }),
      ["evidence-based-qa"],
    );
  });

  it("does not suppress explicitly selected simple paper QA", function () {
    loadBuiltInSkills();

    assert.deepEqual(
      getMatchedSkillIds({
        userText: "what method did they use in this paper",
        selectedPaperContexts: [paperA],
        forcedSkillIds: ["simple-paper-qa"],
      }),
      ["simple-paper-qa", "evidence-based-qa"],
    );
  });

  it("suppresses automatic simple paper QA when evidence QA is explicit", function () {
    loadBuiltInSkills();

    assert.deepEqual(
      getMatchedSkillIds({
        userText: "summarize this paper",
        selectedPaperContexts: [paperA],
        forcedSkillIds: ["evidence-based-qa"],
      }),
      ["evidence-based-qa"],
    );
  });
});
