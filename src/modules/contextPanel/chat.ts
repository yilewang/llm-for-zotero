import { renderMarkdown, renderMarkdownForNote } from "../../utils/markdown";
import {
  appendMessage as appendStoredMessage,
  clearConversation as clearStoredConversation,
  loadConversation,
  pruneConversation,
  StoredChatMessage,
} from "../../utils/chatStore";
import {
  callLLMStream,
  ChatMessage,
  getRuntimeReasoningOptions,
  ReasoningConfig as LLMReasoningConfig,
  ReasoningEvent,
  ReasoningLevel as LLMReasoningLevel,
} from "../../utils/llmClient";
import {
  PERSISTED_HISTORY_LIMIT,
  MAX_HISTORY_MESSAGES,
  AUTO_SCROLL_BOTTOM_THRESHOLD,
  MODEL_PROFILE_ORDER,
  type ModelProfileKey,
} from "./constants";
import type {
  Message,
  ReasoningProviderKind,
  ReasoningOption,
  ReasoningLevelSelection,
  AdvancedModelParams,
  ApiProfile,
} from "./types";
import {
  chatHistory,
  loadedConversationKeys,
  loadingConversationTasks,
  selectedModelCache,
  selectedReasoningCache,
  cancelledRequestId,
  currentAbortController,
  setCurrentAbortController,
  nextRequestId,
  setResponseMenuTarget,
  selectedImageCache,
  selectedTextCache,
  pdfTextCache,
} from "./state";
import {
  sanitizeText,
  formatTime,
  setStatus,
  getSelectedTextWithinBubble,
  buildQuestionWithSelectedText,
} from "./textUtils";
import { positionMenuAtPointer } from "./menuPositioning";
import {
  getSelectedProfileForItem,
  getAdvancedModelParamsForProfile,
  getApiProfiles,
  getStringPref,
} from "./prefHelpers";
import { buildContext, ensurePDFTextCached } from "./pdfContext";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
} from "./contextResolution";
import { buildChatHistoryNotePayload } from "./notes";

/** Get AbortController constructor from global scope */
export function getAbortController(): new () => AbortController {
  return (
    (ztoolkit.getGlobal("AbortController") as new () => AbortController) ||
    (
      globalThis as typeof globalThis & {
        AbortController: new () => AbortController;
      }
    ).AbortController
  );
}

export function appendReasoningPart(
  base: string | undefined,
  next?: string,
): string {
  const chunk = sanitizeText(next || "");
  if (!chunk) return base || "";
  return `${base || ""}${chunk}`;
}

export function getConversationKey(item: Zotero.Item): number {
  if (item.isAttachment() && item.parentID) {
    return item.parentID;
  }
  return item.id;
}

export async function persistConversationMessage(
  conversationKey: number,
  message: StoredChatMessage,
): Promise<void> {
  try {
    await appendStoredMessage(conversationKey, message);
    await pruneConversation(conversationKey, PERSISTED_HISTORY_LIMIT);
  } catch (err) {
    ztoolkit.log("LLM: Failed to persist chat message", err);
  }
}

export function toPanelMessage(message: StoredChatMessage): Message {
  return {
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    modelName: message.modelName,
    reasoningSummary: message.reasoningSummary,
    reasoningDetails: message.reasoningDetails,
    reasoningOpen: false,
  };
}

export async function ensureConversationLoaded(
  item: Zotero.Item,
): Promise<void> {
  const conversationKey = getConversationKey(item);

  if (loadedConversationKeys.has(conversationKey)) return;
  if (chatHistory.has(conversationKey)) {
    loadedConversationKeys.add(conversationKey);
    return;
  }

  const existingTask = loadingConversationTasks.get(conversationKey);
  if (existingTask) {
    await existingTask;
    return;
  }

  const task = (async () => {
    try {
      const storedMessages = await loadConversation(
        conversationKey,
        PERSISTED_HISTORY_LIMIT,
      );
      chatHistory.set(
        conversationKey,
        storedMessages.map((message) => toPanelMessage(message)),
      );
    } catch (err) {
      ztoolkit.log("LLM: Failed to load chat history", err);
      if (!chatHistory.has(conversationKey)) {
        chatHistory.set(conversationKey, []);
      }
    } finally {
      loadedConversationKeys.add(conversationKey);
      loadingConversationTasks.delete(conversationKey);
    }
  })();

  loadingConversationTasks.set(conversationKey, task);
  await task;
}

