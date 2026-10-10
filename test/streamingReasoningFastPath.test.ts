import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";

const here = dirname(fileURLToPath(import.meta.url));

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.isAtLeast(from, 0, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.isAbove(to, from, `missing ${end}`);
  return source.slice(from, to);
}

describe("streamed thinking text", function () {
  const chatSource = readFileSync(
    resolve(here, "../src/modules/contextPanel/chat.ts"),
    "utf8",
  );

  it("updates the mounted message in place instead of rebuilding it", function () {
    const fastPath = sliceBetween(
      chatSource,
      "function updateMountedAssistantViews(",
      "export type RefreshChatOptions",
    );
    // Growing thinking text no longer forces the full message renderer;
    // only clearing it does.
    assert.notInclude(
      fastPath,
      "message.reasoningSummary !== view.reasoningSummary",
    );
    assert.notInclude(
      fastPath,
      "message.reasoningDetails !== view.reasoningDetails",
    );
    assert.include(fastPath, "updateMountedReasoningPanel(view, message");
  });

  it("reparses only the unfinished tail while streaming", function () {
    const renderPart = sliceBetween(
      chatSource,
      "function renderReasoningPart(",
      "function updateMountedReasoningPanel(",
    );
    assert.include(renderPart, "renderStreamingMarkdownInto(");
    const updatePanel = sliceBetween(
      chatSource,
      "function updateMountedReasoningPanel(",
      "export type RefreshChatOptions",
    );
    assert.include(updatePanel, "scheduleChatScrollReconciliation(");
  });

  it("releases streaming thinking renderers with the mounted view", function () {
    const dispose = sliceBetween(
      chatSource,
      "function disposeMountedAssistantView(",
      "function createReasoningPanel(",
    );
    assert.include(dispose, "view.reasoning?.text");
    assert.include(dispose, "disposeStreamingMarkdown(text)");
  });
});
