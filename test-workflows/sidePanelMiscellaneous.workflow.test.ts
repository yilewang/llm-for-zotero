import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";
import {
  HTML_PREVIEW_CSP_META,
  HTML_PREVIEW_SANDBOX,
} from "../src/modules/contextPanel/htmlPreviewFrame";

/**
 * Sandboxed HTML preview, the "Move to side panel" buttons, item tabs, and
 * the Miscellaneous tab, in a real Zotero window.
 *
 * Chats are seeded without a model: assistant turns are rendered by the real
 * chat renderer, so the buttons, frames, and tabs are the shipped ones.
 *
 * A plan card is not seeded: a plan document needs a finalized, persisted
 * document record, which no existing seed helper builds.
 */

declare const Zotero: any;
declare const IOUtils: any;

const SHOT_DIR = PathUtils.join(
  PathUtils.tempDir,
  "llm-for-zotero-side-panel-misc-shots",
);

const MERMAID_FENCE = "```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```";
const SVG_FENCE =
  '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60"><rect width="120" height="60" fill="#4a90d9"/><circle cx="60" cy="30" r="18" fill="#f5a623"/></svg>\n```';
const HTML_FENCE =
  '```html\n<!DOCTYPE html><html><body style="font-family:sans-serif"><h3 id="hello">Hello preview</h3><script>\nvar d = document.documentElement;\nd.setAttribute("data-zotero", typeof Zotero);\nd.setAttribute("data-chromeutils", typeof ChromeUtils);\nd.setAttribute("data-components", typeof Components);\nd.setAttribute("data-components-classes", typeof Components === "undefined" ? "undefined" : typeof Components.classes);\nd.setAttribute("data-components-utils", typeof Components === "undefined" ? "undefined" : typeof Components.utils);\nd.setAttribute("data-origin", String(self.origin));\nd.setAttribute("data-parent", (function () { try { return String(parent.Zotero); } catch (e) { return "blocked"; } })());\nfetch("https://example.com").then(function () { d.setAttribute("data-fetch", "ok"); }, function () { d.setAttribute("data-fetch", "failed"); });\n</script></body></html>\n```';
const CODE_FENCE =
  "```python\ndef greet(name):\n    return f'hello {name}'\n```";

async function until(
  check: () => boolean | Promise<boolean>,
  describe: () => string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Zotero.Promise.delay(50);
  }
  if (await check()) return;
  assert.fail(describe());
}

/** Saves a PNG of `win`; never fails the test when drawWindow is missing. */
async function shoot(win: Window, name: string): Promise<void> {
  try {
    const doc = win.document;
    const width = Math.ceil(win.innerWidth);
    const height = Math.ceil(win.innerHeight);
    const scale = Number(win.devicePixelRatio) || 1;
    const canvas = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    ) as HTMLCanvasElement;
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d") as any;
    if (!ctx || typeof ctx.drawWindow !== "function") {
      throw new Error("drawWindow is unavailable");
    }
    ctx.scale(scale, scale);
    ctx.drawWindow(win, 0, 0, width, height, "#1e1e1e");
    const base64 = canvas.toDataURL("image/png").split(",")[1] || "";
    const binary = win.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await IOUtils.makeDirectory(SHOT_DIR, { ignoreExisting: true });
    await IOUtils.write(`${SHOT_DIR}/${name}`, bytes);
  } catch (error) {
    Zotero.debug(
      `[sidePanelMiscellaneous] screenshot ${name} skipped: ${error}`,
    );
  }
}

