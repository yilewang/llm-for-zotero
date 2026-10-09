import { assert } from "chai";
import { waitForNativeWindowFrame } from "../test-workflows/nativeWindowReadiness";

type NativeTestWindow = Parameters<typeof waitForNativeWindowFrame>[0];
type FrameMode = "async" | "stalled";

function createNativeWindow({
  visibility = "visible",
  windowState = 3,
  frameMode = "async",
}: {
  visibility?: DocumentVisibilityState;
  windowState?: number;
  frameMode?: FrameMode;
} = {}) {
  let visibilityState = visibility;
  let nextFrame = 1;
  let focusAction: (() => void) | undefined;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const cancelledFrames: number[] = [];
  const win = {
    document: {
      get visibilityState() {
        return visibilityState;
      },
    },
    closed: false,
    windowState,
    STATE_MINIMIZED: 2,
    focusCalls: 0,
    restoreCalls: 0,
    focus() {
      this.focusCalls++;
      focusAction?.();
    },
    restore() {
      this.restoreCalls++;
    },
    requestAnimationFrame(callback: FrameRequestCallback) {
      const frame = nextFrame++;
      pendingFrames.set(frame, callback);
      if (frameMode === "async") {
        timers.set(
          frame,
          setTimeout(() => {
            timers.delete(frame);
            this.deliverFrame(frame);
          }, 0),
        );
      }
      return frame;
    },
    cancelAnimationFrame(frame: number) {
      cancelledFrames.push(frame);
      pendingFrames.delete(frame);
      const timer = timers.get(frame);
      if (timer) clearTimeout(timer);
      timers.delete(frame);
    },
    deliverFrame(frame = 1) {
      const callback = pendingFrames.get(frame);
      pendingFrames.delete(frame);
      callback?.(Date.now());
    },
  };
  return {
    win: win as unknown as NativeTestWindow,
    cancelledFrames,
    setClosed: (closed: boolean) => (win.closed = closed),
    setFocusAction: (action: () => void) => (focusAction = action),
    setVisibility: (nextVisibility: DocumentVisibilityState) =>
      (visibilityState = nextVisibility),
    get focusCalls() {
      return win.focusCalls;
    },
    get restoreCalls() {
      return win.restoreCalls;
    },
    deliverFrame: win.deliverFrame.bind(win),
  };
}

async function assertRejects(promise: Promise<void>, message: string) {
  await promise.then(
    () => assert.fail("expected native window readiness to reject"),
    (error: unknown) => {
      assert.instanceOf(error, Error);
      assert.include((error as Error).message, message);
    },
  );
}

describe("native window readiness", function () {
  this.timeout(3000);

  it("resolves after an asynchronous frame from a visible host", async function () {
    const fixture = createNativeWindow();

    await waitForNativeWindowFrame(fixture.win, 1000);

    assert.equal(fixture.focusCalls, 0);
    assert.equal(fixture.restoreCalls, 0);
  });

  it("focuses an occluded normal host without restoring state 3", async function () {
    const fixture = createNativeWindow({
      visibility: "hidden",
      windowState: 3,
    });
    fixture.setFocusAction(() => fixture.setVisibility("visible"));

    await waitForNativeWindowFrame(fixture.win, 1000);

    assert.equal(fixture.focusCalls, 1);
    assert.equal(fixture.restoreCalls, 0);
  });

  it("restores a minimized state 2 host before waiting for its frame", async function () {
    const fixture = createNativeWindow({
      visibility: "hidden",
      windowState: 2,
    });
    fixture.setFocusAction(() => fixture.setVisibility("visible"));

    await waitForNativeWindowFrame(fixture.win, 1000);

    assert.equal(fixture.restoreCalls, 1);
    assert.equal(fixture.focusCalls, 1);
  });

  it("rejects a host that remains hidden through a short timeout", async function () {
    const fixture = createNativeWindow({ visibility: "hidden" });

    await assertRejects(
      waitForNativeWindowFrame(fixture.win, 60),
      "Native test host is not visible",
    );

    assert.isAtLeast(fixture.focusCalls, 1);
  });

  it("cancels a stalled animation frame callback on timeout", async function () {
    const fixture = createNativeWindow({ frameMode: "stalled" });

    await assertRejects(
      waitForNativeWindowFrame(fixture.win, 60),
      "did not deliver an animation frame",
    );

    assert.deepEqual(fixture.cancelledFrames, [1]);
  });

  for (const [name, change] of [
    [
      "visibility loss",
      (fixture: ReturnType<typeof createNativeWindow>) =>
        fixture.setVisibility("hidden"),
    ],
    [
      "window closure",
      (fixture: ReturnType<typeof createNativeWindow>) =>
        fixture.setClosed(true),
    ],
  ] as const) {
    it(`rejects ${name} during the animation frame`, async function () {
      const fixture = createNativeWindow({ frameMode: "stalled" });
      const readiness = waitForNativeWindowFrame(fixture.win, 60);

      change(fixture);
      fixture.deliverFrame();

      await assertRejects(readiness, "lost visibility during animation frame");
    });
  }
});
