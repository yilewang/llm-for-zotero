export function clearCommandRowState(params: {
  body: Element;
  inputBox: HTMLTextAreaElement;
}): void {
  const row = params.body.querySelector("#llm-command-row");
  if (row) {
    row.removeAttribute("data-active");
    row.classList.remove("llm-command-row--skill");
  }
  if (params.inputBox.dataset.originalPlaceholder !== undefined) {
    params.inputBox.placeholder = params.inputBox.dataset.originalPlaceholder;
    delete params.inputBox.dataset.originalPlaceholder;
  }
}

export function activateCommandRowState(params: {
  body: Element;
  inputBox: HTMLTextAreaElement;
  label: string;
  kind: "skill" | "command";
  clearInput?: boolean;
  dispatchInput?: () => void;
}): HTMLElement | null {
  const row = params.body.querySelector("#llm-command-row");
  const badgeEl = params.body.querySelector("#llm-command-row-badge");
  if (!row || !badgeEl) return null;
  badgeEl.textContent = params.label;
  if (params.kind === "skill") {
    row.classList.add("llm-command-row--skill");
  } else {
    row.classList.remove("llm-command-row--skill");
  }
  row.setAttribute("data-active", "");
  if (params.inputBox.dataset.originalPlaceholder === undefined) {
    params.inputBox.dataset.originalPlaceholder = params.inputBox.placeholder;
  }
  params.inputBox.placeholder = "";
  if (params.clearInput) {
    params.inputBox.value = "";
  }
  params.inputBox.focus({ preventScroll: true });
  params.dispatchInput?.();
  return row as HTMLElement;
}
