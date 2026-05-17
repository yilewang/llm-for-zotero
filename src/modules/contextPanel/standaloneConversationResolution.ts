export type ConversationDraftSummary = {
  conversationKey?: number | null;
  kind?: "global" | "paper" | string | null;
  libraryID?: number | null;
  paperItemID?: number | null;
  providerSessionId?: string | null;
  scopedConversationKey?: string | null;
  userTurnCount?: number | null;
};

export type StandaloneDraftSummary = ConversationDraftSummary;

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function hasNoUserTurns(summary: ConversationDraftSummary): boolean {
  const userTurnCount = Number(summary.userTurnCount);
  return Number.isFinite(userTurnCount) && userTurnCount === 0;
}

function hasNoProviderThreadState(summary: ConversationDraftSummary): boolean {
  return !summary.providerSessionId?.trim() && !summary.scopedConversationKey?.trim();
}

function getDraftScopeKey(summary: ConversationDraftSummary): string | null {
  if (summary.kind !== "global" && summary.kind !== "paper") return null;
  if (summary.kind === "global") {
    const libraryID = normalizePositiveInt(summary.libraryID);
    return libraryID ? `global:${libraryID}` : null;
  }
  const paperItemID = normalizePositiveInt(summary.paperItemID);
  const libraryID = normalizePositiveInt(summary.libraryID);
  return paperItemID
    ? libraryID
      ? `paper:${libraryID}:${paperItemID}`
      : `paper:${paperItemID}`
    : null;
}

function normalizeActivityTimestamp(
  summary: ConversationDraftSummary & {
    createdAt?: number | null;
    lastActivityAt?: number | null;
    updatedAt?: number | null;
  },
): number {
  const timestamp = Number(
    summary.lastActivityAt || summary.updatedAt || summary.createdAt || 0,
  );
  return Number.isFinite(timestamp) && timestamp > 0
    ? Math.floor(timestamp)
    : 0;
}

export function isReusableConversationDraft(params: {
  forceFresh?: boolean;
  summary: ConversationDraftSummary | null | undefined;
  kind?: "global" | "paper";
  libraryID?: number | null;
  paperItemID?: number | null;
}): boolean {
  const summary = params.summary;
  if (!summary) return false;
  if (params.kind && summary.kind !== params.kind) return false;
  if (params.kind === "global") {
    const expectedLibraryID = normalizePositiveInt(params.libraryID);
    const summaryLibraryID = normalizePositiveInt(summary.libraryID);
    if (!expectedLibraryID || summaryLibraryID !== expectedLibraryID) {
      return false;
    }
  }
  if (params.kind === "paper") {
    const expectedPaperItemID = normalizePositiveInt(params.paperItemID);
    const summaryPaperItemID = normalizePositiveInt(summary.paperItemID);
    if (!expectedPaperItemID || summaryPaperItemID !== expectedPaperItemID) {
      return false;
    }
  }
  return hasNoUserTurns(summary) && hasNoProviderThreadState(summary);
}

export function findReusableConversationDraft<
  T extends ConversationDraftSummary,
>(params: {
  forceFresh?: boolean;
  summaries: readonly T[];
  kind?: "global" | "paper";
  libraryID?: number | null;
  paperItemID?: number | null;
}): T | null {
  return (
    params.summaries.find((summary) =>
      isReusableConversationDraft({
        forceFresh: params.forceFresh,
        summary,
        kind: params.kind,
        libraryID: params.libraryID,
        paperItemID: params.paperItemID,
      }),
    ) || null
  );
}

export function isReusableStandaloneDraft(params: {
  forceFresh?: boolean;
  summary: StandaloneDraftSummary | null | undefined;
  kind: "global" | "paper";
  libraryID?: number | null;
  paperItemID?: number | null;
}): boolean {
  return isReusableConversationDraft(params);
}

export function findReusableStandaloneDraft<
  T extends StandaloneDraftSummary,
>(params: {
  forceFresh?: boolean;
  summaries: readonly T[];
  kind?: "global" | "paper";
  libraryID?: number | null;
  paperItemID?: number | null;
}): T | null {
  return findReusableConversationDraft(params);
}

export function collapseDuplicateReusableConversationDrafts<
  T extends ConversationDraftSummary & {
    conversationKey?: number | null;
    createdAt?: number | null;
    lastActivityAt?: number | null;
    updatedAt?: number | null;
  },
>(params: {
  entries: readonly T[];
  activeConversationKey?: number | null;
}): T[] {
  const activeConversationKey = normalizePositiveInt(params.activeConversationKey);
  const selectedByScope = new Map<string, T>();
  const reusableScopeByEntry = new Map<T, string>();

  for (const entry of params.entries) {
    if (
      !isReusableConversationDraft({
        summary: entry,
        kind: entry.kind === "paper" ? "paper" : entry.kind === "global" ? "global" : undefined,
        libraryID: entry.libraryID,
        paperItemID: entry.paperItemID,
      })
    ) {
      continue;
    }
    const scopeKey = getDraftScopeKey(entry);
    if (!scopeKey) continue;
    reusableScopeByEntry.set(entry, scopeKey);
    const selected = selectedByScope.get(scopeKey);
    if (!selected) {
      selectedByScope.set(scopeKey, entry);
      continue;
    }
    const entryKey = normalizePositiveInt(entry.conversationKey);
    const selectedKey = normalizePositiveInt(selected.conversationKey);
    const entryIsActive = Boolean(activeConversationKey && entryKey === activeConversationKey);
    const selectedIsActive = Boolean(activeConversationKey && selectedKey === activeConversationKey);
    if (entryIsActive !== selectedIsActive) {
      if (entryIsActive) selectedByScope.set(scopeKey, entry);
      continue;
    }
    const entryTimestamp = normalizeActivityTimestamp(entry);
    const selectedTimestamp = normalizeActivityTimestamp(selected);
    if (
      entryTimestamp > selectedTimestamp ||
      (entryTimestamp === selectedTimestamp && (entryKey || 0) > (selectedKey || 0))
    ) {
      selectedByScope.set(scopeKey, entry);
    }
  }

  return params.entries.filter((entry) => {
    const scopeKey = reusableScopeByEntry.get(entry);
    if (!scopeKey) return true;
    return selectedByScope.get(scopeKey) === entry;
  });
}
