/**
 * Task progress docked in the standalone window's side panel: a registered
 * dock puts a "Move to side panel" button (→|) on the chat's row; while its
 * tab is open the row leaves the chat and the dock gets each input. The Task
 * progress button only says whether the row is in the chat: not pressed while
 * docked, and its click brings the row back. Docked, the drawer is always open.
 */
import { assert } from "chai";
import {
  bindTaskProgressToggle,
  disposeTaskProgressPanel,
  getTaskProgressPanelInput,
  registerTaskProgressDock,
  syncTaskProgressPanel,
} from "../src/modules/contextPanel/taskProgress/panel";
import {
  beginTaskAction,
  clearAllTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";
import { createTaskProgressToggleButton } from "../src/modules/contextPanel/taskProgress/toggleButton";
import {
  createTaskProgressCard,
  createTaskProgressCurtain,
  mountTaskProgressView,
  type TaskProgressViewInput,
} from "../src/modules/contextPanel/taskProgress/view";
import { fakeDocument, FakeElement } from "./helpers/fakeDom";

const KEY = 771301;

function findById(root: FakeElement, id: string): FakeElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const match = findById(child, id);
    if (match) return match;
  }
  return null;
}

const timers = new Map<number, () => void>();
let timerHandle = 0;
const fakeWindow = {
  closed: false,
  setTimeout: (callback: () => void) => {
    timers.set(++timerHandle, callback);
    return timerHandle;
  },
  clearTimeout: (id: number) => timers.delete(id),
  performance: { now: () => 0 },
  getComputedStyle: () => ({
    transitionDuration: "0s",
    transitionDelay: "0s",
    minHeight: "",
  }),
};

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

/** The standalone window's chat panel, as `buildUI` lays it out. */
function buildPanel(conversationKey: number) {
  const body = new FakeBody("div");
  const main = new FakeElement("div");
  main.id = "llm-main";
  main.className = "llm-panel";
  main.dataset.itemId = String(conversationKey);
  main.dataset.conversationKind = "global";
  main.dataset.libraryId = "1";
  main.dataset.runtimeMode = "agent";
  const shell = new FakeElement("div");
  shell.id = "llm-chat-shell";
  const curtain = createTaskProgressCurtain(
    fakeDocument,
  ) as unknown as FakeElement;
  const chatBox = new FakeElement("div");
  chatBox.id = "llm-chat-box";
  shell.append(curtain, chatBox);
  main.append(shell);
  body.append(main);
  syncTaskProgressPanel(body as unknown as Element);
  return {
    body,
    card: curtain.findByClass("llm-task-progress-card")!,
    row: curtain.findByClass("llm-task-progress")!,
  };
}

const hidden = (node: FakeElement) => (node as any).hidden === true;

