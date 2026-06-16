import type {
  AgentPendingAction,
  AgentPendingActionButton,
  AgentPendingField,
  AgentToolResult,
} from "../types";

export type PagedActionInput = {
  limit?: number;
  pageSize?: number;
  startOffset?: number;
};

export type PagedActionOptions = {
  limit?: number;
  pageSize: number;
  startOffset: number;
};

export type PagedActionPage<T> = {
  items: T[];
  pageIndex: number;
  totalPages: number;
  offset: number;
};

export const DEFAULT_ACTION_PAGE_SIZE = 20;
export const MAX_ACTION_PAGE_SIZE = 100;
export const ACTION_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
export const DEFAULT_TAGS_PER_PAPER = 5;
export const MAX_TAGS_PER_PAPER = 6;

export type PagedOperationMeta = {
  actionName: string;
  pageIndex: number;
  totalPages: number;
  pageSize?: number;
  tagsPerPaper?: number;
};

export function normalizeActionPageSize(value: unknown): number {
  const numeric =
    typeof value === "string" && value.trim()
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_ACTION_PAGE_SIZE;
  }
  const bounded = Math.max(
    1,
    Math.min(MAX_ACTION_PAGE_SIZE, Math.floor(numeric)),
  );
  for (const option of ACTION_PAGE_SIZE_OPTIONS) {
    if (bounded <= option) return option;
  }
  return MAX_ACTION_PAGE_SIZE;
}

export function normalizeTagsPerPaper(value: unknown): number {
  const numeric =
    typeof value === "string" && value.trim()
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_TAGS_PER_PAPER;
  }
  return Math.max(1, Math.min(MAX_TAGS_PER_PAPER, Math.floor(numeric)));
}

export function normalizeActionLimit(value: unknown): number | undefined {
  const numeric =
    typeof value === "string" && value.trim()
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.max(1, Math.floor(numeric));
}

export function normalizeActionStartOffset(value: unknown): number {
  const numeric =
    typeof value === "string" && value.trim()
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.max(0, Math.floor(numeric));
}

export function getPagedActionOptions(
  input: PagedActionInput,
): PagedActionOptions {
  return {
    limit: normalizeActionLimit(input.limit),
    pageSize: normalizeActionPageSize(input.pageSize),
    startOffset: normalizeActionStartOffset(input.startOffset),
  };
}

export function applyPagedActionWindow<T>(
  items: T[],
  options: PagedActionOptions,
): T[] {
  const fromOffset =
    options.startOffset > 0 ? items.slice(options.startOffset) : items;
  return options.limit ? fromOffset.slice(0, options.limit) : fromOffset;
}

export function getPagedActionPages<T>(
  items: T[],
  options: PagedActionOptions,
): PagedActionPage<T>[] {
  const windowed = applyPagedActionWindow(items, options);
  const totalPages = Math.max(1, Math.ceil(windowed.length / options.pageSize));
  const pages: PagedActionPage<T>[] = [];
  for (let offset = 0; offset < windowed.length; offset += options.pageSize) {
    pages.push({
      items: windowed.slice(offset, offset + options.pageSize),
      pageIndex: pages.length + 1,
      totalPages,
      offset: options.startOffset + offset,
    });
  }
  return pages;
}

export function formatActionPageLabel(page: {
  pageIndex: number;
  totalPages: number;
}): string {
  return `Page ${page.pageIndex} of ${page.totalPages}`;
}

export function getPagedOperationId(
  actionName: string,
  page: { pageIndex: number; totalPages: number },
  options: { pageSize?: number; tagsPerPaper?: number } = {},
): string {
  const parts = [`${actionName}:page:${page.pageIndex}:${page.totalPages}`];
  if (options.pageSize)
    parts.push(`size:${normalizeActionPageSize(options.pageSize)}`);
  if (options.tagsPerPaper) {
    parts.push(`tags:${normalizeTagsPerPaper(options.tagsPerPaper)}`);
  }
  return parts.join(":");
}

