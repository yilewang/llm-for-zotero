import type {
  AgentNoteChangeResultCard,
  AgentSavedNoteResultCard,
} from "../../../agent/types";
import { projectPaperReferences } from "../../../shared/paperDisplayLabels";
import { getAgentRuntime } from "../../../agent";
import {
  exportPlanDocumentMarkdown,
  savePlanDocumentAsNote,
} from "../../../agent/documents/actions";
import {
  loadPlanDocument,
  loadPlanDocumentOutbox,
} from "../../../agent/documents/store";
import type { PlanDocument } from "../../../agent/documents/types";
import { planExecutionCoordinator } from "../../../agent/plans/coordinator";
import {
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../../../agent/plans/store";
import {
  isContentLikeToolArgumentKey,
  isMalformedToolArgumentsDiagnostic,
} from "../../../agent/toolArgumentDiagnostics";
import { summarizeFileIOCall } from "../../../agent/tools/write/fileIO";
import type {
  AgentActionContract,
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentPendingChoiceValue,
  AgentPendingField,
  AgentRunEventRecord,
  AgentToolArtifact,
  AgentToolEffect,
  AgentToolPresentationSummary,
  AgentToolResultCard,
  AgentTraceChip,
  AgentTraceDetail,
  AgentTraceRequestSummary,
  PlanArtifact,
  PlanExecutionLedger,
} from "../../../agent/types";
import { getConversationWriteGeneration } from "../../../shared/conversationWriteFence";
import type { GeneratedChatImage } from "../../../shared/types";
import { toFileUrl } from "../../../utils/pathFileUrl";
import { normalizePublicWebUrl } from "../../../webAccess/tavilyClient";
import { agentReasoningExpandedCache } from "../agentState";
import { copyTextToClipboard } from "../clipboard";
import {
  createContextIcon,
  getSelectedTextSourceIconName,
  isContextIconName,
  NOTE_EDIT_PENCIL_ICON,
} from "../contextIcons";
import { createDocumentCardLayout } from "../documentCard";
import { renderAssistantGeneratedImagesInto } from "../generatedImageRender";
import {
  normalizePaperContextRefs,
  normalizeSelectedTextSources,
} from "../normalizers";
import {
  planDocumentCitationSourceHref as citationSourceHref,
  getPlanDocumentItemTitle as itemTitle,
  navigatePlanDocumentCitationSource,
  renderPlanDocumentContent,
  renderPlanDocumentFigures,
} from "../planDocumentPresentation";
import {
  PLAN_APPROVED_EVENT,
  PLAN_CANCEL_EVENT,
  PLAN_REVISE_EVENT,
  stageApprovedPlanExecution,
} from "../planModeState";
import { buildAssistantDisplayMarkdownForRender } from "../assistantRichText";
import { renderRenderedMarkdownInto } from "../renderedMarkdown";
import { applyStableAnimationPhase } from "../stableAnimationPhase";
import { showStandaloneConfirmationDialog } from "../standaloneConfirmationDialog";
import { openStandalonePlanDocumentWindow } from "../standalonePlanDocumentWindow";
import {
  disposeStreamingMarkdown,
  renderStreamingMarkdownInto,
} from "../streamingMarkdown";
import { sanitizeText } from "../textUtils";
import type { Message, PaperContextRef } from "../types";
import { createWebFaviconImage } from "../webFavicon";
import { renderDiffPreviewField } from "./diffPreviewField";
import { getDiscoveryCardProjection } from "./discoveryCardProjection";
import { renderNoteChangeCard } from "./noteChangeCard";
import { getNoteReviewContent, renderNoteReviewCard } from "./noteReviewCard";
import {
  renderSavedNoteCard,
  savedNoteIsPrimaryOutcome,
} from "./savedNoteCard";
import {
  buildToolResultTraceInfo,
  type ToolResultTraceInfo,
} from "./toolResultTraceInfo";
import {
  appendAgentTraceText,
  compactAgentTraceEvents,
  getReasoningTraceKey,
  normalizeInlineTextForDedupe,
} from "./traceReducer";

type AgentTraceSummaryKind = "plan" | "tool" | "ok" | "skip" | "done";

const INTERNAL_PLAN_TOOL_NAMES = new Set([
  "update_plan",
  "amend_plan",
  "task_update",
  "request_user_input",
  "submit_plan_document",
  "submit_document",
  "research_update",
  "approve_research_expansion",
  "approve_research_mutation",
]);

type AgentTraceSummaryRow = {
  kind: AgentTraceSummaryKind;
  icon: string;
  iconName?: "library" | "web";
  text: string;
  /** Optional code block shown below the summary text (e.g. shell commands). */
  codeBlock?: string;
};

const agentTraceActionExpandedCache = new Map<string, boolean>();
const agentActivityExpandedCache = new WeakMap<
  Message,
  { open: boolean; wasWorking: boolean }
>();

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
      type: "image_grid";
      images: GeneratedChatImage[];
    }
  | {
      type: "reasoning";
      key: string;
      logicalKey: string;
      label: string;
      summary?: string;
      details?: string;
    }
  | { type: "inline_text"; text: string };

type RenderAgentTraceParams = {
  doc: Document;
  panelItem?: Zotero.Item;
  message: Message;
  userMessage?: Message | null;
  events: AgentRunEventRecord[];
  previous?: HTMLElement;
  allowPlanRecovery?: boolean;
  onTraceMissing?: () => void;
  onInterleavedText?: () => void;
};

export function formatAgentActivityDuration(durationMs: number): string {
  const totalSeconds = Math.max(
    1,
    Math.round((Number.isFinite(durationMs) ? durationMs : 0) / 1000),
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    `${seconds}s`,
  ]
    .filter(Boolean)
    .join(" ");
}

function resolveAgentActivityDurationMs(
  message: Message,
  userMessage: Message | null | undefined,
  events: AgentRunEventRecord[],
): number {
  const eventTimes = events
    .map((event) => Number(event.createdAt))
    .filter((value) => Number.isFinite(value) && value > 0);
  const waitingStartedAt = Number(message.waitingAnimationStartedAt);
  const userStartedAt = Number(userMessage?.timestamp);
  const messageTimestamp = Number(message.timestamp);
  const start =
    (Number.isFinite(waitingStartedAt) && waitingStartedAt > 0
      ? waitingStartedAt
      : 0) ||
    (eventTimes.length ? Math.min(...eventTimes) : 0) ||
    (Number.isFinite(userStartedAt) && userStartedAt > 0 ? userStartedAt : 0) ||
    (Number.isFinite(messageTimestamp) && messageTimestamp > 0
      ? messageTimestamp
      : Date.now());
  const end = message.streaming
    ? Date.now()
    : Math.max(
        start,
        Number.isFinite(messageTimestamp) && messageTimestamp > 0
          ? messageTimestamp
          : 0,
        ...eventTimes,
      );
  return Math.max(0, end - start);
}

function appendAgentActivityDisclosure(params: {
  doc: Document;
  wrap: HTMLElement;
  list: HTMLElement;
  message: Message;
  userMessage?: Message | null;
  events: AgentRunEventRecord[];
  forceOpen?: boolean;
}): void {
  const { doc, wrap, list, message, userMessage, events } = params;
  const working = message.streaming === true;
  const planPhase = resolveTracePlanPhase(events);
  const previous = agentActivityExpandedCache.get(message);
  const state = working
    ? !previous || !previous.wasWorking
      ? { open: true, wasWorking: true }
      : previous
    : previous?.wasWorking
      ? { open: false, wasWorking: false }
      : previous || { open: false, wasWorking: false };
  agentActivityExpandedCache.set(message, state);

  const mounted = wrap.querySelector?.<HTMLDetailsElement>(
    ".llm-agent-activity-details",
  );
  const details =
    mounted || (doc.createElement("details") as HTMLDetailsElement);
  details.className = "llm-agent-activity-details";
  details.open = params.forceOpen === true || state.open;

  const summary =
    details.querySelector?.("summary") || doc.createElement("summary");
  summary.className = "llm-agent-activity-summary";
  const duration = formatAgentActivityDuration(
    resolveAgentActivityDurationMs(message, userMessage, events),
  );
  summary.textContent = working
    ? planPhase === "planning"
      ? "Planning…"
      : planPhase === "executing"
        ? "Executing plan…"
        : "Working…"
    : planPhase === "planning"
      ? `Planned in ${duration}`
      : planPhase === "executing"
        ? `Plan ran for ${duration}`
        : `Worked for ${duration}`;
  if (mounted) return;
  details.append(summary, list);
  details.addEventListener("toggle", () => {
    agentActivityExpandedCache.set(message, {
      open: details.open,
      wasWorking: message.streaming === true,
    });
  });
  wrap.appendChild(details);
}

function resolveTracePlanPhase(
  events: readonly AgentRunEventRecord[],
): "planning" | "executing" | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (payload?.type === "plan_execution_updated") return "executing";
    if (payload?.type === "plan_ready" || payload?.type === "plan_updated") {
      return "planning";
    }
    if (payload?.type === "status") {
      const text = payload.text.trim().toLowerCase();
      if (text.startsWith("executing the approved plan")) return "executing";
      if (text.startsWith("planning the request")) return "planning";
    }
  }
  return null;
}

