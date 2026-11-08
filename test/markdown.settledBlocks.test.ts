import { assert } from "chai";
import { splitSettledMarkdownBlocks } from "../src/utils/markdown";

describe("settled Markdown blocks of a streaming reply", function () {
  it("covers a prefix of the reply and keeps the last two tokens open", function () {
    assert.deepEqual(splitSettledMarkdownBlocks("Alpha\n\nBeta\n\nGamma"), [
      "Alpha",
      "\n\n",
      "Beta",
    ]);
  });

  it("keeps a display equation in one block when a line inside looks like a list", function () {
    for (const [open, close] of [
      ["$$", "$$"],
      ["\\[", "\\]"],
    ]) {
      const equation = `${open}\na = b\n+ c\n- d\n${close}\n\n`;
      const settled = splitSettledMarkdownBlocks(
        `Intro.\n\n${equation}After.\n\nEnd.`,
      );
      assert.include(settled, equation, open);
      assert.isTrue(
        `Intro.\n\n${equation}After.\n\nEnd.`.startsWith(settled.join("")),
      );
    }
  });

  it("settles nothing from an equation whose closing delimiter has not arrived", function () {
    for (const opener of ["$$", "\\["]) {
      const settled = splitSettledMarkdownBlocks(
        `Intro.\n\n${opener}\na = b\n+ c\n- d\n- e\n\n- f`,
      );
      assert.equal(settled.join(""), "Intro.\n\n", opener);
    }
  });

  it("settles prose that holds inline display math", function () {
    const reply = "Hi $$x$$ is small.\n\nNext.\n\nLast.\n\nEnd.";
    assert.equal(
      splitSettledMarkdownBlocks(reply).join(""),
      "Hi $$x$$ is small.\n\nNext.\n\nLast.",
    );
  });

  it("settles a code block whose dollar pair opens no equation", function () {
    const reply = "```sh\n$$ echo\n```\n\nNext.\n\nLast.\n\nEnd.";
    assert.equal(
      splitSettledMarkdownBlocks(reply).join(""),
      "```sh\n$$ echo\n```\n\nNext.\n\nLast.",
    );
  });
});
