import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/**
 * The Task progress row keeps one padding rule: the last mark on the right
 * (the →| button in the standalone window, the chevron in Zotero's side
 * pane) ends as far in from the card's right edge as the status ring starts
 * from its left edge. These read the painted pixels of the row, in light and
 * dark, in a wide and a narrow standalone window and in the side pane, and
 * save a picture of each for a person to look at.
 */
describe("workflow: Task progress row padding", function () {
  this.timeout(180000);
  const darkPref = "ui.systemUsesDarkTheme";
  const prefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const saved = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let paper: Awaited<ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>>;
  const turns = [
    {
      user: { text: "Explain representational drift in CA1" },
      answer: "Drift is a gradual change in which cells fire.",
      events: [
        { type: "status", text: "Reading" },
        { type: "final", text: "Drift is a gradual change." },
      ] as never,
    },
  ];

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 15000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(25);
    assert.isTrue(check(), message);
  }

  /** Pixels of a window rectangle, at the screen's own resolution. */
  function pixels(
    win: any,
    rect: { left: number; top: number; width: number; height: number },
  ) {
    const scale = win.devicePixelRatio || 1;
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(
      win,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      "#ff00ff",
    );
    return {
      scale,
      width: canvas.width,
      height: canvas.height,
      data: context.getImageData(0, 0, canvas.width, canvas.height)
        .data as Uint8ClampedArray,
      canvas,
    };
  }

  async function save(win: any, canvas: any, filename: string) {
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    await win.IOUtils.write(
      `${Zotero.DataDirectory.dir}/${filename}`,
      Uint8Array.from(binary, (char: string) => char.charCodeAt(0)),
    );
  }

  /**
   * How far in from the card's outer edges the row's first and last painted
   * marks sit, in CSS pixels. The card's 1px border is left out of the scan.
   */
  function insets(win: any, card: HTMLElement, row: HTMLElement) {
    const c = card.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const shot = pixels(win, {
      left: c.left + 2,
      top: r.top + 6,
      width: c.width - 4,
      height: r.height - 12,
    });
    const { data, width, height } = shot;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const ink = (x: number) => {
      for (let y = 0; y < height; y++) {
        const i = (y * width + x) * 4;
        const d =
          Math.abs(data[i] - ((bg >> 16) & 255)) +
          Math.abs(data[i + 1] - ((bg >> 8) & 255)) +
          Math.abs(data[i + 2] - (bg & 255));
        if (d > 60) return true;
      }
      return false;
    };
    let first = 0;
    while (first < width && !ink(first)) first++;
    let last = width - 1;
    while (last >= 0 && !ink(last)) last--;
    return {
      left: 2 + first / shot.scale,
      right: 2 + (width - 1 - last) / shot.scale,
    };
  }

  before(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    for (const [name, value] of prefs) {
      saved.set(name, Zotero.Prefs.get(name, true));
      Zotero.Prefs.set(name, value as never, true);
    }
    paper = await api.createPaperWithPdfFixture({
      title: "Place cells in a familiar arena",
      pdfTitle: "Place cells in a familiar arena",
      pages: ["Place cell evidence."],
    });
  });

  after(async function () {
    Services.prefs.clearUserPref(darkPref);
    await api.closeStandalone().catch(() => undefined);
    await api.reset();
    if (paper) await api.cleanupFixture(paper);
    for (const [name, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(name, true);
      else Zotero.Prefs.set(name, value as never, true);
    }
  });

  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";

    it(`standalone window: →| keeps the row's padding (${theme})`, async function () {
      Services.prefs.setIntPref(darkPref, dark ? 1 : 0);
      await api.openStandaloneForItem(paper.parentItemId);
      await api.resizeStandaloneWindow(1100, 760);
      await api.clickStandaloneTab("open");
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow;
      const doc = win.document as Document;
      const root = () =>
        doc.querySelector(".llm-standalone-content #llm-main") as HTMLElement;
      await until(
        () => root()?.dataset.conversationKind === "global",
        "the window shows Library chat",
      );
      await api.seedTaskProgressConversation({ surface: "standalone", turns });
      await api.reopenTaskProgressConversation({ surface: "standalone" });
      const curtain = () =>
        root().querySelector(".llm-task-progress-curtain") as HTMLElement;
      if (curtain().dataset.curtain !== "open") {
        (
          doc.querySelector(
            ".llm-standalone-content-title-actions .llm-standalone-icon-task-progress",
          ) as HTMLButtonElement
        ).click();
      }
      await until(() => {
        api.flushTaskProgress();
        return curtain().dataset.curtain === "open";
      }, "the Task progress row is down in the chat");
      for (const width of [1100, 500]) {
        await api.resizeStandaloneWindow(width, 760);
        await Zotero.Promise.delay(400);
        const card = root().querySelector(
          ".llm-task-progress-card",
        ) as HTMLElement;
        const row = root().querySelector("#llm-task-progress") as HTMLElement;
        assert.equal(card.dataset.movable, "true", "the row has its →|");
        const got = insets(win, card, row);
        Zotero.debug(
          `[edge-padding] standalone ${theme} ${width}px: left ${got.left} right ${got.right}`,
        );
        assert.closeTo(
          got.right,
          got.left,
          1,
          `standalone ${theme} ${width}px: →| ends as far in as the ring starts`,
        );
        const c = card.getBoundingClientRect();
        const t = doc
          .querySelector(
            ".llm-standalone-content-wrapper > .llm-standalone-content-title",
          )!
          .getBoundingClientRect();
        const shot = pixels(win, {
          left: Math.max(0, c.left - 12),
          top: t.top,
          width: c.width + 24,
          height: c.bottom - t.top + 12,
        });
        await save(
          win,
          shot.canvas,
          `tp-edge-standalone-${width}-${theme}.png`,
        );
      }
      // Moved to the side panel: a picture of the whole window, for a
      // person to check the side panel's title row by eye.
      await api.resizeStandaloneWindow(1100, 760);
      await Zotero.Promise.delay(300);
      (root().querySelector(".llm-task-progress-move") as HTMLElement).click();
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          doc.querySelector(
            ".llm-standalone-side-panel-task-progress:not([hidden]) .llm-task-progress-dock-question",
          ),
        );
      }, "Task progress shows in the side panel");
      await Zotero.Promise.delay(400);
      const whole = pixels(win, {
        left: 0,
        top: 0,
        width: win.innerWidth,
        height: win.innerHeight,
      });
      await save(win, whole.canvas, `tp-edge-docked-${theme}.png`);
      (
        doc.querySelector(
          ".llm-standalone-side-panel-task-progress .llm-task-progress-back",
        ) as HTMLElement
      )?.click();
      await Zotero.Promise.delay(300);
      await api.closeStandalone();
    });

    it(`side pane: the chevron keeps the row's padding (${theme})`, async function () {
      Services.prefs.setIntPref(darkPref, dark ? 1 : 0);
      const win = Zotero.getMainWindow() as any;
      win.focus();
      const panel = await api.renderPanelForItem(paper.parentItemId);
      const body = win.document.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      ) as HTMLElement;
      const host = body.closest("[data-llm-workflow-test]") as HTMLElement;
      const previous = host.getAttribute("style");
      host.style.left = "0";
      host.style.width = "380px";
      host.style.height = "700px";
      host.style.zIndex = "99999";
      host.style.background = "var(--material-background, #fff)";
      try {
        await api.seedTaskProgressConversation({
          panelId: panel.panelId,
          turns,
        });
        await api.reopenTaskProgressConversation({ panelId: panel.panelId });
        const row = () =>
          body.querySelector("#llm-task-progress") as HTMLElement;
        const curtain = () =>
          body.querySelector(".llm-task-progress-curtain") as HTMLElement;
        await Zotero.Promise.delay(300);
        api.flushTaskProgress();
        if (curtain()?.dataset.curtain !== "open") {
          (
            body.querySelector("#llm-task-progress-toggle") as HTMLElement
          ).click();
        }
        await until(() => {
          api.flushTaskProgress();
          return Boolean(row()) && !row().hidden;
        }, "the Task progress row shows");
        await Zotero.Promise.delay(500);
        const card = row().closest(".llm-task-progress-card") as HTMLElement;
        assert.notEqual(card.dataset.movable, "true", "no →| in the side pane");
        const got = insets(win, card, row());
        Zotero.debug(
          `[edge-padding] side pane ${theme}: left ${got.left} right ${got.right}`,
        );
        assert.closeTo(
          got.right,
          got.left,
          1,
          `side pane ${theme}: the chevron ends as far in as the ring starts`,
        );
        const c = card.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        const shot = pixels(win, {
          left: b.left,
          top: Math.max(b.top, c.top - 60),
          width: b.width,
          height: c.bottom - Math.max(b.top, c.top - 60) + 12,
        });
        await save(win, shot.canvas, `tp-edge-sidepane-${theme}.png`);
      } finally {
        if (previous === null) host.removeAttribute("style");
        else host.setAttribute("style", previous);
      }
    });
  }
});
