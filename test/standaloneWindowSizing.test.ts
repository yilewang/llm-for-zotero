import { assert } from "chai";
import { describe, it } from "mocha";
import {
  computeStandaloneManualVerticalResize,
  computeStandaloneContextFitHeight,
  installStandaloneVerticalResizeBehavior,
  resizeStandaloneWindowToFitElement,
  scheduleStandaloneWindowFitForElement,
} from "../src/modules/contextPanel/standaloneWindowSizing";

describe("standalone window sizing", function () {
  it("grows the window and chat panel together when its handle moves down", function () {
    assert.deepEqual(
      computeStandaloneManualVerticalResize({
        kind: "chat",
        startScreenY: 700,
        currentScreenY: 820,
        startWindowHeight: 900,
        startElementHeight: 540,
        minWindowHeight: 500,
        minElementHeight: 200,
      }),
      {
        windowHeight: 1020,
        elementHeight: 660,
      },
    );
  });

  it("grows the window and typing box together without consuming chat height", function () {
    assert.deepEqual(
      computeStandaloneManualVerticalResize({
        kind: "input",
        startScreenY: 760,
        currentScreenY: 850,
        startWindowHeight: 900,
        startElementHeight: 100,
        minWindowHeight: 500,
        minElementHeight: 60,
        maxElementHeight: 220,
      }),
      {
        windowHeight: 990,
        elementHeight: 190,
      },
    );
  });

  it("stops typing-box and window growth at the composer maximum", function () {
    assert.deepEqual(
      computeStandaloneManualVerticalResize({
        kind: "input",
        startScreenY: 760,
        currentScreenY: 980,
        startWindowHeight: 900,
        startElementHeight: 100,
        minWindowHeight: 500,
        minElementHeight: 60,
        maxElementHeight: 220,
      }),
      {
        windowHeight: 1020,
        elementHeight: 220,
      },
    );
  });

  it("marks a composer drag as a manual textarea height", function () {
    const rootListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();
    const input = {
      dataset: {} as DOMStringMap,
      style: { height: "100px" },
      getBoundingClientRect: () => ({ height: 100 }),
    } as unknown as HTMLTextAreaElement;
    const inputWrap = {
      querySelector: () => input,
    };
    const handle = {
      dataset: { resizeTarget: "input" },
      parentElement: inputWrap,
      closest: () => handle,
      setCapture: () => {},
      releaseCapture: () => {},
    };
    const root = {
      contains: () => true,
      classList: {
        add: () => {},
        remove: () => {},
      },
      addEventListener: (type: string, listener: EventListener) => {
        rootListeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        rootListeners.delete(type);
      },
    } as unknown as HTMLElement;
    const resizeCalls: Array<{ width: number; height: number }> = [];
    const win = {
      outerHeight: 900,
      outerWidth: 820,
      getComputedStyle: () => ({
        minHeight: "60px",
        maxHeight: "220px",
      }),
      resizeTo: (width: number, height: number) => {
        resizeCalls.push({ width, height });
      },
      addEventListener: (type: string, listener: EventListener) => {
        windowListeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        windowListeners.delete(type);
      },
    } as unknown as Window;
    const cleanup = installStandaloneVerticalResizeBehavior(win, root);

    rootListeners.get("mousedown")?.({
      button: 0,
      target: handle,
      screenY: 760,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as MouseEvent);
    windowListeners.get("mousemove")?.({
      screenY: 850,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as MouseEvent);

    assert.equal(input.dataset.llmManualHeight, "true");
    assert.equal(input.style.height, "190px");
    assert.deepEqual(resizeCalls, [{ width: 820, height: 990 }]);

    cleanup();
    assert.isUndefined(rootListeners.get("mousedown"));
    assert.isUndefined(windowListeners.get("mousemove"));
  });

  it("honors both window and element minimums while dragging upward", function () {
    assert.deepEqual(
      computeStandaloneManualVerticalResize({
        kind: "chat",
        startScreenY: 700,
        currentScreenY: 300,
        startWindowHeight: 620,
        startElementHeight: 320,
        minWindowHeight: 500,
        minElementHeight: 200,
      }),
      {
        windowHeight: 500,
        elementHeight: 200,
      },
    );
  });

  it("grows the outer window when the target element would be clipped", function () {
    assert.equal(
      computeStandaloneContextFitHeight({
        targetBottom: 540,
        innerHeight: 480,
        outerHeight: 520,
        screenY: 100,
        screenAvailTop: 0,
        screenAvailHeight: 900,
      }),
      604,
    );
  });

  it("does not resize when the target element already fits", function () {
    assert.isNull(
      computeStandaloneContextFitHeight({
        targetBottom: 430,
        innerHeight: 480,
        outerHeight: 520,
        screenY: 100,
        screenAvailTop: 0,
        screenAvailHeight: 900,
      }),
    );
  });

  it("caps growth at the available screen bottom", function () {
    assert.equal(
      computeStandaloneContextFitHeight({
        targetBottom: 460,
        innerHeight: 360,
        outerHeight: 400,
        screenY: 300,
        screenAvailTop: 0,
        screenAvailHeight: 780,
      }),
      480,
    );
  });

  it("resizes to keep the measured element visible", function () {
    const calls: Array<{ width: number; height: number }> = [];
    const win = {
      innerHeight: 480,
      outerHeight: 520,
      outerWidth: 820,
      screenY: 100,
      screen: { availTop: 0, availHeight: 900 },
      resizeTo: (width: number, height: number) => {
        calls.push({ width, height });
      },
    };
    const element = {
      getBoundingClientRect: () => ({ bottom: 540 }),
    };

    assert.isTrue(
      resizeStandaloneWindowToFitElement(win as any, element as any),
    );
    assert.deepEqual(calls, [{ width: 820, height: 604 }]);
  });

  it("skips a scheduled resize when the request becomes stale", function () {
    const calls: Array<{ width: number; height: number }> = [];
    let animationFrameCallback: FrameRequestCallback | null = null;
    const win = {
      innerHeight: 480,
      outerHeight: 520,
      outerWidth: 820,
      screenY: 100,
      screen: { availTop: 0, availHeight: 900 },
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        animationFrameCallback = callback;
        return 1;
      },
      resizeTo: (width: number, height: number) => {
        calls.push({ width, height });
      },
    };
    const element = {
      getBoundingClientRect: () => ({ bottom: 540 }),
    };

    scheduleStandaloneWindowFitForElement(
      win as any,
      element as any,
      {
        shouldRun: () => false,
      } as any,
    );
    assert.isFunction(animationFrameCallback);
    animationFrameCallback?.(0);

    assert.deepEqual(calls, []);
  });
});
