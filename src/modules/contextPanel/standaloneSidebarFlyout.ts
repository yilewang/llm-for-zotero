/**
 * Hover-to-reveal behaviour for the collapsed sidebar.
 *
 * While the sidebar is collapsed the rail is not rendered at all, so the only
 * way back to New chat, Search history, Skills and the conversation list
 * without permanently expanding is to hover the collapse toggle. The panel
 * then floats over the content until the pointer leaves it.
 *
 * Closing is deferred by a short grace period because the pointer has to cross
 * the gap between the toggle and the panel edge, and an immediate close there
 * would make the panel flicker away mid-travel.
 */

const CLOSE_GRACE_MS = 220;

type TimerHost = Pick<Window, "setTimeout" | "clearTimeout">;

export type StandaloneSidebarFlyoutOptions = {
  win: TimerHost;
  toggle: HTMLElement;
  panel: HTMLElement;
  /** The flyout only exists while the sidebar is not permanently expanded. */
  isCollapsed: () => boolean;
  setOpen: (open: boolean) => void;
  closeDelayMs?: number;
};

export function installStandaloneSidebarFlyout(
  options: StandaloneSidebarFlyoutOptions,
): () => void {
  const { win, toggle, panel, isCollapsed, setOpen } = options;
  const closeDelayMs = options.closeDelayMs ?? CLOSE_GRACE_MS;
  let closeTimer: number | null = null;

  const cancelPendingClose = () => {
    if (closeTimer === null) return;
    win.clearTimeout(closeTimer);
    closeTimer = null;
  };

  const closeNow = () => {
    cancelPendingClose();
    setOpen(false);
  };

  const open = () => {
    if (!isCollapsed()) return;
    cancelPendingClose();
    setOpen(true);
  };

  /** True while the pointer is still inside the flyout's own surfaces. */
  const staysInside = (target: unknown): boolean => {
    if (!target) return false;
    const node = target as Node;
    return toggle.contains(node) || panel.contains(node);
  };

  const scheduleClose = (event: MouseEvent) => {
    if (staysInside(event.relatedTarget)) return;
    cancelPendingClose();
    closeTimer = win.setTimeout(() => {
      closeTimer = null;
      setOpen(false);
    }, closeDelayMs) as unknown as number;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    closeNow();
  };

  toggle.addEventListener("mouseenter", open);
  toggle.addEventListener("mouseleave", scheduleClose as EventListener);
  toggle.addEventListener("keydown", onKeyDown as EventListener);
  panel.addEventListener("mouseenter", cancelPendingClose);
  panel.addEventListener("mouseleave", scheduleClose as EventListener);
  panel.addEventListener("keydown", onKeyDown as EventListener);
  // Choosing an action dismisses the flyout, so the panel never lingers over
  // the result of the click.
  panel.addEventListener("click", closeNow);

  return () => {
    cancelPendingClose();
    toggle.removeEventListener("mouseenter", open);
    toggle.removeEventListener("mouseleave", scheduleClose as EventListener);
    toggle.removeEventListener("keydown", onKeyDown as EventListener);
    panel.removeEventListener("mouseenter", cancelPendingClose);
    panel.removeEventListener("mouseleave", scheduleClose as EventListener);
    panel.removeEventListener("keydown", onKeyDown as EventListener);
    panel.removeEventListener("click", closeNow);
  };
}
