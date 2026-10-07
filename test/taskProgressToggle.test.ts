/**
 * The Task progress button: left of Export in the standalone window's title
 * bar and left of Open in Window in the sidebar header, it shows or hides the
 * row for the conversation on screen. The choice holds for that conversation
 * in that panel (a new run does not undo it) and goes when the panel shows
 * another conversation. The Stacked sidebar header drops the button below
 * its compact width.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import {
  finishRequest,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";
import {
  bindTaskProgressToggle,
  disposeTaskProgressPanel,
  syncTaskProgressPanel,
  syncTaskProgressPanelsForConversation,
} from "../src/modules/contextPanel/taskProgress/panel";
import {
  applyTaskPaperUpdate,
  beginTaskAction,
  beginTaskRun,
  clearAllTaskProgress,
  getTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";
import {
  applyTaskProgressToggleState,
  createTaskProgressToggleButton,
} from "../src/modules/contextPanel/taskProgress/toggleButton";
import { createTaskProgressCurtain } from "../src/modules/contextPanel/taskProgress/view";
import { initI18n, t } from "../src/utils/i18n";
import { fakeDocument, FakeElement } from "./helpers/fakeDom";
import type { TaskPaperLedgerDelta } from "../src/agent/context/taskPaperLedger";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

const KEY = 771201;
const OTHER_KEY = 771202;

/** `paper_read` reading a paper's full text: a read in depth. */
function fullRead(runId: string, itemId = 1): TaskPaperLedgerDelta {
  const key = `1:${itemId}`;
  return {
    version: 1,
    callId: `read-${itemId}`,
    runId,
    toolName: "paper_read",
    papers: [
      { key, libraryID: 1, itemId, title: `Paper ${itemId}`, state: "read" },
    ],
    reads: [
      {
        key,
        callId: `read-${itemId}`,
        toolName: "paper_read",
        granularity: "full",
        method: "full",
        snippet: "Body text.",
      },
    ],
  };
}

function findById(root: FakeElement, id: string): FakeElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const match = findById(child, id);
    if (match) return match;
  }
  return null;
}

/** Timers a test runs by hand, as the panel's window would fire them. */
const timers = new Map<number, () => void>();
let timerHandle = 0;
function runTimers() {
  for (const [id, callback] of Array.from(timers)) {
    timers.delete(id);
    callback();
  }
}

const fakeWindow = {
  closed: false,
  setTimeout: (callback: () => void) => {
    timers.set(++timerHandle, callback);
    return timerHandle;
  },
  clearTimeout: (id: number) => timers.delete(id),
  performance: { now: () => 0 },
  // No motion: every change settles at once.
  getComputedStyle: () => ({
    transitionDuration: "0s",
    transitionDelay: "0s",
    minHeight: "",
  }),
};

/** A mounted panel's body: in a live window, and found by id like the DOM. */
class FakeBody extends FakeElement {
  readonly ownerDocument = { ...fakeDocument, defaultView: fakeWindow };

  get isConnected() {
    return true;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.startsWith("#")) return findById(this, selector.slice(1));
    return super.querySelector(selector);
  }
}

type Panel = {
  body: FakeBody;
  main: FakeElement;
  row: FakeElement;
  drawer: FakeElement;
  /** Show this conversation now, as the panel does after a switch. */
  show: (conversationKey: number) => void;
};

/** A chat panel as `buildUI` lays it out: the row first in the chat shell. */
function buildPanel(
  conversationKey: number,
  conversationKind: "global" | "paper" = "global",
): Panel {
  const body = new FakeBody("div");
  const main = new FakeElement("div");
  main.id = "llm-main";
  main.className = "llm-panel";
  main.dataset.itemId = String(conversationKey);
  main.dataset.conversationKind = conversationKind;
  main.dataset.libraryId = "1";
  main.dataset.runtimeMode = "agent";
  const shell = new FakeElement("div");
  shell.id = "llm-chat-shell";
  shell.className = "llm-chat-shell";
  const curtain = createTaskProgressCurtain(
    fakeDocument,
  ) as unknown as FakeElement;
  const chatBox = new FakeElement("div");
  chatBox.id = "llm-chat-box";
  chatBox.className = "llm-messages";
  shell.append(curtain, chatBox);
  main.append(shell);
  body.append(main);
  const panel: Panel = {
    body,
    main,
    row: curtain.findByClass("llm-task-progress")!,
    drawer: curtain.findByClass("llm-task-progress-drawer")!,
    show(key) {
      main.dataset.itemId = String(key);
      syncTaskProgressPanel(body as unknown as Element);
    },
  };
  syncTaskProgressPanel(body as unknown as Element);
  return panel;
}

