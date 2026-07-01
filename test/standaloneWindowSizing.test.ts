import { assert } from "chai";
import { describe, it } from "mocha";
import {
  computeStandaloneContextFitHeight,
  resizeStandaloneWindowToFitElement,
  scheduleStandaloneWindowFitForElement,
} from "../src/modules/contextPanel/standaloneWindowSizing";

describe("standalone window sizing", function () {
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