export function buildAgentTraceMarkdownForRender(
  text: string,
  message?: Pick<
    Message,
    "text" | "quoteCitations" | "quoteDisplayOverride" | "streaming"
  > | null,
): string {
  const useDisplayOverride =
    Boolean(message?.quoteDisplayOverride) &&
    sanitizeText(text || "") === sanitizeText(message?.text || "");
  const display = useDisplayOverride
    ? message!.quoteDisplayOverride!
    : {
        markdown: text,
        quoteCitations:
          message?.quoteDisplayOverride?.quoteCitations ||
          message?.quoteCitations,
      };
  return buildAssistantDisplayMarkdownForRender({
    text: display.markdown || text || "",
    quoteCitations: display.quoteCitations,
    streaming: message?.streaming,
  });
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
  wrap.className =
    "llm-agent-hitl-assignment-table llm-agent-hitl-tag-assignment-table";

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
      input.setAttribute("aria-label", `Tag for ${item.label}`);
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
      removeButton.setAttribute("aria-label", "Remove tag");
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
  cards: Exclude<AgentToolResultCard, { kind: "saved_note" | "note_change" }>[],
): HTMLDivElement {
  const container = doc.createElement("div");
  container.className =
    "llm-agent-hitl-card llm-plan-container llm-search-results llm-search-results-readonly";

  const { header } = createDocumentCardLayout(doc, {
    title: `${cards.length} paper${cards.length === 1 ? "" : "s"} found online`,
    status: "Results",
    statusKind: "completed",
  });
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
      // Submit the current selection once; expansion is a read-only
      // continuation, independent of the import button.
      const card = container.closest(".llm-agent-hitl-card");
      if (card)
        for (const control of Array.from(
          card.querySelectorAll("input,button,select,textarea"),
        ) as HTMLInputElement[])
          control.disabled = true;
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
    field.type === "choice" ||
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
    // Every non-navigation confirmation now resolves through one explicit
    // footer CTA. Selecting an alternative promotes it to that CTA instead
    // of executing it from the chooser.
    showsFooterExecuteButton: normalizedActions.primaryActions.length > 0,
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

function isPlanningQuestionAction(action: AgentPendingAction): boolean {
  return (
    action.toolName === "request_user_input" &&
    action.mode === "review" &&
    action.fields.length > 0 &&
    action.fields.every((field) => field.type === "choice")
  );
}

const PLANNING_QUESTION_AUTO_ADVANCE_MS = 480;
const PLANNING_QUESTION_TRANSITION_MS = 360;

function renderPlanningQuestionCard(
  doc: Document,
  pending: { requestId: string; action: AgentPendingAction },
  resolveConfirmation: (
    requestId: string,
    resolution: AgentConfirmationResolution,
  ) => void,
): HTMLDivElement {
  const fields = pending.action.fields.filter(
    (field): field is Extract<AgentPendingField, { type: "choice" }> =>
      field.type === "choice",
  );
  const normalizedActions = normalizePendingActions(pending.action);
  const card = doc.createElement("div");
  card.className =
    "llm-agent-hitl-card llm-plan-container llm-planning-question-card";
  card.dataset.requestId = pending.requestId;
  card.dataset.planningQuestionCard = "true";

  const content = doc.createElement("div");
  content.className = "llm-agent-hitl-content llm-planning-question-content";
  card.appendChild(content);

  const { header } = createDocumentCardLayout(doc, {
    title: pending.action.title,
    status: "Your input",
    statusKind: "awaiting_approval",
  });
  content.appendChild(header);

  const viewport = doc.createElement("div");
  viewport.className = "llm-planning-question-viewport";
  viewport.setAttribute("aria-live", "polite");
  const track = doc.createElement("div");
  track.className = "llm-planning-question-track";
  viewport.appendChild(track);
  content.appendChild(viewport);

  const answers = new Map<string, AgentPendingChoiceValue>();
  const customTexts = new Map<string, string>();
  for (const field of fields) {
    if (field.value?.kind === "option") {
      answers.set(field.id, { ...field.value });
    } else if (field.value?.kind === "custom" && field.value.text.trim()) {
      const text = field.value.text.trim();
      answers.set(field.id, { kind: "custom", text });
      customTexts.set(field.id, text);
    }
  }

  type QuestionPanel = {
    element: HTMLDivElement;
    prompt: HTMLDivElement;
    optionButtons: HTMLButtonElement[];
    customInput: HTMLInputElement | null;
  };
  const panels: QuestionPanel[] = [];
  const allButtons: HTMLButtonElement[] = [];
  let activeIndex = 0;
  let mountedAllPanels = false;
  let advanceTimer: ReturnType<typeof setTimeout> | null = null;
  let counterTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const hasAnswer = (index: number) => answers.has(fields[index].id);
  const clearAdvanceTimer = () => {
    if (advanceTimer) clearTimeout(advanceTimer);
    advanceTimer = null;
  };

  const createQuestionPanel = (
    field: (typeof fields)[number],
    questionIndex: number,
  ): QuestionPanel => {
    const panel = doc.createElement("div");
    panel.className = "llm-planning-question-panel";
    panel.dataset.questionIndex = `${questionIndex}`;

    const prompt = doc.createElement("div");
    prompt.className = "llm-planning-question-prompt";
    prompt.textContent = field.label;
    prompt.tabIndex = -1;
    panel.appendChild(prompt);

    const options = doc.createElement("div");
    options.className = "llm-planning-question-options";
    options.setAttribute("role", "radiogroup");
    options.setAttribute("aria-label", field.label);
    const optionButtons: HTMLButtonElement[] = [];
    let customInput: HTMLInputElement | null = null;
    let customRow: HTMLLabelElement | null = null;

    const syncSelection = () => {
      const answer = answers.get(field.id);
      for (const button of optionButtons) {
        const selected =
          answer?.kind === "option" &&
          answer.optionId === button.dataset.optionId;
        button.classList.toggle(
          "llm-planning-question-option-selected",
          selected,
        );
        button.setAttribute("aria-checked", selected ? "true" : "false");
      }
      if (customInput && answer?.kind !== "custom") {
        customInput.value = customTexts.get(field.id) || "";
      }
      customRow?.classList.toggle(
        "llm-planning-question-custom-selected",
        answer?.kind === "custom",
      );
    };

    for (const option of field.options) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "llm-planning-question-option";
      button.dataset.optionId = option.id;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", "false");

      const marker = doc.createElement("span");
      marker.className = "llm-planning-question-option-marker";
      marker.setAttribute("aria-hidden", "true");
      const markerDot = doc.createElement("span");
      markerDot.className = "llm-planning-question-option-marker-dot";
      marker.appendChild(markerDot);

      const copy = doc.createElement("span");
      copy.className = "llm-planning-question-option-copy";
      const label = doc.createElement("span");
      label.className = "llm-planning-question-option-label";
      label.textContent = option.label;
      copy.appendChild(label);
      if (option.description) {
        const description = doc.createElement("span");
        description.className = "llm-planning-question-option-description";
        description.textContent = option.description;
        copy.appendChild(description);
      }
      button.append(marker, copy);
      button.addEventListener("click", () => {
        answers.set(field.id, { kind: "option", optionId: option.id });
        customTexts.delete(field.id);
        if (customInput) customInput.value = "";
        syncSelection();
        syncControls();
        clearAdvanceTimer();
        if (questionIndex < fields.length - 1) {
          advanceTimer = setTimeout(() => {
            if (activeIndex === questionIndex) showQuestion(questionIndex + 1);
          }, PLANNING_QUESTION_AUTO_ADVANCE_MS);
        }
      });
      optionButtons.push(button);
      allButtons.push(button);
      options.appendChild(button);
    }

    if (field.allowCustom) {
      customRow = doc.createElement("label");
      customRow.className = "llm-planning-question-custom";
      const customMarker = doc.createElement("span");
      customMarker.className = "llm-planning-question-custom-marker";
      customMarker.setAttribute("aria-hidden", "true");
      customInput = doc.createElement("input");
      customInput.type = "text";
      customInput.className = "llm-planning-question-custom-input";
      customInput.placeholder = field.customPlaceholder || "Something else…";
      customInput.setAttribute("aria-label", `${field.label}: custom answer`);
      customInput.value = customTexts.get(field.id) || "";
      customInput.addEventListener("input", () => {
        clearAdvanceTimer();
        const text = customInput?.value || "";
        if (text.trim()) {
          customTexts.set(field.id, text);
          answers.set(field.id, { kind: "custom", text: text.trim() });
        } else {
          customTexts.delete(field.id);
          answers.delete(field.id);
        }
        syncSelection();
        syncControls();
      });
      customInput.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" || !hasAnswer(questionIndex)) return;
        event.preventDefault();
        if (questionIndex < fields.length - 1) {
          showQuestion(questionIndex + 1);
        } else {
          submitAnswers();
        }
      });
      customRow.append(customMarker, customInput);
      options.appendChild(customRow);
    }
    panel.appendChild(options);
    panels.push({ element: panel, prompt, optionButtons, customInput });
    syncSelection();
    return panels[panels.length - 1];
  };

  for (const [index, field] of fields.entries()) {
    createQuestionPanel(field, index);
  }
  track.appendChild(panels[0].element);

  const footer = doc.createElement("div");
  footer.className = "llm-planning-question-footer";
  const navigation = doc.createElement("div");
  navigation.className = "llm-planning-question-navigation";
  const previousButton = doc.createElement("button");
  previousButton.type = "button";
  previousButton.className = "llm-planning-question-nav-btn";
  previousButton.title = "Previous question";
  previousButton.setAttribute("aria-label", previousButton.title);
  previousButton.textContent = "‹";
  const counter = doc.createElement("span");
  counter.className = "llm-planning-question-counter";
  counter.textContent = `1 / ${fields.length}`;
  const nextButton = doc.createElement("button");
  nextButton.type = "button";
  nextButton.className = "llm-planning-question-nav-btn";
  nextButton.title = "Next question";
  nextButton.setAttribute("aria-label", nextButton.title);
  nextButton.textContent = "›";
  navigation.append(previousButton, counter, nextButton);

  const actions = doc.createElement("div");
  actions.className = "llm-planning-question-actions";
  const cancelButton = doc.createElement("button");
  cancelButton.type = "button";
  cancelButton.className =
    "llm-agent-hitl-btn llm-agent-hitl-btn-secondary llm-planning-question-cancel";
  cancelButton.textContent =
    normalizedActions.cancelAction?.label ||
    pending.action.cancelLabel ||
    "Cancel plan";
  const continueButton = doc.createElement("button");
  continueButton.type = "button";
  continueButton.className =
    "llm-agent-hitl-btn llm-planning-question-continue";
  continueButton.textContent =
    getPendingActionButton(pending.action, normalizedActions.defaultActionId)
      ?.label ||
    pending.action.confirmLabel ||
    "Continue planning";
  actions.append(cancelButton, continueButton);
  footer.append(navigation, actions);
  card.appendChild(footer);
  allButtons.push(previousButton, nextButton, cancelButton, continueButton);

  const syncPanelState = () => {
    panels.forEach((panel, index) => {
      const active = index === activeIndex;
      panel.element.classList.toggle(
        "llm-planning-question-panel-active",
        active,
      );
      panel.element.setAttribute("aria-hidden", active ? "false" : "true");
      for (const button of panel.optionButtons) {
        button.tabIndex = active ? 0 : -1;
      }
      if (panel.customInput) panel.customInput.tabIndex = active ? 0 : -1;
    });
  };

  const layoutTrack = (animate: boolean) => {
    const activePanel = panels[activeIndex].element;
    const height = activePanel.offsetHeight || activePanel.scrollHeight;
    viewport.style.transition = animate
      ? `height ${PLANNING_QUESTION_TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
      : "none";
    track.style.transition = animate
      ? `transform ${PLANNING_QUESTION_TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
      : "none";
    if (height > 0) viewport.style.height = `${height}px`;
    track.style.transform = `translate3d(0, ${-activePanel.offsetTop}px, 0)`;
  };

  function syncControls(): void {
    previousButton.disabled = activeIndex === 0;
    nextButton.disabled =
      activeIndex >= fields.length - 1 || !hasAnswer(activeIndex);
    continueButton.disabled = !hasAnswer(activeIndex);
  }

  const rollCounter = (previousIndex: number) => {
    if (counterTimer) clearTimeout(counterTimer);
    counter.textContent = `${activeIndex + 1} / ${fields.length}`;
    counter.dataset.direction = activeIndex < previousIndex ? "back" : "next";
    counter.classList.remove("llm-planning-question-counter-rolling");
    void counter.offsetWidth;
    counter.classList.add("llm-planning-question-counter-rolling");
    counterTimer = setTimeout(() => {
      counter.classList.remove("llm-planning-question-counter-rolling");
    }, 320);
  };

  function showQuestion(nextIndex: number): void {
    const bounded = Math.min(Math.max(nextIndex, 0), fields.length - 1);
    if (bounded === activeIndex) return;
    if (bounded > activeIndex && !hasAnswer(activeIndex)) return;
    clearAdvanceTimer();
    const previousIndex = activeIndex;
    activeIndex = bounded;
    syncPanelState();
    syncControls();
    rollCounter(previousIndex);
    if (mountedAllPanels) {
      layoutTrack(true);
    } else {
      track.replaceChildren(panels[activeIndex].element);
      viewport.style.height = "auto";
    }
    const focus = () =>
      panels[activeIndex].prompt.focus({ preventScroll: true });
    const win = doc.defaultView;
    if (win?.requestAnimationFrame) win.requestAnimationFrame(focus);
    else focus();
  }

  function submitAnswers(): void {
    clearAdvanceTimer();
    if (!fields.every((_, index) => hasAnswer(index))) return;
    resizeObserver?.disconnect();
    for (const button of allButtons) button.disabled = true;
    for (const panel of panels) {
      if (panel.customInput) panel.customInput.disabled = true;
    }
    resolveConfirmation(pending.requestId, {
      approved: true,
      actionId: normalizedActions.defaultActionId,
      data: Object.fromEntries(
        fields.map((field) => [field.id, answers.get(field.id)]),
      ),
    });
  }

  previousButton.addEventListener("click", () => showQuestion(activeIndex - 1));
  nextButton.addEventListener("click", () => showQuestion(activeIndex + 1));
  continueButton.addEventListener("click", () => {
    if (activeIndex < fields.length - 1) showQuestion(activeIndex + 1);
    else submitAnswers();
  });
  cancelButton.addEventListener("click", () => {
    clearAdvanceTimer();
    resizeObserver?.disconnect();
    for (const button of allButtons) button.disabled = true;
    resolveConfirmation(pending.requestId, {
      approved: false,
      actionId: normalizedActions.cancelActionId,
    });
  });

  syncPanelState();
  syncControls();
  const win = doc.defaultView;
  if (win?.requestAnimationFrame) {
    win.requestAnimationFrame(() => {
      const initialHeight =
        panels[activeIndex].element.offsetHeight ||
        panels[activeIndex].element.scrollHeight;
      if (initialHeight > 0) viewport.style.height = `${initialHeight}px`;
      track.replaceChildren(...panels.map((panel) => panel.element));
      mountedAllPanels = true;
      syncPanelState();
      layoutTrack(false);
      // The viewport follows the active question when panel width or text size
      // changes. Observe content, not the viewport height that layoutTrack sets.
      if (win.ResizeObserver) {
        resizeObserver = new win.ResizeObserver(() => {
          if (!card.isConnected) {
            resizeObserver?.disconnect();
            return;
          }
          layoutTrack(false);
        });
        resizeObserver.observe(track);
      }
      card.dataset.questionStackReady = "true";
    });
  }

  return card;
}

