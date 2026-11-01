import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

// A web page in a chat answer is as tall as its content. A page taller than
// 420px folds there, and "Show the whole page" shows all of it. A themed page
// sits right on the chat; a page with its own white background gets a white
// card. These tests read the real frames and pixels in Zotero.
describe("workflow: chat web page previews fit their page", function () {
  this.timeout(90000);
  const darkPref = "ui.systemUsesDarkTheme";
  const FOLD = 420;
  let api: WorkflowTestApi;
  let paper: Awaited<ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>>;

  // Model pages often paint the theme background themselves.
  const shortPage = `<style>body{background:var(--llm-bg)}</style><div style="color:var(--llm-text);background:var(--llm-bg)"><p style="font-size:20px;text-align:center">L = &sum; (y - &sigma;x - &beta;)<sup>2</sup> + b</p><p>Choose &sigma;, &beta;, and b to minimize the loss.</p></div>`;
  const longPage = `<!doctype html><html><head><title>A quasicontinuous ring attractor</title></head><body style="color:var(--llm-text)"><h1>A ring that remembers</h1>${Array.from(
    { length: 14 },
    (_, i) =>
      `<p style="color:var(--llm-muted)">Paragraph ${i + 1}: a bump of activity sits on the ring and drifts slowly when the input is removed.</p>`,
  ).join("")}</body></html>`;
  const paperPage = `<div style="background:#ffffff;color:#222"><p>A page with its own white background.</p></div>`;
  const answer = [
    "Short page:",
    "```html\n" + shortPage + "\n```",
    "Long page:",
    "```html\n" + longPage + "\n```",
    "Paper page:",
    "```html\n" + paperPage + "\n```",
  ].join("\n\n");

  async function saveWindow(win: any, filename: string) {
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    const scale = win.devicePixelRatio || 1;
    canvas.width = win.innerWidth * scale;
    canvas.height = win.innerHeight * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(win, 0, 0, win.innerWidth, win.innerHeight, "#ffffff");
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    await win.IOUtils.write(
      `${Zotero.DataDirectory.dir}/${filename}`,
      Uint8Array.from(binary, (char: string) => char.charCodeAt(0)),
    );
  }

  // One window pixel as [r, g, b].
  function pixel(win: any, x: number, y: number): number[] {
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    ) as HTMLCanvasElement;
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d") as any;
    context.drawWindow(win, Math.round(x), Math.round(y), 1, 1, "#ff00ff");
    const data = context.getImageData(0, 0, 1, 1).data as Uint8ClampedArray;
    return [data[0], data[1], data[2]];
  }

  function assertSameColor(a: number[], b: number[], label: string) {
    const diff = Math.max(...a.map((value, i) => Math.abs(value - b[i])));
    assert.isAtMost(diff, 3, `${label}: ${a} vs ${b}`);
  }

  const frameOf = (preview: HTMLElement) =>
    preview.querySelector(":scope > iframe") as HTMLIFrameElement;
  const contentHeight = (frame: HTMLIFrameElement) =>
    frame.contentDocument!.documentElement.getBoundingClientRect().height;
  const frameHeight = (frame: HTMLIFrameElement) =>
    frame.getBoundingClientRect().height;
  const frame2 = (win: any) =>
    new Promise<void>((resolve) =>
      win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)),
    );

  async function waitForPreviews(doc: Document): Promise<HTMLElement[]> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const previews = Array.from(
        doc.querySelectorAll(".llm-html-preview"),
      ) as HTMLElement[];
      if (
        previews.length === 3 &&
        previews.every((p) => frameOf(p)?.style.height)
      ) {
        // Late layout (fonts) settles within the fit's rechecks.
        await Zotero.Promise.delay(600);
        return previews;
      }
      await Zotero.Promise.delay(50);
    }
    throw new Error("the web page previews were not fitted");
  }

  async function checkPreviews(win: any, label: string, png: string) {
    const doc = win.document as Document;
    const [short, long, white] = await waitForPreviews(doc);

    // Short page: the whole page, at its content height, no inner scroll.
    const shortFrame = frameOf(short);
    assert.equal(short.getAttribute("data-llm-html-tall"), "false", label);
    assert.closeTo(
      frameHeight(shortFrame),
      contentHeight(shortFrame),
      2,
      `${label}: the short page frame is as tall as its content`,
    );
    const shortPage = shortFrame.contentDocument!;
    assert.isAtMost(
      shortPage.documentElement.scrollHeight,
      Math.ceil(frameHeight(shortFrame)) + 1,
      `${label}: the short page does not scroll inside its frame`,
    );
    assert.isBelow(contentHeight(shortFrame), FOLD, label);
    assert.equal(
      win.getComputedStyle(short.querySelector(".llm-content-expand-btn"))
        .display,
      "none",
      `${label}: a short page has no expand button`,
    );
    assert.notEqual(
      (shortFrame.contentWindow as any).getComputedStyle(shortPage.body)
        .fontFamily,
      "serif",
      `${label}: the page takes the chat font`,
    );

    // Themed page: no box. A pixel inside the frame where the page draws
    // nothing matches the chat just outside the frame.
    short.scrollIntoView({ block: "center" });
    await frame2(win);
    const rect = shortFrame.getBoundingClientRect();
    const x = rect.right - 6;
    assertSameColor(
      pixel(win, x, rect.top + rect.height / 2),
      pixel(win, x, rect.top - 4),
      `${label}: the themed page sits on the chat`,
    );
    assertSameColor(
      pixel(win, x, rect.bottom - 2),
      pixel(win, x, rect.top - 4),
      `${label}: no box at the themed page's bottom`,
    );

    // Paper page: a white card as tall as its page.
    const whiteFrame = frameOf(white);
    assert.equal(white.getAttribute("data-llm-preview-surface"), "paper");
    assert.closeTo(
      frameHeight(whiteFrame),
      contentHeight(whiteFrame),
      2,
      `${label}: the paper page frame is as tall as its content`,
    );
    white.scrollIntoView({ block: "center" });
    await frame2(win);
    const whiteRect = whiteFrame.getBoundingClientRect();
    assertSameColor(
      pixel(win, whiteRect.right - 4, whiteRect.top + 3),
      [255, 255, 255],
      `${label}: the paper page is on a white card`,
    );

    // Long page: folded at 420px with the button, then shown whole.
    const longFrame = frameOf(long);
    const fullHeight = contentHeight(longFrame);
    assert.isAbove(fullHeight, FOLD + 50, label);
    assert.equal(long.getAttribute("data-llm-html-tall"), "true", label);
    assert.closeTo(
      frameHeight(longFrame),
      FOLD,
      1,
      `${label}: the long page folds at 420px`,
    );
    const expand = long.querySelector(
      ".llm-content-expand-btn",
    ) as HTMLButtonElement;
    long.scrollIntoView({ block: "center" });
    await frame2(win);
    assert.notEqual(win.getComputedStyle(expand).display, "none", label);
    assert.isAbove(expand.getBoundingClientRect().height, 0, label);
    assert.equal(expand.textContent, "Show the whole page", label);
    await saveWindow(win, `${png}-folded.png`);
    expand.click();
    await frame2(win);
    assert.closeTo(
      frameHeight(longFrame),
      fullHeight,
      2,
      `${label}: the whole page shows after the click`,
    );
    assert.isAtMost(
      longFrame.contentDocument!.documentElement.scrollHeight,
      Math.ceil(frameHeight(longFrame)) + 1,
      `${label}: the whole page does not scroll inside its frame`,
    );
    assert.equal(expand.textContent, "Show less", label);
    expand.scrollIntoView({ block: "center" });
    await frame2(win);
    await saveWindow(win, `${png}-expanded.png`);
    expand.click();
    await frame2(win);
    assert.closeTo(frameHeight(longFrame), FOLD, 1, `${label}: Show less`);
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    paper = await api.createPaperWithPdfFixture({
      title: "Web page preview paper",
      pages: ["Disposable paper for web page previews."],
    });
  });

  afterEach(async function () {
    Services.prefs.clearUserPref(darkPref);
    await api.closeStandalone();
    await api.reset();
    if (paper) await api.cleanupFixture(paper);
  });

  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";

    it(`fits web pages in the standalone window (${theme})`, async function () {
      Services.prefs.setIntPref(darkPref, dark ? 1 : 0);
      await api.openStandaloneForItem(paper.parentItemId);
      await api.clickStandaloneTab("paper");
      await api.resizeStandaloneWindow(1050, 900);
      await api.seedStandaloneConversation([
        { role: "user", text: "Show me the pages." },
        { role: "assistant", text: answer },
      ]);
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow;
      await checkPreviews(
        win,
        `standalone ${theme}`,
        `html-preview-fit-standalone-${theme}`,
      );
    });

    it(`fits web pages in the sidebar panel (${theme})`, async function () {
      Services.prefs.setIntPref(darkPref, dark ? 1 : 0);
      Zotero.getMainWindow().focus();
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const win = Zotero.getMainWindow() as any;
      const body = win.document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      ) as HTMLElement;
      // The harness parks the panel off screen; bring it into view so its
      // pixels can be read.
      Object.assign(body.style, {
        position: "fixed",
        left: "20px",
        top: "0px",
        zIndex: "99999",
        width: "380px",
        height: "860px",
      });
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Show me the pages.",
        answer,
      );
      await checkPreviews(
        win,
        `sidebar ${theme}`,
        `html-preview-fit-sidebar-${theme}`,
      );
    });
  }
});
