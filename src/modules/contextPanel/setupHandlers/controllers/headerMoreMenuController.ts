type HeaderMoreMenuDeps = {
  body: Element;
  panelDoc: Document;
  moreBtn: HTMLButtonElement | null;
  menu: HTMLDivElement | null;
  /** The header buttons the items stand for; their handlers do the work. */
  taskProgressBtn: HTMLButtonElement | null;
  popoutBtn: HTMLButtonElement | null;
  settingsBtn: HTMLButtonElement | null;
  exportBtn: HTMLButtonElement | null;
  clearBtn: HTMLButtonElement | null;
  /** Closes the other header and composer menus before this one opens. */
  closeOtherMenus: () => void;
};

export type HeaderMoreMenuController = {
  isOpen: () => boolean;
  close: () => void;
  dispose: () => void;
};

/**
 * The Stacked header's More strip: icon buttons, no text. Task progress and
 * Open in window (tight stage only), Settings, Export and Delete keep their
 * one handler each, on their own buttons: an item clicks its button, so
 * authorization, confirmation and disabled state stay in one place. The
 * buttons are hidden while the row is collapsed, which does not stop a
 * programmatic click.
 */
export function attachHeaderMoreMenuController(
  deps: HeaderMoreMenuDeps,
): HeaderMoreMenuController {
  const { panelDoc, moreBtn, menu } = deps;
  const noop: HeaderMoreMenuController = {
    isOpen: () => false,
    close: () => {},
    dispose: () => {},
  };
  if (!moreBtn || !menu) return noop;

  const isOpen = () => menu.style.display !== "none";
  const close = () => {
    menu.style.display = "none";
    moreBtn.setAttribute("aria-expanded", "false");
  };

  const items: Array<{
    id: string;
    source: HTMLButtonElement | null;
    /** Shown only while the header row is in its tight stage. */
    tightOnly?: boolean;
  }> = [
    {
      id: "llm-header-more-task-progress",
      source: deps.taskProgressBtn,
      tightOnly: true,
    },
    { id: "llm-header-more-popout", source: deps.popoutBtn, tightOnly: true },
    { id: "llm-header-more-settings", source: deps.settingsBtn },
    { id: "llm-header-more-export", source: deps.exportBtn },
    { id: "llm-header-more-delete", source: deps.clearBtn },
  ];
  const itemEl = (id: string) =>
    menu.querySelector<HTMLButtonElement>(`#${id}`);

  // The items mirror their buttons when the menu opens, so a state the
  // buttons carry (Export off without a conversation, Exit in a web chat)
  // shows here too.
  const syncItems = () => {
    const tight =
      moreBtn.closest<HTMLElement>(".llm-header-nav-row")?.dataset.fit ===
      "tight";
    let topShown = 0;
    for (const { id, source, tightOnly } of items) {
      const el = itemEl(id);
      if (!el) continue;
      if (tightOnly) {
        // Code hides a button inline (Task progress when it does not apply).
        const show =
          tight && Boolean(source) && source!.style.display !== "none";
        const display = show ? "" : "none";
        if (el.style.display !== display) el.style.display = display;
        if (show) topShown++;
      }
      el.disabled = !source || source.disabled;
    }
    const topSeparator = itemEl("llm-header-more-top-separator");
    if (topSeparator) {
      const display = topShown > 0 ? "" : "none";
      if (topSeparator.style.display !== display) {
        topSeparator.style.display = display;
      }
    }
    // These buttons' titles change with state (Show or Hide task progress)
    // and the strip has no text, so the title is the item's only name.
    for (const { id, source } of items) {
      const el = itemEl(id);
      const label = source?.title;
      if (!el || !label) continue;
      if (el.title !== label) el.title = label;
      if (el.getAttribute("aria-label") !== label) {
        el.setAttribute("aria-label", label);
      }
    }
  };

  // Right edge on the More button, below it, kept inside the panel.
  const position = () => {
    const win = deps.body.ownerDocument?.defaultView;
    if (!win) return;
    const margin = 8;
    const panelRect = deps.body.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.display = "flex";
    menu.style.visibility = "hidden";
    const menuRect = menu.getBoundingClientRect();
    const buttonRect = moreBtn.getBoundingClientRect();
    const minLeft = Math.max(margin, Math.round(panelRect.left) + 2);
    const maxLeft = Math.max(
      minLeft,
      Math.min(
        win.innerWidth - menuRect.width - margin,
        Math.round(panelRect.right) - 2 - menuRect.width,
      ),
    );
    const left = Math.min(
      Math.max(minLeft, buttonRect.right - menuRect.width),
      maxLeft,
    );
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(buttonRect.bottom + 6)}px`;
    menu.style.visibility = "visible";
  };

  const open = () => {
    deps.closeOtherMenus();
    syncItems();
    position();
    moreBtn.setAttribute("aria-expanded", "true");
  };

  const onMoreClick = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isOpen()) close();
    else open();
  };
  moreBtn.addEventListener("click", onMoreClick);

  for (const { id, source } of items) {
    itemEl(id)?.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const el = itemEl(id);
      if (!el || el.disabled || !source || source.disabled) return;
      close();
      source.click();
    });
  }

  const stop = (event: Event) => event.stopPropagation();
  menu.addEventListener("pointerdown", stop);
  menu.addEventListener("mousedown", stop);

  const onOutsidePointerDown = (event: Event) => {
    if (!isOpen()) return;
    const target = event.target as Node | null;
    if (target && (menu.contains(target) || moreBtn.contains(target))) return;
    close();
  };
  const onKeyDown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== "Escape" || !isOpen()) return;
    close();
    moreBtn.focus();
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
  };
  panelDoc.addEventListener("pointerdown", onOutsidePointerDown, true);
  panelDoc.addEventListener("keydown", onKeyDown, true);

  return {
    isOpen,
    close,
    dispose: () => {
      panelDoc.removeEventListener("pointerdown", onOutsidePointerDown, true);
      panelDoc.removeEventListener("keydown", onKeyDown, true);
      moreBtn.removeEventListener("click", onMoreClick);
    },
  };
}
