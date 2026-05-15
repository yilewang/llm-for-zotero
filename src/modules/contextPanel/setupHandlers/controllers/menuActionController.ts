import { t } from "../../../../utils/i18n";
import {
  copyRenderedMarkdownToClipboard,
  copyTextToClipboard,
} from "../../chat";
import {
  buildChatHistoryNotePayload,
  createNoteFromAssistantText,
  createNoteFromChatHistory,
  createStandaloneNoteFromAssistantText,
  createStandaloneNoteFromChatHistory,
} from "../../notes";
import { isGlobalPortalItem } from "../../portalScope";
import { isClaudeGlobalPortalItem } from "../../../../claudeCode/portal";
import { positionMenuBelowButton } from "../../menuPositioning";
import { setStatus } from "../../textUtils";
import type { ConversationSystem, QuoteCitation } from "../../../../shared/types";
import type { ChatRuntimeMode, Message } from "../../types";

type ResponseMenuTarget = {
  item: Zotero.Item;
  contentText: string;
  modelName: string;
  conversationKey?: number;
  userTimestamp?: number;
  assistantTimestamp?: number;
  paperContexts?: import("../../types").PaperContextRef[];
  quoteCitations?: QuoteCitation[];
} | null;

type PromptMenuTarget = {
  item: Zotero.Item;
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
  editable?: boolean;
} | null;

type MenuActionControllerDeps = {
  body: Element;
  status: HTMLElement | null;
  responseMenu: HTMLDivElement | null;
  responseMenuCopyBtn: HTMLButtonElement | null;
  responseMenuNoteBtn: HTMLButtonElement | null;
  responseMenuDeleteBtn: HTMLButtonElement | null;
  promptMenu: HTMLDivElement | null;
  promptMenuDeleteBtn: HTMLButtonElement | null;
  exportMenu: HTMLDivElement | null;
  exportMenuCopyBtn: HTMLButtonElement | null;
  exportMenuNoteBtn: HTMLButtonElement | null;
  exportBtn: HTMLButtonElement | null;
  popoutBtn: HTMLButtonElement | null;
  settingsBtn: HTMLButtonElement | null;
  preferencesPaneId: string;
  getItem: () => Zotero.Item | null;
  getResponseMenuTarget: () => ResponseMenuTarget;
  getPromptMenuTarget: () => PromptMenuTarget;
  getCurrentLibraryID: () => number;
  getConversationSystem: () => ConversationSystem;
  getCurrentRuntimeModeForItem: (item: Zotero.Item) => ChatRuntimeMode | null;
  isGlobalMode: () => boolean;
  ensureConversationLoaded: (item: Zotero.Item) => Promise<void>;
  getConversationKey: (item: Zotero.Item) => number;
  getHistory: (conversationKey: number) => Message[];
  resolveActiveNoteSession: (item: Zotero.Item) => { noteKind?: string } | null;
  closeResponseMenu: () => void;
  closePromptMenu: () => void;
  closeExportMenu: () => void;
  closeRetryModelMenu: () => void;
  closeSlashMenu: () => void;
  closeHistoryNewMenu: () => void;
  closeHistoryMenu: () => void;
  queueTurnDeletion: (target: {
    conversationKey: number;
    userTimestamp: number;
    assistantTimestamp: number;
  }) => Promise<void>;
  logError: (message: string, error: unknown) => void;
};