describe("task progress in the side panel", function () {
  const bodies: FakeBody[] = [];
  const cleanups: Array<() => void> = [];

  function dockedPanel() {
    beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
    const panel = buildPanel(KEY);
    bodies.push(panel.body);
    const dock = {
      docked: false,
      opened: 0,
      closed: 0,
      inputs: [] as TaskProgressViewInput[],
    };
    cleanups.push(
      registerTaskProgressDock(panel.body as unknown as Element, {
        isDocked: () => dock.docked,
        open: () => {
          dock.opened++;
          dock.docked = true;
          syncTaskProgressPanel(panel.body as unknown as Element);
        },
        close: () => {
          dock.closed++;
          dock.docked = false;
          syncTaskProgressPanel(panel.body as unknown as Element);
        },
        onInput: (input) => dock.inputs.push(input),
      }),
    );
    const button = createTaskProgressToggleButton(
      fakeDocument,
    ) as unknown as FakeElement;
    cleanups.push(
      bindTaskProgressToggle(
        panel.body as unknown as Element,
        button as unknown as HTMLButtonElement,
      ),
    );
    const move = () => panel.card.findByClass("llm-task-progress-move");
    return { ...panel, dock, button, move };
  }

  afterEach(function () {
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const body of bodies.splice(0))
      disposeTaskProgressPanel(body as unknown as Element);
    timers.clear();
    clearAllTaskProgress();
  });

  it("puts one →| button on the chat's row, after it in its card", function () {
    const tp = dockedPanel();
    syncTaskProgressPanel(tp.body as unknown as Element);
    const buttons = tp.card.children.filter((child) =>
      child.classList.contains("llm-task-progress-move"),
    );
    assert.lengthOf(buttons, 1, "added once, however often the panel syncs");
    assert.strictEqual(tp.card.children.indexOf(buttons[0]), 1);
    assert.equal(buttons[0].getAttribute("aria-label"), "Move to side panel");
    assert.equal(tp.card.dataset.movable, "true");
  });

  it("moves the row to the side panel: the row leaves the chat and the dock gets the conversation", function () {
    const tp = dockedPanel();
    assert.isFalse(hidden(tp.row), "a run's steps show the row");
    tp.move()!.dispatchFakeEvent("click");
    assert.equal(tp.dock.opened, 1);
    assert.isTrue(hidden(tp.row), "the row is in the tab now, not the chat");
    const last = tp.dock.inputs[tp.dock.inputs.length - 1];
    assert.equal(last.conversationKey, KEY);
    assert.isUndefined(
      last.visibility.userChoice,
      "the tab gets the input as it is, not hidden",
    );
    assert.equal(
      getTaskProgressPanelInput(tp.body as unknown as Element)?.conversationKey,
      KEY,
    );
  });

  it("leaves the Task progress button unpressed while docked, and its click brings the row back", function () {
    const tp = dockedPanel();
    assert.equal(tp.button.getAttribute("aria-pressed"), "true");
    tp.move()!.dispatchFakeEvent("click");
    assert.equal(
      tp.button.getAttribute("aria-pressed"),
      "false",
      "the row is not in the chat",
    );
    assert.equal(
      tp.button.getAttribute("aria-label"),
      "Move task progress back to chat",
    );
    tp.button.dispatchFakeEvent("click");
    assert.equal(tp.dock.closed, 1, "the click closes the tab");
    assert.isFalse(hidden(tp.row), "the row is back in the chat");
    assert.equal(tp.button.getAttribute("aria-pressed"), "true");
    tp.button.dispatchFakeEvent("click");
    assert.isTrue(hidden(tp.row), "and the next click hides it, as before");
  });

  it("brings the row back to the chat once the tab closes", function () {
    const tp = dockedPanel();
    tp.move()!.dispatchFakeEvent("click");
    tp.dock.docked = false;
    syncTaskProgressPanel(tp.body as unknown as Element);
    assert.isFalse(hidden(tp.row));
    assert.equal(tp.button.getAttribute("aria-label"), "Hide task progress");
  });

  it("takes the button away when the dock goes", function () {
    const tp = dockedPanel();
    cleanups.shift()!();
    assert.isNull(tp.move());
    assert.isUndefined(tp.card.dataset.movable);
  });
});

describe("docked task progress view", function () {
  afterEach(function () {
    clearAllTaskProgress();
  });

  function mountDocked(input: Partial<TaskProgressViewInput["visibility"]>) {
    const card = createTaskProgressCard(fakeDocument) as unknown as FakeElement;
    const root = new FakeElement("div");
    root.append(card);
    const row = card.findByClass("llm-task-progress")!;
    const drawer = card.findByClass("llm-task-progress-drawer")!;
    const view = mountTaskProgressView({
      doc: fakeDocument,
      row: row as unknown as HTMLButtonElement,
      drawer: drawer as unknown as HTMLElement,
      shell: root as unknown as HTMLElement,
      chatBox: root as unknown as HTMLElement,
      keyTarget: root as unknown as HTMLElement,
      docked: true,
      deps: {
        setTimeout: () => 0,
        clearTimeout: () => undefined,
        now: () => 0,
      },
    });
    view.setInput({
      conversationKey: KEY,
      recordsReads: true,
      visibility: {
        conversationKind: "paper",
        isWebChat: false,
        isNoteSession: false,
        collectionCount: 0,
        tagCount: 0,
        paperCount: 1,
        ...input,
      },
    });
    return { view, card, row, drawer };
  }

  it("shows with its drawer open in a one-paper chat the chat's row leaves out", function () {
    const docked = mountDocked({});
    assert.isFalse(hidden(docked.card));
    assert.isTrue(docked.view.isOpen());
    assert.isFalse(hidden(docked.drawer));
    docked.view.dispose();
  });

  it("keeps the drawer open on a click on its row", function () {
    const docked = mountDocked({});
    docked.row.dispatchFakeEvent("click");
    assert.isTrue(docked.view.isOpen());
    docked.view.dispose();
  });

  it("shows nothing in WebChat", function () {
    const docked = mountDocked({ isWebChat: true });
    assert.isTrue(hidden(docked.card));
    assert.isFalse(docked.view.isOpen());
    docked.view.dispose();
  });
});
