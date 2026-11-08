import { assert } from "chai";
import { after, before, describe, it } from "mocha";
import { initI18n, t } from "../src/utils/i18n";
import {
  DEFAULT_INLINE_ASK_PROMPTS,
  getInlineAskQuickPrompts,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskPrompts";
import {
  cloneInlineAskAnnotation,
  isInlineAskReader,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskSnapshot";

const CARD_STRINGS = [
  "Inline Ask",
  "Ask about the selected text here",
  "Selected text",
  "Ask about this selection…",
  "Ask a follow-up…",
  "Enter to send · Shift+Enter for a new line · Esc to close",
  "Send",
  "Reading the selection…",
  "Discard",
  "Continue in sidebar",
  "Save as annotation",
  "Reasoning effort",
  "Inline Ask needs an API model.",
  'Show "Inline Ask" in reader selection popup',
  "Disable this if you prefer not to show the Inline Ask option in Zotero's text selection popup menu.",
];

describe("Inline Ask quick prompts", function () {
  it("offers Explain, Define terms and Translate in English", function () {
    const prompts = getInlineAskQuickPrompts();
    assert.deepEqual(
      prompts.map((prompt) => prompt.label),
      ["Explain", "Define terms", "Translate"],
    );
    assert.equal(
      prompts[2].prompt,
      "Translate this passage into English.",
      "Translate names the UI language",
    );
  });

  describe("in Chinese", function () {
    const globals = globalThis as unknown as { Zotero?: unknown };
    let previousZotero: unknown;
    before(function () {
      previousZotero = globals.Zotero;
      globals.Zotero = { Prefs: { get: () => "zh-CN" }, locale: "zh-CN" };
      initI18n();
    });
    after(function () {
      if (previousZotero === undefined) delete globals.Zotero;
      else globals.Zotero = previousZotero;
      initI18n();
    });

    it("has a Chinese copy of every label and prompt", function () {
      for (const entry of DEFAULT_INLINE_ASK_PROMPTS) {
        assert.notEqual(t(entry.label), entry.label, entry.label);
        assert.notEqual(t(entry.prompt), entry.prompt, entry.prompt);
      }
      const translate = getInlineAskQuickPrompts().find(
        (prompt) => prompt.id === "translate",
      );
      assert.include(translate?.prompt, "中文");
    });

    it("translates every card and settings string", function () {
      for (const value of CARD_STRINGS) assert.notEqual(t(value), value, value);
    });
  });
});

describe("Inline Ask popup snapshot", function () {
  it("is offered in PDF readers only", function () {
    assert.isTrue(isInlineAskReader({ type: "pdf" }, null));
    assert.isFalse(isInlineAskReader({ type: "epub" }, null));
    assert.isFalse(isInlineAskReader({ type: "snapshot" }, null));
    assert.isTrue(
      isInlineAskReader({}, { isPDFAttachment: () => true }),
      "an older reader without a type falls back to the item",
    );
    assert.isFalse(isInlineAskReader(null, null));
  });

  it("copies the annotation draft so later reader changes cannot alter it", function () {
    const draft = {
      text: "selected",
      position: { pageIndex: 2, rects: [[1, 2, 3, 4]] },
      sortIndex: "00002|000100|00200",
    };
    const copy = cloneInlineAskAnnotation(draft);
    draft.position.rects[0][0] = 99;
    assert.deepEqual(copy, {
      text: "selected",
      position: { pageIndex: 2, rects: [[1, 2, 3, 4]] },
      sortIndex: "00002|000100|00200",
    });
    assert.isNull(cloneInlineAskAnnotation(undefined));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.isNull(cloneInlineAskAnnotation(cyclic));
  });
});
