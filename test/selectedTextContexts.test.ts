import { assert } from "chai";
import {
  normalizeSelectedTextContexts,
  synthesizeSelectedTextContexts,
} from "../src/services/context/normalizers";

describe("selected text context normalization", function () {
  it("sanitizes invalid stable locator values", function () {
    const contexts = normalizeSelectedTextContexts([
      {
        text: " Selected quote ",
        source: "pdf",
        contextItemId: -5,
        pageIndex: -1,
        pageLabel: " custom ",
      },
      {
        text: "High page quote",
        source: "pdf",
        contextItemId: 44.9,
        pageIndex: 587.8,
      },
    ]);

    assert.deepEqual(contexts[0], {
      text: "Selected quote",
      source: "pdf",
      paperContext: undefined,
      noteContext: undefined,
      contextItemId: undefined,
      pageIndex: undefined,
      pageLabel: "custom",
    });
    assert.equal(contexts[1]?.contextItemId, 44);
    assert.equal(contexts[1]?.pageIndex, 587);
    // D5 (was "588", guessed from the page index): no label is invented.
    assert.isUndefined(contexts[1]?.pageLabel);
  });

  it("treats canonical contexts as authoritative over legacy arrays", function () {
    const contexts = synthesizeSelectedTextContexts({
      selectedTextContexts: [
        {
          text: "Canonical quote",
          source: "pdf",
          contextItemId: 50,
          pageIndex: 9,
          pageLabel: "x",
        },
      ],
      selectedTexts: ["Legacy quote"],
      selectedTextSources: ["note"],
    });

    assert.lengthOf(contexts, 1);
    assert.equal(contexts[0]?.text, "Canonical quote");
    assert.equal(contexts[0]?.source, "pdf");
    assert.equal(contexts[0]?.pageIndex, 9);
  });

  it("reconstructs legacy rows by zipping compatibility arrays", function () {
    const contexts = synthesizeSelectedTextContexts({
      selectedTexts: ["PDF quote", "Note quote"],
      selectedTextSources: ["pdf", "note"],
      selectedTextPaperContexts: [
        {
          itemId: 1,
          contextItemId: 2,
          title: "Paper",
        },
        undefined,
      ],
      selectedTextNoteContexts: [
        undefined,
        {
          libraryID: 1,
          noteItemKey: "ABCD1234",
          noteKind: "standalone",
          title: "Note",
        },
      ],
    });

    assert.equal(contexts[0]?.contextItemId, 2);
    assert.equal(contexts[0]?.paperContext?.title, "Paper");
    assert.equal(contexts[1]?.source, "note");
    assert.equal(contexts[1]?.noteContext?.noteItemKey, "ABCD1234");
  });
});
