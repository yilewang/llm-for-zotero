import type { OriginalAgentPermissionMode } from "./originalAgentPermissionMode";
import type { ClaudePermissionMode } from "./claudePermissionMode";
import {
  ANTIGRAVITY_PERMISSION_MODES,
  isAntigravityPermissionMode,
  type AntigravityPermissionMode,
} from "./antigravityPermissionMode";
import {
  RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS,
  runtimeConversationSystemForPermissionProvider,
} from "../core/conversations/conversationSystems";

export type PermissionProvider =
  | "original"
  | "claude"
  | "codex"
  | "antigravity";

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
        "Every external write, including new-note creation, is shown for review before it runs. Reads do not require review.",
      available: true,
    },
    auto: {
      provider: "original",
      selectionKey: "original:auto",
      fullLabel: "Auto",
      compactLabel: "auto",
      description:
        "Reads, ordinary writes and recoverable changes run automatically. Other actions receive model review; confirmation is requested only for unclear intent, excessive risk, or unavailable review.",
      available: true,
    },
    yolo: {
      provider: "original",
      selectionKey: "original:yolo",
      fullLabel: "Yolo",
      compactLabel: "yolo",
      description:
        "The Original Agent acts without permission prompts or approval-model calls, including ambiguous or dangerous actions. Requested review workflows, execution integrity and the paper selection card for discovered papers remain enforced. Claude Code, Codex, and external MCP callers keep their own permission controls.",
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

const ANTIGRAVITY_PRESENTATION: Record<
  AntigravityPermissionMode,
  Omit<PermissionOption, "provider" | "selectionKey" | "available">
> = {
  default: {
    fullLabel: "Default",
    compactLabel: "default",
    description:
      "Antigravity asks before edits, commands, and Zotero writes. Zotero reads run without asking.",
  },
  "accept-edits": {
    fullLabel: "Accept edits",
    compactLabel: "edits",
    description:
      "Antigravity edits files without asking and asks before commands, deletions, and Zotero writes.",
  },
  auto: {
    fullLabel: "Auto",
    compactLabel: "auto",
    description:
      "Antigravity runs most tools without asking and asks only before deleting.",
  },
  plan: {
    fullLabel: "Plan",
    compactLabel: "plan",
    description: "Antigravity plans and asks before it changes anything.",
  },
  "full-access": {
    fullLabel: "Full access",
    compactLabel: "full",
    description:
      "Antigravity runs every tool without asking, in its own agy process started with --dangerously-skip-permissions.",
  },
};

export function getAntigravityPermissionOptions(): PermissionOption[] {
  return ANTIGRAVITY_PERMISSION_MODES.map((mode) => ({
    provider: "antigravity",
    selectionKey: `antigravity:${mode}`,
    ...ANTIGRAVITY_PRESENTATION[mode],
    available: true,
  }));
}

export function getAntigravityPermissionModeFromSelectionKey(
  selectionKey: string,
): AntigravityPermissionMode | null {
  const mode = selectionKey.replace(/^antigravity:/, "");
  return isAntigravityPermissionMode(mode) ? mode : null;
}

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
  const runtime = runtimeConversationSystemForPermissionProvider(
    option.provider,
  );
  const provider = runtime
    ? RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS[runtime].label
    : "Original Agent";
  const description = option.description.trim();
  return `${provider} permission mode: ${option.fullLabel}${description ? ` — ${description}` : ""}`;
}
