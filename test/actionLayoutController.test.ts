import { assert } from "chai";
import { createActionLayoutController } from "../src/modules/contextPanel/setupHandlers/controllers/actionLayoutController";

function layoutFixture(initialWidth: number, connected = true) {
  let width = initialWidth;
  let geometryReads = 0;
  let styleReads = 0;
  let classToggles = 0;
  const pendingFrames: FrameRequestCallback[] = [];
  function element(label = "") {
    const classes = new Set<string>();
    return {
      isConnected: connected,
      dataset: {} as Record<string, string>,
      textContent: label,
      title: "",
      parentElement: null,
      get scrollWidth() {
        return this.textContent.length * 8;
      },
      get clientWidth() {
        geometryReads++;
        return width;
      },
      getBoundingClientRect: () => ({ width }),
      classList: {
        toggle(name: string, enabled: boolean) {
          classToggles++;
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
        contains: (name: string) => classes.has(name),
      },
    };
  }
  const body = {
    isConnected: connected,
    getBoundingClientRect: () => ({ width }),
    ownerDocument: {
      createElement: () => ({ getContext: () => null }),
      defaultView: {
        requestAnimationFrame(callback: FrameRequestCallback) {
          pendingFrames.push(callback);
          return pendingFrames.length;
        },
        getComputedStyle() {
          styleReads++;
          return { getPropertyValue: () => "0" };
        },
      },
    },
  };
  const panelRoot = element();
  const modelBtn = element();
  modelBtn.dataset.modelLabel = "Example model";
  const reasoningBtn = element();
  reasoningBtn.dataset.reasoningLabel = "High";
  const sendBtn = element("Send");
  const cancelBtn = element("Cancel");
  const controller = createActionLayoutController({
    body,
    panelRoot,
    actionsRow: element(),
    actionsLeft: element(),
    modelBtn,
    modelSlot: null,
    reasoningBtn,
    reasoningSlot: null,
    uploadBtn: null,
    selectTextBtn: null,
    screenshotBtn: null,
    sendBtn,
    cancelBtn,
  } as unknown as Parameters<typeof createActionLayoutController>[0]);
  return {
    controller,
    panelRoot,
    modelBtn,
    reasoningBtn,
    sendBtn,
    cancelBtn,
    pendingFrames,
    setWidth: (nextWidth: number) => (width = nextWidth),
    get geometryReads() {
      return geometryReads;
    },
    get styleReads() {
      return styleReads;
    },
    get classToggles() {
      return classToggles;
    },
    advanceFrames(count: number) {
      for (let frame = 0; frame < count; frame++) {
        const callbacks = pendingFrames.splice(0);
        for (const callback of callbacks) callback(frame * 16);
      }
    },
  };
}

describe("action layout lifetime", function () {
  it("leaves a zero-width panel idle until a real layout request", function () {
    const fixture = layoutFixture(0);
    fixture.controller.applyResponsiveActionButtonsLayout();
    const readsAfterRequest = fixture.geometryReads;
    fixture.advanceFrames(120);
    assert.equal(fixture.geometryReads, readsAfterRequest);
    assert.lengthOf(fixture.pendingFrames, 0);
    assert.equal(fixture.styleReads, 0);
  });

  for (const width of [0, 600]) {
    it(`does no layout on a disconnected panel with cached width ${width}`, function () {
      const fixture = layoutFixture(width, false);
      fixture.controller.applyResponsiveActionButtonsLayout();
      fixture.advanceFrames(120);
      assert.equal(fixture.geometryReads, 0);
      assert.equal(fixture.styleReads, 0);
      assert.lengthOf(fixture.pendingFrames, 0);
    });
  }

  it("restores labels on reveal and responds to later width and model changes", function () {
    const fixture = layoutFixture(0);
    const layout = fixture.controller.applyResponsiveActionButtonsLayout;
    layout();
    fixture.setWidth(600);
    layout();
    assert.equal(fixture.modelBtn.textContent, "Example model");
    assert.equal(fixture.reasoningBtn.textContent, "High");
    assert.equal(fixture.sendBtn.textContent, "");
    assert.equal(fixture.cancelBtn.textContent, "");
    assert.equal(fixture.sendBtn.title, "Send");
    assert.equal(fixture.cancelBtn.title, "Cancel");
    assert.equal(fixture.panelRoot.dataset.llmActionLayoutMode, "full");

    fixture.setWidth(40);
    layout();
    assert.equal(fixture.modelBtn.textContent, "");
    assert.equal(fixture.sendBtn.textContent, "");
    assert.equal(fixture.cancelBtn.textContent, "");

    fixture.setWidth(0);
    layout();
    fixture.modelBtn.dataset.modelLabel = "New model";
    fixture.setWidth(600);
    layout();
    assert.equal(fixture.modelBtn.textContent, "New model");
    assert.equal(fixture.panelRoot.dataset.llmActionLayoutMode, "full");
    assert.lengthOf(fixture.pendingFrames, 0);
  });

  it("shows model and effort as text only when both fit on one line", function () {
    // Text is 8 px a character, plus 1 px for rounding: "Example model" 105,
    // "High" 33, send 36.
    const fixture = layoutFixture(174);
    const layout = fixture.controller.applyResponsiveActionButtonsLayout;
    layout();
    assert.equal(fixture.modelBtn.textContent, "Example model");
    assert.equal(fixture.reasoningBtn.textContent, "High");

    // Room for the effort text beside a model icon, but not for both texts.
    fixture.setWidth(150);
    layout();
    assert.equal(fixture.modelBtn.textContent, "");
    assert.equal(fixture.reasoningBtn.textContent, "");
    assert.isTrue(
      fixture.reasoningBtn.classList.contains("llm-reasoning-btn-collapsed"),
    );
    assert.equal(fixture.panelRoot.dataset.llmActionLayoutMode, "half");
  });

  it("skips the measure-and-apply pass when nothing it reads has changed", function () {
    const fixture = layoutFixture(600);
    const layout = fixture.controller.applyResponsiveActionButtonsLayout;
    layout();
    assert.equal(fixture.modelBtn.textContent, "Example model");
    const togglesAfterFirst = fixture.classToggles;
    const styleReadsAfterFirst = fixture.styleReads;

    layout();
    layout();
    assert.equal(fixture.classToggles, togglesAfterFirst);
    assert.isAtMost(fixture.styleReads - styleReadsAfterFirst, 2);

    fixture.modelBtn.dataset.modelLabel = "Other model";
    layout();
    assert.equal(fixture.modelBtn.textContent, "Other model");
    assert.isAbove(fixture.classToggles, togglesAfterFirst);

    const togglesAfterLabel = fixture.classToggles;
    fixture.setWidth(40);
    layout();
    assert.isAbove(fixture.classToggles, togglesAfterLabel);
    assert.equal(fixture.modelBtn.textContent, "");

    // Something else rewrote a label: the next layout restores it.
    fixture.setWidth(600);
    layout();
    fixture.modelBtn.textContent = "stale";
    layout();
    assert.equal(fixture.modelBtn.textContent, "Other model");
  });
});
