import { getAgentRuntime } from "../../../agent";
import type {
  AgentPendingAction,
  AgentPendingField,
  AgentRunEventRecord,
  AgentTraceChip,
  AgentTraceRequestSummary,
  AgentToolPresentationSummary,
} from "../../../agent/types";
import type { Message, PaperContextRef } from "../types";
import { sanitizeText, getSelectedTextSourceIcon } from "../textUtils";
import { toFileUrl } from "../../../utils/pathFileUrl";
import {
  normalizePaperContextRefs,
  normalizeSelectedTextSources,
} from "../normalizers";

type AgentTraceSummaryKind = "plan" | "tool" | "ok" | "skip" | "done";

type AgentTraceSummaryRow = {
  kind: AgentTraceSummaryKind;
  icon: string;
  text: string;
};

type AgentTraceDisplayItem =
  | {
      type: "message";
      tone: "neutral" | "success" | "warning";
      text: string;
    }
  | {
      type: "action";
      row: AgentTraceSummaryRow;
      chips?: AgentTraceChip[];
    };

type RenderAgentTraceParams = {
  doc: Document;
  message: Message;
  userMessage?: Message | null;
  events: AgentRunEventRecord[];
  onTraceMissing?: () => void;
};

type AgentRunEventPayload = AgentRunEventRecord["payload"];

function normalizeSelectedTexts(
  selectedTexts: unknown,
  legacySelectedText?: unknown,
): string[] {
  const normalize = (value: unknown): string => {
    if (typeof value !== "string") return "";
    return sanitizeText(value).trim();
  };
  if (Array.isArray(selectedTexts)) {
    return selectedTexts.map((value) => normalize(value)).filter(Boolean);
  }
  const legacy = normalize(legacySelectedText);
  return legacy ? [legacy] : [];
}

function getMessageSelectedTexts(message: Message): string[] {
  return normalizeSelectedTexts(message.selectedTexts, message.selectedText);
}

function normalizePaperContexts(paperContexts: unknown): PaperContextRef[] {
  return normalizePaperContextRefs(paperContexts, { sanitizeText });
}

function getPendingWriteConfirmation(
  events: AgentRunEventRecord[],
): { requestId: string; action: AgentPendingAction } | null {
  const pending = new Map<string, AgentPendingAction>();
  for (const entry of events) {
    if (entry.payload.type === "confirmation_required") {
      pending.set(entry.payload.requestId, entry.payload.action);
      continue;
    }
    if (entry.payload.type === "confirmation_resolved") {
      pending.delete(entry.payload.requestId);
    }
  }
  const last = Array.from(pending.entries()).pop();
  if (!last) return null;
  return {
    requestId: last[0],
    action: last[1],
  };
}

function isAgentTraceRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readAgentTraceText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncateAgentTraceText(value: unknown, max = 88): string {
  const raw = readAgentTraceText(value) || `${value ?? ""}`;
  const normalized = sanitizeText(raw).replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function renderReviewTableField(
  doc: Document,
  field: Extract<AgentPendingField, { type: "review_table" }>,
): HTMLDivElement {
  const list = doc.createElement("div");
  list.className = "llm-agent-hitl-review-list";

  for (const item of field.rows) {
    const row = doc.createElement("div");
    row.className = "llm-agent-hitl-review-item";

    const label = doc.createElement("div");
    label.className = "llm-agent-hitl-review-label";
    label.textContent = item.label;
    row.appendChild(label);

    const values = doc.createElement("div");
    values.className = "llm-agent-hitl-review-values";

    const beforeCol = doc.createElement("div");
    beforeCol.className = "llm-agent-hitl-review-column";
    const beforeLabel = doc.createElement("div");
    beforeLabel.className = "llm-agent-hitl-review-column-label";
    beforeLabel.textContent = "Before";
    const beforeValue = doc.createElement("div");
    beforeValue.className = item.multiline
      ? "llm-agent-hitl-review-value llm-agent-hitl-review-value-multiline"
      : "llm-agent-hitl-review-value";
    beforeValue.textContent = item.before?.trim() || "Empty";
    beforeCol.append(beforeLabel, beforeValue);

    const afterCol = doc.createElement("div");
    afterCol.className = "llm-agent-hitl-review-column";
    const afterLabel = doc.createElement("div");
    afterLabel.className = "llm-agent-hitl-review-column-label";
    afterLabel.textContent = "After";
    const afterValue = doc.createElement("div");
    afterValue.className = item.multiline
      ? "llm-agent-hitl-review-value llm-agent-hitl-review-value-multiline llm-agent-hitl-review-value-after"
      : "llm-agent-hitl-review-value llm-agent-hitl-review-value-after";
    afterValue.textContent = item.after.trim() || "Empty";
    afterCol.append(afterLabel, afterValue);

    values.append(beforeCol, afterCol);
    row.append(values);
    list.appendChild(row);
  }

  return list;
}

function renderImageGalleryField(
  doc: Document,
  field: Extract<AgentPendingField, { type: "image_gallery" }>,
): HTMLDivElement {
  const previewGrid = doc.createElement("div");
  previewGrid.className = "llm-agent-hitl-preview-grid";
  for (const image of field.items) {
    const previewCard = doc.createElement("div");
    previewCard.className = "llm-agent-hitl-preview-card";
    const previewImg = doc.createElement("img");
    previewImg.className = "llm-agent-hitl-preview-image";
    previewImg.loading = "lazy";
    previewImg.alt = image.title || image.label;
    const previewUrl = toFileUrl(image.storedPath);
    if (previewUrl) {
      previewImg.src = previewUrl;
    }
    const previewLabel = doc.createElement("div");
    previewLabel.className = "llm-agent-hitl-preview-label";
    previewLabel.textContent = image.label;
    previewCard.append(previewImg, previewLabel);
    previewGrid.appendChild(previewCard);
  }
  return previewGrid;
}

function renderChecklistField(
  doc: Document,
  field: Extract<AgentPendingField, { type: "checklist" }>,
): {
  element: HTMLDivElement;
  accessor: {
    id: string;
    getValue: () => string[];
    setDisabled: (disabled: boolean) => void;
    isValid: () => boolean;
    bindValidity: (callback: () => void) => void;
  };
} {
  const wrap = doc.createElement("div");
  wrap.className = "llm-agent-hitl-checklist";

  const toolbar = doc.createElement("div");
  toolbar.className = "llm-agent-hitl-checklist-toolbar";

  const selectAllButton = doc.createElement("button");
  selectAllButton.type = "button";
  selectAllButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-alt";
  selectAllButton.textContent = "Select all";
  toolbar.appendChild(selectAllButton);

  const clearAllButton = doc.createElement("button");
  clearAllButton.type = "button";
  clearAllButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
  clearAllButton.textContent = "Clear all";
  toolbar.appendChild(clearAllButton);

  wrap.appendChild(toolbar);

  const list = doc.createElement("div");
  list.className = "llm-agent-hitl-checklist-list";
  wrap.appendChild(list);

  const checkboxes: HTMLInputElement[] = [];
  const listeners: Array<() => void> = [];
  const emitValidityChange = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const getSelectedIds = () =>
    checkboxes
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value);

  for (const item of field.items) {
    const row = doc.createElement("label");
    row.className = "llm-agent-hitl-checklist-item";

    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "llm-agent-hitl-checklist-checkbox";
    checkbox.value = item.id;
    checkbox.checked = item.checked !== false;
    checkbox.addEventListener("change", emitValidityChange);
    checkboxes.push(checkbox);

    const content = doc.createElement("span");
    content.className = "llm-agent-hitl-checklist-content";

    const title = doc.createElement("span");
    title.className = "llm-agent-hitl-checklist-title";
    title.textContent = item.label;
    content.appendChild(title);

    if (item.description) {
      const description = doc.createElement("span");
      description.className = "llm-agent-hitl-checklist-description";
      description.textContent = item.description;
      content.appendChild(description);
    }

    row.append(checkbox, content);
    list.appendChild(row);
  }

  selectAllButton.addEventListener("click", () => {
    for (const checkbox of checkboxes) {
      checkbox.checked = true;
    }
    emitValidityChange();
  });
  clearAllButton.addEventListener("click", () => {
    for (const checkbox of checkboxes) {
      checkbox.checked = false;
    }
    emitValidityChange();
  });

  return {
    element: wrap,
    accessor: {
      id: field.id,
      getValue: () => getSelectedIds(),
      setDisabled: (disabled) => {
        for (const checkbox of checkboxes) {
          checkbox.disabled = disabled;
        }
        selectAllButton.disabled = disabled;
        clearAllButton.disabled = disabled;
      },
      isValid: () => getSelectedIds().length > 0,
      bindValidity: (callback) => {
        listeners.push(callback);
      },
    },
  };
}

function renderAssignmentTableField(
  doc: Document,
  field: Extract<AgentPendingField, { type: "assignment_table" }>,
): {
  element: HTMLDivElement;
  accessor: {
    id: string;
    getValue: () => Array<{ id: string; checked: boolean; value: string }>;
    setDisabled: (disabled: boolean) => void;
    isValid: () => boolean;
    bindValidity: (callback: () => void) => void;
  };
} {
  const wrap = doc.createElement("div");
  wrap.className = "llm-agent-hitl-assignment-table";

  const rows: Array<{
    select: HTMLSelectElement;
    id: string;
  }> = [];
  const listeners: Array<() => void> = [];
  const emitValidityChange = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const getAssignments = () =>
    rows.map((row) => ({
      id: row.id,
      checked: row.select.value !== "__skip__",
      value: row.select.value,
    }));

  for (const item of field.rows) {
    const row = doc.createElement("div");
    row.className = "llm-agent-hitl-assignment-row";

    const content = doc.createElement("div");
    content.className = "llm-agent-hitl-assignment-content";

    const title = doc.createElement("div");
    title.className = "llm-agent-hitl-assignment-title";
    title.textContent = item.label;
    content.appendChild(title);

    if (item.description) {
      const description = doc.createElement("div");
      description.className = "llm-agent-hitl-assignment-description";
      description.textContent = item.description;
      content.appendChild(description);
    }

    const control = doc.createElement("div");
    control.className = "llm-agent-hitl-assignment-control";

    const selectLabel = doc.createElement("div");
    selectLabel.className = "llm-agent-hitl-assignment-select-label";
    selectLabel.textContent = "Move to";
    control.appendChild(selectLabel);

    const select = doc.createElement("select");
    select.className = "llm-agent-hitl-page-input llm-agent-hitl-assignment-select";
    for (const option of field.options) {
      const optionEl = doc.createElement("option");
      optionEl.value = option.id;
      optionEl.textContent = option.label;
      select.appendChild(optionEl);
    }
    const initialValue =
      item.checked === false ? "__skip__" : item.value || "__skip__";
    let hasInitialValue = false;
    for (let index = 0; index < select.options.length; index += 1) {
      const option = select.options.item(index) as HTMLOptionElement | null;
      if (option?.value === initialValue) {
        hasInitialValue = true;
        break;
      }
    }
    select.value = hasInitialValue ? initialValue : "__skip__";
    select.addEventListener("change", emitValidityChange);
    control.appendChild(select);

    rows.push({
      select,
      id: item.id,
    });

    row.append(content, control);
    wrap.appendChild(row);
  }

  return {
    element: wrap,
    accessor: {
      id: field.id,
      getValue: () => getAssignments(),
      setDisabled: (disabled) => {
        for (const row of rows) {
          row.select.disabled = disabled;
        }
      },
      isValid: () =>
        getAssignments().some(
          (entry) => entry.checked && entry.value && entry.value !== "__skip__",
        ),
      bindValidity: (callback) => {
        listeners.push(callback);
      },
    },
  };
}

