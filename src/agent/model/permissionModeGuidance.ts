import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";

/** Mode-specific instructions for the main agent model. Pure; no preference reads. */
export function buildPermissionModeGuidance(
  mode: OriginalAgentPermissionMode,
  assumptions: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  if (mode === "safe") {
    lines.push(
      "Permission mode: safe. Every external write is shown to the user for review before it runs, including new-note creation. Call the concrete tool; the host owns the review UI.",
    );
  } else if (mode === "auto") {
    lines.push(
      "Permission mode: auto. Reads, ordinary writes and recoverable operations run directly. The host makes a bounded model review for other actions and asks the user only when intent is unclear, risk is excessive, or review cannot complete. Call the concrete tool; do not request permission yourself or treat shell syntax, a different library, or an output path as reasons to pause. Use request_user_input only for a material missing choice that reading or bounded search cannot resolve.",
    );
  } else {
    lines.push(
      "Permission mode: yolo. The user delegated permission decisions completely, including ambiguous or dangerous actions and filesystem or library expansion. The host does not run an approval model or ask for permission. Decide, act, and state your assumptions and any own-initiative changes in your reply. Requested review workflows, database integrity and the paper selection card for papers the user asked you to find remain binding. Use request_user_input only when proceeding under any assumption would make the work useless.",
    );
  }
  if (assumptions.length)
    lines.push(
      `Interpretation assumptions: ${assumptions.join(" ")} State them in your reply.`,
    );
  return lines;
}
