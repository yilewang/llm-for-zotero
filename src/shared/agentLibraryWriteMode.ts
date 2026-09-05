/**
 * How much the in-plugin agent may change the Zotero library without asking.
 *
 * This is deliberately a SEPARATE key from `agentPermissionMode`. That one's
 * on-screen help text promises users it "affects Claude Code's bridge
 * permission mode only; Zotero MCP and tool-specific safety checks can still
 * require confirmation" — a promise the MCP path still keeps. Reusing the
 * stored value would silently convert consent given for bash prompting into
 * consent for unattended whole-library rewrites.
 *
 * - `auto`   — the default. Confirms only what cannot be undone. Everything
 *              else applies immediately and stays revertible from the agent
 *              history.
 * - `safe`   — every library write is reviewed. Batch jobs pause per page.
 * - `yolo`   — the model's judgement decides, including irreversible writes.
 *              Batch jobs run to completion without per-page review.
 *
 * `auto` exists because the binary mode made the agent unusable for ordinary
 * work: one request that created a collection and filed a paper into it
 * raised TWO cards, and a three-step request raised three. That is a wizard,
 * not an agent. Confirming everything also stopped buying much safety once
 * every reversible write became journalled with a working inverse — so the
 * burden is now proportional to reversibility rather than uniform.
 */
export type AgentLibraryWriteMode = "auto" | "safe" | "yolo";

export function normalizeAgentLibraryWriteMode(
  value: unknown,
): AgentLibraryWriteMode {
  if (value === "yolo") return "yolo";
  if (value === "safe") return "safe";
  return "auto";
}

export function getAgentLibraryWriteModeDescription(): string {
  return "auto (default) applies changes that can be undone and asks only before something irreversible — permanently erasing, deleting a tag library-wide, or merging duplicates. safe reviews every library change before it happens, and batch jobs pause on each page. yolo lets the agent apply changes on its own judgement, including irreversible ones and whole-library batch jobs. Every reversible change is recorded either way and can be reverted from the agent history.";
}
