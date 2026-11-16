function parseCssPixels(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Drag on the sidebar's corner handle (`.llm-chat-shell-resize-handle`) to
 * change the chat area's height. The new height is the start height plus the
 * pointer's vertical travel, within the chat shell's computed min-height and
 * max-height. The handle shows its arc while the drag runs.
 */
export function installChatShellResizeBehavior(
  win: Window,
  root: HTMLElement,
): () => void {
  type ActiveDrag = {
    handle: HTMLElement;
    shell: HTMLElement;
    startScreenY: number;
    startHeight: number;
    minHeight: number;
    maxHeight: number;
    lastHeight: number;
  };

  let activeDrag: ActiveDrag | null = null;

  const endDrag = () => {
    const drag = activeDrag;
    activeDrag = null;
    drag?.handle.classList.remove("llm-resize-handle-active");
    try {
      (drag?.handle as any)?.releaseCapture?.();
    } catch {
      // Gecko can throw if capture was already released by window teardown.
    }
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const handle = (event.target as HTMLElement | null)?.closest?.(
      ".llm-chat-shell-resize-handle",
    ) as HTMLElement | null;
    if (!handle || !root.contains(handle)) return;
    const shell = root.querySelector("#llm-chat-shell") as HTMLElement | null;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    if (!rect.height) return;

    const computed = win.getComputedStyle(shell);
    // Min, max and `style.height` exclude padding and border when the shell is
    // content-box; the shell's rect includes them.
    const extra =
      computed?.boxSizing === "border-box"
        ? 0
        : (parseCssPixels(computed?.paddingTop) ?? 0) +
          (parseCssPixels(computed?.paddingBottom) ?? 0) +
          (parseCssPixels(computed?.borderTopWidth) ?? 0) +
          (parseCssPixels(computed?.borderBottomWidth) ?? 0);
    const startHeight = rect.height - extra;
    activeDrag = {
      handle,
      shell,
      startScreenY: event.screenY,
      startHeight,
      minHeight: parseCssPixels(computed?.minHeight) ?? 0,
      maxHeight:
        parseCssPixels(computed?.maxHeight) ?? Number.POSITIVE_INFINITY,
      lastHeight: startHeight,
    };
    handle.classList.add("llm-resize-handle-active");
    try {
      (handle as any).setCapture?.(true);
    } catch {
      // Window-level listeners still keep the drag active without capture.
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onMouseMove = (event: MouseEvent) => {
    const drag = activeDrag;
    if (!drag) return;
    const next = Math.min(
      drag.maxHeight,
      Math.max(
        drag.minHeight,
        drag.startHeight + (event.screenY - drag.startScreenY),
      ),
    );
    if (next !== drag.lastHeight) {
      drag.shell.style.height = `${Math.round(next * 100) / 100}px`;
      drag.lastHeight = next;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  root.addEventListener("mousedown", onMouseDown, true);
  win.addEventListener("mousemove", onMouseMove, true);
  win.addEventListener("mouseup", endDrag, true);
  win.addEventListener("blur", endDrag);

  return () => {
    endDrag();
    root.removeEventListener("mousedown", onMouseDown, true);
    win.removeEventListener("mousemove", onMouseMove, true);
    win.removeEventListener("mouseup", endDrag, true);
    win.removeEventListener("blur", endDrag);
  };
}
