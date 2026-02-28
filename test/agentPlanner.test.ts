import { assert } from "chai";
import {
  buildFallbackAgentQueryPlan,
  findAgentPlanJsonObject,
  parseAgentQueryPlan,
} from "../src/modules/contextPanel/agentPlanner";
import type { AgentQueryPlan } from "../src/modules/contextPanel/agentTypes";

describe("agentPlanner", function () {
  const fallback: AgentQueryPlan = {
    action: "skip",
    maxPapersToRead: 1,
    traceLines: ["fallback"],
  };

  it("extracts the first JSON object from model output", function () {
    const raw =
      'Here is the plan:\n{"action":"library-search","searchQuery":"graph memory","maxPapersToRead":4,"traceLines":["Search the library."]}\nDone.';
    const jsonText = findAgentPlanJsonObject(raw);
    assert.include(jsonText, '"action":"library-search"');
  });

  it("parses and normalizes a planner JSON response", function () {
    const plan = parseAgentQueryPlan(
      JSON.stringify({
        action: "library-search",
        searchQuery: "graph memory",
        maxPapersToRead: 99,
        traceLines: ["Search the library for relevant papers."],
      }),
      fallback,
    );
    assert.equal(plan.action, "library-search");
    assert.equal(plan.searchQuery, "graph memory");
    assert.equal(plan.maxPapersToRead, 12);
    assert.deepEqual(plan.traceLines, [
      "Search the library for relevant papers.",
    ]);
  });

  it("falls back on invalid planner JSON", function () {
    const plan = parseAgentQueryPlan("{not-json", fallback);
    assert.deepEqual(plan, fallback);
  });

  it("builds a whole-library fallback plan for overview queries", function () {
    const plan = buildFallbackAgentQueryPlan({
      question: "read the whole library to me",
      conversationMode: "open",
      libraryID: 5,
      model: "gpt-4o-mini",
      paperContexts: [],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
    });
    assert.equal(plan.action, "library-overview");
  });

  it("builds an existing-paper fallback when papers are already present", function () {
    const plan = buildFallbackAgentQueryPlan({
      question: "compare these papers",
      conversationMode: "open",
      libraryID: 5,
      model: "gpt-4o-mini",
      paperContexts: [
        {
          itemId: 1,
          contextItemId: 2,
          title: "Paper A",
        },
      ],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
    });
    assert.equal(plan.action, "existing-paper-contexts");
  });
});
