import { assert } from "chai";
import {
  isLibraryOverviewQuery,
  isLibraryScopedSearchQuery,
} from "../src/modules/contextPanel/Agent/context";

describe("agentContext", function () {
  it("detects whole-library overview requests", function () {
    assert.isTrue(isLibraryOverviewQuery("read the whole library to me"));
    assert.isTrue(isLibraryOverviewQuery("give me an overview of my Zotero library"));
    assert.isFalse(isLibraryOverviewQuery("summarize this paper"));
  });

  it("detects library-scoped search requests", function () {
    assert.isTrue(
      isLibraryScopedSearchQuery(
        "which papers in my library talk about retrieval augmentation?",
        "open",
      ),
    );
    assert.isTrue(
      isLibraryScopedSearchQuery("find papers by Smith in my Zotero library", "paper"),
    );
    assert.isFalse(
      isLibraryScopedSearchQuery("compare the methodology of this paper", "paper"),
    );
    assert.isFalse(
      isLibraryScopedSearchQuery("what is a paper abstract?", "open"),
    );
  });
});
