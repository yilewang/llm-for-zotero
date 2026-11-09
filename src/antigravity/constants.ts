import { getClaudeProfileSignature } from "../claudeCode/projectSkills";
import {
  ANTIGRAVITY_GLOBAL_CONVERSATION_KEY_BASE,
  ANTIGRAVITY_PAPER_CONVERSATION_KEY_BASE,
  buildDefaultConversationKey,
  getConversationKeyRange,
  getRuntimeAllocatedConversationKeyRange,
  getRuntimeDefaultConversationKeyRange,
  isConversationKeyFor,
} from "../shared/conversationKeySpace";

export {
  ANTIGRAVITY_GLOBAL_CONVERSATION_KEY_BASE,
  ANTIGRAVITY_PAPER_CONVERSATION_KEY_BASE,
};
export const ANTIGRAVITY_HISTORY_LIMIT = 200;

/**
 * Used until the model catalog has been read from `agy models`. The CLI picks
 * its own default when `--model` is omitted, so an empty pref means "default".
 */
export const DEFAULT_ANTIGRAVITY_RUNTIME_MODEL = "";

export const ANTIGRAVITY_EFFORT_OPTIONS = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type AntigravityEffortMode = (typeof ANTIGRAVITY_EFFORT_OPTIONS)[number];

export function getAntigravityProfileSignature(): string {
  return getClaudeProfileSignature();
}

export function getAntigravityGlobalConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  return getConversationKeyRange(
    "antigravity",
    "global",
    getAntigravityProfileSignature(),
  );
}

export function getAntigravityPaperConversationKeyRange(): {
  start: number;
  endExclusive: number;
} {
  return getConversationKeyRange(
    "antigravity",
    "paper",
    getAntigravityProfileSignature(),
  );
}

export function getAntigravityDefaultConversationKeyRange(
  kind: "global" | "paper",
): { start: number; endExclusive: number } {
  return getRuntimeDefaultConversationKeyRange(
    "antigravity",
    kind,
    getAntigravityProfileSignature(),
  );
}

export function getAntigravityAllocatedConversationKeyRange(
  kind: "global" | "paper",
): { start: number; endExclusive: number } {
  return getRuntimeAllocatedConversationKeyRange(
    "antigravity",
    kind,
    getAntigravityProfileSignature(),
  );
}

export function buildDefaultAntigravityGlobalConversationKey(
  libraryID: number,
): number {
  return buildDefaultConversationKey(
    "antigravity",
    "global",
    libraryID,
    getAntigravityProfileSignature(),
  );
}

export function buildDefaultAntigravityPaperConversationKey(
  paperItemID: number,
): number {
  return buildDefaultConversationKey(
    "antigravity",
    "paper",
    paperItemID,
    getAntigravityProfileSignature(),
  );
}

export function isAntigravityConversationKey(conversationKey: number): boolean {
  return isConversationKeyFor("antigravity", conversationKey);
}
