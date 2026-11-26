import { getClaudeProfileSignature } from "../claudeCode/projectSkills";
import {
  buildDefaultConversationKey,
  getConversationKeyRange,
  getRuntimeAllocatedConversationKeyRange,
} from "../shared/conversationKeySpace";

export const CODEX_HISTORY_LIMIT = 200;

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