export function renderPendingActionCard(
  doc: Document,
  pending: { requestId: string; action: AgentPendingAction },
  resolveConfirmation: (
    requestId: string,
    resolution: AgentConfirmationResolution,
  ) => void = (requestId, resolution) => {
    getAgentRuntime().resolveConfirmation(requestId, resolution);
  },
): HTMLDivElement {
  if (isPlanningQuestionAction(pending.action)) {
    return renderPlanningQuestionCard(doc, pending, resolveConfirmation);
  }
  const noteContent = getNoteReviewContent(pending.action);
  if (noteContent) {
    const actions = normalizePendingActions(pending.action);
    return renderNoteReviewCard({
      doc,
      pending,
      field: noteContent,
      confirmActionId: actions.defaultActionId,
      cancelActionId: actions.cancelActionId,
      resolve: (resolution) => {
        resolveConfirmation(pending.requestId, resolution);
      },
      renderChanges: (field) => renderDiffPreviewField(doc, field),
    });
  }
  const card = doc.createElement("div");
  card.className = "llm-agent-hitl-card llm-plan-container";
  card.dataset.requestId = pending.requestId;
  const normalizedActions = normalizePendingActions(pending.action);
  const isPagedReviewCard = isPagedReviewAction(pending.action);
  if (isPagedReviewCard) {
    card.dataset.pagedReview = "true";
  }

  const content = doc.createElement("div");
  content.className = "llm-agent-hitl-content";
  card.appendChild(content);

  const { header } = createDocumentCardLayout(doc, {
    title: pending.action.title,
    status: pending.action.selectionAction
      ? "Choose papers"
      : "Awaiting approval",
    statusKind: "awaiting_approval",
  });
  content.appendChild(header);

  if (pending.action.description) {
    const description = doc.createElement("div");
    description.className = "llm-agent-hitl-description";
    description.textContent = pending.action.description;
    content.appendChild(description);
  }

  const pagedTopControls = isPagedReviewCard ? doc.createElement("div") : null;
  if (pagedTopControls) {
    pagedTopControls.className = "llm-agent-hitl-paged-top-controls";
    content.appendChild(pagedTopControls);
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
      content.appendChild(fieldContainer);
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
      content.appendChild(fieldContainer);
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
      content.appendChild(fieldContainer);
      continue;
    }

    if (field.type === "select") {
      const label = doc.createElement("label");
      label.className = "llm-agent-hitl-label";
      const isPagedPageSizeField = isPagedReviewCard && field.id === "pageSize";
      const isPagedTagsField = isPagedReviewCard && field.id === "tagsPerPaper";
      if (isPagedPageSizeField) {
        label.textContent = "items on this page";
        label.title = field.label;
      } else if (isPagedTagsField) {
        label.textContent = field.label;
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
      select.setAttribute("aria-label", field.label);
      fieldContainer.append(label, select);
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
        const help = doc.createElement("div");
        help.className = "llm-agent-hitl-control-help";
        help.textContent =
          "Changing this regenerates suggestions and replaces your edits.";
        pagedTopControls.appendChild(help);
      } else if (
        isPagedReviewCard &&
        field.id === "pageSize" &&
        pagedFooterCenterControls
      ) {
        fieldContainer.className += " llm-agent-hitl-paged-footer-field";
        pagedFooterCenterControls.appendChild(fieldContainer);
      } else {
        content.appendChild(fieldContainer);
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
      content.appendChild(fieldContainer);
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
      content.appendChild(fieldContainer);
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
      content.appendChild(fieldContainer);
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
      content.appendChild(fieldContainer);
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
      content.appendChild(fieldContainer);
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
      content.appendChild(fieldContainer);
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
      content.appendChild(fieldContainer);
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
  const alternativeButtons = new Map<string, HTMLButtonElement>();
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
  let lastChooserActionId =
    normalizedActions.primaryActions.find(
      (action) => !actionNeedsSeparateSubmit(action.id),
    )?.id || normalizedActions.defaultActionId;
  let actionChooser: HTMLDivElement | null = null;
  const actionRow = doc.createElement("div");
  actionRow.className =
    "llm-plan-actions llm-agent-hitl-actions llm-agent-hitl-footer";
  const safeActionGroup = doc.createElement("div");
  safeActionGroup.className = "llm-agent-hitl-footer-safe";
  const primaryActionGroup = doc.createElement("div");
  primaryActionGroup.className = "llm-agent-hitl-footer-primary";
  let executeButton: HTMLButtonElement | null = null;
  let backButton: HTMLButtonElement | null = null;
  let alternativesToggleButton: HTMLButtonElement | null = null;
  let alternativesOpen = false;
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
  const syncConfirmButton = () => {
    const isValid = isActionValid(activeActionId);
    if (executeButton) {
      executeButton.disabled = !isValid;
      const selectionAction = pending.action.selectionAction;
      if (selectionAction) {
        const value = fieldAccessors
          .find((accessor) => accessor.id === selectionAction.fieldId)
          ?.getValue();
        const count = Array.isArray(value) ? value.length : 0;
        executeButton.textContent = `${selectionAction.verb} ${count} paper${count === 1 ? "" : "s"}`;
      }
    }
  };
  const syncAlternativeButtons = () => {
    for (const [actionId, button] of alternativeButtons) {
      const isActive = actionId === activeActionId;
      button.hidden = isActive;
      button.tabIndex = alternativesOpen && !isActive ? 0 : -1;
    }
  };
  const setAlternativesOpen = (open: boolean, focusFirst = false) => {
    if (!actionChooser || !alternativesToggleButton) return;
    alternativesOpen = open;
    actionChooser.dataset.open = open ? "true" : "false";
    actionChooser.setAttribute("aria-hidden", open ? "false" : "true");
    alternativesToggleButton.setAttribute(
      "aria-expanded",
      open ? "true" : "false",
    );
    syncAlternativeButtons();
    if (open && focusFirst) {
      const firstAlternative = Array.from(alternativeButtons.values()).find(
        (button) => !button.hidden && !button.disabled,
      );
      firstAlternative?.focus({ preventScroll: true });
    }
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
    if (executeButton) {
      executeButton.hidden = !buttonLayout.showsFooterExecuteButton;
      executeButton.textContent = isSeparateSubmitMode
        ? getSeparateSubmitLabel(activeActionId)
        : activeAction?.label || pending.action.confirmLabel || "Apply";
      executeButton.dataset.actionId = activeActionId;
      executeButton.className =
        activeAction?.style === "danger"
          ? "llm-plan-action llm-agent-hitl-btn llm-agent-hitl-btn-danger"
          : "llm-plan-action llm-plan-approve llm-agent-hitl-btn";
    }
    if (backButton) {
      backButton.hidden = !isSeparateSubmitMode;
      backButton.textContent = getBackLabel(activeActionId);
    }
    if (alternativesToggleButton) {
      alternativesToggleButton.hidden = isSeparateSubmitMode;
    }
    card.dataset.activeActionId = activeActionId;
    syncAlternativeButtons();
    syncConfirmButton();
  };
  const executeAction = (actionId = activeActionId) => {
    activeActionId = actionId;
    setAlternativesOpen(false);
    setButtonsDisabled(true);
    const payload = Object.fromEntries(
      fieldAccessors.map((accessor) => [accessor.id, accessor.getValue()]),
    );
    const activeAction = getActionById(actionId);
    resolveConfirmation(pending.requestId, {
      approved:
        activeAction?.approved ?? actionId !== normalizedActions.cancelActionId,
      actionId,
      data: payload,
    });
  };
  const handleExecute = () => {
    executeAction(activeActionId);
  };

  if (buttonLayout.hasActionChooser && !isPagedReviewCard) {
    actionChooser = doc.createElement("div");
    actionChooser.className = "llm-agent-hitl-action-choices";
    actionChooser.dataset.open = "false";
    actionChooser.setAttribute("aria-hidden", "true");
    actionChooser.setAttribute("role", "region");
    const safeRequestId = pending.requestId.replace(/[^a-zA-Z0-9_-]/g, "-");
    actionChooser.id = `llm-agent-hitl-alternatives-${safeRequestId}`;

    const drawerInner = doc.createElement("div");
    drawerInner.className = "llm-agent-hitl-alternatives-inner";
    const drawerLabel = doc.createElement("div");
    drawerLabel.className = "llm-agent-hitl-alternatives-label";
    drawerLabel.textContent = "Other options";
    drawerLabel.id = `${actionChooser.id}-label`;
    actionChooser.setAttribute("aria-labelledby", drawerLabel.id);
    const drawerList = doc.createElement("div");
    drawerList.className = "llm-agent-hitl-alternatives-list";
    drawerInner.append(drawerLabel, drawerList);
    actionChooser.appendChild(drawerInner);

    for (const action of normalizedActions.primaryActions) {
      const actionButton = doc.createElement("button");
      actionButton.type = "button";
      actionButton.dataset.actionChoice = action.id;
      actionButton.dataset.actionStyle = action.style || "secondary";
      actionButton.className = "llm-agent-hitl-alternative";
      const actionLabel = doc.createElement("span");
      actionLabel.className = "llm-agent-hitl-alternative-label";
      actionLabel.textContent = action.label;
      actionButton.appendChild(actionLabel);
      if (actionNeedsSeparateSubmit(action.id)) {
        const actionMeta = doc.createElement("span");
        actionMeta.className = "llm-agent-hitl-alternative-meta";
        actionMeta.textContent = "Requires input";
        actionButton.appendChild(actionMeta);
      }
      actionButton.addEventListener("click", () => {
        if (action.id === activeActionId) return;
        if (actionNeedsSeparateSubmit(action.id)) {
          lastChooserActionId = activeActionId;
        }
        activeActionId = action.id;
        setAlternativesOpen(false);
        syncActionUi();
        executeButton?.focus({ preventScroll: true });
      });
      alternativeButtons.set(action.id, actionButton);
      buttons.push(actionButton);
      drawerList.appendChild(actionButton);
    }
    actionChooser.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAlternativesOpen(false);
      alternativesToggleButton?.focus({ preventScroll: true });
    });
    card.appendChild(actionChooser);
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
      setAlternativesOpen(false);
      setButtonsDisabled(true);
      resolveConfirmation(pending.requestId, {
        approved: false,
        actionId: normalizedActions.cancelActionId,
      });
    });
    buttons.push(cancelButton);
    safeActionGroup.appendChild(cancelButton);
  }

  if (!isPagedReviewCard && buttonLayout.hasActionChooser) {
    alternativesToggleButton = doc.createElement("button");
    alternativesToggleButton.type = "button";
    alternativesToggleButton.dataset.kind = "alternatives";
    alternativesToggleButton.className =
      "llm-agent-hitl-btn llm-agent-hitl-btn-secondary llm-agent-hitl-alternatives-toggle";
    alternativesToggleButton.textContent = "Alternatives";
    alternativesToggleButton.setAttribute("aria-expanded", "false");
    if (actionChooser) {
      alternativesToggleButton.setAttribute("aria-controls", actionChooser.id);
    }
    alternativesToggleButton.addEventListener("click", () => {
      setAlternativesOpen(!alternativesOpen, !alternativesOpen);
    });
    buttons.push(alternativesToggleButton);
    primaryActionGroup.appendChild(alternativesToggleButton);

    backButton = doc.createElement("button");
    backButton.type = "button";
    backButton.dataset.kind = "back";
    backButton.className = "llm-agent-hitl-btn llm-agent-hitl-btn-secondary";
    backButton.textContent = getBackLabel(activeActionId);
    backButton.hidden = true;
    backButton.addEventListener("click", () => {
      activeActionId = lastChooserActionId;
      setAlternativesOpen(false);
      syncActionUi();
      executeButton?.focus({ preventScroll: true });
    });
    buttons.push(backButton);
    primaryActionGroup.appendChild(backButton);
  }

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
    primaryActionGroup.appendChild(executeButton);
  }

  if (!isPagedReviewCard) {
    actionRow.append(safeActionGroup, primaryActionGroup);
    card.appendChild(actionRow);
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
    pagedActions.className =
      "llm-agent-hitl-paged-actions llm-agent-hitl-footer";

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

  syncActionUi();
  for (const accessor of fieldAccessors) {
    accessor.bindValidity?.(syncActionUi);
  }
  if (isPagedReviewCard && getActionById("refresh")?.approved === false) {
    liveFieldBindings
      .get("tagsPerPaper")
      ?.bindChange(() => executeAction("refresh"));
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
    effect?: AgentToolEffect;
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
    .map((entry) => {
      const normalized = normalizeAgentTraceDetail(
        entry.label,
        entry.value,
        entry.kind || "text",
      );
      if (normalized && entry.timeline) {
        normalized.timeline = { ...entry.timeline };
      }
      return normalized;
    })
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
    if (detail.timeline) normalized.timeline = { ...detail.timeline };
    const key = `${normalized.label}\u0000${normalized.value}\u0000${
      normalized.timeline?.href || ""
    }`;
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
  const presentation = getToolDefinition(name)?.presentation;
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
    resolveToolPresentationSummary(presentation?.summaries?.onCall, {
      label,
      args,
      request,
    }) ||
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
    ...(presentation?.traceIcon ? { iconName: presentation.traceIcon } : {}),
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
  effect?: AgentToolEffect,
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
        { label, content, effect, request },
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
      { label, content, effect, request },
    ) ||
    resolveToolPresentationSummary(
      getToolDefinition(name)?.presentation?.summaries?.onSuccess,
      { label, content, effect, request },
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
  args?: unknown;
  ok?: boolean;
  text?: string;
  codeBlock?: string;
  artifacts?: AgentToolArtifact[];
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
  const imageArtifacts = normalizeImageArtifacts(input.artifacts);
  if (
    input.phase === "completed" &&
    input.ok !== false &&
    imageArtifacts.length &&
    normalizeMcpToolName(toolName || "") === "paper_read" &&
    readToolArgsMode(input.args) === "figures"
  ) {
    return {
      kind: "tool",
      icon: "⌘",
      text:
        imageArtifacts.length === 1
          ? "Extracted 1 figure"
          : `Extracted ${imageArtifacts.length} figures`,
      codeBlock: readAgentTraceText(input.codeBlock) || undefined,
    };
  }
  const verb = input.phase === "completed" ? "Used" : "Using";
  return {
    kind: "tool",
    icon: "⌘",
    text: `${verb} ${label}`,
    codeBlock: readAgentTraceText(input.codeBlock) || undefined,
  };
}

function normalizeMcpToolName(value: string): string {
  const clean = value.trim();
  const match = clean.match(/^mcp__.+__(.+)$/);
  return match?.[1] || clean;
}

function readToolArgsMode(args: unknown): string {
  let value = args;
  if (typeof value === "string") {
    const clean = value.trim();
    if (clean.startsWith("{") || clean.startsWith("[")) {
      try {
        value = JSON.parse(clean) as unknown;
      } catch {
        return "";
      }
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const mode = (value as Record<string, unknown>).mode;
  return typeof mode === "string" ? mode.trim() : "";
}

type ImageAgentToolArtifact = Extract<AgentToolArtifact, { kind: "image" }>;

function normalizeImageArtifacts(artifacts: unknown): ImageAgentToolArtifact[] {
  if (!Array.isArray(artifacts)) return [];
  const images: ImageAgentToolArtifact[] = [];
  const seenPaths = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      continue;
    }
    const record = artifact as Partial<ImageAgentToolArtifact>;
    const storedPath =
      typeof record.storedPath === "string" ? record.storedPath.trim() : "";
    const mimeType =
      typeof record.mimeType === "string" ? record.mimeType.trim() : "";
    if (record.kind !== "image" || !storedPath || !/^image\//i.test(mimeType)) {
      continue;
    }
    if (seenPaths.has(storedPath)) continue;
    seenPaths.add(storedPath);
    images.push({
      kind: "image",
      mimeType,
      storedPath,
      ...(typeof record.contentHash === "string" && record.contentHash.trim()
        ? { contentHash: record.contentHash.trim() }
        : {}),
      ...(typeof record.title === "string" && record.title.trim()
        ? { title: sanitizeText(record.title).trim() }
        : {}),
      ...(Number.isFinite(record.pageIndex)
        ? { pageIndex: Math.floor(Number(record.pageIndex)) }
        : {}),
      ...(typeof record.pageLabel === "string" && record.pageLabel.trim()
        ? { pageLabel: sanitizeText(record.pageLabel).trim() }
        : {}),
      ...(record.paperContext ? { paperContext: record.paperContext } : {}),
    });
  }
  return images;
}

function basenameFromLocalPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function imageArtifactLabel(artifact: ImageAgentToolArtifact): string {
  const title = sanitizeText(artifact.title || "").trim();
  if (title) return title;
  const basename = sanitizeText(basenameFromLocalPath(artifact.storedPath));
  if (basename) return basename;
  const pageLabel = sanitizeText(artifact.pageLabel || "").trim();
  return pageLabel ? `Page ${pageLabel}` : "Image artifact";
}

function imageArtifactTooltip(artifact: ImageAgentToolArtifact): string {
  const parts = [
    artifact.paperContext?.title,
    artifact.pageLabel ? `Page ${artifact.pageLabel}` : "",
    artifact.storedPath,
  ]
    .map((part) => sanitizeText(part || "").trim())
    .filter(Boolean);
  return parts.join(" · ");
}

function imageArtifactsToGeneratedImages(
  artifacts: unknown,
  keyPrefix: string,
): GeneratedChatImage[] {
  return normalizeImageArtifacts(artifacts).map((artifact, index) => ({
    id: `${keyPrefix}:${index}:${artifact.storedPath}${
      artifact.contentHash ? `:${artifact.contentHash}` : ""
    }`.slice(0, 200),
    label: imageArtifactLabel(artifact),
    path: artifact.storedPath,
    ...(imageArtifactTooltip(artifact)
      ? { revisedPrompt: imageArtifactTooltip(artifact) }
      : {}),
  }));
}

function appendImageArtifactGrid(
  ctx: AgentTraceAdapterContext,
  artifacts: unknown,
  keyPrefix: string,
): boolean {
  const images = imageArtifactsToGeneratedImages(artifacts, keyPrefix);
  if (images.length) {
    ctx.items.push({ type: "image_grid", images });
    return true;
  }
  return false;
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
  preserveRolledBackText: boolean;
  requestSummary: AgentTraceRequestSummary;
  userMessage: Message | null | undefined;
  pendingActions: Map<string, AgentPendingAction>;
  toolResultsByCallId: Map<
    string,
    Extract<AgentRunEventRecord["payload"], { type: "tool_result" }>
  >;
  lastMeaningfulStatus: string | null;
  reasoningLabels: Map<string, string>;
  reasoningSegmentCounts: Map<string, number>;
  reasoningStepCounter: number;
  fallbackReasoningStep: number;
  visibleInlineText: Set<string>;
  intermediateInlineTextItems: Set<
    Extract<AgentTraceDisplayItem, { type: "inline_text" }>
  >;
};

function markLatestInlineTextAsIntermediate(
  ctx: AgentTraceAdapterContext,
  beforeIndex: number,
): void {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const item = ctx.items[index];
    if (item.type !== "inline_text") continue;
    ctx.intermediateInlineTextItems.add(item);
    return;
  }
}

