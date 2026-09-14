import type { RuntimeModelEntry } from "../../../../utils/modelProviders";
import {
  clearConversationOwnedRuntimeState,
  webChatIsolatedConversationKeys,
} from "../../state";

/**
 * Owner of the WebChat mode transition.
 *
 * WebChat is a provider auth mode, so the panel is "in webchat" exactly while
 * the selected model entry is a webchat entry. Leaving therefore means three
 * things that must always happen together, whichever control triggered it
 * (the Exit button, picking an API model, or switching to Codex/Claude Code):
 *
 * 1. the selected model entry becomes a non-webchat entry again, so no later
 *    render or Zotero start silently re-enters webchat;
 * 2. the ephemeral, catalog-hidden session row is dropped from every
 *    in-memory owner, so the panel cannot resolve back onto it and adopt it
 *    into visible history by accident;
 * 3. the panel returns to the paper's persisted last-used conversation, which
 *    the webchat session never overwrote.
 */
export type WebChatModeControllerDeps = {
  getItem: () => Zotero.Item | null;
  isWebChatMode: () => boolean;
  getConversationKey: (item: Zotero.Item) => number;
  getAvailableModelEntries: () => RuntimeModelEntry[];
  getSelectedModelEntryId: () => string | null;
  setSelectedModelEntry: (entryId: string) => void;
  abortPreload: () => void;
  removePreloadOverlay: () => void;
  stopConnectionCheck: () => void;
  clearNewChatIntent: () => void;
  applyWebChatModeUI: () => void;
  updateModelButton: () => void;
  updateReasoningButton: () => void;
  readComposerText: () => string;
  writeComposerText: (text: string) => void;
  switchPaperConversation: () => Promise<boolean>;
  refreshChatPreservingScroll: () => void;
  resetComposePreviewUI: () => void;
  log: (message: string, ...args: unknown[]) => void;
};

export type LeaveWebChatModeOptions = {
  /** The API entry the user picked explicitly; wins over the remembered one. */
  targetEntryId?: string | null;
  /**
   * Skip returning to the paper conversation. Used when the caller is about
   * to switch the conversation system, which replaces the conversation anyway.
   */
  restoreConversation?: boolean;
};

export function resolveWebChatExitModelEntryId(input: {
  previousEntryId: string | null;
  targetEntryId?: string | null;
  entries: RuntimeModelEntry[];
}): string | null {
  const isRestorable = (entryId: string | null | undefined) =>
    !!entryId &&
    input.entries.some(
      (entry) => entry.entryId === entryId && entry.authMode !== "webchat",
    );
  if (isRestorable(input.targetEntryId)) return input.targetEntryId!;
  if (isRestorable(input.previousEntryId)) return input.previousEntryId;
  return (
    input.entries.find((entry) => entry.authMode !== "webchat")?.entryId || null
  );
}

export function createWebChatModeController(deps: WebChatModeControllerDeps): {
  rememberModelBeforeEnteringWebChat: () => void;
  leaveWebChatMode: (options?: LeaveWebChatModeOptions) => Promise<boolean>;
} {
  let previousNonWebChatEntryId: string | null = null;

  const rememberModelBeforeEnteringWebChat = () => {
    previousNonWebChatEntryId = deps.getSelectedModelEntryId();
  };

  const leaveWebChatMode = async (
    options: LeaveWebChatModeOptions = {},
  ): Promise<boolean> => {
    const item = deps.getItem();
    if (!item || !deps.isWebChatMode()) return false;

    deps.abortPreload();
    deps.removePreloadOverlay();
    deps.stopConnectionCheck();
    deps.clearNewChatIntent();

    const conversationKey = deps.getConversationKey(item);
    const restoreEntryId = resolveWebChatExitModelEntryId({
      previousEntryId: previousNonWebChatEntryId,
      targetEntryId: options.targetEntryId,
      entries: deps.getAvailableModelEntries(),
    });
    if (restoreEntryId) deps.setSelectedModelEntry(restoreEntryId);
    previousNonWebChatEntryId = null;

    if (webChatIsolatedConversationKeys.has(conversationKey)) {
      clearConversationOwnedRuntimeState(conversationKey);
    }

    deps.updateModelButton();
    deps.updateReasoningButton();
    deps.applyWebChatModeUI();

    if (options.restoreConversation === false) return true;

    const carriedDraft = deps.readComposerText();
    let switched = false;
    try {
      switched = await deps.switchPaperConversation();
    } catch (err) {
      deps.log(
        "LLM: Failed to restore conversation after leaving webchat",
        err,
      );
    }
    if (carriedDraft.trim() && !deps.readComposerText().trim()) {
      deps.writeComposerText(carriedDraft);
    }
    if (!switched) {
      deps.refreshChatPreservingScroll();
      deps.resetComposePreviewUI();
    }
    return true;
  };

  return { rememberModelBeforeEnteringWebChat, leaveWebChatMode };
}
