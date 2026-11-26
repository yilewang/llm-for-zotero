export type ConversationDraftSummary = {
  conversationKey?: number | null;
  kind?: "global" | "paper" | string | null;
  libraryID?: number | null;
  paperItemID?: number | null;
  providerSessionId?: string | null;
  scopedConversationKey?: string | null;
  userTurnCount?: number | null;
  title?: string | null;
  isDraft?: boolean | null;
};

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function hasNoUserTurns(summary: ConversationDraftSummary): boolean {
  if (summary.isDraft === false) return false;
  const userTurnCount = Number(summary.userTurnCount);
  return Number.isFinite(userTurnCount) && userTurnCount === 0;
}

function hasNoProviderThreadState(summary: ConversationDraftSummary): boolean {
  return (
    !summary.providerSessionId?.trim() && !summary.scopedConversationKey?.trim()
  );
}

const GENERATED_DRAFT_TITLES = new Set([
  "new chat",
  "new claude chat",
  "new claude paper chat",
  "new codex chat",
  "new codex paper chat",
]);

function hasMeaningfulConversationTitle(
  summary: ConversationDraftSummary,
): boolean {
  const title = typeof summary.title === "string" ? summary.title.trim() : "";
  if (!title) return false;
  return !GENERATED_DRAFT_TITLES.has(title.toLowerCase());
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
  return (
    hasNoUserTurns(summary) &&
    hasNoProviderThreadState(summary) &&
    !hasMeaningfulConversationTitle(summary)
  );
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
  const activeConversationKey = normalizePositiveInt(
    params.activeConversationKey,
  );
  const selectedByScope = new Map<string, T>();
  const reusableScopeByEntry = new Map<T, string>();

  for (const entry of params.entries) {
    if (
      !isReusableConversationDraft({
        summary: entry,
        kind:
          entry.kind === "paper"
            ? "paper"
            : entry.kind === "global"
              ? "global"
              : undefined,
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
    const entryIsActive = Boolean(
      activeConversationKey && entryKey === activeConversationKey,
    );
    const selectedIsActive = Boolean(
      activeConversationKey && selectedKey === activeConversationKey,
    );
    if (entryIsActive !== selectedIsActive) {
      if (entryIsActive) selectedByScope.set(scopeKey, entry);
      continue;
    }
    const entryTimestamp = normalizeActivityTimestamp(entry);
    const selectedTimestamp = normalizeActivityTimestamp(selected);
    if (
      entryTimestamp > selectedTimestamp ||
      (entryTimestamp === selectedTimestamp &&
        (entryKey || 0) > (selectedKey || 0))
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