export function detectReasoningProvider(
  modelName: string,
): ReasoningProviderKind {
  const name = modelName.trim().toLowerCase();
  if (!name) return "unsupported";
  if (name.startsWith("deepseek")) {
    return "deepseek";
  }
  if (name.startsWith("kimi")) {
    return "kimi";
  }
  if (/(^|[/:])(?:qwen(?:\d+)?|qwq|qvq)(?:\b|[.-])/.test(name)) {
    return "qwen";
  }
  if (/(^|[/:])grok(?:\b|[.-])/.test(name)) {
    return "grok";
  }
  if (/(^|[/:])claude(?:\b|[.-])/.test(name)) {
    return "anthropic";
  }
  if (name.includes("gemini")) return "gemini";
  if (/^(gpt-5|o\d)(\b|[.-])/.test(name)) return "openai";
  return "unsupported";
}

export function getReasoningOptions(
  provider: ReasoningProviderKind,
  modelName: string,
  apiBase?: string,
): ReasoningOption[] {
  if (provider === "unsupported") return [];
  return getRuntimeReasoningOptions(provider, modelName).map((option) => ({
    level: option.level as LLMReasoningLevel,
    enabled: option.enabled,
    label: option.label,
  }));
}

export async function copyTextToClipboard(
  body: Element,
  text: string,
): Promise<void> {
  const safeText = sanitizeText(text).trim();
  if (!safeText) return;

  const win = body.ownerDocument?.defaultView as
    | (Window & { navigator?: Navigator })
    | undefined;
  if (win?.navigator?.clipboard?.writeText) {
    try {
      await win.navigator.clipboard.writeText(safeText);
      return;
    } catch (err) {
      ztoolkit.log("Clipboard API copy failed:", err);
    }
  }

  try {
    const helper = (
      globalThis as typeof globalThis & {
        Components?: {
          classes: Record<string, { getService: (iface: unknown) => unknown }>;
          interfaces: Record<string, unknown>;
        };
      }
    ).Components;
    const svc = helper?.classes?.[
      "@mozilla.org/widget/clipboardhelper;1"
    ]?.getService(helper.interfaces.nsIClipboardHelper) as
      | { copyString: (value: string) => void }
      | undefined;
    if (svc) svc.copyString(safeText);
  } catch (err) {
    ztoolkit.log("Clipboard fallback copy failed:", err);
  }
}

/**
 * Render markdown text through renderMarkdownForNote and copy the result
 * to the clipboard as both text/html and text/plain.  When pasted into a
 * Zotero note, the HTML version is used — producing the same rendering as
 * "Save as note".  When pasted into a plain-text editor, the raw markdown
 * is used — matching "Copy chat as md".
 */
export async function copyRenderedMarkdownToClipboard(
  body: Element,
  markdownText: string,
): Promise<void> {
  const safeText = sanitizeText(markdownText).trim();
  if (!safeText) return;

  let renderedHtml = "";
  try {
    renderedHtml = renderMarkdownForNote(safeText);
  } catch (err) {
    ztoolkit.log("LLM: Copy markdown render error:", err);
  }

  // Try rich clipboard (HTML + plain) first so that paste into Zotero
  // notes gives properly rendered content with math.
  if (renderedHtml) {
    const win = body.ownerDocument?.defaultView as
      | (Window & {
          navigator?: Navigator;
          ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem;
        })
      | undefined;
    if (win?.navigator?.clipboard?.write && win.ClipboardItem) {
      try {
        const item = new win.ClipboardItem({
          "text/html": new Blob([renderedHtml], { type: "text/html" }),
          "text/plain": new Blob([safeText], { type: "text/plain" }),
        });
        await win.navigator.clipboard.write([item]);
        return;
      } catch (err) {
        ztoolkit.log("LLM: Rich clipboard write failed, falling back:", err);
      }
    }
  }

  // Fallback: copy raw markdown as plain text.
  await copyTextToClipboard(body, safeText);
}

