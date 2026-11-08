function positionSourceCard(wrapper: HTMLElement, popover: HTMLElement): void {
  const doc = wrapper.ownerDocument;
  const win = doc.defaultView;
  if (!win) return;
  popover.classList.remove("llm-web-source-popover-below");
  popover.style.top = "0px";
  popover.style.left = "0px";
  popover.style.width = "";
  popover.style.maxHeight = "";
  const anchorRect = wrapper.getBoundingClientRect();
  const messageViewport = wrapper.closest(
    ".llm-messages",
  ) as HTMLElement | null;
  const viewportRect = messageViewport?.getBoundingClientRect();
  const viewportPadding = 12;
  const viewportLeft = Math.max(0, viewportRect?.left ?? 0);
  const viewportTop = Math.max(0, viewportRect?.top ?? 0);
  const viewportRight =
    viewportRect?.right || doc.documentElement.clientWidth || win.innerWidth;
  const viewportBottom =
    viewportRect?.bottom || doc.documentElement.clientHeight || win.innerHeight;
  const availableWidth = Math.max(
    0,
    viewportRight - viewportLeft - viewportPadding * 2,
  );
  const cardWidth = Math.min(360, availableWidth);
  popover.style.width = `${Math.floor(cardWidth)}px`;
  const cardRect = popover.getBoundingClientRect();
  const desiredLeft = anchorRect.right - cardWidth;
  const clampedLeft = Math.min(
    Math.max(viewportLeft + viewportPadding, desiredLeft),
    Math.max(
      viewportLeft + viewportPadding,
      viewportRight - cardWidth - viewportPadding,
    ),
  );
  popover.style.left = `${Math.floor(clampedLeft)}px`;
  const availableAbove = Math.max(
    0,
    anchorRect.top - viewportTop - viewportPadding - 8,
  );
  const availableBelow = Math.max(
    0,
    viewportBottom - anchorRect.bottom - viewportPadding - 8,
  );
  const placeBelow =
    availableAbove < cardRect.height && availableBelow > availableAbove;
  if (placeBelow) {
    popover.classList.add("llm-web-source-popover-below");
  }
  const availableHeight = placeBelow ? availableBelow : availableAbove;
  popover.style.maxHeight = `${Math.floor(availableHeight)}px`;
  const renderedHeight = Math.min(cardRect.height, availableHeight);
  popover.style.top = `${Math.floor(
    placeBelow
      ? anchorRect.bottom + 8
      : Math.max(
          viewportTop + viewportPadding,
          anchorRect.top - renderedHeight - 8,
        ),
  )}px`;
}

