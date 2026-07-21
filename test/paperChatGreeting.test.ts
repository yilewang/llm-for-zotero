import { assert } from "chai";

import { getPaperChatStartPageHtml } from "../src/utils/i18n";

describe("paper chat start-page greeting", function () {
  it("rotates the greeting instead of immediately repeating it", function () {
    const first = getPaperChatStartPageHtml(() => 0);
    const second = getPaperChatStartPageHtml(() => 0);

    assert.notEqual(first, second);
    assert.include(first, "llm-paper-start-page");
    assert.include(second, "llm-paper-start-page");
  });

  it("keeps the opening copy short and paper-focused", function () {
    const html = getPaperChatStartPageHtml(() => 0.99);

    assert.include(html, "Peer review, but make it personal.");
    assert.include(html, "method, the evidence, or what's missing");
    assert.notInclude(html, "The current PDF is ready");
  });
});