function renderTagAssignmentTableField(
  doc: Document,
  field: Extract<AgentPendingField, { type: "tag_assignment_table" }>,
): {
  element: HTMLDivElement;
  accessor: {
    id: string;
    getValue: () => Array<{ id: string; value: string[] }>;
    setDisabled: (disabled: boolean) => void;
    isValid: () => boolean;
    bindValidity: (callback: () => void) => void;
  };
} {
  const wrap = doc.createElement("div");
  wrap.className = "llm-agent-hitl-assignment-table";

  const rows: Array<{
    buttons: HTMLButtonElement[];
    getTags: () => string[];
    setDisabled: (disabled: boolean) => void;
    id: string;
  }> = [];
  const listeners: Array<() => void> = [];
  const emitValidityChange = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const getAssignments = () =>
    rows.map((row) => ({
      id: row.id,
      value: row.getTags(),
    }));
  const parseInitialTags = (value: string | string[] | undefined): string[] => {
    if (Array.isArray(value)) {
      return value.map((entry) => entry.trim()).filter(Boolean);
    }
    if (typeof value !== "string") return [];
    return value
      .split(/\r?\n|,/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
  };

  for (const item of field.rows) {
    const row = doc.createElement("div");
    row.className = "llm-agent-hitl-assignment-row";

    const content = doc.createElement("div");
    content.className = "llm-agent-hitl-assignment-content";

    const title = doc.createElement("div");
    title.className = "llm-agent-hitl-assignment-title";
    title.textContent = item.label;
    content.appendChild(title);

    if (item.description) {
      const description = doc.createElement("div");
      description.className = "llm-agent-hitl-assignment-description";
      description.textContent = item.description;
      content.appendChild(description);
    }

    const control = doc.createElement("div");
    control.className = "llm-agent-hitl-assignment-control";

    const inputLabel = doc.createElement("div");
    inputLabel.className = "llm-agent-hitl-assignment-select-label";
    inputLabel.textContent = "Suggested tags";
    control.appendChild(inputLabel);

    const editor = doc.createElement("div");
    editor.className = "llm-agent-hitl-tag-editor";

    const chipList = doc.createElement("div");
    chipList.className = "llm-agent-hitl-tag-chip-list";
    editor.appendChild(chipList);

    const addButton = doc.createElement("button");
    addButton.type = "button";
    addButton.className = "llm-agent-hitl-tag-add";
    addButton.textContent = "Add tag";
    editor.appendChild(addButton);

    const chipInputs: HTMLInputElement[] = [];
    const chipButtons: HTMLButtonElement[] = [addButton];

    const updateChipInputSize = (input: HTMLInputElement) => {
      input.size = Math.max(8, input.value.trim().length + 1);
    };

    const normalizeChipInput = (input: HTMLInputElement) => {
      const segments = input.value
        .split(/,/g)
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!segments.length) {
        input.value = "";
        updateChipInputSize(input);
        return;
      }
      input.value = segments[0];
      updateChipInputSize(input);
      for (const segment of segments.slice(1)) {
        addChip(segment);
      }
    };

    const removeChip = (chip: HTMLDivElement, input: HTMLInputElement) => {
      const index = chipInputs.indexOf(input);
      if (index >= 0) {
        chipInputs.splice(index, 1);
      }
      chip.remove();
      emitValidityChange();
    };

    const addChip = (initialValue = "") => {
      const chip = doc.createElement("div");
      chip.className =
        "llm-selected-context llm-paper-context-chip llm-selected-context-pinned llm-agent-hitl-tag-chip";

      const chipHeader = doc.createElement("div");
      chipHeader.className =
        "llm-selected-context-header llm-paper-context-chip-header llm-agent-hitl-tag-chip-header";

      const input = doc.createElement("input");
      input.type = "text";
      input.className =
        "llm-paper-context-chip-label llm-agent-hitl-tag-chip-input";
      input.value = initialValue;
      input.placeholder = item.placeholder || "tag";
      updateChipInputSize(input);
      input.addEventListener("input", () => {
        updateChipInputSize(input);
        emitValidityChange();
      });
      input.addEventListener("blur", () => {
        normalizeChipInput(input);
        emitValidityChange();
      });
      input.addEventListener("keydown", (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key === "," || keyboardEvent.key === "Enter") {
          event.preventDefault();
          normalizeChipInput(input);
          const nextChip = addChip();
          nextChip.focus();
          emitValidityChange();
          return;
        }
        if (
          keyboardEvent.key === "Backspace" &&
          !input.value &&
          chipInputs.length > 1
        ) {
          event.preventDefault();
          const index = chipInputs.indexOf(input);
          removeChip(chip, input);
          const fallback = chipInputs[Math.max(0, index - 1)];
          fallback?.focus();
        }
      });

      const removeButton = doc.createElement("button");
      removeButton.type = "button";
      removeButton.className =
        "llm-remove-img-btn llm-paper-context-clear llm-agent-hitl-tag-chip-remove";
      removeButton.textContent = "×";
      removeButton.addEventListener("click", () => {
        removeChip(chip, input);
      });
      chipButtons.push(removeButton);

      chipHeader.append(input, removeButton);
      chip.append(chipHeader);
      chipList.appendChild(chip);
      chipInputs.push(input);
      return input;
    };

    const initialTags = parseInitialTags(item.value);
    for (const tag of initialTags) {
      addChip(tag);
    }
    addButton.addEventListener("click", () => {
      const input = addChip();
      input.focus();
      emitValidityChange();
    });

    control.appendChild(editor);

    rows.push({
      buttons: chipButtons,
      getTags: () =>
        chipInputs
          .map((input) => input.value.trim())
          .filter(Boolean),
      setDisabled: (disabled) => {
        addButton.disabled = disabled;
        for (const input of chipInputs) {
          input.disabled = disabled;
        }
        for (const button of chipButtons) {
          button.disabled = disabled;
        }
      },
      id: item.id,
    });

    row.append(content, control);
    wrap.appendChild(row);
  }

  return {
    element: wrap,
    accessor: {
      id: field.id,
      getValue: () => getAssignments(),
      setDisabled: (disabled) => {
        for (const row of rows) {
          row.setDisabled(disabled);
        }
      },
      isValid: () =>
        getAssignments().some((entry) => entry.value.length > 0),
      bindValidity: (callback) => {
        listeners.push(callback);
      },
    },
  };
}

