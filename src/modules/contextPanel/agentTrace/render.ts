import { getAgentRuntime } from "../../../agent";
import { renderMarkdown } from "../../../utils/markdown";
import type {
  AgentPendingAction,
  AgentPendingField,
  AgentRunEventRecord,
  AgentToolResultCard,
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
import { agentReasoningExpandedCache } from "../agentState";
import { buildTextDiffPreview } from "./diffPreview";

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
    }
  | {
      type: "card_list";
      cards: AgentToolResultCard[];
    }
  | {
      type: "reasoning";
      key: string;
      label: string;
      summary?: string;
      details?: string;
    };

type RenderAgentTraceParams = {
  doc: Document;
  message: Message;
  userMessage?: Message | null;
  events: AgentRunEventRecord[];
  onTraceMissing?: () => void;
};

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

function getPendingConfirmation(
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

function appendAgentTraceText(
  base: string | undefined,
  next: unknown,
): string | undefined {
  const chunk =
    typeof next === "string" && next.trim() ? sanitizeText(next) : null;
  if (!chunk) return base;
  return `${base || ""}${chunk}`;
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

function renderDiffPreviewField(
  doc: Document,
  field: Extract<AgentPendingField, { type: "diff_preview" }>,
): {
  element: HTMLDivElement;
  update: (nextAfter: string) => void;
} {
  const wrap = doc.createElement("div");
  wrap.className = "llm-agent-hitl-diff";

  const body = doc.createElement("div");
  body.className = "llm-agent-hitl-diff-body";
  wrap.appendChild(body);

  const update = (nextAfter: string) => {
    body.replaceChildren();
    const lines = buildTextDiffPreview(field.before || "", nextAfter, {
      contextLines: field.contextLines,
    });
    if (!lines.length) {
      const empty = doc.createElement("div");
      empty.className = "llm-agent-hitl-diff-empty";
      empty.textContent = field.emptyMessage || "No changes.";
      body.appendChild(empty);
      return;
    }

    for (const line of lines) {
      if (line.kind === "gap") {
        const gap = doc.createElement("div");
        gap.className = "llm-agent-hitl-diff-gap";
        gap.textContent = `... ${line.omittedCount} unchanged line${
          line.omittedCount === 1 ? "" : "s"
        } ...`;
        body.appendChild(gap);
        continue;
      }

      const row = doc.createElement("div");
      row.className = `llm-agent-hitl-diff-line llm-agent-hitl-diff-line-${line.kind}`;

      const gutter = doc.createElement("div");
      gutter.className = "llm-agent-hitl-diff-gutter";

      const oldLineNumber = doc.createElement("span");
      oldLineNumber.className = "llm-agent-hitl-diff-line-number";
      oldLineNumber.textContent =
        typeof line.oldLineNumber === "number" ? String(line.oldLineNumber) : "";

      const newLineNumber = doc.createElement("span");
      newLineNumber.className = "llm-agent-hitl-diff-line-number";
      newLineNumber.textContent =
        typeof line.newLineNumber === "number" ? String(line.newLineNumber) : "";

      const marker = doc.createElement("span");
      marker.className = "llm-agent-hitl-diff-marker";
      marker.textContent =
        line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";

      gutter.append(oldLineNumber, newLineNumber, marker);

      const content = doc.createElement("pre");
      content.className = "llm-agent-hitl-diff-content";
      for (const segment of line.segments) {
        const segmentEl = doc.createElement("span");
        segmentEl.className =
          segment.kind === "context"
            ? "llm-agent-hitl-diff-segment"
            : `llm-agent-hitl-diff-segment llm-agent-hitl-diff-segment-${segment.kind}`;
        segmentEl.textContent = segment.text;
        content.appendChild(segmentEl);
      }
      if (!content.textContent) {
        content.textContent = " ";
      }

      row.append(gutter, content);
      body.appendChild(row);
    }
  };

  update(field.after || "");
  return { element: wrap, update };
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

/**
 * Renders a read-only list of result cards below a tool trace row.
 * Interactive workflows should use review cards instead.
 */
function renderResultCardList(
  doc: Document,
  cards: AgentToolResultCard[],
): HTMLDivElement {
  const container = doc.createElement("div");
  container.className =
    "llm-agent-hitl-card llm-search-results llm-search-results-readonly";

  const header = doc.createElement("div");
  header.className = "llm-agent-hitl-header";
  header.textContent = `${cards.length} paper${cards.length === 1 ? "" : "s"} found online`;
  container.appendChild(header);

  const list = doc.createElement("div");
  list.className = "llm-search-results-list";
  container.appendChild(list);

  for (const card of cards) {
    const row = doc.createElement("div");
    row.className = "llm-search-results-item";

    const content = doc.createElement("div");
    content.className = "llm-search-results-content";

    const titleRow = doc.createElement("div");
    titleRow.className = "llm-search-results-title-row";

    const titleEl = doc.createElement("span");
    titleEl.className = "llm-search-results-title";
    titleEl.textContent = card.title;
    titleRow.appendChild(titleEl);

    if (card.href) {
      const openBtn = doc.createElement("a");
      openBtn.className = "llm-search-results-open";
      openBtn.textContent = "Open ↗";
      openBtn.href = card.href;
      openBtn.addEventListener("click", (e) => {
        e.preventDefault();
        try {
          const launch = (Zotero as unknown as { launchURL?: (url: string) => void })
            .launchURL;
          if (typeof launch === "function") launch(card.href!);
        } catch {
          /* ignore */
        }
      });
      titleRow.appendChild(openBtn);
    }
    content.appendChild(titleRow);

    if (card.subtitle) {
      const subtitleEl = doc.createElement("div");
      subtitleEl.className = "llm-search-results-subtitle";
      subtitleEl.textContent = card.subtitle;
      content.appendChild(subtitleEl);
    }

    if (card.body) {
      const bodyEl = doc.createElement("div");
      bodyEl.className = "llm-search-results-body";
      bodyEl.textContent = card.body;
      content.appendChild(bodyEl);
    }

    if (card.badges?.length) {
      const badgeRow = doc.createElement("div");
      badgeRow.className = "llm-search-results-badges";
      for (const badge of card.badges) {
        const badgeEl = doc.createElement("span");
        badgeEl.className = "llm-agent-hitl-badge";
        badgeEl.textContent = badge;
        badgeRow.appendChild(badgeEl);
      }
      content.appendChild(badgeRow);
    }

    row.appendChild(content);
    list.appendChild(row);
  }
  return container;
}

function renderPaperResultListField(
  doc: Document,
  field: Extract<AgentPendingField, { type: "paper_result_list" }>,
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
  const container = doc.createElement("div");
  container.className = "llm-search-results";

  const toolbar = doc.createElement("div");
  toolbar.className = "llm-agent-hitl-checklist-toolbar";
  container.appendChild(toolbar);

  const list = doc.createElement("div");
  list.className = "llm-search-results-list";
  container.appendChild(list);

  const listeners: Array<() => void> = [];
  const emitValidityChange = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const checkboxes: HTMLInputElement[] = [];
  let selectAllButton: HTMLButtonElement | null = null;
  let deselectAllButton: HTMLButtonElement | null = null;

  selectAllButton = doc.createElement("button");
  selectAllButton.type = "button";
  selectAllButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-alt";
  selectAllButton.textContent = "Select all";
  selectAllButton.addEventListener("click", () => {
    for (const checkbox of checkboxes) {
      checkbox.checked = true;
    }
    emitValidityChange();
  });
  toolbar.appendChild(selectAllButton);

  deselectAllButton = doc.createElement("button");
  deselectAllButton.type = "button";
  deselectAllButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
  deselectAllButton.textContent = "Deselect all";
  deselectAllButton.addEventListener("click", () => {
    for (const checkbox of checkboxes) {
      checkbox.checked = false;
    }
    emitValidityChange();
  });
  toolbar.appendChild(deselectAllButton);

  for (const rowData of field.rows) {
    const row = doc.createElement("label");
    row.className = "llm-search-results-item";

    const checkboxWrap = doc.createElement("div");
    checkboxWrap.className = "llm-search-results-checkbox-wrap";
    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "llm-search-results-checkbox";
    checkbox.checked = rowData.checked !== false;
    checkbox.addEventListener("change", emitValidityChange);
    checkboxWrap.appendChild(checkbox);
    row.appendChild(checkboxWrap);
    checkboxes.push(checkbox);

    const content = doc.createElement("div");
    content.className = "llm-search-results-content";

    const titleRow = doc.createElement("div");
    titleRow.className = "llm-search-results-title-row";

    const titleEl = doc.createElement("span");
    titleEl.className = "llm-search-results-title";
    titleEl.textContent = rowData.title;
    titleRow.appendChild(titleEl);

    if (rowData.href) {
      const openBtn = doc.createElement("a");
      openBtn.className = "llm-search-results-open";
      openBtn.textContent = "Open ↗";
      openBtn.href = rowData.href;
      openBtn.addEventListener("click", (event) => {
        event.preventDefault();
        try {
          const launch = (Zotero as unknown as { launchURL?: (url: string) => void })
            .launchURL;
          if (typeof launch === "function") launch(rowData.href!);
        } catch {
          /* ignore */
        }
      });
      titleRow.appendChild(openBtn);
    }
    content.appendChild(titleRow);

    if (rowData.subtitle) {
      const subtitleEl = doc.createElement("div");
      subtitleEl.className = "llm-search-results-subtitle";
      subtitleEl.textContent = rowData.subtitle;
      content.appendChild(subtitleEl);
    }

    if (rowData.body) {
      const bodyEl = doc.createElement("div");
      bodyEl.className = "llm-search-results-body";
      bodyEl.textContent = rowData.body;
      content.appendChild(bodyEl);
    }

    if (rowData.badges?.length) {
      const badgeRow = doc.createElement("div");
      badgeRow.className = "llm-search-results-badges";
      for (const badge of rowData.badges) {
        const badgeEl = doc.createElement("span");
        badgeEl.className = "llm-agent-hitl-badge";
        badgeEl.textContent = badge;
        badgeRow.appendChild(badgeEl);
      }
      content.appendChild(badgeRow);
    }

    row.appendChild(content);
    list.appendChild(row);
  }

  const getSelectedIds = () =>
    field.rows
      .filter((_row, index) => checkboxes[index]?.checked)
      .map((row) => row.id);

  return {
    element: container,
    accessor: {
      id: field.id,
      getValue: () => getSelectedIds(),
      setDisabled: (disabled) => {
        for (const checkbox of checkboxes) {
          checkbox.disabled = disabled;
        }
        if (selectAllButton) {
          selectAllButton.disabled = disabled;
        }
        if (deselectAllButton) {
          deselectAllButton.disabled = disabled;
        }
      },
      isValid: () => getSelectedIds().length > 0,
      bindValidity: (callback) => {
        listeners.push(callback);
      },
    },
  };
}

function normalizePendingActions(action: AgentPendingAction) {
  const provided =
    Array.isArray(action.actions) && action.actions.length > 0
      ? action.actions
      : [
          {
            id: "confirm",
            label: action.confirmLabel || "Apply",
            style: "primary" as const,
          },
          {
            id: "cancel",
            label: action.cancelLabel || "Cancel",
            style: "secondary" as const,
          },
        ];
  const cancelActionId =
    action.cancelActionId && provided.some((entry) => entry.id === action.cancelActionId)
      ? action.cancelActionId
      : provided.find((entry) => entry.id === "cancel")?.id || provided[provided.length - 1]?.id;
  const primaryActions = provided.filter((entry) => entry.id !== cancelActionId);
  const defaultActionId =
    action.defaultActionId && primaryActions.some((entry) => entry.id === action.defaultActionId)
      ? action.defaultActionId
      : primaryActions[0]?.id || cancelActionId;
  return {
    actions: provided,
    primaryActions,
    cancelAction: provided.find((entry) => entry.id === cancelActionId) || null,
    defaultActionId,
    cancelActionId,
  };
}

function isDeferredActionField(field: AgentPendingField): boolean {
  return (
    field.type === "textarea" ||
    field.type === "text" ||
    field.type === "select" ||
    field.type === "assignment_table" ||
    field.type === "tag_assignment_table"
  );
}

function getPendingActionButton(
  action: AgentPendingAction,
  actionId: string,
) {
  return normalizePendingActions(action).actions.find((entry) => entry.id === actionId) || null;
}

function getPendingActionExecutionMode(
  action: AgentPendingAction,
  actionId: string,
): "immediate" | "edit" {
  const button = getPendingActionButton(action, actionId);
  if (button?.executionMode) {
    return button.executionMode;
  }
  return action.fields.some((field) => {
    const isScoped =
      Boolean(field.visibleForActionIds?.length) ||
      Boolean(field.requiredForActionIds?.length);
    if (!isScoped || !isDeferredActionField(field)) {
      return false;
    }
    const visibleForAction =
      !field.visibleForActionIds?.length || field.visibleForActionIds.includes(actionId);
    const requiredForAction = field.requiredForActionIds?.includes(actionId) || false;
    return visibleForAction || requiredForAction;
  })
    ? "edit"
    : "immediate";
}

export function getPendingActionButtonLayout(action: AgentPendingAction): {
  hasActionChooser: boolean;
  showsFooterExecuteButton: boolean;
} {
  const normalizedActions = normalizePendingActions(action);
  const hasActionChooser = normalizedActions.primaryActions.length > 1;
  return {
    hasActionChooser,
    showsFooterExecuteButton:
      !hasActionChooser ||
      normalizedActions.primaryActions.some(
        (entry) => getPendingActionExecutionMode(action, entry.id) === "edit",
      ),
  };
}

function isFieldVisibleForAction(
  field: AgentPendingField,
  actionId: string,
): boolean {
  return !field.visibleForActionIds?.length || field.visibleForActionIds.includes(actionId);
}

function isFieldRequiredForAction(
  field: AgentPendingField,
  actionId: string,
): boolean {
  if (field.requiredForActionIds?.length) {
    return field.requiredForActionIds.includes(actionId);
  }
  return isFieldVisibleForAction(field, actionId);
}

function getPaperResultMinSelection(
  field: Extract<AgentPendingField, { type: "paper_result_list" }>,
  actionId: string,
): number {
  return (
    field.minSelectedByAction?.find((entry) => entry.actionId === actionId)?.min ||
    0
  );
}

export function renderPendingActionCard(
  doc: Document,
  pending: { requestId: string; action: AgentPendingAction },
): HTMLDivElement {
  const card = doc.createElement("div");
  card.className = "llm-agent-hitl-card";

  const header = doc.createElement("div");
  header.className = "llm-agent-hitl-header";
  header.textContent =
    pending.action.mode === "review" ? "Review required" : "Action required";
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

  const normalizedActions = normalizePendingActions(pending.action);
  const buttonLayout = getPendingActionButtonLayout(pending.action);
  let activeActionId = normalizedActions.defaultActionId;
  const liveFieldBindings = new Map<
    string,
    {
      getValue: () => string;
      bindChange: (callback: () => void) => void;
    }
  >();
  const diffPreviewBindings: Array<{
    field: Extract<AgentPendingField, { type: "diff_preview" }>;
    update: (nextAfter: string) => void;
  }> = [];
  const fieldAccessors: Array<{
    field: AgentPendingField;
    container: HTMLElement;
    id: string;
    getValue: () => unknown;
    setDisabled: (disabled: boolean) => void;
    isValid: () => boolean;
    bindValidity?: (callback: () => void) => void;
  }> = [];

  for (const field of pending.action.fields) {
    const fieldContainer = doc.createElement("div");
    fieldContainer.className = "llm-agent-hitl-field";
    if (field.type === "textarea") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      fieldContainer.appendChild(label);

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
      fieldContainer.appendChild(textarea);
      fieldAccessors.push({
        field,
        container: fieldContainer,
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
      liveFieldBindings.set(field.id, {
        getValue: () => textarea.value,
        bindChange: (callback) => {
          textarea.addEventListener("input", callback);
        },
      });
      card.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "text") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      fieldContainer.appendChild(label);

      const input = doc.createElement("input");
      input.type = "text";
      input.className = "llm-agent-hitl-page-input";
      input.value = field.value || "";
      input.placeholder = field.placeholder || "";
      fieldContainer.appendChild(input);
      fieldAccessors.push({
        field,
        container: fieldContainer,
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
      liveFieldBindings.set(field.id, {
        getValue: () => input.value,
        bindChange: (callback) => {
          input.addEventListener("input", callback);
        },
      });
      card.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "select") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      fieldContainer.appendChild(label);

      const select = doc.createElement("select");
      select.className = "llm-agent-hitl-page-input";
      for (const option of field.options) {
        const optionEl = doc.createElement("option");
        optionEl.value = option.id;
        optionEl.textContent = option.label;
        select.appendChild(optionEl);
      }
      select.value = field.value || field.options[0]?.id || "";
      fieldContainer.appendChild(select);
      fieldAccessors.push({
        field,
        container: fieldContainer,
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
      liveFieldBindings.set(field.id, {
        getValue: () => select.value,
        bindChange: (callback) => {
          select.addEventListener("change", callback);
        },
      });
      card.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "review_table") {
      if (field.label) {
        const label = doc.createElement("label");
        label.className = "llm-agent-hitl-label";
        label.textContent = field.label;
        fieldContainer.appendChild(label);
      }
      fieldContainer.appendChild(renderReviewTableField(doc, field));
      fieldAccessors.push({
        field,
        container: fieldContainer,
        id: field.id,
        getValue: () => null,
        setDisabled: () => undefined,
        isValid: () => true,
      });
      card.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "diff_preview") {
      if (field.label) {
        const label = doc.createElement("label");
        label.className = "llm-agent-hitl-label";
        label.textContent = field.label;
        fieldContainer.appendChild(label);
      }
      const rendered = renderDiffPreviewField(doc, field);
      fieldContainer.appendChild(rendered.element);
      diffPreviewBindings.push({
        field,
        update: rendered.update,
      });
      fieldAccessors.push({
        field,
        container: fieldContainer,
        id: field.id,
        getValue: () => null,
        setDisabled: () => undefined,
        isValid: () => true,
      });
      card.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "image_gallery") {
      if (field.label) {
        const label = doc.createElement("label");
        label.className = "llm-agent-hitl-label";
        label.textContent = field.label;
        fieldContainer.appendChild(label);
      }
      fieldContainer.appendChild(renderImageGalleryField(doc, field));
      fieldAccessors.push({
        field,
        container: fieldContainer,
        id: field.id,
        getValue: () => null,
        setDisabled: () => undefined,
        isValid: () => true,
      });
      card.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "checklist") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      fieldContainer.appendChild(label);
      const rendered = renderChecklistField(doc, field);
      fieldContainer.appendChild(rendered.element);
      fieldAccessors.push({
        field,
        container: fieldContainer,
        ...rendered.accessor,
      });
      card.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "assignment_table") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      fieldContainer.appendChild(label);
      const rendered = renderAssignmentTableField(doc, field);
      fieldContainer.appendChild(rendered.element);
      fieldAccessors.push({
        field,
        container: fieldContainer,
        ...rendered.accessor,
      });
      card.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "tag_assignment_table") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      fieldContainer.appendChild(label);
      const rendered = renderTagAssignmentTableField(doc, field);
      fieldContainer.appendChild(rendered.element);
      fieldAccessors.push({
        field,
        container: fieldContainer,
        ...rendered.accessor,
      });
      card.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "paper_result_list") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      fieldContainer.appendChild(label);
      const rendered = renderPaperResultListField(doc, field);
      fieldContainer.appendChild(rendered.element);
      fieldAccessors.push({
        field,
        container: fieldContainer,
        ...rendered.accessor,
      });
      card.appendChild(fieldContainer);
    }
  }

  for (const binding of diffPreviewBindings) {
    const source = binding.field.sourceFieldId
      ? liveFieldBindings.get(binding.field.sourceFieldId)
      : null;
    if (!source) {
      continue;
    }
    const refresh = () => {
      binding.update(source.getValue());
    };
    refresh();
    source.bindChange(refresh);
  }

  const buttons: HTMLButtonElement[] = [];
  const isActionValid = (actionId: string) =>
    fieldAccessors.every((accessor) => isAccessorValidForAction(accessor, actionId));
  const getActionById = (actionId: string) =>
    normalizedActions.actions.find((entry) => entry.id === actionId) || null;
  const actionNeedsSeparateSubmit = (actionId: string) =>
    getPendingActionExecutionMode(pending.action, actionId) === "edit";
  const getSeparateSubmitLabel = (actionId: string) => {
    const actionButton = getActionById(actionId);
    return actionButton?.submitLabel || actionButton?.label || pending.action.confirmLabel || "Apply";
  };
  const getBackLabel = (actionId: string) => {
    return getActionById(actionId)?.backLabel || "Get back";
  };
  const actionNeedsExplicitReview = (actionId: string) =>
    fieldAccessors.some(({ field }) => {
      const hasScopedVisibility =
        Array.isArray(field.visibleForActionIds) &&
        field.visibleForActionIds.length > 0 &&
        field.visibleForActionIds.includes(actionId);
      const hasScopedRequirement =
        Array.isArray(field.requiredForActionIds) &&
        field.requiredForActionIds.length > 0 &&
        field.requiredForActionIds.includes(actionId);
      return hasScopedVisibility || hasScopedRequirement;
    });
  const handleExecute = () => {
    setButtonsDisabled(true);
    const payload = Object.fromEntries(
      fieldAccessors.map((accessor) => [accessor.id, accessor.getValue()]),
    );
    getAgentRuntime().resolveConfirmation(pending.requestId, {
      approved: activeActionId !== normalizedActions.cancelActionId,
      actionId: activeActionId,
      data: payload,
    });
  };
  let lastChooserActionId =
    normalizedActions.primaryActions.find(
      (action) => !actionNeedsSeparateSubmit(action.id),
    )?.id || normalizedActions.defaultActionId;
  let actionChooser: HTMLDivElement | null = null;
  if (buttonLayout.hasActionChooser) {
    actionChooser = doc.createElement("div");
    actionChooser.className = "llm-agent-hitl-action-choices";
    for (const action of normalizedActions.primaryActions) {
      const actionButton = doc.createElement("button");
      actionButton.type = "button";
      actionButton.dataset.actionChoice = action.id;
      actionButton.dataset.primary = action.style === "primary" ? "true" : "false";
      actionButton.className =
        action.id === activeActionId
          ? "llm-agent-hitl-btn llm-agent-hitl-btn-active"
          : action.style === "primary"
            ? "llm-agent-hitl-btn"
            : "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
      actionButton.textContent = action.label;
      actionButton.addEventListener("click", () => {
        const nextActionNeedsSeparateSubmit = actionNeedsSeparateSubmit(action.id);
        if (activeActionId === action.id) {
          if (!nextActionNeedsSeparateSubmit && isActionValid(action.id)) {
            handleExecute();
          }
          return;
        }
        if (!nextActionNeedsSeparateSubmit) {
          lastChooserActionId = action.id;
        } else if (!actionNeedsSeparateSubmit(activeActionId)) {
          lastChooserActionId = activeActionId;
        }
        activeActionId = action.id;
        syncActionUi();
        if (
          !actionNeedsExplicitReview(action.id) &&
          !nextActionNeedsSeparateSubmit &&
          isActionValid(action.id)
        ) {
          handleExecute();
        }
      });
      buttons.push(actionButton);
      actionChooser.appendChild(actionButton);
    }
    card.appendChild(actionChooser);
  }

  const actionRow = doc.createElement("div");
  actionRow.className = "llm-agent-hitl-actions";
  let executeButton: HTMLButtonElement | null = null;
  let backButton: HTMLButtonElement | null = null;
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
  const isAccessorValidForAction = (
    accessor: (typeof fieldAccessors)[number],
    actionId: string,
  ) => {
    if (!isFieldRequiredForAction(accessor.field, actionId)) {
      return true;
    }
    if (accessor.field.type === "paper_result_list") {
      const selectedCount = Array.isArray(accessor.getValue())
        ? (accessor.getValue() as unknown[]).length
        : 0;
      return selectedCount >= getPaperResultMinSelection(accessor.field, actionId);
    }
    return accessor.isValid();
  };
  const syncActionUi = () => {
    const isSeparateSubmitMode =
      buttonLayout.hasActionChooser && actionNeedsSeparateSubmit(activeActionId);
    for (const accessor of fieldAccessors) {
      accessor.container.hidden = !isFieldVisibleForAction(accessor.field, activeActionId);
    }
    const activeAction = getActionById(activeActionId);
    if (actionChooser) {
      actionChooser.hidden = isSeparateSubmitMode;
    }
    if (executeButton) {
      executeButton.hidden =
        !buttonLayout.showsFooterExecuteButton ||
        (buttonLayout.hasActionChooser && !isSeparateSubmitMode);
      executeButton.textContent = isSeparateSubmitMode
        ? getSeparateSubmitLabel(activeActionId)
        : activeAction?.label || pending.action.confirmLabel || "Apply";
    }
    if (backButton) {
      backButton.hidden = !isSeparateSubmitMode;
      backButton.textContent = getBackLabel(activeActionId);
    }
    for (const button of buttons) {
      if (button.dataset.actionChoice) {
        const isActive = button.dataset.actionChoice === activeActionId;
        button.className = isActive
          ? "llm-agent-hitl-btn llm-agent-hitl-btn-active"
          : button.dataset.primary === "true"
            ? "llm-agent-hitl-btn"
            : "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
      }
    }
    syncConfirmButton();
  };
  const syncConfirmButton = () => {
    const isValid = isActionValid(activeActionId);
    if (executeButton) {
      executeButton.disabled = !isValid;
    }
  };
  if (buttonLayout.showsFooterExecuteButton) {
    executeButton = doc.createElement("button");
    executeButton.type = "button";
    executeButton.dataset.kind = "save";
    executeButton.className = "llm-agent-hitl-btn";
    executeButton.textContent = pending.action.confirmLabel || "Apply";
    executeButton.addEventListener("click", () => {
      handleExecute();
    });
    buttons.push(executeButton);
    actionRow.appendChild(executeButton);
  }

  if (buttonLayout.hasActionChooser) {
    backButton = doc.createElement("button");
    backButton.type = "button";
    backButton.dataset.kind = "back";
    backButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
    backButton.textContent = getBackLabel(activeActionId);
    backButton.hidden = true;
    backButton.addEventListener("click", () => {
      activeActionId = lastChooserActionId;
      syncActionUi();
    });
    buttons.push(backButton);
    actionRow.appendChild(backButton);
  }

  if (normalizedActions.cancelAction) {
    const cancelButton = doc.createElement("button");
    cancelButton.type = "button";
    cancelButton.dataset.kind = "cancel";
    cancelButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
    cancelButton.textContent =
      normalizedActions.cancelAction.label || pending.action.cancelLabel || "Cancel";
    cancelButton.addEventListener("click", () => {
      setButtonsDisabled(true);
      getAgentRuntime().resolveConfirmation(pending.requestId, {
        approved: false,
        actionId: normalizedActions.cancelActionId,
      });
    });
    buttons.push(cancelButton);
    actionRow.appendChild(cancelButton);
  }
  if (actionRow.childElementCount > 0) {
    card.appendChild(actionRow);
  }
  syncActionUi();
  for (const accessor of fieldAccessors) {
    accessor.bindValidity?.(syncActionUi);
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
  try {
    return getAgentRuntime().getToolDefinition(name);
  } catch {
    return undefined;
  }
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
  action: AgentPendingAction,
  request?: AgentTraceRequestSummary,
): AgentTraceSummaryRow {
  const toolName = action.toolName;
  const label = toolLabelFromName(toolName);
  const text =
    resolveToolPresentationSummary(
      getToolDefinition(toolName)?.presentation?.summaries?.onPending,
      { label, request },
    ) ||
    (action.mode === "review"
      ? `Waiting for your review of ${label}`
      : `Waiting for your approval to continue with ${label}`);
  return {
    kind: "plan",
    icon: "...",
    text,
  };
}

function summarizeAgentTraceConfirmationResolved(
  action: AgentPendingAction,
  approved: boolean,
  actionId: string | undefined,
  request?: AgentTraceRequestSummary,
): AgentTraceSummaryRow {
  const toolName = action.toolName;
  const label = toolLabelFromName(toolName);
  const selectedActionLabel =
    action.actions?.find((entry) => entry.id === actionId)?.label ||
    (approved ? action.confirmLabel : action.cancelLabel);
  const text =
    resolveToolPresentationSummary(
      approved
        ? getToolDefinition(toolName)?.presentation?.summaries?.onApproved
        : getToolDefinition(toolName)?.presentation?.summaries?.onDenied,
      { label, request },
    ) ||
    (approved
      ? action.mode === "review"
        ? `Review received - selected "${selectedActionLabel}" for ${label}`
        : `Approval received - continuing with ${label}`
      : action.mode === "review"
        ? `Stopped ${label} after review`
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

function isGenericAgentStatusText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "running agent" ||
    /^continuing agent \(\d+\/\d+\)$/.test(normalized)
  );
}

function buildInitialAgentMessage(requestChips: AgentTraceChip[]): string {
  return requestChips.length
    ? "Checking the request against the attached context."
    : "Checking the current request and Zotero context.";
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
    if (
      entry.payload.type === "reasoning" &&
      previous?.payload.type === "reasoning" &&
      previous.payload.round === entry.payload.round
    ) {
      compact[compact.length - 1] = {
        ...entry,
        payload: {
          type: "reasoning",
          round: entry.payload.round,
          summary: appendAgentTraceText(
            previous.payload.summary,
            entry.payload.summary,
          ),
          details: appendAgentTraceText(
            previous.payload.details,
            entry.payload.details,
          ),
        },
      };
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
  const pendingActions = new Map<string, AgentPendingAction>();
  let announcedWriting = false;
  let lastMeaningfulStatus: string | null = null;

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
        ? "Request and attached context received"
        : "Request received",
    },
    chips: requestChips,
  });

  for (let index = 0; index < compactedEvents.length; index += 1) {
    const entry = compactedEvents[index];
    switch (entry.payload.type) {
      case "status": {
        const statusText = readAgentTraceText(entry.payload.text);
        if (
          !statusText ||
          isGenericAgentStatusText(statusText) ||
          statusText === lastMeaningfulStatus
        ) {
          break;
        }
        lastMeaningfulStatus = statusText;
        items.push({
          type: "action",
          row: {
            kind: "plan",
            icon: "…",
            text: statusText,
          },
        });
        break;
      }
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
      case "reasoning": {
        const summary = readAgentTraceText(entry.payload.summary) || undefined;
        const details = readAgentTraceText(entry.payload.details) || undefined;
        if (!summary && !details) {
          break;
        }
        items.push({
          type: "reasoning",
          key: `round:${entry.payload.round}`,
          label: `Thinking for step ${entry.payload.round}`,
          summary,
          details,
        });
        break;
      }
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
          if (entry.payload.ok) {
            try {
              const cards =
                getToolDefinition(entry.payload.name)
                  ?.presentation?.buildResultCards?.(entry.payload.content) ??
                null;
              if (cards && cards.length > 0) {
                items.push({ type: "card_list", cards });
              }
            } catch {
              // card generation errors must not crash the trace
            }
          }
        }
        break;
      }
      case "confirmation_required":
        pendingActions.set(entry.payload.requestId, entry.payload.action);
        items.push({
          type: "action",
          row: summarizeAgentTraceConfirmationRequest(entry.payload.action, requestSummary),
        });
        break;
      case "confirmation_resolved": {
        const action = pendingActions.get(entry.payload.requestId) || {
          toolName: "action",
          title: "Action",
          confirmLabel: "Apply",
          cancelLabel: "Cancel",
          fields: [],
        };
        pendingActions.delete(entry.payload.requestId);
        items.push({
          type: "action",
          row: summarizeAgentTraceConfirmationResolved(
            action,
            entry.payload.approved,
            entry.payload.actionId,
            requestSummary,
          ),
        });
        break;
      }
      case "message_delta":
        if (!announcedWriting) {
          announcedWriting = true;
          items.push({
            type: "action",
            row: {
              kind: "plan",
              icon: "✎",
              text: "Drafting answer",
            },
          });
        }
        break;
      case "message_rollback": {
        announcedWriting = false;
        const rollbackText = (entry.payload.text || "").trim();
        if (rollbackText) {
          items.push({
            type: "message",
            tone: "neutral",
            text: rollbackText,
          });
        }
        break;
      }
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
  const pending = getPendingConfirmation(events);
  const hasFinalResponse = events.some((entry) => entry.payload.type === "final");
  for (const itemEntry of processItems) {
    if (itemEntry.type === "message") {
      const messageEl = doc.createElement("div");
      messageEl.className = `llm-agent-process-message llm-agent-process-message-${itemEntry.tone}`;
      messageEl.textContent = itemEntry.text;
      list.appendChild(messageEl);
      continue;
    }

    if (itemEntry.type === "card_list") {
      list.appendChild(renderResultCardList(doc, itemEntry.cards));
      continue;
    }

    if (itemEntry.type === "reasoning") {
      const details = doc.createElement("details") as HTMLDetailsElement;
      details.className = "llm-agent-reasoning";
      const expansionKey = `${runId}:${itemEntry.key}`;
      details.open = Boolean(agentReasoningExpandedCache.get(expansionKey));

      const summary = doc.createElement("summary") as HTMLElement;
      summary.className = "llm-agent-reasoning-summary";
      summary.textContent = itemEntry.label;
      const toggleReasoning = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = !details.open;
        details.open = next;
        agentReasoningExpandedCache.set(expansionKey, next);
      };
      summary.addEventListener("mousedown", toggleReasoning);
      summary.addEventListener("click", (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      summary.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          toggleReasoning(event);
        }
      });
      details.appendChild(summary);

      const bodyWrap = doc.createElement("div") as HTMLDivElement;
      bodyWrap.className = "llm-agent-reasoning-body";

      if (itemEntry.summary) {
        const summaryBlock = doc.createElement("div") as HTMLDivElement;
        summaryBlock.className = "llm-agent-reasoning-block";
        const label = doc.createElement("div") as HTMLDivElement;
        label.className = "llm-agent-reasoning-label";
        label.textContent = "Summary";
        const text = doc.createElement("div") as HTMLDivElement;
        text.className = "llm-agent-reasoning-text";
        try {
          text.innerHTML = renderMarkdown(itemEntry.summary);
        } catch (error) {
          ztoolkit.log("Agent reasoning render error:", error);
          text.textContent = itemEntry.summary;
        }
        summaryBlock.append(label, text);
        bodyWrap.appendChild(summaryBlock);
      }

      if (itemEntry.details) {
        const detailsBlock = doc.createElement("div") as HTMLDivElement;
        detailsBlock.className = "llm-agent-reasoning-block";
        const label = doc.createElement("div") as HTMLDivElement;
        label.className = "llm-agent-reasoning-label";
        label.textContent = "Details";
        const text = doc.createElement("div") as HTMLDivElement;
        text.className = "llm-agent-reasoning-text";
        try {
          text.innerHTML = renderMarkdown(itemEntry.details);
        } catch (error) {
          ztoolkit.log("Agent reasoning render error:", error);
          text.textContent = itemEntry.details;
        }
        detailsBlock.append(label, text);
        bodyWrap.appendChild(detailsBlock);
      }

      details.appendChild(bodyWrap);
      list.appendChild(details);
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
    wrap.appendChild(renderPendingActionCard(doc, pending));
  }

  return wrap;
}
