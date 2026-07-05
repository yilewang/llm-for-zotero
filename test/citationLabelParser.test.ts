import { assert } from "chai";
import {
  citationLabelsCompatible,
  extractCitationAuthorKey,
  extractCitationYear,
  isCanonicalSourceCitationLabel,
  isLikelyStandaloneSourceCitationLabel,
  isNonSourceCitationLabel,
  normalizeCitationKey,
  normalizeCitationLabel,
  normalizeCitationLabelForMatch,
  parseStandaloneCitationLabel,
} from "../src/modules/contextPanel/citationLabelParser";

describe("citationLabelParser", function () {
  it("parses standalone source citation labels", function () {
    const cases = [
      ["(Smith, 2020)", "Smith, 2020"],
      ["(Smith et al., 2020)", "Smith et al., 2020"],
      ["(Smith & Jones, 2020)", "Smith & Jones, 2020"],
      ["(王, 2021)", "王, 2021"],
      ["(Paper 123)", "Paper 123"],
      [
        "(Attachment X, attachment under Smith, 2020)",
        "Attachment X, attachment under Smith, 2020",
      ],
    ] as const;

    for (const [raw, citationLabel] of cases) {
      const parsed = parseStandaloneCitationLabel(raw);
      assert.equal(parsed?.sourceLabel, `(${citationLabel})`, raw);
      assert.equal(parsed?.citationLabel, citationLabel, raw);
      assert.equal(parsed?.displayCitationLabel, citationLabel, raw);
      assert.isTrue(isCanonicalSourceCitationLabel(raw), raw);
    }
  });

  it("extracts citekeys, page labels, and leading cue text", function () {
    const withKey = parseStandaloneCitationLabel("(Smith, 2020 [smith2020])");
    assert.equal(withKey?.sourceLabel, "(Smith, 2020 [smith2020])");
    assert.equal(withKey?.citationLabel, "Smith, 2020 [smith2020]");
    assert.equal(withKey?.displayCitationLabel, "Smith, 2020");
    assert.equal(withKey?.citationKey, "smith2020");
    assert.equal(withKey?.normalizedCitationKey, "smith2020");

    const withPage = parseStandaloneCitationLabel("(Smith, 2020, page 12)");
    assert.equal(withPage?.sourceLabel, "(Smith, 2020)");
    assert.equal(withPage?.citationLabel, "Smith, 2020");
    assert.equal(withPage?.pageLabel, "12");

    const withCue = parseStandaloneCitationLabel("(as in Kossio et al)");
    assert.equal(withCue?.displayCitationLabel, "as in Kossio et al");
    assert.equal(withCue?.citationLabel, "Kossio et al");
  });

  it("rejects non-source and non-standalone labels", function () {
    for (const label of [
      "(Figure 1)",
      "(Methods)",
      "(Supplementary Fig. 2)",
      "(Smith, 2020; Jones, 2021)",
      "Smith (2020)",
      "(Smith (2020))",
      "According to (Smith, 2020), this changed.",
    ]) {
      assert.isNull(parseStandaloneCitationLabel(label), label);
    }

    assert.isTrue(isNonSourceCitationLabel("(Figure 1)"));
    assert.isFalse(isCanonicalSourceCitationLabel("(Figure 1)"));
  });

  it("normalizes matching keys for ranking and compatibility", function () {
    assert.equal(normalizeCitationLabel("(Smith, 2020)"), "(smith, 2020)");
    assert.equal(normalizeCitationKey(" Smith 2020 "), "smith2020");
    assert.equal(
      normalizeCitationLabelForMatch("(Smith, 2020, page 12)"),
      "(smith, 2020)",
    );
    assert.isTrue(
      citationLabelsCompatible("(Smith, 2020, page 12)", "(Smith, 2020)"),
    );
    assert.equal(extractCitationAuthorKey("(Smith et al., 2020)"), "smith");
    assert.equal(extractCitationYear("(Smith et al., 2020)"), "2020");
    assert.isTrue(isLikelyStandaloneSourceCitationLabel("Smith & Jones"));
  });
});
