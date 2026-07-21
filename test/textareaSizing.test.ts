import { assert } from "chai";
import {
  calculateAdaptiveTextareaHeight,
  resizeTextareaToContent,
} from "../src/modules/contextPanel/textareaSizing";

describe("adaptive composer textarea sizing", function () {
  it("keeps short text at the compact minimum height", function () {
    assert.deepEqual(
      calculateAdaptiveTextareaHeight({
        scrollHeight: 58,
        borderHeight: 2,
        minHeight: 60,
        maxHeight: 220,
      }),
      {
        height: 60,
        overflowY: "hidden",
      },
    );
  });

  it("matches multiline content without reserving a spare line", function () {
    assert.deepEqual(
      calculateAdaptiveTextareaHeight({
        scrollHeight: 78,
        borderHeight: 2,
        minHeight: 60,
        maxHeight: 220,
      }),
      {
        height: 80,
        overflowY: "hidden",
      },
    );
  });

  it("caps tall content and enables scrolling only when content exceeds the cap", function () {
    assert.deepEqual(
      calculateAdaptiveTextareaHeight({
        scrollHeight: 240,
        borderHeight: 2,
        minHeight: 60,
        maxHeight: 220,
      }),
      {
        height: 220,
        overflowY: "auto",
      },
    );
    assert.deepEqual(
      calculateAdaptiveTextareaHeight({
        scrollHeight: 208,
        borderHeight: 2,
        minHeight: 60,
        maxHeight: 220,
      }),
      {
        height: 210,
        overflowY: "hidden",
      },
    );
  });

  it("applies computed styles to the live textarea", function () {
    const style = {
      height: "60px",
      overflowY: "auto",
    };
    const textarea = {
      style,
      scrollHeight: 78,
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({
            fontSize: "12px",
            lineHeight: "18px",
            minHeight: "60px",
            maxHeight: "220px",
            boxSizing: "border-box",
            borderTopWidth: "1px",
            borderBottomWidth: "1px",
          }),
        },
      },
    } as unknown as HTMLTextAreaElement;

    const result = resizeTextareaToContent(textarea);

    assert.deepEqual(result, {
      height: 80,
      overflowY: "hidden",
    });
    assert.equal(style.height, "80px");
    assert.equal(style.overflowY, "hidden");
  });

  it("preserves a manually selected textarea height while content changes", function () {
    const style = {
      height: "180px",
      overflowY: "hidden",
    };
    const textarea = {
      dataset: {
        llmManualHeight: "true",
      },
      style,
      scrollHeight: 240,
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({
            minHeight: "60px",
            maxHeight: "220px",
            boxSizing: "border-box",
            borderTopWidth: "1px",
            borderBottomWidth: "1px",
          }),
        },
      },
    } as unknown as HTMLTextAreaElement;

    const result = resizeTextareaToContent(textarea);

    assert.deepEqual(result, {
      height: 180,
      overflowY: "auto",
    });
    assert.equal(style.height, "180px");
    assert.equal(style.overflowY, "auto");
  });
});
