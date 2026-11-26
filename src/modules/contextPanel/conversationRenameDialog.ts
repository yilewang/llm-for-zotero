import { createElement } from "../../utils/domHelpers";
import { openModalDialog } from "./modalDialog";
import { GLOBAL_HISTORY_TITLE_MAX_LENGTH } from "./setupHandlers/controllers/conversationHistoryController";

export type ConversationRenameDialogOptions = {
  title: string;
  initialTitle: string;
  confirmLabel: string;
  cancelLabel: string;
  maxLength?: number;
};

export function showConversationRenameDialog(
  doc: Document,
  options: ConversationRenameDialogOptions,
): Promise<string | null> {
  return openModalDialog<string | null>(doc, {
    name: "llm-conversation-rename",
    role: "dialog",
    title: options.title,
    titleClass: "llm-conversation-rename-title",
    dismissed: null,
    build: ({ dialog, settle }) => {
      const form = createElement(
        doc,
        "form",
        "llm-conversation-rename-form",
      ) as HTMLFormElement;
      const input = createElement(
        doc,
        "input",
        "llm-conversation-rename-input",
        {
          type: "text",
        },
      ) as HTMLInputElement;
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
      dialog.append(form);

      input.addEventListener("input", syncConfirmState);
      cancelButton.addEventListener("click", () => settle(null));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        settle(value);
      });
      return input;
    },
  });
}
