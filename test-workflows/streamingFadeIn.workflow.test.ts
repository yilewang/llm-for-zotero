import { assert } from "chai";
import {
  disposeStreamingMarkdown,
  renderStreamingMarkdownInto,
} from "../src/modules/contextPanel/streamingMarkdown";

describe("workflow: new streaming blocks fade in once", function () {
  this.timeout(30000);
  const FADE = "llm-streaming-fade-in";
  const delay = (ms: number) => Zotero.Promise.delay(ms);
  let doc: Document;
  let root: HTMLDivElement;
  let answer: HTMLDivElement;

  beforeEach(function () {
    doc = Zotero.getMainWindow().document;
    root = doc.createElement("div") as HTMLDivElement;
    root.style.cssText =
      "position:fixed;left:30px;top:30px;width:420px;z-index:2147483647;background:white";
    answer = doc.createElement("div") as HTMLDivElement;
    answer.className = "llm-agent-inline-text";
    root.appendChild(answer);
    doc.documentElement.appendChild(root);
  });

  afterEach(function () {
    if (answer) disposeStreamingMarkdown(answer);
    root?.remove();
  });

  async function render(source: string) {
    renderStreamingMarkdownInto(answer, source, doc, () => {});
    await delay(80);
  }
  const paragraph = (text: string) =>
    (Array.from(answer.querySelectorAll("p")) as HTMLElement[]).find(
      (p) => p.textContent?.trim() === text,
    )!;

  it("fades each new block, resumes it across redraws, and never replays it", async function () {
    const reducedMotion = doc.defaultView!.matchMedia(
      "(prefers-reduced-motion: reduce)",
    )!.matches;

    await render("Alpha");
    const alpha = paragraph("Alpha");
    assert.isTrue(alpha.classList.contains(FADE));
    const computed = doc.defaultView!.getComputedStyle(alpha)!;
    assert.equal(
      computed.animationName,
      reducedMotion ? "none" : FADE,
      "the stylesheet animates the block unless motion is reduced",
    );

    // Alpha moves from the redrawn tail into a committed block.
    await render("Alpha\n\nBeta");
    const committedAlpha = paragraph("Alpha");
    const beta = paragraph("Beta");
    assert.notStrictEqual(committedAlpha, alpha, "Alpha was redrawn");
    assert.isTrue(committedAlpha.classList.contains(FADE));
    assert.isBelow(
      parseFloat(committedAlpha.style.animationDelay),
      0,
      "the redrawn block resumes its fade",
    );
    assert.isTrue(beta.classList.contains(FADE));

    await delay(700);
    await render("Alpha\n\nBeta\n\nGamma");
    assert.isFalse(
      paragraph("Beta").classList.contains(FADE),
      "a block the reader has seen does not fade again",
    );
    assert.isTrue(paragraph("Gamma").classList.contains(FADE));

    // Positions keep counting past every block committed so far.
    await render("Alpha\n\nBeta\n\nGamma\n\nDelta");
    assert.isTrue(paragraph("Gamma").classList.contains(FADE));
    assert.isBelow(parseFloat(paragraph("Gamma").style.animationDelay), 0);
    assert.equal(paragraph("Delta").style.animationDelay, "0ms");
    if (!reducedMotion) {
      assert.isFalse(
        paragraph("Alpha").classList.contains(FADE),
        "the class is dropped when the fade ends",
      );
    }
  });
});
