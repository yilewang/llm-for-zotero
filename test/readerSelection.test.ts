import { assert } from "chai";
import {
  closeReaderSelectionPopup,
  collectReaderSelectionDocuments,
  getFirstSelectionFromReader,
  getSelectionFromDocument,
  getSelectionPopupTextFromReader,
} from "../src/services/pdf/readerSelection";

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

describe("reader selection recovery", function () {
  it("uses Zotero's live selection popup state when the DOM selection is gone", function () {
    const reader = {
      _internalReader: {
        _lastViewPrimary: true,
        _state: {
          primary: true,
          primaryViewSelectionPopup: {
            annotation: { text: "  recovered   selection  " },
          },
        },
      },
    };

    assert.equal(
      getSelectionPopupTextFromReader(reader, normalize),
      "recovered selection",
    );
    assert.equal(
      getFirstSelectionFromReader(reader, normalize),
      "recovered selection",
    );
  });

  it("prefers a live DOM selection over the private popup fallback", function () {
    const doc = {
      defaultView: {
        getSelection: () => ({ toString: () => "live selection" }),
      },
    } as unknown as Document;
    const reader = {
      _iframeWindow: { document: doc },
      _internalReader: {
        _state: {
          primaryViewSelectionPopup: {
            annotation: { text: "popup selection" },
          },
        },
      },
    };

    assert.equal(
      getFirstSelectionFromReader(reader, normalize),
      "live selection",
    );
  });

  it("survives stale reader document wrappers and uses the current popup", function () {
    const reader = {
      get _iframeWindow() {
        throw new Error("dead object");
      },
      _internalReader: {
        _lastViewPrimary: false,
        _state: {
          primary: false,
          secondaryViewSelectionPopup: {
            annotation: { text: "secondary selection" },
          },
        },
      },
    };
    const staleDoc = {
      get defaultView() {
        throw new Error("dead object");
      },
    } as unknown as Document;

    assert.deepEqual(collectReaderSelectionDocuments(reader), []);
    assert.equal(getSelectionFromDocument(staleDoc, normalize), "");
    assert.equal(
      getFirstSelectionFromReader(reader, normalize),
      "secondary selection",
    );
  });
});

describe("closeReaderSelectionPopup", function () {
  function fakeReader(state: Record<string, unknown>) {
    const updates: Array<Record<string, unknown>> = [];
    const internal = {
      _state: { ...state },
      _updateState(update: Record<string, unknown>) {
        updates.push(update);
        Object.assign(internal._state, update);
      },
    };
    return { reader: { _internalReader: internal }, internal, updates };
  }
  const popupIn = (view: "primary" | "secondary") => ({
    closest: (selector: string) =>
      selector === `.${view}-view` ? { className: `${view}-view` } : null,
  });

  it("clears the primary view's popup state and nothing else", function () {
    const { reader, internal, updates } = fakeReader({
      primaryViewSelectionPopup: { rect: [1, 2, 3, 4] },
      secondaryViewSelectionPopup: null,
    });
    assert.isTrue(closeReaderSelectionPopup(reader, popupIn("primary") as any));
    assert.deepEqual(updates, [{ primaryViewSelectionPopup: null }]);
    assert.isNull(internal._state.primaryViewSelectionPopup);
  });

  it("clears the secondary view's popup when the popup is in that view", function () {
    const { reader, updates } = fakeReader({
      primaryViewSelectionPopup: { rect: [1, 2, 3, 4] },
      secondaryViewSelectionPopup: { rect: [5, 6, 7, 8] },
    });
    assert.isTrue(
      closeReaderSelectionPopup(reader, popupIn("secondary") as any),
    );
    assert.deepEqual(updates, [{ secondaryViewSelectionPopup: null }]);
  });

  it("changes nothing and returns false without the reader state it needs", function () {
    assert.isFalse(closeReaderSelectionPopup(null, null));
    assert.isFalse(closeReaderSelectionPopup({ _internalReader: {} }, null));
    const noPopup = fakeReader({ primaryViewSelectionPopup: null });
    assert.isFalse(closeReaderSelectionPopup(noPopup.reader, null));
    assert.deepEqual(noPopup.updates, []);
    const otherShape = fakeReader({ somethingElse: 1 });
    assert.isFalse(closeReaderSelectionPopup(otherShape.reader, null));
    assert.deepEqual(otherShape.updates, []);
  });

  it("returns false when the reader throws", function () {
    const reader = {
      _internalReader: {
        _state: { primaryViewSelectionPopup: {} },
        _updateState() {
          throw new Error("dead object");
        },
      },
    };
    assert.isFalse(closeReaderSelectionPopup(reader, null));
  });
});
