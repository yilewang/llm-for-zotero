type ChromeWindow = Window & {
  windowState?: number;
  STATE_MINIMIZED?: number;
};

/**
 * Whether an element (a chat panel, a note editor) is on screen: still in its
 * document, laid out with a size (not display:none, not in a collapsed pane),
 * not hidden (a pane or editor of a tab that is not selected keeps its
 * layout box), in a window that is not minimized.
 */
export function isShownOnScreen(element: Element): boolean {
  if (!element.isConnected) return false;
  const win = element.ownerDocument?.defaultView as ChromeWindow | null;
  if (!win) return false;
  // STATE_MINIMIZED is 2 on every Gecko chrome window.
  if (
    typeof win.windowState === "number" &&
    win.windowState === (win.STATE_MINIMIZED ?? 2)
  ) {
    return false;
  }
  try {
    const visibility = win.getComputedStyle(element)?.visibility;
    if (visibility === "hidden" || visibility === "collapse") return false;
  } catch {
    // No computed style: fall back to the layout box below.
  }
  const rect = (element as HTMLElement).getBoundingClientRect?.();
  if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
  return true;
}
