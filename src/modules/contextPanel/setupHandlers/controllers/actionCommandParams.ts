export type ActionChatMode = "paper" | "library";
export type InlineActionCommand = {
  actionName: string;
  params: string;
};

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

export function parseInlineActionCommand(
  text: string,
): InlineActionCommand | null {
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  return {
    actionName: match[1],
    params: match[2]?.trim() || "",
  };
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

export function buildCommandDefaultInput(
  actionName: string,
  mode: ActionChatMode,
): Record<string, unknown> {
  return isPagedLibraryActionForMode(actionName, mode)
    ? { scope: "all", pageSize: DEFAULT_PAGED_ACTION_PAGE_SIZE }
    : {};
}
