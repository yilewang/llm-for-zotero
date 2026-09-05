import { assert } from "chai";
import { describe, it } from "mocha";

import {
  clearAllState,
  selectedTagContextCache,
  webChatIsolatedConversationKeys,
} from "../src/modules/contextPanel/state";
import {
  buildMermaidSvgCacheKey,
  cacheMermaidSvg,
  getMermaidSvgCacheSizeForTests,
} from "../src/modules/contextPanel/mermaidSvgCache";

describe("clearAllState shutdown hygiene", function () {
  it("clears the tag-context cache and webchat isolation keys", function () {
    selectedTagContextCache.set(42, [
      { libraryID: 1, tag: "methods" } as never,
    ]);
    webChatIsolatedConversationKeys.add(42);

    clearAllState();

    assert.strictEqual(selectedTagContextCache.size, 0);
    assert.strictEqual(webChatIsolatedConversationKeys.size, 0);
  });

  it("clears the mermaid SVG cache on shutdown", function () {
    cacheMermaidSvg(
      buildMermaidSvgCacheKey("3", "light", "graph TD; A-->B"),
      "<svg></svg>",
    );
    assert.isAbove(getMermaidSvgCacheSizeForTests(), 0);

    clearAllState();

    assert.strictEqual(getMermaidSvgCacheSizeForTests(), 0);
  });
});