function stopFloatingMenuPropagation(menu: HTMLDivElement): void {
  menu.addEventListener("pointerdown", (e: Event) => {
    e.stopPropagation();
  });
  menu.addEventListener("mousedown", (e: Event) => {
    e.stopPropagation();
  });
  menu.addEventListener("contextmenu", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

export function attachMenuActionController(
  deps: MenuActionControllerDeps,
): void {
  const setStatusMessage = (
    message: string,
    level: "ready" | "warning" | "error",
  ) => {
    if (deps.status) setStatus(deps.status, message, level);
  };

  if (
    deps.responseMenu &&
    deps.responseMenuCopyBtn &&
    deps.responseMenuNoteBtn &&
    !deps.responseMenu.dataset.listenerAttached
  ) {
    deps.responseMenu.dataset.listenerAttached = "true";
    stopFloatingMenuPropagation(deps.responseMenu);
    deps.responseMenuCopyBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const target = deps.getResponseMenuTarget();
      deps.closeResponseMenu();
      if (!target) return;
      await copyRenderedMarkdownToClipboard(deps.body, target.contentText);
      setStatusMessage(t("Copied response"), "ready");
    });
    deps.responseMenuNoteBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const target = deps.getResponseMenuTarget();
      deps.closeResponseMenu();
      if (!target) {
        deps.logError("LLM: Note save - no responseMenuTarget", null);
        return;
      }
      const {
        item: targetItem,
        contentText,
        modelName,
        paperContexts,
        quoteCitations,
      } = target;
      if (!targetItem || !contentText) {
        deps.logError("LLM: Note save - missing item or contentText", null);
        return;
      }
      try {
        const targetNoteSession = deps.resolveActiveNoteSession(targetItem);
        if (
          isGlobalPortalItem(targetItem) ||
          isClaudeGlobalPortalItem(targetItem) ||
          targetNoteSession?.noteKind === "standalone"
        ) {
          const libraryID =
            Number.isFinite(targetItem.libraryID) && targetItem.libraryID > 0
              ? Math.floor(targetItem.libraryID)
              : deps.getCurrentLibraryID();
          await createStandaloneNoteFromAssistantText(
            libraryID,
            contentText,
            modelName,
            paperContexts,
            quoteCitations,
          );
          setStatusMessage(t("Created a new note"), "ready");
          return;
        }
        const saveResult = await createNoteFromAssistantText(
          targetItem,
          contentText,
          modelName,
          paperContexts,
          {
            appendToTrackedNote: true,
            rememberCreatedNote: true,
            quoteCitations,
          },
        );
        setStatusMessage(
          saveResult === "appended"
            ? t("Appended to existing note")
            : t("Created a new note"),
          "ready",
        );
      } catch (err) {
        deps.logError("Create note failed:", err);
        setStatusMessage(t("Failed to create note"), "error");
      }
    });
    deps.responseMenuDeleteBtn?.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const target = deps.getResponseMenuTarget();
      deps.closeResponseMenu();
      if (!target || !deps.getItem()) return;
      const conversationKey = Number(target.conversationKey || 0);
      const userTimestamp = Number(target.userTimestamp || 0);
      const assistantTimestamp = Number(target.assistantTimestamp || 0);
      if (
        !Number.isFinite(conversationKey) ||
        conversationKey <= 0 ||
        !Number.isFinite(userTimestamp) ||
        userTimestamp <= 0 ||
        !Number.isFinite(assistantTimestamp) ||
        assistantTimestamp <= 0
      ) {
        setStatusMessage(t("No deletable turn found"), "error");
        return;
      }
      await deps.queueTurnDeletion({
        conversationKey: Math.floor(conversationKey),
        userTimestamp: Math.floor(userTimestamp),
        assistantTimestamp: Math.floor(assistantTimestamp),
      });
    });
  }

  if (deps.promptMenu && !deps.promptMenu.dataset.listenerAttached) {
    deps.promptMenu.dataset.listenerAttached = "true";
    stopFloatingMenuPropagation(deps.promptMenu);
    deps.promptMenuDeleteBtn?.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const target = deps.getPromptMenuTarget();
      deps.closePromptMenu();
      if (!target || !deps.getItem()) return;
      if (
        !Number.isFinite(target.userTimestamp) ||
        target.userTimestamp <= 0 ||
        !Number.isFinite(target.assistantTimestamp) ||
        target.assistantTimestamp <= 0
      ) {
        setStatusMessage(t("No deletable turn found"), "error");
        return;
      }
      await deps.queueTurnDeletion({
        conversationKey: Math.floor(target.conversationKey),
        userTimestamp: Math.floor(target.userTimestamp),
        assistantTimestamp: Math.floor(target.assistantTimestamp),
      });
    });
  }

  if (
    deps.exportMenu &&
    deps.exportMenuCopyBtn &&
    deps.exportMenuNoteBtn &&
    !deps.exportMenu.dataset.listenerAttached
  ) {
    deps.exportMenu.dataset.listenerAttached = "true";
    stopFloatingMenuPropagation(deps.exportMenu);
    deps.exportMenuCopyBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const item = deps.getItem();
      if (!item) return;
      await deps.ensureConversationLoaded(item);
      const conversationKey = deps.getConversationKey(item);
      const payload = buildChatHistoryNotePayload(
        deps.getHistory(conversationKey),
      );
      if (!payload.noteText) {
        setStatusMessage(t("No chat history detected."), "ready");
        deps.closeExportMenu();
        return;
      }
      await copyTextToClipboard(deps.body, payload.noteText);
      setStatusMessage(t("Copied chat as md"), "ready");
      deps.closeExportMenu();
    });
    deps.exportMenuNoteBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const currentItem = deps.getItem();
      const currentLibraryID = deps.getCurrentLibraryID();
      deps.closeExportMenu();
      if (!currentItem) return;
      try {
        await deps.ensureConversationLoaded(currentItem);
        const conversationKey = deps.getConversationKey(currentItem);
        const history = deps.getHistory(conversationKey);
        const payload = buildChatHistoryNotePayload(history);
        if (!payload.noteText) {
          setStatusMessage(t("No chat history detected."), "ready");
          return;
        }
        if (deps.isGlobalMode()) {
          await createStandaloneNoteFromChatHistory(currentLibraryID, history);
        } else {
          await createNoteFromChatHistory(currentItem, history);
        }
        setStatusMessage(t("Saved chat history to new note"), "ready");
      } catch (err) {
        deps.logError("Save chat history note failed:", err);
        setStatusMessage(t("Failed to save chat history"), "error");
      }
    });
  }

  deps.exportBtn?.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    const item = deps.getItem();
    const exportBtn = deps.exportBtn;
    const exportMenu = deps.exportMenu;
    if (!exportBtn || exportBtn.disabled || !exportMenu || !item) return;
    deps.closeRetryModelMenu();
    deps.closeSlashMenu();
    deps.closeResponseMenu();
    deps.closePromptMenu();
    deps.closeHistoryNewMenu();
    deps.closeHistoryMenu();
    if (exportMenu.style.display !== "none") {
      deps.closeExportMenu();
      return;
    }
    positionMenuBelowButton(deps.body, exportMenu, exportBtn);
  });

  deps.popoutBtn?.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const {
        isStandaloneWindowActive,
        openStandaloneChat,
      } = require("../../standaloneWindow");
      const item = deps.getItem();
      if (isStandaloneWindowActive()) {
        addon.data.standaloneWindow?.close();
      } else {
        openStandaloneChat({
          initialItem: item,
          initialConversationSystem: deps.getConversationSystem(),
          initialRuntimeMode: item
            ? deps.getCurrentRuntimeModeForItem(item)
            : null,
          sourceBody: deps.body,
        });
      }
    } catch (err) {
      deps.logError("LLM: Failed to toggle standalone window", err);
    }
  });

  deps.settingsBtn?.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      deps.closeRetryModelMenu();
      deps.closeSlashMenu();
      deps.closeResponseMenu();
      deps.closePromptMenu();
      deps.closeHistoryNewMenu();
      deps.closeHistoryMenu();
      deps.closeExportMenu();
      const paneId =
        deps.settingsBtn?.dataset.preferencesPaneId || deps.preferencesPaneId;
      Zotero.Utilities.Internal.openPreferences(paneId);
    } catch (error) {
      deps.logError("LLM: Failed to open plugin preferences", error);
      setStatusMessage(t("Could not open plugin settings"), "error");
    }
  });
}
