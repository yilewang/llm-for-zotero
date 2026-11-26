import { createElement } from "../../utils/domHelpers";
import { openModalDialog } from "./modalDialog";

export type ShortcutEditDialogOptions = {
  title: string;
  initialLabel: string;
  initialPrompt: string;
  labelText: string;
  promptText: string;
  confirmLabel: string;
  cancelLabel: string;
};

export function showShortcutEditDialog(
  doc: Document,
  options: ShortcutEditDialogOptions,
): Promise<{ label: string; prompt: string } | null> {
  return openModalDialog<{ label: string; prompt: string } | null>(doc, {
    name: "llm-shortcut-edit",
    role: "dialog",
    title: options.title,
    dismissed: null,
    build: ({ dialog, instanceId, settle }) => {
      const labelInputId = `llm-shortcut-label-input-${instanceId}`;
      const promptInputId = `llm-shortcut-prompt-input-${instanceId}`;

      const form = createElement(
        doc,
        "form",
        "llm-shortcut-edit-form",
      ) as HTMLFormElement;

      const labelField = createElement(doc, "div", "llm-shortcut-edit-field");
      const label = createElement(doc, "label", "llm-shortcut-edit-label", {
        htmlFor: labelInputId,
        textContent: options.labelText,
      });
      const labelInput = createElement(
        doc,
        "input",
        "llm-shortcut-edit-control",
        {
          id: labelInputId,
          type: "text",
          value: options.initialLabel,
        },
      );
      labelInput.setAttribute("autocomplete", "off");
      labelField.append(label, labelInput);

      const promptField = createElement(doc, "div", "llm-shortcut-edit-field");
      const promptLabel = createElement(
        doc,
        "label",
        "llm-shortcut-edit-label",
        {
          htmlFor: promptInputId,
          textContent: options.promptText,
        },
      );
      const promptInput = createElement(
        doc,
        "textarea",
        "llm-shortcut-edit-control llm-shortcut-edit-prompt",
        {
          id: promptInputId,
          rows: 6,
          value: options.initialPrompt,
        },
      );
      promptField.append(promptLabel, promptInput);

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
      );

      const syncConfirmState = () => {
        confirmButton.disabled = !promptInput.value.trim();
      };
      syncConfirmState();

      actions.append(cancelButton, confirmButton);
      form.append(labelField, promptField, actions);
      dialog.append(form);

      promptInput.addEventListener("input", syncConfirmState);
      cancelButton.addEventListener("click", () => settle(null));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const prompt = promptInput.value.trim();
        if (!prompt) return;
        settle({ label: labelInput.value, prompt: promptInput.value });
      });
      return labelInput;
    },
  });
}
