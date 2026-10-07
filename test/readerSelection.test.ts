import { assert } from "chai";
import {
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
