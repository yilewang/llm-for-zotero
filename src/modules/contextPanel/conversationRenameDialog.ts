import { createElement } from "../../utils/domHelpers";
import { GLOBAL_HISTORY_TITLE_MAX_LENGTH } from "./setupHandlers/controllers/conversationHistoryController";

export type ConversationRenameDialogOptions = {
  title: string;
  initialTitle: string;
  confirmLabel: string;
  cancelLabel: string;
  maxLength?: number;
};

let conversationRenameDialogCounter = 0;

function nextDialogElementId(prefix: string): string {
  conversationRenameDialogCounter += 1;
  return `${prefix}-${conversationRenameDialogCounter}`;
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

export function showConversationRenameDialog(
  doc: Document,
  options: ConversationRenameDialogOptions,
): Promise<string | null> {
  const parent = doc.body ?? doc.documentElement;
  if (!parent) return Promise.resolve(null);

  return new Promise((resolve) => {
    const previousActiveElement = doc.activeElement;
    const titleId = nextDialogElementId("llm-conversation-rename-title");

    const overlay = createElement(
      doc,
      "div",
      "llm-modal-overlay llm-conversation-rename-overlay",
    );
    overlay.setAttribute("role", "presentation");

    const dialog = createElement(
      doc,
      "div",
      "llm-modal-dialog llm-conversation-rename-dialog",
    );
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);

    const title = createElement(
      doc,
      "div",
      "llm-modal-title llm-conversation-rename-title",
      {
        id: titleId,
        textContent: options.title,
      },
    );
    const form = createElement(
      doc,
      "form",
      "llm-conversation-rename-form",
    ) as HTMLFormElement;
    const input = createElement(doc, "input", "llm-conversation-rename-input", {
      type: "text",
    }) as HTMLInputElement;
    input.value = options.initialTitle;
    input.maxLength = Math.max(
      1,
      Math.floor(options.maxLength || GLOBAL_HISTORY_TITLE_MAX_LENGTH),
    );
    input.setAttribute("aria-label", options.title);
    input.setAttribute("autocomplete", "off");

    const actions = createElement(doc, "div", "llm-modal-actions");
    const cancelButton = createElement(
      doc,
      "button",
      "llm-modal-btn llm-modal-cancel",
      {
        type: "button",
        textContent: options.cancelLabel,
      },
    );
    const confirmButton = createElement(
      doc,
      "button",
      "llm-modal-btn llm-modal-primary",
      {
        type: "submit",
        textContent: options.confirmLabel,
      },
    ) as HTMLButtonElement;

    const syncConfirmState = () => {
      confirmButton.disabled = !input.value.trim();
    };
    syncConfirmState();

    actions.append(cancelButton, confirmButton);
    form.append(input, actions);
    dialog.append(title, form);
    overlay.appendChild(dialog);

    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      doc.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      focusElement(previousActiveElement);
      resolve(value);
    };

    const onOverlayClick = (event: MouseEvent) => {
      if (event.target === overlay) settle(null);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      settle(null);
    };

    overlay.addEventListener("click", onOverlayClick);
    input.addEventListener("input", syncConfirmState);
    cancelButton.addEventListener("click", () => settle(null));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      settle(value);
    });
    doc.addEventListener("keydown", onKeydown, true);

    parent.appendChild(overlay);
    focusElement(input);
    try {
      input.select();
    } catch {
      // Selection is cosmetic; focus and editing still work without it.
    }
  });
}