function renderPendingWriteActionCard(
  doc: Document,
  pending: { requestId: string; action: AgentPendingAction },
): HTMLDivElement {
  const card = doc.createElement("div");
  card.className = "llm-agent-hitl-card";

  const header = doc.createElement("div");
  header.className = "llm-agent-hitl-header";
  header.textContent = "Action required";
  card.appendChild(header);

  const title = doc.createElement("div");
  title.className = "llm-agent-hitl-title";
  title.textContent = pending.action.title;
  card.appendChild(title);

  if (pending.action.description) {
    const description = doc.createElement("div");
    description.className = "llm-agent-hitl-description";
    description.textContent = pending.action.description;
    card.appendChild(description);
  }

  const fieldAccessors: Array<{
    id: string;
    getValue: () => unknown;
    setDisabled: (disabled: boolean) => void;
    isValid: () => boolean;
    bindValidity?: (callback: () => void) => void;
  }> = [];

  for (const field of pending.action.fields) {
    if (field.type === "textarea") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      card.appendChild(label);

      const textarea = doc.createElement("textarea");
      textarea.className =
        field.editorMode === "json"
          ? "llm-agent-hitl-input llm-agent-hitl-input-code"
          : "llm-agent-hitl-input";
      textarea.value = field.value || "";
      textarea.placeholder = field.placeholder || "";
      textarea.spellcheck = field.spellcheck ?? field.editorMode !== "json";
      const resizeTextarea = () => {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`;
      };
      resizeTextarea();
      textarea.addEventListener("input", resizeTextarea);
      card.appendChild(textarea);
      fieldAccessors.push({
        id: field.id,
        getValue: () => textarea.value,
        setDisabled: (disabled) => {
          textarea.disabled = disabled;
        },
        isValid: () => textarea.value.trim().length > 0,
        bindValidity: (callback) => {
          textarea.addEventListener("input", callback);
        },
      });
      continue;
    }

    if (field.type === "text") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      card.appendChild(label);

      const input = doc.createElement("input");
      input.type = "text";
      input.className = "llm-agent-hitl-page-input";
      input.value = field.value || "";
      input.placeholder = field.placeholder || "";
      card.appendChild(input);
      fieldAccessors.push({
        id: field.id,
        getValue: () => input.value,
        setDisabled: (disabled) => {
          input.disabled = disabled;
        },
        isValid: () => input.value.trim().length > 0,
        bindValidity: (callback) => {
          input.addEventListener("input", callback);
        },
      });
      continue;
    }

    if (field.type === "select") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      card.appendChild(label);

      const select = doc.createElement("select");
      select.className = "llm-agent-hitl-page-input";
      for (const option of field.options) {
        const optionEl = doc.createElement("option");
        optionEl.value = option.id;
        optionEl.textContent = option.label;
        select.appendChild(optionEl);
      }
      select.value = field.value || field.options[0]?.id || "";
      card.appendChild(select);
      fieldAccessors.push({
        id: field.id,
        getValue: () => select.value,
        setDisabled: (disabled) => {
          select.disabled = disabled;
        },
        isValid: () => Boolean(select.value.trim()),
        bindValidity: (callback) => {
          select.addEventListener("change", callback);
        },
      });
      continue;
    }

    if (field.type === "review_table") {
      if (field.label) {
        const label = doc.createElement("label");
        label.className = "llm-agent-hitl-label";
        label.textContent = field.label;
        card.appendChild(label);
      }
      card.appendChild(renderReviewTableField(doc, field));
      continue;
    }

    if (field.type === "image_gallery") {
      if (field.label) {
        const label = doc.createElement("label");
        label.className = "llm-agent-hitl-label";
        label.textContent = field.label;
        card.appendChild(label);
      }
      card.appendChild(renderImageGalleryField(doc, field));
      continue;
    }

    if (field.type === "checklist") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      card.appendChild(label);
      const rendered = renderChecklistField(doc, field);
      card.appendChild(rendered.element);
      fieldAccessors.push(rendered.accessor);
      continue;
    }

    if (field.type === "assignment_table") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      card.appendChild(label);
      const rendered = renderAssignmentTableField(doc, field);
      card.appendChild(rendered.element);
      fieldAccessors.push(rendered.accessor);
      continue;
    }

    if (field.type === "tag_assignment_table") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      card.appendChild(label);
      const rendered = renderTagAssignmentTableField(doc, field);
      card.appendChild(rendered.element);
      fieldAccessors.push(rendered.accessor);
    }
  }

  const actionRow = doc.createElement("div");
  actionRow.className = "llm-agent-hitl-actions";
  const buttons: HTMLButtonElement[] = [];
  const setButtonsDisabled = (disabled: boolean) => {
    for (const accessor of fieldAccessors) {
      accessor.setDisabled(disabled);
    }
    for (const button of buttons) {
      if (disabled) {
        button.disabled = true;
      }
    }
  };
  const syncConfirmButton = () => {
    const isValid = fieldAccessors.every((accessor) => accessor.isValid());
    for (const button of buttons) {
      if (button.dataset.kind === "save") {
        button.disabled = !isValid;
      }
    }
  };
  const handleSave = () => {
    setButtonsDisabled(true);
    const payload = Object.fromEntries(
      fieldAccessors.map((accessor) => [accessor.id, accessor.getValue()]),
    );
    getAgentRuntime().resolveConfirmation(pending.requestId, true, payload);
  };

  const saveButton = doc.createElement("button");
  saveButton.type = "button";
  saveButton.dataset.kind = "save";
  saveButton.className = "llm-agent-hitl-btn";
  saveButton.textContent = pending.action.confirmLabel || "Apply";
  saveButton.addEventListener("click", () => {
    handleSave();
  });
  buttons.push(saveButton);
  actionRow.appendChild(saveButton);

  const cancelButton = doc.createElement("button");
  cancelButton.type = "button";
  cancelButton.dataset.kind = "cancel";
  cancelButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
  cancelButton.textContent = pending.action.cancelLabel || "Cancel";
  cancelButton.addEventListener("click", () => {
    setButtonsDisabled(true);
    getAgentRuntime().resolveConfirmation(pending.requestId, false);
  });
  buttons.push(cancelButton);
  actionRow.appendChild(cancelButton);
  card.appendChild(actionRow);
  syncConfirmButton();
  for (const accessor of fieldAccessors) {
    accessor.bindValidity?.(syncConfirmButton);
  }

  return card;
}

function buildAgentTraceRequestChips(
  userMessage: Message | null | undefined,
): AgentTraceChip[] {
  if (!userMessage) return [];
  const chips: AgentTraceChip[] = [];
  const paperContexts = normalizePaperContexts(userMessage.paperContexts);
  if (paperContexts.length) {
    const label =
      paperContexts.length === 1
        ? truncateAgentTraceText(paperContexts[0]?.title || "Paper", 42)
        : `${paperContexts.length} papers`;
    chips.push({
      icon: "📚",
      label,
      title: paperContexts.map((entry) => entry.title).join("\n"),
    });
  }

  const selectedTexts = getMessageSelectedTexts(userMessage);
  if (selectedTexts.length) {
    const sources = normalizeSelectedTextSources(
      userMessage.selectedTextSources,
      selectedTexts.length,
    );
    const sourceIcon = getSelectedTextSourceIcon(sources[0] || "pdf");
    const label =
      selectedTexts.length === 1
        ? truncateAgentTraceText(selectedTexts[0], 42)
        : `${selectedTexts.length} text selections`;
    chips.push({
      icon: sourceIcon,
      label,
      title: selectedTexts.join("\n\n"),
    });
  }

  const screenshotCount = Array.isArray(userMessage.screenshotImages)
    ? userMessage.screenshotImages.filter(Boolean).length
    : 0;
  if (screenshotCount > 0) {
    chips.push({
      icon: "🖼",
      label: screenshotCount === 1 ? "1 figure" : `${screenshotCount} figures`,
    });
  }

  const fileAttachments = Array.isArray(userMessage.attachments)
    ? userMessage.attachments.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          entry.category !== "image" &&
          typeof entry.name === "string",
      )
    : [];
  if (fileAttachments.length) {
    chips.push({
      icon: "📎",
      label:
        fileAttachments.length === 1
          ? truncateAgentTraceText(fileAttachments[0]?.name || "File", 32)
          : `${fileAttachments.length} files`,
      title: fileAttachments.map((entry) => entry.name).join("\n"),
    });
  }

  return chips;
}

function buildAgentTraceRequestSummary(
  userMessage: Message | null | undefined,
): AgentTraceRequestSummary {
  const selectedTexts = userMessage ? getMessageSelectedTexts(userMessage) : [];
  const paperTitles = userMessage
    ? normalizePaperContexts(userMessage.paperContexts).map((entry) => entry.title)
    : [];
  const fileNames = Array.isArray(userMessage?.attachments)
    ? userMessage.attachments
        .filter((entry) => entry && entry.category !== "image")
        .map((entry) => entry.name)
    : [];
  const screenshotCount = Array.isArray(userMessage?.screenshotImages)
    ? userMessage.screenshotImages.filter(Boolean).length
    : 0;
  return {
    selectedTexts,
    paperTitles,
    fileNames,
    screenshotCount,
  };
}

function getToolDefinition(name: string) {
  return getAgentRuntime().getToolDefinition(name);
}

function resolveToolPresentationSummary(
  summary: AgentToolPresentationSummary | undefined,
  input: {
    label: string;
    args?: unknown;
    content?: unknown;
    request?: AgentTraceRequestSummary;
  },
): string | null {
  if (!summary) return null;
  if (typeof summary === "function") {
    return summary(input);
  }
  const normalized = summary.trim();
  return normalized || null;
}

function toolLabelFromName(name: string): string {
  const explicitLabel = getToolDefinition(name)?.presentation?.label?.trim();
  if (explicitLabel) return explicitLabel;
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildAgentTraceToolChips(
  toolName: string,
  args: unknown,
  userMessage: Message | null | undefined,
): AgentTraceChip[] {
  const requestSummary = buildAgentTraceRequestSummary(userMessage);
  const customChips = getToolDefinition(toolName)?.presentation?.buildChips?.({
    args,
    request: requestSummary,
  });
  if (Array.isArray(customChips) && customChips.length) {
    return customChips;
  }

  const record = isAgentTraceRecord(args) ? args : null;
  const chips: AgentTraceChip[] = [];
  const paperContext = isAgentTraceRecord(record?.paperContext)
    ? record?.paperContext
    : null;
  if (paperContext) {
    const paperTitle =
      readAgentTraceText(paperContext.title) ||
      `Paper ${paperContext.itemId ?? ""}`.trim();
    chips.push({
      icon: "📚",
      label: truncateAgentTraceText(paperTitle, 42),
      title: paperTitle,
    });
  }

  const query = readAgentTraceText(record?.query);
  if (query) {
    chips.push({
      icon: "⌕",
      label: truncateAgentTraceText(query, 36),
      title: query,
    });
  }

  const attachmentName = readAgentTraceText(record?.name);
  if (attachmentName) {
    chips.push({
      icon: /\.pdf$/i.test(attachmentName) ? "📄" : "📎",
      label: truncateAgentTraceText(attachmentName, 36),
      title: attachmentName,
    });
  }

  const pages =
    Array.isArray(record?.pages) && record?.pages.length
      ? record.pages
      : readAgentTraceText(record?.pages)
        ? [record?.pages]
        : [];
  if (pages.length) {
    const labels = pages
      .map((entry) =>
        typeof entry === "number"
          ? `p${Math.max(1, Math.floor(entry) + 1)}`
          : truncateAgentTraceText(entry, 16),
      )
      .join(", ");
    if (labels) {
      chips.push({
        icon: "§",
        label: truncateAgentTraceText(labels, 24),
        title: labels,
      });
    }
  }

  if (!chips.length && toolName === "get_active_context") {
    return buildAgentTraceRequestChips(userMessage);
  }

  return chips;
}

function summarizeAgentTraceToolCall(
  name: string,
  args: unknown,
  request?: AgentTraceRequestSummary,
): AgentTraceSummaryRow {
  const label = toolLabelFromName(name);
  const text =
    resolveToolPresentationSummary(
      getToolDefinition(name)?.presentation?.summaries?.onCall,
      { label, args, request },
    ) || `Using ${label}`;
  return {
    kind: "tool",
    icon: "→",
    text,
  };
}

function summarizeAgentTraceConfirmationRequest(
  toolName: string,
  request?: AgentTraceRequestSummary,
): AgentTraceSummaryRow {
  const label = toolLabelFromName(toolName);
  const text =
    resolveToolPresentationSummary(
      getToolDefinition(toolName)?.presentation?.summaries?.onPending,
      { label, request },
    ) || `Waiting for your approval to continue with ${label}`;
  return {
    kind: "plan",
    icon: "...",
    text,
  };
}

function summarizeAgentTraceConfirmationResolved(
  toolName: string,
  approved: boolean,
  request?: AgentTraceRequestSummary,
): AgentTraceSummaryRow {
  const label = toolLabelFromName(toolName);
  const text =
    resolveToolPresentationSummary(
      approved
        ? getToolDefinition(toolName)?.presentation?.summaries?.onApproved
        : getToolDefinition(toolName)?.presentation?.summaries?.onDenied,
      { label, request },
    ) ||
    (approved
      ? `Approval received - continuing with ${label}`
      : `Cancelled ${label}`);
  return {
    kind: approved ? "ok" : "skip",
    icon: approved ? "✓" : "-",
    text,
  };
}

function toolContentLooksEmpty(content: unknown): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return false;
  }
  const record = content as Record<string, unknown>;
  for (const key of [
    "papers",
    "evidence",
    "results",
    "suggestions",
    "pages",
    "collections",
  ]) {
    if (Array.isArray(record[key])) {
      return record[key].length === 0;
    }
  }
  return false;
}

function summarizeAgentTraceToolResult(
  name: string,
  ok: boolean,
  content: unknown,
  request?: AgentTraceRequestSummary,
): AgentTraceSummaryRow | null {
  const label = toolLabelFromName(name);
  const normalized = isAgentTraceRecord(content) ? content : null;
  if (!ok) {
    const rawError = readAgentTraceText(normalized?.error);
    if (rawError?.toLowerCase() === "user denied action") {
      return null;
    }
    const text =
      resolveToolPresentationSummary(
        getToolDefinition(name)?.presentation?.summaries?.onError,
        { label, content, request },
      ) ||
      truncateAgentTraceText(
        `Could not complete ${label}: ${rawError || "Tool failed"}`,
        92,
      );
    return {
      kind: "skip",
      icon: "!",
      text,
    };
  }

  const isEmpty = toolContentLooksEmpty(content);
  const text =
    resolveToolPresentationSummary(
      isEmpty
        ? getToolDefinition(name)?.presentation?.summaries?.onEmpty
        : getToolDefinition(name)?.presentation?.summaries?.onSuccess,
      { label, content, request },
    ) ||
    resolveToolPresentationSummary(
      getToolDefinition(name)?.presentation?.summaries?.onSuccess,
      { label, content, request },
    ) ||
    `${isEmpty ? "No results from" : "Completed"} ${label}`;
  return {
    kind: isEmpty ? "skip" : "ok",
    icon: isEmpty ? "-" : "✓",
    text,
  };
}

function getNextMeaningfulPayload(
  events: AgentRunEventRecord[],
  fromIndex: number,
): AgentRunEventPayload | null {
  for (let index = fromIndex; index < events.length; index += 1) {
    const payload = events[index]?.payload;
    if (!payload || payload.type === "status") continue;
    return payload;
  }
  return null;
}

function buildInitialAgentMessage(requestChips: AgentTraceChip[]): string {
  return requestChips.length
    ? "I've got your question and the attached context. I'm checking that first so I can ground the answer properly."
    : "I've got your question. I'm checking the current context first.";
}

function buildToolFollowUpMessage(
  _toolName: string,
  nextPayload: AgentRunEventPayload | null,
): string | null {
  if (!nextPayload) return null;
  if (nextPayload.type === "tool_call") {
    return `I'm ready for the next step, so I'm using ${toolLabelFromName(
      nextPayload.name,
    )} next.`;
  }
  if (nextPayload.type === "confirmation_required") {
    return "I'm ready for the next action. Review it below and approve if you want me to continue.";
  }
  if (nextPayload.type === "message_delta") {
    return "I have enough grounded information now, so I'm drafting the answer next.";
  }
  if (nextPayload.type === "final") {
    return "I have what I need now, so I can answer directly.";
  }
  return null;
}

function compactAgentTraceEvents(
  events: AgentRunEventRecord[],
): AgentRunEventRecord[] {
  const compact: AgentRunEventRecord[] = [];
  for (const entry of events) {
    const previous = compact[compact.length - 1];
    if (
      entry.payload.type === "message_delta" &&
      previous?.payload.type === "message_delta"
    ) {
      compact[compact.length - 1] = entry;
      continue;
    }
    compact.push(entry);
  }
  return compact;
}

export function buildAgentTraceDisplayItems(
  events: AgentRunEventRecord[],
  userMessage: Message | null | undefined,
): AgentTraceDisplayItem[] {
  const items: AgentTraceDisplayItem[] = [];
  const compactedEvents = compactAgentTraceEvents(events);
  const requestChips = buildAgentTraceRequestChips(userMessage);
  const requestSummary = buildAgentTraceRequestSummary(userMessage);
  const confirmationToolNames = new Map<string, string>();
  let announcedReadyToAnswer = false;
  let announcedWriting = false;

  items.push({
    type: "message",
    tone: "neutral",
    text: buildInitialAgentMessage(requestChips),
  });
  items.push({
    type: "action",
    row: {
      kind: "plan",
      icon: "↳",
      text: requestChips.length
        ? "Received your question and the attached context"
        : "Received your question",
    },
    chips: requestChips,
  });

  for (let index = 0; index < compactedEvents.length; index += 1) {
    const entry = compactedEvents[index];
    const nextPayload = getNextMeaningfulPayload(compactedEvents, index + 1);
    switch (entry.payload.type) {
      case "status":
        break;
      case "tool_call":
        items.push({
          type: "action",
          row: summarizeAgentTraceToolCall(
            entry.payload.name,
            entry.payload.args,
            requestSummary,
          ),
          chips: buildAgentTraceToolChips(
            entry.payload.name,
            entry.payload.args,
            userMessage,
          ),
        });
        break;
      case "tool_result": {
        const row = summarizeAgentTraceToolResult(
          entry.payload.name,
          entry.payload.ok,
          entry.payload.content,
          requestSummary,
        );
        if (row) {
          items.push({
            type: "action",
            row,
          });
          const followUp = buildToolFollowUpMessage(
            entry.payload.name,
            nextPayload,
          );
          if (followUp) {
            items.push({
              type: "message",
              tone: row.kind === "skip" ? "warning" : "neutral",
              text: followUp,
            });
          }
        }
        break;
      }
      case "confirmation_required":
        confirmationToolNames.set(
          entry.payload.requestId,
          entry.payload.action.toolName,
        );
        items.push({
          type: "message",
          tone: "warning",
          text: "I'm ready for the next action, but I need your approval before I continue.",
        });
        items.push({
          type: "action",
          row: summarizeAgentTraceConfirmationRequest(
            entry.payload.action.toolName,
            requestSummary,
          ),
        });
        break;
      case "confirmation_resolved": {
        const toolName =
          confirmationToolNames.get(entry.payload.requestId) || "action";
        items.push({
          type: "action",
          row: summarizeAgentTraceConfirmationResolved(
            toolName,
            entry.payload.approved,
            requestSummary,
          ),
        });
        items.push({
          type: "message",
          tone: entry.payload.approved ? "neutral" : "warning",
          text: entry.payload.approved
            ? "Thanks - I'm continuing with that action now."
            : "No problem - I stopped there.",
        });
        break;
      }
      case "message_delta":
        if (!announcedReadyToAnswer) {
          announcedReadyToAnswer = true;
          items.push({
            type: "message",
            tone: "neutral",
            text: "I have enough grounded information now, so I'm turning it into a direct answer.",
          });
        }
        if (!announcedWriting) {
          announcedWriting = true;
          items.push({
            type: "action",
            row: {
              kind: "plan",
              icon: "✎",
              text: "Drafting the answer",
            },
          });
        }
        break;
      case "final":
        items.push({
          type: "action",
          row: {
            kind: "done",
            icon: "✓",
            text: "Response ready",
          },
        });
        break;
      case "fallback":
        items.push({
          type: "message",
          tone: "warning",
          text: entry.payload.reason,
        });
        break;
    }
  }

  return items;
}

export function renderAgentTrace({
  doc,
  message,
  userMessage,
  events,
  onTraceMissing,
}: RenderAgentTraceParams): HTMLElement | null {
  const runId = message.agentRunId?.trim();
  if (!runId) return null;
  const wrap = doc.createElement("div");
  wrap.className = "llm-agent-activity";
  const list = doc.createElement("div");
  list.className = "llm-agent-activity-list";

  if (!events.length) {
    onTraceMissing?.();
    const loadingRow = doc.createElement("div");
    loadingRow.className = "llm-at-row llm-at-row-plan";
    const loadingIcon = doc.createElement("span");
    loadingIcon.className = "llm-at-icon";
    loadingIcon.textContent = "...";
    const loadingText = doc.createElement("span");
    loadingText.className = "llm-at-text llm-at-plan-text";
    loadingText.textContent = "Loading agent activity...";
    loadingRow.append(loadingIcon, loadingText);
    list.appendChild(loadingRow);
    wrap.appendChild(list);
    return wrap;
  }
  const processItems = buildAgentTraceDisplayItems(events, userMessage);
  const pending = getPendingWriteConfirmation(events);
  const hasFinalResponse = events.some((entry) => entry.payload.type === "final");
  for (const itemEntry of processItems) {
    if (itemEntry.type === "message") {
      const messageEl = doc.createElement("div");
      messageEl.className = `llm-agent-process-message llm-agent-process-message-${itemEntry.tone}`;
      messageEl.textContent = itemEntry.text;
      list.appendChild(messageEl);
      continue;
    }

    const actionWrap = doc.createElement("div");
    actionWrap.className = "llm-agent-process-action";
    const row = doc.createElement("div");
    row.className = `llm-at-row llm-at-row-${itemEntry.row.kind}`;
    const icon = doc.createElement("span");
    icon.className = "llm-at-icon";
    icon.textContent = itemEntry.row.icon;
    const text = doc.createElement("span");
    text.className = `llm-at-text llm-at-${itemEntry.row.kind}-text`;
    text.textContent = itemEntry.row.text;
    row.append(icon, text);
    actionWrap.appendChild(row);

    if (itemEntry.chips?.length) {
      const chips = doc.createElement("div");
      chips.className = "llm-agent-process-chips";
      for (const chip of itemEntry.chips) {
        const chipEl = doc.createElement("div");
        chipEl.className = "llm-agent-process-chip";
        if (chip.title) {
          chipEl.title = chip.title;
        }
        const chipIcon = doc.createElement("span");
        chipIcon.className = "llm-agent-process-chip-icon";
        chipIcon.textContent = chip.icon;
        const chipLabel = doc.createElement("span");
        chipLabel.className = "llm-agent-process-chip-label";
        chipLabel.textContent = chip.label;
        chipEl.append(chipIcon, chipLabel);
        chips.appendChild(chipEl);
      }
      actionWrap.appendChild(chips);
    }

    list.appendChild(actionWrap);
  }
  wrap.appendChild(list);

  if (hasFinalResponse) {
    const divider = doc.createElement("div");
    divider.className = "llm-agent-output-divider";
    divider.setAttribute("aria-hidden", "true");
    wrap.appendChild(divider);
  }

  if (pending) {
    wrap.appendChild(renderPendingWriteActionCard(doc, pending));
  }

  return wrap;
}
