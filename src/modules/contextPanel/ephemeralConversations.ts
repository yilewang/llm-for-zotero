/**
 * In-memory lifecycle of the window's temporary side chat: its conversation
 * key comes from the reserved ephemeral band (conversationKeySpace.ts), and
 * nothing for that key is ever persisted. This module owns moving a side chat
 * to a new key (when the window switches between Paper and Library chat, the
 * key's kind must follow) and dropping it.
 */
import {
  isEphemeralConversationKey,
  allocateEphemeralGlobalConversationKey,
  allocateEphemeralPaperConversationKey,
} from "../../shared/conversationKeySpace";
import {
  clearEphemeralBackgroundContextProvider,
  moveEphemeralBackgroundContextProvider,
} from "../../shared/ephemeralBackgroundContext";
import { clearInMemoryAgentToolResultHandles } from "../../agent/store/toolResultHandles";
import {
  chatHistory,
  clearConversationOwnedRuntimeState,
  draftInputCache,
  isRequestPending,
  loadedConversationKeys,
  initializedConversationComposeContextKeys,
  selectedCollectionContextCache,
  selectedFileAttachmentCache,
  selectedFilePreviewExpandedCache,
  selectedImageCache,
  selectedImagePreviewActiveIndexCache,
  selectedImagePreviewExpandedCache,
  selectedNotePreviewExpandedCache,
  selectedOtherRefContextCache,
  selectedPaperContextCache,
  selectedPaperContextListExpandedCache,
  selectedPaperPreviewExpandedCache,
  selectedTagContextCache,
  attachedConversationCache,
  selectedTextCache,
  selectedTextPreviewExpandedCache,
} from "./state";

/** Composer caches that hold a side chat's attached context and previews. */
function clearComposerCaches(conversationKey: number): void {
  initializedConversationComposeContextKeys.delete(conversationKey);
  selectedImageCache.delete(conversationKey);
  selectedFileAttachmentCache.delete(conversationKey);
  selectedFilePreviewExpandedCache.delete(conversationKey);
  selectedPaperContextCache.delete(conversationKey);
  selectedOtherRefContextCache.delete(conversationKey);
  selectedCollectionContextCache.delete(conversationKey);
  selectedTagContextCache.delete(conversationKey);
  attachedConversationCache.delete(conversationKey);
  selectedPaperPreviewExpandedCache.delete(conversationKey);
  selectedPaperContextListExpandedCache.delete(conversationKey);
  selectedTextPreviewExpandedCache.delete(conversationKey);
  selectedNotePreviewExpandedCache.delete(conversationKey);
  selectedImagePreviewExpandedCache.delete(conversationKey);
  selectedImagePreviewActiveIndexCache.delete(conversationKey);
}

export {
  isEphemeralConversationKey,
  allocateEphemeralGlobalConversationKey,
  allocateEphemeralPaperConversationKey,
};
export {
  buildEphemeralBackgroundContextBlock,
  clearEphemeralBackgroundContextProvider,
  setEphemeralBackgroundContextProvider,
} from "../../shared/ephemeralBackgroundContext";

/**
 * Whether the side chat on `conversationKey` has a request in flight. A
 * remount or key move must wait while it does.
 */
export function isEphemeralConversationBusy(conversationKey: number): boolean {
  return (
    isEphemeralConversationKey(conversationKey) &&
    isRequestPending(conversationKey)
  );
}

/**
 * Move a side chat from `oldKey` to `newKey`, both ephemeral: its messages,
 * unsent draft, selected-text chips, and background context provider. The
 * old key's runtime state is then cleared. Returns false, changing nothing,
 * for a real key, the same key, or a side chat that is still answering.
 */
export function moveEphemeralConversation(
  oldKey: number,
  newKey: number,
): boolean {
  if (
    !isEphemeralConversationKey(oldKey) ||
    !isEphemeralConversationKey(newKey) ||
    Math.floor(oldKey) === Math.floor(newKey) ||
    isEphemeralConversationBusy(oldKey) ||
    isEphemeralConversationBusy(newKey)
  ) {
    return false;
  }
  const history = chatHistory.get(oldKey) || [];
  const draft = draftInputCache.get(oldKey);
  const selectedTexts = selectedTextCache.get(oldKey);
  // Images and file attachments are the user's own input and follow the chat.
  // Paper, other-reference, collection, and tag contexts belong to the old
  // context (paper vs library), so they are dropped, not carried over.
  const images = selectedImageCache.get(oldKey);
  const fileAttachments = selectedFileAttachmentCache.get(oldKey);
  moveEphemeralBackgroundContextProvider(oldKey, newKey);
  clearConversationOwnedRuntimeState(oldKey);
  selectedTextCache.delete(oldKey);
  clearComposerCaches(oldKey);
  clearInMemoryAgentToolResultHandles(oldKey);
  // A message's write-generation stamp belongs to the old key.
  chatHistory.set(
    newKey,
    history.map((message) => {
      const moved = { ...message };
      delete moved.conversationGeneration;
      return moved;
    }),
  );
  loadedConversationKeys.add(newKey);
  if (draft !== undefined) draftInputCache.set(newKey, draft);
  if (selectedTexts) selectedTextCache.set(newKey, selectedTexts);
  if (images) selectedImageCache.set(newKey, images);
  if (fileAttachments) selectedFileAttachmentCache.set(newKey, fileAttachments);
  return true;
}

/** Drop everything a side chat holds in memory (the side chat is closed). */
export function discardEphemeralConversation(conversationKey: number): void {
  if (!isEphemeralConversationKey(conversationKey)) return;
  clearEphemeralBackgroundContextProvider(conversationKey);
  clearConversationOwnedRuntimeState(conversationKey);
  selectedTextCache.delete(conversationKey);
  clearComposerCaches(conversationKey);
  clearInMemoryAgentToolResultHandles(conversationKey);
}
