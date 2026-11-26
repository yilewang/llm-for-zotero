import { createElement } from "../../utils/domHelpers";
import { registerAddonInPanelDialog } from "../../utils/dialogRegistry";

let modalDialogCounter = 0;

/** Focuses an element without scrolling to it, where the element allows that. */
function focusElement(element: Element | null | undefined): void {
  const focus = (element as { focus?: (options?: FocusOptions) => void } | null)
    ?.focus;
  if (typeof focus !== "function") return;
  try {
    focus.call(element, { preventScroll: true });
  } catch {
    focus.call(element);
  }
}

export type ModalDialogFrame<T> = {
  /** The dialog element, already holding its title. */
  dialog: HTMLElement;
  /** A number unique to this dialog, for the ids of its own elements. */
  instanceId: number;
  /** Closes the dialog with this result. Later calls do nothing. */
  settle: (value: T) => void;
};

export type ModalDialogOptions<T> = {
  /** Class and id prefix, such as `llm-conversation-rename`. */
  name: string;
  role: "dialog" | "alertdialog";
  title: string;
  /** A class for the title element besides `llm-modal-title`. */
  titleClass?: string;
  /** The result when the dialog is dismissed without an answer. */
  dismissed: T;
  /**
   * Adds the dialog's body and wires its controls to `settle`. Returns the
   * element to focus first.
   */
  build: (frame: ModalDialogFrame<T>) => Element | null;
};

/**
 * Opens a modal dialog over the document and resolves with its result.
 *
 * Every dialog has the same frame: a dimmed overlay, a titled dialog, and
 * three ways to dismiss it (Escape, a click on the overlay, the panel
 * closing), each resolving with `dismissed`. Focus returns to where it was.
 */
export function openModalDialog<T>(
  doc: Document,
  options: ModalDialogOptions<T>,
): Promise<T> {
  const parent = doc.body ?? doc.documentElement;
  if (!parent) return Promise.resolve(options.dismissed);

  return new Promise((resolve) => {
    modalDialogCounter += 1;
    const instanceId = modalDialogCounter;
    const previousActiveElement = doc.activeElement;
    const titleId = `${options.name}-title-${instanceId}`;

    const overlay = createElement(
      doc,
      "div",
      `llm-modal-overlay ${options.name}-overlay`,
    );
    overlay.setAttribute("role", "presentation");

    const dialog = createElement(
      doc,
      "div",
      `llm-modal-dialog ${options.name}-dialog`,
    );
    dialog.setAttribute("role", options.role);
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);

    const title = createElement(
      doc,
      "div",
      ["llm-modal-title", options.titleClass].filter(Boolean).join(" "),
      {
        id: titleId,
        textContent: options.title,
      },
    );
    dialog.append(title);

    let settled = false;
    let unregisterDialog = () => {};
    const settle = (value: T) => {
      if (settled) return;
      settled = true;
      unregisterDialog();
      doc.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      focusElement(previousActiveElement);
      resolve(value);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      settle(options.dismissed);
    };

    const initialFocus = options.build({ dialog, instanceId, settle });
    overlay.appendChild(dialog);

    overlay.addEventListener("click", (event: MouseEvent) => {
      if (event.target === overlay) settle(options.dismissed);
    });
    doc.addEventListener("keydown", onKeydown, true);
    unregisterDialog = registerAddonInPanelDialog(doc, () =>
      settle(options.dismissed),
    );

    parent.appendChild(overlay);
    focusElement(initialFocus);
    try {
      (initialFocus as { select?: () => void } | null)?.select?.();
    } catch {
      // Selection is cosmetic; focus and editing still work without it.
    }
  });
}
