function resolveMenuBounds(element: Element): DOMRect {
  // 1. Is the element itself the floating panel?
  if (element.classList?.contains("llm-panel-floating")) {
    return element.getBoundingClientRect();
  }

  // 2. Does it contain the floating panel? (Most likely case for 'body')
  const floatingChild = element.querySelector(".llm-panel-floating");
  if (floatingChild) {
    return floatingChild.getBoundingClientRect();
  }

  // 3. Is it inside the floating panel? (e.g. if passed a button inside)
  const floatingParent = element.closest(".llm-panel-floating");
  if (floatingParent) {
    return floatingParent.getBoundingClientRect();
  }

  // 4. Fallback: Use the element's own rect (Sidebar behavior)
  return element.getBoundingClientRect();
}

export function positionMenuAtPointer(
  body: Element,
  menu: HTMLDivElement,
  clientX: number,
  clientY: number,
): void {
  const isFloating = Boolean(
    body.classList?.contains("llm-panel-floating") ||
    ((body as any).__llmFloatedPanel || body).querySelector(".llm-panel-floating") ||
    body.closest(".llm-panel-floating")
  );

  const win = isFloating
    ? (Zotero.getMainWindow() as Window)
    : body.ownerDocument?.defaultView;

  if (!win) return;

  const viewportMargin = 8;
  const panelRect = resolveMenuBounds(body);
  const minLeftBound = Math.max(viewportMargin, Math.round(panelRect.left) + 2);
  const minTopBound = Math.max(viewportMargin, Math.round(panelRect.top) + 2);
  menu.style.position = "fixed";
  menu.style.display = "grid";
  menu.style.visibility = "hidden";
  menu.style.maxHeight = `${Math.max(120, Math.floor(panelRect.height) - viewportMargin * 2)}px`;
  menu.style.overflowY = "auto";

  const menuRect = menu.getBoundingClientRect();
  const maxLeft = Math.max(
    minLeftBound,
    Math.min(
      win.innerWidth - menuRect.width - viewportMargin,
      Math.round(panelRect.right) - menuRect.width - 2,
    ),
  );
  const maxTop = Math.max(
    minTopBound,
    Math.min(
      win.innerHeight - menuRect.height - viewportMargin,
      Math.round(panelRect.bottom) - menuRect.height - 2,
    ),
  );
  const left = Math.min(Math.max(minLeftBound, clientX), maxLeft);
  const top = Math.min(Math.max(minTopBound, clientY), maxTop);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = "visible";
}

function applyPanelBoundMenuWidth(
  body: Element,
  menu: HTMLDivElement,
  viewportMargin: number,
): void {
  const panelRect = resolveMenuBounds(body);
  const availableWidth = Math.max(
    1,
    Math.floor(panelRect.width) - viewportMargin * 2 - 4,
  );
  if (menu.id === "llm-history-menu") {
    menu.style.boxSizing = "border-box";
    menu.style.minWidth = `${Math.min(240, availableWidth)}px`;
    menu.style.width = `${Math.min(360, availableWidth)}px`;
    menu.style.maxWidth = `${availableWidth}px`;
    return;
  }
  menu.style.maxWidth = `${availableWidth}px`;
}

export function positionMenuBelowButton(
  body: Element,
  menu: HTMLDivElement,
  button: HTMLElement,
): void {
  const isFloating = Boolean(
    body.classList?.contains("llm-panel-floating") ||
    ((body as any).__llmFloatedPanel || body).querySelector(".llm-panel-floating") ||
    body.closest(".llm-panel-floating")
  );

  const win = isFloating
    ? (Zotero.getMainWindow() as Window)
    : body.ownerDocument?.defaultView;

  if (!win) return;

  const viewportMargin = 8;
  const panelRect = resolveMenuBounds(body);
  const minLeftBound = Math.max(viewportMargin, Math.round(panelRect.left) + 2);
  const minTopBound = Math.max(viewportMargin, Math.round(panelRect.top) + 2);
  const maxRightBound = Math.round(panelRect.right) - 2;
  const maxBottomBound = Math.round(panelRect.bottom) - 2;
  const buttonRect = button.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.display = "grid";
  menu.style.visibility = "hidden";
  menu.style.maxHeight = `${Math.max(120, Math.floor(panelRect.height) - viewportMargin * 2)}px`;
  menu.style.overflowY = "auto";
  applyPanelBoundMenuWidth(body, menu, viewportMargin);

  const menuRect = menu.getBoundingClientRect();
  const maxLeft = Math.max(
    minLeftBound,
    Math.min(
      win.innerWidth - menuRect.width - viewportMargin,
      maxRightBound - menuRect.width,
    ),
  );
  const maxTop = Math.max(
    minTopBound,
    Math.min(
      win.innerHeight - menuRect.height - viewportMargin,
      maxBottomBound - menuRect.height,
    ),
  );
  const preferredLeft =
    buttonRect.left + menuRect.width <= maxRightBound
      ? buttonRect.left
      : buttonRect.right - menuRect.width;
  const spaceBelow = maxBottomBound - buttonRect.bottom;
  const spaceAbove = buttonRect.top - minTopBound;
  const preferredTop =
    spaceBelow >= menuRect.height || spaceBelow >= spaceAbove
      ? buttonRect.bottom + 6
      : buttonRect.top - menuRect.height - 6;
  const left = Math.min(Math.max(minLeftBound, preferredLeft), maxLeft);
  const top = Math.min(Math.max(minTopBound, preferredTop), maxTop);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = "visible";
}