function rollbackInlineTraceText(
  ctx: AgentTraceAdapterContext,
  payload: Extract<
    AgentRunEventRecord["payload"],
    { type: "message_rollback" }
  >,
): void {
  if (ctx.preserveRolledBackText) return;
  let remaining =
    typeof payload.length === "number" && payload.length > 0
      ? payload.length
      : (payload.text || "").length;
  if (remaining <= 0) return;

  for (let index = ctx.items.length - 1; index >= 0 && remaining > 0; index--) {
    const item = ctx.items[index];
    if (item.type !== "inline_text") continue;
    const previousText = item.text;
    const previousKey = normalizeInlineTextForDedupe(previousText);
    if (previousKey) ctx.visibleInlineText.delete(previousKey);
    if (remaining >= previousText.length) {
      remaining -= previousText.length;
      ctx.intermediateInlineTextItems.delete(item);
      ctx.items.splice(index, 1);
      continue;
    }
    item.text = previousText.slice(0, previousText.length - remaining);
    remaining = 0;
    const nextKey = normalizeInlineTextForDedupe(item.text);
    if (nextKey) ctx.visibleInlineText.add(nextKey);
  }
}

function replaceInlineTextWithDraftingAction(
  items: AgentTraceDisplayItem[],
): AgentTraceDisplayItem[] {
  let insertedDraftingAction = false;
  const result: AgentTraceDisplayItem[] = [];
  for (const item of items) {
    if (item.type !== "inline_text") {
      result.push(item);
      continue;
    }
    if (insertedDraftingAction) continue;
    insertedDraftingAction = true;
    result.push({
      type: "action",
      row: {
        kind: "plan",
        icon: NOTE_EDIT_PENCIL_ICON,
        text: "Drafting answer",
      },
    });
  }
  return result;
}

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
  const logicalKey = hasExplicitStepId
    ? getReasoningTraceKey(payload)
    : `step:${ctx.fallbackReasoningStep}`;
  const previousItem = ctx.items[ctx.items.length - 1];
  if (
    previousItem?.type === "reasoning" &&
    previousItem.logicalKey === logicalKey
  ) {
    const prev = previousItem.summary || "";
    if (!prev.includes(text)) {
      previousItem.summary = appendAgentTraceText(previousItem.summary, text);
    }
    return;
  }

  let label = readAgentTraceText(payload.stepLabel) || "";
  if (!label) {
    label = ctx.reasoningLabels.get(logicalKey) || "";
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
    ctx.reasoningLabels.set(logicalKey, label);
  }
  const segmentNumber = (ctx.reasoningSegmentCounts.get(logicalKey) || 0) + 1;
  ctx.reasoningSegmentCounts.set(logicalKey, segmentNumber);
  ctx.items.push({
    type: "reasoning",
    key: `${logicalKey}:segment:${segmentNumber}`,
    logicalKey,
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
      if (INTERNAL_PLAN_TOOL_NAMES.has(entry.payload.name)) return true;
      const resultEvent = ctx.toolResultsByCallId.get(entry.payload.callId);
      const resultInfo = buildToolResultTraceInfo(
        entry.payload.name,
        resultEvent,
      );
      let presentationDetails: AgentTraceDetail[] = [];
      if (resultEvent) {
        try {
          presentationDetails =
            getToolDefinition(
              entry.payload.name,
            )?.presentation?.buildTraceDetails?.({
              args: entry.payload.args,
              content: resultEvent.content,
            }) ?? [];
        } catch {
          presentationDetails = [];
        }
      }
      const details = presentationDetails.length
        ? presentationDetails
        : [
            ...buildAgentTraceArgsDetails(
              entry.payload.name,
              entry.payload.args,
            ),
            ...(resultInfo?.details || []),
          ];
      const presentation = getToolDefinition(entry.payload.name)?.presentation;
      let row = summarizeAgentTraceToolCall(
        entry.payload.name,
        entry.payload.args,
        ctx.requestSummary,
        resultInfo || undefined,
      );
      if (resultEvent?.ok && presentation?.buildTraceSummary) {
        try {
          const summary = presentation.buildTraceSummary({
            args: entry.payload.args,
            content: resultEvent.content,
          });
          if (summary) row = { ...row, text: summary };
        } catch {
          // Keep the regular call summary when display-only formatting fails.
        }
      }
      ctx.items.push({
        type: "action",
        row,
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
      if (INTERNAL_PLAN_TOOL_NAMES.has(entry.payload.name)) return true;
      // A write the agent chose on its own must always be visible, ahead of
      // every presentation shortcut: neither a missing summary nor a tool that
      // folds its result into the call row may hide it.
      const judgment = entry.payload.authority === "yolo_judgment";
      if (
        !judgment &&
        entry.payload.ok &&
        getToolDefinition(entry.payload.name)?.presentation
          ?.mergeResultIntoCallTrace
      ) {
        return true;
      }
      let row = summarizeAgentTraceToolResult(
        entry.payload.name,
        entry.payload.ok,
        entry.payload.content,
        entry.payload.effect,
        ctx.requestSummary,
      );
      if (judgment) {
        row = row
          ? { ...row, text: `${row.text} (agent's own call)` }
          : {
              kind: "ok",
              icon: "✓",
              text: `${toolLabelFromName(entry.payload.name)} completed (agent's own call)`,
            };
      }
      if (row) {
        ctx.items.push({
          type: "action",
          row,
        });
        if (entry.payload.ok || entry.payload.name === "note_write") {
          try {
            const cards =
              getToolDefinition(
                entry.payload.name,
              )?.presentation?.buildResultCards?.(entry.payload.content) ??
              null;
            if (cards && cards.length > 0) {
              ctx.items.push({
                type: "card_list",
                cards: entry.payload.ok
                  ? cards
                  : cards.filter(
                      (card) =>
                        card.kind === "note_change" &&
                        ["failed", "mismatch", "unverified"].includes(
                          card.state,
                        ),
                    ),
              });
            }
          } catch {
            // card generation errors must not crash the trace
          }
        }
      }
      if (entry.payload.ok) {
        const hasImageGrid = appendImageArtifactGrid(
          ctx,
          entry.payload.artifacts,
          `tool-result:${entry.payload.callId}`,
        );
        if (hasImageGrid && !row) {
          const inserted = ctx.items.pop();
          ctx.items.push({
            type: "action",
            row: {
              kind: "ok",
              icon: "✓",
              text: "Prepared image artifact",
            },
          });
          if (inserted) ctx.items.push(inserted);
        }
      }
      return true;
    }
    case "message_delta":
      appendInterleavedInlineText(
        ctx.items,
        entry.payload.text || "",
        ctx.visibleInlineText,
      );
      return true;
    case "message_rollback":
      rollbackInlineTraceText(ctx, entry.payload);
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
          args: entry.payload.args,
          ok: entry.payload.ok,
          text: entry.payload.text,
          codeBlock: entry.payload.codeBlock,
          artifacts: entry.payload.artifacts,
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
      if (entry.payload.phase === "completed" && entry.payload.ok !== false) {
        appendImageArtifactGrid(
          ctx,
          entry.payload.artifacts,
          `codex:${entry.payload.itemId}`,
        );
      }
      return true;
    }
    case "codex_progress": {
      const progressText = readAgentTraceText(entry.payload.text);
      if (progressText) {
        // Agent messages are activity entries. Keep them in arrival order with
        // tool calls; the canonical final answer renders outside this trace.
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
    case "plan_scope_amended":
      ctx.items.push({
        type: "action",
        row: {
          kind: "plan",
          icon: "↳",
          text:
            `Scope amended${entry.payload.authority === "user" ? "" : " automatically"} (${entry.payload.previousItemCount} to ` +
            `${entry.payload.newItemCount}; ${entry.payload.authority}): ` +
            entry.payload.rationale,
        },
        details: [
          {
            label: "Mode",
            value: entry.payload.mode,
            kind: "text",
          },
          {
            label: "Amendment",
            value: entry.payload.amendmentId,
            kind: "text",
          },
        ],
        detailKey: `plan-amendment:${entry.payload.amendmentId}`,
      });
      return true;
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

function researchDisplayLabels(
  events: readonly AgentRunEventRecord[],
): Map<string, string> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index].payload;
    const values =
      event.type === "provider_event" &&
      event.providerType === "paper_display_labels" &&
      event.payload?.version === 1
        ? event.payload.displayLabels
        : event.type === "tool_result" &&
            event.ok &&
            ["research_update", "update_plan"].includes(event.name) &&
            isAgentTraceRecord(event.content)
          ? event.content.displayLabels
          : undefined;
    if (values && typeof values === "object")
      return new Map(
        Object.entries(values).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
  }
  return undefined;
}

type TraceProjection = ReturnType<typeof buildAgentTraceDisplayItemsCanonical>;
const streamingProjections = new WeakMap<
  Message,
  {
    events: AgentRunEventRecord[];
    count: number;
    last: AgentRunEventRecord | undefined;
    text: string;
    user: Message | null | undefined;
    projection: TraceProjection;
    labels?: Map<string, string>;
    tail?: Extract<AgentRunEventRecord["payload"], { type: "reasoning" }>;
  }
>();

/** Reuse the canonical projection; append the active compacted reasoning group. */
export function buildAgentTraceDisplayItems(
  events: AgentRunEventRecord[],
  userMessage?: Message | null,
  assistantMessage?: Message | null,
): TraceProjection {
  const cached = assistantMessage && streamingProjections.get(assistantMessage);
  if (
    assistantMessage?.streaming &&
    cached &&
    cached.events === events &&
    cached.count <= events.length &&
    events[cached.count - 1] === cached.last &&
    cached.text === assistantMessage.text &&
    cached.user === userMessage
  ) {
    const added = events.slice(cached.count);
    if (!added.length) return cached.projection;
    const tail = cached.tail;
    const lastItem =
      cached.projection.items[cached.projection.items.length - 1];
    if (
      tail &&
      lastItem?.type === "reasoning" &&
      added.every(
        (entry) =>
          entry.payload.type === "reasoning" &&
          getReasoningTraceKey(entry.payload) === getReasoningTraceKey(tail),
      )
    ) {
      for (const entry of added) {
        const next = entry.payload as typeof tail;
        tail.summary = appendAgentTraceText(tail.summary, next.summary);
        tail.details = appendAgentTraceText(tail.details, next.details);
        tail.stepLabel = next.stepLabel || tail.stepLabel;
      }
      if (readAgentTraceText(tail.stepLabel))
        lastItem.label = readAgentTraceText(tail.stepLabel)!;
      lastItem.summary =
        readAgentTraceText(tail.details) ||
        readAgentTraceText(tail.summary) ||
        undefined;
      if (cached.labels && lastItem.summary)
        lastItem.summary = projectPaperReferences(
          lastItem.summary,
          cached.labels,
        );
      cached.count = events.length;
      cached.last = events[events.length - 1];
      return cached.projection;
    }
  }
  const projection = buildAgentTraceDisplayItemsCanonical(
    events,
    userMessage,
    assistantMessage,
  );
  if (assistantMessage?.streaming) {
    const compacted = compactAgentTraceEvents(events);
    const tail = compacted[compacted.length - 1]?.payload;
    const lastItem = projection.items[projection.items.length - 1];
    const labels = researchDisplayLabels(events);
    const canAppend =
      tail?.type === "reasoning" &&
      lastItem?.type === "reasoning" &&
      (Boolean(labels) ||
        lastItem.summary ===
          (readAgentTraceText(tail.details) ||
            readAgentTraceText(tail.summary)));
    streamingProjections.set(assistantMessage, {
      events,
      count: events.length,
      last: events[events.length - 1],
      text: assistantMessage.text,
      user: userMessage,
      projection,
      tail: canAppend ? { ...tail } : undefined,
      labels,
    });
  } else if (assistantMessage) streamingProjections.delete(assistantMessage);
  return projection;
}

function buildAgentTraceDisplayItemsCanonical(
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
  const preserveRolledBackText = isCodexTrace || isAgentTrace;
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
  const requestChips = buildAgentTraceRequestChips(userMessage);
  const requestSummary = buildAgentTraceRequestSummary(userMessage);
  const planPhase = resolveTracePlanPhase(compactedEvents);
  const adapterContext: AgentTraceAdapterContext = {
    items,
    isCodexTrace,
    preserveRolledBackText,
    requestSummary,
    userMessage,
    pendingActions: new Map<string, AgentPendingAction>(),
    toolResultsByCallId,
    lastMeaningfulStatus: null,
    reasoningLabels: new Map<string, string>(),
    reasoningSegmentCounts: new Map<string, number>(),
    reasoningStepCounter: 0,
    fallbackReasoningStep: 1,
    visibleInlineText: new Set<string>(),
    intermediateInlineTextItems: new Set(),
  };

  items.push({
    type: "message",
    tone: "neutral",
    text:
      planPhase === "planning"
        ? "Planning the request against the available context."
        : planPhase === "executing"
          ? "Executing the approved plan in order."
          : isCodexTrace
            ? "Request sent to Codex."
            : buildInitialAgentMessage(requestChips),
  });
  items.push({
    type: "action",
    row: {
      kind: "plan",
      icon: "↳",
      text:
        planPhase === "planning"
          ? requestChips.length
            ? "Plan request and attached context received"
            : "Plan request received"
          : planPhase === "executing"
            ? "Approved tasks and context received"
            : isCodexTrace
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
    const itemCountBeforeEvent = items.length;
    const handled =
      appendCodexAgentTraceEvent(adapterContext, entry) ||
      appendLegacyAgentTraceEvent(adapterContext, entry) ||
      appendSharedAgentTraceEvent(adapterContext, entry);
    if (
      handled &&
      entry.payload.type !== "message_delta" &&
      entry.payload.type !== "message_rollback" &&
      entry.payload.type !== "final" &&
      items.length > itemCountBeforeEvent
    ) {
      markLatestInlineTextAsIntermediate(adapterContext, itemCountBeforeEvent);
    }
  }

  const finalText = getFinalTraceText(compactedEvents);
  const isInterleaved = items.some(
    (item) =>
      item.type === "inline_text" &&
      adapterContext.intermediateInlineTextItems.has(item),
  );
  const hasTerminalInlineText = items.some(
    (item) =>
      item.type === "inline_text" &&
      !adapterContext.intermediateInlineTextItems.has(item),
  );
  const hasCanonicalAssistantText = Boolean(assistantMessage?.text?.trim());
  const displayItems = isInterleaved
    ? finalText
      ? items.filter(
          (item) => !shouldSuppressInlineFinalAnswer(item, finalText),
        )
      : hasCanonicalAssistantText
        ? items.filter(
            (item) =>
              item.type !== "inline_text" ||
              adapterContext.intermediateInlineTextItems.has(item),
          )
        : items
    : replaceInlineTextWithDraftingAction(items);
  const inlineTextReplacesAssistantText =
    isInterleaved &&
    !finalText &&
    (!hasTerminalInlineText || !hasCanonicalAssistantText);

  const labels = researchDisplayLabels(events);
  const presentedItems = labels
    ? displayItems.map((item): AgentTraceDisplayItem => {
        if (item.type === "inline_text")
          return { ...item, text: projectPaperReferences(item.text, labels) };
        if (item.type === "reasoning")
          return {
            ...item,
            summary: item.summary
              ? projectPaperReferences(item.summary, labels)
              : undefined,
            details: item.details
              ? projectPaperReferences(item.details, labels)
              : undefined,
          };
        if (item.type === "message")
          return { ...item, text: projectPaperReferences(item.text, labels) };
        if (item.type === "action")
          return {
            ...item,
            row: {
              ...item.row,
              text: projectPaperReferences(item.row.text, labels),
            },
          };
        return item;
      })
    : displayItems;
  return {
    items: presentedItems,
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
  if (details.some((detail) => detail.timeline)) {
    body.classList.add("llm-agent-process-details-with-timeline");
  }
  let timeline: HTMLDivElement | null = null;
  for (const detail of details) {
    if (detail.timeline) {
      if (!timeline) {
        timeline = doc.createElement("div") as HTMLDivElement;
        timeline.className = "llm-agent-trace-timeline";
        body.appendChild(timeline);
      }
      let safeHref: string | null = null;
      if (detail.timeline.href) {
        try {
          safeHref = normalizePublicWebUrl(detail.timeline.href);
        } catch {
          safeHref = null;
        }
      }
      const row = doc.createElement(safeHref ? "button" : "div") as
        | HTMLButtonElement
        | HTMLDivElement;
      row.className = `llm-agent-trace-timeline-row llm-agent-trace-timeline-row-${detail.timeline.icon}${
        safeHref ? " llm-agent-trace-timeline-row-link" : ""
      }`;
      if (safeHref) {
        (row as HTMLButtonElement).type = "button";
        row.setAttribute("aria-label", `Open ${detail.label}: ${detail.value}`);
        row.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          Zotero.launchURL(safeHref!);
        });
      }
      row.title = detail.value;

      const icon = doc.createElement("span") as HTMLSpanElement;
      icon.className = `llm-agent-trace-timeline-icon llm-agent-trace-timeline-icon-${detail.timeline.icon}`;
      icon.setAttribute("aria-hidden", "true");
      if (detail.timeline.icon === "website") {
        const favicon = createWebFaviconImage(
          doc,
          detail.timeline.faviconUrl,
          "llm-agent-trace-timeline-favicon",
        );
        if (favicon) {
          icon.classList.add("llm-agent-trace-timeline-icon-has-favicon");
          favicon.addEventListener("error", () => {
            icon.classList.remove("llm-agent-trace-timeline-icon-has-favicon");
          });
          icon.appendChild(favicon);
        }
      }
      const value = doc.createElement("span") as HTMLSpanElement;
      value.className = "llm-agent-trace-timeline-value";
      value.textContent = detail.value;
      row.append(icon, value);
      timeline.appendChild(row);
      continue;
    }
    timeline = null;
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

export const renderAgentTraceDetailsBodyForTests = renderAgentTraceDetailsBody;

function createPlanningDriveIcon(doc: Document): HTMLSpanElement {
  const loader = doc.createElement("span") as HTMLSpanElement;
  loader.className = "llm-at-planning-drive";
  loader.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 9; index += 1) {
    const pixel = doc.createElement("span") as HTMLSpanElement;
    pixel.className = "llm-at-planning-drive-pixel";
    loader.appendChild(pixel);
  }
  return loader;
}

const cardDisposers = new WeakMap<HTMLElement, () => void>();
function disposePlanCard(node: HTMLElement): void {
  cardDisposers.get(node)?.();
  cardDisposers.delete(node);
  node.remove();
}

function dispatchPlanEvent(
  root: HTMLElement,
  name: string,
  detail: Record<string, unknown>,
): void {
  const EventCtor = root.ownerDocument.defaultView?.CustomEvent;
  if (!EventCtor) return;
  root.dispatchEvent(new EventCtor(name, { bubbles: true, detail }));
}

function getPlanProjection(
  events: AgentRunEventRecord[],
):
  | { artifact: PlanArtifact; ledger?: undefined }
  | { artifact?: undefined; ledger: PlanExecutionLedger }
  | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index].payload;
    if (event.type === "plan_execution_updated") {
      return { ledger: event.ledger };
    }
    if (event.type === "plan_ready" || event.type === "plan_updated") {
      return { artifact: event.artifact };
    }
  }
  return null;
}

function getPlanActionContract(
  events: AgentRunEventRecord[],
): AgentActionContract | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index].payload;
    if (
      event.type === "provider_event" &&
      event.providerType === "agent_action_contract" &&
      event.payload?.contract
    ) {
      return event.payload.contract as AgentActionContract;
    }
  }
  return undefined;
}

