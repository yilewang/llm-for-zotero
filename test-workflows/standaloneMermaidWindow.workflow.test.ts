import { assert } from "chai";
import { openStandaloneMermaidWindow } from "../src/modules/contextPanel/standaloneMermaidWindow";

describe("workflow: standalone Mermaid titlebar", function () {
  this.timeout(15000);

  it("keeps diagram controls clickable above the seamless titlebar", async function () {
    let viewer: Window | null = null;
    try {
      assert.isTrue(
        openStandaloneMermaidWindow(Zotero.getMainWindow().document, {
          svgMarkup:
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect width="300" height="100" fill="steelblue"/></svg>',
          source: "flowchart LR\nA --> B",
          themeKey: "light",
        }),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const windows = (Services as any).wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
          const candidate = windows.getNext() as Window;
          if (candidate.document.querySelector(".llm-mermaid-window-btn"))
            viewer = candidate;
        }
        if (viewer) break;
        await Zotero.Promise.delay(25);
      }
      assert.isOk(viewer, "Mermaid viewer must open");
      const win = viewer!;
      await Zotero.Promise.delay(100);
      const doc = win.document;
      const buttons = Array.from(
        doc.querySelectorAll(".llm-mermaid-window-btn"),
      ) as HTMLElement[];
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        for (const y of [
          rect.top + 2,
          rect.top + rect.height / 2,
          rect.bottom - 2,
        ]) {
          assert.isTrue(
            button.contains(
              doc.elementFromPoint(rect.left + rect.width / 2, y),
            ),
            `${button.title} must receive clicks over its full height`,
          );
        }
      }
      const strip = doc.querySelector(
        ".llm-window-titlebar",
      ) as HTMLElement | null;
      if (doc.documentElement.hasAttribute("customtitlebar")) {
        assert.isOk(strip);
        const stripRect = strip!.getBoundingClientRect();
        const buttonRect = buttons[0].getBoundingClientRect();
        assert.closeTo(
          buttonRect.top + buttonRect.height / 2,
          stripRect.top + stripRect.height / 2,
          0.5,
        );
        const canvas = doc.querySelector(
          ".llm-mermaid-window-viewport",
        ) as HTMLElement;
        assert.equal(
          win.getComputedStyle(strip!)?.backgroundColor,
          win.getComputedStyle(canvas)?.backgroundColor,
        );
      }
      const root = doc.querySelector(".llm-mermaid-window-root") as HTMLElement;
      const before = root.dataset.mermaidZoom;
      buttons[1].click();
      assert.notEqual(root.dataset.mermaidZoom, before);
    } finally {
      viewer?.close();
    }
  });
});
