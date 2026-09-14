/**
 * Permission mode for the in-plugin Original Agent.
 *
 * Unlike the legacy library-write preference, this mode governs every
 * Original Agent capability: Zotero mutations, local files, commands,
 * privileged scripts, and agent-controlled network access.
 * Claude Code and Codex retain their own independent native profiles.
 */
export type OriginalAgentPermissionMode = "auto" | "safe" | "yolo";

export function normalizeOriginalAgentPermissionMode(
  value: unknown,
): OriginalAgentPermissionMode {
  if (value === "yolo") return "yolo";
  if (value === "safe") return "safe";
  return "auto";
}

export function getOriginalAgentPermissionModeDescription(): string {
  return "Requested new notes are created directly and shown as saved-note cards in every mode. safe shows other writes, commands, scripts, and network actions for review first. auto runs requested actions without review, applies existing-note edits and then shows the diff, and asks only for genuine ambiguity or dangerous shell commands. yolo lets the agent act on its own judgment, including actions beyond the literal request. Explicit prohibitions, protected items, the database, plan integrity, chat-only memory, the paper selection card before importing discovered papers, and the change journal remain enforced in every mode.";
}
