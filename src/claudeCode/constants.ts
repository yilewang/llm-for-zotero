import { getClaudeProfileSignature } from "./projectSkills";

export const CLAUDE_GLOBAL_CONVERSATION_KEY_BASE = 3_000_000_000_000_000;
export const CLAUDE_PAPER_CONVERSATION_KEY_BASE = 4_000_000_000_000_000;
export const CLAUDE_PROFILE_KEY_MULTIPLIER = 1_000_000_000;
export const CLAUDE_PROFILE_SLOT_MOD = 999_999;
export const CLAUDE_HISTORY_LIMIT = 200;
export const CLAUDE_RUNTIME_RELEASE_GRACE_MS = 30_000;

export const CLAUDE_MODEL_OPTIONS = ["sonnet", "opus", "haiku"] as const;
export type ClaudeRuntimeModel = (typeof CLAUDE_MODEL_OPTIONS)[number];

export const CLAUDE_REASONING_OPTIONS = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ClaudeReasoningMode = (typeof CLAUDE_REASONING_OPTIONS)[number];

export function getClaudeProfileKeySlot(): number {
  const signature = getClaudeProfileSignature();
  const hex = signature.replace(/^profile-/, "");
  const parsed = Number.parseInt(hex, 16);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return (parsed % CLAUDE_PROFILE_SLOT_MOD) + 1;
}

export function getClaudeProfileKeyOffset(): number {
  return getClaudeProfileKeySlot() * CLAUDE_PROFILE_KEY_MULTIPLIER;
}

export function getClaudeGlobalConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  const start = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + getClaudeProfileKeyOffset();
  return {
    start,
    endExclusive: start + CLAUDE_PROFILE_KEY_MULTIPLIER,
  };
}

export function getClaudePaperConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  const start = CLAUDE_PAPER_CONVERSATION_KEY_BASE + getClaudeProfileKeyOffset();
  return {
    start,
    endExclusive: start + CLAUDE_PROFILE_KEY_MULTIPLIER,
  };
}

export function buildDefaultClaudeGlobalConversationKey(libraryID: number): number {
  return getClaudeGlobalConversationKeyRange().start + Math.max(1, Math.floor(libraryID));
}

export function buildDefaultClaudePaperConversationKey(paperItemID: number): number {
  return getClaudePaperConversationKeyRange().start + Math.max(1, Math.floor(paperItemID));
}

export function isClaudeConversationKey(conversationKey: number): boolean {
  return Number.isFinite(conversationKey) && conversationKey >= 3_000_000_000;
}
