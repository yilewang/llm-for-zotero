import type { PaperContextRef } from "./types";

export type FullReadTargetSelection =
  | { kind: "active" | "selected" | "available" }
  | { kind: "item_ids"; itemIds: number[] };

export class FullReadTargetResolutionError extends Error {}

/** Resolves structured selection against frozen context. This module accepts no prose. */
export function resolveFullReadPaperTargets(params: {
  selection: FullReadTargetSelection;
  availablePapers: PaperContextRef[];
  selectedPapers: PaperContextRef[];
  activePaper?: PaperContextRef | null;
}): { papers: PaperContextRef[]; reason: FullReadTargetSelection["kind"] } {
  const available = new Map(
    params.availablePapers.map((paper) => [paper.itemId, paper]),
  );
  const selection = params.selection;
  const ids =
    selection.kind === "item_ids"
      ? selection.itemIds
      : selection.kind === "available"
        ? [...available.keys()]
        : selection.kind === "selected"
          ? params.selectedPapers.map((paper) => paper.itemId)
          : params.activePaper
            ? [params.activePaper.itemId]
            : [];
  if (
    !ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || !available.has(id))
  ) {
    throw new FullReadTargetResolutionError(
      "The requested full-read paper is not available in the frozen context.",
    );
  }
  return {
    papers: [...new Set(ids)].map((id) => available.get(id)!),
    reason: selection.kind,
  };
}
