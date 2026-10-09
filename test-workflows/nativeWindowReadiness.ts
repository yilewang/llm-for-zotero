type NativeTestWindow = Pick<
  Window,
  | "document"
  | "closed"
  | "focus"
  | "requestAnimationFrame"
  | "cancelAnimationFrame"
> & {
  windowState?: number;
  STATE_MINIMIZED?: number;
  restore?: () => void;
};

/**
 * Geometry/animation tests require a visible native host. A normal window may
 * be occluded on Windows, throttling rAF despite positive DOMRect dimensions.
 * Bound and cancel the frame wait so a timed-out fixture cannot mutate the
 * next test after Mocha has already continued.
 */
export async function waitForNativeWindowFrame(
  win: NativeTestWindow,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (win.document.visibilityState !== "visible") {
    if (win.closed || Date.now() >= deadline) {
      throw new Error(
        `Native test host is not visible: visibility=${win.document.visibilityState}, windowState=${win.windowState}, closed=${win.closed}`,
      );
    }
    if (
      win.STATE_MINIMIZED !== undefined &&
      win.windowState === win.STATE_MINIMIZED
    ) {
      win.restore?.();
    }
    win.focus();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (win.closed)
    throw new Error("Native test host closed before animation frame");
  await new Promise<void>((resolve, reject) => {
    let frame = 0;
    const timer = setTimeout(
      () => {
        win.cancelAnimationFrame(frame);
        reject(
          new Error(
            `Native test host did not deliver an animation frame: visibility=${win.document.visibilityState}, windowState=${win.windowState}`,
          ),
        );
      },
      Math.max(1, deadline - Date.now()),
    );
    frame = win.requestAnimationFrame(() => {
      clearTimeout(timer);
      if (win.closed || win.document.visibilityState !== "visible") {
        reject(
          new Error("Native test host lost visibility during animation frame"),
        );
      } else {
        resolve();
      }
    });
  });
}
