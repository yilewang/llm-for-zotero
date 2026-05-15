export type StandaloneDraftSummary = {
  conversationKey?: number | null;
  kind?: "global" | "paper" | string | null;
  libraryID?: number | null;
  userTurnCount?: number | null;
};

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function hasNoUserTurns(summary: StandaloneDraftSummary): boolean {
  return (Number(summary.userTurnCount || 0) || 0) === 0;
}

export function isReusableStandaloneDraft(params: {
  forceFresh?: boolean;
  summary: StandaloneDraftSummary | null | undefined;
  kind: "global" | "paper";
  libraryID?: number | null;
}): boolean {
  const summary = params.summary;
  if (!summary) return false;
  if (summary.kind !== params.kind) return false;
  if (params.kind === "global") {
    const expectedLibraryID = normalizePositiveInt(params.libraryID);
    const summaryLibraryID = normalizePositiveInt(summary.libraryID);
    if (!expectedLibraryID || summaryLibraryID !== expectedLibraryID) {
      return false;
    }
  }
  return hasNoUserTurns(summary);
}

export function findReusableStandaloneDraft<
  T extends StandaloneDraftSummary,
>(params: { forceFresh?: boolean; summaries: readonly T[] }): T | null {
  return params.summaries.find((summary) => hasNoUserTurns(summary)) || null;
}
