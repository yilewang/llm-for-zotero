import { getClaudeProfileSignature } from "../claudeCode/projectSkills";
import {
  buildDefaultConversationKey,
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_PAPER_CONVERSATION_KEY_BASE,
  getConversationKeyRange,
  getRuntimeAllocatedConversationKeyRange,
  getRuntimeDefaultConversationKeyRange,
  getProfileKeyOffset,
  getProfileKeySlot,
  isConversationKeyFor,
  RUNTIME_PROFILE_KEY_MULTIPLIER,
  RUNTIME_PROFILE_SLOT_MOD,
} from "../shared/conversationKeySpace";

export {
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_PAPER_CONVERSATION_KEY_BASE,
};
export const CODEX_PROFILE_KEY_MULTIPLIER = RUNTIME_PROFILE_KEY_MULTIPLIER;
export const CODEX_PROFILE_SLOT_MOD = RUNTIME_PROFILE_SLOT_MOD;
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
export type CodexReasoningMode = string;

export function getCodexProfileSignature(): string {
  return getClaudeProfileSignature();
}

export function getCodexProfileKeySlot(): number {
  return getProfileKeySlot(getCodexProfileSignature());
}

export function getCodexProfileKeyOffset(): number {
  return getProfileKeyOffset(getCodexProfileSignature());
}

export function getCodexGlobalConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  return getConversationKeyRange("codex", "global", getCodexProfileSignature());
}

export function getCodexPaperConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  return getConversationKeyRange("codex", "paper", getCodexProfileSignature());
}

export function getCodexDefaultConversationKeyRange(kind: "global" | "paper"): {
  start: number;
  endExclusive: number;
} {
  return getRuntimeDefaultConversationKeyRange(
    "codex",
    kind,
    getCodexProfileSignature(),
  );
}

export function getCodexAllocatedConversationKeyRange(
  kind: "global" | "paper",
): {
  start: number;
  endExclusive: number;
} {
  return getRuntimeAllocatedConversationKeyRange(
    "codex",
    kind,
    getCodexProfileSignature(),
  );
}

export function buildDefaultCodexGlobalConversationKey(
  libraryID: number,
): number {
  return buildDefaultConversationKey(
    "codex",
    "global",
    libraryID,
    getCodexProfileSignature(),
  );
}

export function buildDefaultCodexPaperConversationKey(
  paperItemID: number,
): number {
  return buildDefaultConversationKey(
    "codex",
    "paper",
    paperItemID,
    getCodexProfileSignature(),
  );
}

export function isCodexConversationKey(conversationKey: number): boolean {
  return isConversationKeyFor("codex", conversationKey);
}
