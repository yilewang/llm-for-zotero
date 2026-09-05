import { getClaudeProfileSignature } from "./projectSkills";
import {
  buildDefaultConversationKey,
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CLAUDE_PAPER_CONVERSATION_KEY_BASE,
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
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CLAUDE_PAPER_CONVERSATION_KEY_BASE,
};
export const CLAUDE_PROFILE_KEY_MULTIPLIER = RUNTIME_PROFILE_KEY_MULTIPLIER;
export const CLAUDE_PROFILE_SLOT_MOD = RUNTIME_PROFILE_SLOT_MOD;
export const CLAUDE_HISTORY_LIMIT = 200;
export const CLAUDE_RUNTIME_RELEASE_GRACE_MS = 30_000;

export const DEFAULT_CLAUDE_RUNTIME_MODEL = "sonnet";
export type ClaudeRuntimeModel = string;

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
  return getProfileKeySlot(getClaudeProfileSignature());
}

export function getClaudeProfileKeyOffset(): number {
  return getProfileKeyOffset(getClaudeProfileSignature());
}

export function getClaudeGlobalConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  return getConversationKeyRange(
    "claude_code",
    "global",
    getClaudeProfileSignature(),
  );
}

export function getClaudePaperConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  return getConversationKeyRange(
    "claude_code",
    "paper",
    getClaudeProfileSignature(),
  );
}

export function getClaudeDefaultConversationKeyRange(
  kind: "global" | "paper",
): {
  start: number;
  endExclusive: number;
} {
  return getRuntimeDefaultConversationKeyRange(
    "claude_code",
    kind,
    getClaudeProfileSignature(),
  );
}

export function getClaudeAllocatedConversationKeyRange(
  kind: "global" | "paper",
): {
  start: number;
  endExclusive: number;
} {
  return getRuntimeAllocatedConversationKeyRange(
    "claude_code",
    kind,
    getClaudeProfileSignature(),
  );
}

export function buildDefaultClaudeGlobalConversationKey(
  libraryID: number,
): number {
  return buildDefaultConversationKey(
    "claude_code",
    "global",
    libraryID,
    getClaudeProfileSignature(),
  );
}

export function buildDefaultClaudePaperConversationKey(
  paperItemID: number,
): number {
  return buildDefaultConversationKey(
    "claude_code",
    "paper",
    paperItemID,
    getClaudeProfileSignature(),
  );
}

export function isClaudeConversationKey(conversationKey: number): boolean {
  return isConversationKeyFor("claude_code", conversationKey);
}
