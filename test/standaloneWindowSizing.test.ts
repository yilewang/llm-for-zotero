import { assert } from "chai";
import { describe, it } from "mocha";
import {
  computeStandaloneSidebarPanelWidth,
  computeStandaloneSidebarWidthLayout,
  computeStandaloneManualVerticalResize,
  computeStandaloneContextFitHeight,
  installStandaloneSidebarResizeBehavior,
  installStandaloneVerticalResizeBehavior,
  resizeStandaloneWindowToFitElement,
  scheduleStandaloneWindowFitForElement,
} from "../src/modules/contextPanel/standaloneWindowSizing";

describe("standalone window sizing", function () {
  it("clamps the History pane while preserving room for the main chat", function () {
    assert.equal(
      computeStandaloneSidebarPanelWidth({
        requestedWidth: 380,
        containerWidth: 900,
      }),
      380,
    );
    assert.equal(
      computeStandaloneSidebarPanelWidth({
        requestedWidth: 380,
        containerWidth: 700,
      }),
      287,
    );
    assert.equal(
      computeStandaloneSidebarPanelWidth({
        requestedWidth: 80,
        containerWidth: 900,
      }),
      160,
    );
  });

  it("returns the rendered width and effective maximum from one layout calculation", function () {
    assert.deepEqual(
      computeStandaloneSidebarWidthLayout({
        requestedWidth: 420,
        containerWidth: 640,
      }),
      { renderedWidth: 227, effectiveMaxWidth: 227 },
    );
  });

  it("drags, keyboard-resizes, persists, and responsively restores the History pane", function () {
    const separatorListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();
    const cssProperties = new Map<string, string>();
    const attributes = new Map<string, string>();
    const classes = new Set<string>();
    const container = {
      clientWidth: 900,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    } as unknown as HTMLElement;
    const sidebarPanel = {
      style: {
        setProperty: (name: string, value: string) => {
          cssProperties.set(name, value);
        },
      },
      getBoundingClientRect: () => ({ width: 220 }),
    } as unknown as HTMLElement;
    const separator = {
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
      addEventListener: (type: string, listener: EventListener) => {
        separatorListeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        separatorListeners.delete(type);
      },
      setCapture: () => {},
      releaseCapture: () => {},
    } as unknown as HTMLElement;
    const win = {
      addEventListener: (type: string, listener: EventListener) => {
        windowListeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        windowListeners.delete(type);
      },
    } as unknown as Window;
    const committedWidths: number[] = [];
    const cleanup = installStandaloneSidebarResizeBehavior(
      win,
      container,
      sidebarPanel,
      separator,
      {
        initialWidth: 220,
        onWidthCommit: (width) => committedWidths.push(width),
      },
    );

    separatorListeners.get("mousedown")?.({
      button: 0,
      screenX: 300,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as MouseEvent);
    windowListeners.get("mousemove")?.({
      screenX: 380,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as MouseEvent);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "300px",
    );
    assert.isTrue(classes.has("llm-standalone-sidebar-resizing"));
    windowListeners.get("mouseup")?.({} as Event);
    assert.deepEqual(committedWidths, [300]);
    assert.isFalse(classes.has("llm-standalone-sidebar-resizing"));

    separatorListeners.get("keydown")?.({
      key: "ArrowLeft",
      shiftKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as KeyboardEvent);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "288px",
    );
    assert.deepEqual(committedWidths, [300, 288]);

    (container as unknown as { clientWidth: number }).clientWidth = 640;
    windowListeners.get("resize")?.({} as Event);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "227px",
    );
    assert.equal(attributes.get("aria-valuemax"), "227");
    assert.deepEqual(committedWidths, [300, 288]);

    (container as unknown as { clientWidth: number }).clientWidth = 900;
    windowListeners.get("resize")?.({} as Event);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "288px",
    );
    assert.equal(attributes.get("aria-valuenow"), "288");

    separatorListeners.get("keydown")?.({
      key: "End",
      shiftKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as KeyboardEvent);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "420px",
    );
    assert.deepEqual(committedWidths, [300, 288, 420]);

    (container as unknown as { clientWidth: number }).clientWidth = 800;
    windowListeners.get("resize")?.({} as Event);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "387px",
    );
    assert.deepEqual(committedWidths, [300, 288, 420]);

    separatorListeners.get("keydown")?.({
      key: "ArrowLeft",
      shiftKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as KeyboardEvent);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "375px",
    );
    assert.deepEqual(committedWidths, [300, 288, 420, 375]);

    (container as unknown as { clientWidth: number }).clientWidth = 900;
    windowListeners.get("resize")?.({} as Event);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "375px",
    );

    cleanup();
    assert.isUndefined(separatorListeners.get("mousedown"));
    assert.isUndefined(windowListeners.get("mousemove"));
  });

  it("coalesces drag movement and commits the unclamped preferred width", function () {
    const separatorListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    const cancelledFrames: number[] = [];
    const cssProperties = new Map<string, string>();
    let widthReads = 0;
    let nextFrameId = 1;
    let containerWidth = 640;
    const container = {
      get clientWidth() {
        widthReads += 1;
        return containerWidth;
      },
      classList: { add: () => {}, remove: () => {} },
    } as unknown as HTMLElement;
    const sidebarPanel = {
      style: {
        setProperty: (name: string, value: string) => {
          cssProperties.set(name, value);
        },
      },
      getBoundingClientRect: () => ({ width: 220 }),
    } as unknown as HTMLElement;
    const separator = {
      setAttribute: () => {},
      addEventListener: (type: string, listener: EventListener) => {
        separatorListeners.set(type, listener);
      },
      removeEventListener: (type: string) => separatorListeners.delete(type),
      setCapture: () => {},
      releaseCapture: () => {},
    } as unknown as HTMLElement;
    const win = {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frameCallbacks.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => {
        cancelledFrames.push(id);
        frameCallbacks.delete(id);
      },
      addEventListener: (type: string, listener: EventListener) => {
        windowListeners.set(type, listener);
      },
      removeEventListener: (type: string) => windowListeners.delete(type),
    } as unknown as Window;
    const committedWidths: number[] = [];
    const cleanup = installStandaloneSidebarResizeBehavior(
      win,
      container,
      sidebarPanel,
      separator,
      { onWidthCommit: (width) => committedWidths.push(width) },
    );
    assert.equal(widthReads, 1);

    separatorListeners.get("mousedown")?.({
      button: 0,
      screenX: 300,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as MouseEvent);
    for (const screenX of [420, 500]) {
      windowListeners.get("mousemove")?.({
        screenX,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as MouseEvent);
    }

    assert.equal(frameCallbacks.size, 1);
    assert.equal(widthReads, 1);
    const frame = [...frameCallbacks.entries()][0];
    frameCallbacks.delete(frame[0]);
    frame[1](0);
    assert.equal(widthReads, 2);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "227px",
    );

    windowListeners.get("mouseup")?.({} as Event);
    assert.deepEqual(committedWidths, [420]);
    assert.isEmpty(cancelledFrames);

    containerWidth = 900;
    separatorListeners.get("mousedown")?.({
      button: 0,
      screenX: 300,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as MouseEvent);
    windowListeners.get("mousemove")?.({
      screenX: 320,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as MouseEvent);
    const pendingFrameId = [...frameCallbacks.keys()][0];
    windowListeners.get("mouseup")?.({ screenX: 380 } as MouseEvent);
    assert.deepEqual(cancelledFrames, [pendingFrameId]);
    assert.equal(frameCallbacks.size, 0);
    assert.deepEqual(committedWidths, [420, 300]);
    assert.equal(
      cssProperties.get("--llm-standalone-sidebar-panel-width"),
      "300px",
    );
    cleanup();
  });

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
