import { getAgentRuntime } from "../../../agent";
import type {
  AgentPendingAction,
  AgentPendingField,
  AgentRunEventRecord,
  AgentTraceDetail,
  AgentToolResultCard,
  AgentTraceChip,
  AgentTraceRequestSummary,
  AgentToolPresentationSummary,
} from "../../../agent/types";
import type { Message, PaperContextRef } from "../types";
import { sanitizeText } from "../textUtils";
import { renderRenderedMarkdownInto } from "../renderedMarkdown";
import {
  normalizeQuoteCitationPlaceholdersForDisplay,
  replaceQuoteCitationPlaceholdersForMarkdown,
} from "../quoteCitations";
import { toFileUrl } from "../../../utils/pathFileUrl";
import {
  normalizePaperContextRefs,
  normalizeSelectedTextSources,
} from "../normalizers";
import { agentReasoningExpandedCache } from "../agentState";
import { buildTextDiffPreview } from "./diffPreview";
import {
  createContextIcon,
  getSelectedTextSourceIconName,
  isContextIconName,
  NOTE_EDIT_PENCIL_ICON,
} from "../contextIcons";
import { summarizeFileIOCall } from "../../../agent/tools/write/fileIO";
import {
  isContentLikeToolArgumentKey,
  isMalformedToolArgumentsDiagnostic,
} from "../../../agent/toolArgumentDiagnostics";
import {
  appendAgentTraceText,
  compactAgentTraceEvents,
  getReasoningTraceKey,
  normalizeInlineTextForDedupe,
} from "./traceReducer";
import {
  buildToolResultTraceInfo,
  type ToolResultTraceInfo,
} from "./toolResultTraceInfo";

type AgentTraceSummaryKind = "plan" | "tool" | "ok" | "skip" | "done";

type AgentTraceSummaryRow = {
  kind: AgentTraceSummaryKind;
  icon: string;
  text: string;
  /** Optional code block shown below the summary text (e.g. shell commands). */
  codeBlock?: string;
};

const agentTraceActionExpandedCache = new Map<string, boolean>();

type AgentTraceDisplayItem =
  | {
      type: "message";
      tone: "neutral" | "success" | "warning";
      text: string;
      markdown?: boolean;
    }
  | {
      type: "action";
      row: AgentTraceSummaryRow;
      chips?: AgentTraceChip[];
      details?: AgentTraceDetail[];
      detailKey?: string;
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
    }
  | { type: "inline_text"; text: string };

type RenderAgentTraceParams = {
  doc: Document;
  message: Message;
  userMessage?: Message | null;
  events: AgentRunEventRecord[];
  onTraceMissing?: () => void;
  onInterleavedText?: () => void;
};

export function buildAgentTraceMarkdownForRender(
  text: string,
  message?: Pick<Message, "quoteCitations"> | null,
): string {
  return normalizeQuoteCitationPlaceholdersForDisplay(
    replaceQuoteCitationPlaceholdersForMarkdown(
      sanitizeText(text || ""),
      message?.quoteCitations,
      { resolved: "preserve", unresolved: "omit" },
    ),
  );
}

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
  if (typeof value !== "string") return null;
  return value.trim() ? value : null;
}

function compactAgentTraceText(value: unknown): string {
  const raw = readAgentTraceText(value) || `${value ?? ""}`;
  return sanitizeText(raw).replace(/\s+/g, " ").trim();
}

function normalizeAgentTraceDetail(
  label: string,
  value: unknown,
  kind: AgentTraceDetail["kind"] = "text",
): AgentTraceDetail | null {
  const cleanLabel = compactAgentTraceText(label);
  if (!cleanLabel) return null;
  const cleanValue =
    typeof value === "string"
      ? sanitizeText(value).trim()
      : compactAgentTraceText(value);
  if (!cleanValue) return null;
  return {
    label: cleanLabel,
    value: cleanValue,
    ...(kind ? { kind } : {}),
  };
}

function omitLargeTraceString(value: string): string {
  if (/^data:(?:image|application)\//i.test(value) && value.length > 160) {
    const marker = value.slice(0, 96);
    return `${marker}...[omitted ${value.length - marker.length} chars]`;
  }
  return value;
}

function stringifyAgentTraceJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(
      value,
      (_key, entry) => {
        if (typeof entry === "string") {
          return omitLargeTraceString(entry);
        }
        if (entry && typeof entry === "object") {
          if (seen.has(entry)) return "[Circular]";
          seen.add(entry);
        }
        return entry;
      },
      2,
    );
    return json && json !== "{}" && json !== "[]" ? json : null;
  } catch {
    return compactAgentTraceText(value);
  }
}

function buildJsonTraceDetail(
  label: string,
  value: unknown,
): AgentTraceDetail | null {
  const json = stringifyAgentTraceJson(value);
  return json ? normalizeAgentTraceDetail(label, json, "json") : null;
}

function pushTraceDetail(
  details: AgentTraceDetail[],
  label: string,
  value: unknown,
  kind: AgentTraceDetail["kind"] = "text",
): void {
  const detail = normalizeAgentTraceDetail(label, value, kind);
  if (detail) details.push(detail);
}

function renderReviewValueCell(
  doc: Document,
  raw: string,
  multiline: boolean,
  variant: "before" | "after",
): HTMLDivElement {
  const value = doc.createElement("div");
  const baseClasses = multiline
    ? ["llm-agent-hitl-review-value", "llm-agent-hitl-review-value-multiline"]
    : ["llm-agent-hitl-review-value"];
  if (variant === "after") {
    baseClasses.push("llm-agent-hitl-review-value-after");
  }
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    baseClasses.push("llm-agent-hitl-review-value-empty");
    value.textContent = "(empty)";
  } else {
    value.textContent = trimmed;
    if (!multiline) {
      value.setAttribute("title", trimmed);
    }
  }
  value.className = baseClasses.join(" ");
  return value;
}

/**
 * Renders a review_table as a per-paper block. When `paperTitle` is provided
 * (batch mode: multiple papers in one card), the list is wrapped in a
 * bordered block with a prominent title line. Each field row inside the
 * block uses a three-column Before → After layout so the change is scannable.
 */
