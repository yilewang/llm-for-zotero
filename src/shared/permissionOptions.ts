import type { OriginalAgentPermissionMode } from "./originalAgentPermissionMode";
import type { ClaudePermissionMode } from "./claudePermissionMode";

export type PermissionProvider = "original" | "claude" | "codex";

export type PermissionOption = {
  selectionKey: string;
  provider: PermissionProvider;
  fullLabel: string;
  compactLabel: string;
  description: string;
  available: boolean;
  disabledReason?: string;
};

export type CodexPermissionProfile = {
  id: string;
  description: string;
  allowed: boolean;
  disabledReason?: string;
};

const ORIGINAL_OPTIONS: Record<OriginalAgentPermissionMode, PermissionOption> =
  {
    safe: {
      provider: "original",
      selectionKey: "original:safe",
      fullLabel: "Safe",
      compactLabel: "safe",
      description:
        "Requested new notes are created directly. Other writes, commands, scripts, and network actions are shown for review first. Literature discovery shows a selection card.",
      available: true,
    },
    auto: {
      provider: "original",
      selectionKey: "original:auto",
      fullLabel: "Auto",
      compactLabel: "auto",
      description:
        "Requested actions run without review. Existing-note edits are applied and then shown as a diff. The agent asks only for genuine ambiguity in the request or for dangerous shell commands.",
      available: true,
    },
    yolo: {
      provider: "original",
      selectionKey: "original:yolo",
      fullLabel: "Yolo",
      compactLabel: "yolo",
      description:
        "The agent acts on its own judgment without asking and may take actions beyond the literal request. Explicit prohibitions, protected items, the database, plan integrity checks, chat-only memory, and the paper selection card before importing discovered papers remain enforced. Also applies to plugin tools called by Claude Code or Codex.",
      available: true,
    },
  };

const CLAUDE_PRESENTATION: Record<
  ClaudePermissionMode,
  Omit<PermissionOption, "provider" | "selectionKey" | "available">
> = {
  plan: {
    fullLabel: "Plan",
    compactLabel: "plan",
    description: "Plan without executing tools that modify the environment.",
  },
  dontAsk: {
    fullLabel: "Don’t ask",
    compactLabel: "no prompts",
    description: "Decline permission prompts instead of asking the user.",
  },
  default: {
    fullLabel: "Default",
    compactLabel: "default",
    description: "Use Claude Code's standard permission behavior.",
  },
  acceptEdits: {
    fullLabel: "Accept edits",
    compactLabel: "edits",
    description:
      "Automatically accept file edits while retaining other prompts.",
  },
  auto: {
    fullLabel: "Auto approval",
    compactLabel: "auto",
    description: "Let Claude Code automatically resolve supported permissions.",
  },
  bypassPermissions: {
    fullLabel: "Bypass permissions",
    compactLabel: "bypass",
    description: "Bypass Claude Code permission checks for this runtime.",
  },
};

export function getOriginalPermissionOptions(): PermissionOption[] {
  return ["safe", "auto", "yolo"].map(
    (id) => ORIGINAL_OPTIONS[id as OriginalAgentPermissionMode],
  );
}

export function getOriginalPermissionModeFromSelectionKey(
  selectionKey: string,
): OriginalAgentPermissionMode | null {
  const mode = selectionKey.replace(/^original:/, "");
  return mode === "safe" || mode === "auto" || mode === "yolo" ? mode : null;
}

export function buildClaudePermissionOption(params: {
  id: ClaudePermissionMode;
  available?: boolean;
  description?: string;
  disabledReason?: string;
}): PermissionOption {
  const presentation = CLAUDE_PRESENTATION[params.id];
  return {
    provider: "claude",
    selectionKey: `claude:${params.id}`,
    ...presentation,
    description: params.description?.trim() || presentation.description,
    available: params.available !== false,
    disabledReason: params.disabledReason,
  };
}

export function getClaudePermissionModeFromSelectionKey(
  selectionKey: string,
): ClaudePermissionMode | null {
  const mode = selectionKey.replace(/^claude:/, "");
  return mode === "default" ||
    mode === "acceptEdits" ||
    mode === "plan" ||
    mode === "auto" ||
    mode === "dontAsk" ||
    mode === "bypassPermissions"
    ? mode
    : null;
}

export function buildPermissionAccessibleLabel(
  option: PermissionOption,
): string {
  const provider =
    option.provider === "claude"
      ? "Claude Code"
      : option.provider === "codex"
        ? "Codex"
        : "Original Agent";
  const description = option.description.trim();
  return `${provider} permission mode: ${option.fullLabel}${description ? ` — ${description}` : ""}`;
}