/** Shared activation, pinning and portal lifetime for source footers. */
export function createSourcePopover(
  doc: Document,
  options: {
    label: string;
    icon: Node;
    activation?: "hover" | "click";
    populate: (popover: HTMLElement, close: () => void) => void;
    /** Extra classes on the chip button. */
    chipClassName?: string;
    /**
     * A click on the chip; return true when it was handled (the card then
     * closes instead of pinning open).
     */
    onChipClick?: (event: MouseEvent) => boolean;
  },
): HTMLElement {
  const wrapper = doc.createElement("span");
  wrapper.className = "llm-web-source-indicator";
  let pinned = false;
  let indicatorHovered = false;
  let popoverHovered = false;
  let closeTimer: number | undefined;
  let removeOpenListeners: (() => void) | null = null;

  const chip = doc.createElement("button");
  chip.type = "button";
  chip.className = options.chipClassName
    ? `llm-web-source-chip ${options.chipClassName}`
    : "llm-web-source-chip";
  chip.setAttribute("aria-label", options.label);
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");

  chip.appendChild(options.icon);

  const popover = doc.createElement("span");
  popover.className = "llm-web-source-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", options.label);

  const clearCloseTimer = () => {
    if (closeTimer === undefined) return;
    doc.defaultView?.clearTimeout(closeTimer);
    closeTimer = undefined;
  };

  const close = () => {
    clearCloseTimer();
    wrapper.classList.remove("expanded");
    popover.classList.remove("llm-web-source-popover-visible");
    chip.setAttribute("aria-expanded", "false");
    removeOpenListeners?.();
    removeOpenListeners = null;
    popover.remove();
  };

  const focusIsInside = () =>
    wrapper.contains(doc.activeElement) || popover.contains(doc.activeElement);

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer = doc.defaultView?.setTimeout(() => {
      closeTimer = undefined;
      if (pinned || indicatorHovered || popoverHovered || focusIsInside()) {
        return;
      }
      close();
    }, 120);
  };

  // The card's content is built when it first opens: an answer can carry
  // many marks, and most are never opened.
  let populated = false;
  const populate = () => {
    if (populated) return;
    populated = true;
    options.populate(popover, () => {
      pinned = false;
      close();
    });
  };

  const open = () => {
    clearCloseTimer();
    populate();
    if (!popover.isConnected) {
      (doc.body || doc.documentElement).appendChild(popover);
    }
    popover.classList.add("llm-web-source-popover-visible");
    chip.setAttribute("aria-expanded", "true");
    positionSourceCard(wrapper, popover);
    if (removeOpenListeners) return;

    const reposition = () => {
      if (!wrapper.isConnected) {
        pinned = false;
        close();
        return;
      }
      positionSourceCard(wrapper, popover);
    };
    const onOutsideMouseDown = (event: Event) => {
      if (
        event.target &&
        (wrapper.contains(event.target as Node) ||
          popover.contains(event.target as Node))
      ) {
        return;
      }
      pinned = false;
      close();
    };
    const scrollHost = wrapper.closest(".llm-messages");
    doc.addEventListener("mousedown", onOutsideMouseDown, true);
    scrollHost?.addEventListener("scroll", reposition, { passive: true });
    doc.defaultView?.addEventListener("resize", reposition);
    const MutationObserverCtor = doc.defaultView?.MutationObserver;
    const connectionObserver = MutationObserverCtor
      ? new MutationObserverCtor(() => {
          if (!wrapper.isConnected) {
            pinned = false;
            close();
          }
        })
      : null;
    connectionObserver?.observe(doc.documentElement, {
      childList: true,
      subtree: true,
    });
    removeOpenListeners = () => {
      doc.removeEventListener("mousedown", onOutsideMouseDown, true);
      scrollHost?.removeEventListener("scroll", reposition);
      doc.defaultView?.removeEventListener("resize", reposition);
      connectionObserver?.disconnect();
    };
  };

  const handleFocusOut = () => {
    doc.defaultView?.setTimeout(() => {
      if (focusIsInside()) return;
      pinned = false;
      scheduleClose();
    }, 0);
  };
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    pinned = false;
    chip.focus();
    close();
  };
  wrapper.addEventListener("mouseenter", () => {
    indicatorHovered = true;
    if (options.activation !== "click") open();
  });
  wrapper.addEventListener("mouseleave", () => {
    indicatorHovered = false;
    scheduleClose();
  });
  popover.addEventListener("mouseenter", () => {
    popoverHovered = true;
    clearCloseTimer();
  });
  popover.addEventListener("mouseleave", () => {
    popoverHovered = false;
    scheduleClose();
  });
  if (options.activation !== "click") {
    wrapper.addEventListener("focusin", open);
    popover.addEventListener("focusin", open);
  }
  wrapper.addEventListener("focusout", handleFocusOut);
  popover.addEventListener("focusout", handleFocusOut);
  wrapper.addEventListener("keydown", handleEscape);
  popover.addEventListener("keydown", handleEscape);
  chip.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (options.activation === "click") {
      pinned = true;
      wrapper.classList.add("expanded");
    }
    open();
    popover.querySelector<HTMLElement>("button, [tabindex='0']")?.focus();
  });
  chip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (options.onChipClick?.(event)) {
      pinned = false;
      close();
      return;
    }
    pinned = !pinned;
    wrapper.classList.toggle("expanded", pinned);
    if (!pinned) {
      close();
      return;
    }
    open();
  });

  wrapper.appendChild(chip);
  return wrapper;
}