function renderReviewTableField(
  doc: Document,
  field: Extract<AgentPendingField, { type: "review_table" }>,
  meta?: { paperTitle?: string; paperIndex?: number; paperTotal?: number },
): HTMLDivElement {
  const paperTitle = meta?.paperTitle ?? field.label ?? "";
  // Only wrap in a bordered paper-block when there's a title worth showing;
  // otherwise the block's border would duplicate the outer HITL card border.
  const root = doc.createElement("div");
  root.className = paperTitle
    ? "llm-agent-hitl-paper-block"
    : "llm-agent-hitl-paper-block llm-agent-hitl-paper-block--plain";

  if (paperTitle) {
    const header = doc.createElement("div");
    header.className = "llm-agent-hitl-paper-title";
    const titleSpan = doc.createElement("span");
    titleSpan.className = "llm-agent-hitl-paper-title-text";
    titleSpan.textContent = paperTitle;
    titleSpan.setAttribute("title", paperTitle);
    header.appendChild(titleSpan);
    if (
      meta?.paperTotal &&
      meta.paperTotal > 1 &&
      typeof meta.paperIndex === "number"
    ) {
      const badge = doc.createElement("span");
      badge.className = "llm-agent-hitl-paper-title-index";
      badge.textContent = `${meta.paperIndex} / ${meta.paperTotal}`;
      header.appendChild(badge);
    }
    root.appendChild(header);
  }

  const list = doc.createElement("div");
  list.className = "llm-agent-hitl-review-list";
  root.appendChild(list);

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
    beforeCol.append(
      beforeLabel,
      renderReviewValueCell(doc, item.before || "", !!item.multiline, "before"),
    );

    const arrow = doc.createElement("div");
    arrow.className = "llm-agent-hitl-review-arrow";
    arrow.textContent = "\u2192";
    arrow.setAttribute("aria-hidden", "true");

    const afterCol = doc.createElement("div");
    afterCol.className = "llm-agent-hitl-review-column";
    const afterLabel = doc.createElement("div");
    afterLabel.className = "llm-agent-hitl-review-column-label";
    afterLabel.textContent = "After";
    afterCol.append(
      afterLabel,
      renderReviewValueCell(doc, item.after || "", !!item.multiline, "after"),
    );

    values.append(beforeCol, arrow, afterCol);
    row.append(values);
    list.appendChild(row);
  }

  return root;
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

      const lineNumber = doc.createElement("span");
      lineNumber.className = "llm-agent-hitl-diff-line-number";
      lineNumber.textContent =
        typeof line.oldLineNumber === "number"
          ? String(line.oldLineNumber)
          : typeof line.newLineNumber === "number"
            ? String(line.newLineNumber)
            : "";

      const marker = doc.createElement("span");
      marker.className = "llm-agent-hitl-diff-marker";
      marker.textContent =
        line.kind === "add" ? "+" : line.kind === "remove" ? "\u2212" : " ";

      gutter.append(lineNumber, marker);

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
    if (item.label) title.setAttribute("title", item.label);
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
    select.className =
      "llm-agent-hitl-page-input llm-agent-hitl-assignment-select";
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
    if (item.label) title.setAttribute("title", item.label);
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
        chipInputs.map((input) => input.value.trim()).filter(Boolean),
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
      isValid: () => getAssignments().some((entry) => entry.value.length > 0),
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
          const launch = (
            Zotero as unknown as { launchURL?: (url: string) => void }
          ).launchURL;
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
  requestId?: string,
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
  type FieldRow = (typeof field.rows)[number];
  type SortKey = "relevance" | "date" | "citations";

  const container = doc.createElement("div");
  container.className = "llm-search-results";

  // Resolve the mode list. Legacy cards without `modes` get a single implicit
  // mode built from the flat `rows`. In legacy mode, rows default to checked
  // unless explicitly `checked: false` (prior behavior); in multi-mode cards
  // the caller is expected to opt each row in with `checked: true`.
  const modes: Array<{
    id: string;
    label: string;
    rows: FieldRow[];
    emptyMessage?: string;
  }> = field.modes?.length
    ? field.modes.map((m) => ({
        id: m.id,
        label: m.label,
        rows: m.rows,
        emptyMessage: m.emptyMessage,
      }))
    : [
        {
          id: "__default__",
          label: "",
          rows: field.rows.map((r) => ({
            ...r,
            checked: r.checked !== false,
          })),
        },
      ];

  const defaultMode =
    modes.find((m) => m.id === field.defaultModeId) || modes[0];
  let activeModeId = defaultMode.id;
  const getActiveMode = () =>
    modes.find((m) => m.id === activeModeId) || modes[0];

  // Selection state survives mode switches. Seed with any row flagged
  // `checked: true` across all modes — callers opt in explicitly (e.g.
  // discoverRelated pre-checks only the recommendations mode's rows).
  const selectedIds = new Set<string>();
  for (const mode of modes) {
    for (const row of mode.rows) {
      if (row.checked === true) selectedIds.add(row.id);
    }
  }

  // Per-mode sort key (each mode remembers its own sort).
  const sortByMode = new Map<string, SortKey>();

  const listeners: Array<() => void> = [];
  const emitValidityChange = () => {
    for (const listener of listeners) listener();
  };

  // ── Mode toggle (only when the card exposes >1 mode) ────────────────────
  let modeTabsEl: HTMLDivElement | null = null;
  if (modes.length > 1) {
    modeTabsEl = doc.createElement("div");
    modeTabsEl.className = "llm-search-mode-tabs";
    for (const mode of modes) {
      const tab = doc.createElement("button");
      tab.type = "button";
      tab.className = "llm-search-mode-tab";
      tab.dataset.modeId = mode.id;
      tab.textContent = mode.label;
      if (mode.id === activeModeId)
        tab.classList.add("llm-search-mode-tab-active");
      tab.addEventListener("click", () => {
        if (activeModeId === mode.id) return;
        activeModeId = mode.id;
        renderActiveMode();
        syncModeTabs();
        emitValidityChange();
      });
      modeTabsEl.appendChild(tab);
    }
    container.appendChild(modeTabsEl);
  }
  const syncModeTabs = () => {
    if (!modeTabsEl) return;
    for (const tab of Array.from(modeTabsEl.children) as HTMLButtonElement[]) {
      tab.classList.toggle(
        "llm-search-mode-tab-active",
        tab.dataset.modeId === activeModeId,
      );
    }
  };

  // ── Toolbar (select-all checkbox on the left, sort group on the right) ──
  const toolbar = doc.createElement("div");
  toolbar.className = "llm-agent-hitl-checklist-toolbar";
  container.appendChild(toolbar);

  const selectAllLabel = doc.createElement("label");
  selectAllLabel.className = "llm-search-select-all";
  const selectAllCheckbox = doc.createElement("input");
  selectAllCheckbox.type = "checkbox";
  selectAllCheckbox.className = "llm-search-select-all-checkbox";
  const selectAllText = doc.createElement("span");
  selectAllText.className = "llm-search-select-all-text";
  selectAllText.textContent = "Select all";
  selectAllLabel.append(selectAllCheckbox, selectAllText);
  toolbar.appendChild(selectAllLabel);

  // Sort group — shown only when at least one mode has sortable data.
  const anyModeHasSortableData = modes.some((m) =>
    m.rows.some(
      (r) => typeof r.year === "number" || typeof r.citationCount === "number",
    ),
  );
  let sortGroupEl: HTMLSpanElement | null = null;
  const sortButtons: Record<string, HTMLButtonElement> = {};
  if (anyModeHasSortableData) {
    const sortSep = doc.createElement("span");
    sortSep.className = "llm-search-sort-separator";
    toolbar.appendChild(sortSep);

    sortGroupEl = doc.createElement("span");
    sortGroupEl.className = "llm-search-sort-group";

    const sortLabel = doc.createElement("span");
    sortLabel.className = "llm-search-sort-label";
    sortLabel.textContent = "Sort:";
    sortGroupEl.appendChild(sortLabel);

    for (const key of ["relevance", "date", "citations"] as SortKey[]) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "llm-search-sort-btn";
      btn.textContent =
        key === "relevance"
          ? "Relevance"
          : key === "date"
            ? "Date"
            : "Citations";
      btn.addEventListener("click", () => {
        sortByMode.set(activeModeId, key);
        renderActiveMode();
      });
      sortGroupEl.appendChild(btn);
      sortButtons[key] = btn;
    }
    toolbar.appendChild(sortGroupEl);
  }

  // ── List container (rows re-rendered when mode or sort changes) ─────────
  const list = doc.createElement("div");
  list.className = "llm-search-results-list";
  container.appendChild(list);

  const emptyState = doc.createElement("div");
  emptyState.className = "llm-search-results-empty";
  emptyState.style.display = "none";
  container.appendChild(emptyState);

  const rowCheckboxes: HTMLInputElement[] = [];

  const renderRow = (rowData: FieldRow): HTMLElement => {
    const row = doc.createElement("label");
    row.className = "llm-search-results-item";

    const checkboxWrap = doc.createElement("div");
    checkboxWrap.className = "llm-search-results-checkbox-wrap";
    const checkbox = doc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "llm-search-results-checkbox";
    checkbox.checked = selectedIds.has(rowData.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(rowData.id);
      else selectedIds.delete(rowData.id);
      syncSelectAllCheckbox();
      emitValidityChange();
    });
    checkboxWrap.appendChild(checkbox);
    row.appendChild(checkboxWrap);
    rowCheckboxes.push(checkbox);

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
          const launch = (
            Zotero as unknown as { launchURL?: (url: string) => void }
          ).launchURL;
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
    return row;
  };

  const syncSortButtonsActive = () => {
    const key = sortByMode.get(activeModeId) || "relevance";
    for (const [k, btn] of Object.entries(sortButtons)) {
      btn.classList.toggle("llm-search-sort-active", k === key);
    }
  };

  const syncSelectAllCheckbox = () => {
    const rows = getActiveMode().rows;
    if (!rows.length) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
      return;
    }
    const selectedCount = rows.filter((r) => selectedIds.has(r.id)).length;
    if (selectedCount === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else if (selectedCount === rows.length) {
      selectAllCheckbox.checked = true;
      selectAllCheckbox.indeterminate = false;
    } else {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = true;
    }
  };

  selectAllCheckbox.addEventListener("change", () => {
    const rows = getActiveMode().rows;
    if (selectAllCheckbox.checked) {
      for (const r of rows) selectedIds.add(r.id);
    } else {
      for (const r of rows) selectedIds.delete(r.id);
    }
    // Update visible checkboxes to match.
    for (let i = 0; i < rowCheckboxes.length; i += 1) {
      rowCheckboxes[i].checked = selectedIds.has(rows[i].id);
    }
    selectAllCheckbox.indeterminate = false;
    emitValidityChange();
  });

  const renderActiveMode = () => {
    const mode = getActiveMode();
    list.replaceChildren();
    rowCheckboxes.length = 0;

    // Sort a copy so the original arrays aren't mutated.
    const key = sortByMode.get(mode.id) || "relevance";
    const rowsForRender = mode.rows.slice();
    if (key === "date") {
      rowsForRender.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (key === "citations") {
      rowsForRender.sort(
        (a, b) => (b.citationCount || 0) - (a.citationCount || 0),
      );
    }
    // Keep the mode.rows array (used by the select-all logic) in the same
    // order so checkbox index aligns with getActiveMode().rows[i].
    mode.rows = rowsForRender;

    if (!rowsForRender.length) {
      emptyState.style.display = "";
      emptyState.textContent =
        mode.emptyMessage || "No results available for this mode.";
      selectAllCheckbox.disabled = true;
    } else {
      emptyState.style.display = "none";
      selectAllCheckbox.disabled = false;
      for (const rowData of rowsForRender) {
        list.appendChild(renderRow(rowData));
      }
    }
    syncSortButtonsActive();
    syncSelectAllCheckbox();
  };

  // Initial paint.
  renderActiveMode();

  // ── Load more button (optional) ────────────────────────────────────────
  let loadMoreButton: HTMLButtonElement | null = null;
  if (field.loadMoreActionId && requestId) {
    const loadMoreWrap = doc.createElement("div");
    loadMoreWrap.className = "llm-search-load-more-wrap";
    loadMoreButton = doc.createElement("button");
    loadMoreButton.type = "button";
    loadMoreButton.className = "llm-search-load-more-btn";
    loadMoreButton.textContent = field.loadMoreLabel || "Load more";
    loadMoreButton.addEventListener("click", () => {
      if (!loadMoreButton) return;
      loadMoreButton.disabled = true;
      loadMoreButton.textContent = "Loading…";
      // Resolve the current confirmation with the load_more actionId.
      // The action will re-fetch with a larger limit and re-invoke
      // requestConfirmation — producing a fresh card with the expanded
      // result set and the prior selections preserved (via the data
      // payload below).
      getAgentRuntime().resolveConfirmation(requestId, {
        approved: true,
        actionId: field.loadMoreActionId as string,
        data: {
          [field.id]: Array.from(selectedIds),
          __activeModeId__: activeModeId,
        },
      });
    });
    loadMoreWrap.appendChild(loadMoreButton);
    container.appendChild(loadMoreWrap);
  }

  const getSelectedIds = () => Array.from(selectedIds);

  return {
    element: container,
    accessor: {
      id: field.id,
      getValue: () => getSelectedIds(),
      setDisabled: (disabled) => {
        for (const checkbox of rowCheckboxes) checkbox.disabled = disabled;
        selectAllCheckbox.disabled = disabled;
        if (modeTabsEl) {
          for (const tab of Array.from(
            modeTabsEl.children,
          ) as HTMLButtonElement[]) {
            tab.disabled = disabled;
          }
        }
        if (sortGroupEl) {
          for (const btn of Object.values(sortButtons)) btn.disabled = disabled;
        }
        if (loadMoreButton) loadMoreButton.disabled = disabled;
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
    action.cancelActionId &&
    provided.some((entry) => entry.id === action.cancelActionId)
      ? action.cancelActionId
      : provided.find((entry) => entry.id === "cancel")?.id ||
        provided[provided.length - 1]?.id;
  const primaryActions = provided.filter(
    (entry) => entry.id !== cancelActionId,
  );
  const defaultActionId =
    action.defaultActionId &&
    primaryActions.some((entry) => entry.id === action.defaultActionId)
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

function getPendingActionButton(action: AgentPendingAction, actionId: string) {
  return (
    normalizePendingActions(action).actions.find(
      (entry) => entry.id === actionId,
    ) || null
  );
}

function isPagedReviewAction(action: AgentPendingAction): boolean {
  if (action.mode !== "review" || !Array.isArray(action.actions)) return false;
  const actionIds = new Set(action.actions.map((entry) => entry.id));
  return (
    actionIds.has("confirm") &&
    actionIds.has("cancel") &&
    (actionIds.has("previous") ||
      actionIds.has("next") ||
      actionIds.has("refresh")) &&
    action.fields.some(
      (field) =>
        field.type === "select" &&
        (field.id === "pageSize" || field.id === "tagsPerPaper"),
    )
  );
}

function getPagedActionPageLabel(title: string): string {
  return title.match(/\bPage\s+\d+\s+of\s+\d+\b/i)?.[0] || "";
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
      !field.visibleForActionIds?.length ||
      field.visibleForActionIds.includes(actionId);
    const requiredForAction =
      field.requiredForActionIds?.includes(actionId) || false;
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
  return (
    !field.visibleForActionIds?.length ||
    field.visibleForActionIds.includes(actionId)
  );
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
    field.minSelectedByAction?.find((entry) => entry.actionId === actionId)
      ?.min || 0
  );
}

export function renderPendingActionCard(
  doc: Document,
  pending: { requestId: string; action: AgentPendingAction },
): HTMLDivElement {
  const card = doc.createElement("div");
  card.className = "llm-agent-hitl-card";
  card.dataset.requestId = pending.requestId;
  const normalizedActions = normalizePendingActions(pending.action);
  const isPagedReviewCard = isPagedReviewAction(pending.action);
  if (isPagedReviewCard) {
    card.dataset.pagedReview = "true";
  }

  const header = doc.createElement("div");
  header.className = "llm-agent-hitl-header";
  header.textContent =
    pending.action.mode === "review" && !isPagedReviewCard
      ? "Review required"
      : "Action required";
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

  const pagedTopControls = isPagedReviewCard ? doc.createElement("div") : null;
  if (pagedTopControls) {
    pagedTopControls.className = "llm-agent-hitl-paged-top-controls";
    card.appendChild(pagedTopControls);
  }
  const pagedFooterCenterControls = isPagedReviewCard
    ? doc.createElement("div")
    : null;
  if (pagedFooterCenterControls) {
    pagedFooterCenterControls.className =
      "llm-agent-hitl-paged-footer-controls";
  }
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

  // Count review_table fields up front so each can render its "x of N" badge.
  const reviewTableFields = pending.action.fields.filter(
    (f): f is Extract<AgentPendingField, { type: "review_table" }> =>
      f.type === "review_table",
  );
  const reviewTableTotal = reviewTableFields.length;
  let reviewTableIndex = 0;

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

    if (field.type === "code_preview") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      label.textContent = field.label;
      fieldContainer.appendChild(label);

      const pre = doc.createElement("pre");
      pre.className = "llm-agent-hitl-code-preview";
      const code = doc.createElement("code");
      if (field.language) {
        code.className = `language-${field.language}`;
        code.setAttribute("data-language", field.language);
      }
      code.textContent = field.value;
      pre.appendChild(code);
      fieldContainer.appendChild(pre);
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

    if (field.type === "select") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      const isPagedPageSizeField = isPagedReviewCard && field.id === "pageSize";
      const isPagedTagsField = isPagedReviewCard && field.id === "tagsPerPaper";
      const isPagedInlineSelect = isPagedPageSizeField || isPagedTagsField;
      if (isPagedPageSizeField) {
        label.textContent = "items on this page";
        label.title = field.label;
      } else if (isPagedTagsField) {
        label.textContent = "of tags per paper";
        label.title = field.label;
      } else {
        label.textContent = field.label;
      }

      const select = doc.createElement("select");
      select.className = "llm-agent-hitl-page-input";
      for (const option of field.options) {
        const optionEl = doc.createElement("option");
        optionEl.value = option.id;
        optionEl.textContent = option.label;
        select.appendChild(optionEl);
      }
      select.value = field.value || field.options[0]?.id || "";
      if (isPagedInlineSelect) {
        fieldContainer.append(select, label);
      } else {
        fieldContainer.append(label, select);
      }
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
      if (
        isPagedReviewCard &&
        field.id === "tagsPerPaper" &&
        pagedTopControls
      ) {
        fieldContainer.className += " llm-agent-hitl-paged-top-field";
        pagedTopControls.appendChild(fieldContainer);
      } else if (
        isPagedReviewCard &&
        field.id === "pageSize" &&
        pagedFooterCenterControls
      ) {
        fieldContainer.className += " llm-agent-hitl-paged-footer-field";
        pagedFooterCenterControls.appendChild(fieldContainer);
      } else {
        card.appendChild(fieldContainer);
      }
      continue;
    }

    if (field.type === "review_table") {
      reviewTableIndex += 1;
      fieldContainer.appendChild(
        renderReviewTableField(doc, field, {
          paperTitle: field.label,
          paperIndex: reviewTableIndex,
          paperTotal: reviewTableTotal,
        }),
      );
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
      if (field.label) {
        const label = doc.createElement("label");
        label.className = "llm-agent-hitl-label";
        label.textContent = field.label;
        fieldContainer.appendChild(label);
      }
      const rendered = renderPaperResultListField(
        doc,
        field,
        pending.requestId,
      );
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
    fieldAccessors.every((accessor) =>
      isAccessorValidForAction(accessor, actionId),
    );
  const getActionById = (actionId: string) =>
    normalizedActions.actions.find((entry) => entry.id === actionId) || null;
  const actionNeedsSeparateSubmit = (actionId: string) =>
    getPendingActionExecutionMode(pending.action, actionId) === "edit";
  const getSeparateSubmitLabel = (actionId: string) => {
    const actionButton = getActionById(actionId);
    return (
      actionButton?.submitLabel ||
      actionButton?.label ||
      pending.action.confirmLabel ||
      "Apply"
    );
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
  const executeAction = (actionId = activeActionId) => {
    activeActionId = actionId;
    setButtonsDisabled(true);
    const payload = Object.fromEntries(
      fieldAccessors.map((accessor) => [accessor.id, accessor.getValue()]),
    );
    const activeAction = getActionById(actionId);
    getAgentRuntime().resolveConfirmation(pending.requestId, {
      approved:
        activeAction?.approved ?? actionId !== normalizedActions.cancelActionId,
      actionId,
      data: payload,
    });
  };
  const handleExecute = () => {
    executeAction(activeActionId);
  };
  let lastChooserActionId =
    normalizedActions.primaryActions.find(
      (action) => !actionNeedsSeparateSubmit(action.id),
    )?.id || normalizedActions.defaultActionId;
  let actionChooser: HTMLDivElement | null = null;
  if (buttonLayout.hasActionChooser && !isPagedReviewCard) {
    actionChooser = doc.createElement("div");
    actionChooser.className = "llm-agent-hitl-action-choices";
    for (const action of normalizedActions.primaryActions) {
      const actionButton = doc.createElement("button");
      actionButton.type = "button";
      actionButton.dataset.actionChoice = action.id;
      actionButton.dataset.primary =
        action.style === "primary" ? "true" : "false";
      actionButton.className =
        action.id === activeActionId
          ? "llm-agent-hitl-btn llm-agent-hitl-btn-active"
          : action.style === "primary"
            ? "llm-agent-hitl-btn"
            : "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
      actionButton.textContent = action.label;
      actionButton.addEventListener("click", () => {
        const nextActionNeedsSeparateSubmit = actionNeedsSeparateSubmit(
          action.id,
        );
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
      return (
        selectedCount >= getPaperResultMinSelection(accessor.field, actionId)
      );
    }
    return accessor.isValid();
  };
  const syncActionUi = () => {
    const isSeparateSubmitMode =
      buttonLayout.hasActionChooser &&
      actionNeedsSeparateSubmit(activeActionId);
    for (const accessor of fieldAccessors) {
      accessor.container.hidden = !isFieldVisibleForAction(
        accessor.field,
        activeActionId,
      );
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
  if (!isPagedReviewCard && buttonLayout.showsFooterExecuteButton) {
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

  if (!isPagedReviewCard && buttonLayout.hasActionChooser) {
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

  const createPendingActionButton = (
    actionId: string,
    className: string,
  ): HTMLButtonElement | null => {
    const action = getActionById(actionId);
    if (!action) return null;
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.actionId = actionId;
    button.className = className;
    button.textContent = action.label;
    button.addEventListener("click", () => {
      executeAction(actionId);
    });
    buttons.push(button);
    return button;
  };

  if (isPagedReviewCard) {
    const refreshButton = createPendingActionButton(
      "refresh",
      "llm-agent-hitl-refresh-btn",
    );
    if (refreshButton) {
      refreshButton.textContent = "";
      refreshButton.title = getActionById("refresh")?.label || "Refresh";
      refreshButton.setAttribute("aria-label", refreshButton.title);
      card.appendChild(refreshButton);
    }

    const pagedActions = doc.createElement("div");
    pagedActions.className = "llm-agent-hitl-paged-actions";

    const left = doc.createElement("div");
    left.className =
      "llm-agent-hitl-paged-actions-slot llm-agent-hitl-paged-actions-left";
    const previousButton = createPendingActionButton(
      "previous",
      "llm-agent-hitl-btn llm-agent-hitl-btn-secondary llm-agent-hitl-paged-nav-btn llm-agent-hitl-paged-previous-btn",
    );
    if (previousButton) left.appendChild(previousButton);

    const center = doc.createElement("div");
    center.className =
      "llm-agent-hitl-paged-actions-slot llm-agent-hitl-paged-actions-center";
    const confirmButton = createPendingActionButton(
      "confirm",
      "llm-agent-hitl-btn llm-agent-hitl-paged-confirm-btn",
    );
    if (confirmButton) center.appendChild(confirmButton);
    const pageLabel = getPagedActionPageLabel(pending.action.title);
    if (pageLabel) {
      const pageIndicator = doc.createElement("span");
      pageIndicator.className = "llm-agent-hitl-page-indicator";
      pageIndicator.textContent = pageLabel;
      center.appendChild(pageIndicator);
    }
    if (pagedFooterCenterControls?.children.length) {
      center.appendChild(pagedFooterCenterControls);
    }
    const cancelButton = createPendingActionButton(
      "cancel",
      "llm-agent-hitl-btn llm-agent-hitl-btn-secondary llm-agent-hitl-paged-cancel-btn",
    );
    if (cancelButton) center.appendChild(cancelButton);

    const right = doc.createElement("div");
    right.className =
      "llm-agent-hitl-paged-actions-slot llm-agent-hitl-paged-actions-right";
    const nextButton = createPendingActionButton(
      "next",
      "llm-agent-hitl-btn llm-agent-hitl-paged-nav-btn llm-agent-hitl-paged-next-btn",
    );
    if (nextButton) right.appendChild(nextButton);

    pagedActions.append(left, center, right);
    card.appendChild(pagedActions);
  }

  if (!isPagedReviewCard && normalizedActions.cancelAction) {
    const cancelButton = doc.createElement("button");
    cancelButton.type = "button";
    cancelButton.dataset.kind = "cancel";
    cancelButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
    cancelButton.textContent =
      normalizedActions.cancelAction.label ||
      pending.action.cancelLabel ||
      "Cancel";
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
  if (!isPagedReviewCard && actionRow.children.length > 0) {
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
    const details = paperContexts
      .map((entry, index) =>
        normalizeAgentTraceDetail(
          paperContexts.length === 1 ? "Paper" : `Paper ${index + 1}`,
          entry.title,
        ),
      )
      .filter((entry): entry is AgentTraceDetail => Boolean(entry));
    chips.push({
      iconName: "paper",
      label:
        paperContexts.length === 1 ? "Paper" : `${paperContexts.length} papers`,
      title: paperContexts.map((entry) => entry.title).join("\n"),
      details,
    });
  }

  const selectedTexts = getMessageSelectedTexts(userMessage);
  if (selectedTexts.length) {
    const sources = normalizeSelectedTextSources(
      userMessage.selectedTextSources,
      selectedTexts.length,
    );
    const source = sources[0] || "pdf";
    const details = selectedTexts
      .map((entry, index) =>
        normalizeAgentTraceDetail(
          selectedTexts.length === 1
            ? "Selected text"
            : `Selected text ${index + 1}`,
          entry,
        ),
      )
      .filter((entry): entry is AgentTraceDetail => Boolean(entry));
    chips.push({
      ...(source === "note-edit"
        ? { icon: NOTE_EDIT_PENCIL_ICON }
        : { iconName: getSelectedTextSourceIconName(source) }),
      label:
        selectedTexts.length === 1
          ? "Selected text"
          : `${selectedTexts.length} text selections`,
      title: selectedTexts.join("\n\n"),
      details,
    });
  }

  const screenshotCount = Array.isArray(userMessage.screenshotImages)
    ? userMessage.screenshotImages.filter(Boolean).length
    : 0;
  if (screenshotCount > 0) {
    chips.push({
      iconName: "image",
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
    const details = fileAttachments
      .map((entry, index) =>
        normalizeAgentTraceDetail(
          fileAttachments.length === 1 ? "File" : `File ${index + 1}`,
          entry.name,
        ),
      )
      .filter((entry): entry is AgentTraceDetail => Boolean(entry));
    chips.push({
      iconName: "file",
      label:
        fileAttachments.length === 1
          ? "File"
          : `${fileAttachments.length} files`,
      title: fileAttachments.map((entry) => entry.name).join("\n"),
      details,
    });
  }

  return chips;
}

function buildAgentTraceRequestSummary(
  userMessage: Message | null | undefined,
): AgentTraceRequestSummary {
  const selectedTexts = userMessage ? getMessageSelectedTexts(userMessage) : [];
  const paperTitles = userMessage
    ? normalizePaperContexts(userMessage.paperContexts).map(
        (entry) => entry.title,
      )
    : [];
  const attachments = userMessage?.attachments;
  const screenshotImages = userMessage?.screenshotImages;
  const fileNames = Array.isArray(attachments)
    ? attachments
        .filter((entry) => entry && entry.category !== "image")
        .map((entry) => entry.name)
    : [];
  const screenshotCount = Array.isArray(screenshotImages)
    ? screenshotImages.filter(Boolean).length
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
      iconName: "paper",
      label: "Paper",
      title: paperTitle,
      detail: normalizeAgentTraceDetail("Paper", paperTitle) || undefined,
    });
  }

  const query = readAgentTraceText(record?.query);
  if (query) {
    chips.push({
      icon: "⌕",
      label: "Query",
      title: query,
      detail: normalizeAgentTraceDetail("Query", query) || undefined,
    });
  }

  const url = readAgentTraceText(record?.url);
  if (url) {
    chips.push({
      icon: "↗",
      label: "URL",
      title: url,
      detail: normalizeAgentTraceDetail("URL", url, "url") || undefined,
    });
  }

  const pattern = readAgentTraceText(record?.pattern);
  if (pattern) {
    chips.push({
      icon: "⌕",
      label: "Pattern",
      title: pattern,
      detail: normalizeAgentTraceDetail("Pattern", pattern) || undefined,
    });
  }

  const attachmentName = readAgentTraceText(record?.name);
  if (attachmentName) {
    chips.push({
      iconName: /\.pdf$/i.test(attachmentName) ? "pdf" : "file",
      label: "File",
      title: attachmentName,
      detail: normalizeAgentTraceDetail("File", attachmentName) || undefined,
    });
  }

  const status = readAgentTraceText(record?.status);
  if (status) {
    chips.push({
      icon: "•",
      label: "Status",
      title: `status: ${status}`,
      detail: normalizeAgentTraceDetail("Status", status) || undefined,
    });
  }

  const saved =
    readAgentTraceText(record?.saved) || readAgentTraceText(record?.savedPath);
  if (saved) {
    chips.push({
      iconName: "image",
      label: "Saved",
      title: saved,
      detail: normalizeAgentTraceDetail("Saved", saved) || undefined,
    });
  }

  const path = !saved ? readAgentTraceText(record?.path) : null;
  if (path) {
    chips.push({
      iconName: "image",
      label: "Path",
      title: path,
      detail: normalizeAgentTraceDetail("Path", path) || undefined,
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
          : compactAgentTraceText(entry),
      )
      .join(", ");
    if (labels) {
      chips.push({
        icon: "§",
        label: "Pages",
        title: labels,
        detail: normalizeAgentTraceDetail("Pages", labels) || undefined,
      });
    }
  }

  if (!chips.length && toolName === "get_active_context") {
    return buildAgentTraceRequestChips(userMessage);
  }

  return chips;
}

function detailLabelFromChip(chip: AgentTraceChip): string {
  const label = compactAgentTraceText(chip.label);
  if (!label) return "Detail";
  const colonIndex = label.indexOf(":");
  if (colonIndex > 0 && colonIndex <= 24) {
    return label.slice(0, colonIndex).trim() || "Detail";
  }
  return label.length <= 48 ? label : "Detail";
}

export function buildAgentTraceChipDetails(
  chip: AgentTraceChip,
): AgentTraceDetail[] {
  const explicit = [
    ...(chip.detail ? [chip.detail] : []),
    ...(Array.isArray(chip.details) ? chip.details : []),
  ]
    .map((entry) =>
      normalizeAgentTraceDetail(entry.label, entry.value, entry.kind || "text"),
    )
    .filter((entry): entry is AgentTraceDetail => Boolean(entry));
  if (explicit.length) return explicit;

  const title =
    typeof chip.title === "string" ? sanitizeText(chip.title).trim() : "";
  if (title) {
    const detail = normalizeAgentTraceDetail(
      detailLabelFromChip(chip),
      title,
      /^https?:\/\//i.test(title) ? "url" : "text",
    );
    return detail ? [detail] : [];
  }

  const label = compactAgentTraceText(chip.label);
  if (label.length > 40) {
    const detail = normalizeAgentTraceDetail(detailLabelFromChip(chip), label);
    return detail ? [detail] : [];
  }
  return [];
}

function dedupeAgentTraceDetails(
  details: AgentTraceDetail[],
): AgentTraceDetail[] {
  const seen = new Set<string>();
  const unique: AgentTraceDetail[] = [];
  for (const detail of details) {
    const normalized = normalizeAgentTraceDetail(
      detail.label,
      detail.value,
      detail.kind || "text",
    );
    if (!normalized) continue;
    const key = `${normalized.label}\u0000${normalized.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function buildAgentTraceActionDetails(
  item: Extract<AgentTraceDisplayItem, { type: "action" }>,
): AgentTraceDetail[] {
  const details: AgentTraceDetail[] = [];
  for (const chip of item.chips || []) {
    details.push(...buildAgentTraceChipDetails(chip));
  }
  if (item.row.codeBlock) {
    pushTraceDetail(details, "Command", item.row.codeBlock, "code");
  }
  if (item.details?.length) {
    details.push(...item.details);
  }
  return dedupeAgentTraceDetails(details);
}

const FILE_IO_TRACE_ACTION_FIELDS = ["action", "mode", "operation", "op"];
const FILE_IO_TRACE_PATH_FIELDS = ["filePath", "path", "file_path", "filepath"];

function redactContentLikeTraceArgs(value: unknown, key = ""): unknown {
  if (isContentLikeToolArgumentKey(key)) {
    if (typeof value === "string") {
      return `[redacted ${value.length} chars]`;
    }
    if (Array.isArray(value)) {
      return `[redacted ${value.length} entries]`;
    }
    if (isAgentTraceRecord(value)) {
      return "[redacted object]";
    }
    return value == null ? value : "[redacted value]";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactContentLikeTraceArgs(entry));
  }
  if (!isAgentTraceRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    out[entryKey] = redactContentLikeTraceArgs(entryValue, entryKey);
  }
  return out;
}

function readFirstTraceStringField(
  args: Record<string, unknown>,
  fields: readonly string[],
): { field: string; value: string } | null {
  for (const field of fields) {
    const value = args[field];
    if (typeof value === "string" && value.trim()) {
      return { field, value };
    }
  }
  return null;
}

function buildAgentTraceArgsDetails(
  toolName: string | undefined,
  args: unknown,
): AgentTraceDetail[] {
  const details: AgentTraceDetail[] = [];
  const record = isAgentTraceRecord(args) ? args : null;
  if (record) {
    if (toolName === "file_io") {
      const keys = Object.keys(record);
      pushTraceDetail(details, "Argument keys", keys.join(", "));
      const action = readFirstTraceStringField(
        record,
        FILE_IO_TRACE_ACTION_FIELDS,
      );
      if (action) {
        pushTraceDetail(
          details,
          `Action field (${action.field})`,
          action.value,
        );
      }
      const path = readFirstTraceStringField(record, FILE_IO_TRACE_PATH_FIELDS);
      if (path) {
        pushTraceDetail(details, `Path field (${path.field})`, path.value);
      }
    }
    if (isMalformedToolArgumentsDiagnostic(record)) {
      pushTraceDetail(details, "Malformed input", record.rawPreview, "code");
    }
  }

  const detail = buildJsonTraceDetail(
    "Arguments",
    redactContentLikeTraceArgs(args),
  );
  if (detail) details.push(detail);
  return dedupeAgentTraceDetails(details);
}

function readTraceStringField(
  args: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = args[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function buildFileIoTraceCodeBlock(
  args: Record<string, unknown>,
): string | undefined {
  const filePath = readTraceStringField(args, [
    "filePath",
    "path",
    "file_path",
    "filepath",
  ]);
  if (!filePath) return undefined;
  const action =
    readTraceStringField(args, ["action", "mode", "operation", "op"]) ||
    "access";
  return `${action} ${filePath}`;
}

function summarizeAgentTraceToolCall(
  name: string,
  args: unknown,
  request?: AgentTraceRequestSummary,
  resultInfo?: ToolResultTraceInfo,
): AgentTraceSummaryRow {
  const label = toolLabelFromName(name);
  const a =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const skillName =
    name === "Skill" && typeof a.skill === "string" && a.skill.trim()
      ? a.skill.trim()
      : null;
  const skillSource =
    name === "Skill" && typeof a.source === "string" ? a.source.trim() : "";
  const skillVerb =
    skillSource === "codex-native-slash" ? "Invoked Skill" : "Using Skill";
  const fallbackFileIoSummary =
    name === "file_io" ? summarizeFileIOCall(args) : null;
  const text =
    resolveToolPresentationSummary(
      getToolDefinition(name)?.presentation?.summaries?.onCall,
      { label, args, request },
    ) ||
    fallbackFileIoSummary ||
    (skillName ? `${skillVerb}: ${skillName}` : `Using ${label}`);
  const displayText =
    resultInfo?.rowSuffix && text === `Using ${label}`
      ? `${text} ${resultInfo.rowSuffix}`
      : text;

  // Show code block for shell commands and file I/O
  let codeBlock: string | undefined;
  if (name === "run_command" && typeof a.command === "string") {
    codeBlock = a.command;
  } else if (name === "file_io") {
    codeBlock = buildFileIoTraceCodeBlock(a);
  }

  return {
    kind: "tool",
    icon: "→",
    // For file_io, use the descriptive onCall text (e.g. "Reading paper section")
    // instead of the generic label. For other tools (run_command), keep label.
    text: codeBlock && name !== "file_io" ? label : displayText,
    codeBlock,
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
    const value = record[key];
    if (Array.isArray(value)) {
      return value.length === 0;
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
      ) || `Could not complete ${label}: ${rawError || "Tool failed"}`;
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
    (isEmpty ? `No results from ${label}` : "");
  if (!text) {
    return null;
  }
  return {
    kind: isEmpty ? "skip" : "ok",
    icon: isEmpty ? "-" : "✓",
    text,
  };
}

function summarizeCodexToolActivity(input: {
  phase: "started" | "completed";
  toolName?: string;
  toolLabel?: string;
  serverName?: string;
  text?: string;
  codeBlock?: string;
}): AgentTraceSummaryRow {
  const explicitText = readAgentTraceText(input.text);
  if (explicitText) {
    return {
      kind: "tool",
      icon: "⌘",
      text: explicitText,
      codeBlock: readAgentTraceText(input.codeBlock) || undefined,
    };
  }
  const toolName = readAgentTraceText(input.toolName);
  const label =
    readAgentTraceText(input.toolLabel) ||
    (toolName ? toolLabelFromName(toolName) : "") ||
    "Zotero MCP tool";
  const verb = input.phase === "completed" ? "Used" : "Using";
  return {
    kind: "tool",
    icon: "⌘",
    text: `${verb} ${label}`,
    codeBlock: readAgentTraceText(input.codeBlock) || undefined,
  };
}

function isGenericAgentStatusText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "running agent" ||
    /^continuing agent \(\d+\/\d+\)$/.test(normalized)
  );
}

function isHiddenClaudeStartupStatus(text: string): boolean {
  return (
    text === "Checking the request against the attached context." ||
    text === "Request and attached context received" ||
    text === "Reused previous context" ||
    text === "Detected updated context" ||
    text === "Initializing Claude session" ||
    text === "Rebuilding Claude session after runtime change" ||
    text ===
      "Session signature mismatch detected. Retrying with a fresh Claude session." ||
    text ===
      "Claude runtime changed. Rebuilding this conversation on the new runtime while keeping local context." ||
    /^Claude bridge URL:/i.test(text) ||
    text === "Claude bridge URL is empty. Falling back to local runtime."
  );
}

function buildInitialAgentMessage(requestChips: AgentTraceChip[]): string {
  return requestChips.length
    ? "Checking the request against the attached context."
    : "Checking the current request and Zotero context.";
}

function hasInterleavedTextAndTools(
  events: AgentRunEventRecord[],
  options: { preserveRolledBackText?: boolean } = {},
): boolean {
  let visibleDraftLength = 0;
  for (const entry of events) {
    if (entry.payload.type === "message_delta") {
      visibleDraftLength += (entry.payload.text || "").length;
      continue;
    }
    if (
      entry.payload.type === "message_rollback" &&
      !options.preserveRolledBackText
    ) {
      const rollbackLength =
        typeof entry.payload.length === "number" && entry.payload.length > 0
          ? entry.payload.length
          : (entry.payload.text || "").length;
      visibleDraftLength = Math.max(0, visibleDraftLength - rollbackLength);
      continue;
    }
    if (entry.payload.type === "tool_call" && visibleDraftLength > 0) {
      return true;
    }
  }
  return false;
}

function replaceInlineTextDedupeKey(
  visibleInlineText: Set<string>,
  previousText: string,
  nextText: string,
): void {
  const previousKey = normalizeInlineTextForDedupe(previousText);
  if (previousKey) visibleInlineText.delete(previousKey);
  const nextKey = normalizeInlineTextForDedupe(nextText);
  if (nextKey) visibleInlineText.add(nextKey);
}

function appendInterleavedInlineText(
  items: AgentTraceDisplayItem[],
  rawText: string,
  visibleInlineText: Set<string>,
): void {
  const chunk = sanitizeText(rawText || "");
  if (!chunk) return;

  const lastItem = items[items.length - 1];
  if (lastItem?.type === "inline_text") {
    if (!chunk.trim()) {
      lastItem.text += chunk;
      return;
    }

    const previousText = lastItem.text;
    const previousKey = normalizeInlineTextForDedupe(previousText);
    const chunkKey = normalizeInlineTextForDedupe(chunk);
    const chunkLooksLikeReplay = !/^\s/.test(chunk);

    if (!chunkKey) return;
    if (
      chunkLooksLikeReplay &&
      (chunkKey === previousKey || previousKey.endsWith(chunkKey))
    ) {
      return;
    }

    if (
      chunkLooksLikeReplay &&
      previousKey &&
      chunkKey.startsWith(previousKey)
    ) {
      const nextText = chunk.trim();
      lastItem.text = nextText;
      replaceInlineTextDedupeKey(visibleInlineText, previousText, nextText);
      return;
    }

    const nextText = `${previousText}${chunk}`;
    lastItem.text = nextText;
    replaceInlineTextDedupeKey(visibleInlineText, previousText, nextText);
    return;
  }

  const text = chunk.trim();
  if (!text) return;
  const dedupeKey = normalizeInlineTextForDedupe(text);
  if (!dedupeKey || visibleInlineText.has(dedupeKey)) return;
  visibleInlineText.add(dedupeKey);
  items.push({ type: "inline_text", text });
}

function getFinalTraceText(events: AgentRunEventRecord[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (entry?.payload.type === "final") {
      return sanitizeText(entry.payload.text || "").trim();
    }
  }
  return "";
}

function shouldSuppressInlineFinalAnswer(
  item: AgentTraceDisplayItem,
  finalText: string,
): boolean {
  if (item.type !== "inline_text") return false;
  const finalKey = normalizeInlineTextForDedupe(finalText);
  const itemKey = normalizeInlineTextForDedupe(item.text);
  return Boolean(finalKey && itemKey && finalKey === itemKey);
}

type AgentTraceAdapterContext = {
  items: AgentTraceDisplayItem[];
  isCodexTrace: boolean;
  isInterleaved: boolean;
  requestSummary: AgentTraceRequestSummary;
  userMessage: Message | null | undefined;
  pendingActions: Map<string, AgentPendingAction>;
  toolResultsByCallId: Map<
    string,
    Extract<AgentRunEventRecord["payload"], { type: "tool_result" }>
  >;
  announcedWriting: boolean;
  lastMeaningfulStatus: string | null;
  reasoningLabels: Map<string, string>;
  reasoningStepCounter: number;
  fallbackReasoningStep: number;
  visibleInlineText: Set<string>;
};

function appendReasoningTraceItem(
  ctx: AgentTraceAdapterContext,
  payload: Extract<AgentRunEventRecord["payload"], { type: "reasoning" }>,
): void {
  const text =
    readAgentTraceText(payload.details) ||
    readAgentTraceText(payload.summary) ||
    undefined;
  if (!text) return;
  const hasExplicitStepId = Boolean(
    typeof payload.stepId === "string" && payload.stepId.trim(),
  );
  const reasoningKey = hasExplicitStepId
    ? getReasoningTraceKey(payload)
    : `step:${ctx.fallbackReasoningStep}`;
  let existing: Extract<AgentTraceDisplayItem, { type: "reasoning" }> | null =
    null;
  for (let itemIndex = ctx.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const candidate = ctx.items[itemIndex];
    if (candidate.type === "reasoning" && candidate.key === reasoningKey) {
      existing = candidate;
      break;
    }
  }
  if (existing && existing.type === "reasoning") {
    const prev = existing.summary || "";
    if (!prev.includes(text)) {
      existing.summary = appendAgentTraceText(existing.summary, text);
    }
    return;
  }

  let label = readAgentTraceText(payload.stepLabel) || "";
  if (!label) {
    label = ctx.reasoningLabels.get(reasoningKey) || "";
  }
  if (!label) {
    if (hasExplicitStepId) {
      ctx.reasoningStepCounter += 1;
      label = ctx.isCodexTrace
        ? `Codex reasoning ${ctx.reasoningStepCounter}`
        : `Thinking for step ${ctx.reasoningStepCounter}`;
    } else {
      label = ctx.isCodexTrace ? "Codex reasoning" : "Thinking";
    }
    ctx.reasoningLabels.set(reasoningKey, label);
  }
  ctx.items.push({
    type: "reasoning",
    key: reasoningKey,
    label,
    summary: text,
    details: undefined,
  });
}

function appendLegacyAgentTraceEvent(
  ctx: AgentTraceAdapterContext,
  entry: AgentRunEventRecord,
): boolean {
  switch (entry.payload.type) {
    case "status": {
      const statusText = readAgentTraceText(entry.payload.text);
      if (
        !statusText ||
        isGenericAgentStatusText(statusText) ||
        statusText === ctx.lastMeaningfulStatus
      ) {
        return true;
      }
      const isSessionStartStatus =
        statusText === "Running SessionStart:resume" ||
        statusText === "Finished SessionStart:resume" ||
        statusText === "Running SessionStart:startup" ||
        statusText === "Finished SessionStart:startup";
      if (
        isSessionStartStatus ||
        statusText === "Compacting context…" ||
        isHiddenClaudeStartupStatus(statusText)
      ) {
        return true;
      }
      ctx.lastMeaningfulStatus = statusText;
      ctx.items.push({
        type: "action",
        row: {
          kind: "plan",
          icon: "…",
          text: statusText,
        },
      });
      return true;
    }
    case "tool_call": {
      const resultInfo = buildToolResultTraceInfo(
        entry.payload.name,
        ctx.toolResultsByCallId.get(entry.payload.callId),
      );
      const details = [
        ...buildAgentTraceArgsDetails(entry.payload.name, entry.payload.args),
        ...(resultInfo?.details || []),
      ];
      ctx.items.push({
        type: "action",
        row: summarizeAgentTraceToolCall(
          entry.payload.name,
          entry.payload.args,
          ctx.requestSummary,
          resultInfo || undefined,
        ),
        chips: buildAgentTraceToolChips(
          entry.payload.name,
          entry.payload.args,
          ctx.userMessage,
        ),
        details: dedupeAgentTraceDetails(details),
        detailKey: `tool-call:${entry.payload.callId}`,
      });
      ctx.fallbackReasoningStep += 1;
      return true;
    }
    case "reasoning":
      appendReasoningTraceItem(ctx, entry.payload);
      return true;
    case "tool_result": {
      const row = summarizeAgentTraceToolResult(
        entry.payload.name,
        entry.payload.ok,
        entry.payload.content,
        ctx.requestSummary,
      );
      if (row) {
        ctx.items.push({
          type: "action",
          row,
        });
        if (entry.payload.ok) {
          try {
            const cards =
              getToolDefinition(
                entry.payload.name,
              )?.presentation?.buildResultCards?.(entry.payload.content) ??
              null;
            if (cards && cards.length > 0) {
              ctx.items.push({ type: "card_list", cards });
            }
          } catch {
            // card generation errors must not crash the trace
          }
        }
      }
      return true;
    }
    case "message_delta":
      if (ctx.isInterleaved) {
        appendInterleavedInlineText(
          ctx.items,
          entry.payload.text || "",
          ctx.visibleInlineText,
        );
      } else if (!ctx.announcedWriting) {
        ctx.announcedWriting = true;
        ctx.items.push({
          type: "action",
          row: {
            kind: "plan",
            icon: NOTE_EDIT_PENCIL_ICON,
            text: "Drafting answer",
          },
        });
      }
      return true;
    case "message_rollback":
      ctx.announcedWriting = false;
      return true;
    default:
      return false;
  }
}

function appendCodexAgentTraceEvent(
  ctx: AgentTraceAdapterContext,
  entry: AgentRunEventRecord,
): boolean {
  switch (entry.payload.type) {
    case "codex_tool_activity": {
      const toolName = readAgentTraceText(entry.payload.toolName) || undefined;
      const details = [
        ...(entry.payload.codeBlock
          ? [
              normalizeAgentTraceDetail(
                "Command",
                entry.payload.codeBlock,
                "code",
              ),
            ]
          : []),
        ...buildAgentTraceArgsDetails(toolName, entry.payload.args),
      ].filter((detail): detail is AgentTraceDetail => Boolean(detail));
      ctx.items.push({
        type: "action",
        row: summarizeCodexToolActivity({
          phase: entry.payload.phase,
          toolName,
          toolLabel: entry.payload.toolLabel,
          serverName: entry.payload.serverName,
          text: entry.payload.text,
          codeBlock: entry.payload.codeBlock,
        }),
        chips: toolName
          ? buildAgentTraceToolChips(
              toolName,
              entry.payload.args,
              ctx.userMessage,
            )
          : undefined,
        details,
        detailKey: `codex:${entry.payload.itemId}`,
      });
      return true;
    }
    case "codex_progress": {
      const progressText = readAgentTraceText(entry.payload.text);
      if (progressText) {
        ctx.items.push({
          type: "message",
          tone: "neutral",
          text: progressText,
          markdown: true,
        });
      }
      return true;
    }
    default:
      return false;
  }
}

function appendSharedAgentTraceEvent(
  ctx: AgentTraceAdapterContext,
  entry: AgentRunEventRecord,
): boolean {
  switch (entry.payload.type) {
    case "confirmation_required":
      ctx.pendingActions.set(entry.payload.requestId, entry.payload.action);
      ctx.items.push({
        type: "action",
        row: summarizeAgentTraceConfirmationRequest(
          entry.payload.action,
          ctx.requestSummary,
        ),
      });
      return true;
    case "confirmation_resolved": {
      const action = ctx.pendingActions.get(entry.payload.requestId) || {
        toolName: "action",
        title: "Action",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      };
      ctx.pendingActions.delete(entry.payload.requestId);
      ctx.items.push({
        type: "action",
        row: summarizeAgentTraceConfirmationResolved(
          action,
          entry.payload.approved,
          entry.payload.actionId,
          ctx.requestSummary,
        ),
      });
      return true;
    }
    case "final": {
      const alreadyCompleted = ctx.items.some(
        (item) => item.type === "action" && item.row.kind === "done",
      );
      if (!alreadyCompleted) {
        ctx.items.push({
          type: "action",
          row: {
            kind: "done",
            icon: "✓",
            text: "Response ready",
          },
        });
      }
      return true;
    }
    case "fallback":
      ctx.items.push({
        type: "message",
        tone: "warning",
        text: entry.payload.reason,
      });
      return true;
    default:
      return false;
  }
}

export function buildAgentTraceDisplayItems(
  events: AgentRunEventRecord[],
  userMessage: Message | null | undefined,
  assistantMessage?: Message | null,
): {
  items: AgentTraceDisplayItem[];
  isInterleaved: boolean;
  inlineTextReplacesAssistantText: boolean;
} {
  const items: AgentTraceDisplayItem[] = [];
  const isCodexTrace = assistantMessage?.modelProviderLabel === "Codex";
  const isAgentTrace = assistantMessage?.runMode === "agent";
  const compactedEvents = compactAgentTraceEvents(events);
  const toolResultsByCallId = new Map<
    string,
    Extract<AgentRunEventRecord["payload"], { type: "tool_result" }>
  >();
  for (const entry of compactedEvents) {
    if (entry.payload.type === "tool_result") {
      toolResultsByCallId.set(entry.payload.callId, entry.payload);
    }
  }
  const isInterleaved = hasInterleavedTextAndTools(events, {
    preserveRolledBackText: isCodexTrace || isAgentTrace,
  });
  const requestChips = buildAgentTraceRequestChips(userMessage);
  const requestSummary = buildAgentTraceRequestSummary(userMessage);
  const adapterContext: AgentTraceAdapterContext = {
    items,
    isCodexTrace,
    isInterleaved,
    requestSummary,
    userMessage,
    pendingActions: new Map<string, AgentPendingAction>(),
    toolResultsByCallId,
    announcedWriting: false,
    lastMeaningfulStatus: null,
    reasoningLabels: new Map<string, string>(),
    reasoningStepCounter: 0,
    fallbackReasoningStep: 1,
    visibleInlineText: new Set<string>(),
  };

  items.push({
    type: "message",
    tone: "neutral",
    text: isCodexTrace
      ? "Request sent to Codex."
      : buildInitialAgentMessage(requestChips),
  });
  items.push({
    type: "action",
    row: {
      kind: "plan",
      icon: "↳",
      text: isCodexTrace
        ? "Codex received the request"
        : requestChips.length
          ? "Request and attached context received"
          : "Request received",
    },
    chips: requestChips,
    detailKey: "request",
  });

  for (let index = 0; index < compactedEvents.length; index += 1) {
    const entry = compactedEvents[index];
    if (appendCodexAgentTraceEvent(adapterContext, entry)) continue;
    if (appendLegacyAgentTraceEvent(adapterContext, entry)) continue;
    appendSharedAgentTraceEvent(adapterContext, entry);
  }

  const finalText = getFinalTraceText(compactedEvents);
  const displayItems = finalText
    ? items.filter((item) => !shouldSuppressInlineFinalAnswer(item, finalText))
    : items;
  const inlineTextReplacesAssistantText = isInterleaved && !finalText;

  return {
    items: displayItems,
    isInterleaved,
    inlineTextReplacesAssistantText,
  };
}

function renderAgentTraceChips(
  doc: Document,
  chips: AgentTraceChip[] | undefined,
): HTMLDivElement | null {
  if (!chips?.length) return null;
  const chipsEl = doc.createElement("div") as HTMLDivElement;
  chipsEl.className = "llm-agent-process-chips";
  for (const chip of chips) {
    const chipEl = doc.createElement("div") as HTMLDivElement;
    chipEl.className = "llm-agent-process-chip";
    if (chip.title) {
      chipEl.title = chip.title;
    }
    const chipLabel = doc.createElement("span") as HTMLSpanElement;
    chipLabel.className = "llm-agent-process-chip-label";
    chipLabel.textContent = chip.label;
    const chipIcon = isContextIconName(chip.iconName)
      ? createContextIcon(doc, chip.iconName, "llm-agent-process-chip-icon")
      : null;
    if (chipIcon) {
      chipEl.append(chipIcon, chipLabel);
    } else if (chip.icon) {
      const fallbackIcon = doc.createElement("span") as HTMLSpanElement;
      fallbackIcon.className = "llm-agent-process-chip-icon";
      fallbackIcon.textContent = chip.icon;
      chipEl.append(fallbackIcon, chipLabel);
    } else {
      chipEl.appendChild(chipLabel);
    }
    chipsEl.appendChild(chipEl);
  }
  return chipsEl;
}

function renderAgentTraceDetailsBody(
  doc: Document,
  details: AgentTraceDetail[],
): HTMLDivElement {
  const body = doc.createElement("div") as HTMLDivElement;
  body.className = "llm-agent-process-details";
  for (const detail of details) {
    const item = doc.createElement("div") as HTMLDivElement;
    item.className = "llm-agent-process-detail";

    const label = doc.createElement("div") as HTMLDivElement;
    label.className = "llm-agent-process-detail-label";
    label.textContent = detail.label;

    if (detail.kind === "code" || detail.kind === "json") {
      const pre = doc.createElement("pre") as HTMLPreElement;
      pre.className = `llm-agent-process-detail-value llm-agent-process-detail-value-${detail.kind}`;
      const code = doc.createElement("code") as HTMLElement;
      code.textContent = detail.value;
      pre.appendChild(code);
      item.append(label, pre);
    } else {
      const value = doc.createElement("div") as HTMLDivElement;
      value.className = `llm-agent-process-detail-value${
        detail.kind === "url" ? " llm-agent-process-detail-value-url" : ""
      }`;
      value.textContent = detail.value;
      item.append(label, value);
    }

    body.appendChild(item);
  }
  return body;
}

export function renderAgentTrace({
  doc,
  message,
  userMessage,
  events,
  onTraceMissing,
  onInterleavedText,
}: RenderAgentTraceParams): HTMLElement | null {
  const runId = message.agentRunId?.trim() || "pending";
  if (
    !events.length &&
    !message.pendingAgentTraceEvents?.length &&
    !onTraceMissing
  ) {
    return null;
  }
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
    loadingIcon.textContent = "…";
    const loadingText = doc.createElement("span");
    loadingText.className = "llm-at-text llm-at-plan-text";
    loadingText.textContent = "Loading agent activity...";
    loadingRow.append(loadingIcon, loadingText);
    list.appendChild(loadingRow);
    wrap.appendChild(list);
    return wrap;
  }
  const {
    items: processItems,
    isInterleaved,
    inlineTextReplacesAssistantText,
  } = buildAgentTraceDisplayItems(events, userMessage, message);
  if (inlineTextReplacesAssistantText) {
    onInterleavedText?.();
  }
  const pending = getPendingConfirmation(events);
  if (pending) {
    wrap.classList.add("llm-agent-activity-with-pending-action");
  }
  const hasFinalResponse = events.some(
    (entry) => entry.payload.type === "final",
  );
  for (const [itemIndex, itemEntry] of processItems.entries()) {
    if (itemEntry.type === "inline_text") {
      const inlineEl = doc.createElement("div");
      inlineEl.className = "llm-agent-inline-text";
      const inlineText = buildAgentTraceMarkdownForRender(
        itemEntry.text,
        message,
      );
      try {
        renderRenderedMarkdownInto(inlineEl, inlineText, doc);
      } catch {
        inlineEl.textContent = inlineText;
      }
      list.appendChild(inlineEl);
      continue;
    }

    if (itemEntry.type === "message") {
      const messageEl = doc.createElement("div");
      messageEl.className = `llm-agent-process-message llm-agent-process-message-${itemEntry.tone}`;
      if (itemEntry.markdown) {
        messageEl.classList.add("llm-agent-process-message-markdown");
        const markdownText = buildAgentTraceMarkdownForRender(
          itemEntry.text,
          message,
        );
        try {
          renderRenderedMarkdownInto(messageEl, markdownText, doc);
        } catch {
          messageEl.textContent = markdownText;
        }
      } else {
        messageEl.textContent = itemEntry.text;
      }
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
      let reasoningToggleHandled = false;
      const toggleReasoning = (event: Event) => {
        if (reasoningToggleHandled) return;
        reasoningToggleHandled = true;
        event.preventDefault();
        event.stopPropagation();
        const next = !details.open;
        details.open = next;
        agentReasoningExpandedCache.set(expansionKey, next);
        doc.defaultView?.setTimeout(() => {
          reasoningToggleHandled = false;
        }, 0);
      };
      summary.addEventListener("pointerdown", toggleReasoning);
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

      // Show only summary — details from most models duplicate the summary
      const reasoningText = itemEntry.summary || itemEntry.details;
      if (reasoningText) {
        const summaryBlock = doc.createElement("div") as HTMLDivElement;
        summaryBlock.className = "llm-agent-reasoning-block";
        const text = doc.createElement("div") as HTMLDivElement;
        text.className = "llm-agent-reasoning-text";
        text.textContent = reasoningText;
        summaryBlock.appendChild(text);
        bodyWrap.appendChild(summaryBlock);
      }

      // Details section removed — most models duplicate summary in details

      details.appendChild(bodyWrap);
      list.appendChild(details);
      continue;
    }

    const actionDetails = buildAgentTraceActionDetails(itemEntry);
    const isExpandable = actionDetails.length > 0;
    const actionWrap = doc.createElement(
      isExpandable ? "details" : "div",
    ) as HTMLElement;
    actionWrap.className = `llm-agent-process-action${
      isExpandable ? " llm-agent-process-action-expandable" : ""
    }`;
    const expansionKey = `${runId}:action:${itemEntry.detailKey || itemIndex}`;
    if (isExpandable) {
      (actionWrap as HTMLDetailsElement).open = Boolean(
        agentTraceActionExpandedCache.get(expansionKey),
      );
    }
    const row = doc.createElement("div");
    row.className = `llm-at-row llm-at-row-${itemEntry.row.kind}`;
    const icon = doc.createElement("span");
    icon.className = "llm-at-icon";
    icon.textContent = itemEntry.row.icon;
    const text = doc.createElement("span");
    text.className = `llm-at-text llm-at-${itemEntry.row.kind}-text`;
    text.textContent = itemEntry.row.text;
    if (isExpandable) {
      row.append(icon, text);

      const summary = doc.createElement("summary") as HTMLElement;
      summary.className = "llm-agent-process-action-summary";
      summary.appendChild(row);
      const chips = renderAgentTraceChips(doc, itemEntry.chips);
      if (chips) summary.appendChild(chips);
      actionWrap.appendChild(summary);
      actionWrap.appendChild(renderAgentTraceDetailsBody(doc, actionDetails));
      actionWrap.addEventListener("toggle", () => {
        const open = Boolean((actionWrap as HTMLDetailsElement).open);
        agentTraceActionExpandedCache.set(expansionKey, open);
      });
    } else {
      row.append(icon, text);
      actionWrap.appendChild(row);
      const chips = renderAgentTraceChips(doc, itemEntry.chips);
      if (chips) {
        actionWrap.appendChild(chips);
      }
    }

    list.appendChild(actionWrap);
  }
  wrap.appendChild(list);

  if (hasFinalResponse && !isInterleaved) {
    const divider = doc.createElement("div");
    divider.className = "llm-agent-output-divider";
    divider.setAttribute("aria-hidden", "true");
    wrap.appendChild(divider);
  }

  if (pending) {
    const pendingShell = doc.createElement("div");
    pendingShell.className = "llm-agent-pending-action-shell";
    pendingShell.appendChild(renderPendingActionCard(doc, pending));
    wrap.appendChild(pendingShell);
  }

  return wrap;
}