export function readPagedOperationMeta(
  id: string | undefined,
): PagedOperationMeta | null {
  const match =
    /^([^:]+):page:(\d+):(\d+)(?::size:(\d+))?(?::tags:(\d+))?(?::.*)?$/.exec(
      id || "",
    );
  if (!match) return null;
  const pageIndex = Number(match[2]);
  const totalPages = Number(match[3]);
  if (!Number.isFinite(pageIndex) || !Number.isFinite(totalPages)) return null;
  return {
    actionName: match[1],
    pageIndex,
    totalPages,
    pageSize: match[4] ? normalizeActionPageSize(Number(match[4])) : undefined,
    tagsPerPaper: match[5]
      ? normalizeTagsPerPaper(Number(match[5]))
      : undefined,
  };
}

export function readPagedOperationLabel(id: string | undefined): string {
  const meta = readPagedOperationMeta(id);
  return meta ? `Page ${meta.pageIndex} of ${meta.totalPages}` : "";
}

export function buildPagedReviewActions(
  meta: PagedOperationMeta,
  options: { includeRefresh?: boolean } = {},
): AgentPendingActionButton[] {
  const actions: AgentPendingActionButton[] = [];
  if (meta.pageIndex > 1) {
    actions.push({
      id: "previous",
      label: "Previous page",
      style: "secondary",
      approved: false,
    });
  }
  actions.push({ id: "confirm", label: "Confirm", style: "primary" });
  if (options.includeRefresh) {
    actions.push({
      id: "refresh",
      label: "Refresh",
      style: "secondary",
      approved: false,
    });
  }
  actions.push({
    id: "cancel",
    label: "Cancel",
    style: "secondary",
    approved: false,
  });
  if (meta.pageIndex < meta.totalPages) {
    actions.push({
      id: "next",
      label: "Next page",
      style: "secondary",
      approved: false,
    });
  }
  return actions;
}

export function getDefaultPagedReviewActionId(
  meta: PagedOperationMeta,
): string {
  return meta.pageIndex < meta.totalPages ? "next" : "confirm";
}

export function buildPagedReviewActionConfig(
  meta: PagedOperationMeta,
  options: { includeRefresh?: boolean } = {},
): Pick<
  AgentPendingAction,
  "mode" | "actions" | "defaultActionId" | "cancelActionId"
> {
  return {
    mode: "review",
    actions: buildPagedReviewActions(meta, options),
    defaultActionId: getDefaultPagedReviewActionId(meta),
    cancelActionId: "cancel",
  };
}

export function buildPageSizeSelectField(
  pageSize: number | undefined,
): Extract<AgentPendingField, { type: "select" }> {
  const normalized = normalizeActionPageSize(pageSize);
  return {
    type: "select",
    id: "pageSize",
    label: "Items on this page",
    value: `${normalized}`,
    options: ACTION_PAGE_SIZE_OPTIONS.map((option) => ({
      id: `${option}`,
      label: `${option}`,
    })),
  };
}

export function buildTagsPerPaperSelectField(
  tagsPerPaper: number | undefined,
): Extract<AgentPendingField, { type: "select" }> {
  const normalized = normalizeTagsPerPaper(tagsPerPaper);
  return {
    type: "select",
    id: "tagsPerPaper",
    label: "Tags per paper",
    value: `${normalized}`,
    options: Array.from(
      { length: MAX_TAGS_PER_PAPER },
      (_, index) => index + 1,
    ).map((option) => ({
      id: `${option}`,
      label: `${option}`,
    })),
  };
}

export function readToolConfirmationActionId(result: AgentToolResult): string {
  const content = result.content;
  if (!content || typeof content !== "object") return "";
  const value = (content as Record<string, unknown>).confirmationActionId;
  return typeof value === "string" ? value : "";
}

export function readToolConfirmationData(
  result: AgentToolResult,
): Record<string, unknown> {
  const content = result.content;
  if (!content || typeof content !== "object") return {};
  const value = (content as Record<string, unknown>).confirmationData;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readToolResultError(result: AgentToolResult): string {
  const content = result.content;
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error.trim();
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
  }
  return "";
}

export function isUserCancelledToolResult(result: AgentToolResult): boolean {
  return readToolResultError(result).toLowerCase() === "user denied action";
}
