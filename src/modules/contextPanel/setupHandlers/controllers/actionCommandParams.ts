export type ActionChatMode = "paper" | "library";

const PAGED_LIBRARY_ACTION_NAMES = new Set([
  "audit_library",
  "organize_unfiled",
  "auto_tag",
]);
const DEFAULT_PAGED_ACTION_PAGE_SIZE = 20;

export function isPagedLibraryActionForMode(
  actionName: string,
  mode: ActionChatMode,
): boolean {
  return mode === "library" && PAGED_LIBRARY_ACTION_NAMES.has(actionName);
}

export function shouldExecuteAgentActionImmediatelyFromSlash(
  actionName: string,
  mode: ActionChatMode,
  hasPaperScopeProfile: boolean,
): boolean {
  return (
    isPagedLibraryActionForMode(actionName, mode) ||
    (mode === "paper" && hasPaperScopeProfile)
  );
}

export function parseCommandParams(
  actionName: string,
  params: string,
  mode: ActionChatMode,
): Record<string, unknown> {
  const isPagedLibraryAction = isPagedLibraryActionForMode(actionName, mode);
  const input: Record<string, unknown> = isPagedLibraryAction
    ? {
        scope: "all",
        pageSize: DEFAULT_PAGED_ACTION_PAGE_SIZE,
      }
    : {};
  if (params.trim()) {
    input.userQuery = params.trim();
  }
  if (!params) return input;
  const lower = params.toLowerCase();
  const pageSizeMatch = /(?:page\s*size|per\s*page|show)\s+(\d+)/i.exec(
    params,
  );
  if (pageSizeMatch && isPagedLibraryAction) {
    input.pageSize = parseInt(pageSizeMatch[1], 10);
    return input;
  }
  const firstNMatch =
    /(?:for\s+)?(?:first|top)\s+(\d+)\s*(?:items?|papers?)?/i.exec(params);
  if (firstNMatch) {
    input.limit = parseInt(firstNMatch[1], 10);
    return input;
  }
  const limitMatch = /(?:limit|cap)\s+(\d+)/i.exec(params);
  if (limitMatch) {
    input.limit = parseInt(limitMatch[1], 10);
    return input;
  }
  const lastNMatch = /(?:for\s+)?last\s+(\d+)\s*(?:items?|papers?)?/i.exec(
    params,
  );
  if (lastNMatch) {
    input.limit = parseInt(lastNMatch[1], 10);
    return input;
  }
  const collectionMatch = /(?:for\s+)?collection\s+(.+)/i.exec(params);
  if (collectionMatch) {
    input.scope = "collection";
    input.collectionName = collectionMatch[1].trim();
    return input;
  }
  if (
    lower.includes("whole library") ||
    lower.includes("for all") ||
    lower === "all"
  ) {
    input.scope = "all";
    return input;
  }
  const bareNumber = /^(\d+)$/.exec(params.trim());
  if (bareNumber) {
    if (isPagedLibraryAction) {
      input.pageSize = parseInt(bareNumber[1], 10);
    } else {
      input.limit = parseInt(bareNumber[1], 10);
    }
  }
  return input;
}
