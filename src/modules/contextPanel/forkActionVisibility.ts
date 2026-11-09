import { evaluateConversationForkEligibility } from "../../core/conversations/forkEligibility";
import type { ConversationSystem } from "../../shared/types";
import { resolveConversationStorageSystemForItem } from "./conversationProvisioning";
import {
  resolveActiveNoteSession,
  resolveConversationSystemForItem,
} from "./portalScope";
import type { Message } from "./types";

function normalizeConversationSystem(
  value: unknown,
): ConversationSystem | null {
  return value === "upstream" ||
    value === "claude_code" ||
    value === "codex" ||
    value === "antigravity"
    ? value
    : null;
}

function getPanelConversationSystem(
  body: Element | null | undefined,
): ConversationSystem | null {
  if (!body) return null;
  const directSystem = normalizeConversationSystem(
    (body as HTMLElement | null)?.dataset?.conversationSystem,
  );
  if (directSystem) return directSystem;
  const panelRoot = body.querySelector?.("#llm-main") as HTMLElement | null;
  return normalizeConversationSystem(panelRoot?.dataset?.conversationSystem);
}

export function resolveForkActionConversationSystem(params: {
  body?: Element | null;
  item: Zotero.Item;
  conversationSystem?: ConversationSystem | null;
}): ConversationSystem | null {
  if (resolveActiveNoteSession(params.item)) return null;
  return (
    getPanelConversationSystem(params.body) ||
    resolveConversationStorageSystemForItem({
      item: params.item,
      conversationSystem: params.conversationSystem,
    }) ||
    resolveConversationSystemForItem(params.item)
  );
}

export function shouldShowForkActionForAssistantTurn(params: {
  body?: Element | null;
  item: Zotero.Item;
  assistantTimestamp: unknown;
  assistantMessage?: Message | null;
  history?: readonly Message[] | null;
}): boolean {
  const system = resolveForkActionConversationSystem({
    body: params.body,
    item: params.item,
  });
  if (!system) return false;
  return evaluateConversationForkEligibility({
    system,
    assistantTimestamp: params.assistantTimestamp,
    assistantMessage: params.assistantMessage,
    history: params.history || [],
  }).visible;
}
