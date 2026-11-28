import { positiveIntOrZero } from "../../../../core/values";
export const PAPER_CONTEXT_COLLAPSE_THRESHOLD = 5;

export type PaperContextCollapseState = {
  showSummaryChip: boolean;
  showPaperChips: boolean;
  expanded: boolean;
  summaryLabel: string;
};

type PaperContextCollapseParams = {
  itemId: number;
  paperCount: number;
  /** A Map or a compose-context store slot. */
  expandedByItem: {
    get(itemId: number): boolean | undefined;
    set(itemId: number, expanded: boolean): unknown;
    delete(itemId: number): unknown;
  };
  threshold?: number;
};

function formatSummaryLabel(paperCount: number): string {
  return `${paperCount} ${paperCount === 1 ? "item" : "items"}`;
}

export function getPaperContextCollapseState(
  params: PaperContextCollapseParams,
): PaperContextCollapseState {
  const itemId = positiveIntOrZero(params.itemId);
  const paperCount = Math.max(0, positiveIntOrZero(params.paperCount));
  const threshold =
    positiveIntOrZero(params.threshold) || PAPER_CONTEXT_COLLAPSE_THRESHOLD;

  if (!itemId || paperCount <= threshold) {
    if (itemId) params.expandedByItem.delete(itemId);
    return {
      showSummaryChip: false,
      showPaperChips: true,
      expanded: false,
      summaryLabel: "",
    };
  }

  const expanded = params.expandedByItem.get(itemId) === true;
  return {
    showSummaryChip: true,
    showPaperChips: expanded,
    expanded,
    summaryLabel: formatSummaryLabel(paperCount),
  };
}

export function togglePaperContextCollapseState(
  params: PaperContextCollapseParams,
): boolean {
  const itemId = positiveIntOrZero(params.itemId);
  const paperCount = Math.max(0, positiveIntOrZero(params.paperCount));
  const threshold =
    positiveIntOrZero(params.threshold) || PAPER_CONTEXT_COLLAPSE_THRESHOLD;
  if (!itemId || paperCount <= threshold) {
    if (itemId) params.expandedByItem.delete(itemId);
    return false;
  }

  const nextExpanded = params.expandedByItem.get(itemId) !== true;
  params.expandedByItem.set(itemId, nextExpanded);
  return nextExpanded;
}
