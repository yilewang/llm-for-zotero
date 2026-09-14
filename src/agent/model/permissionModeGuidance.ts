import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";

/** Mode-specific instructions for the main agent model. Pure; no preference reads. */
export function buildPermissionModeGuidance(
  mode: OriginalAgentPermissionMode,
  assumptions: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  if (mode === "safe") {
    lines.push(
      "Permission mode: safe. Writes you were asked for are shown to the user for review before they run. Call the tool; do not ask for permission in text.",
    );
  } else if (mode === "auto") {
    lines.push(
      "Permission mode: auto. Requested writes run without review. Use request_user_input only for genuine ambiguity in the request that reading cannot resolve.",
    );
  } else {
    lines.push(
      "Permission mode: yolo. The user delegated judgment. Do not ask for confirmation or clarification; decide, act, and state your assumptions and any own-initiative changes in your reply. Actions beyond the literal request are authorized except explicit prohibitions, protected targets, chat-only memory, and importing discovered papers without the user's selection. Use request_user_input only when proceeding under any assumption would make the work useless.",
    );
  }
  if (assumptions.length)
    lines.push(
      `Interpretation assumptions: ${assumptions.join(" ")} State them in your reply.`,
    );
  return lines;
}
