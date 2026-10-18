import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { renderShortcuts } from "../src/modules/contextPanel/shortcuts";
import { createGlobalPortalItem } from "../src/modules/contextPanel/portalScope";
import { shortcutTextCache } from "../src/modules/contextPanel/state";
import { FakeElement, fakeDocument } from "./helpers/fakeDom";

describe("Agent prompt template buttons", function () {
  const previous = globalThis.Zotero;
  const globals = globalThis as any;
  const previousToolkit = globals.ztoolkit;
  const preferences = new Map<string, unknown>();
  let sent = "";
  const input = { value: "" };
  function panel() {
    const container = new FakeElement();
    const body = Object.assign(new FakeElement(), {
      ownerDocument: fakeDocument,
      querySelector: (selector: string) =>
        selector === "#llm-shortcuts"
          ? container
          : selector === "#llm-input"
            ? input
            : selector === "#llm-send"
              ? {
                  click: () => {
                    sent = input.value;
                  },
                }
              : null,
    });
    return {
      body: body as unknown as Element,
      container: container as FakeElement & {
        onclick: (event: unknown) => void;
      },
    };
  }
  beforeEach(function () {
    preferences.clear();
    sent = "";
    input.value = "";
    shortcutTextCache.clear();
    globalThis.Zotero = {
      locale: "en-US",
      Prefs: {
        get: (key: string) => preferences.get(key),
        set: (key: string, value: unknown) => preferences.set(key, value),
      },
    } as typeof Zotero;
    globals.ztoolkit = {
      getGlobal: () => async () => ({
        ok: true,
        text: async () => "Summarize the current paper.",
      }),
    };
  });
  afterEach(function () {
    shortcutTextCache.clear();
    globalThis.Zotero = previous;
    globals.ztoolkit = previousToolkit;
  });
  for (const mode of ["paper", "library"] as const) {
    it(`renders and sends a template in ${mode} conversation mode`, async function () {
      const { body, container } = panel();
      const item =
        mode === "library"
          ? createGlobalPortalItem(1, 2000000001)
          : ({ id: 42, isRegularItem: () => true } as Zotero.Item);
      await renderShortcuts(body, item, mode);
      assert.isAbove(container.children.length, 0);
      const button = container.children[0];
      assert.isFalse(button.disabled);
      container.onclick({
        target: button.children[0],
        preventDefault() {},
        stopPropagation() {},
      });
      assert.equal(sent, "Summarize the current paper.");
    });
  }
  it("keeps templates disabled until a conversation has an item", async function () {
    const { body, container } = panel();
    await renderShortcuts(body, null, "paper");
    assert.isAbove(container.children.length, 0);
    assert.isTrue(container.children.every((button) => button.disabled));
  });
  it("keeps the note editor's own actions", async function () {
    const { body, container } = panel();
    const note = {
      id: 55,
      libraryID: 1,
      isNote: () => true,
      getField: () => "Note",
    } as Zotero.Item;
    await renderShortcuts(body, note, "library");
    assert.lengthOf(container.children, 0);
  });
});
