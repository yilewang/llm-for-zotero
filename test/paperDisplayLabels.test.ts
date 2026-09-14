import { assert } from "chai";
import {
  buildPaperDisplayLabels,
  formatPaperDisplayLabel,
  projectPaperReferences,
} from "../src/shared/paperDisplayLabels";

describe("readable paper references", function () {
  it("disambiguates a frozen corpus without exposing technical identifiers", function () {
    const entries = [
      {
        identity: "1:AAAA1111",
        firstCreator: "Smith et al.",
        year: "2024",
        title: "Observer models",
      },
      {
        identity: "1:BBBB2222",
        firstCreator: "Smith et al.",
        year: "2024",
        title: "Neural models",
      },
      {
        identity: "1:CCCC3333",
        firstCreator: "Smith et al.",
        year: "2024",
        title: "Neural models",
      },
    ];
    const labels = buildPaperDisplayLabels(entries);
    assert.equal(
      labels.get(entries[0].identity),
      "(Smith et al., 2024 — Observer models)",
    );
    assert.equal(
      labels.get(entries[1].identity),
      "(Smith et al., 2024 — Neural models; duplicate 1/2)",
    );
    assert.equal(
      labels.get(entries[2].identity),
      "(Smith et al., 2024 — Neural models; duplicate 2/2)",
    );
    assert.equal(
      formatPaperDisplayLabel({ title: "Untimed study" }),
      "(Untimed study, n.d.)",
    );
  });
  it("projects known references in prose while preserving technical and quoted material", function () {
    const labels = new Map([["1:AAAA1111", "(Smith, 2024)"]]);
    const source =
      "Read 1:AAAA1111 and AAAA1111; item 31. `AAAA1111` [paper](zotero://select/library/items/AAAA1111)\n> AAAA1111\n[[quote:AAAA1111]]";
    assert.equal(
      projectPaperReferences(source, labels),
      "Read (Smith, 2024) and (Smith, 2024); item 31. `AAAA1111` [paper](zotero://select/library/items/AAAA1111)\n> AAAA1111\n[[quote:AAAA1111]]",
    );
  });
});
