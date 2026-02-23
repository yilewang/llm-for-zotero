export const MODEL_MENU_OPEN_CLASS = "llm-model-menu-open";
export const REASONING_MENU_OPEN_CLASS = "llm-reasoning-menu-open";
export const RETRY_MODEL_MENU_OPEN_CLASS = "llm-model-menu-open";
export const SLASH_MENU_OPEN_CLASS = "llm-slash-menu-open";

export function setFloatingMenuOpen(
  menu: HTMLDivElement | null,
  openClass: string,
  isOpen: boolean,
): void {
  if (!menu) return;
  if (isOpen) {
    menu.style.display = "grid";
    menu.classList.add(openClass);
    return;
  }
  menu.classList.remove(openClass);
  menu.style.display = "none";
}

export function isFloatingMenuOpen(menu: HTMLDivElement | null): boolean {
  return Boolean(menu && menu.style.display !== "none");
}

export function positionFloatingMenu(
  owner: Element,
  menu: HTMLDivElement,
  anchor: HTMLButtonElement,
): void {
  const win = owner.ownerDocument?.defaultView;
  if (!win) return;

  const viewportMargin = 8;
  const gap = 6;

  menu.style.position = "fixed";
  menu.style.display = "grid";
  menu.style.visibility = "hidden";
  menu.style.maxHeight = `${Math.max(120, win.innerHeight - viewportMargin * 2)}px`;
  menu.style.overflowY = "auto";

  const anchorRect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();

  let left = anchorRect.left;
  const maxLeft = Math.max(
    viewportMargin,
    win.innerWidth - menuRect.width - viewportMargin,
  );
  left = Math.min(Math.max(viewportMargin, left), maxLeft);

  const belowTop = anchorRect.bottom + gap;
  const aboveTop = anchorRect.top - gap - menuRect.height;
  let top = belowTop;

  if (belowTop + menuRect.height > win.innerHeight - viewportMargin) {
    if (aboveTop >= viewportMargin) {
      top = aboveTop;
    } else {
      top = Math.max(
        viewportMargin,
        win.innerHeight - menuRect.height - viewportMargin,
      );
    }
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = "visible";
}
