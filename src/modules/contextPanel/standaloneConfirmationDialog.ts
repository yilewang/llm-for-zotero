import { createElement } from "../../utils/domHelpers";
import { openModalDialog } from "./modalDialog";

export type StandaloneConfirmationDialogOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
};

export function showStandaloneConfirmationDialog(
  doc: Document,
  options: StandaloneConfirmationDialogOptions,
): Promise<boolean> {
  return openModalDialog<boolean>(doc, {
    name: "llm-standalone-confirm",
    role: "alertdialog",
    title: options.title,
    titleClass: "llm-standalone-confirm-title",
    dismissed: false,
    build: ({ dialog, instanceId, settle }) => {
      const messageId = `llm-standalone-confirm-message-${instanceId}`;
      dialog.setAttribute("aria-describedby", messageId);

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
      dialog.append(message, actions);

      cancelButton.addEventListener("click", () => settle(false));
      confirmButton.addEventListener("click", () => settle(true));
      return cancelButton;
    },
  });
}
