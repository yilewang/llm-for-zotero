export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export function normalizeClaudePermissionMode(
  value: unknown,
): ClaudePermissionMode {
  if (typeof value !== "string") return "default";
  const normalized = value.trim();
  return CLAUDE_PERMISSION_MODES.includes(normalized as ClaudePermissionMode)
    ? (normalized as ClaudePermissionMode)
    : "default";
}
