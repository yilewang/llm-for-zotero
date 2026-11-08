import { assert } from "chai";
import { after, afterEach, before, beforeEach, describe, it } from "mocha";
import { initI18n, t } from "../src/utils/i18n";
import {
  createInlineAskPromptEditing,
  DEFAULT_INLINE_ASK_PROMPTS,
  getInlineAskQuickPrompts,
  MAX_INLINE_ASK_PROMPTS,
  parseInlineAskSavedPrompts,
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
  "Edit",
  "Delete",
  "Add",
  "Reset",
  "Label",
  "Prompt, sent with the selected text",
  "Cancel",
  "Save",
  "Reasoning",
  "Claude Code runs only in the sidebar. Inline Ask uses an API model from this list.",
  "WebChat runs only in the sidebar. Inline Ask uses an API model from this list.",
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

const PREFIX = "extensions.zotero.llmforzotero.";

/** A Zotero with a pref store (and a locale) for the prompt prefs. */
function installPrefs(locale = "en-US") {
  const globals = globalThis as unknown as { Zotero?: unknown };
  const previous = globals.Zotero;
  const store = new Map<string, unknown>();
  globals.Zotero = {
    locale,
    Prefs: {
      get: (key: string) =>
        key === `${PREFIX}locale` ? locale : store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value);
      },
      clear: (key: string) => {
        store.delete(key);
      },
    },
  };
  initI18n();
  return {
    store,
    restore: () => {
      if (previous === undefined) delete globals.Zotero;
      else globals.Zotero = previous;
      initI18n();
    },
  };
}

describe("Inline Ask prompt prefs", function () {
  let prefs: ReturnType<typeof installPrefs>;
  let ids = 0;
  const editing = () => createInlineAskPromptEditing(() => `custom-${++ids}`);
  const labels = () => getInlineAskQuickPrompts().map((entry) => entry.label);

  beforeEach(function () {
    prefs = installPrefs();
  });
  afterEach(function () {
    prefs.restore();
  });

  it("starts with the three built-ins and no stored value", function () {
    assert.deepEqual(labels(), ["Explain", "Define terms", "Translate"]);
    assert.isFalse(prefs.store.has(`${PREFIX}inlineAskPrompts`));
    assert.isFalse(prefs.store.has(`${PREFIX}inlineAskDeletedPrompts`));
  });

  it("edits a built-in in place and stores only the change", function () {
    editing().edit("define", { label: " Terms ", prompt: " List the terms. " });
    const prompts = getInlineAskQuickPrompts();
    assert.deepEqual(prompts[1], {
      id: "define",
      label: "Terms",
      prompt: "List the terms.",
    });
    assert.deepEqual(
      JSON.parse(String(prefs.store.get(`${PREFIX}inlineAskPrompts`))),
      [{ id: "define", label: "Terms", prompt: "List the terms." }],
    );
    // Editing it back to the shown default drops the override.
    editing().edit("define", {
      label: "Define terms",
      prompt: "Define the technical terms in this passage.",
    });
    assert.isFalse(prefs.store.has(`${PREFIX}inlineAskPrompts`));
  });

  it("ignores an edit with an empty label or prompt", function () {
    editing().edit("explain", { label: "", prompt: "x" });
    editing().edit("explain", { label: "x", prompt: "  " });
    assert.deepEqual(labels(), ["Explain", "Define terms", "Translate"]);
  });

  it("adds a prompt last, edits it, and deletes it", function () {
    assert.isTrue(editing().add({ label: "Critique", prompt: "Critique it." }));
    assert.deepEqual(labels(), [
      "Explain",
      "Define terms",
      "Translate",
      "Critique",
    ]);
    const id = getInlineAskQuickPrompts()[3].id;
    editing().edit(id, { label: "Critic", prompt: "Be critical." });
    assert.deepEqual(getInlineAskQuickPrompts()[3], {
      id,
      label: "Critic",
      prompt: "Be critical.",
    });
    editing().remove(id);
    assert.deepEqual(labels(), ["Explain", "Define terms", "Translate"]);
    assert.isFalse(prefs.store.has(`${PREFIX}inlineAskPrompts`));
  });

  it("deletes a built-in by id and Reset restores the three", function () {
    editing().edit("explain", { label: "Plain", prompt: "Say it plainly." });
    editing().remove("explain");
    editing().add({ label: "Mine", prompt: "My prompt." });
    assert.deepEqual(labels(), ["Define terms", "Translate", "Mine"]);
    assert.deepEqual(
      JSON.parse(String(prefs.store.get(`${PREFIX}inlineAskDeletedPrompts`))),
      ["explain"],
    );
    // Editing a deleted built-in changes nothing.
    editing().edit("explain", { label: "Back", prompt: "Back." });
    assert.deepEqual(labels(), ["Define terms", "Translate", "Mine"]);

    editing().reset();
    assert.deepEqual(labels(), ["Explain", "Define terms", "Translate"]);
    assert.isFalse(prefs.store.has(`${PREFIX}inlineAskPrompts`));
    assert.isFalse(prefs.store.has(`${PREFIX}inlineAskDeletedPrompts`));
  });

  it("caps the card at 20 prompts", function () {
    const edit = editing();
    for (let index = 0; index < MAX_INLINE_ASK_PROMPTS - 3; index++) {
      assert.isTrue(
        edit.add({ label: `P${index}`, prompt: `Prompt ${index}` }),
      );
    }
    assert.lengthOf(getInlineAskQuickPrompts(), MAX_INLINE_ASK_PROMPTS);
    assert.isFalse(edit.canAdd());
    assert.isFalse(edit.add({ label: "One more", prompt: "Too many." }));
    assert.lengthOf(getInlineAskQuickPrompts(), MAX_INLINE_ASK_PROMPTS);
    edit.remove("translate");
    assert.isTrue(edit.canAdd());
  });

  it("reads malformed prefs as the defaults", function () {
    prefs.store.set(`${PREFIX}inlineAskPrompts`, "{not json");
    prefs.store.set(`${PREFIX}inlineAskDeletedPrompts`, '["nope", 3]');
    assert.deepEqual(labels(), ["Explain", "Define terms", "Translate"]);
    assert.deepEqual(
      parseInlineAskSavedPrompts(
        JSON.stringify([
          { id: "a", label: "A", prompt: "PA" },
          { id: "a", label: "A2", prompt: "PA2" },
          { id: "b", label: "", prompt: "PB" },
          null,
          "x",
        ]),
      ),
      [{ id: "a", label: "A", prompt: "PA" }],
    );
  });

  it("shows unedited built-ins in Chinese and keeps edited text as typed", function () {
    prefs.restore();
    prefs = installPrefs("zh-CN");
    editing().edit("define", { label: "My terms", prompt: "Mine." });
    const prompts = getInlineAskQuickPrompts();
    assert.equal(prompts[0].label, t("Explain"));
    assert.notEqual(prompts[0].label, "Explain");
    assert.equal(prompts[1].label, "My terms");
    assert.include(prompts[2].prompt, "中文");
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
