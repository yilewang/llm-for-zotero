import { getClaudeProfileSignature } from "../claudeCode/projectSkills";
import {
  buildDefaultConversationKey,
  getConversationKeyRange,
  getRuntimeAllocatedConversationKeyRange,
  isConversationKeyFor,
} from "../shared/conversationKeySpace";

/**
 * Antigravity conversation keys: the global band at 7e15 and the paper band
 * at 8e15 (see RUNTIME_CONVERSATION_SYSTEM_DESCRIPTORS), split by profile
 * like the other runtimes.
 */

export const ANTIGRAVITY_HISTORY_LIMIT = 200;

type KeyRange = { start: number; endExclusive: number };
type Kind = "global" | "paper";

/** The plugin profile signature, shared by every runtime store. */
export function getAntigravityProfileSignature(): string {
  return getClaudeProfileSignature();
}

export function getAntigravityConversationKeyRange(kind: Kind): KeyRange {
  return getConversationKeyRange(
    "antigravity",
    kind,
    getAntigravityProfileSignature(),
  );
}

export function getAntigravityAllocatedConversationKeyRange(
  kind: Kind,
): KeyRange {
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

function isInRange(value: number, range: KeyRange): boolean {
  return (
    Number.isFinite(value) &&
    value > 0 &&
    value >= range.start &&
    value < range.endExclusive
  );
}

/** Whether the key is in this profile's band of the kind. */
export function isAntigravityConversationKeyInRange(
  value: number,
  kind: Kind,
): boolean {
  return isInRange(value, getAntigravityConversationKeyRange(kind));
}

/** Whether the key is in this profile's allocated (non-default) range. */
export function isAntigravityConversationKeyInAllocatedRange(
  value: number,
  kind: Kind,
): boolean {
  return isInRange(value, getAntigravityAllocatedConversationKeyRange(kind));
}
