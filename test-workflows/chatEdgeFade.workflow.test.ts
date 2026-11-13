import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

// The chat text fades out at the top and bottom edges of the scroll area,
// in the sidebar panel and in the standalone window, only where more of the
// chat is past that edge. These tests read the rendered pixels, so a mask
// that is overridden or lands on the wrong element fails here.
describe("workflow: soft fade at the chat edges", function () {
  this.timeout(90000);
  const darkPref = "ui.systemUsesDarkTheme";
  let api: WorkflowTestApi;
  let paper: Awaited<ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>>;
  const longAnswer = Array.from(
    { length: 35 },
    (_, i) =>
      `Paragraph ${i + 1}. A neural population can represent a stimulus through the pattern of activity across many neurons, and the reader scrolls through this text.`,
  ).join("\n\n");
  const settle = () => Zotero.Promise.delay(400);

  async function scrollTo(box: HTMLDivElement, top: number) {
    const owner = box.ownerDocument.defaultView!;
    box.dispatchEvent(new owner.WheelEvent("wheel", { deltaY: -100 }));
    box.scrollTop = top;
    box.dispatchEvent(new owner.Event("scroll"));
    // The frame scheduler sets the fade; there is no transition to wait for.
    // Wait for the expected top fade, then two more frames to paint it.
    const frame = () =>
      new Promise<void>((resolve) =>
        owner.requestAnimationFrame(() => resolve()),
      );
    const expectedTop = () =>
      `${Math.round(Math.min(Math.max(box.scrollTop, 0), 10))}px`;
    const deadline = Date.now() + 400;
    while (
      box.style.getPropertyValue("--llm-edge-fade-top") !== expectedTop() &&
      Date.now() < deadline
    )
      await frame();
    await frame();
    await frame();
  }

  function fadeHeights(box: HTMLDivElement) {
    return [
      box.style.getPropertyValue("--llm-edge-fade-top"),
      box.style.getPropertyValue("--llm-edge-fade-bottom"),
    ];
  }

  // Pixels of one strip of the chat, in window coordinates.
  function capture(
    box: HTMLDivElement,
    top: number,
    height: number,
    span?: { left: number; width: number },
  ) {
    const win = box.ownerDocument.defaultView as any;
    const rect = box.getBoundingClientRect();
    // Leave out the scrollbar strip on the right and the padding.
    const left = span?.left ?? rect.left + 12;
    const width = span?.width ?? rect.width - 30;
    const canvas = box.ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    ) as HTMLCanvasElement;
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const context = canvas.getContext("2d") as any;
    context.drawWindow(win, left, top, width, height, "#ffffff");
    return context.getImageData(0, 0, canvas.width, canvas.height)
      .data as Uint8ClampedArray;
  }

  // How far the strip's pixels stray from its most common colour: the text.
  function ink(data: Uint8ClampedArray) {
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const background = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const bg = [
      (background >> 16) & 255,
      (background >> 8) & 255,
      background & 255,
    ];
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      total +=
        Math.abs(data[i] - bg[0]) +
        Math.abs(data[i + 1] - bg[1]) +
        Math.abs(data[i + 2] - bg[2]);
    }
    return total;
  }

  // The ink of one strip with the mask and without it. A strip can fall
  // between two lines, so it is summed over a paragraph's height of scroll
  // positions.
  async function stripInk(
    box: HTMLDivElement,
    top: number,
    height: number,
    span?: { left: number; width: number },
  ) {
    const start = box.scrollTop;
    let masked = 0;
    let plain = 0;
    for (const shift of [0, 7, 14, 21, 28, 35, 42, 49, 56]) {
      await scrollTo(box, start + shift);
      masked += ink(capture(box, top, height, span));
      box.style.setProperty("mask-image", "none");
      plain += ink(capture(box, top, height, span));
      box.style.removeProperty("mask-image");
    }
    await scrollTo(box, start);
    return { masked, plain };
  }

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

  const parts = (box: HTMLDivElement) => {
    const main = box.closest<HTMLElement>("#llm-main")!;
    return {
      main,
      shortcuts: main.querySelector<HTMLElement>("#llm-shortcuts")!,
      composer: main.querySelector<HTMLElement>(":scope > .llm-input-section")!,
    };
  };
  const rect = (node: Element) => node.getBoundingClientRect();

  // The chips and the composer float over the bottom of the chat: the chat
  // runs down behind the composer, the chips sit 6 px above the composer,
  // and the chat shows between the chips.
  async function checkFloating(box: HTMLDivElement, label: string) {
    const win = box.ownerDocument.defaultView!;
    const { main, shortcuts, composer } = parts(box);
    assert.closeTo(
      rect(composer).bottom,
      rect(box).bottom,
      1,
      `${label}: the chat runs down behind the composer`,
    );
    const chips = Array.from(shortcuts.children) as HTMLElement[];
    assert.isNotEmpty(chips, `${label}: paper chat shows shortcut chips`);
    const row = rect(shortcuts);
    assert.closeTo(row.bottom, rect(composer).top - 6, 1, label);
    assert.equal(
      main.style.getPropertyValue("--llm-shortcuts-overlay"),
      `${Math.round(row.height)}px`,
      label,
    );
    assert.equal(
      main.style.getPropertyValue("--llm-composer-overlay"),
      `${Math.round(rect(composer).height)}px`,
      label,
    );
    assert.notEqual(
      win.getComputedStyle(chips[0])!.backgroundColor,
      "rgba(0, 0, 0, 0)",
      `${label}: a chip hides the chat behind it`,
    );
    // Past the last chip, the pointer reaches the chat behind the row, and
    // on the composer it reaches the composer.
    const lastChip = rect(chips[chips.length - 1]);
    const besideChips = box.ownerDocument.elementFromPoint(
      Math.min(lastChip.right + 20, row.right - 30),
      lastChip.top + lastChip.height / 2,
    );
    assert.isTrue(
      box.contains(besideChips),
      `${label}: the chat is under the row (${besideChips?.className})`,
    );
    const onComposer = box.ownerDocument.elementFromPoint(
      rect(composer).left + 40,
      rect(composer).top + rect(composer).height / 2,
    );
    assert.isTrue(
      composer.contains(onComposer),
      `${label}: the composer is on top (${onComposer?.className})`,
    );
    // Library chat empties the row; then only the composer floats.
    shortcuts.replaceChildren();
    await settle();
    assert.equal(win.getComputedStyle(shortcuts)!.display, "none", label);
    assert.equal(
      main.style.getPropertyValue("--llm-shortcuts-overlay"),
      "0px",
      label,
    );
    assert.closeTo(rect(composer).bottom, rect(box).bottom, 1, label);
    shortcuts.replaceChildren(...chips);
    await settle();
  }

  async function checkFades(box: HTMLDivElement, label: string) {
    const win = box.ownerDocument.defaultView!;
    await checkFloating(box, label);
    assert.include(
      win.getComputedStyle(box)!.maskImage,
      "linear-gradient",
      `${label}: the chat scroll area carries the edge mask`,
    );
    const max = box.scrollHeight - box.clientHeight;
    const { shortcuts, composer } = parts(box);

    await scrollTo(box, Math.round(max / 2));
    assert.deepEqual(fadeHeights(box), ["10px", "10px"], label);
    const top = await stripInk(box, rect(box).top, 6);
    assert.isAbove(top.plain, 0, `${label}: text reaches the top edge`);
    assert.isBelow(top.masked, top.plain * 0.6, `${label}: the top edge fades`);

    // Beside the chips the text is fading; between the chips and the
    // composer it is faint but still there.
    const row = rect(shortcuts);
    const chips = shortcuts.querySelectorAll(".llm-shortcut-btn");
    const lastChip = rect(chips[chips.length - 1]);
    const beside = await stripInk(
      box,
      lastChip.top + lastChip.height / 2 - 4,
      8,
      {
        left: lastChip.right + 8,
        width: Math.max(40, row.right - lastChip.right - 40),
      },
    );
    assert.isAbove(beside.plain, 0, `${label}: text passes behind the chips`);
    assert.isBelow(
      beside.masked,
      beside.plain * 0.85,
      `${label}: the text fades behind the chips`,
    );
    assert.isAbove(
      beside.masked,
      beside.plain * 0.2,
      `${label}: the text stays visible behind the chips`,
    );
    const below = await stripInk(box, rect(composer).top - 5, 4);
    assert.isAbove(below.plain, 0, `${label}: text reaches the composer`);
    assert.isBelow(
      below.masked,
      below.plain * 0.5,
      `${label}: the text is faint just above the composer`,
    );
    assert.isAbove(
      below.masked,
      0,
      `${label}: the text runs on to the composer`,
    );

    await scrollTo(box, 0);
    assert.deepEqual(fadeHeights(box), ["0px", "10px"], `${label}: at the top`);
    await scrollTo(box, max);
    assert.deepEqual(
      fadeHeights(box),
      ["10px", "0px"],
      `${label}: at the bottom`,
    );
    assert.isAtMost(
      rect(box.lastElementChild!).bottom,
      rect(shortcuts).top + 1,
      `${label}: the last message clears the chips`,
    );
    await scrollTo(box, Math.round(max / 2));
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    paper = await api.createPaperWithPdfFixture({
      title: "Edge fade paper",
      pages: ["Disposable paper for the chat edge fade."],
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

    it(`fades both edges in the sidebar panel (${theme})`, async function () {
      Services.prefs.setIntPref(darkPref, dark ? 1 : 0);
      // A standalone window left in front by the previous test would leave
      // the main window in the background, where its observers lag.
      Zotero.getMainWindow().focus();
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const body = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      )!;
      // The harness parks the panel off screen; bring it into view so its
      // pixels can be read.
      body.style.position = "fixed";
      body.style.left = "20px";
      body.style.top = "0px";
      body.style.zIndex = "99999";
      body.style.width = "340px";
      body.style.height = "560px";
      const shell = body.querySelector<HTMLElement>(".llm-chat-shell")!;
      shell.style.flex = "1 1 0";
      shell.style.height = "auto";
      shell.style.minHeight = "80px";
      shell.style.maxHeight = "none";
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Explain the paper in detail.",
        longAnswer,
      );
      await settle();
      const box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
      assert.isAbove(box.scrollHeight - box.clientHeight, 1000);
      await checkFades(box, `sidebar ${theme}`);
      await saveWindow(doc.defaultView, `edge-fade-sidebar-${theme}.png`);
    });

    it(`fades both edges in the standalone window (${theme})`, async function () {
      Services.prefs.setIntPref(darkPref, dark ? 1 : 0);
      await api.openStandaloneForItem(paper.parentItemId);
      await api.clickStandaloneTab("paper");
      await api.resizeStandaloneWindow(1050, 730);
      await api.seedStandaloneConversation([
        { role: "user", text: "Explain the paper in detail." },
        { role: "assistant", text: longAnswer },
      ]);
      await settle();
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow;
      const box = win.document.querySelector("#llm-chat-box") as HTMLDivElement;
      assert.isAbove(box.scrollHeight - box.clientHeight, 1000);
      // The chat runs up under the lower 5 px of the title row. Below the
      // row's text, the click target is the chat, not the title row.
      const title = win.document.querySelector(
        ".llm-standalone-content-wrapper > .llm-standalone-content-title",
      ) as HTMLElement;
      const titleText = title.querySelector(
        ".llm-standalone-content-title-text",
      ) as HTMLElement;
      const boxTop = box.getBoundingClientRect().top;
      const hit = win.document.elementFromPoint(
        box.getBoundingClientRect().left + 40,
        Math.max(boxTop, titleText.getBoundingClientRect().bottom) + 2,
      );
      assert.isTrue(
        box.contains(hit),
        `standalone ${theme}: ${hit?.className}`,
      );
      assert.closeTo(
        boxTop,
        title.getBoundingClientRect().bottom - 5,
        1,
        `standalone ${theme}: the chat starts under the title row`,
      );
      // ...exactly at the title buttons' lower edge, so text never runs
      // into a button's hover fill.
      for (const button of Array.from(
        title.querySelectorAll(
          ".llm-standalone-content-title-actions > button",
        ),
      ) as HTMLElement[]) {
        if (button.hidden) continue;
        assert.closeTo(
          button.getBoundingClientRect().bottom,
          boxTop,
          0.5,
          `standalone ${theme}: ${button.className} ends where the chat starts`,
        );
      }
      await checkFades(box, `standalone ${theme}`);
      await saveWindow(win, `edge-fade-standalone-${theme}.png`);
    });
  }
});