function renderPlanContainer(params: {
  doc: Document;
  events: AgentRunEventRecord[];
  projection:
    | { artifact: PlanArtifact; ledger?: undefined }
    | { artifact?: undefined; ledger: PlanExecutionLedger };
}): HTMLElement {
  if (params.projection.ledger) {
    const ledger = params.projection.ledger;
    const root = params.doc.createElement("section");
    root.className = "llm-plan-recovery-card";
    const text = params.doc.createElement("p");
    text.textContent = "Plan execution was interrupted.";
    const resume = params.doc.createElement("button");
    resume.className = "llm-plan-action llm-plan-approve";
    resume.textContent = "Resume execution";
    let disposed = false;
    const onResume = async () => {
      resume.disabled = true;
      try {
        const current = await loadPlanExecutionLedger(ledger.executionId);
        if (disposed || !root.isConnected) return;
        if (!current || current.status !== "interrupted") {
          text.textContent = "This execution is no longer available to resume.";
          resume.remove();
          return;
        }
        stageApprovedPlanExecution(current);
        dispatchPlanEvent(root, PLAN_APPROVED_EVENT, {
          planId: current.planId,
          revision: current.revision,
          executionId: current.executionId,
          recovery: true,
        });
      } catch (error) {
        if (!disposed)
          text.textContent =
            error instanceof Error ? error.message : String(error);
      } finally {
        if (!disposed) resume.disabled = false;
      }
    };
    resume.addEventListener("click", onResume);
    cardDisposers.set(root, () => {
      disposed = true;
      resume.removeEventListener("click", onResume);
    });
    root.append(text, resume);
    return root;
  }
  const root = params.doc.createElement("section");
  root.className = "llm-plan-container";
  const actionContract = getPlanActionContract(params.events);

  const artifactStatusLabel = (status: PlanArtifact["status"]): string => {
    switch (status) {
      case "drafting":
        return "Planning";
      case "awaiting_approval":
        return "Ready to review";
      case "approved":
        return "Approved";
      case "superseded":
        return "Superseded";
      case "cancelled":
        return "Cancelled";
    }
  };

  const renderArtifactMarkdown = (artifact: PlanArtifact): HTMLElement => {
    const markdown = params.doc.createElement("div");
    markdown.className = "llm-plan-markdown";
    const rawSource =
      artifact.nativePlanning?.proposal?.markdown ||
      [
        artifact.explanation?.trim() || "",
        ...artifact.steps.map((step, index) => `${index + 1}. ${step.content}`),
      ]
        .filter(Boolean)
        .join("\n\n");
    const labels = researchDisplayLabels(params.events);
    const source = labels
      ? projectPaperReferences(rawSource, labels)
      : rawSource;
    try {
      renderRenderedMarkdownInto(markdown, source, params.doc);
    } catch {
      markdown.textContent = source;
    }
    if (artifact.nativePlanning?.proposal && artifact.contract) {
      const summary = params.doc.createElement("p");
      summary.className = "llm-plan-contract-summary";
      const investigation = artifact.contract.investigation;
      summary.textContent = [
        investigation?.scopeSnapshot
          ? `Research scope: ${investigation.scopeSnapshot.itemCount} papers`
          : "Scope: the approved request",
        `Deliverable: ${artifact.contract.deliverable.kind}`,
        artifact.contract.effects?.libraryMutation
          ? `Library changes: ${artifact.contract.effects.libraryMutation.approval === "after_research" ? "review exact targets after research" : "within the approved scope"}`
          : "Library changes: none",
      ].join(" · ");
      markdown.appendChild(summary);
    }
    return markdown;
  };

  let disposed = false;
  let lastArtifact = params.projection.artifact;
  let paintedSignature = "";
  cardDisposers.set(root, () => {
    disposed = true;
  });
  const paint = (projection: { artifact: PlanArtifact }) => {
    if (disposed || projection.artifact.updatedAt < lastArtifact.updatedAt)
      return;
    const signature = JSON.stringify([
      projection.artifact.planId,
      projection.artifact.revision,
      projection.artifact.digest,
      projection.artifact.status,
      projection.artifact.updatedAt,
    ]);
    if (signature === paintedSignature) return;
    paintedSignature = signature;
    lastArtifact = projection.artifact;
    root.replaceChildren();
    const artifact = projection.artifact;
    const planId = artifact.planId;
    const revision = artifact.revision;
    root.dataset.llmPlanId = planId;
    root.dataset.llmPlanRevision = `${revision}`;
    root.setAttribute("aria-label", "Plan");

    const header = params.doc.createElement("div");
    header.className = "llm-plan-header";
    const heading = params.doc.createElement("div");
    heading.className = "llm-plan-heading";
    const title = params.doc.createElement("strong");
    title.className = "llm-plan-title";
    title.textContent = "Plan";
    heading.appendChild(title);
    if (revision > 1) {
      const version = params.doc.createElement("span");
      version.className = "llm-plan-version";
      version.textContent = `Revision ${revision}`;
      heading.appendChild(version);
    }
    const status = params.doc.createElement("span");
    status.className = "llm-plan-status";
    status.textContent = artifactStatusLabel(artifact.status);
    status.dataset.status = artifact.status;
    header.append(heading, status);
    root.appendChild(header);

    if (artifact) {
      root.appendChild(renderArtifactMarkdown(artifact));
      const snapshot = artifact.contract?.investigation?.scopeSnapshot;
      if (snapshot) {
        const scope = params.doc.createElement("div");
        scope.className = "llm-plan-scope-snapshot";
        const createdAt = new Date(snapshot.createdAt).toLocaleString();
        const shortDigest =
          snapshot.digest.length > 24
            ? `${snapshot.digest.slice(0, 16)}…${snapshot.digest.slice(-8)}`
            : snapshot.digest;
        scope.textContent = `Frozen scope · ${snapshot.itemCount.toLocaleString()} items · ${createdAt} · policy v${snapshot.policyVersion} · ${shortDigest}`;
        scope.title = `Scope snapshot ${snapshot.snapshotId}\nDigest: ${snapshot.digest}`;
        root.appendChild(scope);
      }
    }

    const live = params.doc.createElement("div");
    live.className = "llm-plan-live-region";
    live.setAttribute("aria-live", "polite");
    live.textContent = status.textContent || "";
    root.appendChild(live);

    if (projection.artifact?.status === "awaiting_approval") {
      const approvalHint = params.doc.createElement("p");
      approvalHint.className = "llm-plan-approval-hint";
      approvalHint.textContent =
        "Approve to start these steps. During execution, Safe reviews eligible scope amendments, Auto handles in-goal amendments, and YOLO may also approve successor revisions. Hard safety boundaries remain enforced.";
      root.appendChild(approvalHint);
      const actions = params.doc.createElement("div");
      actions.className = "llm-plan-actions llm-plan-review-actions";
      const setReviewActionLabel = (
        button: HTMLButtonElement,
        fullLabel: string,
        compactLabel: string,
      ) => {
        button.setAttribute("aria-label", fullLabel);
        const full = params.doc.createElement("span");
        full.className = "llm-plan-action-label-full";
        full.textContent = fullLabel;
        const compact = params.doc.createElement("span");
        compact.className = "llm-plan-action-label-compact";
        compact.textContent = compactLabel;
        button.replaceChildren(full, compact);
      };
      const approve = params.doc.createElement("button");
      approve.type = "button";
      approve.className = "llm-plan-action llm-plan-approve";
      setReviewActionLabel(approve, "Approve plan", "Approve");
      const revise = params.doc.createElement("button");
      revise.type = "button";
      revise.className = "llm-plan-action llm-plan-revise";
      setReviewActionLabel(revise, "Request changes", "Revise");
      const cancel = params.doc.createElement("button");
      cancel.type = "button";
      cancel.className = "llm-plan-action llm-plan-cancel";
      setReviewActionLabel(cancel, "Cancel", "Cancel");
      actions.append(approve, revise, cancel);
      root.appendChild(actions);

      const revisionBox = params.doc.createElement("div");
      revisionBox.className = "llm-plan-revision-box";
      revisionBox.style.display = "none";
      const revisionInput = params.doc.createElement("textarea");
      revisionInput.className = "llm-plan-revision-input";
      revisionInput.placeholder = "What should change in this plan?";
      const sendRevision = params.doc.createElement("button");
      sendRevision.type = "button";
      sendRevision.className = "llm-plan-action llm-plan-approve";
      sendRevision.textContent = "Send revision";
      revisionBox.append(revisionInput, sendRevision);
      root.appendChild(revisionBox);

      const reviewArtifact = projection.artifact;
      approve.addEventListener("click", () => {
        approve.disabled = true;
        revise.disabled = true;
        cancel.disabled = true;
        approve.textContent = "Starting…";
        approve.setAttribute("aria-label", "Starting plan");
        void planExecutionCoordinator
          .approve({
            planId: reviewArtifact.planId,
            revision: reviewArtifact.revision,
            expectedDigest: reviewArtifact.digest,
            conversationGeneration: getConversationWriteGeneration(
              reviewArtifact.conversationKey,
            ),
            actionContract,
          })
          .then(async (ledger) => {
            stageApprovedPlanExecution(ledger);
            const approvedArtifact = await loadPlanArtifact(
              reviewArtifact.planId,
              reviewArtifact.revision,
            );
            paint({
              artifact:
                approvedArtifact ||
                ({
                  ...reviewArtifact,
                  status: "approved",
                  approvedAt: Date.now(),
                  updatedAt: Date.now(),
                } as PlanArtifact),
            });
            dispatchPlanEvent(root, PLAN_APPROVED_EVENT, {
              planId: ledger.planId,
              revision: ledger.revision,
              executionId: ledger.executionId,
            });
          })
          .catch((error) => {
            approve.disabled = false;
            revise.disabled = false;
            cancel.disabled = false;
            setReviewActionLabel(approve, "Approve plan", "Approve");
            const errorMessage = params.doc.createElement("p");
            errorMessage.className = "llm-plan-error";
            errorMessage.textContent =
              error instanceof Error ? error.message : String(error);
            root.appendChild(errorMessage);
          });
      });
      revise.addEventListener("click", () => {
        revisionBox.style.display =
          revisionBox.style.display === "none" ? "flex" : "none";
        if (revisionBox.style.display !== "none") revisionInput.focus();
      });
      sendRevision.addEventListener("click", () => {
        const comment = revisionInput.value.trim();
        if (!comment) return;
        dispatchPlanEvent(root, PLAN_REVISE_EVENT, {
          planId: reviewArtifact.planId,
          revision: reviewArtifact.revision,
          provider: reviewArtifact.provider,
          comment,
        });
      });
      cancel.addEventListener("click", () => {
        void (async () => {
          const confirmed = await showStandaloneConfirmationDialog(params.doc, {
            title: "Cancel this plan?",
            message: "The cancelled plan will remain in conversation history.",
            confirmLabel: "Cancel plan",
            cancelLabel: "Keep plan",
            destructive: true,
          });
          if (!confirmed) return;
          const artifact = await planExecutionCoordinator.cancelArtifact({
            planId: reviewArtifact.planId,
            revision: reviewArtifact.revision,
          });
          if (artifact) paint({ artifact });
          dispatchPlanEvent(root, PLAN_CANCEL_EVENT, {
            planId: reviewArtifact.planId,
            revision: reviewArtifact.revision,
          });
        })();
      });
    }
  };

  paint(params.projection);
  const artifact = params.projection.artifact;
  if (artifact) {
    void loadPlanArtifact(artifact.planId, artifact.revision)
      .then((stored) => {
        if (disposed || !root.isConnected) return;
        if (stored) paint({ artifact: stored });
      })
      .catch((error) => ztoolkit.log("LLM: Failed to hydrate plan:", error));
  }
  return root;
}

