import { t } from "../../../../utils/i18n";
import {
  copyGeneratedImageToClipboard,
  buildPlainMarkdownClipboardText,
  copyTextToClipboard,
  resolveAssistantResponseMenuContent,
} from "../../chat";
import { getMessageCitationPaperContexts } from "../../citationContexts";
import {
  buildChatHistoryNotePayload,
  createAssistantResponseNote,
  createNoteFromChatHistory,
  createStandaloneNoteFromChatHistory,
} from "../../notes";
import { isGlobalPortalItem } from "../../portalScope";
import { isClaudeGlobalPortalItem } from "../../../../claudeCode/portal";
import { positionMenuBelowButton } from "../../menuPositioning";
import { renderMermaidSourceToSvg } from "../../renderedMarkdown";
import { setStatus } from "../../textUtils";
import type {
  ConversationSystem,
  GeneratedChatImage,
  QuoteCitation,
} from "../../../../shared/types";
import type { ChatRuntimeMode, Message, PaperContextRef } from "../../types";

export type ResponseMenuTarget = {
  item: Zotero.Item;
  contentText: string;
  queryText?: string;
  modelName: string;
  conversationKey?: number;
  userTimestamp?: number;
  assistantTimestamp?: number;
  paperContexts?: PaperContextRef[];
  quoteCitations?: QuoteCitation[];
  generatedImages?: GeneratedChatImage[];
} | null;

type ResponseActionKind = "copy" | "note" | "delete";

type ResponseTurnReference = {
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
};

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