export function getSelectedReasoningForItem(
  itemId: number,
  modelName: string,
  apiBase?: string,
): LLMReasoningConfig | undefined {
  const provider = detectReasoningProvider(modelName);
  if (provider === "unsupported") return undefined;
  const enabledLevels = getReasoningOptions(provider, modelName, apiBase)
    .filter((option) => option.enabled)
    .map((option) => option.level);
  if (!enabledLevels.length) return undefined;

  let selectedLevel = selectedReasoningCache.get(itemId) || "none";
  if (
    selectedLevel === "none" ||
    !enabledLevels.includes(selectedLevel as LLMReasoningLevel)
  ) {
    selectedLevel = enabledLevels[0];
    selectedReasoningCache.set(itemId, selectedLevel);
  }

  return { provider, level: selectedLevel as LLMReasoningLevel };
}

export async function sendQuestion(
  body: Element,
  item: Zotero.Item,
  question: string,
  images?: string[],
  model?: string,
  apiBase?: string,
  apiKey?: string,
  reasoning?: LLMReasoningConfig,
  advanced?: AdvancedModelParams,
  displayQuestion?: string,
) {
  const inputBox = body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  const sendBtn = body.querySelector("#llm-send") as HTMLButtonElement | null;
  const cancelBtn = body.querySelector(
    "#llm-cancel",
  ) as HTMLButtonElement | null;
  const status = body.querySelector("#llm-status") as HTMLElement | null;

  // Track this request
  const thisRequestId = nextRequestId();

  // Show cancel, hide send
  if (sendBtn) sendBtn.style.display = "none";
  if (cancelBtn) cancelBtn.style.display = "";
  if (inputBox) inputBox.disabled = true;
  if (status) setStatus(status, "Preparing request...", "sending");

  await ensureConversationLoaded(item);
  const conversationKey = getConversationKey(item);

  // Add user message (include indicator if image was attached)
  if (!chatHistory.has(conversationKey)) {
    chatHistory.set(conversationKey, []);
  }
  const history = chatHistory.get(conversationKey)!;
  const historyForLLM = history.slice(-MAX_HISTORY_MESSAGES);
  const fallbackProfile = getSelectedProfileForItem(item.id);
  const effectiveModel = (
    model ||
    fallbackProfile.model ||
    getStringPref("modelPrimary") ||
    getStringPref("model") ||
    "gpt-4o-mini"
  ).trim();
  const effectiveApiBase = (apiBase || fallbackProfile.apiBase).trim();
  const effectiveApiKey = (apiKey || fallbackProfile.apiKey).trim();
  const effectiveReasoning =
    reasoning ||
    getSelectedReasoningForItem(item.id, effectiveModel, effectiveApiBase);
  const effectiveAdvanced =
    advanced || getAdvancedModelParamsForProfile(fallbackProfile.key);
  const shownQuestion = displayQuestion || question;
  const imageCount = Array.isArray(images) ? images.filter(Boolean).length : 0;
  const userMessageText = imageCount
    ? `${shownQuestion}\n[📷 ${imageCount} image${imageCount > 1 ? "s" : ""} attached]`
    : shownQuestion;
  const userMessage: Message = {
    role: "user",
    text: userMessageText,
    timestamp: Date.now(),
  };
  history.push(userMessage);
  await persistConversationMessage(conversationKey, {
    role: "user",
    text: userMessage.text,
    timestamp: userMessage.timestamp,
  });

  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    modelName: effectiveModel,
    streaming: true,
  };
  history.push(assistantMessage);
  if (history.length > PERSISTED_HISTORY_LIMIT) {
    history.splice(0, history.length - PERSISTED_HISTORY_LIMIT);
  }
  refreshChat(body, item);

  let assistantPersisted = false;
  const persistAssistantOnce = async () => {
    if (assistantPersisted) return;
    assistantPersisted = true;
    await persistConversationMessage(conversationKey, {
      role: "assistant",
      text: assistantMessage.text,
      timestamp: assistantMessage.timestamp,
      modelName: assistantMessage.modelName,
      reasoningSummary: assistantMessage.reasoningSummary,
      reasoningDetails: assistantMessage.reasoningDetails,
    });
  };
  const markCancelled = async () => {
    assistantMessage.text = "[Cancelled]";
    assistantMessage.streaming = false;
    assistantMessage.reasoningSummary = undefined;
    assistantMessage.reasoningDetails = undefined;
    assistantMessage.reasoningOpen = false;
    refreshChat(body, item);
    await persistAssistantOnce();
    if (status) setStatus(status, "Cancelled", "ready");
  };

  try {
    const contextSource = resolveContextSourceItem(item);
    if (status) setStatus(status, contextSource.statusText, "sending");

    let pdfContext = "";
    if (contextSource.contextItem) {
      await ensurePDFTextCached(contextSource.contextItem);
      pdfContext = await buildContext(
        pdfTextCache.get(contextSource.contextItem.id),
        question,
        imageCount > 0,
        { apiBase: effectiveApiBase, apiKey: effectiveApiKey },
      );
    }

    const llmHistory: ChatMessage[] = historyForLLM.map((msg) => ({
      role: msg.role,
      content: msg.text,
    }));

    const AbortControllerCtor = getAbortController();
    setCurrentAbortController(
      AbortControllerCtor ? new AbortControllerCtor() : null,
    );
    let refreshQueued = false;
    const queueRefresh = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      setTimeout(() => {
        refreshQueued = false;
        refreshChat(body, item);
      }, 50);
    };

    const answer = await callLLMStream(
      {
        prompt: question,
        context: pdfContext,
        history: llmHistory,
        signal: currentAbortController?.signal,
        images: images,
        model: effectiveModel,
        apiBase: effectiveApiBase,
        apiKey: effectiveApiKey,
        reasoning: effectiveReasoning,
        temperature: effectiveAdvanced?.temperature,
        maxTokens: effectiveAdvanced?.maxTokens,
      },
      (delta) => {
        assistantMessage.text += sanitizeText(delta);
        queueRefresh();
      },
      (reasoning: ReasoningEvent) => {
        if (typeof assistantMessage.reasoningOpen !== "boolean") {
          assistantMessage.reasoningOpen = true;
        }
        if (reasoning.summary) {
          assistantMessage.reasoningSummary = appendReasoningPart(
            assistantMessage.reasoningSummary,
            reasoning.summary,
          );
        }
        if (reasoning.details) {
          assistantMessage.reasoningDetails = appendReasoningPart(
            assistantMessage.reasoningDetails,
            reasoning.details,
          );
        }
        queueRefresh();
      },
    );

    if (
      cancelledRequestId >= thisRequestId ||
      Boolean(currentAbortController?.signal.aborted)
    ) {
      await markCancelled();
      return;
    }

    assistantMessage.text =
      sanitizeText(answer) || assistantMessage.text || "No response.";
    assistantMessage.streaming = false;
    refreshChat(body, item);
    await persistAssistantOnce();

    if (status) setStatus(status, "Ready", "ready");
  } catch (err) {
    const isCancelled =
      cancelledRequestId >= thisRequestId ||
      Boolean(currentAbortController?.signal.aborted) ||
      (err as { name?: string }).name === "AbortError";
    if (isCancelled) {
      await markCancelled();
      return;
    }

    const errMsg = (err as Error).message || "Error";
    assistantMessage.text = `Error: ${errMsg}`;
    assistantMessage.streaming = false;
    refreshChat(body, item);
    await persistAssistantOnce();

    if (status) {
      setStatus(status, `Error: ${errMsg.slice(0, 40)}`, "error");
    }
  } finally {
    // Only restore UI if this is still the current request
    if (cancelledRequestId < thisRequestId) {
      if (inputBox) {
        inputBox.disabled = false;
        inputBox.focus();
      }
      if (sendBtn) {
        sendBtn.style.display = "";
        sendBtn.disabled = false;
      }
      if (cancelBtn) cancelBtn.style.display = "none";
    }
    setCurrentAbortController(null);
  }
}