function getPlanDocumentId(events: AgentRunEventRecord[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index].payload;
    if (
      event.type === "document_ready" ||
      event.type === "plan_document_ready"
    ) {
      return event.documentId;
    }
  }
  return null;
}

function createDocumentActionButton(params: {
  doc: Document;
  className: string;
  title: string;
}): HTMLButtonElement {
  const button = params.doc.createElement("button") as HTMLButtonElement;
  button.type = "button";
  button.className = `llm-plan-document-action ${params.className}`;
  button.title = params.title;
  button.setAttribute("aria-label", params.title);
  return button;
}

function renderCoverageInspector(
  doc: Document,
  document: PlanDocument,
): HTMLElement | null {
  if (!document.coverageItems.length) return null;
  const details = doc.createElement("details");
  details.className = "llm-plan-document-coverage";
  const summary = doc.createElement("summary");
  summary.textContent = "View coverage";
  const controls = doc.createElement("div");
  controls.className = "llm-plan-document-coverage-controls";
  const search = doc.createElement("input") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "Search papers";
  search.setAttribute("aria-label", "Search covered papers");
  const filter = doc.createElement("select") as HTMLSelectElement;
  filter.setAttribute("aria-label", "Filter coverage status");
  for (const value of [
    "all",
    "included",
    "excluded",
    "unresolved",
    "unreadable",
    "missing",
  ]) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = value[0].toUpperCase() + value.slice(1);
    filter.appendChild(option);
  }
  controls.append(search, filter);
  const list = doc.createElement("div");
  list.className = "llm-plan-document-coverage-list";
  const paint = () => {
    list.replaceChildren();
    const term = search.value.trim().toLowerCase();
    const status = filter.value;
    for (const entry of document.coverageItems) {
      const title = entry.title || itemTitle(entry.libraryID, entry.itemKey);
      if (status !== "all" && entry.status !== status) continue;
      if (
        term &&
        !`${title} ${entry.reason || ""} ${entry.itemKey}`
          .toLowerCase()
          .includes(term)
      ) {
        continue;
      }
      const row = doc.createElement("div");
      row.className = "llm-plan-document-coverage-row";
      const link = doc.createElement("a");
      const source = {
        libraryID: entry.libraryID,
        itemKey: entry.itemKey,
        evidenceRefs: [],
      };
      link.href = citationSourceHref(source);
      link.textContent = title;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void navigatePlanDocumentCitationSource(source);
      });
      const metadata = doc.createElement("span");
      metadata.textContent = `${entry.status} · ${entry.evidenceDepth}${
        entry.reason ? ` · ${entry.reason}` : ""
      }`;
      row.append(link, metadata);
      list.appendChild(row);
    }
    if (!list.childElementCount) {
      const empty = doc.createElement("div");
      empty.className = "llm-plan-document-coverage-empty";
      empty.textContent = "No matching papers";
      list.appendChild(empty);
    }
  };
  search.addEventListener("input", paint);
  filter.addEventListener("change", paint);
  paint();
  details.append(summary, controls, list);
  return details;
}