describe("workflow: html preview, move buttons, and the Miscellaneous tab", function () {
  this.timeout(240_000);

  let api: WorkflowTestApi;
  const fixtures: WorkflowTestFixture[] = [];
  let win: Window;

  const q = <T extends Element = HTMLElement>(sel: string) =>
    win.document.querySelector(sel) as T | null;
  const qa = <T extends Element = HTMLElement>(sel: string) =>
    Array.from(win.document.querySelectorAll(sel)) as T[];
  const mainBody = () => q(".llm-standalone-content")!;
  const itemTabs = () =>
    qa('.llm-standalone-side-panel-tab[data-side-tab-kind="item"]');
  const shownItemRoot = () =>
    qa('.llm-standalone-side-panel-item[data-side-view="item"]').find((el) => {
      const rect = el.getBoundingClientRect();
      return !el.hidden && rect.width > 0 && rect.height > 0;
    }) || null;
  // The flat style puts the →| button in the block's hover bar, a child of
  // the .llm-copyable wrapper and outside the element that carries
  // data-side-item-kind; older markup kept it inside that element.
  const moveButtonsOfKind = (root: ParentNode, kind: string): HTMLElement[] =>
    (
      Array.from(
        root.querySelectorAll(`[data-side-item-kind="${kind}"]`),
      ) as HTMLElement[]
    ).flatMap((el) => {
      const inBar = el
        .closest(".llm-copyable")
        ?.querySelector(":scope > .llm-content-bar > .llm-side-move-btn");
      if (inBar) return [inBar as HTMLElement];
      return Array.from(
        el.querySelectorAll(".llm-side-move-btn, :scope > .llm-side-move-btn"),
      ) as HTMLElement[];
    });
  const moveButton = (kind: string) =>
    moveButtonsOfKind(mainBody(), kind)[0] || null;

  before(function () {
    api = (Zotero as any).LLMForZotero?.api?.workflowTest;
    assert.isOk(api, "workflow test API should be installed");
  });

  beforeEach(async function () {
    await api.reset();
  });

  afterEach(async function () {
    await api.closeStandalone();
    for (const fixture of fixtures.splice(0)) {
      await api.cleanupFixture(fixture);
    }
    await api.reset();
  });

  after(async function () {
    await api.closeStandalone();
    await api.reset();
  });

  it("previews a complete html block in a sandboxed frame and adds no move buttons in the sidebar", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Html preview paper",
      pdfTitle: "Html preview paper PDF",
    });
    fixtures.push(fixture);
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    await api.renderAssistantForPanel(panel.panelId, {
      text: `Here is a page.\n\n${HTML_FENCE}\n\nAnd a diagram.\n\n${MERMAID_FENCE}\n\n${CODE_FENCE}`,
    });
    const mainWin = Zotero.getMainWindow() as Window;
    const root = mainWin.document.querySelector(
      `[data-workflow-panel-id="${panel.panelId}"]`,
    ) as HTMLElement;
    assert.isOk(root, "sidebar panel root");
    await until(
      () => Boolean(root.querySelector(".llm-html-preview iframe")),
      () => "html preview frame never mounted",
    );
    const preview = root.querySelector(".llm-html-preview") as HTMLElement;
    const frame = preview.querySelector("iframe") as HTMLIFrameElement;
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
    assert.equal(frame.getAttribute("sandbox"), HTML_PREVIEW_SANDBOX);
    const srcdoc = frame.getAttribute("srcdoc") || "";
    assert.include(srcdoc, HTML_PREVIEW_CSP_META, "srcdoc carries the CSP");
    assert.include(srcdoc, "<!DOCTYPE html>", "the doctype stays");
    assert.isBelow(
      srcdoc.indexOf(HTML_PREVIEW_CSP_META),
      srcdoc.indexOf("<script>"),
      "the CSP comes before any script",
    );
    // The page sets its own colours (none of the theme's), so it is shown on a
    // white card in every theme, with the light sheet after the CSP.
    assert.equal(preview.getAttribute("data-llm-preview-surface"), "paper");
    assert.include(
      srcdoc,
      `${HTML_PREVIEW_CSP_META}<style>:root{color-scheme:light}</style>`,
    );
    assert.equal(
      mainWin.getComputedStyle(preview)?.backgroundColor,
      "rgb(255, 255, 255)",
      "a paper page sits on a white card",
    );

    // The page ran, and reports what it could reach.
    let contentDoc: Document | null = null;
    await until(
      () => {
        try {
          contentDoc = frame.contentDocument;
          return Boolean(
            contentDoc?.documentElement?.getAttribute("data-zotero"),
          );
        } catch {
          return false;
        }
      },
      () => "the preview page never reported",
    );
    const read = (name: string) =>
      contentDoc!.documentElement.getAttribute(`data-${name}`);
    assert.equal(read("zotero"), "undefined", "typeof Zotero");
    assert.equal(read("chromeutils"), "undefined", "typeof ChromeUtils");
    // Web content keeps a legacy Components shim (DOM interface constants
    // only); what matters is that the privileged parts are absent.
    assert.equal(
      read("components-classes"),
      "undefined",
      "typeof Components.classes",
    );
    assert.equal(
      read("components-utils"),
      "undefined",
      "typeof Components.utils",
    );
    assert.equal(read("origin"), "null", "frame origin");
    assert.include(
      ["blocked", "undefined"],
      read("parent"),
      "parent.Zotero must not be reachable",
    );
    await until(
      () => Boolean(read("fetch")),
      () => "fetch outcome was never recorded",
    );
    assert.equal(read("fetch"), "failed", "the page has no network");
    let isNull: boolean | null = null;
    try {
      isNull = (contentDoc as any).nodePrincipal.isNullPrincipal;
    } catch {
      isNull = null;
    }
    if (isNull === null) {
      Zotero.debug("[sidePanelMiscellaneous] nodePrincipal not readable");
    } else {
      assert.isTrue(isNull, "the frame runs under a null principal");
    }

    assert.lengthOf(
      root.querySelectorAll(".llm-side-move-btn"),
      0,
      "the sidebar has no move buttons",
    );
    await Zotero.Promise.delay(300);
    preview.scrollIntoView?.({ block: "center" });
    await Zotero.Promise.delay(300);
    await shoot(mainWin, "sidebar-html-block.png");
  });

  it("recolors themed drawings and pages when the standalone window switches theme", async function () {
    const THEME_PREF = "browser.theme.toolbar-theme";
    const themedSvg =
      '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" width="120" height="60"><text x="4" y="14">Themed</text><path d="M4 50 L116 50" style="stroke:var(--llm-blue)"/></svg>\n```';
    const themedHtml =
      '```html\n<!DOCTYPE html><html><body><h3 style="color:var(--llm-text)">Themed page</h3></body></html>\n```';
    Zotero.Prefs.set(THEME_PREF, 1, true);
    try {
      const fixture = await api.createPaperWithPdfFixture({
        title: "Theme switch paper",
        pdfTitle: "Theme switch paper PDF",
      });
      fixtures.push(fixture);
      await api.openStandaloneForItem(fixture.parentItemId);
      win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      await api.seedStandaloneConversation([
        { role: "user", text: "Draw it in the theme colours" },
        {
          role: "assistant",
          text: `A drawing.\n\n${themedSvg}\n\nA page.\n\n${themedHtml}`,
        },
      ]);
      let drawing = () =>
        q('.llm-svg-preview[data-llm-preview-surface="themed"]');
      let page = () =>
        q('.llm-html-preview[data-llm-preview-surface="themed"]');
      const pageFrame = () => page()?.querySelector("iframe") || null;
      const state = () =>
        `drawing=${drawing()?.getAttribute("data-llm-preview-theme")} frame=${pageFrame()?.getAttribute("data-llm-preview-theme")}`;
      await until(
        () => state() === "drawing=light frame=light",
        () => `light theme: ${state()}`,
      );

      // Let the window settle, so no late render of its own hides a missed
      // theme change.
      await Zotero.Promise.delay(1000);
      // The previews already shown must follow the switch themselves, not be
      // replaced by a rebuilt answer.
      const shownDrawing = drawing()!;
      const shownPage = page()!;
      drawing = () => shownDrawing;
      page = () => shownPage;
      Zotero.Prefs.set(THEME_PREF, 0, true);
      await until(
        () => state() === "drawing=dark frame=dark",
        () => `after the switch to dark: ${state()}`,
      );
      const src = drawing()!.querySelector("img")!.getAttribute("src") || "";
      assert.include(
        win.atob(src.split(",")[1] || ""),
        'data-llm-theme="dark"',
        "the drawing carries the dark sheet",
      );
      assert.include(
        pageFrame()!.getAttribute("srcdoc") || "",
        ":root{color-scheme:dark;",
        "the new frame carries the dark sheet",
      );
    } finally {
      Zotero.Prefs.clear(THEME_PREF, true);
    }
  });

  it("moves each item kind into its own tab, focuses instead of duplicating, and shows the source", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Move buttons paper",
      pdfTitle: "Move buttons paper PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);
    await api.resizeStandaloneWindow(1300, 800);
    win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
    // A past chat for the History tab, then the main chat.
    const past = await api.seedStandaloneConversation([
      { role: "user", text: "misc-past-question" },
      { role: "assistant", text: "misc-past-answer" },
    ]);
    await Zotero.DB.queryAsync(
      `UPDATE llm_for_zotero_paper_conversations
          SET user_turn_count = 1, title = ?, last_activity_at = ?
        WHERE conversation_key = ?`,
      ["Miscellaneous past chat", Date.now(), Number(past.conversationKey)],
    );
    await api.startNewStandaloneConversation();
    await api.seedStandaloneConversation([
      { role: "user", text: "Draw me a flow and a figure" },
      {
        role: "assistant",
        text: `Diagram first.\n\n${MERMAID_FENCE}\n\nThen the figure.\n\n${SVG_FENCE}`,
      },
      { role: "user", text: "Now a page and some code" },
      {
        role: "assistant",
        text: `The page.\n\n${HTML_FENCE}\n\nThe code.\n\n${CODE_FENCE}`,
      },
      { role: "user", text: "Summarise in one line" },
      { role: "assistant", text: "A plain answer about nothing at all." },
    ]);
    await until(
      () => qa(".llm-side-move-btn").length >= 4,
      () => `move buttons: ${qa(".llm-side-move-btn").length}`,
      30_000,
    );
    await Zotero.Promise.delay(500);

    const kinds = ["mermaid", "svg", "html", "code"] as const;
    for (const kind of kinds) {
      assert.isOk(moveButton(kind), `${kind} has a move button`);
      assert.equal(
        moveButton(kind)!.title,
        "Move to side panel",
        `${kind} button title`,
      );
    }
    // An answer's footer has no move button; only the items inside it do.
    const footers = qa(".llm-message-actions").filter((footer) =>
      footer.querySelector(".llm-message-action-ask-side"),
    );
    assert.isAtLeast(footers.length, 3, "each answer footer offers Ask");
    for (const footer of footers) {
      assert.isNull(
        footer.querySelector(
          '.llm-message-action-move-side, [data-extra-action="move-side"], .llm-side-move-btn',
        ),
        "an answer footer has no move-to-side-panel button",
      );
    }
    footers[footers.length - 1].scrollIntoView?.({ block: "center" });
    await Zotero.Promise.delay(300);
    await shoot(win, "answer-footer-no-move.png");
    // The mermaid/svg/html previews do not also get a code-block button.
    assert.lengthOf(
      moveButtonsOfKind(win.document, "code"),
      1,
      "only the plain code block has a code button",
    );
    await shoot(win, "standalone-move-buttons.png");
    const assertMasked = (el: Element, what: string) => {
      const before = win.getComputedStyle(el, "::before");
      const mask = before?.getPropertyValue("mask-image") || "";
      assert.isTrue(
        !!mask && mask !== "none",
        `${what} icon has a mask (got ${mask || "empty"})`,
      );
    };
    for (const button of qa(".llm-side-move-btn")) {
      assertMasked(button, "move button");
    }

    const clickKind = async (
      kind: string,
      shot: string,
      expectTabs: number,
    ) => {
      moveButton(kind)!.click();
      await until(
        () => itemTabs().length === expectTabs,
        () =>
          `${kind}: expected ${expectTabs} item tabs, got ${itemTabs().length}`,
      );
      await until(
        () => shownItemRoot()?.getAttribute("data-side-item-kind") === kind,
        () =>
          `${kind}: shown item is ${shownItemRoot()?.getAttribute("data-side-item-kind")}`,
      );
      const actionButtons = Array.from(
        shownItemRoot()!.querySelectorAll(
          ".llm-standalone-side-panel-item-action",
        ),
      ) as HTMLElement[];
      assert.isAtLeast(actionButtons.length, 1, `${kind}: has title actions`);
      for (const button of actionButtons) {
        assert.equal(button.textContent, "", `${kind}: action is icon-only`);
        assert.isNotEmpty(button.getAttribute("aria-label"));
        assertMasked(
          button,
          `${kind} ${button.getAttribute("data-item-action")}`,
        );
      }
      await Zotero.Promise.delay(900);
      await shoot(win, shot);
    };
    await clickKind("mermaid", "tab-mermaid.png", 1);
    await clickKind("svg", "tab-svg.png", 2);
    await clickKind("html", "tab-html.png", 3);
    const htmlRoot = shownItemRoot()!;
    assert.isOk(
      htmlRoot.querySelector(".llm-html-preview iframe"),
      "the html tab holds the sandboxed frame",
    );
    assert.equal(
      htmlRoot
        .querySelector(".llm-html-preview iframe")!
        .getAttribute("sandbox"),
      "allow-scripts",
    );
    // Every tab kind has the same flat hover bar: Show code, Copy, Full view.
    const htmlBar = htmlRoot.querySelector(".llm-content-bar");
    assert.isOk(htmlBar, "the html tab has the flat hover bar");
    for (const cls of [
      "llm-content-bar-source",
      "llm-render-code-copy-btn",
      "llm-content-bar-fullview",
    ]) {
      assert.isOk(htmlBar!.querySelector(`.${cls}`), `html bar has ${cls}`);
    }
    await clickKind("code", "tab-code.png", 4);
    // The code tab draws the chat's own code block: inner code, real
    // language, highlighted. It never shows the ``` fence lines as code.
    const codeRoot = shownItemRoot()!;
    const codeShell = codeRoot.querySelector(
      ".llm-codeblock-shell",
    ) as HTMLElement | null;
    assert.isOk(codeShell, "the code tab holds a code block");
    assert.equal(codeShell!.getAttribute("data-code-lang"), "python");
    assert.equal(
      codeShell!.querySelector(".llm-codeblock-lang")?.textContent,
      "python",
    );
    const codeBody = codeShell!.querySelector(
      ".llm-codeblock-body",
    ) as HTMLElement;
    assert.notInclude(codeBody.textContent || "", "```");
    assert.include(codeBody.textContent || "", "def greet(name):");
    const codeEl = codeBody.querySelector("code") as HTMLElement;
    const keyword = codeBody.querySelector(
      ".hljs-keyword",
    ) as HTMLElement | null;
    assert.isOk(keyword, "the code tab has highlighted spans");
    assert.notEqual(
      win.getComputedStyle(keyword!)!.color,
      win.getComputedStyle(codeEl)!.color,
      "a keyword is coloured differently from plain code",
    );

    // Clicking again focuses the same tab instead of opening a second one.
    for (const kind of kinds) {
      moveButton(kind)!.click();
      await Zotero.Promise.delay(300);
      assert.lengthOf(itemTabs(), 4, `${kind}: no duplicate tab`);
      assert.equal(
        shownItemRoot()?.getAttribute("data-side-item-kind"),
        kind,
        `${kind}: the existing tab is focused`,
      );
    }

    assert.isNull(
      shownItemRoot()!.querySelector('[data-item-action="back"]'),
      "an item moved with →| has no Back to Miscellaneous",
    );

    // Show in chat scrolls to the source message and flashes it.
    moveButton("mermaid")!.click();
    await Zotero.Promise.delay(300);
    const show = shownItemRoot()!.querySelector<HTMLElement>(
      '[data-item-action="show-in-chat"]',
    );
    assert.isOk(show, "Show in chat exists for a mermaid item");
    show!.click();
    await until(
      () => Boolean(mainBody().querySelector(".llm-side-item-flash")),
      () => "the source message never flashed",
      3000,
    );
    const flashed = mainBody().querySelector(
      ".llm-side-item-flash",
    ) as HTMLElement;
    assert.equal(
      flashed.getAttribute("data-message-index"),
      "1",
      "the mermaid item's message is flashed",
    );
    await until(
      () => !mainBody().querySelector(".llm-side-item-flash"),
      () => "the flash class never cleared",
      5000,
    );
  });

  it("lists four launch rows on the new tab page, and Miscellaneous opens items in place", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Miscellaneous list paper",
      pdfTitle: "Miscellaneous list paper PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);
    await api.resizeStandaloneWindow(1300, 800);
    win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
    const past = await api.seedStandaloneConversation([
      { role: "user", text: "misc-past-question" },
      { role: "assistant", text: "misc-past-answer" },
    ]);
    await Zotero.DB.queryAsync(
      `UPDATE llm_for_zotero_paper_conversations
          SET user_turn_count = 1, title = ?, last_activity_at = ?
        WHERE conversation_key = ?`,
      ["Miscellaneous past chat", Date.now(), Number(past.conversationKey)],
    );
    await api.startNewStandaloneConversation();
    await api.seedStandaloneConversation([
      { role: "user", text: "Draw me a flow and a figure" },
      {
        role: "assistant",
        text: `Diagram first.\n\n${MERMAID_FENCE}\n\nThen the figure.\n\n${SVG_FENCE}`,
      },
      { role: "user", text: "Now a page and some code" },
      {
        role: "assistant",
        text: `The page.\n\n${HTML_FENCE}\n\nThe code.\n\n${CODE_FENCE}`,
      },
    ]);
    await until(
      () => qa(".llm-side-move-btn").length >= 4,
      () => `move buttons: ${qa(".llm-side-move-btn").length}`,
      30_000,
    );

    // The New tab page.
    let state = await api.clickStandaloneSidePanelControl("toggle");
    assert.isTrue(state.open);
    state = await api.clickStandaloneSidePanelControl("new-tab");
    assert.equal(state.view, "newtab");
    let rows = qa("[data-side-launch]");
    assert.deepEqual(
      rows.map((row) => row.getAttribute("data-side-launch")),
      ["sidechat", "history", "misc", "progress"],
    );
    assert.deepEqual(
      rows.map(
        (row) =>
          row.querySelector(".llm-standalone-nav-label")?.textContent || "",
      ),
      ["Side chat", "History", "Miscellaneous", "Task progress"],
    );
    await shoot(win, "newtab-four-rows.png");

    // Task progress: its row opens the Task progress side tab.
    (rows[3] as HTMLElement).click();
    await until(
      () =>
        qa(".llm-standalone-side-panel-tab[data-side-tab-kind='progress']")
          .length === 1,
      () =>
        `tabs: ${qa(".llm-standalone-side-panel-tab")
          .map((tab) => tab.dataset.sideTabKind)
          .join(",")}`,
    );
    state = await api.clickStandaloneSidePanelControl("new-tab");
    assert.equal(state.view, "newtab");
    rows = qa("[data-side-launch]");

    // Miscellaneous: items newest first with kind chips.
    (rows[2] as HTMLElement).click();
    const miscLoading = () =>
      qa(".llm-standalone-search-empty").some((el) =>
        (el.textContent || "").includes("Looking through the other chats"),
      );
    await until(
      () => !miscLoading() && qa("[data-made-kind]").length === 4,
      () =>
        `misc rows: ${qa("[data-made-kind]").length}, loading: ${miscLoading()}`,
    );
    const miscRows = qa("[data-made-kind]");
    assert.deepEqual(
      miscRows.map((row) => row.getAttribute("data-made-kind")),
      ["code", "html", "svg", "mermaid"],
      "newest first",
    );
    // Every item belongs to the new chat the window shows, never the past one.
    const openKey = miscRows[0].dataset.madeConversationKey;
    assert.notEqual(
      miscRows[0].dataset.madeConversationKey,
      String(past.conversationKey),
      "no row stamped with the past chat",
    );
    for (const row of miscRows) {
      assert.notEqual(
        row.dataset.madeConversationKey,
        String(past.conversationKey),
        "row is not the past chat",
      );
      assert.include(
        row.querySelector(".llm-standalone-side-panel-misc-here")
          ?.textContent || "",
        "open now",
        "row marks the open chat",
      );
      assert.equal(
        row.dataset.madeConversationKey,
        openKey,
        "every row carries the same (open) chat key",
      );
    }
    for (const row of miscRows) {
      const chip = row.querySelector(".llm-standalone-search-label");
      assert.isOk(chip, "kind chip");
      assert.equal(chip!.getAttribute("data-item-kind"), row.dataset.madeKind);
      assert.isNotEmpty(chip!.textContent);
    }
    await Zotero.Promise.delay(400);
    await shoot(win, "miscellaneous-list.png");

    // Style parity, Miscellaneous row vs History row.
    const metrics = (el: HTMLElement) => {
      const style = win.getComputedStyle(el)!;
      const rect = el.getBoundingClientRect();
      return {
        fontSize: style.fontSize,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        borderRadius: style.borderRadius,
        height: rect.height,
      };
    };
    const freshMiscRow = qa("[data-made-kind]")[0];
    const miscMetrics = metrics(freshMiscRow);
    const miscClass = freshMiscRow.className;
    // A New tab tab -> History row in a second tab.
    await api.clickStandaloneSidePanelControl("new-tab");
    await api.clickStandaloneSidePanelControl("new-history");
    await until(
      () =>
        qa(".llm-standalone-side-panel-history .llm-standalone-search-item")
          .length > 0,
      () => "history list is empty",
    );
    const historyRow = qa(
      ".llm-standalone-side-panel-history .llm-standalone-search-item",
    )[0];
    assert.equal(historyRow.className, miscClass, "same row classes");
    const historyMetrics = metrics(historyRow);
    assert.deepEqual(
      { ...miscMetrics, height: 0 },
      { ...historyMetrics, height: 0 },
      "same font size, padding, and radius",
    );
    // Height follows content: History rows carry a second (meta) line that
    // Miscellaneous rows do not have, so only the styles are compared.
    Zotero.debug(
      `[sidePanelMiscellaneous] row height misc=${miscMetrics.height} history=${historyMetrics.height}`,
    );

    // Back to Miscellaneous, pick a row: it opens in the same tab.
    const miscTab = qa(
      '.llm-standalone-side-panel-tab[data-side-tab-kind="misc"]',
    )[0];
    assert.isOk(miscTab);
    miscTab.click();
    await until(
      () => qa("[data-made-kind]").some((el) => el.offsetParent !== null),
      () => "misc list not visible",
    );
    const tabCountBefore = qa(".llm-standalone-side-panel-tab").length;
    const svgRow = qa("[data-made-kind]").find(
      (el) => el.dataset.madeKind === "svg",
    )!;
    svgRow.click();
    await until(
      () => itemTabs().length === 1,
      () => `item tabs after pick: ${itemTabs().length}`,
    );
    assert.equal(
      shownItemRoot()?.getAttribute("data-side-item-kind"),
      "svg",
      "the picked item is shown",
    );
    assert.lengthOf(
      qa('.llm-standalone-side-panel-tab[data-side-tab-kind="misc"]'),
      0,
      "the Miscellaneous tab became the item tab",
    );
    assert.equal(
      qa(".llm-standalone-side-panel-tab").length,
      tabCountBefore,
      "the tab count did not change",
    );

    // Style parity, item tab vs an existing tab.
    const tabMetrics = (el: HTMLElement) => {
      const style = win.getComputedStyle(el)!;
      const title = win.getComputedStyle(
        el.querySelector(".llm-standalone-side-panel-tab-title")!,
      )!;
      return {
        fontSize: title.fontSize,
        borderRadius: style.borderRadius,
        height: el.getBoundingClientRect().height,
      };
    };
    const itemTab = itemTabs()[0];
    const historyTab = qa(
      '.llm-standalone-side-panel-tab[data-side-tab-kind="history"]',
    )[0];
    assert.isOk(historyTab);
    assert.equal(
      itemTab.className.replace(/\bactive\b|\bis-active\b/g, "").trim(),
      historyTab.className.replace(/\bactive\b|\bis-active\b/g, "").trim(),
      "same tab classes (ignoring the active state)",
    );
    // Measure both in the same (active) state: the active tab squares its
    // bottom corners.
    const isActive = (el: HTMLElement) =>
      el.classList.contains("active") ||
      el.classList.contains("is-active") ||
      el.getAttribute("aria-selected") === "true";
    historyTab.click();
    await until(
      () => isActive(historyTab),
      () => "the History tab did not become active",
    );
    const historyTabMetrics = tabMetrics(historyTab);
    itemTab.click();
    await until(
      () => isActive(itemTab),
      () => "the item tab did not become active",
    );
    const itemTabMetrics = tabMetrics(itemTab);
    assert.equal(itemTabMetrics.fontSize, historyTabMetrics.fontSize);
    assert.equal(itemTabMetrics.borderRadius, historyTabMetrics.borderRadius);
    assert.closeTo(itemTabMetrics.height, historyTabMetrics.height, 0.5);

    // Back to Miscellaneous: the picked item's tab shows the list again.
    const back = shownItemRoot()!.querySelector<HTMLElement>(
      '[data-item-action="back"]',
    );
    assert.isOk(back, "an item picked in the list has a back button");
    assert.equal(back!.title, "Back to Miscellaneous");
    const titleRow = back!.parentElement!;
    assert.equal(titleRow.firstElementChild, back, "back comes first");
    const copy = shownItemRoot()!.querySelector<HTMLElement>(
      '[data-item-action="copy"]',
    )!;
    assert.equal(back!.className.split(" ")[0], copy.className.split(" ")[0]);
    const backRect = back!.getBoundingClientRect();
    const copyRect = copy.getBoundingClientRect();
    assert.closeTo(backRect.width, copyRect.width, 0.5, "same button size");
    assert.closeTo(backRect.height, copyRect.height, 0.5, "same button size");
    // The back icon's mask is first used here; let it load before the shot.
    await Zotero.Promise.delay(500);
    await shoot(win, "misc-item-back.png");
    back!.click();
    await until(
      () =>
        qa("[data-made-kind]").filter((el) => el.offsetParent !== null)
          .length === 4,
      () => `misc rows after back: ${qa("[data-made-kind]").length}`,
    );
    assert.lengthOf(itemTabs(), 0, "the item tab became the list again");
    assert.lengthOf(
      qa('.llm-standalone-side-panel-tab[data-side-tab-kind="misc"]'),
      1,
      "one Miscellaneous tab",
    );
    assert.equal(
      qa(".llm-standalone-side-panel-tab").length,
      tabCountBefore,
      "the tab count did not change",
    );
  });

  it("lists only the answer's items, not code from the agent's tool calls", async function () {
    const fixture = await api.createPaperWithPdfFixture({
      title: "Miscellaneous trace paper",
      pdfTitle: "Miscellaneous trace paper PDF",
    });
    fixtures.push(fixture);
    await api.openStandaloneForItem(fixture.parentItemId);
    await api.resizeStandaloneWindow(1300, 800);
    win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
    const toolEvent = (seq: number, toolName: string) => ({
      runId: "misc-trace",
      seq,
      createdAt: seq,
      eventType: "codex_tool_activity",
      payload: {
        type: "codex_tool_activity",
        itemId: `tool-${seq}`,
        phase: "completed",
        toolName,
        args: { operation: "next_work", view: "full" },
      },
    });
    await api.seedStandaloneConversation([
      { role: "user", text: "Look things up, then write code" },
      {
        role: "assistant",
        text: `Here is the code.\n\n${CODE_FENCE}`,
        runMode: "agent",
        modelProviderLabel: "Codex",
        pendingAgentTraceEvents: [
          toolEvent(1, "inspect_records"),
          toolEvent(2, "search_library"),
        ],
      } as any,
    ]);
    await until(
      () => qa(".llm-agent-trace-code .llm-codeblock-shell").length >= 1,
      () =>
        `trace code blocks: ${qa(".llm-agent-trace-code .llm-codeblock-shell").length}`,
      30_000,
    );
    await until(
      () => qa(".llm-side-move-btn").length >= 1,
      () => `move buttons: ${qa(".llm-side-move-btn").length}`,
      30_000,
    );
    assert.lengthOf(
      qa(".llm-agent-trace-code .llm-side-move-btn"),
      0,
      "trace code blocks have no →|",
    );
    assert.lengthOf(
      qa(".llm-agent-trace-code [data-side-item-kind]"),
      0,
      "trace code blocks are not side items",
    );

    await api.clickStandaloneSidePanelControl("toggle");
    await api.clickStandaloneSidePanelControl("new-tab");
    qa('[data-side-launch="misc"]')[0].click();
    await until(
      () => qa("[data-made-kind]").length >= 1,
      () => `misc rows: ${qa("[data-made-kind]").length}`,
    );
    await Zotero.Promise.delay(300);
    assert.deepEqual(
      qa("[data-made-kind]").map((row) => row.getAttribute("data-made-kind")),
      ["code"],
      "only the answer's code block is listed",
    );
    await shoot(win, "misc-list-no-trace.png");
  });
});
