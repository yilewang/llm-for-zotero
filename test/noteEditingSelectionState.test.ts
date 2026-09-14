import { assert } from "chai";
import {
  registerNoteEditingSelectionTracking,
  unregisterNoteEditingSelectionTracking,
} from "../src/modules/contextPanel/index";
import { getSelectedTextContextEntries } from "../src/modules/contextPanel/contextResolution";
import { getConversationKey } from "../src/modules/contextPanel/conversationIdentity";
import { clearAllState } from "../src/modules/contextPanel/state";
import { normalizeSelectedText } from "../src/modules/contextPanel/textUtils";

const originalZotero = globalThis.Zotero;

describe("note editing live selection state", function () {
  afterEach(function () {
    clearAllState();
    globalThis.Zotero = originalZotero;
  });
  it("preserves note-edit spacing while keeping PDF selection normalization", function () {
    const selected = "First  paragraph\r\n\r\nSecond paragraph";
    assert.equal(
      normalizeSelectedText(selected, "note-edit"),
      "First  paragraph\n\nSecond paragraph",
    );
    assert.equal(
      normalizeSelectedText(selected),
      "First paragraph Second paragraph",
    );
  });
  for (const selected of [
    "Selected note sentence.",
    "First  paragraph\n\nSecond paragraph",
  ])
    it(`preserves ${JSON.stringify(selected)} across editor, chrome, and composer focus until the editor clears it`, function () {
      class Editable {
        nodeType = 1;
        id = "";
        isContentEditable = true;
        parentElement = null;
        closest() {
          return null;
        }
      }
      const el = new Editable();
      let editorFocused = true;
      let selectedValue = selected;
      const selection = {
        toString: () => selectedValue,
        isCollapsed: false,
        anchorNode: el,
        focusNode: el,
      };
      const noEvent = () => {};
      const editorDoc: any = {
        activeElement: el,
        body: {},
        hasFocus: () => editorFocused,
        querySelectorAll: () => [],
        addEventListener: noEvent,
        removeEventListener: noEvent,
        defaultView: {
          HTMLElement: Editable,
          Node: { ELEMENT_NODE: 1 },
          getSelection: () => selection,
        },
      };
      const mainDoc: any = {
        activeElement: { id: "note-frame" },
        body: {},
        hasFocus: () => true,
        querySelectorAll: (selector: string) =>
          selector === "note-editor"
            ? [
                {
                  item: note,
                  querySelector: () => ({ contentDocument: editorDoc }),
                  getClientRects: () => [{}],
                },
              ]
            : selector === "iframe"
              ? [{ contentDocument: editorDoc }]
              : [],
        addEventListener: noEvent,
        removeEventListener: noEvent,
        defaultView: { getSelection: () => null },
      };
      const note: any = {
        id: 3975,
        key: "EIZ25QAM",
        libraryID: 1,
        isNote: () => true,
        isAttachment: () => false,
        isRegularItem: () => false,
        getNoteTitle: () => "Diagnostic note",
      };
      const tabs = {
        selectedID: "note",
        _tabs: [{ id: "note", data: { itemID: 3975 } }],
      };
      globalThis.Zotero = {
        Prefs: { get: () => undefined },
        Items: { get: () => note },
        Tabs: tabs,
      } as any;
      let poll = () => {};
      const win: any = {
        document: mainDoc,
        Zotero: { Tabs: tabs },
        setInterval: (cb) => {
          poll = cb;
          return 1;
        },
        clearInterval: noEvent,
        setTimeout: () => 2,
        clearTimeout: noEvent,
        addEventListener: noEvent,
        removeEventListener: noEvent,
      };
      registerNoteEditingSelectionTracking(win);
      const key = getConversationKey(note);
      assert.equal(getSelectedTextContextEntries(key)[0]?.text, selected);
      editorFocused = false;
      mainDoc.activeElement = { id: "zotero-chrome" };
      poll();
      assert.equal(selection.toString(), selected);
      assert.equal(getSelectedTextContextEntries(key)[0]?.text, selected);
      mainDoc.activeElement = { id: "llm-input", closest: () => ({}) };
      poll();
      assert.equal(getSelectedTextContextEntries(key)[0]?.text, selected);
      selectedValue = "";
      selection.isCollapsed = true;
      editorFocused = true;
      mainDoc.activeElement = { id: "note-frame" };
      poll();
      assert.isEmpty(getSelectedTextContextEntries(key));
      unregisterNoteEditingSelectionTracking(win);
    });
});
