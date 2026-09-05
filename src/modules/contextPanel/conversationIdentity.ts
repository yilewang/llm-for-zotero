import {
  resolveConversationKeyForNoteFocus,
  resolvePreferredConversationSystem,
} from "./portalScope";

// A real Zotero item cannot have its numeric ID changed.  When its historical
// deterministic conversation key is retired, provisioning records the fresh
// conversation key for this exact in-memory item object until the next panel
// mount can represent it with a synthetic portal item.  This avoids letting a
// stale global preference remap every raw paper object in the process.
const provisionedConversationKeys = new WeakMap<object, number>();

export function bindProvisionedConversationKey(
  item: Zotero.Item,
  conversationKey: number,
): void {
  if (!item || typeof item !== "object") return;
  const normalized = Math.floor(Number(conversationKey || 0));
  if (normalized > 0) provisionedConversationKeys.set(item, normalized);
}

export function getConversationKey(item: Zotero.Item): number {
  const provisionedKey =
    item && typeof item === "object"
      ? provisionedConversationKeys.get(item as object)
      : undefined;
  if (Number.isFinite(provisionedKey) && Number(provisionedKey) > 0) {
    return Math.floor(Number(provisionedKey));
  }
  const noteFocusConversationKey = resolveConversationKeyForNoteFocus(item, {
    conversationSystem: resolvePreferredConversationSystem({ item }),
  });
  if (noteFocusConversationKey) return noteFocusConversationKey;
  if (item.isAttachment() && item.parentID) {
    return item.parentID;
  }
  return item.id;
}
