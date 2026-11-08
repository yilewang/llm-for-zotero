/**
 * The renderer shifts headings down one level, so "## Section" draws as h3.
 *
 * Answer typography follows one scale, set by the message text: headings,
 * list gaps and code are fractions of it, and paragraph gaps come from the
 * paragraph-spacing setting. So the whole answer grows and shrinks with the
 * font-scale setting, code blocks included, and nothing needs a second knob.
 */
import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

const ANSWER = [
  "Opening paragraph before the section.",
  "",
  "## Section heading",
  "",
  "First paragraph under the heading.",
  "",
  "Second paragraph with `inline code` in it.",
  "",
  "- First item",
  "- Second item",
  "  - Nested item",
  "",
  "```python",
  "value = 1",
  "```",
].join("\n");

describe("workflow: answer typography", function () {
  this.timeout(60000);

  it("sizes and spaces the answer from its message text and the font scale", async function () {
    assert.isTrue(Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"));
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    await api.reset();
    const fixture = await api.createPaperWithPdfFixture({
      title: "Answer typography fixture",
      pages: ["Fixture page text."],
    });
    try {
      await api.openStandaloneForItem(fixture.parentItemId);
      await api.seedStandaloneConversation([
        { role: "user", text: "Show the typography" },
        { role: "assistant", text: ANSWER },
      ]);
      // Reopen so the answer draws from stored history.
      await api.reset();
      await api.openStandaloneForItem(fixture.parentItemId);
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      const doc = win.document;
      let body: HTMLElement | null = null;
      const deadline = Date.now() + 15000;
      while (!body && Date.now() < deadline) {
        body = doc.querySelector<HTMLElement>(".llm-rendered-markdown h3")
          ?.parentElement as HTMLElement | null;
        if (!body) await Zotero.Promise.delay(50);
      }
      assert.isOk(body, "the seeded answer renders");
      const panel = body!.closest<HTMLElement>(".llm-panel")!;
      assert.isOk(panel, "the answer sits in a chat panel");
      const px = (el: Element, prop: string) =>
        Number.parseFloat(
          (win.getComputedStyle(el) as any).getPropertyValue(prop),
        );
      const near = (actual: number, expected: number, label: string) =>
        assert.closeTo(actual, expected, 0.6, label);

      const measure = () => {
        const paragraphs = Array.from(
          body!.querySelectorAll<HTMLElement>(":scope > p"),
        ) as HTMLElement[];
        const heading = body!.querySelector("h3")!;
        const items = Array.from(
          body!.querySelectorAll<HTMLElement>(":scope > ul > li"),
        ) as HTMLElement[];
        const nested = body!.querySelector("li > ul")!;
        const inline = paragraphs[2].querySelector("code")!;
        const block = body!.querySelector("pre code")!;
        const text = px(paragraphs[1], "font-size");
        return {
          scale: px(panel, "--llm-font-scale"),
          text,
          paragraphGap: px(paragraphs[1], "margin-bottom"),
          spacingSetting: px(panel, "--llm-message-paragraph-spacing"),
          heading: {
            size: px(heading, "font-size"),
            top: px(heading, "margin-top"),
            bottom: px(heading, "margin-bottom"),
            weight: px(heading, "font-weight"),
          },
          itemGap:
            items[1].getBoundingClientRect().top -
            items[0].getBoundingClientRect().bottom,
          nestedTop: px(nested, "margin-top"),
          inlineCode: {
            size: px(inline, "font-size"),
            family: win.getComputedStyle(inline)!.fontFamily,
          },
          blockCode: px(block, "font-size"),
        };
      };

      const base = measure();
      near(
        base.text,
        13 * base.scale,
        "message text is one step above UI text",
      );
      near(base.paragraphGap, base.spacingSetting, "paragraph gap = setting");
      near(
        base.heading.size,
        1.08 * base.text,
        "a section head is 1.08x the text",
      );
      near(base.heading.top, 1.3 * base.heading.size, "room above a heading");
      near(base.heading.bottom, 0.45 * base.heading.size, "short gap below");
      assert.equal(base.heading.weight, 600);
      near(
        base.itemGap,
        0.25 * base.text,
        "list items sit a quarter line apart",
      );
      near(base.nestedTop, 0.25 * base.text, "a nested list hugs its item");
      near(base.inlineCode.size, 0.875 * base.text, "inline code follows text");
      assert.notEqual(base.inlineCode.family, "monospace");
      near(base.blockCode, 0.875 * base.text, "code blocks follow the text");

      // A larger font scale grows the whole answer, code blocks included.
      const savedScale = panel.style.getPropertyValue("--llm-font-scale");
      panel.style.setProperty("--llm-font-scale", `${base.scale * 1.5}`);
      try {
        const scaled = measure();
        near(scaled.text, base.text * 1.5, "text follows the font scale");
        near(scaled.heading.size, base.heading.size * 1.5, "headings follow");
        near(scaled.itemGap, base.itemGap * 1.5, "list gaps follow");
        near(scaled.blockCode, base.blockCode * 1.5, "code blocks follow");
      } finally {
        panel.style.setProperty("--llm-font-scale", savedScale);
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