function parsePositiveFiniteNumber(value: unknown): number {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeResponseTurnReference(
  input: Partial<ResponseTurnReference> | null | undefined,
): ResponseTurnReference | null {
  const conversationKey = parsePositiveFiniteNumber(input?.conversationKey);
  const userTimestamp = parsePositiveFiniteNumber(input?.userTimestamp);
  const assistantTimestamp = parsePositiveFiniteNumber(
    input?.assistantTimestamp,
  );
  if (!conversationKey || !userTimestamp || !assistantTimestamp) return null;
  return { conversationKey, userTimestamp, assistantTimestamp };
}

function findResponseTurnPair(
  history: Message[],
  reference: ResponseTurnReference,
): { userMessage: Message; assistantMessage: Message } | null {
  for (let index = 0; index < history.length - 1; index += 1) {
    const userMessage = history[index];
    const assistantMessage = history[index + 1];
    if (
      userMessage?.role !== "user" ||
      assistantMessage?.role !== "assistant"
    ) {
      continue;
    }
    if (
      Math.floor(userMessage.timestamp) === reference.userTimestamp &&
      Math.floor(assistantMessage.timestamp) === reference.assistantTimestamp
    ) {
      return { userMessage, assistantMessage };
    }
  }
  return null;
}

export function buildResponseActionTargetFromHistory(params: {
  item: Zotero.Item;
  history: Message[];
  conversationKey: number;
  userTimestamp: number;
  assistantTimestamp: number;
}): ResponseMenuTarget {
  const reference = normalizeResponseTurnReference(params);
  if (!reference) return null;
  const pair = findResponseTurnPair(params.history, reference);
  if (!pair) return null;
  const menuContent = resolveAssistantResponseMenuContent(
    pair.assistantMessage,
  );
  if (!menuContent) return null;
  return {
    item: params.item,
    contentText: menuContent.contentText,
    queryText: pair.userMessage.text || "",
    modelName: pair.assistantMessage.modelName?.trim() || "unknown",
    conversationKey: reference.conversationKey,
    userTimestamp: reference.userTimestamp,
    assistantTimestamp: reference.assistantTimestamp,
    paperContexts: getMessageCitationPaperContexts(pair.userMessage),
    quoteCitations: pair.assistantMessage.quoteCitations,
    generatedImages: menuContent.generatedImages,
  };
}

async function copyResponseTarget(
  deps: MenuActionControllerDeps,
  target: ResponseMenuTarget,
  setStatusMessage: (
    message: string,
    level: "ready" | "warning" | "error",
  ) => void,
): Promise<void> {
  if (!target) return;
  const markdownText = buildPlainMarkdownClipboardText(
    target.contentText,
    target.quoteCitations,
  );
  if (markdownText) {
    await copyTextToClipboard(deps.body, markdownText);
    setStatusMessage(t("Copied response"), "ready");
  } else if (target.generatedImages?.length) {
    const result = await copyGeneratedImageToClipboard(
      deps.body,
      target.generatedImages[0]!,
    );
    setStatusMessage(
      result === "image" ? "Copied image" : "Copied image source",
      "ready",
    );
  }
}

function buildNoteFigureRenderOptions(deps: MenuActionControllerDeps) {
  const doc = deps.body.ownerDocument || null;
  const body = deps.body as HTMLElement | null;
  return doc
    ? {
        doc,
        omitUnconvertedVisualFences: true,
        renderMermaidSvg: async (
          source: string,
          renderDoc: Document,
          anchor?: HTMLElement,
        ) =>
          findRenderedMermaidSvgForSource(deps.body, source) ||
          renderMermaidSourceToSvg(
            source,
            renderDoc,
            anchor || body || undefined,
          ),
      }
    : undefined;
}

function findRenderedMermaidSvgForSource(
  root: ParentNode,
  source: string,
): string | null {
  const normalizedSource = source.trim();
  if (!normalizedSource || typeof root.querySelectorAll !== "function") {
    return null;
  }
  const previews = Array.from(
    root.querySelectorAll(".llm-mermaid-preview[data-llm-mermaid-source]"),
  ) as HTMLElement[];
  for (const preview of previews) {
    if ((preview.dataset.llmMermaidSource || "").trim() !== normalizedSource) {
      continue;
    }
    const renderedSvg = (preview.dataset.llmRenderedSvg || "").trim();
    if (renderedSvg) return renderedSvg;
  }
  return null;
}

async function saveResponseTargetAsNote(
  deps: MenuActionControllerDeps,
  target: ResponseMenuTarget,
  setStatusMessage: (
    message: string,
    level: "ready" | "warning" | "error",
  ) => void,
): Promise<void> {
  if (!target) {
    deps.logError("LLM: Note save - no responseMenuTarget", null);
    return;
  }
  const {
    item: targetItem,
    contentText,
    queryText,
    modelName,
    paperContexts,
    quoteCitations,
    generatedImages,
  } = target;
  if (!targetItem || (!contentText && !generatedImages?.length)) {
    deps.logError("LLM: Note save - missing item or response content", null);
    return;
  }
  try {
    const figureRender = buildNoteFigureRenderOptions(deps);
    const targetNoteSession = deps.resolveActiveNoteSession(targetItem);
    if (
      deps.isGlobalMode() ||
      isGlobalPortalItem(targetItem) ||
      isClaudeGlobalPortalItem(targetItem) ||
      targetNoteSession?.noteKind === "standalone"
    ) {
      const libraryID =
        Number.isFinite(targetItem.libraryID) && targetItem.libraryID > 0
          ? Math.floor(targetItem.libraryID)
          : deps.getCurrentLibraryID();
      await createAssistantResponseNote({
        destination: { kind: "standalone", libraryID },
        contentText,
        queryText,
        modelName,
        paperContexts,
        quoteCitations,
        generatedImages,
        figureRender,
      });
      setStatusMessage(t("Created a new note"), "ready");
      return;
    }
    await createAssistantResponseNote({
      destination: { kind: "item", item: targetItem },
      contentText,
      queryText,
      modelName,
      paperContexts,
      quoteCitations,
      generatedImages,
      figureRender,
    });
    setStatusMessage(t("Created a new note"), "ready");
  } catch (err) {
    deps.logError("Create note failed:", err);
    setStatusMessage(t("Failed to create note"), "error");
  }
}

async function queueResponseTurnDeletion(
  deps: MenuActionControllerDeps,
  reference: Partial<ResponseTurnReference> | null | undefined,
  setStatusMessage: (
    message: string,
    level: "ready" | "warning" | "error",
  ) => void,
): Promise<void> {
  const normalized = normalizeResponseTurnReference(reference);
  const item = deps.getItem();
  if (!normalized || !item) return;
  if (deps.getConversationKey(item) !== normalized.conversationKey) {
    setStatusMessage(t("Delete target changed"), "error");
    return;
  }
  const pair = findResponseTurnPair(
    deps.getHistory(normalized.conversationKey),
    normalized,
  );
  if (!pair) {
    setStatusMessage(t("No deletable turn found"), "error");
    return;
  }
  if (pair.assistantMessage.streaming) {
    setStatusMessage(t("Cannot delete while generating"), "ready");
    return;
  }
  await deps.queueTurnDeletion(normalized);
}

export async function runResponseMenuAction(
  deps: MenuActionControllerDeps,
  action: ResponseActionKind,
  target: ResponseMenuTarget,
  setStatusMessage: (
    message: string,
    level: "ready" | "warning" | "error",
  ) => void,
): Promise<void> {
  try {
    if (action === "copy") {
      await copyResponseTarget(deps, target, setStatusMessage);
      return;
    }
    if (action === "note") {
      await saveResponseTargetAsNote(deps, target, setStatusMessage);
      return;
    }
    await queueResponseTurnDeletion(deps, target, setStatusMessage);
  } catch (err) {
    deps.logError("Response action failed:", err);
    setStatusMessage(t("Response action failed"), "error");
  }
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
      await runResponseMenuAction(deps, "copy", target, setStatusMessage);
    });
    deps.responseMenuNoteBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const target = deps.getResponseMenuTarget();
      deps.closeResponseMenu();
      await runResponseMenuAction(deps, "note", target, setStatusMessage);
    });
    deps.responseMenuDeleteBtn?.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const target = deps.getResponseMenuTarget();
      deps.closeResponseMenu();
      await runResponseMenuAction(deps, "delete", target, setStatusMessage);
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
          await createStandaloneNoteFromChatHistory(currentLibraryID, history, {
            figureRender: buildNoteFigureRenderOptions(deps),
          });
        } else {
          await createNoteFromChatHistory(currentItem, history, {
            figureRender: buildNoteFigureRenderOptions(deps),
          });
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