export function refreshChat(body: Element, item?: Zotero.Item | null) {
  const chatBox = body.querySelector("#llm-chat-box") as HTMLDivElement | null;
  if (!chatBox) return;
  const doc = body.ownerDocument!;
  const prevScrollTop = chatBox.scrollTop;
  const distanceFromBottom =
    chatBox.scrollHeight - chatBox.clientHeight - chatBox.scrollTop;
  const shouldStickToBottom =
    distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD;

  if (!item) {
    chatBox.innerHTML = `
      <div class="llm-welcome">
        <div class="llm-welcome-icon">📄</div>
        <div class="llm-welcome-text">Select an item or open a PDF to start.</div>
      </div>
    `;
    return;
  }

  const conversationKey = getConversationKey(item);
  const history = chatHistory.get(conversationKey) || [];

  if (history.length === 0) {
    chatBox.innerHTML = `
      <div class="llm-welcome">
        <div class="llm-welcome-icon">💬</div>
        <div class="llm-welcome-text">Start a conversation by asking a question or using one of the quick actions below.</div>
      </div>
    `;
    return;
  }

  chatBox.innerHTML = "";

  for (const msg of history) {
    const isUser = msg.role === "user";
    const wrapper = doc.createElement("div") as HTMLDivElement;
    wrapper.className = `llm-message-wrapper ${isUser ? "user" : "assistant"}`;

    const bubble = doc.createElement("div") as HTMLDivElement;
    bubble.className = `llm-bubble ${isUser ? "user" : "assistant"}`;

    if (isUser) {
      bubble.textContent = sanitizeText(msg.text || "");
    } else {
      const hasModelName = Boolean(msg.modelName?.trim());
      const hasAnswerText = Boolean(msg.text);
      if (hasAnswerText) {
        const safeText = sanitizeText(msg.text);
        if (msg.streaming) bubble.classList.add("streaming");
        try {
          bubble.innerHTML = renderMarkdown(safeText);
        } catch (err) {
          ztoolkit.log("LLM render error:", err);
          bubble.textContent = safeText;
        }
        bubble.addEventListener("contextmenu", (e: Event) => {
          const me = e as MouseEvent;
          me.preventDefault();
          me.stopPropagation();
          if (typeof me.stopImmediatePropagation === "function") {
            me.stopImmediatePropagation();
          }
          const responseMenu = doc.querySelector(
            "#llm-response-menu",
          ) as HTMLDivElement | null;
          const exportMenu = doc.querySelector(
            "#llm-export-menu",
          ) as HTMLDivElement | null;
          if (!responseMenu || !item) return;
          if (exportMenu) exportMenu.style.display = "none";
          // If the user has text selected within this bubble, extract
          // just that portion (with KaTeX math properly handled).
          // Otherwise fall back to the full raw markdown source.
          const selectedText = getSelectedTextWithinBubble(doc, bubble);
          const fullMarkdown = sanitizeText(msg.text || "").trim();
          const contentText = selectedText || fullMarkdown;
          if (!contentText) return;
          setResponseMenuTarget({
            item,
            contentText,
            modelName: msg.modelName?.trim() || "unknown",
          });
          positionMenuAtPointer(body, responseMenu, me.clientX, me.clientY);
        });
      }

      const hasReasoningSummary = Boolean(msg.reasoningSummary?.trim());
      const hasReasoningDetails = Boolean(msg.reasoningDetails?.trim());
      if (hasReasoningSummary || hasReasoningDetails) {
        const details = doc.createElement("details") as HTMLDetailsElement;
        details.className = "llm-reasoning";
        details.open =
          typeof msg.reasoningOpen === "boolean"
            ? msg.reasoningOpen
            : Boolean(msg.streaming);

        const summary = doc.createElement("summary") as HTMLElement;
        summary.className = "llm-reasoning-summary";
        summary.textContent = "Thinking";
        const toggleReasoning = (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          const next = !msg.reasoningOpen;
          msg.reasoningOpen = next;
          details.open = next;
        };
        summary.addEventListener("mousedown", toggleReasoning);
        summary.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
        });
        summary.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            toggleReasoning(e);
          }
        });
        details.appendChild(summary);

        const bodyWrap = doc.createElement("div") as HTMLDivElement;
        bodyWrap.className = "llm-reasoning-body";

        if (hasReasoningSummary) {
          const summaryBlock = doc.createElement("div") as HTMLDivElement;
          summaryBlock.className = "llm-reasoning-block";
          const label = doc.createElement("div") as HTMLDivElement;
          label.className = "llm-reasoning-label";
          label.textContent = "Summary";
          const text = doc.createElement("div") as HTMLDivElement;
          text.className = "llm-reasoning-text";
          try {
            text.innerHTML = renderMarkdown(msg.reasoningSummary || "");
          } catch (err) {
            ztoolkit.log("LLM reasoning render error:", err);
            text.textContent = msg.reasoningSummary || "";
          }
          summaryBlock.append(label, text);
          bodyWrap.appendChild(summaryBlock);
        }

        if (hasReasoningDetails) {
          const detailsBlock = doc.createElement("div") as HTMLDivElement;
          detailsBlock.className = "llm-reasoning-block";
          const label = doc.createElement("div") as HTMLDivElement;
          label.className = "llm-reasoning-label";
          label.textContent = "Details";
          const text = doc.createElement("div") as HTMLDivElement;
          text.className = "llm-reasoning-text";
          try {
            text.innerHTML = renderMarkdown(msg.reasoningDetails || "");
          } catch (err) {
            ztoolkit.log("LLM reasoning render error:", err);
            text.textContent = msg.reasoningDetails || "";
          }
          detailsBlock.append(label, text);
          bodyWrap.appendChild(detailsBlock);
        }

        details.appendChild(bodyWrap);
        bubble.insertBefore(details, bubble.firstChild);
      }

      if (!hasAnswerText) {
        const typing = doc.createElement("div") as HTMLDivElement;
        typing.className = "llm-typing";
        typing.innerHTML =
          '<span class="llm-typing-dot"></span><span class="llm-typing-dot"></span><span class="llm-typing-dot"></span>';
        bubble.appendChild(typing);
      }

      if (hasModelName) {
        const modelName = doc.createElement("div") as HTMLDivElement;
        modelName.className = "llm-model-name";
        modelName.textContent = msg.modelName?.trim() || "";
        bubble.insertBefore(modelName, bubble.firstChild);
      }
    }

    const meta = doc.createElement("div") as HTMLDivElement;
    meta.className = "llm-message-meta";

    const time = doc.createElement("span") as HTMLSpanElement;
    time.className = "llm-message-time";
    time.textContent = formatTime(msg.timestamp);
    meta.appendChild(time);

    wrapper.appendChild(bubble);
    wrapper.appendChild(meta);
    chatBox.appendChild(wrapper);
  }

  if (shouldStickToBottom) {
    chatBox.scrollTop = chatBox.scrollHeight;
  } else {
    chatBox.scrollTop = prevScrollTop;
  }
}
