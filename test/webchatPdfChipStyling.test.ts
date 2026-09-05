import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getContextSourceModeCssClassName } from "../src/modules/contextPanel/contextSourceModes";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

describe("WebChat PDF chip styling", function () {
  it("keeps the PDF source class after a successful upload switches to prompt-only mode", function () {
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");

    assert.equal(
      getContextSourceModeCssClassName("pdf"),
      "llm-paper-context-chip-pdf",
    );
    assert.notMatch(
      setupHandlers,
      /isWebChatMode\(\)\s*&&\s*contentSourceMode\s*===\s*"pdf"\s*&&\s*!fullText\s*\?\s*"text"/,
    );
    assert.match(
      setupHandlers,
      /chip\.classList\.toggle\(\s*"llm-paper-context-chip-webchat-inactive",\s*isWebChatMode\(\)\s*&&\s*contentSourceMode\s*===\s*"pdf"\s*&&\s*!fullText,/,
    );
  });

  it("keeps the inactive WebChat surface neutral without changing PDF purple", function () {
    const css = source("addon/content/zoteroPane.css");

    assert.match(
      css,
      /\.llm-paper-context-chip\.llm-paper-context-chip-pdf\s+\.llm-paper-context-chip-icon\s*\{[\s\S]*?color:\s*var\(--llm-pdf-color\);/,
    );
    assert.match(
      css,
      /\.llm-paper-context-chip\.llm-paper-context-chip-pdf\.llm-paper-context-chip-webchat-inactive\s+\.llm-paper-context-chip-header\s*\{[\s\S]*?background:\s*transparent;/,
    );
  });

  it("updates the inactive surface immediately when right-click toggles PDF sending", function () {
    const controller = source(
      "src/modules/contextPanel/setupHandlers/controllers/composePreviewInteractionController.ts",
    );

    assert.match(
      controller,
      /paperChip\.classList\.toggle\(\s*"llm-paper-context-chip-webchat-inactive",\s*deps\.isWebChatMode\(\)\s*&&\s*contentSource\s*===\s*"pdf"\s*&&\s*!nextIsFullText,/,
    );
    assert.match(controller, /Next query will attach this PDF\./);
    assert.notMatch(
      controller,
      /WebChat only requires uploading PDF once per session/,
    );
  });

  it("documents that any later turn can attach the current PDF again", function () {
    const i18n = source("src/utils/i18n.ts");

    assert.include(i18n, "attach the current PDF again");
    assert.notInclude(i18n, "uploaded only once per webchat session");
  });

  it("keeps the Chinese welcome text in sync with the reattach behavior", function () {
    const i18n = source("src/utils/i18n.ts");

    assert.include(i18n, "重新附加当前 PDF");
    assert.notInclude(i18n, "每个 WebChat 会话通常只上传一次 PDF");
  });
});
