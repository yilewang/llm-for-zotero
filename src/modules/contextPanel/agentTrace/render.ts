import { fnv1a32Raw } from "../../../utils/fnv1a";
import type {
  AgentActionSummaryResultCard,
  AgentNoteChangeResultCard,
  AgentSavedNoteResultCard,
} from "../../../agent/types";
import { projectPaperReferences } from "../../../shared/paperDisplayLabels";
import type { AgentActionVerification } from "../../../agent/contracts/actionVerificationLabels";
import {
  AGENT_ACTION_VERIFICATION_LABELS,
  worstAgentActionVerification,
} from "../../../agent/contracts/actionVerificationLabels";
import {
  exportPlanDocumentMarkdown,
  savePlanDocumentAsNote,
} from "../../../agent/documents/actions";
import {
  loadPlanDocument,
  loadPlanDocumentOutbox,
} from "../../../agent/documents/store";
import type { PlanDocument } from "../../../agent/documents/types";
import { subscribeDocumentPublication } from "../../../agent/documents/publicationEvents";
import { documentMessageLead } from "../../../agent/documents/publication";
import {
  isContentLikeToolArgumentKey,
  isMalformedToolArgumentsDiagnostic,
} from "../../../agent/toolArgumentDiagnostics";
import type {
  AgentActionReceipt,
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
  AgentStage,
  AgentWorkCategory,
} from "../../../agent/types";
import { SKILL_ACTIVATION_TRACE_LABEL } from "../../../agent/workCategory";
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
} from "../../../services/context/normalizers";
import {
  planDocumentCitationSourceHref as citationSourceHref,
  getPlanDocumentItemTitle as itemTitle,
  navigatePlanDocumentCitationSource,
  renderPlanDocumentContent,
  renderPlanDocumentFigures,
} from "../planDocumentPresentation";
import { buildAssistantDisplayMarkdownForRender } from "../assistantRichText";
import { renderRenderedMarkdownInto } from "../renderedMarkdown";
import { applyStableAnimationPhase } from "../stableAnimationPhase";
import { isCodexPlanChecklistEvent } from "../taskProgress/codexPlan";
import { PLAN_STATUS_SYMBOLS } from "../taskProgress/planSteps";
import { openStandalonePlanDocumentWindow } from "../standalonePlanDocumentWindow";
import {
  readStoredPlanEvent,
  type StoredPlanArtifact,
  type StoredPlanExecution,
} from "./storedPlanEvents";
import {
  disposeStreamingMarkdown,
  renderStreamingMarkdownInto,
} from "../streamingMarkdown";
import { sanitizeText } from "../../../utils/textSanitization";
import type { Message, PaperContextRef } from "../types";
import { createWebFaviconImage } from "../webFavicon";
import {
  buildAgentActionSummaryCard,
  renderActionSummaryCard,
} from "./actionSummaryCard";
import type { NavigationHost } from "./actionCardNavigation";
import { actionCardNoteMode, attachNoteDetails } from "./actionCardModel";
import { renderActionCardDetail } from "./actionCardNoteDetail";
import { createZoteroActionCardResolvers } from "./actionCardResolvers";
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
  isTruncatedToolResultContent,
  toolResultContentForDisplay,
} from "../../../agent/store/truncatedToolResult";
import { getAgentRuntime } from "../../../agent";
import { projectStageEvents } from "./stageProjection";
import { resolveAgentToolPresentation } from "./toolPresentation";
import {
  compactAgentTraceEvents,
  createAgentTraceCompactor,
  getReasoningTraceKey,
  normalizeInlineTextForDedupe,
  appendAgentTraceText,
  type AgentTraceCompactor,
} from "./traceReducer";
import {
  applyAgentTraceEventToScan,
  createAgentTraceEventScan,
  readPendingConfirmation,
  readTraceDisplayLabels,
  readTracePlanPhase,
  scanAgentTraceEvents,
  type AgentTraceEventScan,
} from "./traceEventScan";

type AgentTraceSummaryKind = "plan" | "tool" | "ok" | "skip" | "done";

type AgentTraceSummaryRow = {
  kind: AgentTraceSummaryKind;
  icon: string;
  iconName?: "library" | "web";
  text: string;
  /** Optional code block shown below the summary text (e.g. shell commands). */
  codeBlock?: string;
};

type AgentStagePayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "agent_stage" }
>;
type AgentStageStatus = AgentStagePayload["status"];

/**
 * What each stage is called for the reader.
 *
 * The stage vocabulary is the agent's own `AgentWorkCategory`; these are the
 * product words for it, kept here because they are presentation and nowhere
 * else in the system needs them. `external_system` is the category's name and
 * "External action" is the reader's.
 */
const AGENT_STAGE_LABELS: Readonly<Record<AgentStage, string>> = {
  retrieval: "Read evidence",
  planning: "Planning",
  generation: "Generated material",
  zotero_action: "Zotero action",
  external_system: "External action",
};

/**
 * The label for a run that declared no stage at all.
 *
 * Such a trace predates the work-category contract, so its one projected
 * stage covers everything the run did and must not claim to be any of them.
 */
const UNDIFFERENTIATED_AGENT_STAGE_LABEL = "Agent activity";

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
      workCategory?: AgentWorkCategory;
      /**
       * The row that announces what its whole stage produced: the material a
       * generation stage finalized, or the material write a Zotero action
       * landed. Its stage names itself after it rather than repeating it.
       */
      stageHeadline?: boolean;
    }
  | {
      type: "stage";
      /** Stable across re-renders so the retained view keeps this node. */
      key: string;
      stage: AgentStage;
      status: AgentStageStatus;
      label: string;
      chips?: AgentTraceChip[];
      /** Reconstructed for a trace recorded before stages existed. */
      projected?: boolean;
      children: AgentTraceDisplayItem[];
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
  onTraceMissing?: () => void;
  onInterleavedText?: () => void;
  /** The conversation owns this footer below the assistant's final answer. */
  actionSummaryHost?: HTMLElement;
  /** Where the action card's chips take the reader; the running Zotero by default. */
  actionCardNavigation?: NavigationHost;
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
  eventTimes: { first: number; last: number },
): number {
  const firstEventAt = eventTimes.first;
  const waitingStartedAt = Number(message.waitingAnimationStartedAt);
  const userStartedAt = Number(userMessage?.timestamp);
  const messageTimestamp = Number(message.timestamp);
  const start =
    (Number.isFinite(waitingStartedAt) && waitingStartedAt > 0
      ? waitingStartedAt
      : 0) ||
    (firstEventAt > 0 ? firstEventAt : 0) ||
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
        eventTimes.last > 0 ? eventTimes.last : 0,
      );
  return Math.max(0, end - start);
}

function appendAgentActivityDisclosure(params: {
  doc: Document;
  wrap: HTMLElement;
  list: HTMLElement;
  message: Message;
  userMessage?: Message | null;
  scan: AgentTraceEventScan;
  forceOpen?: boolean;
}): void {
  const { doc, wrap, list, message, userMessage, scan } = params;
  const working = message.streaming === true;
  const planPhase = scan.planPhase;
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
  const durationMs = resolveAgentActivityDurationMs(message, userMessage, {
    first: scan.minCreatedAt,
    last: scan.maxCreatedAt,
  });
  const view = traceViews.get(wrap)!;
  if (working) {
    let label = summary.querySelector(".llm-agent-activity-label");
    if (!label) {
      label = doc.createElement("span");
      label.className = "llm-agent-activity-label llm-text-shimmer";
      summary.replaceChildren(label);
    }
    label.textContent =
      planPhase === "planning"
        ? "Planning"
        : planPhase === "executing"
          ? "Executing plan"
          : "Working";
    if (!view.activityClock) {
      const elapsed = doc.createElement("span");
      elapsed.className = "llm-agent-activity-elapsed";
      elapsed.setAttribute("role", "timer");
      elapsed.setAttribute("aria-live", "off");
      summary.appendChild(elapsed);
      const win = doc.defaultView;
      const clock = {
        startedAt: Date.now() - durationMs,
        paint: () => {
          const totalSeconds = Math.max(
            0,
            Math.floor((Date.now() - clock.startedAt) / 1000),
          );
          const seconds = String(totalSeconds % 60);
          const text =
            totalSeconds < 60
              ? `${seconds}s`
              : `${Math.floor(totalSeconds / 60)}m ${seconds.padStart(2, "0")}s`;
          if (elapsed.textContent !== text) elapsed.textContent = text;
        },
        stop: () => {
          if (timer !== undefined) win?.clearInterval(timer);
          view.activityClock = undefined;
        },
      };
      // Only this text node ticks: it must not refresh the transcript or run
      // scroll restoration. Wall time also catches up after a background pause.
      const timer = win?.setInterval(() => {
        if (!elapsed.isConnected) clock.stop();
        else clock.paint();
      }, 1000);
      view.activityClock = clock;
    }
    view.activityClock.startedAt = Date.now() - durationMs;
    view.activityClock.paint();
  } else {
    view.activityClock?.stop();
    const duration = formatAgentActivityDuration(durationMs);
    summary.replaceChildren();
    summary.textContent =
      planPhase === "planning"
        ? `Planned in ${duration}`
        : planPhase === "executing"
          ? `Plan ran for ${duration}`
          : `Worked for ${duration}`;
  }
  if (mounted) return;
  details.append(summary, list);
  details.addEventListener("toggle", () => {
    agentActivityExpandedCache.set(message, {
      open: details.open,
      // Native toggle events are queued. The message may already be complete
      // before this running view is repainted; keep the last rendered phase so
      // that its delayed opening cannot masquerade as a user's completed-view
      // expansion and bypass the one-time collapse on completion.
      wasWorking: view.streaming === true,
    });
  });
  wrap.appendChild(details);
}

function resolveTracePlanPhase(
  events: readonly AgentRunEventRecord[],
): "planning" | "executing" | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const phase = readTracePlanPhase(events[index]?.payload);
    if (phase) return phase;
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
  cards: Exclude<
    AgentToolResultCard,
    { kind: "saved_note" | "note_change" | "action_summary" }
  >[],
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

/**
 * Whether this card is a question the run is waiting on, rather than an
 * approval of prepared work. The action says so: the host stamps the
 * interaction kind its tool declared.
 */