type DocumentFilePicker = {
  init?: (parent: unknown, title: string, mode: number) => void;
  appendFilter?: (title: string, pattern: string) => void;
  open?: (callback: (result: number) => void) => void;
  show?: () => number | Promise<number>;
  defaultString?: string;
  defaultExtension?: string;
  file?: string | { path?: string };
  modeSave?: number;
  returnOK?: number;
  returnReplace?: number;
};

async function pickMarkdownExportPath(
  doc: Document,
  defaultName: string,
): Promise<string | null> {
  let Constructor = (
    Zotero as unknown as { FilePicker?: new () => DocumentFilePicker }
  ).FilePicker;
  if (!Constructor) {
    try {
      Constructor = (globalThis as any).ChromeUtils?.importESModule?.(
        "chrome://zotero/content/modules/filePicker.mjs",
      )?.FilePicker;
    } catch {
      Constructor = undefined;
    }
  }
  if (!Constructor) throw new Error("Zotero file picker is unavailable");
  const picker = new Constructor();
  const parent = Zotero.getMainWindow?.() || doc.defaultView;
  picker.init?.(parent, "Export document", picker.modeSave ?? 0);
  picker.defaultString = defaultName.endsWith(".md")
    ? defaultName
    : `${defaultName}.md`;
  picker.defaultExtension = "md";
  picker.appendFilter?.("Markdown", "*.md");
  const result = await new Promise<number>((resolve, reject) => {
    try {
      if (picker.open) picker.open(resolve);
      else if (picker.show)
        void Promise.resolve(picker.show()).then(resolve, reject);
      else resolve(-1);
    } catch (error) {
      reject(error);
    }
  });
  const accepted =
    result === picker.returnOK ||
    result === picker.returnReplace ||
    (picker.returnOK === undefined &&
      picker.returnReplace === undefined &&
      result === 0);
  if (!accepted) return null;
  return typeof picker.file === "string"
    ? picker.file
    : picker.file?.path || null;
}

