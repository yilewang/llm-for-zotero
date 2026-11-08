/**
 * The search-routing live suite's pure helpers for the nothing-attached
 * cases (S7, S8): whether the library's results were in before the first
 * outside call, whether the answer names library papers, and whether it
 * offers to search outside. The live suite only reports these.
 */
import { assert } from "chai";
import {
  classifyTool,
  namesAnyTitle,
  offersOutsideSearch,
  summarizeRoutingRep,
  type RoutingCall,
} from "../test-live/agent/search-routing/searchRoutingMetrics";

function call(name: string, round: number): RoutingCall {
  return {
    name,
    family: classifyTool(name),
    round,
    args: {},
    startedMs: 0,
  };
}

describe("search routing metrics: library result before outside", function () {
  it("is true only when a local call came in an earlier round than the first outside call", function () {
    const earlier = summarizeRoutingRep(
      [call("library_retrieve", 1), call("literature_search", 2)],
      [],
    );
    assert.isTrue(earlier.localResultBeforeOutside);
    // The same round counts for localBeforeOutside, not for this metric:
    // the model decided before it saw the library's results.
    const sameRound = summarizeRoutingRep(
      [call("library_retrieve", 1), call("literature_search", 1)],
      [],
    );
    assert.isTrue(sameRound.localBeforeOutside);
    assert.isFalse(sameRound.localResultBeforeOutside);
    const outsideOnly = summarizeRoutingRep(
      [call("literature_search", 1), call("library_retrieve", 2)],
      [],
    );
    assert.isFalse(outsideOnly.localResultBeforeOutside);
  });

  it("is null when the rep made no outside call", function () {
    assert.isNull(
      summarizeRoutingRep([call("library_retrieve", 1)], [])
        .localResultBeforeOutside,
    );
  });
});

describe("search routing metrics: library answer heuristics", function () {
  it("finds a library paper's title in the answer, whatever its case and spacing", function () {
    const titles = [
      "Representational drift in the mouse visual cortex",
      "Stable place fields after sleep restriction",
    ];
    assert.isTrue(
      namesAnyTitle(
        "Your library has *Representational  drift in the mouse visual cortex* (2021).",
        titles,
      ),
    );
    assert.isFalse(namesAnyTitle("Drift is a known effect.", titles));
    assert.isFalse(namesAnyTitle("anything", []));
  });

  it("recognizes an offer to search outside the library", function () {
    for (const answer of [
      "Would you like me to search outside your library for newer studies?",
      "If you want, I can search scholarly databases for more papers.",
      "Let me know if you'd like me to look for additional papers beyond your library.",
      "我可以帮你在库外搜索更多论文。 Do you want me to search OpenAlex for more?",
    ])
      assert.isTrue(offersOutsideSearch(answer), answer);
    for (const answer of [
      "I searched your library and found two papers.",
      "These papers report drift across days.",
    ])
      assert.isFalse(offersOutsideSearch(answer), answer);
  });
});