function isPlanningQuestionAction(action: AgentPendingAction): boolean {
  return (
    action.interaction === "user_input" &&
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

/**
 * Whether this tool asked to stay out of the trace.
 *
 * The name is the registry key and nothing more; the answer is the tool's own
 * declaration. A trace of a tool the registry no longer knows shows its rows,
 * which is the right failure: a row the reader can read beats a row silently
 * dropped because a name matched a list written years earlier.
 */
function isToolHiddenFromTrace(name: string): boolean {
  return resolveAgentToolPresentation(name)?.hiddenInTrace === true;
}

/**
 * What to call a tool in a row.
 *
 * The run stamps the tool's own label on every event it emits, so a trace
 * recorded months ago still reads the way it read when it ran. Only an event
 * from before that (or one a connected client relayed without a label) falls
 * back to the live registry, and then to title-casing the identifier.
 */
function toolLabelFromEvent(name: string, eventLabel?: string): string {
  const stamped = readAgentTraceText(eventLabel);
  if (stamped) return stamped;
  const explicitLabel = resolveAgentToolPresentation(name)?.label?.trim();
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
  const customChips = resolveAgentToolPresentation(toolName)?.buildChips?.({
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

function buildAgentTraceArgsDetails(
  toolName: string | undefined,
  args: unknown,
): AgentTraceDetail[] {
  const details: AgentTraceDetail[] = [];
  const record = isAgentTraceRecord(args) ? args : null;
  // A tool that knows which of its argument spellings matter says so itself.
  if (toolName) {
    try {
      details.push(
        ...(resolveAgentToolPresentation(toolName)?.buildTraceArgDetails?.({
          args,
        }) ?? []),
      );
    } catch {
      // Display-only formatting must never take the trace down with it.
    }
  }
  if (record) {
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

/**
 * The words for a skill activation, when the event is one.
 *
 * Skill activation reaches the trace as an event its producer labelled, with
 * the skill it activated in the event's arguments. Both sides read that label
 * from one constant, so the row recognises exactly what the bridge stamped
 * and never asks what the call was named.
 */
function skillActivationText(label: string, args: unknown): string | null {
  if (label !== SKILL_ACTIVATION_TRACE_LABEL) return null;
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const skill = readAgentTraceText(record.skill);
  if (!skill) return null;
  const source = readAgentTraceText(record.source);
  const verb =
    source === "codex-native-slash" ? "Invoked Skill" : "Using Skill";
  return `${verb}: ${skill}`;
}

function summarizeAgentTraceToolCall(
  name: string,
  args: unknown,
  toolLabel?: string,
  request?: AgentTraceRequestSummary,
  resultInfo?: ToolResultTraceInfo,
): AgentTraceSummaryRow {
  const label = toolLabelFromEvent(name, toolLabel);
  const presentation = resolveAgentToolPresentation(name);
  let codeBlock: ReturnType<
    NonNullable<typeof presentation>["buildTraceCodeBlock"] & object
  > | null = null;
  try {
    codeBlock = presentation?.buildTraceCodeBlock?.({ args }) ?? null;
  } catch {
    codeBlock = null;
  }
  const text =
    resolveToolPresentationSummary(presentation?.summaries?.onCall, {
      label,
      args,
      request,
    }) ||
    skillActivationText(label, args) ||
    `Using ${label}`;
  const displayText =
    resultInfo?.rowSuffix && text === `Using ${label}`
      ? `${text} ${resultInfo.rowSuffix}`
      : text;

  return {
    kind: "tool",
    icon: "→",
    ...(presentation?.traceIcon ? { iconName: presentation.traceIcon } : {}),
    // A block that already carries what the summary would say leaves the row
    // to name the tool instead of repeating the block one line up.
    text: codeBlock?.replacesSummary ? label : displayText,
    ...(codeBlock?.code ? { codeBlock: codeBlock.code } : {}),
  };
}

/** Note operations are the only ones that consume finalized material today. */
const NOTE_WRITE_ACTION_OPERATIONS = new Set([
  "note_create",
  "note_edit",
  "note_append",
]);

/** Model-authored labels are capped so one long title cannot own the trace. */
const MATERIAL_LABEL_MAX_LENGTH = 120;

type TraceMaterialAnnouncement = { kind: string; title: string };

function materialLabel(value: unknown, fallback: string): string {
  const text = compactAgentTraceText(value);
  const capped = (text || fallback).slice(0, MATERIAL_LABEL_MAX_LENGTH).trim();
  return capped || fallback;
}

/** What the run finalized, named the way the announcing event named it. */
function readMaterialAnnouncement(
  payload: Extract<
    AgentRunEventRecord["payload"],
    { type: "material_finalized" }
  >,
): { documentId: string; announcement: TraceMaterialAnnouncement } | null {
  const documentId = readAgentTraceText(payload.materialRef?.documentId);
  if (!documentId) return null;
  return {
    documentId,
    announcement: {
      kind: materialLabel(payload.materialKind, "document").replace(
        /[_-]+/gu,
        " ",
      ),
      title: materialLabel(payload.materialTitle, documentId),
    },
  };
}

type BatchItemOutcomePayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "batch_item_outcome" }
>;

/**
 * What one item of a note batch is called in the trace.
 *
 * The durable row key is the only name the announcement carries, so the row
 * reads it instead of inventing one: `item:42` is the item the note was
 * written onto, and a second note onto the same item is `item:42#2`. A key of
 * any other shape is shown as it stands rather than mangled into a number.
 */
function batchItemLabel(itemKey: string): string {
  const parsed = /^item:(\d+)(?:#(\d+))?$/u.exec(itemKey);
  if (!parsed) return itemKey;
  return parsed[2]
    ? `item ${parsed[1]} (note ${parsed[2]})`
    : `item ${parsed[1]}`;
}

/**
 * Whether the announcing call is the one that wrote this note.
 *
 * A resumed batch announces every row it holds, so `saved` alone does not mean
 * this call wrote anything. Events persisted before the batch reported it
 * carry no `written` field, and the row has to treat that as unknown rather
 * than pick a side: reading the absence as `false` would relabel every note of
 * an older run as one the call skipped.
 */
function readBatchItemWritten(
  payload: BatchItemOutcomePayload,
): boolean | undefined {
  const written = (payload as { written?: unknown }).written;
  return typeof written === "boolean" ? written : undefined;
}

/**
 * One row per announced batch item, read from the event and nothing else.
 *
 * Fifty notes written under one approval are fifty separate outcomes, and the
 * tool result can only say how many of each there were. The row names the item
 * and what became of its note, so the trace stays the record of what happened
 * to each one.
 */
function batchItemOutcomeRow(
  payload: BatchItemOutcomePayload,
): AgentTraceSummaryRow {
  const itemKey = readAgentTraceText(payload.itemKey);
  const label = itemKey ? batchItemLabel(itemKey) : "an item";
  if (payload.status === "failed")
    return { kind: "skip", icon: "!", text: `Note write failed for ${label}` };
  if (payload.status === "pending")
    return {
      kind: "skip",
      icon: "…",
      text: `Note not written yet for ${label}`,
    };
  const written = readBatchItemWritten(payload);
  if (written === undefined)
    return { kind: "ok", icon: "✓", text: `Note recorded for ${label}` };
  return written
    ? { kind: "ok", icon: "✓", text: `Saved note for ${label}` }
    : { kind: "ok", icon: "✓", text: `Already saved: ${label}` };
}

/**
 * What a note write proved about the Zotero state it claims to have changed.
 *
 * The fact strings are opaque strength tokens minted by the verifier, so the
 * trace reads their shape and never recomputes a digest.
 */
function noteWriteEvidence(
  receipt: AgentActionReceipt,
): "html_sha256" | "text_match" | null {
  if (receipt.verification !== "verified") return null;
  const facts = receipt.verifiedFacts || [];
  if (facts.some((fact) => /^native_note:.+:html_sha256:.+$/u.test(fact)))
    return "html_sha256";
  if (facts.some((fact) => /^native_note:.+:text_match$/u.test(fact)))
    return "text_match";
  return null;
}

type MaterialNoteWriteOutcome = {
  documentId: string;
  evidence: "html_sha256" | "text_match" | null;
};

/**
 * The material-backed note write a tool result reports, read from its receipts.
 *
 * Identity comes from the receipt's frozen `materialRef` and the proposal
 * operation, never from the tool's name, so a renamed or re-registered write
 * tool still reads as the same journey stage. A cancelled receipt is a denial,
 * which the trace already reports as a cancellation rather than a failure.
 */
function readMaterialNoteWrite(
  payload: Extract<AgentRunEventRecord["payload"], { type: "tool_result" }>,
): MaterialNoteWriteOutcome | null {
  for (const receipt of payload.actionReceipts || []) {
    if (!NOTE_WRITE_ACTION_OPERATIONS.has(receipt.operation)) continue;
    if (receipt.status === "cancelled") return null;
    const documentId = readAgentTraceText(receipt.materialRef?.documentId);
    if (!documentId) continue;
    return { documentId, evidence: noteWriteEvidence(receipt) };
  }
  return null;
}

/**
 * The glyph that carries each verdict at a glance, in the trace's own marks.
 *
 * `not_applicable` is absent on purpose: an action that claimed nothing gets no
 * chip, and the compiler holds the builder to that.
 */
const AGENT_TRACE_VERIFICATION_CHIP_ICONS: Record<
  Exclude<AgentActionVerification, "not_applicable">,
  string
> = {
  verified: "✓",
  execution_only: "▸",
  unverified: "!",
};

/**
 * What a result's receipts proved, and under whose authority they ran.
 *
 * One row carries one verdict, so several receipts collapse to the weakest
 * proof among them: a verified tag write beside an unverified note write is not
 * a verified result. Everything here is read from receipt fields — a tool's
 * name, its wording, and its card builders cannot make an unverified effect
 * look verified.
 *
 * `materialEvidence` says the row is already followed by the Phase 1 material
 * journey row ("Zotero state verified" / "checked (text match)"), which names
 * the same proof and its strength. When that row covers the whole result the
 * chip would repeat it, so it is dropped; a weaker receipt elsewhere in the
 * same result still gets its chip, because the evidence row speaks only for the
 * note write it came from.
 */
function buildAgentTraceVerificationChips(
  receipts: AgentActionReceipt[] | undefined,
  options: { materialEvidence?: boolean } = {},
): AgentTraceChip[] {
  const chips: AgentTraceChip[] = [];
  const verification = worstAgentActionVerification(receipts);
  const coveredByEvidenceRow =
    options.materialEvidence === true && verification === "verified";
  if (
    verification &&
    verification !== "not_applicable" &&
    !coveredByEvidenceRow
  )
    chips.push({
      icon: AGENT_TRACE_VERIFICATION_CHIP_ICONS[verification],
      label: AGENT_ACTION_VERIFICATION_LABELS[verification],
    });
  if (
    (receipts || []).some(
      (receipt) => receipt?.executionAuthority === "external_runtime",
    )
  )
    chips.push({ icon: "↗", label: "Authorized by connected client" });
  return chips;
}

/**
 * The cards a tool result contributes to the trace.
 *
 * Only the tool that produced the result knows whether its payload carries a
 * card, so the decision is the builder's own payload check and never the
 * result's tool name or its receipts: a result journaled before receipts
 * existed still shows the diff that proves what happened. A failed write shows
 * only that diff, because the rest of a card set describes work that did not
 * land.
 */
export function selectToolResultTraceCards(
  payload: Extract<AgentRunEventRecord["payload"], { type: "tool_result" }>,
  buildCards: ((content: unknown) => AgentToolResultCard[] | null) | undefined,
): AgentToolResultCard[] {
  if (!buildCards) return [];
  let cards: AgentToolResultCard[] | null = null;
  try {
    cards = buildCards(payload.content) ?? null;
  } catch {
    // card generation errors must not crash the trace
    return [];
  }
  if (!cards?.length) return [];
  return payload.ok
    ? cards
    : cards.filter(
        (card) =>
          card.kind === "note_change" &&
          ["failed", "mismatch", "unverified"].includes(card.state),
      );
}

/** The material a pending note write would consume, named for the user. */
function pendingNoteMaterialLabel(
  ctx: AgentTraceAdapterContext,
  action: AgentPendingAction,
): string | null {
  const material = action.material;
  if (!material || !NOTE_WRITE_ACTION_OPERATIONS.has(material.operation))
    return null;
  const documentId = readAgentTraceText(material.ref?.documentId);
  if (!documentId) return null;
  return ctx.finalizedMaterials.get(documentId)?.title || documentId;
}

function summarizeAgentTraceConfirmationRequest(
  action: AgentPendingAction,
  request?: AgentTraceRequestSummary,
  materialLabelForNote?: string | null,
): AgentTraceSummaryRow {
  const toolName = action.toolName;
  const label = toolLabelFromEvent(toolName);
  // Material identity outranks the tool's own wording: the user is authorizing
  // one exact document, so the row names it.
  const text = materialLabelForNote
    ? `Waiting for permission to save ${materialLabelForNote} as a note`
    : resolveToolPresentationSummary(
        resolveAgentToolPresentation(toolName)?.summaries?.onPending,
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
  const label = toolLabelFromEvent(toolName);
  const selectedActionLabel =
    action.actions?.find((entry) => entry.id === actionId)?.label ||
    (approved ? action.confirmLabel : action.cancelLabel);
  const planningQuestionCount =
    action.interaction === "user_input" ? action.fields.length : 0;
  const text =
    resolveToolPresentationSummary(
      approved
        ? resolveAgentToolPresentation(toolName)?.summaries?.onApproved
        : resolveAgentToolPresentation(toolName)?.summaries?.onDenied,
      { label, request },
    ) ||
    (approved && planningQuestionCount
      ? `Answered ${planningQuestionCount} planning question${planningQuestionCount === 1 ? "" : "s"}`
      : approved
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

function buildPlanningQuestionTraceDetails(
  action: AgentPendingAction,
  data: unknown,
): AgentTraceDetail[] {
  if (
    action.interaction !== "user_input" ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return [];
  }
  const answers = data as Record<string, unknown>;
  return action.fields.flatMap((field) => {
    const raw = answers[field.id];
    let answer = "";
    if (typeof raw === "string") {
      answer = sanitizeText(raw).trim();
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const choice = raw as Record<string, unknown>;
      if (choice.kind === "custom" && typeof choice.text === "string") {
        answer = sanitizeText(choice.text).trim();
      } else if (
        choice.kind === "option" &&
        typeof choice.optionId === "string" &&
        field.type === "choice"
      ) {
        answer =
          field.options.find((option) => option.id === choice.optionId)
            ?.label || "";
      }
    }
    const question = sanitizeText(field.label || "").trim();
    return question && answer
      ? [normalizeAgentTraceDetail(question, answer, "text")].filter(
          (detail): detail is AgentTraceDetail => Boolean(detail),
        )
      : [];
  });
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
  toolLabel?: string,
  effect?: AgentToolEffect,
  request?: AgentTraceRequestSummary,
): AgentTraceSummaryRow | null {
  const label = toolLabelFromEvent(name, toolLabel);
  const normalized = isAgentTraceRecord(content) ? content : null;
  if (!ok) {
    const rawError = readAgentTraceText(normalized?.error);
    if (rawError?.toLowerCase() === "user denied action") {
      return null;
    }
    const text =
      resolveToolPresentationSummary(
        resolveAgentToolPresentation(name)?.summaries?.onError,
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
        ? resolveAgentToolPresentation(name)?.summaries?.onEmpty
        : resolveAgentToolPresentation(name)?.summaries?.onSuccess,
      { label, content, effect, request },
    ) ||
    resolveToolPresentationSummary(
      resolveAgentToolPresentation(name)?.summaries?.onSuccess,
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
    (toolName
      ? toolLabelFromEvent(toolName, input.toolLabel)
      : readAgentTraceText(input.toolLabel)) || "Zotero MCP tool";
  // Only the tool that ran can say what its relayed artifacts amount to.
  const relayedSummary = toolName
    ? buildRelayedActivitySummary(toolName, input)
    : null;
  if (relayedSummary) {
    return {
      kind: "tool",
      icon: "⌘",
      text: relayedSummary,
      codeBlock: readAgentTraceText(input.codeBlock) || undefined,
    };
  }
  // A skill activation reaches the trace as a relayed row the bridge
  // labelled, with the skill in its arguments; the same reading as a
  // host-run activation, from the same two event fields.
  const skillText = skillActivationText(label, input.args);
  if (skillText) {
    return { kind: "tool", icon: "⌘", text: skillText };
  }
  const verb = input.phase === "completed" ? "Used" : "Using";
  return {
    kind: "tool",
    icon: "⌘",
    text: `${verb} ${label}`,
    codeBlock: readAgentTraceText(input.codeBlock) || undefined,
  };
}

/**
 * The row a connected client's relayed call gets from the tool that ran.
 *
 * The name only locates the spec in the registry; what the row says is the
 * spec's own answer about the arguments and artifacts it was handed.
 */
function buildRelayedActivitySummary(
  toolName: string,
  input: {
    phase: "started" | "completed";
    args?: unknown;
    ok?: boolean;
    artifacts?: AgentToolArtifact[];
  },
): string | null {
  const buildTraceSummary = resolveAgentToolPresentation(
    normalizeMcpToolName(toolName),
  )?.buildTraceSummary;
  if (!buildTraceSummary) return null;
  try {
    return (
      buildTraceSummary({
        args: input.args,
        artifacts: input.artifacts,
        phase: input.phase,
        ok: input.ok,
      }) || null
    );
  } catch {
    return null;
  }
}

function normalizeMcpToolName(value: string): string {
  const clean = value.trim();
  const match = clean.match(/^mcp__.+__(.+)$/);
  return match?.[1] || clean;
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

export function isGenericAgentStatusText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "running agent" ||
    // "(round n)"; runs recorded before it said "(n/24)" or "(segment 2, n/32)".
    /^continuing agent \((?:round \d+|(?:segment \d+, )?\d+\/\d+)\)$/.test(
      normalized,
    ) ||
    /^checkpointed agent segment \d+; continuing$/.test(normalized)
  );
}

/**
 * A long job's progress, "Continuing agent (page 2 · 7 of 30)": the live
 * status shows it as written, and the trace does not repeat it every round.
 */
export function isAgentPageProgressText(text: string): boolean {
  return /^continuing agent \(page \d+ · \d+ of \d+\)$/.test(
    text.trim().toLowerCase(),
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
    // The adapter reworded this status once already; match the prefix so any
    // future rewording stays hidden instead of leaking into the trace.
    /^Claude runtime changed\./i.test(text) ||
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

/** `chunk` is already sanitized: the caller remembers it per payload. */
function appendInterleavedInlineText(
  items: AgentTraceDisplayItem[],
  chunk: string,
  visibleInlineText: Set<string>,
): void {
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

function getFinalTraceText(events: readonly AgentRunEventRecord[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (entry?.payload.type === "final") {
      return sanitizeText(entry.payload.text || "").trim();
    }
  }
  return "";
}

/**
 * Inline text the answer bubble already shows. Text the model streamed before
 * a tool call and the host kept (an intermediate item) is part of the final
 * answer; so is the text streamed after it, which ends the answer.
 */
function shouldSuppressInlineFinalAnswer(
  item: AgentTraceDisplayItem,
  finalText: string,
  intermediate: boolean,
): boolean {
  if (item.type !== "inline_text") return false;
  const finalKey = normalizeInlineTextForDedupe(finalText);
  const itemKey = normalizeInlineTextForDedupe(item.text);
  if (!finalKey || !itemKey) return false;
  if (finalKey === itemKey) return true;
  if (!intermediate) return finalKey.endsWith(` ${itemKey}`);
  return itemKey.length >= 40 && finalKey.includes(itemKey);
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
  /** Material this run announced as finalized, keyed by document id. */
  finalizedMaterials: Map<string, TraceMaterialAnnouncement>;
  /** Documents whose note write failed in this run. */
  failedMaterialWrites: Set<string>;
};

/**
 * Events whose row does not turn already-streamed text into an intermediate
 * draft.
 *
 * `message_delta` and `message_rollback` are that text. `final` and
 * `material_finalized` announce the answer itself rather than a step the agent
 * took before writing it, so a run that streams a draft and then finalizes its
 * material must still show one collapsed "Drafting answer" row.
 */
const NON_INTERLEAVING_TRACE_EVENT_TYPES = new Set<
  AgentRunEventRecord["payload"]["type"]
>(["message_delta", "message_rollback", "final", "material_finalized"]);

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

type TraceToolCallPayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "tool_call" }
>;
type TraceToolResultPayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "tool_result" }
>;

/**
 * How often the trace read a tool result's payload, for tests only.
 *
 * A result can be megabytes of paper text and is read on every refresh of a
 * live run; each payload must be read once and remembered.
 */
const agentTraceProjectionCounters = {
  toolResultTraceInfo: 0,
  toolResultCards: 0,
  toolCallDetails: 0,
  /** Live refreshes that patched the last thinking block alone. */
  liveReasoningPatches: 0,
  /** Live refreshes that walked the folded trace. */
  liveWalks: 0,
  /** Live states started over from the first event. */
  liveResets: 0,
};

export function readAgentTraceProjectionCountersForTests(): Readonly<
  typeof agentTraceProjectionCounters
> {
  return { ...agentTraceProjectionCounters };
}

export function resetAgentTraceProjectionCountersForTests(): void {
  for (const key of Object.keys(agentTraceProjectionCounters))
    agentTraceProjectionCounters[
      key as keyof typeof agentTraceProjectionCounters
    ] = 0;
}

/*
 * What the trace reads from one event payload, remembered by that payload.
 * Stored events are never rewritten in place (a changed event is a new
 * record), so a payload's projection holds for as long as the payload does,
 * and a refresh reads each result once however often it repaints.
 */
const toolResultTraceInfoMemo = new WeakMap<
  TraceToolResultPayload,
  ToolResultTraceInfo | null
>();
const toolResultCardsMemo = new WeakMap<
  TraceToolResultPayload,
  {
    build: Parameters<typeof selectToolResultTraceCards>[1];
    cards: AgentToolResultCard[];
  }
>();
type TraceToolCallProjection = {
  result: TraceToolResultPayload | undefined;
  presentation: ReturnType<typeof resolveAgentToolPresentation>;
  resultInfo: ToolResultTraceInfo | null;
  details: AgentTraceDetail[];
  summary: string | null;
};
const toolCallProjectionMemo = new WeakMap<
  TraceToolCallPayload,
  TraceToolCallProjection
>();
/** Shared details arrays, so a row's signature need not serialize them. */
const memoizedTraceDetailIds = new WeakMap<AgentTraceDetail[], number>();
let nextMemoizedTraceDetailId = 0;
const sanitizedMessageDeltaMemo = new WeakMap<object, string>();

function projectToolResultTraceInfo(
  result: TraceToolResultPayload | undefined,
): ToolResultTraceInfo | null {
  if (!result) return null;
  const known = toolResultTraceInfoMemo.get(result);
  if (known !== undefined) return known;
  agentTraceProjectionCounters.toolResultTraceInfo += 1;
  const info = buildToolResultTraceInfo(result);
  toolResultTraceInfoMemo.set(result, info);
  return info;
}

function projectToolResultCards(
  payload: TraceToolResultPayload,
  build: Parameters<typeof selectToolResultTraceCards>[1],
): AgentToolResultCard[] {
  const known = toolResultCardsMemo.get(payload);
  if (known && known.build === build) return known.cards.slice();
  agentTraceProjectionCounters.toolResultCards += 1;
  const cards = selectToolResultTraceCards(payload, build);
  toolResultCardsMemo.set(payload, { build, cards });
  return cards.slice();
}

/** The parts of a call row read from its arguments and its result. */
function projectToolCall(
  payload: TraceToolCallPayload,
  result: TraceToolResultPayload | undefined,
): TraceToolCallProjection {
  const presentation = resolveAgentToolPresentation(payload.name);
  const known = toolCallProjectionMemo.get(payload);
  if (known && known.result === result && known.presentation === presentation)
    return known;
  agentTraceProjectionCounters.toolCallDetails += 1;
  const resultInfo = projectToolResultTraceInfo(result);
  // A result the trace stored by handle is read from its preview.
  const resultContent = toolResultContentForDisplay(result?.content);
  const storedByHandle = isTruncatedToolResultContent(result?.content);
  let presentationDetails: AgentTraceDetail[] = [];
  if (result) {
    try {
      presentationDetails =
        presentation?.buildTraceDetails?.({
          args: payload.args,
          content: resultContent,
        }) ?? [];
    } catch {
      presentationDetails = [];
    }
  }
  const details = dedupeAgentTraceDetails(
    presentationDetails.length
      ? [
          ...presentationDetails,
          // A stored result also says how big it was and where it is.
          ...(storedByHandle
            ? (resultInfo?.details || []).filter(
                (detail) =>
                  detail.label === "Result size" ||
                  detail.label === "Stored by handle",
              )
            : []),
        ]
      : [
          ...buildAgentTraceArgsDetails(payload.name, payload.args),
          ...(resultInfo?.details || []),
        ],
  );
  memoizedTraceDetailIds.set(details, (nextMemoizedTraceDetailId += 1));
  let summary: string | null = null;
  if (result?.ok && presentation?.buildTraceSummary) {
    try {
      summary =
        presentation.buildTraceSummary({
          args: payload.args,
          content: resultContent,
        }) || null;
    } catch {
      // Keep the regular call summary when display-only formatting fails.
      summary = null;
    }
  }
  const projection = { result, presentation, resultInfo, details, summary };
  toolCallProjectionMemo.set(payload, projection);
  return projection;
}

function sanitizeMessageDeltaText(
  payload: Extract<AgentRunEventRecord["payload"], { type: "message_delta" }>,
): string {
  const known = sanitizedMessageDeltaMemo.get(payload);
  if (known !== undefined) return known;
  const text = sanitizeText(payload.text || "");
  sanitizedMessageDeltaMemo.set(payload, text);
  return text;
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
        isAgentPageProgressText(statusText) ||
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
      if (isToolHiddenFromTrace(entry.payload.name)) return true;
      const resultEvent = ctx.toolResultsByCallId.get(entry.payload.callId);
      const call = projectToolCall(entry.payload, resultEvent);
      let row = summarizeAgentTraceToolCall(
        entry.payload.name,
        entry.payload.args,
        entry.payload.toolLabel,
        ctx.requestSummary,
        call.resultInfo || undefined,
      );
      if (call.summary) row = { ...row, text: call.summary };
      ctx.items.push({
        type: "action",
        row,
        workCategory: entry.payload.workCategory,
        chips: buildAgentTraceToolChips(
          entry.payload.name,
          entry.payload.args,
          ctx.userMessage,
        ),
        details: call.details,
        detailKey: `tool-call:${entry.payload.callId}`,
      });
      ctx.fallbackReasoningStep += 1;
      return true;
    }
    case "reasoning":
      appendReasoningTraceItem(ctx, entry.payload);
      return true;
    case "tool_result": {
      if (isToolHiddenFromTrace(entry.payload.name)) return true;
      // A write the agent chose on its own must always be visible, ahead of
      // every presentation shortcut: neither a missing summary nor a tool that
      // folds its result into the call row may hide it.
      const judgment = entry.payload.authority === "yolo_judgment";
      if (
        !judgment &&
        entry.payload.ok &&
        resolveAgentToolPresentation(entry.payload.name)
          ?.mergeResultIntoCallTrace
      ) {
        return true;
      }
      // The journey stage comes from the receipts the write produced, so the
      // rows below never depend on what the write tool happens to be called.
      const materialWrite = readMaterialNoteWrite(entry.payload);
      let row = summarizeAgentTraceToolResult(
        entry.payload.name,
        entry.payload.ok,
        // A result the trace stored by handle is summarized from its preview.
        toolResultContentForDisplay(entry.payload.content),
        entry.payload.toolLabel,
        entry.payload.effect,
        ctx.requestSummary,
      );
      if (materialWrite) {
        if (!entry.payload.ok)
          ctx.failedMaterialWrites.add(materialWrite.documentId);
        const text = entry.payload.ok ? "Saved note" : "Note write failed";
        row = row
          ? { ...row, text }
          : {
              kind: entry.payload.ok ? "ok" : "skip",
              icon: entry.payload.ok ? "\u2713" : "!",
              text,
            };
      }
      if (judgment) {
        row = row
          ? { ...row, text: `${row.text} (agent's own call)` }
          : {
              kind: "ok",
              icon: "✓",
              text: `${toolLabelFromEvent(entry.payload.name, entry.payload.toolLabel)} completed (agent's own call)`,
            };
      }
      const materialEvidence = entry.payload.ok
        ? materialWrite?.evidence || null
        : null;
      if (row) {
        ctx.items.push({
          type: "action",
          row,
          chips: buildAgentTraceVerificationChips(
            entry.payload.actionReceipts,
            {
              materialEvidence: Boolean(materialEvidence),
            },
          ),
          workCategory: entry.payload.workCategory,
          ...(materialWrite ? { stageHeadline: true } : {}),
        });
        if (materialEvidence) {
          ctx.items.push({
            type: "action",
            row: {
              kind: "ok",
              icon: "\u2713",
              text:
                materialEvidence === "html_sha256"
                  ? "Zotero state verified"
                  : "Zotero state checked (text match)",
            },
          });
        }
        const cards = projectToolResultCards(
          entry.payload,
          resolveAgentToolPresentation(entry.payload.name)?.buildResultCards,
        );
        if (cards.length) ctx.items.push({ type: "card_list", cards });
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
        sanitizeMessageDeltaText(entry.payload),
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
        workCategory: entry.payload.workCategory,
        // A write the connected client ran reaches the trace here, so its
        // receipts must be read for the same verdict an in-app write shows.
        chips: [
          ...(toolName
            ? buildAgentTraceToolChips(
                toolName,
                entry.payload.args,
                ctx.userMessage,
              )
            : []),
          ...buildAgentTraceVerificationChips(entry.payload.actionReceipts),
        ],
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
      // Codex's own plan shows in the Task progress Steps block, not here.
      if (isCodexPlanChecklistEvent(entry.payload)) return true;
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
  // An old plan run's scope amendment, as its run recorded it.
  const amended = readStoredPlanEvent(entry.payload);
  if (amended?.type === "plan_scope_amended") {
    ctx.items.push({
      type: "action",
      row: {
        kind: "plan",
        icon: "↳",
        text:
          `Scope amended${amended.authority === "user" ? "" : " automatically"} (${amended.previousItemCount} to ` +
          `${amended.newItemCount}; ${amended.authority}): ` +
          amended.rationale,
      },
      details: [
        {
          label: "Mode",
          value: amended.mode,
          kind: "text",
        },
        {
          label: "Amendment",
          value: amended.amendmentId,
          kind: "text",
        },
      ],
      detailKey: `plan-amendment:${amended.amendmentId}`,
    });
    return true;
  }
  switch (entry.payload.type) {
    case "material_finalized": {
      const announced = readMaterialAnnouncement(entry.payload);
      if (!announced) return true;
      ctx.finalizedMaterials.set(announced.documentId, announced.announcement);
      ctx.items.push({
        type: "action",
        row: {
          kind: "ok",
          icon: "\u2713",
          text: `Generated ${announced.announcement.kind}: ${announced.announcement.title}`,
        },
        stageHeadline: true,
      });
      return true;
    }
    case "batch_item_outcome":
      ctx.items.push({
        type: "action",
        row: batchItemOutcomeRow(entry.payload),
      });
      return true;
    case "confirmation_required":
      ctx.pendingActions.set(entry.payload.requestId, entry.payload.action);
      ctx.items.push({
        type: "action",
        row: summarizeAgentTraceConfirmationRequest(
          entry.payload.action,
          ctx.requestSummary,
          pendingNoteMaterialLabel(ctx, entry.payload.action),
        ),
        ...(entry.payload.action.interaction === "user_input"
          ? { detailKey: `confirmation:${entry.payload.requestId}` }
          : {}),
      });
      return true;
    case "confirmation_resolved": {
      const requestId = entry.payload.requestId;
      const action = ctx.pendingActions.get(entry.payload.requestId) || {
        toolName: "action",
        title: "Action",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      };
      ctx.pendingActions.delete(entry.payload.requestId);
      const resolvedItem: Extract<AgentTraceDisplayItem, { type: "action" }> = {
        type: "action",
        row: summarizeAgentTraceConfirmationResolved(
          action,
          entry.payload.approved,
          entry.payload.actionId,
          ctx.requestSummary,
        ),
        ...(action.interaction === "user_input"
          ? {
              detailKey: `confirmation:${requestId}`,
              details: buildPlanningQuestionTraceDetails(
                action,
                entry.payload.data,
              ),
            }
          : {}),
      };
      if (action.interaction === "user_input") {
        const existingIndex = ctx.items.findIndex(
          (item) =>
            item.type === "action" &&
            item.detailKey === `confirmation:${requestId}`,
        );
        if (existingIndex >= 0) ctx.items[existingIndex] = resolvedItem;
        else ctx.items.push(resolvedItem);
      } else {
        ctx.items.push(resolvedItem);
      }
      return true;
    }
    case "final": {
      const alreadyCompleted = someAgentTraceDisplayItem(
        ctx.items,
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

/**
 * How this run names the papers it talks about, as the run itself said.
 *
 * A result that resolved paper identities to reader-facing labels reports
 * them under `displayLabels`. That field is the fact; which tool produced it
 * is not, so a result is read for it whenever it carries one. A run that
 * never resolved any has none, and identities stay as they are.
 */
function researchDisplayLabels(
  events: readonly AgentRunEventRecord[],
): Map<string, string> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const labels = readTraceDisplayLabels(events[index].payload);
    if (labels) return labels;
  }
  return undefined;
}

type TraceProjection = {
  items: AgentTraceDisplayItem[];
  isInterleaved: boolean;
  inlineTextReplacesAssistantText: boolean;
};

type ReasoningTraceItem = Extract<AgentTraceDisplayItem, { type: "reasoning" }>;

/**
 * What a live run's projection keeps between refreshes.
 *
 * The run's events are folded once each: into the compacted list the
 * projection walks and into the whole-run facts (plan phase, pending
 * confirmation, final answer, paper labels) the renderer reads. A refresh
 * folds only what arrived since the last one.
 */
type LiveTraceState = {
  runId: string | undefined;
  events: AgentRunEventRecord[];
  /** The records folded so far, to notice one replaced in place. */
  folded: AgentRunEventRecord[];
  compactor: AgentTraceCompactor;
  scan: AgentTraceEventScan;
  /** Events arrived since `cached` was projected. */
  changed: boolean;
  /** ... and every one of them only lengthened the last reasoning entry. */
  onlyTailReasoning: boolean;
  cached?: {
    projection: TraceProjection;
    user: Message | null | undefined;
    hasText: boolean;
    /**
     * The answer text's length and hash: the projection reads the text to
     * hide inline text the answer already shows, so a changed text projects
     * again even when no event arrived.
     */
    textKey: string;
    providerLabel: Message["modelProviderLabel"];
    runMode: Message["runMode"];
    /** The shown item the last compacted entry produced, when reasoning. */
    tailReasoning?: ReasoningTraceItem;
  };
};

/**
 * One live run per streaming message. A message that stops streaming drops
 * its state on its next projection, and a message that is discarded takes
 * its state with it.
 */
const liveTraces = new WeakMap<Message, LiveTraceState>();

function createLiveTraceState(
  events: AgentRunEventRecord[],
  runId: string | undefined,
): LiveTraceState {
  return {
    runId,
    events,
    folded: [],
    compactor: createAgentTraceCompactor(),
    scan: createAgentTraceEventScan(),
    changed: true,
    onlyTailReasoning: false,
  };
}

/** Whether every folded record is still where it was folded from. */
function foldedRecordsUnchanged(
  folded: readonly AgentRunEventRecord[],
  events: readonly AgentRunEventRecord[],
): boolean {
  if (events.length < folded.length) return false;
  for (let index = folded.length - 1; index >= 0; index -= 1) {
    if (folded[index] !== events[index]) return false;
  }
  return true;
}

/**
 * Fold the events that arrived since the last refresh.
 *
 * An event list that was replaced, shortened, or had a record rewritten in
 * place cannot be folded forward, so its state starts over from the first
 * event, once.
 */
function advanceLiveTrace(
  events: AgentRunEventRecord[],
  message: Message,
): LiveTraceState {
  let state = liveTraces.get(message);
  if (
    !state ||
    state.events !== events ||
    state.runId !== message.agentRunId ||
    !foldedRecordsUnchanged(state.folded, events)
  ) {
    state = createLiveTraceState(events, message.agentRunId);
    liveTraces.set(message, state);
    agentTraceProjectionCounters.liveResets += 1;
  }
  for (let index = state.folded.length; index < events.length; index += 1) {
    const entry = events[index];
    state.folded.push(entry);
    const change = state.compactor.push(entry);
    applyAgentTraceEventToScan(state.scan, entry);
    state.changed = true;
    if (entry.payload.type !== "reasoning" || change !== "merged_tail")
      state.onlyTailReasoning = false;
  }
  return state;
}

/**
 * Whether the run's events are already the stage-annotated log the
 * projection reads: it reports its own stages, or holds nothing a stage could
 * be reconstructed from (see `projectStageEvents`).
 */
function liveTraceReadsOwnEvents(scan: AgentTraceEventScan): boolean {
  return scan.hasAgentStage || !scan.hasStageSource;
}

/**
 * The whole-run facts the renderer reads, folded once per event for a live
 * run and in one pass for a finished one.
 */
function readAgentTraceEventScan(
  events: AgentRunEventRecord[],
  message: Message,
): AgentTraceEventScan {
  if (!message.streaming) return scanAgentTraceEvents(events);
  return advanceLiveTrace(events, message).scan;
}

/**
 * The display items for a run.
 *
 * A finished run is projected from scratch. A live run folds only the events
 * that arrived since its last refresh and walks the compacted trace, whose
 * every tool payload was read once and remembered; a refresh that only
 * lengthened the last thinking block patches that block alone.
 */
/** The answer text's length and FNV-1a hash, as one cache key. */
function answerTextKey(text: string): string {
  return `${text.length}:${fnv1a32Raw(text).toString(36)}`;
}

export function buildAgentTraceDisplayItems(
  events: AgentRunEventRecord[],
  userMessage?: Message | null,
  assistantMessage?: Message | null,
): TraceProjection {
  if (!assistantMessage?.streaming) {
    if (assistantMessage) liveTraces.delete(assistantMessage);
    return buildAgentTraceDisplayItemsCanonical(
      events,
      userMessage,
      assistantMessage,
    );
  }
  const state = advanceLiveTrace(events, assistantMessage);
  const hasText = Boolean(assistantMessage.text?.trim());
  const textKey = answerTextKey(assistantMessage.text || "");
  const cached = state.cached;
  const ownEvents = liveTraceReadsOwnEvents(state.scan);
  const sameInputs =
    cached &&
    cached.user === userMessage &&
    cached.hasText === hasText &&
    cached.textKey === textKey &&
    cached.providerLabel === assistantMessage.modelProviderLabel &&
    cached.runMode === assistantMessage.runMode;
  if (cached && sameInputs && !state.changed) return cached.projection;
  if (
    cached?.tailReasoning &&
    sameInputs &&
    ownEvents &&
    state.onlyTailReasoning
  ) {
    const entries = state.compactor.entries;
    const tail = entries[entries.length - 1]?.payload;
    if (tail?.type === "reasoning") {
      const item = cached.tailReasoning;
      const stepLabel = readAgentTraceText(tail.stepLabel);
      if (stepLabel) item.label = stepLabel;
      const text =
        readAgentTraceText(tail.details) ||
        readAgentTraceText(tail.summary) ||
        undefined;
      item.summary =
        text && state.scan.labels
          ? projectPaperReferences(text, state.scan.labels)
          : text;
      state.changed = false;
      state.onlyTailReasoning = true;
      agentTraceProjectionCounters.liveReasoningPatches += 1;
      return cached.projection;
    }
  }
  agentTraceProjectionCounters.liveWalks += 1;
  // A live run that neither reports stages nor is free of tool work has its
  // stages reconstructed from the whole list, which only the canonical
  // reducer does; its tool payloads are still read once each.
  const { projection, tailReasoning } = ownEvents
    ? projectAgentTrace(
        {
          compactedEvents: state.compactor.entries,
          labels: state.scan.labels,
          planPhase: state.scan.planPhase,
          finalText: state.scan.finalText,
        },
        userMessage,
        assistantMessage,
      )
    : {
        projection: buildAgentTraceDisplayItemsCanonical(
          events,
          userMessage,
          assistantMessage,
        ),
        tailReasoning: undefined,
      };
  state.cached = {
    projection,
    user: userMessage,
    hasText,
    textKey,
    providerLabel: assistantMessage.modelProviderLabel,
    runMode: assistantMessage.runMode,
    tailReasoning,
  };
  state.changed = false;
  state.onlyTailReasoning = true;
  return projection;
}

/**
 * The display items for a run, projected from its events alone. History
 * replay and every finished run read this; a live run's incremental
 * projection must equal it after every event.
 */
export function buildAgentTraceDisplayItemsCanonical(
  events: AgentRunEventRecord[],
  userMessage?: Message | null,
  assistantMessage?: Message | null,
): TraceProjection {
  // A trace recorded before the runtime emitted stage events is reconstructed
  // once, here, so everything below reads one kind of event log.
  const compactedEvents = compactAgentTraceEvents(projectStageEvents(events));
  return projectAgentTrace(
    {
      compactedEvents,
      labels: researchDisplayLabels(events),
      planPhase: resolveTracePlanPhase(compactedEvents),
      finalText: getFinalTraceText(compactedEvents),
    },
    userMessage,
    assistantMessage,
  ).projection;
}

/**
 * Close a run that generated material but could not save it.
 *
 * The two halves are reported separately everywhere else, so the reader is
 * left to guess whether the work survived. This row says it did and names the
 * one thing left to do, which is the same material a retry would reuse.
 */
function appendMaterialOutcomeFooter(ctx: AgentTraceAdapterContext): void {
  for (const [documentId, material] of ctx.finalizedMaterials) {
    if (!ctx.failedMaterialWrites.has(documentId)) continue;
    ctx.items.push({
      type: "action",
      row: {
        kind: "skip",
        icon: "!",
        text:
          `Generated ${material.kind}: complete \u00b7 Note write: failed ` +
          "\u00b7 Retry available using the same material",
      },
    });
  }
}

/**
 * Items a stage group holds.
 *
 * A stage groups the work the agent did; the answer it streamed, the thinking
 * it reported and the messages it wrote are not work steps, so they stay at
 * the top level and end the stage they interrupt rather than being folded
 * into it out of order.
 */
const STAGE_GROUPED_ITEM_TYPES: ReadonlySet<AgentTraceDisplayItem["type"]> =
  new Set(["action", "card_list", "image_grid"]);

type OpenTraceStage = {
  item: Extract<AgentTraceDisplayItem, { type: "stage" }>;
  /** Receipts the stage's own events proved, for its summary chip. */
  receipts: AgentActionReceipt[];
  /**
   * A close arrived for this stage. The close is emitted immediately before
   * the event it describes, so the stage stays open until it has taken that
   * event's rows.
   */
  awaitingClose: boolean;
  /**
   * Whether the group has reached the item list.
   *
   * A stage joins the list with its first row, never when it opens: a stage
   * whose every row is suppressed would otherwise sit between two halves of
   * the streamed answer and split them into two paragraphs, and removing it
   * afterwards cannot put them back together.
   */
  shown: boolean;
};

function traceStageLabel(payload: AgentStagePayload): string {
  return payload.undifferentiated
    ? UNDIFFERENTIATED_AGENT_STAGE_LABEL
    : AGENT_STAGE_LABELS[payload.stage];
}

function readTraceEventReceipts(
  payload: AgentRunEventRecord["payload"],
): AgentActionReceipt[] {
  if (payload.type === "tool_result") return payload.actionReceipts || [];
  if (payload.type === "codex_tool_activity")
    return payload.actionReceipts || [];
  return [];
}

/**
 * Groups the rows a run produced under the stage that produced them.
 *
 * The reducer below pushes rows onto one flat array, as it always has; this
 * moves each event's rows into the stage that was open when the event
 * arrived. Nothing here reads a tool name: a stage opens, closes and is
 * labelled entirely from the `agent_stage` events the run recorded (or that
 * the compatibility projection reconstructed for it).
 */
/**
 * Drop a row's evidence chip when its stage's heading already carries it.
 *
 * The heading shows the aggregate of everything the group's rows proved, so a
 * row whose verdict is that aggregate would state it twice. A row whose proof
 * differs carries a different label from the shared vocabulary and keeps its
 * chip -- which is the only case where the second chip tells the reader
 * something the first did not. The comparison is by label because a heading's
 * chips are receipt-derived and nothing else in a row's chip set shares that
 * vocabulary.
 */
function suppressChipsTheStageHeadingShows(
  stage: Extract<AgentTraceDisplayItem, { type: "stage" }>,
): void {
  const shown = new Set((stage.chips || []).map((chip) => chip.label));
  if (!shown.size) return;
  for (const child of stage.children) {
    if (child.type !== "action" || !child.chips?.length) continue;
    child.chips = child.chips.filter((chip) => !shown.has(chip.label));
  }
}

function createTraceStageGrouper(items: AgentTraceDisplayItem[]) {
  let open: OpenTraceStage | null = null;
  let closed: OpenTraceStage | null = null;
  /** Whether a top-level row has separated the last closed stage from now. */
  let interrupted = false;

  const close = (): void => {
    const stage = open;
    open = null;
    // A stage no row ever joined never reached the list, so there is nothing
    // to close and nothing separating what came before it from what follows.
    if (!stage?.shown) return;
    // The row that announces what the stage produced becomes its heading, so
    // the group names its own outcome instead of repeating it one line down.
    const headlineIndex = stage.item.children.findIndex(
      (child) => child.type === "action" && child.stageHeadline,
    );
    const headline =
      headlineIndex >= 0
        ? stage.item.children.splice(headlineIndex, 1)[0]
        : null;
    if (headline?.type === "action") stage.item.label = headline.row.text;
    const chips = buildAgentTraceVerificationChips(stage.receipts);
    if (chips.length) stage.item.chips = chips;
    closed = stage;
    interrupted = false;
  };

  const openStage = (payload: AgentStagePayload, seq: number): void => {
    // Two stages of one kind with nothing visible between them are one stage
    // to the reader, so the second reopens the first instead of repeating it.
    if (closed && !interrupted && closed.item.stage === payload.stage) {
      open = closed;
      closed = null;
      open.awaitingClose = false;
      open.item.status = payload.status;
      return;
    }
    const item: Extract<AgentTraceDisplayItem, { type: "stage" }> = {
      type: "stage",
      key: `stage:${seq}`,
      stage: payload.stage,
      status: payload.status,
      label: traceStageLabel(payload),
      ...(payload.projected ? { projected: true } : {}),
      children: [],
    };
    open = { item, receipts: [], awaitingClose: false, shown: false };
  };

  return {
    onStageEvent(payload: AgentStagePayload, seq: number): void {
      if (payload.status === "started") {
        if (open?.item.stage === payload.stage) {
          open.awaitingClose = false;
          open.item.status = "started";
          return;
        }
        close();
        openStage(payload, seq);
        return;
      }
      if (open?.item.stage !== payload.stage) {
        close();
        openStage(payload, seq);
      }
      if (!open) return;
      open.item.status = payload.status;
      open.awaitingClose = true;
    },
    noteEvent(entry: AgentRunEventRecord): void {
      if (!open) return;
      open.receipts.push(...readTraceEventReceipts(entry.payload));
    },
    /** Move the rows this event produced into the stage that was open. */
    routeProducedItems(producedFrom: number): void {
      if (items.length <= producedFrom) return;
      const produced = items.slice(producedFrom);
      const groupable = produced.every((item) =>
        STAGE_GROUPED_ITEM_TYPES.has(item.type),
      );
      if (!open || !groupable) {
        close();
        interrupted = true;
        return;
      }
      items.length = producedFrom;
      if (!open.shown) {
        // The group takes the place its first row would have had.
        items.push(open.item);
        open.shown = true;
      }
      open.item.children.push(...produced);
      if (open.awaitingClose) close();
    },
    finish(): void {
      close();
      // A stage that reopens gains receipts, so its heading's verdict is only
      // final once the run is: the rows drop what it shows exactly once, here.
      for (const item of items) {
        if (item.type === "stage") suppressChipsTheStageHeadingShows(item);
      }
    },
  };
}

/** Visit every item, inside a stage group or not, in the order produced. */
function forEachAgentTraceDisplayItem(
  items: readonly AgentTraceDisplayItem[],
  visit: (item: AgentTraceDisplayItem) => void,
): void {
  for (const item of items) {
    visit(item);
    if (item.type === "stage")
      forEachAgentTraceDisplayItem(item.children, visit);
  }
}

/** Whether any item, inside a stage group or not, satisfies `predicate`. */
function someAgentTraceDisplayItem(
  items: readonly AgentTraceDisplayItem[],
  predicate: (item: AgentTraceDisplayItem) => boolean,
): boolean {
  return items.some((item) =>
    item.type === "stage"
      ? predicate(item) || someAgentTraceDisplayItem(item.children, predicate)
      : predicate(item),
  );
}

/** Rewrite every reader-facing string with the run's paper display labels. */
function projectPaperReferencesOntoTraceItems(
  items: readonly AgentTraceDisplayItem[],
  labels: Map<string, string>,
): AgentTraceDisplayItem[] {
  return items.map((item): AgentTraceDisplayItem => {
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
    if (item.type === "stage")
      return {
        ...item,
        label: projectPaperReferences(item.label, labels),
        children: projectPaperReferencesOntoTraceItems(item.children, labels),
      };
    return item;
  });
}

/**
 * Walk a compacted, stage-annotated trace into display items.
 *
 * The whole-run facts come in with it, read from the run's own events, so a
 * live run passes the ones it folded and a replay the ones it scanned.
 */
function projectAgentTrace(
  input: {
    compactedEvents: readonly AgentRunEventRecord[];
    labels: Map<string, string> | undefined;
    planPhase: "planning" | "executing" | null;
    finalText: string;
  },
  userMessage: Message | null | undefined,
  assistantMessage?: Message | null,
): { projection: TraceProjection; tailReasoning?: ReasoningTraceItem } {
  const { compactedEvents, labels, planPhase, finalText } = input;
  const items: AgentTraceDisplayItem[] = [];
  const isCodexTrace = assistantMessage?.modelProviderLabel === "Codex";
  const isAgentTrace = assistantMessage?.runMode === "agent";
  const preserveRolledBackText = isCodexTrace || isAgentTrace;
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
    finalizedMaterials: new Map<string, TraceMaterialAnnouncement>(),
    failedMaterialWrites: new Set<string>(),
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

  const stageGrouper = createTraceStageGrouper(items);
  /** The reasoning item the last entry opened, for a live run to extend. */
  let tailReasoningKey: string | undefined;
  for (let index = 0; index < compactedEvents.length; index += 1) {
    const entry = compactedEvents[index];
    if (entry.payload.type === "agent_stage") {
      stageGrouper.onStageEvent(entry.payload, entry.seq);
      continue;
    }
    const itemCountBeforeEvent = items.length;
    const handled =
      appendCodexAgentTraceEvent(adapterContext, entry) ||
      appendLegacyAgentTraceEvent(adapterContext, entry) ||
      appendSharedAgentTraceEvent(adapterContext, entry);
    if (index === compactedEvents.length - 1) {
      const opened = items[itemCountBeforeEvent];
      tailReasoningKey =
        items.length === itemCountBeforeEvent + 1 &&
        opened?.type === "reasoning"
          ? opened.key
          : undefined;
    }
    if (
      handled &&
      !NON_INTERLEAVING_TRACE_EVENT_TYPES.has(entry.payload.type) &&
      items.length > itemCountBeforeEvent
    ) {
      markLatestInlineTextAsIntermediate(adapterContext, itemCountBeforeEvent);
    }
    stageGrouper.noteEvent(entry);
    stageGrouper.routeProducedItems(itemCountBeforeEvent);
  }
  stageGrouper.finish();

  appendMaterialOutcomeFooter(adapterContext);

  // What the run did, stated once at the end for the reader: the answer bubble
  // no longer carries the model-facing action-status block, and the card
  // renders wherever the trace does, interleaved text included.
  const actionSummary = buildAgentActionSummaryCard(
    compactedEvents,
    createZoteroActionCardResolvers(
      (documentId) => adapterContext.finalizedMaterials.get(documentId)?.title,
    ),
  );
  if (actionSummary) items.push({ type: "card_list", cards: [actionSummary] });

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
  const canonicalAssistantText = assistantMessage?.text || "";
  const hasCanonicalAssistantText = Boolean(canonicalAssistantText.trim());
  const inlineTextReplacesAssistantText =
    isInterleaved &&
    !finalText &&
    (!hasTerminalInlineText || !hasCanonicalAssistantText);
  const displayItems = isInterleaved
    ? finalText
      ? items.filter(
          (item) =>
            !shouldSuppressInlineFinalAnswer(
              item,
              finalText,
              item.type === "inline_text" &&
                adapterContext.intermediateInlineTextItems.has(item),
            ),
        )
      : hasCanonicalAssistantText
        ? // While the answer streams, the bubble already shows text kept
          // from before a tool call; the trace does not repeat it.
          items.filter(
            (item) =>
              item.type !== "inline_text" ||
              (adapterContext.intermediateInlineTextItems.has(item) &&
                (inlineTextReplacesAssistantText ||
                  !shouldSuppressInlineFinalAnswer(
                    item,
                    canonicalAssistantText,
                    true,
                  ))),
          )
        : items
    : replaceInlineTextWithDraftingAction(items);

  const presentedItems = labels
    ? projectPaperReferencesOntoTraceItems(displayItems, labels)
    : displayItems;
  const lastShown = presentedItems[presentedItems.length - 1];
  return {
    projection: {
      items: presentedItems,
      isInterleaved,
      inlineTextReplacesAssistantText,
    },
    tailReasoning:
      tailReasoningKey !== undefined &&
      lastShown?.type === "reasoning" &&
      lastShown.key === tailReasoningKey
        ? lastShown
        : undefined,
  };
}

/** How a stage's heading reports where the stage got to. */
const AGENT_STAGE_STATUS_ICONS: Readonly<Record<AgentStageStatus, string>> = {
  started: "\u2026",
  completed: "\u2713",
  failed: "!",
};

/**
 * One stage group: a heading naming the stage and a body holding its rows.
 *
 * A stage with no rows of its own (a material announcement that became the
 * heading, for instance) is a plain row rather than an empty disclosure.
 */
function renderAgentTraceStageShell(
  doc: Document,
  item: Extract<AgentTraceDisplayItem, { type: "stage" }>,
  runId: string,
): HTMLElement {
  const expandable = item.children.length > 0;
  const node = doc.createElement(expandable ? "details" : "div") as HTMLElement;
  node.className = `llm-agent-process-stage${
    expandable ? " llm-agent-process-stage-expandable" : ""
  }`;
  node.setAttribute("data-stage", item.stage);
  node.setAttribute("data-stage-status", item.status);
  const row = doc.createElement("div") as HTMLDivElement;
  row.className = "llm-at-row llm-at-row-stage";
  const icon = doc.createElement("span") as HTMLSpanElement;
  icon.className = "llm-at-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = AGENT_STAGE_STATUS_ICONS[item.status];
  const label = doc.createElement("span") as HTMLSpanElement;
  label.className = "llm-at-text llm-agent-process-stage-label";
  label.textContent = item.label;
  row.append(icon, label);
  const chips = renderAgentTraceChips(doc, item.chips);
  if (!expandable) {
    node.appendChild(row);
    if (chips) node.appendChild(chips);
    return node;
  }
  const expansionKey = `${runId}:${item.key}`;
  const remembered = agentTraceActionExpandedCache.get(expansionKey);
  (node as HTMLDetailsElement).open = remembered === undefined || remembered;
  const summary = doc.createElement("summary") as HTMLElement;
  summary.className =
    "llm-agent-process-action-summary llm-agent-process-stage-summary";
  summary.appendChild(row);
  if (chips) summary.appendChild(chips);
  node.appendChild(summary);
  const body = doc.createElement("div") as HTMLDivElement;
  body.className = "llm-agent-activity-list llm-agent-process-stage-body";
  node.appendChild(body);
  node.addEventListener("toggle", () => {
    agentTraceActionExpandedCache.set(
      expansionKey,
      Boolean((node as HTMLDetailsElement).open),
    );
  });
  return node;
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
      const value = doc.createElement("div") as HTMLDivElement;
      value.className = "llm-agent-trace-code";
      // A fence longer than any run in the payload keeps embedded Markdown
      // and HTML inside the code block, using the shared safe renderer.
      const longestFence = (detail.value.match(/`+/g) || []).reduce(
        (longest, run) => Math.max(longest, run.length),
        2,
      );
      const fence = "`".repeat(longestFence + 1);
      renderRenderedMarkdownInto(
        value,
        `${fence}${detail.kind === "json" ? "json" : "text"}\n${detail.value}\n${fence}`,
        doc,
      );
      item.append(label, value);
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

/**
 * A run's plan as that run's own events recorded it: the proposal it drafted
 * and, for a run that executed one, the execution as it last stood. Plan mode
 * is retired, so this only ever describes an old conversation, and the card
 * built from it is read-only.
 */
type PlanProjection = {
  artifact?: StoredPlanArtifact;
  ledger?: StoredPlanExecution;
};

function readPlanProjection(scan: AgentTraceEventScan): PlanProjection | null {
  const artifact = scan.planArtifact;
  const ledger = scan.planLedger;
  return artifact || ledger ? { artifact, ledger } : null;
}

/** A planning run's card is its answer; an execution run keeps its own. */
function isPlanningAnswer(projection: PlanProjection | null): boolean {
  return Boolean(projection?.artifact && !projection.ledger);
}

/**
 * How the plan ended, as its run last recorded it. A plan that stopped
 * mid-way never resumes now, so every live state reads as not finished.
 */
function planEnd(projection: PlanProjection): {
  status: string;
  label: string;
} {
  if (projection.ledger) {
    switch (projection.ledger.status) {
      case "completed":
        return { status: "completed", label: "Completed" };
      case "completed_with_exceptions":
        return { status: "partial", label: "Completed with exceptions" };
      case "blocked":
        return { status: "blocked", label: "Blocked" };
      case "failed":
        return { status: "failed", label: "Failed" };
      case "cancelled":
        return { status: "cancelled", label: "Cancelled" };
      case "superseded":
        return { status: "superseded", label: "Superseded" };
      case "interrupted":
        return { status: "interrupted", label: "Interrupted" };
    }
    return { status: "not_finished", label: "Not finished" };
  }
  switch (projection.artifact?.status) {
    case "approved":
      return { status: "approved", label: "Approved" };
    case "superseded":
      return { status: "superseded", label: "Superseded" };
    case "cancelled":
      return { status: "cancelled", label: "Cancelled" };
    case "awaiting_approval":
      return { status: "proposed", label: "Proposed" };
  }
  return { status: "not_finished", label: "Not finished" };
}

/** The plan's text and steps as the model proposed them. */
function renderPlanProposal(
  doc: Document,
  events: AgentRunEventRecord[],
  artifact: StoredPlanArtifact,
): HTMLElement {
  const markdown = doc.createElement("div");
  markdown.className = "llm-plan-markdown";
  const rawSource =
    artifact.nativePlanning?.proposal?.markdown ||
    [
      artifact.explanation?.trim() || "",
      ...(artifact.steps || []).map(
        (step, index) => `${index + 1}. ${step.content}`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
  const labels = researchDisplayLabels(events);
  const source = labels ? projectPaperReferences(rawSource, labels) : rawSource;
  try {
    renderRenderedMarkdownInto(markdown, source, doc);
  } catch {
    markdown.textContent = source;
  }
  if (artifact.nativePlanning?.proposal && artifact.contract) {
    const summary = doc.createElement("p");
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
}

/**
 * An executed plan's steps as they stood when its run last reported them. A
 * step still marked in progress was cut off with its run, so it shows as
 * interrupted rather than as a spinner that never stops.
 */
function renderEndedPlanTasks(
  doc: Document,
  ledger: StoredPlanExecution,
): HTMLElement {
  const list = doc.createElement("div");
  list.className = "llm-plan-task-list";
  list.setAttribute("role", "list");
  (ledger.tasks || []).forEach((task, index) => {
    const status = task.status === "in_progress" ? "interrupted" : task.status;
    const row = doc.createElement("div");
    row.dataset.taskId = task.taskId;
    row.className = `llm-plan-task llm-plan-task-${status}`;
    row.setAttribute("role", "listitem");
    const line = doc.createElement("div");
    line.className = "llm-plan-task-line";
    const badge = doc.createElement("span");
    badge.className = `llm-plan-task-badge llm-plan-task-badge-${status}`;
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = PLAN_STATUS_SYMBOLS[status] || `${index + 1}`;
    const content = doc.createElement("span");
    content.className = "llm-plan-task-content";
    const label = doc.createElement("span");
    label.className = "llm-plan-task-label";
    label.textContent = task.content || task.activeForm || "";
    content.appendChild(label);
    line.append(badge, content);
    row.appendChild(line);
    list.appendChild(row);
  });
  return list;
}

/** An old plan, read-only: its steps and how it ended, with no control. */
function renderPlanContainer(params: {
  doc: Document;
  events: AgentRunEventRecord[];
  projection: PlanProjection;
}): HTMLElement {
  const { doc, projection } = params;
  const { artifact, ledger } = projection;
  const root = doc.createElement("section");
  root.className = "llm-plan-container";
  const revision = ledger?.revision || artifact?.revision || 1;
  root.dataset.llmPlanId = ledger?.planId || artifact?.planId || "";
  root.dataset.llmPlanRevision = `${revision}`;
  root.setAttribute("aria-label", "Plan");

  const header = doc.createElement("div");
  header.className = "llm-plan-header";
  const heading = doc.createElement("div");
  heading.className = "llm-plan-heading";
  const title = doc.createElement("strong");
  title.className = "llm-plan-title";
  title.textContent = "Plan";
  heading.appendChild(title);
  if (revision > 1) {
    const version = doc.createElement("span");
    version.className = "llm-plan-version";
    version.textContent = `Revision ${revision}`;
    heading.appendChild(version);
  }
  const end = planEnd(projection);
  const status = doc.createElement("span");
  status.className = "llm-plan-status";
  status.textContent = end.label;
  status.dataset.status = end.status;
  header.append(heading, status);
  root.appendChild(header);

  if (ledger?.tasks?.length)
    root.appendChild(renderEndedPlanTasks(doc, ledger));
  else if (artifact)
    root.appendChild(renderPlanProposal(doc, params.events, artifact));
  const snapshot = artifact?.contract?.investigation?.scopeSnapshot;
  if (snapshot) {
    const scope = doc.createElement("div");
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
  return root;
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

/** The visible markdown of documents a card painted, by document id. */
const documentMarkdownById = new Map<string, string>();
const DOCUMENT_MARKDOWN_CACHE_LIMIT = 64;

function rememberDocumentMarkdown(document: PlanDocument): void {
  documentMarkdownById.delete(document.documentId);
  documentMarkdownById.set(document.documentId, document.visibleMarkdown);
  if (documentMarkdownById.size > DOCUMENT_MARKDOWN_CACHE_LIMIT) {
    const oldest = documentMarkdownById.keys().next().value;
    if (oldest !== undefined) documentMarkdownById.delete(oldest);
  }
}

/**
 * A document's visible markdown, when known without loading it: from a card
 * that painted it, else from the submit_document result in the run's events
 * (a stored result too big for the trace keeps only a preview, which does
 * not count). Undefined until the card loads it.
 */
function knownDocumentMarkdown(
  documentId: string,
  events: readonly AgentRunEventRecord[],
): string | undefined {
  const known = documentMarkdownById.get(documentId);
  if (known !== undefined) return known;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index].payload;
    if (payload.type !== "tool_result" || !payload.ok) continue;
    const content = payload.content as
      | { documentId?: unknown; visibleMarkdown?: unknown }
      | null
      | undefined;
    if (
      content &&
      typeof content === "object" &&
      !isTruncatedToolResultContent(content) &&
      content.documentId === documentId &&
      typeof content.visibleMarkdown === "string"
    )
      return content.visibleMarkdown;
  }
  return undefined;
}

/**
 * Shows the text a message carries before its document (text the model
 * wrote before calling the tool) directly above the document card. The
 * answer bubble below stays hidden, since it would repeat the document; the
 * card's Copy, Export and Save Note deliver the document alone.
 */
function syncDocumentLead(
  doc: Document,
  documentView: NonNullable<TraceView["document"]>,
  documentMarkdown: string,
): void {
  const text = documentMessageLead(
    documentView.message.text || "",
    documentMarkdown,
  );
  if (!text) {
    documentView.lead?.node.remove();
    documentView.lead = undefined;
    return;
  }
  const card = documentView.node;
  if (documentView.lead?.text !== text) {
    documentView.lead?.node.remove();
    const node = doc.createElement("div");
    node.className = "llm-agent-inline-text llm-plan-document-lead";
    const markdown = buildAgentTraceMarkdownForRender(
      text,
      documentView.message,
    );
    try {
      renderRenderedMarkdownInto(node, markdown, doc);
    } catch {
      node.textContent = markdown;
    }
    documentView.lead = { text, node };
  }
  const lead = documentView.lead!.node;
  if (card.parentElement && lead.nextSibling !== card)
    card.parentElement.insertBefore(lead, card);
}

function renderPlanDocumentCard(params: {
  doc: Document;
  documentId: string;
  citationContext?: import("../assistantRichText").AssistantCitationContext;
  onReady?: (document: PlanDocument) => void;
}): HTMLElement {
  const root = params.doc.createElement("section");
  root.className = "llm-plan-container llm-plan-document-card";
  root.dataset.llmPlanDocumentId = params.documentId;
  root.textContent = "Loading document…";
  let disposed = false;
  let loadVersion = 0;
  let unsubscribe = () => {};
  cardDisposers.set(root, () => {
    disposed = true;
    unsubscribe();
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
    unsubscribe();
    params.onReady?.(document);
  };

  const reload = () => {
    const version = ++loadVersion;
    void Promise.all([
      loadPlanDocument(params.documentId),
      loadPlanDocumentOutbox(params.documentId),
    ])
      .then(([document, outbox]) => {
        if (disposed || !root.isConnected || version !== loadVersion) return;
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
        if (!disposed && root.isConnected && version === loadVersion)
          root.textContent =
            error instanceof Error ? error.message : String(error);
      });
  };
  unsubscribe = subscribeDocumentPublication(params.documentId, reload);
  reload();
  return root;
}

type TraceItemView = {
  signature: string;
  node: HTMLElement;
  /** A thinking block's text node host, found once when it is built. */
  reasoningText?: HTMLElement | null;
};
type TraceView = {
  activityClock?: { startedAt: number; paint: () => void; stop: () => void };
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
    /** Text the message carries before the document, shown above the card. */
    lead?: { text: string; node: HTMLElement };
  };
  streaming?: boolean;
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
  view.activityClock?.stop();
  for (const item of view.items.values()) disposeStreamingMarkdown(item.node);
  if (view.plan) disposePlanCard(view.plan.node);
  if (view.document) disposePlanCard(view.document.node);
  traceViews.delete(root);
}

/**
 * The text each thinking block last committed to its DOM, so a refresh never
 * reads a growing block back out of the document to diff it.
 */
const committedReasoningText = new WeakMap<HTMLElement, string>();

function updateReasoningText(target: HTMLElement, next: string): void {
  const previous =
    committedReasoningText.get(target) ?? target.textContent ?? "";
  if (previous === next) return;
  const text = target.firstChild;
  if (
    text?.nodeType === 3 &&
    target.childNodes.length === 1 &&
    next.length > previous.length &&
    next.startsWith(previous)
  ) {
    (text as Text).appendData(next.slice(previous.length));
  } else target.textContent = next;
  committedReasoningText.set(target, next);
}

/**
 * A row's signature: the item itself, except where the projection shares a
 * remembered value. A shared details array stands in by identity, so a call
 * row holding a megabyte result preview is not reserialized every refresh.
 */
function traceItemSignature(item: AgentTraceDisplayItem): string {
  return JSON.stringify(item, (key, value) => {
    if (key === "details" && Array.isArray(value)) {
      const id = memoizedTraceDetailIds.get(value);
      if (id !== undefined) return `#details:${id}`;
    }
    return value;
  });
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
  actionCardNavigation,
  actionSummaryHost,
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
    actionSummaryHost?.replaceChildren();
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
    view.streaming === message.streaming &&
    message.streaming !== false &&
    !formattingChanged &&
    added &&
    added.every(
      (entry) =>
        entry.payload.type === "reasoning" ||
        entry.payload.type === "message_delta",
    );
  view.streaming = message.streaming;
  view.eventCount = events.length;
  view.lastEvent = events[events.length - 1];

  if (!events.length) {
    actionSummaryHost?.replaceChildren();
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
      scan: createAgentTraceEventScan(),
      // Loading a saved trace must not override the reader's disclosure state.
      // A live run already opens by default through message.streaming.
    });
    return wrap;
  }
  const { items: processItems, inlineTextReplacesAssistantText } =
    buildAgentTraceDisplayItems(events, userMessage, message);
  const scan = readAgentTraceEventScan(events, message);
  const tracePlanPhase = scan.planPhase;
  if (inlineTextReplacesAssistantText) {
    onInterleavedText?.();
  }
  const pending = readPendingConfirmation(scan);
  if (!textOnly) {
    wrap.className = "llm-agent-activity";
    delete wrap.dataset.llmAssistantTurnReplacement;
  }
  if (pending) {
    wrap.classList.add("llm-agent-activity-with-pending-action");
  }
  if (pending && isPlanningQuestionAction(pending.action)) {
    actionSummaryHost?.replaceChildren();
    view.activityClock?.stop();
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
  const hasFinalResponse = scan.hasFinal;
  const nextViews = new Map<string, TraceItemView>();
  // Stage groups nest their rows, so placement walks one container at a time
  // and recurses into a stage's body with the same retained-view cache.
  const renderTraceItemsInto = (
    container: HTMLElement,
    itemsToRender: readonly AgentTraceDisplayItem[],
    keyPrefix: string,
  ): void => {
    let cursor: ChildNode | null = container.firstChild;
    let currentKey = "";
    let currentSignature = "";
    const place = (node: HTMLElement, reasoningText?: HTMLElement | null) => {
      if (node !== cursor) container.insertBefore(node, cursor);
      cursor = node.nextSibling;
      nextViews.set(currentKey, {
        signature: currentSignature,
        node,
        ...(reasoningText ? { reasoningText } : {}),
      });
    };
    for (const [itemIndex, itemEntry] of itemsToRender.entries()) {
      currentKey =
        keyPrefix +
        (itemEntry.type === "reasoning"
          ? `reasoning:${itemEntry.key}`
          : itemEntry.type === "stage"
            ? itemEntry.key
            : itemEntry.type === "action" && itemEntry.detailKey
              ? `action:${itemEntry.detailKey}`
              : `${itemEntry.type}:${itemIndex}`);
      if (itemEntry.type === "stage") {
        // The group's own signature covers its heading only: a row arriving
        // inside it must not rebuild the disclosure the reader has open.
        currentSignature = JSON.stringify({
          key: itemEntry.key,
          stage: itemEntry.stage,
          status: itemEntry.status,
          label: itemEntry.label,
          chips: itemEntry.chips,
          expandable: itemEntry.children.length > 0,
        });
        const previousStage = view.items.get(currentKey);
        const stageNode =
          previousStage?.signature === currentSignature
            ? previousStage.node
            : renderAgentTraceStageShell(doc, itemEntry, runId);
        place(stageNode);
        const body = stageNode.querySelector<HTMLElement>(
          ".llm-agent-process-stage-body",
        );
        if (body)
          renderTraceItemsInto(body, itemEntry.children, `${currentKey}/`);
        continue;
      }
      if (itemEntry.type === "reasoning") {
        // A thinking block only ever grows while it streams: its text is
        // appended in place rather than reserialized into a signature.
        currentSignature = `reasoning:${itemEntry.key}`;
        const old = view.items.get(currentKey);
        const target = old?.reasoningText;
        if (old && target) {
          updateReasoningText(
            target,
            itemEntry.summary || itemEntry.details || "",
          );
          const label = old.node.querySelector("summary");
          if (label && label.textContent !== itemEntry.label)
            label.textContent = itemEntry.label;
          place(old.node, target);
          continue;
        }
      } else currentSignature = traceItemSignature(itemEntry);
      if (
        itemEntry.type === "inline_text" ||
        (itemEntry.type === "message" && itemEntry.markdown)
      )
        currentSignature += `:${view.formattingVersion || 0}`;
      const old = view.items.get(currentKey);
      if (
        old?.signature === currentSignature &&
        itemEntry.type !== "reasoning"
      ) {
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
        // Saved notes, note changes and the turn's action summary are outcomes
        // rather than steps: they are appended below the activity disclosure so
        // the reader sees them without opening it.
        const papers = itemEntry.cards.filter(
          (card) =>
            card.kind !== "saved_note" &&
            card.kind !== "note_change" &&
            card.kind !== "action_summary",
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
        let reasoningTextNode: HTMLDivElement | null = null;
        if (reasoningText) {
          const summaryBlock = doc.createElement("div") as HTMLDivElement;
          summaryBlock.className = "llm-agent-reasoning-block";
          const text = doc.createElement("div") as HTMLDivElement;
          text.className = "llm-agent-reasoning-text";
          text.textContent = reasoningText;
          committedReasoningText.set(text, reasoningText);
          reasoningTextNode = text;
          summaryBlock.appendChild(text);
          bodyWrap.appendChild(summaryBlock);
        }

        // Details section removed — most models duplicate summary in details

        details.appendChild(bodyWrap);
        place(details, reasoningTextNode);
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
      if (itemEntry.workCategory) {
        actionWrap.setAttribute("data-work-category", itemEntry.workCategory);
      }
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
      container.removeChild(cursor);
      cursor = next;
    }
  };
  renderTraceItemsInto(list, processItems, "");
  for (const [key, old] of view.items) {
    if (nextViews.get(key)?.node !== old.node)
      disposeStreamingMarkdown(old.node);
  }
  view.items = nextViews;
  if (textOnly) {
    if (
      view.document ||
      (view.plan && isPlanningAnswer(readPlanProjection(scan)))
    )
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
        child !== view.document?.lead?.node &&
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
    scan,
    forceOpen: Boolean(pending),
  });

  let hasSavedNote = false;
  let actionSummaryCard: AgentActionSummaryResultCard | undefined;
  const noteCards: (AgentNoteChangeResultCard | AgentSavedNoteResultCard)[] =
    [];
  // These cards are the turn's outcome, not a step, so they are collected from
  // the whole item tree: a card list an action produced is grouped into the
  // stage that produced it, and the in-stage renderer drops these kinds
  // because they belong here, below the disclosure.
  forEachAgentTraceDisplayItem(processItems, (item) => {
    if (item.type !== "card_list") return;
    for (const card of item.cards) {
      if (card.kind === "note_change" || card.kind === "saved_note") {
        if (card.kind === "saved_note") hasSavedNote = true;
        noteCards.push(card);
      } else if (card.kind === "action_summary") actionSummaryCard = card;
    }
  });

  // One card per action: a note the run created and then edited is one note,
  // and the change is the last thing that happened to it. A card that names no
  // action shares its identity with nothing and stands on its own.
  const noteCardsByAction = new Map<string, (typeof noteCards)[number]>();
  const anonymousNoteCards: typeof noteCards = [];
  for (const card of noteCards) {
    if (card.actionId) noteCardsByAction.set(card.actionId, card);
    else anonymousNoteCards.push(card);
  }
  let standaloneNoteCards = [
    ...noteCardsByAction.values(),
    ...anonymousNoteCards,
  ];

  // A note card and an action row are two statements about the same write. The
  // row takes the note over, so the reader is shown it once; a note no receipt
  // claims keeps the card it has always had.
  let actionCardNode: HTMLElement | undefined;
  if (actionSummaryCard) {
    const attached = attachNoteDetails(actionSummaryCard, standaloneNoteCards);
    standaloneNoteCards = attached.unmatched;
    // Receipts can arrive before the answer starts. Reveal their outcome only
    // after streaming finishes, even if a final trace event has arrived sooner.
    if (message.streaming !== true) {
      const noteMode = actionCardNoteMode(attached.card);
      actionCardNode = renderActionSummaryCard(doc, attached.card, {
        mode: noteMode ? "note" : "action",
        ...(noteMode ? { header: noteMode } : {}),
        renderDetail: renderActionCardDetail,
        ...(actionCardNavigation ? { navigation: actionCardNavigation } : {}),
      });
    }
  }

  for (const card of standaloneNoteCards)
    wrap.appendChild(
      card.kind === "note_change"
        ? renderNoteChangeCard(doc, card)
        : renderSavedNoteCard(doc, card),
    );

  const planProjection = readPlanProjection(scan);
  if (!planProjection && view.plan) {
    disposePlanCard(view.plan.node);
    view.plan = undefined;
  }
  if (planProjection) {
    // An old planning turn's card is its visible answer: keep the provider's
    // often-duplicated prose in durable history without rendering a second
    // copy below it. An execution turn renders its final answer as usual.
    if (isPlanningAnswer(planProjection)) onInterleavedText?.();
    const planSignature = JSON.stringify([
      planProjection,
      [...(scan.labels || [])],
    ]);
    if (view.plan?.signature !== planSignature) {
      if (view.plan) disposePlanCard(view.plan.node);
      view.plan = {
        signature: planSignature,
        node: renderPlanContainer({
          doc,
          events,
          projection: planProjection,
        }),
      };
    }
    const planContainer = view.plan.node;
    const planId = planContainer.dataset.llmPlanId;
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
    message.documentId || message.planDocumentId || scan.planDocumentId;
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
        existing.lead?.node.remove();
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
        onReady: (document) => {
          caption.hidden = false;
          rememberDocumentMarkdown(document);
          if (view.document?.node === card)
            syncDocumentLead(doc, view.document, document.visibleMarkdown);
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
    const markdown = knownDocumentMarkdown(planDocumentId, events);
    if (markdown !== undefined) syncDocumentLead(doc, view.document!, markdown);
  } else if (view.document) {
    disposePlanCard(view.document.node);
    view.document.caption.remove();
    view.document.lead?.node.remove();
    view.document = undefined;
  }

  // Chat owns the position below the final answer. Standalone trace surfaces
  // have no separate answer and keep their outcome below the other cards.
  if (actionSummaryHost)
    actionSummaryHost.replaceChildren(
      ...(actionCardNode ? [actionCardNode] : []),
    );
  else if (actionCardNode) wrap.appendChild(actionCardNode);

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

  // Only a run that asked for a discovery review can show its card.
  const discovery = scan.hasDiscovery
    ? getDiscoveryCardProjection(events)
    : undefined;
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
