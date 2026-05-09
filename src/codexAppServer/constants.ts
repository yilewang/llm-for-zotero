import { getClaudeProfileSignature } from "../claudeCode/projectSkills";

export const CODEX_GLOBAL_CONVERSATION_KEY_BASE = 5_000_000_000_000_000;
export const CODEX_PAPER_CONVERSATION_KEY_BASE = 6_000_000_000_000_000;
export const CODEX_PROFILE_KEY_MULTIPLIER = 1_000_000_000;
export const CODEX_PROFILE_SLOT_MOD = 999_999;
export const CODEX_HISTORY_LIMIT = 200;

export const CODEX_MODEL_OPTIONS = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
] as const;
export const DEFAULT_CODEX_RUNTIME_MODEL = "gpt-5.4";
export type CodexRuntimeModel = string;

export const CODEX_REASONING_OPTIONS = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type CodexReasoningMode = (typeof CODEX_REASONING_OPTIONS)[number];

export function getCodexProfileSignature(): string {
  return getClaudeProfileSignature();
}

export function getCodexProfileKeySlot(): number {
  const signature = getCodexProfileSignature();
  const hex = signature.replace(/^profile-/, "");
  const parsed = Number.parseInt(hex, 16);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return (parsed % CODEX_PROFILE_SLOT_MOD) + 1;
}

export function getCodexProfileKeyOffset(): number {
  return getCodexProfileKeySlot() * CODEX_PROFILE_KEY_MULTIPLIER;
}

export function getCodexGlobalConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  const start = CODEX_GLOBAL_CONVERSATION_KEY_BASE + getCodexProfileKeyOffset();
  return {
    start,
    endExclusive: start + CODEX_PROFILE_KEY_MULTIPLIER,
  };
}

export function getCodexPaperConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  const start = CODEX_PAPER_CONVERSATION_KEY_BASE + getCodexProfileKeyOffset();
  return {
    start,
    endExclusive: start + CODEX_PROFILE_KEY_MULTIPLIER,
  };
}

export function buildDefaultCodexGlobalConversationKey(libraryID: number): number {
  return getCodexGlobalConversationKeyRange().start + Math.max(1, Math.floor(libraryID));
}

export function buildDefaultCodexPaperConversationKey(paperItemID: number): number {
  return getCodexPaperConversationKeyRange().start + Math.max(1, Math.floor(paperItemID));
}

export function isCodexConversationKey(conversationKey: number): boolean {
  return (
    Number.isFinite(conversationKey) &&
    conversationKey >= CODEX_GLOBAL_CONVERSATION_KEY_BASE
  );
}
