import { assert } from "chai";
import { bindChatScrollLifecycle } from "../src/modules/contextPanel/chatScrollLifecycle";
import {
  clearChatScrollSnapshotsForTests,
  getChatScrollSnapshot,
} from "../src/modules/contextPanel/chatScrollSnapshots";
import {
  disposeStreamingMarkdown,
  renderStreamingMarkdownInto,
} from "../src/modules/contextPanel/streamingMarkdown";

// Unlike dispatchEvent(new WheelEvent(...)), sendWheelEvent enters Gecko's
// widget input pipeline and performs the native default scroll action. The
// ASYNC flag includes APZ. No test scrollTop writes occur during either trial.
describe("workflow: native wheel scrolling during output", function () {
  this.timeout(30000);
  const key = 928407;
  let doc: Document;
  let win: Window;
  let root: HTMLDivElement;
  let box: HTMLDivElement;
  let output: HTMLDivElement;
  let release: (() => void) | undefined;
  let source = "";
  const savedPrefs = new Map<
    string,
    { hadUserValue: boolean; value: boolean | number }
  >();
  const prefs: Record<string, boolean | number> = {
    "general.smoothScroll": true,
    "general.smoothScroll.mouseWheel": true,
    "general.smoothScroll.mouseWheel.durationMinMS": 250,
    "general.smoothScroll.mouseWheel.durationMaxMS": 250,
    "general.smoothScroll.msdPhysics.enabled": false,
    "mousewheel.default.delta_multiplier_y": 100,
    "ui.prefersReducedMotion": 0,
  };
  const delay = (ms: number) => Zotero.Promise.delay(ms);
  type Sample = { elapsed: number; top: number; mode: string | undefined };
  type Trial = {
    start: number;
    end: number;
    samples: Sample[];
    scrollPositions: number[];
    trustedWheelEvents: number;
    renderedDuringMotion: number;
    scriptWrites: Array<{
      elapsed: number;
      before: number;
      target: number;
      mode: string | undefined;
    }>;
  };

  beforeEach(async function () {
    clearChatScrollSnapshotsForTests();
    for (const [name, value] of Object.entries(prefs)) {
      savedPrefs.set(name, {
        hadUserValue: Services.prefs.prefHasUserValue(name),
        value:
          typeof value === "boolean"
            ? Services.prefs.getBoolPref(name, value)
            : Services.prefs.getIntPref(name, value),
      });
      if (typeof value === "boolean") Services.prefs.setBoolPref(name, value);
      else Services.prefs.setIntPref(name, value);
    }
    doc = Zotero.getMainWindow().document;
    win = doc.defaultView!;
    assert.isFunction(win.windowUtils?.sendWheelEvent);
    assert.isTrue(win.windowUtils.asyncPanZoomEnabled, "APZ must be active");
    root = doc.createElement("div") as HTMLDivElement;
    root.id = "llm-main";
    root.dataset.itemId = String(key);
    root.style.cssText =
      "position:fixed;left:30px;top:30px;width:540px;height:340px;z-index:2147483647;background:white";
    box = doc.createElement("div") as HTMLDivElement;
    box.id = "llm-chat-box";
    box.style.cssText =
      "height:320px;width:520px;overflow:auto;overflow-anchor:none;font:14px/1.5 sans-serif";
    const message = doc.createElement("div");
    message.className = "llm-message-wrapper";
    Object.assign(message.dataset, {
      messageRole: "assistant",
      messageTimestamp: "1",
      messageAnchorKey: "native-wheel-response",
    });
    output = doc.createElement("div") as HTMLDivElement;
    output.className = "llm-agent-inline-text";
    message.appendChild(output);
    box.appendChild(message);
    root.appendChild(box);
    doc.documentElement.appendChild(root);
    source = Array.from(
      { length: 65 },
      (_, index) =>
        `Passage ${index + 1}. The reader follows the evidence across a long Codex response. Each paragraph provides enough content to browse while additional output is generated below.`,
    ).join("\n\n");
    renderStreamingMarkdownInto(output, source, doc, () => {});
    release = bindChatScrollLifecycle(
      box,
      () => key,
      () => {},
    );
    const renderDeadline = Date.now() + 5000;
    while (
      output.querySelectorAll("p").length < 65 &&
      Date.now() < renderDeadline
    )
      await delay(50);
    assert.lengthOf(output.querySelectorAll("p"), 65);
    await delay(300);
    assert.isAbove(box.scrollHeight, box.clientHeight + 3000);
  });

  afterEach(function () {
    release?.();
    release = undefined;
    if (output) disposeStreamingMarkdown(output);
    root?.remove();
    for (const [name, saved] of savedPrefs) {
      if (!saved.hadUserValue) Services.prefs.clearUserPref(name);
      else if (typeof saved.value === "boolean")
        Services.prefs.setBoolPref(name, saved.value);
      else Services.prefs.setIntPref(name, saved.value);
    }
    savedPrefs.clear();
  });

  async function runTrial(
    streaming: boolean,
    initialTop: number,
  ): Promise<Trial> {
    // Fixture positioning only. The next scroll changes must come from Gecko.
    box.scrollTop = initialTop;
    await delay(300);
    const rect = box.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    assert.isTrue(box.contains(doc.elementFromPoint(x, y)), "wheel hit target");
    const trial: Trial = {
      start: box.scrollTop,
      end: box.scrollTop,
      samples: [],
      scrollPositions: [],
      trustedWheelEvents: 0,
      renderedDuringMotion: 0,
      scriptWrites: [],
    };
    const originalOwnScrollTop = Object.getOwnPropertyDescriptor(
      box,
      "scrollTop",
    );
    let scrollTopOwner: object | null = box;
    let nativeScrollTop: PropertyDescriptor | undefined;
    while (scrollTopOwner && !nativeScrollTop) {
      nativeScrollTop = Object.getOwnPropertyDescriptor(
        scrollTopOwner,
        "scrollTop",
      );
      scrollTopOwner = Object.getPrototypeOf(scrollTopOwner);
    }
    assert.isFunction(nativeScrollTop?.get);
    assert.isFunction(nativeScrollTop?.set);
    const started = Date.now();
    const renderObserver = new win.MutationObserver(() => {
      if (Date.now() - started < 500) trial.renderedDuringMotion += 1;
    });
    renderObserver.observe(output, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Delegate to the real DOM accessor. APZ changes the native scroll position
    // without entering this JS setter; plugin restoration writes do enter it.
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get: () => nativeScrollTop!.get!.call(box),
      set: (target: number) => {
        trial.scriptWrites.push({
          elapsed: Date.now() - started,
          before: nativeScrollTop!.get!.call(box),
          target,
          mode: getChatScrollSnapshot(key, box)?.mode,
        });
        nativeScrollTop!.set!.call(box, target);
      },
    });
    const onWheel = (event: WheelEvent) => {
      if (event.isTrusted) trial.trustedWheelEvents += 1;
    };
    const onScroll = () => trial.scrollPositions.push(box.scrollTop);
    box.addEventListener("wheel", onWheel);
    box.addEventListener("scroll", onScroll);
    let nextWheel = 0;
    let nextChunk = 0;
    try {
      while (Date.now() - started < 1000) {
        const elapsed = Date.now() - started;
        if (nextWheel < 6 && elapsed >= nextWheel * 60) {
          win.windowUtils.sendWheelEvent(
            x,
            y,
            0,
            -3,
            0,
            win.WheelEvent.DOM_DELTA_LINE,
            0,
            0,
            -3,
            win.windowUtils.WHEEL_EVENT_ASYNC_ENABLED!,
          );
          nextWheel += 1;
        }
        if (streaming && elapsed >= nextChunk * 25) {
          nextChunk += 1;
          // Commit several paragraphs per chunk in the same streaming target
          // being read, exercising the renderer's per-frame work budget.
          source += Array.from(
            { length: 6 },
            (_, paragraph) =>
              `\n\nOutput chunk ${nextChunk}, paragraph ${paragraph + 1}. Additional evidence continues to arrive in the same response. The earlier passage remains visible while the current Markdown tail becomes several committed paragraphs.`,
          ).join("");
          renderStreamingMarkdownInto(output, source, doc, () => {});
        }
        trial.samples.push({
          elapsed,
          top: box.scrollTop,
          mode: getChatScrollSnapshot(key, box)?.mode,
        });
        await delay(10);
      }
      trial.end = box.scrollTop;
    } finally {
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("scroll", onScroll);
      renderObserver.disconnect();
      if (originalOwnScrollTop)
        Object.defineProperty(box, "scrollTop", originalOwnScrollTop);
      else Reflect.deleteProperty(box, "scrollTop");
    }
    assert.equal(trial.trustedWheelEvents, 6, JSON.stringify(trial));
    return trial;
  }

  it("lets APZ finish the user's smooth wheel movement while output keeps arriving", async function () {
    const initialTop = Math.round((box.scrollHeight - box.clientHeight) * 0.65);
    const control = await runTrial(false, initialTop);
    const controlDistance = control.start - control.end;
    assert.isAbove(controlDistance, 100, "native wheel must move the viewport");
    assert.isAtLeast(
      new Set(
        control.scrollPositions.filter(
          (top) => top < control.start - 1 && top > control.end + 1,
        ),
      ).size,
      3,
      "control must contain intermediate native smooth-scroll positions",
    );
    assert.isEmpty(
      control.scriptWrites,
      `the control must be moved exclusively by Gecko: ${JSON.stringify(control)}`,
    );
    const streaming = await runTrial(true, initialTop);
    const diagnostic = JSON.stringify({ control, streaming });
    assert.isAbove(streaming.renderedDuringMotion, 0, diagnostic);
    assert.closeTo(
      streaming.start - streaming.end,
      controlDistance,
      2,
      `output must not interrupt or redirect native wheel movement: ${diagnostic}`,
    );
    for (let index = 1; index < streaming.samples.length; index += 1) {
      assert.isAtMost(
        streaming.samples[index].top - streaming.samples[index - 1].top,
        1,
        `upward input must not produce a backward jump: ${diagnostic}`,
      );
    }
    assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual", diagnostic);
    assert.isEmpty(
      streaming.scriptWrites,
      `appending below a manual viewport needs no script scroll writes: ${diagnostic}`,
    );

    // Once the wheel animation stops, output alone must leave the view still.
    await delay(300);
    const restingTop = box.scrollTop;
    for (let chunk = 0; chunk < 5; chunk += 1) {
      source += `\n\nOutput after wheel ${chunk + 1}. The reader has stopped scrolling and keeps reading this position.`;
      renderStreamingMarkdownInto(output, source, doc, () => {});
      await delay(150);
      assert.closeTo(box.scrollTop, restingTop, 1);
      assert.equal(getChatScrollSnapshot(key, box)?.mode, "manual");
    }
  });
});