const hidden = (node: FakeElement) => (node as any).hidden === true;
const pressed = (button: FakeElement) => button.getAttribute("aria-pressed");

describe("task progress button", function () {
  describe("the button", function () {
    it("is a title-bar action with its own icon, not pressed, offering to show", function () {
      const button = createTaskProgressToggleButton(
        fakeDocument,
      ) as unknown as FakeElement;
      assert.equal(button.tagName, "button");
      assert.equal(button.type, "button");
      assert.isTrue(button.classList.contains("llm-standalone-title-action"));
      assert.isTrue(
        button.classList.contains("llm-standalone-icon-task-progress"),
      );
      assert.equal(pressed(button), "false");
      assert.equal(button.title, "Show task progress");
      assert.equal(button.getAttribute("aria-label"), "Show task progress");
      assert.equal(
        button.style.display,
        "none",
        "out of the way until a chat panel says it applies",
      );
    });

    it("says what a click will do, and leaves the title bar where the row never shows", function () {
      const button = createTaskProgressToggleButton(
        fakeDocument,
      ) as unknown as FakeElement;
      const apply = (applies: boolean, shown: boolean) =>
        applyTaskProgressToggleState(button as unknown as HTMLButtonElement, {
          applies,
          shown,
        });
      apply(true, true);
      assert.equal(button.style.display, "");
      assert.equal(pressed(button), "true");
      assert.equal(button.title, "Hide task progress");
      assert.equal(button.getAttribute("aria-label"), "Hide task progress");
      apply(true, false);
      assert.equal(pressed(button), "false");
      assert.equal(button.title, "Show task progress");
      assert.equal(button.getAttribute("aria-label"), "Show task progress");
      apply(false, true);
      assert.equal(button.style.display, "none");
      assert.equal(pressed(button), "false");
    });

    describe("in Chinese", function () {
      const globals = globalThis as unknown as { Zotero?: unknown };
      let previousZotero: unknown;
      before(function () {
        previousZotero = globals.Zotero;
        globals.Zotero = { Prefs: { get: () => "zh-CN" }, locale: "zh-CN" };
        initI18n();
      });
      after(function () {
        if (previousZotero === undefined) delete globals.Zotero;
        else globals.Zotero = previousZotero;
        initI18n();
      });

      it("translates both labels", function () {
        assert.equal(t("Show task progress"), "显示任务进度");
        assert.equal(t("Hide task progress"), "隐藏任务进度");
        const button = createTaskProgressToggleButton(
          fakeDocument,
        ) as unknown as FakeElement;
        assert.equal(button.getAttribute("aria-label"), "显示任务进度");
      });
    });
  });

  describe("bound to a chat panel", function () {
    const bodies: FakeBody[] = [];
    const unbinds: Array<() => void> = [];

    function standalone(
      conversationKey: number,
      kind: "global" | "paper" = "global",
    ) {
      const panel = buildPanel(conversationKey, kind);
      bodies.push(panel.body);
      const button = createTaskProgressToggleButton(
        fakeDocument,
      ) as unknown as FakeElement;
      unbinds.push(
        bindTaskProgressToggle(
          panel.body as unknown as Element,
          button as unknown as HTMLButtonElement,
        ),
      );
      return {
        ...panel,
        button,
        click: () => button.dispatchFakeEvent("click"),
      };
    }

    function sidebar(conversationKey: number) {
      const panel = buildPanel(conversationKey);
      bodies.push(panel.body);
      return panel;
    }

    afterEach(function () {
      for (const unbind of unbinds.splice(0)) unbind();
      for (const body of bodies.splice(0))
        disposeTaskProgressPanel(body as unknown as Element);
      timers.clear();
      finishRequest(KEY, 1);
      clearAllTaskProgress();
    });

    it("shows the row in an empty Library chat on a click, with the empty list, and hides it on the next", function () {
      const tp = standalone(KEY);
      assert.equal(tp.button.style.display, "", "the button applies");
      assert.equal(pressed(tp.button), "false");
      assert.isTrue(hidden(tp.row), "no row in an empty Library chat");

      tp.click();
      assert.isFalse(hidden(tp.row), "the row shows");
      assert.equal(pressed(tp.button), "true");
      assert.equal(tp.button.getAttribute("aria-label"), "Hide task progress");
      const listing = getTaskProgress(KEY)?.scope?.listing;
      assert.isTrue(listing?.wholeLibrary, "the whole library, nothing added");
      assert.deepEqual(listing?.entries, []);

      tp.row.dispatchFakeEvent("click");
      assert.isFalse(hidden(tp.drawer), "the drawer opens");
      assert.lengthOf(tp.drawer.findAllByClass("llm-task-paper"), 0);
      assert.isTrue(
        hidden(tp.drawer.findByClass("llm-task-progress-head")!),
        "nothing still being prepared",
      );

      tp.click();
      assert.isTrue(hidden(tp.row), "the row hides");
      assert.isTrue(hidden(tp.drawer), "with its drawer");
      assert.equal(pressed(tp.button), "false");
      assert.equal(tp.button.getAttribute("aria-label"), "Show task progress");
    });

    it("hides a row the automatic rule showed, and a new run does not bring it back", function () {
      beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
      const tp = standalone(KEY);
      assert.isFalse(hidden(tp.row), "a run's steps show the row");
      assert.equal(pressed(tp.button), "true");

      tp.click();
      assert.isTrue(hidden(tp.row));
      assert.equal(pressed(tp.button), "false");

      // A new question: the request starts, the run declares steps and
      // reads a paper in depth.
      tryBeginRequest(KEY, 1, null);
      beginTaskRun(KEY, { runId: "run-2" });
      beginTaskAction(KEY, { runId: "action-2", title: "Auto Tag" });
      applyTaskPaperUpdate(KEY, fullRead("run-2"), "run-2");
      runTimers();
      syncTaskProgressPanelsForConversation(KEY);
      assert.isTrue(hidden(tp.row), "the user's choice holds");
      assert.equal(pressed(tp.button), "false");
      finishRequest(KEY, 1);
      runTimers();
      assert.isTrue(hidden(tp.row));

      tp.click();
      assert.isFalse(hidden(tp.row), "until the next click");
      assert.equal(pressed(tp.button), "true");
    });

    it("keeps a row the user showed through a new run", function () {
      const tp = standalone(KEY);
      tp.click();
      tryBeginRequest(KEY, 1, null);
      beginTaskRun(KEY, { runId: "run-2" });
      runTimers();
      finishRequest(KEY, 1);
      runTimers();
      assert.isFalse(hidden(tp.row));
      assert.equal(pressed(tp.button), "true");
    });

    it("presses the button when the automatic rule shows the row, with no click", function () {
      const tp = standalone(KEY);
      assert.equal(pressed(tp.button), "false");
      beginTaskRun(KEY, { runId: "run-1" });
      applyTaskPaperUpdate(KEY, fullRead("run-1"), "run-1");
      runTimers();
      assert.isFalse(hidden(tp.row), "a paper read in depth shows the row");
      assert.equal(pressed(tp.button), "true");
    });

    it("drops the choice when the window shows another conversation", function () {
      const tp = standalone(KEY);
      tp.click();
      assert.isFalse(hidden(tp.row));

      tp.show(OTHER_KEY);
      assert.isTrue(hidden(tp.row), "the other chat by the automatic rule");
      assert.equal(pressed(tp.button), "false");
      tp.show(KEY);
      assert.isTrue(hidden(tp.row), "back: the automatic rule, not the click");
      assert.equal(pressed(tp.button), "false");

      // A row the user hid comes back by the automatic rule too.
      beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
      runTimers();
      assert.isFalse(hidden(tp.row));
      tp.click();
      assert.isTrue(hidden(tp.row));
      tp.show(OTHER_KEY);
      tp.show(KEY);
      assert.isFalse(hidden(tp.row), "the steps show it again");
      assert.equal(pressed(tp.button), "true");
    });

    it("keeps the choice for the panel that took it: another panel on the same chat follows the automatic rule", function () {
      beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
      const tp = standalone(KEY);
      const side = sidebar(KEY);
      tp.click();
      runTimers();
      syncTaskProgressPanelsForConversation(KEY);
      assert.isTrue(hidden(tp.row), "hidden in the window");
      assert.isFalse(hidden(side.row), "still shown in the sidebar");
    });

    it("takes the button out in WebChat and a note chat, where the row never shows", function () {
      const tp = standalone(KEY);
      tp.click();
      assert.isFalse(hidden(tp.row));

      tp.main.dataset.webchatMode = "true";
      syncTaskProgressPanel(tp.body as unknown as Element);
      assert.equal(tp.button.style.display, "none");
      assert.equal(pressed(tp.button), "false");
      assert.isTrue(hidden(tp.row));
      tp.click();
      assert.isTrue(hidden(tp.row), "a click there changes nothing");

      tp.main.dataset.webchatMode = "false";
      tp.main.dataset.noteKind = "item";
      syncTaskProgressPanel(tp.body as unknown as Element);
      assert.equal(tp.button.style.display, "none");
      assert.isTrue(hidden(tp.row));

      tp.main.dataset.noteKind = "";
      syncTaskProgressPanel(tp.body as unknown as Element);
      assert.equal(tp.button.style.display, "");
    });

    it("takes the button out when the panel is gone, and lets go of it when unbound", function () {
      const tp = standalone(KEY);
      assert.equal(tp.button.style.display, "");
      disposeTaskProgressPanel(tp.body as unknown as Element);
      assert.equal(tp.button.style.display, "none");
      for (const unbind of unbinds.splice(0)) unbind();
      syncTaskProgressPanel(tp.body as unknown as Element);
      assert.equal(
        tp.button.style.display,
        "none",
        "an unbound button is no longer painted",
      );
      tp.click();
      assert.isTrue(hidden(tp.row), "nor does its click reach the panel");
    });

    it("leaves a closed window's button alone when its panel is swept", function () {
      const tp = standalone(KEY);
      assert.equal(tp.button.style.display, "");
      Object.defineProperty(tp.body, "ownerDocument", {
        value: {
          ...fakeDocument,
          defaultView: { ...fakeWindow, closed: true },
        },
      });
      // A sync for the conversation sweeps panels whose window closed.
      syncTaskProgressPanelsForConversation(KEY);
      assert.equal(
        tp.button.style.display,
        "",
        "the closed window's button is not written to",
      );
    });
  });

  describe("in the standalone window", function () {
    const standaloneSource = read(
      "src/modules/contextPanel/standaloneWindow.ts",
    );
    const buildUiSource = read("src/modules/contextPanel/buildUI.ts");

    it("sits immediately left of Export in the chat's title bar", function () {
      assert.match(
        standaloneSource,
        /contentTitleBarSpacer\.append\(\s*iconTaskProgress,\s*iconExport,\s*iconClear,?\s*\)/,
      );
      assert.match(
        standaloneSource,
        /createTaskProgressToggleButton\(doc\)/,
        "the title bar builds it",
      );
    });

    it("drives the window's chat panel, and lets go when the window closes", function () {
      assert.match(
        standaloneSource,
        /bindTaskProgressToggle\(\s*contentArea,\s*iconTaskProgress,?\s*\)/,
      );
      const cleanup = standaloneSource.slice(
        standaloneSource.indexOf("const cleanupWindow = () => {"),
      );
      const unbind = cleanup.indexOf("unbindStandaloneTaskProgressToggle?.()");
      assert.isAtLeast(unbind, 0, "the close unbinds it");
      assert.isBelow(
        unbind,
        cleanup.indexOf("disposeSetupHandlers(contentArea)"),
        "before the panel's teardown repaints it",
      );
    });

    it("leaves the chat panel's own header button unbound, so the title bar's keeps the panel", function () {
      const setupSource = read("src/modules/contextPanel/setupHandlers.ts");
      assert.match(
        setupSource,
        /taskProgressToggleBtn && !isStandalonePanel\s*\?\s*bindTaskProgressToggle\(body, taskProgressToggleBtn\)/,
      );
    });
  });

  describe("in the sidebar header", function () {
    const buildUiSource = read("src/modules/contextPanel/buildUI.ts");
    const setupSource = read("src/modules/contextPanel/setupHandlers.ts");

    it("sits immediately left of Open in Window, with the header's icon-button look", function () {
      assert.match(
        buildUiSource,
        /headerActions\.append\(\s*taskProgressBtn,\s*popoutBtn,\s*settingsBtn,\s*exportBtn,\s*clearBtn,?\s*\)/,
      );
      assert.match(
        buildUiSource,
        /createTaskProgressToggleButton\(\s*doc,\s*"llm-btn-icon llm-task-progress-btn",?\s*\)/,
      );
      const button = createTaskProgressToggleButton(
        fakeDocument,
        "llm-btn-icon llm-task-progress-btn",
      ) as unknown as FakeElement;
      assert.isTrue(button.classList.contains("llm-btn-icon"));
      assert.isFalse(button.classList.contains("llm-standalone-title-action"));
      assert.equal(button.style.display, "none");
    });

    it("lets go of the panel before the panel's teardown", function () {
      const cleanup = setupSource.slice(
        setupSource.indexOf("const cleanupSetupHandlers = () => {"),
      );
      const unbind = cleanup.indexOf("unbindTaskProgressToggle?.()");
      assert.isAtLeast(unbind, 0, "the cleanup unbinds it");
      assert.isBelow(unbind, cleanup.indexOf("disposeTaskProgressPanel(body)"));
    });
  });

  describe("its look", function () {
    const css = read("addon/content/zoteroPane.css");

    it("draws a check in a circle, in the stroke style of the other title actions", function () {
      const icon = read("addon/content/icons/action-task-progress.svg");
      for (const attribute of [
        'viewBox="0 0 24 24"',
        'fill="none"',
        'stroke="currentColor"',
        'stroke-width="2"',
        'stroke-linecap="round"',
        'stroke-linejoin="round"',
        '<circle cx="12" cy="12" r="9"',
        '<path d="M8.5 12.5l2.5 2.5 4.5-5"',
      ])
        assert.include(icon, attribute);
    });

    it("masks the icon like Export and Delete", function () {
      const rule = css.match(
        /\.llm-standalone-icon-task-progress::before\s*\{[^}]*\}/,
      )?.[0];
      assert.isOk(rule);
      assert.include(rule, 'mask-image: url("icons/action-task-progress.svg")');
      assert.include(
        rule,
        '-webkit-mask-image: url("icons/action-task-progress.svg")',
      );
    });

    it("compacts with the other title actions", function () {
      const rule = css.match(
        /([^{}]*\.llm-standalone-content-title-actions \.llm-standalone-icon-export,[^{}]*)\{[^}]*\}/,
      )?.[0];
      assert.isOk(rule);
      assert.include(
        rule,
        ".llm-standalone-content-title-actions .llm-standalone-icon-task-progress",
      );
    });

    it("masks the same icon in the sidebar header, pressed with its hover look", function () {
      const icon = css.match(/\.llm-task-progress-btn::before\s*\{[^}]*\}/)?.[0];
      assert.isOk(icon);
      assert.include(icon, 'mask-image: url("icons/action-task-progress.svg")');
      const pressedRule = css.match(
        /\.llm-task-progress-btn\[aria-pressed="true"\]\s*\{[^}]*\}/,
      )?.[0];
      assert.isOk(pressedRule);
      assert.include(pressedRule, "background: var(--fill-quinary)");
      assert.include(pressedRule, "opacity: 1");
      assert.match(css, /\.llm-popout-btn,\s*\.llm-task-progress-btn\s*\{/);
    });

    it("leaves the Stacked header at the width where its actions compact, and only there", function () {
      const start = css.indexOf("@container (max-width: 380px) {");
      assert.isAtLeast(start, 0);
      const block = css.slice(start, css.indexOf("\n}\n", start));
      assert.include(block, ".llm-header-actions {");
      assert.match(
        block,
        /:root\[data-llm-sidebar-layout="stacked"\] \.llm-task-progress-btn\s*\{\s*display: none;\s*\}/,
      );
      const outside = css.slice(0, start) + css.slice(start + block.length);
      assert.notMatch(
        outside,
        /\.llm-task-progress-btn\s*\{\s*display: none/,
        "no other rule hides it",
      );
    });

    it("shows pressed with the title actions' own hover look, adding no colour", function () {
      const rule = css.match(
        /([^{}]*\.llm-standalone-title-action:hover[^{}]*)\{[^}]*\}/,
      )?.[0];
      assert.isOk(rule);
      assert.include(rule, '.llm-standalone-title-action[aria-pressed="true"]');
      assert.include(rule, "background: var(--fill-quinary)");
      assert.include(rule, "color: var(--fill-primary)");
    });
  });
});