function renderPlanDocumentCard(params: {
  doc: Document;
  documentId: string;
  citationContext?: import("../assistantRichText").AssistantCitationContext;
  onReady?: () => void;
}): HTMLElement {
  const root = params.doc.createElement("section");
  root.className = "llm-plan-container llm-plan-document-card";
  root.dataset.llmPlanDocumentId = params.documentId;
  root.textContent = "Loading document…";
  let disposed = false;
  cardDisposers.set(root, () => {
    disposed = true;
  });

  const paint = (document: PlanDocument) => {
    root.replaceChildren();
    const { header, actions, content } = createDocumentCardLayout(params.doc, {
      title: document.title,
      status: document.coverageStatus
        ? document.coverageStatus.replace(/_/g, " ")
        : "Ready",
      statusKind: document.validation.integrityValidated
        ? "completed"
        : "failed",
    });
    const actionStatus = params.doc.createElement("span");
    actionStatus.className = "llm-plan-document-action-status";
    const setActionStatus = (text: string, error = false) => {
      if (disposed || !root.isConnected) return;
      actionStatus.textContent = text;
      actionStatus.dataset.error = error ? "true" : "false";
    };
    const copy = createDocumentActionButton({
      doc: params.doc,
      className: "llm-plan-document-action-copy",
      title: "Copy Markdown",
    });
    copy.addEventListener("click", async () => {
      await copyTextToClipboard(root, document.visibleMarkdown);
      setActionStatus("Copied");
    });
    const note = createDocumentActionButton({
      doc: params.doc,
      className: "llm-plan-document-action-note",
      title: "Save into Zotero note",
    });
    note.addEventListener("click", async () => {
      note.disabled = true;
      try {
        const saved = await savePlanDocumentAsNote(document.documentId);
        const label = saved.created ? "Saved as note" : "Note already saved";
        setActionStatus(
          saved.warnings.length
            ? `${label}; ${saved.warnings.join("; ")}`
            : label,
          saved.warnings.length > 0,
        );
      } catch (error) {
        setActionStatus(
          error instanceof Error ? error.message : String(error),
          true,
        );
      } finally {
        note.disabled = false;
      }
    });
    const exportButton = createDocumentActionButton({
      doc: params.doc,
      className: "llm-plan-document-action-export",
      title: "Export Markdown",
    });
    exportButton.addEventListener("click", async () => {
      try {
        const path = await pickMarkdownExportPath(params.doc, document.title);
        if (!path) return;
        await exportPlanDocumentMarkdown(document.documentId, path);
        setActionStatus("Exported");
      } catch (error) {
        setActionStatus(
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    });
    const expand = createDocumentActionButton({
      doc: params.doc,
      className: "llm-plan-document-action-expand",
      title: "Open larger view",
    });
    expand.addEventListener("click", () => {
      if (
        openStandalonePlanDocumentWindow(
          params.doc,
          document,
          params.citationContext,
        )
      ) {
        setActionStatus("Opened in a separate window");
      } else {
        setActionStatus("The document window could not be opened", true);
      }
    });
    actions.append(copy, note, exportButton, expand);
    renderPlanDocumentContent({
      doc: params.doc,
      root: content,
      document,
      citationContext: params.citationContext,
    });
    const coverage = renderCoverageInspector(params.doc, document);
    root.append(header, actionStatus, content);
    const figures = renderPlanDocumentFigures(params.doc, document);
    if (figures) root.appendChild(figures);
    if (coverage) root.appendChild(coverage);
    params.onReady?.();
  };

  void Promise.all([
    loadPlanDocument(params.documentId),
    loadPlanDocumentOutbox(params.documentId),
  ])
    .then(([document, outbox]) => {
      if (disposed || !root.isConnected) return;
      if (!document) {
        root.textContent = "Document is unavailable";
      } else if (outbox?.status !== "delivered") {
        // submit_document persists before the assistant message. Do not expose
        // that durable draft as a finished outcome until message publication
        // and (for Plans) the terminal ledger transition commit together.
        root.textContent = "Publishing document…";
      } else {
        paint(document);
      }
    })
    .catch((error) => {
      if (!disposed && root.isConnected)
        root.textContent =
          error instanceof Error ? error.message : String(error);
    });
  return root;
}

type TraceItemView = { signature: string; node: HTMLElement };
type TraceView = {
  discovery?: { key: string; node: HTMLElement };
  list: HTMLElement;
  items: Map<string, TraceItemView>;
  plan?: { signature: string; node: HTMLElement };
  document?: {
    id: string;
    formattingVersion: number;
    panelItem?: Zotero.Item;
    user?: Message | null;
    message: Message;
    node: HTMLElement;
    caption: HTMLElement;
  };
  allowPlanRecovery?: boolean;
  eventCount?: number;
  lastEvent?: AgentRunEventRecord;
  quoteCitations?: Message["quoteCitations"];
  quoteOverride?: Message["quoteDisplayOverride"];
  formattingVersion?: number;
};
const traceViews = new WeakMap<HTMLElement, TraceView>();

export function disposeAgentTrace(root: HTMLElement): void {
  const view = traceViews.get(root);
  if (!view) return;
  for (const item of view.items.values()) disposeStreamingMarkdown(item.node);
  if (view.plan) disposePlanCard(view.plan.node);
  if (view.document) disposePlanCard(view.document.node);
  traceViews.delete(root);
}

function updateReasoningText(target: HTMLElement, next: string): void {
  const text = target.firstChild;
  const previous = target.textContent || "";
  if (previous === next) return;
  if (
    text?.nodeType === 3 &&
    target.childNodes.length === 1 &&
    next.startsWith(previous)
  ) {
    (text as Text).appendData(next.slice(previous.length));
  } else target.textContent = next;
}

export function renderAgentTrace({
  doc,
  panelItem,
  message,
  userMessage,
  events,
  onTraceMissing,
  onInterleavedText,
  previous,
  allowPlanRecovery = false,
}: RenderAgentTraceParams): HTMLElement | null {
  const runId = message.agentRunId?.trim() || "pending";
  // Temporary native events remain visible until the durable run is loaded.
  // The caller supplies this callback only while that run is absent from cache.
  onTraceMissing?.();
  if (!events.length && message.pendingAgentTraceEvents?.length)
    events = message.pendingAgentTraceEvents;
  if (
    !events.length &&
    !message.pendingAgentTraceEvents?.length &&
    !onTraceMissing
  ) {
    return null;
  }
  const retained = previous ? traceViews.get(previous) : undefined;
  const wrap = retained ? previous! : doc.createElement("div");
  if (!retained) wrap.className = "llm-agent-activity";
  if (!retained)
    applyStableAnimationPhase(
      wrap,
      message.waitingAnimationStartedAt ||
        events.find((entry) => entry.createdAt > 0)?.createdAt ||
        message.timestamp,
    );
  const list = retained?.list || doc.createElement("div");
  list.className = "llm-agent-activity-list";
  const view: TraceView = retained || { list, items: new Map() };
  traceViews.set(wrap, view);
  const added =
    retained &&
    view.eventCount !== undefined &&
    events[view.eventCount - 1] === view.lastEvent
      ? events.slice(view.eventCount)
      : null;
  const formattingChanged =
    view.quoteCitations !== message.quoteCitations ||
    view.quoteOverride !== message.quoteDisplayOverride;
  if (formattingChanged)
    view.formattingVersion = (view.formattingVersion || 0) + 1;
  view.quoteCitations = message.quoteCitations;
  view.quoteOverride = message.quoteDisplayOverride;
  const textOnly =
    view.allowPlanRecovery === allowPlanRecovery &&
    message.streaming !== false &&
    !formattingChanged &&
    added &&
    added.every(
      (entry) =>
        entry.payload.type === "reasoning" ||
        entry.payload.type === "message_delta",
    );
  view.allowPlanRecovery = allowPlanRecovery;
  view.eventCount = events.length;
  view.lastEvent = events[events.length - 1];

  if (!events.length) {
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
    appendAgentActivityDisclosure({
      doc,
      wrap,
      list,
      message,
      userMessage,
      events,
      forceOpen: true,
    });
    return wrap;
  }
  const { items: processItems, inlineTextReplacesAssistantText } =
    buildAgentTraceDisplayItems(events, userMessage, message);
  const tracePlanPhase = resolveTracePlanPhase(events);
  if (inlineTextReplacesAssistantText) {
    onInterleavedText?.();
  }
  const pending = getPendingConfirmation(events);
  if (!textOnly) {
    wrap.className = "llm-agent-activity";
    delete wrap.dataset.llmAssistantTurnReplacement;
  }
  if (pending) {
    wrap.classList.add("llm-agent-activity-with-pending-action");
  }
  if (pending && isPlanningQuestionAction(pending.action)) {
    wrap.classList.add("llm-agent-activity-question-card");
    wrap.dataset.llmAssistantTurnReplacement = "true";
    onInterleavedText?.();
    if (view.plan) {
      disposePlanCard(view.plan.node);
      view.plan = undefined;
    }
    if (view.document) {
      disposePlanCard(view.document.node);
      view.document = undefined;
    }
    wrap.replaceChildren(renderPendingActionCard(doc, pending));
    view.items.clear();
    return wrap;
  }
  const hasFinalResponse = events.some(
    (entry) => entry.payload.type === "final",
  );
  let cursor = list.firstChild;
  const nextViews = new Map<string, TraceItemView>();
  let currentKey = "";
  let currentSignature = "";
  const place = (node: HTMLElement) => {
    if (node !== cursor) list.insertBefore(node, cursor);
    cursor = node.nextSibling;
    nextViews.set(currentKey, { signature: currentSignature, node });
  };
  for (const [itemIndex, itemEntry] of processItems.entries()) {
    currentKey =
      itemEntry.type === "reasoning"
        ? `reasoning:${itemEntry.key}`
        : itemEntry.type === "action" && itemEntry.detailKey
          ? `action:${itemEntry.detailKey}`
          : `${itemEntry.type}:${itemIndex}`;
    currentSignature = JSON.stringify(itemEntry);
    if (
      itemEntry.type === "inline_text" ||
      (itemEntry.type === "message" && itemEntry.markdown)
    )
      currentSignature += `:${view.formattingVersion || 0}`;
    const old = view.items.get(currentKey);
    if (old?.signature === currentSignature) {
      place(old.node);
      continue;
    }
    if (old && itemEntry.type === "inline_text" && message.streaming) {
      renderStreamingMarkdownInto(
        old.node,
        buildAgentTraceMarkdownForRender(itemEntry.text, message),
        doc,
        () => {},
      );
      place(old.node);
      continue;
    }
    if (old && itemEntry.type === "reasoning") {
      const target = old.node.querySelector<HTMLElement>(
        ".llm-agent-reasoning-text",
      );
      if (target) {
        updateReasoningText(
          target,
          itemEntry.summary || itemEntry.details || "",
        );
        const label = old.node.querySelector("summary");
        if (label && label.textContent !== itemEntry.label)
          label.textContent = itemEntry.label;
        place(old.node);
        continue;
      }
    }
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
      place(inlineEl);
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
      place(messageEl);
      continue;
    }

    if (itemEntry.type === "card_list") {
      const papers = itemEntry.cards.filter(
        (card) => card.kind !== "saved_note" && card.kind !== "note_change",
      );
      if (papers.length) place(renderResultCardList(doc, papers));
      continue;
    }

    if (itemEntry.type === "image_grid") {
      const container = doc.createElement("div") as HTMLDivElement;
      container.className = "llm-agent-image-artifacts";
      const rendered = renderAssistantGeneratedImagesInto(
        container,
        itemEntry.images,
        doc,
        {
          wrapClassName: "llm-agent-image-artifacts-grid",
          frameClassName: "llm-agent-image-artifact-frame",
        },
      );
      if (rendered) place(container);
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
      place(details);
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
    const isActivePlanningRow =
      message.streaming === true &&
      tracePlanPhase === "planning" &&
      itemEntry.row.kind === "plan" &&
      /^planning\b/i.test(itemEntry.row.text.trim());
    if (isActivePlanningRow) {
      row.classList.add("llm-at-row-planning-active");
    }
    const icon = isActivePlanningRow
      ? createPlanningDriveIcon(doc)
      : doc.createElement("span");
    if (!isActivePlanningRow) {
      icon.className = `llm-at-icon${
        itemEntry.row.iconName ? ` llm-at-icon-${itemEntry.row.iconName}` : ""
      }`;
      icon.setAttribute("aria-hidden", "true");
      if (!itemEntry.row.iconName) icon.textContent = itemEntry.row.icon;
    }
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

    place(actionWrap);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    list.removeChild(cursor);
    cursor = next;
  }
  for (const [key, old] of view.items) {
    if (nextViews.get(key)?.node !== old.node)
      disposeStreamingMarkdown(old.node);
  }
  view.items = nextViews;
  if (textOnly) {
    if (view.document || (view.plan && getPlanProjection(events)?.artifact))
      onInterleavedText?.();
    return wrap;
  }

  if (retained) {
    for (const child of Array.from(wrap.children)) {
      if (
        child !== list.parentElement &&
        child !== view.plan?.node &&
        child !== view.document?.node &&
        child !== view.document?.caption &&
        child !== view.discovery?.node
      )
        child?.remove();
    }
  }
  appendAgentActivityDisclosure({
    doc,
    wrap,
    list,
    message,
    userMessage,
    events,
    forceOpen: Boolean(pending),
  });

  let hasSavedNote = false;
  const shownNoteActions = new Map<
    string,
    AgentNoteChangeResultCard | AgentSavedNoteResultCard
  >();
  for (const item of processItems) {
    if (item.type !== "card_list") continue;
    for (const card of item.cards) {
      if (card.kind === "note_change") {
        shownNoteActions.set(card.actionId, card);
      }
      if (card.kind === "saved_note") {
        hasSavedNote = true;
        if (card.actionId) shownNoteActions.set(card.actionId, card);
        else wrap.appendChild(renderSavedNoteCard(doc, card));
      }
    }
  }

  for (const card of shownNoteActions.values())
    wrap.appendChild(
      card.kind === "note_change"
        ? renderNoteChangeCard(doc, card)
        : renderSavedNoteCard(doc, card),
    );

  const planProjection = getPlanProjection(events);
  const visiblePlanProjection =
    planProjection?.artifact ||
    (allowPlanRecovery && planProjection?.ledger?.status === "interrupted")
      ? planProjection
      : null;
  if (!visiblePlanProjection && view.plan) {
    disposePlanCard(view.plan.node);
    view.plan = undefined;
  }
  if (visiblePlanProjection) {
    // The structured plan is the planning turn's visible answer. Keep the
    // provider's often-duplicated prose in durable history without rendering a
    // second copy below the card. Execution turns still render their final
    // answer normally; the live request owns execution progress separately.
    if (visiblePlanProjection.artifact) onInterleavedText?.();
    const planSignature = JSON.stringify([
      visiblePlanProjection,
      [...(researchDisplayLabels(events) || [])],
    ]);
    if (view.plan?.signature !== planSignature) {
      if (view.plan) disposePlanCard(view.plan.node);
      view.plan = {
        signature: planSignature,
        node: renderPlanContainer({
          doc,
          events,
          projection: visiblePlanProjection,
        }),
      };
    }
    const planContainer = view.plan.node;
    const planId =
      visiblePlanProjection.artifact?.planId ||
      visiblePlanProjection.ledger!.planId;
    for (const node of Array.from(
      doc.querySelectorAll<HTMLElement>(".llm-plan-container"),
    )) {
      const prior = node as HTMLElement;
      if (
        prior.dataset.llmPlanId !== planId ||
        prior.dataset.llmPlanRevision === planContainer.dataset.llmPlanRevision
      ) {
        continue;
      }
      prior.classList.add("llm-plan-history-collapsed");
      if (prior.dataset.llmPlanCollapseBound !== "true") {
        prior.dataset.llmPlanCollapseBound = "true";
        prior
          .querySelector(".llm-plan-header")
          ?.addEventListener("click", () => {
            prior.classList.toggle("llm-plan-history-collapsed");
          });
      }
    }
    if (!planContainer.parentElement) wrap.appendChild(planContainer);
  }

  const planDocumentId =
    message.documentId || message.planDocumentId || getPlanDocumentId(events);
  const savedNotePrimary =
    hasSavedNote &&
    savedNoteIsPrimaryOutcome(
      events.map((record) => record.payload),
      Boolean(planProjection),
    );
  if (savedNotePrimary) onInterleavedText?.();
  if (planDocumentId && !savedNotePrimary) {
    // The immutable card is the visible deliverable. The message text remains
    // byte-identical durable history and future-model context, but rendering it
    // again below the card would create two apparent answers.
    onInterleavedText?.();
    const existing = view.document;
    if (
      !existing ||
      existing.id !== planDocumentId ||
      existing.formattingVersion !== (view.formattingVersion || 0) ||
      existing.panelItem !== panelItem ||
      existing.user !== userMessage ||
      existing.message !== message
    ) {
      if (existing) {
        disposePlanCard(existing.node);
        existing.caption.remove();
      }
      const caption = doc.createElement("p");
      caption.className = "llm-plan-document-completion-caption";
      caption.textContent = "Document completed and verified.";
      caption.hidden = true;
      const card = renderPlanDocumentCard({
        doc,
        documentId: planDocumentId,
        citationContext: panelItem
          ? {
              panelItem,
              assistantMessage: message,
              pairedUserMessage: userMessage,
            }
          : undefined,
        onReady: () => {
          caption.hidden = false;
        },
      });
      view.document = {
        id: planDocumentId,
        formattingVersion: view.formattingVersion || 0,
        panelItem,
        user: userMessage,
        message,
        node: card,
        caption,
      };
      wrap.append(card, caption);
    }
  } else if (view.document) {
    disposePlanCard(view.document.node);
    view.document.caption.remove();
    view.document = undefined;
  }

  // The rule separates the activity trace from the answer, so visible answer
  // text is authoritative even when a restored row retained a stale streaming
  // flag or no longer has its original `final` event.
  const hasAnswerText = Boolean(message.text?.trim());
  if (
    !planDocumentId &&
    (hasFinalResponse || (hasAnswerText && !inlineTextReplacesAssistantText))
  ) {
    const divider = doc.createElement("div");
    divider.className = "llm-agent-output-divider";
    divider.setAttribute("aria-hidden", "true");
    wrap.appendChild(divider);
  }

  const discovery = getDiscoveryCardProjection(events);
  if (discovery && message.streaming === false) discovery.phase = "closed";
  if (discovery) {
    const identity = discovery.pending.action.discovery!;
    const key = `${identity.sessionId}:${identity.revision}:${discovery.phase}`;
    if (view.discovery?.key !== key) {
      const previousScroll =
        view.discovery?.node.querySelector(".llm-search-results-list")
          ?.scrollTop || 0;
      view.discovery?.node.remove();
      const shell = doc.createElement("div");
      shell.className = "llm-agent-pending-action-shell";
      shell.dataset.discoverySession = identity.sessionId;
      const card = renderPendingActionCard(doc, discovery.pending);
      if (discovery.phase !== "pending") {
        for (const control of Array.from(
          card.querySelectorAll("input,button,select,textarea"),
        ) as (HTMLInputElement | HTMLButtonElement | HTMLSelectElement)[])
          control.disabled = true;
        const status = doc.createElement("div");
        status.className = "llm-agent-hitl-description";
        status.setAttribute("role", "status");
        status.textContent =
          discovery.phase === "loading"
            ? "Finding more relevant papers…"
            : "Paper review closed.";
        card.prepend(status);
      }
      shell.appendChild(card);
      view.discovery = { key, node: shell };
      wrap.appendChild(shell);
      const resultList = card.querySelector(".llm-search-results-list");
      if (resultList) resultList.scrollTop = previousScroll;
    } else if (view.discovery.node.parentElement !== wrap)
      wrap.appendChild(view.discovery.node);
  } else if (view.discovery) {
    view.discovery.node.remove();
    view.discovery = undefined;
  }
  if (pending && !pending.action.discovery) {
    const pendingShell = doc.createElement("div");
    pendingShell.className = "llm-agent-pending-action-shell";
    pendingShell.appendChild(renderPendingActionCard(doc, pending));
    wrap.appendChild(pendingShell);
  }

  return wrap;
}
