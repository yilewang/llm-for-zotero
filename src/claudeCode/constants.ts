import { getClaudeProfileSignature } from "./projectSkills";
import {
  buildDefaultConversationKey,
  getConversationKeyRange,
  getRuntimeAllocatedConversationKeyRange,
  isConversationKeyFor,
} from "../shared/conversationKeySpace";

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
