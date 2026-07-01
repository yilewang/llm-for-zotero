import { t } from "../../../../utils/i18n";

const CONTEXT_BAR_OCCUPIED_SELECTORS = [
  "#llm-runtime-mode-toggle",
  ".llm-context-agent-toggle",
  ".llm-selected-context",
  ".llm-paper-context-chip",
  ".llm-other-ref-chip",
  ".llm-collection-context-chip",
  ".llm-tag-context-chip",
  ".llm-image-preview",
  "#llm-file-context-preview",
  "#llm-paper-context-preview",
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']",
];

type ContextBarClearMenuDeps = {
  body: Element;
  contextPreviews: HTMLDivElement | null;
  contextBarMenu: HTMLDivElement | null;
  contextBarClearBtn: HTMLButtonElement | null;
  hasContext: () => boolean;
  clearContext: () => void;
  closeOtherMenus: () => void;
  positionMenuAtPointer: (
    menu: HTMLDivElement,
    clientX: number,
    clientY: number,
  ) => void;
};

export function isContextBarEmptyAreaTarget(
  contextPreviews: Element,
  target: EventTarget | null,
): boolean {
  if (!target || !(contextPreviews as any).contains?.(target)) return false;
  if (target === contextPreviews) return true;
  const element = target as Element;
  if (typeof element.closest !== "function") return false;
  return !CONTEXT_BAR_OCCUPIED_SELECTORS.some((selector) =>
    Boolean(element.closest(selector)),
  );
}

export function syncContextBarClearMenuState(params: {
  menu: HTMLDivElement | null;
  clearButton: HTMLButtonElement | null;
  hasContext: boolean;
}): void {
  const { menu, clearButton, hasContext } = params;
  if (menu) menu.hidden = false;
  if (!clearButton) return;
  clearButton.disabled = !hasContext;
  clearButton.setAttribute?.("aria-disabled", hasContext ? "false" : "true");
  clearButton.title = hasContext ? t("Clear all") : t("No context to clear");
}

export function attachContextBarClearMenuController(
  deps: ContextBarClearMenuDeps,
): void {
  const {
    contextPreviews,
    contextBarMenu,
    contextBarClearBtn,
    body,
  } = deps;
  if (!contextPreviews || !contextBarMenu || !contextBarClearBtn) return;

  const closeMenu = (): void => {
    contextBarMenu.style.display = "none";
  };

  const syncMenuState = (): void => {
    syncContextBarClearMenuState({
      menu: contextBarMenu,
      clearButton: contextBarClearBtn,
      hasContext: deps.hasContext(),
    });
  };

  contextBarMenu.addEventListener("pointerdown", (event: Event) => {
    event.stopPropagation();
  });
  contextBarMenu.addEventListener("mousedown", (event: Event) => {
    event.stopPropagation();
  });
  contextBarMenu.addEventListener("contextmenu", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  contextPreviews.addEventListener("contextmenu", (event: Event) => {
    if (!isContextBarEmptyAreaTarget(contextPreviews, event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    deps.closeOtherMenus();
    syncMenuState();
    const mouseEvent = event as MouseEvent;
    deps.positionMenuAtPointer(
      contextBarMenu,
      mouseEvent.clientX,
      mouseEvent.clientY,
    );
    contextBarMenu.style.display = "grid";
  });

  contextBarClearBtn.addEventListener("click", (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (contextBarClearBtn.disabled) return;
    closeMenu();
    deps.clearContext();
  });

  const ownerDoc = body.ownerDocument;
  const bodyWithDismissHandlers = body as Element & {
    __llmContextBarMenuPointerDismiss?: (event: Event) => void;
    __llmContextBarMenuEscapeDismiss?: (event: Event) => void;
  };
  if (ownerDoc && bodyWithDismissHandlers.__llmContextBarMenuPointerDismiss) {
    ownerDoc.removeEventListener(
      "pointerdown",
      bodyWithDismissHandlers.__llmContextBarMenuPointerDismiss,
      true,
    );
  }
  if (ownerDoc && bodyWithDismissHandlers.__llmContextBarMenuEscapeDismiss) {
    ownerDoc.removeEventListener(
      "keydown",
      bodyWithDismissHandlers.__llmContextBarMenuEscapeDismiss,
      true,
    );
  }
  const dismissOnOutsidePointerDown = (event: Event): void => {
    if (contextBarMenu.style.display === "none") return;
    const target = event.target as Node | null;
    if (target && contextBarMenu.contains(target)) return;
    closeMenu();
  };
  const dismissOnEscape = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (
      keyboardEvent.key !== "Escape" ||
      contextBarMenu.style.display === "none"
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  };
  ownerDoc?.addEventListener("pointerdown", dismissOnOutsidePointerDown, true);
  ownerDoc?.addEventListener("keydown", dismissOnEscape, true);
  bodyWithDismissHandlers.__llmContextBarMenuPointerDismiss =
    dismissOnOutsidePointerDown;
  bodyWithDismissHandlers.__llmContextBarMenuEscapeDismiss = dismissOnEscape;
}
