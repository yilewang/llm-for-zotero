import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

/**
 * "Save as note" (single response) includes the user's query in the saved note
 * unless the "Save only the response" preference is turned off. These tests
 * keep both the immediate build path and the finalized save path aligned, and
 * confirm the preference's default (on) preserves the query.
 */
describe("save-only-response note preference", function () {
  const notes = () => source("src/modules/contextPanel/notes.ts");

  it("exposes the preference key and helper with a true default", function () {
    const src = notes();
    assert.include(src, "SAVE_NOTE_INCLUDE_QUERY_PREF_KEY");
    assert.include(src, "includeQueryInSavedNote()");
    assert.include(
      src,
      "return getBoolPref(SAVE_NOTE_INCLUDE_QUERY_PREF_KEY, true);",
    );
  });

  it("gates the immediate (non-save) path and drops the query block when off", function () {
    const src = notes();
    assert.include(
      src,
      'let queryHtml = includeQuery && query ? renderRawNoteHtml(query) : "";',
    );
    // The default/true path still emits the query block.
    assert.include(src, "const queryBlock = queryHtml");
    assert.include(src, "User query:</strong></p><div>${queryHtml}</div>");
    // The block must no longer re-read the preference after rendering.
    assert.notInclude(src, "queryHtml && includeQueryInSavedNote()");
  });

  it("skips query figure rendering on the finalized save path when off", function () {
    const src = notes();
    assert.include(
      src,
      'let queryHtml =\n    includeQuery && query ? await renderRawNoteHtmlForSave(query, options) : "";',
    );
    assert.notInclude(src, "queryHtml && includeQueryInSavedNote()");
  });

  it("wires the checkbox into the preferences panel and translations", function () {
    const prefs = source("addon/content/preferences.xhtml");
    const script = source("src/modules/preferenceScript.ts");
    const i18n = source("src/utils/i18n.ts");
    assert.include(prefs, 'id="__addonRef__-save-note-include-query"');
    assert.include(
      prefs,
      "Include the question when saving a response as a note",
    );
    assert.include(script, "`#${config.addonRef}-save-note-include-query`");
    assert.include(script, "`${config.prefsPrefix}.saveNoteIncludeQuery`");
    assert.include(i18n, "保存回答为笔记时同时包含提问");
  });
});
