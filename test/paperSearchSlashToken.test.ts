import { assert } from "chai";
import { parsePaperSearchSlashToken } from "../src/modules/contextPanel/paperSearch";

describe("paperSearch slash token parsing", function () {
  it("keeps a single-word slash token active before whitespace", function () {
    const input = "/attention is all you need";
    const token = parsePaperSearchSlashToken(input, "/attention".length);

    assert.deepEqual(token, {
      query: "attention",
      slashStart: 0,
      caretEnd: "/attention".length,
    });
  });

  it("dismisses the slash token after typing whitespace", function () {
    const input = "/attention is all you need";
    const token = parsePaperSearchSlashToken(input, input.length);

    assert.isNull(token);
  });

  it("finds the most recent valid slash token in surrounding text", function () {
    const input = "Please compare /transformer 2017 vaswani";
    const token = parsePaperSearchSlashToken(
      input,
      input.indexOf(" ", input.indexOf("/transformer")) >= 0
        ? input.indexOf(" ", input.indexOf("/transformer"))
        : input.length,
    );

    assert.isNotNull(token);
    assert.equal(token?.query, "transformer");
    assert.equal(token?.slashStart, input.indexOf("/transformer"));
  });

  it("ignores slashes that are not preceded by whitespace or start-of-string", function () {
    const input = "Visit https://example.com/paper";
    const token = parsePaperSearchSlashToken(input, input.length);

    assert.isNull(token);
  });

  it("returns null when the caret is before the slash token", function () {
    const input = "prefix /retrieval augmented generation";
    const token = parsePaperSearchSlashToken(input, 4);

    assert.isNull(token);
  });
});
