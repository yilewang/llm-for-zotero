import { createElement } from "../../utils/domHelpers";

export type StandaloneConfirmationDialogOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
};

let standaloneConfirmationDialogCounter = 0;

function nextDialogElementId(prefix: string): string {
  standaloneConfirmationDialogCounter += 1;
  return `${prefix}-${standaloneConfirmationDialogCounter}`;
}

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

export function showStandaloneConfirmationDialog(
  doc: Document,
  options: StandaloneConfirmationDialogOptions,
): Promise<boolean> {
  const parent = doc.body ?? doc.documentElement;
  if (!parent) return Promise.resolve(false);

  return new Promise((resolve) => {
    const previousActiveElement = doc.activeElement;
    const titleId = nextDialogElementId("llm-standalone-confirm-title");
    const messageId = nextDialogElementId("llm-standalone-confirm-message");

    const overlay = createElement(
      doc,
      "div",
      "llm-modal-overlay llm-standalone-confirm-overlay",
    );
    overlay.setAttribute("role", "presentation");

    const dialog = createElement(
      doc,
      "div",
      "llm-modal-dialog llm-standalone-confirm-dialog",
    );
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.setAttribute("aria-describedby", messageId);

    const title = createElement(
      doc,
      "div",
      "llm-modal-title llm-standalone-confirm-title",
      {
        id: titleId,
        textContent: options.title,
      },
    );
    const message = createElement(
      doc,
      "div",
      "llm-standalone-confirm-message",
      {
        id: messageId,
        textContent: options.message,
      },
    );
    const actions = createElement(
      doc,
      "div",
      "llm-modal-actions llm-standalone-confirm-actions",
    );
    const cancelButton = createElement(
      doc,
      "button",
      "llm-modal-btn llm-modal-cancel llm-standalone-confirm-btn llm-standalone-confirm-cancel",
      {
        type: "button",
        textContent: options.cancelLabel,
      },
    );
    const confirmButton = createElement(
      doc,
      "button",
      [
        "llm-modal-btn",
        "llm-modal-primary",
        "llm-standalone-confirm-btn",
        "llm-standalone-confirm-primary",
        options.destructive ? "llm-standalone-confirm-destructive" : "",
      ]
        .filter(Boolean)
        .join(" "),
      {
        type: "button",
        textContent: options.confirmLabel,
      },
    );

    actions.append(cancelButton, confirmButton);
    dialog.append(title, message, actions);
    overlay.appendChild(dialog);

    let settled = false;
    const settle = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      doc.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      focusElement(previousActiveElement);
      resolve(confirmed);
    };

    const onOverlayClick = (event: MouseEvent) => {
      if (event.target === overlay) settle(false);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      settle(false);
    };

    overlay.addEventListener("click", onOverlayClick);
    cancelButton.addEventListener("click", () => settle(false));
    confirmButton.addEventListener("click", () => settle(true));
    doc.addEventListener("keydown", onKeydown, true);

    parent.appendChild(overlay);
    focusElement(cancelButton);
  });
}
