import { getLocaleID } from "../utils/locale";
import { renderMarkdown } from "../utils/markdown";
import {
  appendMessage as appendStoredMessage,
  clearConversation as clearStoredConversation,
  loadConversation,
  pruneConversation,
  StoredChatMessage,
} from "../utils/chatStore";
import {
  callEmbeddings,
  callLLMStream,
  ChatMessage,
  getRuntimeReasoningOptions,
  ReasoningConfig as LLMReasoningConfig,
  ReasoningEvent,
  ReasoningLevel as LLMReasoningLevel,
} from "../utils/llmClient";
import { config } from "../../package.json";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  MAX_ALLOWED_TOKENS,
} from "../utils/llmDefaults";

// =============================================================================
// Constants
// =============================================================================

const PANE_ID = "llm-context-panel";
const MAX_CONTEXT_LENGTH = 8000;
const MAX_CONTEXT_LENGTH_WITH_IMAGE = 3000;
const FORCE_FULL_CONTEXT = true;
const FULL_CONTEXT_CHAR_LIMIT = 500000;
const CHUNK_TARGET_LENGTH = 2000;
const CHUNK_OVERLAP = 200;
const MAX_CONTEXT_CHUNKS = 4;
const EMBEDDING_BATCH_SIZE = 16;
const HYBRID_WEIGHT_BM25 = 0.5;
const HYBRID_WEIGHT_EMBEDDING = 0.5;
const MAX_HISTORY_MESSAGES = 12;
const PERSISTED_HISTORY_LIMIT = 200;
const HTML_NS = "http://www.w3.org/1999/xhtml";
const AUTO_SCROLL_BOTTOM_THRESHOLD = 64;
const FONT_SCALE_DEFAULT_PERCENT = 120;
const FONT_SCALE_MIN_PERCENT = 80;
const FONT_SCALE_MAX_PERCENT = 180;
const FONT_SCALE_STEP_PERCENT = 10;
const SELECTED_TEXT_MAX_LENGTH = 4000;
const SELECTED_TEXT_PREVIEW_LENGTH = 240;
const MAX_EDITABLE_SHORTCUTS = 5;
const MAX_SELECTED_IMAGES = 5;
const SELECT_TEXT_EXPANDED_LABEL = "Add Text";
const SELECT_TEXT_COMPACT_LABEL = "✍🏻";
const SCREENSHOT_EXPANDED_LABEL = "Screenshots";
const SCREENSHOT_COMPACT_LABEL = "📷";
const REASONING_COMPACT_LABEL = "💭";
const ACTION_LAYOUT_FULL_MODE_BUFFER_PX = 0;
const ACTION_LAYOUT_PARTIAL_MODE_BUFFER_PX = 0;
const ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX = 36;
const ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX = 56;
const ACTION_LAYOUT_MODEL_WRAP_MIN_CHARS = 12;
const ACTION_LAYOUT_MODEL_FULL_MAX_LINES = 2;
const CUSTOM_SHORTCUT_ID_PREFIX = "custom-shortcut";

const BUILTIN_SHORTCUT_FILES = [
  { id: "summarize", label: "Summarize", file: "summarize.txt" },
  { id: "key-points", label: "Key Points", file: "key-points.txt" },
  { id: "methodology", label: "Methodology", file: "methodology.txt" },
  { id: "limitations", label: "Limitations", file: "limitations.txt" },
] as const;

// =============================================================================
// Types
// =============================================================================

interface Message {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  modelName?: string;
  streaming?: boolean;
  reasoningSummary?: string;
  reasoningDetails?: string;
  reasoningOpen?: boolean;
}

type ReasoningProviderKind =
  | "openai"
  | "gemini"
  | "deepseek"
  | "kimi"
  | "unsupported";
type ReasoningLevelSelection = "none" | LLMReasoningLevel;
type ReasoningOption = {
  level: LLMReasoningLevel;
  enabled: boolean;
  label?: string;
};
type ActionDropdownSpec = {
  slotId: string;
  slotClassName: string;
  buttonId: string;
  buttonClassName: string;
  buttonText: string;
  menuId: string;
  menuClassName: string;
  disabled?: boolean;
};
type ModelProfileKey = "primary" | "secondary";
type AdvancedModelParams = {
  temperature: number;
  maxTokens: number;
};
type CustomShortcut = {
  id: string;
  label: string;
  prompt: string;
};
type ResolvedContextSource = {
  contextItem: Zotero.Item | null;
  statusText: string;
};

// =============================================================================
// State
// =============================================================================

const chatHistory = new Map<number, Message[]>();
const loadedConversationKeys = new Set<number>();
const loadingConversationTasks = new Map<number, Promise<void>>();
const selectedModelCache = new Map<number, "primary" | "secondary">();
const selectedReasoningCache = new Map<number, ReasoningLevelSelection>();
type PdfContext = {
  title: string;
  chunks: string[];
  chunkStats: ChunkStat[];
  docFreq: Record<string, number>;
  avgChunkLength: number;
  fullLength: number;
  embeddings?: number[][];
  embeddingPromise?: Promise<number[][] | null>;
  embeddingFailed?: boolean;
};

const pdfTextCache = new Map<number, PdfContext>();
const pdfTextLoadingTasks = new Map<number, Promise<void>>();
const shortcutTextCache = new Map<string, string>();
const shortcutMoveModeState = new WeakMap<Element, boolean>();
const shortcutRenderItemState = new WeakMap<
  Element,
  Zotero.Item | null | undefined
>();
const shortcutEscapeListenerAttached = new WeakSet<Document>();
let readerContextPanelRegistered = false;

let currentRequestId = 0;
let cancelledRequestId = -1;
let currentAbortController: AbortController | null = null;
let panelFontScalePercent = FONT_SCALE_DEFAULT_PERCENT;
let responseMenuTarget: {
  item: Zotero.Item;
  noteText: string;
  noteHtml: string;
  modelName: string;
} | null = null;

// Screenshot selection state (per item)
const selectedImageCache = new Map<number, string[]>();
const selectedTextCache = new Map<number, string>();
const recentReaderSelectionCache = new Map<number, string>();

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "but",
  "not",
  "you",
  "your",
  "our",
  "their",
  "its",
  "they",
  "them",
  "can",
  "could",
  "may",
  "might",
  "will",
  "would",
  "also",
  "than",
  "then",
  "into",
  "about",
  "what",
  "which",
  "when",
  "where",
  "how",
  "why",
  "who",
  "whom",
  "been",
  "being",
  "such",
  "over",
  "under",
  "between",
  "within",
  "using",
  "use",
  "used",
  "via",
  "per",
  "et",
  "al",
]);

// =============================================================================
// Utilities
// =============================================================================

/** Create an HTML element with optional class and properties */
function createElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  props?: Partial<HTMLElementTagNameMap[K]>,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  if (props) Object.assign(el, props);
  return el;
}

function createActionDropdown(doc: Document, spec: ActionDropdownSpec) {
  const slot = createElement(
    doc,
    "div",
    `llm-action-slot ${spec.slotClassName}`.trim(),
    { id: spec.slotId },
  );
  const button = createElement(doc, "button", spec.buttonClassName, {
    id: spec.buttonId,
    textContent: spec.buttonText,
    disabled: spec.disabled,
  });
  const menu = createElement(doc, "div", spec.menuClassName, {
    id: spec.menuId,
  });
  menu.style.display = "none";
  slot.append(button, menu);
  return { slot, button, menu };
}

/** Get AbortController constructor from global scope */
function getAbortController(): new () => AbortController {
  return (
    (ztoolkit.getGlobal("AbortController") as new () => AbortController) ||
    (
      globalThis as typeof globalThis & {
        AbortController: new () => AbortController;
      }
    ).AbortController
  );
}

function appendReasoningPart(base: string | undefined, next?: string): string {
  const chunk = sanitizeText(next || "");
  if (!chunk) return base || "";
  return `${base || ""}${chunk}`;
}

function getConversationKey(item: Zotero.Item): number {
  if (item.isAttachment() && item.parentID) {
    return item.parentID;
  }
  return item.id;
}

async function persistConversationMessage(
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

function toPanelMessage(message: StoredChatMessage): Message {
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

async function ensureConversationLoaded(item: Zotero.Item): Promise<void> {
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

function detectReasoningProvider(modelName: string): ReasoningProviderKind {
  const name = modelName.trim().toLowerCase();
  if (!name) return "unsupported";
  if (name.startsWith("deepseek")) {
    return "deepseek";
  }
  if (
    name === "kimi-k2.5" ||
    name === "kimi-k2-thinking" ||
    name === "kimi-k2-thinking-turbo"
  ) {
    return "kimi";
  }
  if (name.includes("gemini")) return "gemini";
  if (/^(gpt-5|o\d)(\b|[.-])/.test(name)) return "openai";
  return "unsupported";
}

function getReasoningOptions(
  provider: ReasoningProviderKind,
  modelName: string,
  apiBase?: string,
): ReasoningOption[] {
  if (provider === "unsupported") return [];
  return getRuntimeReasoningOptions({
    provider,
    modelName,
    apiBase,
  }).map((option) => ({
    level: option.level as LLMReasoningLevel,
    enabled: option.enabled,
    label: option.label,
  }));
}

async function optimizeImageDataUrl(
  win: Window,
  dataUrl: string,
): Promise<string> {
  const maxDimension = 1024;
  const jpegQuality = 0.7;

  try {
    const ImageCtor = win.Image as typeof Image;
    const img = new ImageCtor();
    img.src = dataUrl;
    await img.decode();

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return dataUrl;

    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = win.document.createElement("canvas") as HTMLCanvasElement;
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return dataUrl;

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    return canvas.toDataURL("image/jpeg", jpegQuality);
  } catch (err) {
    ztoolkit.log("Screenshot optimize failed:", err);
    return dataUrl;
  }
}

/**
 * Screenshot selection overlay for capturing regions from the PDF reader
 */
async function captureScreenshotSelection(win: Window): Promise<string | null> {
  return new Promise((resolve) => {
    const doc = win.document;

    // Find the appropriate container (body for HTML, documentElement for XUL)
    const container = doc.body || doc.documentElement;
    if (!container) {
      ztoolkit.log("Screenshot: No container found");
      resolve(null);
      return;
    }

    // Create overlay with inline styles using HTML namespace
    const overlay = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    overlay.id = "llm-screenshot-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      bottom: "0",
      width: "100vw",
      height: "100vh",
      zIndex: "10000",
      cursor: "crosshair",
      background: "rgba(0, 0, 0, 0.3)",
    });

    // Instructions
    const instructions = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    Object.assign(instructions.style, {
      position: "fixed",
      top: "20px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(0, 0, 0, 0.8)",
      color: "white",
      padding: "12px 20px",
      borderRadius: "8px",
      fontSize: "14px",
      fontWeight: "500",
      zIndex: "10001",
      pointerEvents: "none",
    });
    instructions.textContent =
      "Click and drag to select a region, then release";

    // Cancel button
    const cancelBtn = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    Object.assign(cancelBtn.style, {
      position: "fixed",
      bottom: "20px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#dc2626",
      color: "white",
      border: "none",
      padding: "10px 24px",
      borderRadius: "8px",
      fontSize: "14px",
      fontWeight: "500",
      cursor: "pointer",
      zIndex: "10001",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      lineHeight: "1",
      minWidth: "120px",
    });
    cancelBtn.textContent = "Cancel (Esc)";

    // Selection rectangle
    const selection = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    Object.assign(selection.style, {
      position: "absolute",
      border: "2px dashed #2563eb",
      background: "rgba(37, 99, 235, 0.2)",
      pointerEvents: "none",
      display: "none",
    });

    overlay.append(instructions, cancelBtn, selection);

    try {
      container.appendChild(overlay);
      ztoolkit.log("Screenshot: Overlay appended to", container.tagName);
    } catch (err) {
      ztoolkit.log("Screenshot: Failed to append overlay", err);
      resolve(null);
      return;
    }

    let startX = 0;
    let startY = 0;
    let isSelecting = false;
    let isReady = false;
    let resolved = false;

    const cleanup = () => {
      if (overlay.parentNode) {
        overlay.remove();
      }
      doc.removeEventListener("keydown", onKeyDown);
    };

    const safeResolve = (value: string | null, reason: string) => {
      if (resolved) return;
      resolved = true;
      ztoolkit.log(
        "Screenshot: Resolving with",
        value ? "image" : "null",
        "-",
        reason,
      );
      cleanup();
      resolve(value);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      ztoolkit.log("Screenshot: Key pressed:", e.key);
      if (e.key === "Escape") {
        safeResolve(null, "Escape pressed");
      }
    };

    doc.addEventListener("keydown", onKeyDown);

    cancelBtn.addEventListener("click", (e: MouseEvent) => {
      ztoolkit.log("Screenshot: Cancel button clicked");
      e.preventDefault();
      e.stopPropagation();
      safeResolve(null, "Cancel clicked");
    });

    // Wait before accepting mouse events to prevent button click from triggering
    setTimeout(() => {
      isReady = true;
      ztoolkit.log("Screenshot: Now ready for selection");
    }, 200);

    overlay.addEventListener("mousedown", (e: MouseEvent) => {
      ztoolkit.log(
        "Screenshot: mousedown, isReady:",
        isReady,
        "target:",
        (e.target as Element)?.tagName,
      );
      if (!isReady) {
        ztoolkit.log("Screenshot: Ignoring mousedown - not ready yet");
        return;
      }
      if (e.target === cancelBtn) return;
      e.preventDefault();
      e.stopPropagation();
      isSelecting = true;
      startX = e.clientX;
      startY = e.clientY;
      selection.style.left = `${startX}px`;
      selection.style.top = `${startY}px`;
      selection.style.width = "0px";
      selection.style.height = "0px";
      selection.style.display = "block";
      ztoolkit.log("Screenshot: Selection started at", startX, startY);
    });

    overlay.addEventListener("mousemove", (e: MouseEvent) => {
      if (!isSelecting) return;
      e.preventDefault();
      const currentX = e.clientX;
      const currentY = e.clientY;

      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);
      const width = Math.abs(currentX - startX);
      const height = Math.abs(currentY - startY);

      selection.style.left = `${left}px`;
      selection.style.top = `${top}px`;
      selection.style.width = `${width}px`;
      selection.style.height = `${height}px`;
    });

    overlay.addEventListener("mouseup", async (e: MouseEvent) => {
      ztoolkit.log(
        "Screenshot: mouseup, isReady:",
        isReady,
        "isSelecting:",
        isSelecting,
      );
      if (!isReady) {
        ztoolkit.log("Screenshot: Ignoring mouseup - not ready yet");
        return;
      }
      if (!isSelecting) {
        ztoolkit.log("Screenshot: Ignoring mouseup - not selecting");
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      isSelecting = false;

      const endX = e.clientX;
      const endY = e.clientY;

      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);

      ztoolkit.log("Screenshot: Selection size:", width, "x", height);

      // Minimum selection size - just reset if too small
      if (width < 20 || height < 20) {
        ztoolkit.log("Screenshot: Selection too small, resetting");
        selection.style.display = "none";
        return;
      }

      // Hide overlay before capture
      overlay.style.display = "none";

      try {
        const dataUrl = await captureRegion(win, left, top, width, height);
        safeResolve(dataUrl, "Capture complete");
      } catch (err) {
        ztoolkit.log("Screenshot capture failed:", err);
        safeResolve(null, "Capture error");
      }
    });
  });
}

/**
 * Capture a region of the window using canvas
 */
async function captureRegion(
  win: Window,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<string | null> {
  try {
    // Try to find the PDF canvas in the reader
    const readerFrame = win.document.querySelector(
      'iframe[src*="reader"]',
    ) as HTMLIFrameElement | null;

    let targetDoc = win.document;
    if (readerFrame?.contentDocument) {
      targetDoc = readerFrame.contentDocument;
    }

    // Look for the PDF viewer canvas
    const pdfCanvas = targetDoc.querySelector(
      ".pdfViewer canvas, .canvasWrapper canvas, canvas.pdfViewer",
    ) as HTMLCanvasElement | null;

    if (pdfCanvas) {
      const canvasRect = pdfCanvas.getBoundingClientRect();
      const relX = x - canvasRect.left;
      const relY = y - canvasRect.top;

      const scaleX = pdfCanvas.width / canvasRect.width;
      const scaleY = pdfCanvas.height / canvasRect.height;

      const srcX = Math.max(0, relX * scaleX);
      const srcY = Math.max(0, relY * scaleY);
      const srcWidth = Math.min(width * scaleX, pdfCanvas.width - srcX);
      const srcHeight = Math.min(height * scaleY, pdfCanvas.height - srcY);

      if (srcWidth > 0 && srcHeight > 0) {
        const tempCanvas = win.document.createElement(
          "canvas",
        ) as HTMLCanvasElement;
        tempCanvas.width = srcWidth;
        tempCanvas.height = srcHeight;
        const ctx = tempCanvas.getContext(
          "2d",
        ) as CanvasRenderingContext2D | null;

        if (ctx) {
          ctx.drawImage(
            pdfCanvas,
            srcX,
            srcY,
            srcWidth,
            srcHeight,
            0,
            0,
            srcWidth,
            srcHeight,
          );
          return tempCanvas.toDataURL("image/png");
        }
      }
    }

    // Fallback: use Firefox's drawWindow if available
    ztoolkit.log("No PDF canvas found, using fallback capture");

    const canvas = win.document.createElement("canvas") as HTMLCanvasElement;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;

    if (!ctx) {
      return null;
    }

    if ("drawWindow" in ctx) {
      try {
        (
          ctx as CanvasRenderingContext2D & {
            drawWindow: (
              win: Window,
              x: number,
              y: number,
              w: number,
              h: number,
              bg: string,
            ) => void;
          }
        ).drawWindow(win, x, y, width, height, "white");
        return canvas.toDataURL("image/png");
      } catch (err) {
        ztoolkit.log("drawWindow failed:", err);
      }
    }

    return null;
  } catch (err) {
    ztoolkit.log("Capture region error:", err);
    return null;
  }
}

export function registerLLMStyles(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  if (doc.getElementById(`${config.addonRef}-styles`)) return;

  // Main styles
  const link = doc.createElement("link") as HTMLLinkElement;
  link.id = `${config.addonRef}-styles`;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  doc.documentElement?.appendChild(link);

  // KaTeX styles for math rendering
  const katexLink = doc.createElement("link") as HTMLLinkElement;
  katexLink.id = `${config.addonRef}-katex-styles`;
  katexLink.rel = "stylesheet";
  katexLink.type = "text/css";
  katexLink.href = `chrome://${config.addonRef}/content/vendor/katex/katex.min.css`;
  doc.documentElement?.appendChild(katexLink);
}

export function registerReaderContextPanel() {
  if (readerContextPanelRegistered) return;
  readerContextPanelRegistered = true;
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("llm-panel-head"),
      icon: `chrome://${config.addonRef}/content/icons/neuron.jpg`,
    },
    sidenav: {
      l10nID: getLocaleID("llm-panel-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/neuron.jpg`,
    },
    onItemChange: ({ setEnabled, tabType }) => {
      setEnabled(tabType === "reader" || tabType === "library");
      return true;
    },
    onRender: ({ body, item }) => {
      buildUI(body, item);
    },
    onAsyncRender: async ({ body, item }) => {
      if (item) {
        await ensureConversationLoaded(item);
      }
      await renderShortcuts(body, item);
      setupHandlers(body, item);
      refreshChat(body, item);
      // Defer PDF extraction so the panel becomes interactive sooner.
      const activeContextItem = getActiveContextAttachmentFromTabs();
      if (activeContextItem) {
        void ensurePDFTextCached(activeContextItem);
      }
    },
  });
}

export function registerReaderSelectionTracking() {
  const readerAPI = Zotero.Reader as _ZoteroTypes.Reader & {
    __llmSelectionTrackingRegistered?: boolean;
  };
  if (!readerAPI || readerAPI.__llmSelectionTrackingRegistered) return;

  const handler: _ZoteroTypes.Reader.EventHandler<
    "renderTextSelectionPopup"
  > = (event) => {
    const selectedText = normalizeSelectedText(
      event.params?.annotation?.text || "",
    );
    const itemId = event.reader?._item?.id || event.reader?.itemID;
    if (typeof itemId !== "number") return;
    const item = Zotero.Items.get(itemId) || null;
    const cacheKeys = getItemSelectionCacheKeys(item);
    const keys = cacheKeys.length ? cacheKeys : [itemId];

    if (selectedText) {
      for (const key of keys) {
        recentReaderSelectionCache.set(key, selectedText);
      }

      // Append a hidden sentinel element to the selection popup so we can
      // detect when the popup is dismissed (element becomes disconnected).
      // Once dismissed, clear the stale cache entry.
      try {
        const sentinel = event.doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "span",
        ) as HTMLSpanElement;
        sentinel.style.display = "none";
        event.append(sentinel);

        let wasConnected = false;
        let checks = 0;
        const maxChecks = 600; // safety cap ≈ 5 min

        const watchSentinel = () => {
          if (++checks > maxChecks) return;
          if (sentinel.isConnected) {
            wasConnected = true;
            setTimeout(watchSentinel, 500);
            return;
          }
          if (!wasConnected && checks <= 6) {
            // Popup may not be mounted yet — retry briefly
            setTimeout(watchSentinel, 200);
            return;
          }
          if (wasConnected) {
            // Popup was removed → clear cache only if it still holds *our* text
            for (const key of keys) {
              if (recentReaderSelectionCache.get(key) === selectedText) {
                recentReaderSelectionCache.delete(key);
              }
            }
          }
        };
        setTimeout(watchSentinel, 100);
      } catch (_err) {
        // If the sentinel couldn't be appended the cache won't auto-clear,
        // but the plugin still works — just with the old stale-cache caveat.
        ztoolkit.log("LLM: selection popup sentinel failed", _err);
      }
    } else {
      // Event fired with empty text — clear any stale cache
      for (const key of keys) {
        recentReaderSelectionCache.delete(key);
      }
    }
  };

  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    handler,
    config.addonID,
  );
  readerAPI.__llmSelectionTrackingRegistered = true;
}

function buildUI(body: Element, item?: Zotero.Item | null) {
  body.textContent = "";
  const doc = body.ownerDocument!;
  const hasItem = Boolean(item);

  // Main container
  const container = createElement(doc, "div", "llm-panel", { id: "llm-main" });

  // Header section
  const header = createElement(doc, "div", "llm-header");
  const headerTop = createElement(doc, "div", "llm-header-top");
  const headerInfo = createElement(doc, "div", "llm-header-info");
  // const headerIcon = createElement(doc, "img", "llm-header-icon", {
  //   alt: "LLM",
  //   src: iconUrl,
  // });
  // const title = createElement(doc, "div", "llm-title", {
  //   textContent: "LLM Assistant",
  // });
  const title = createElement(doc, "div", "llm-title", {
    textContent: "LLM Assistant",
  });

  headerInfo.append(title);
  headerTop.appendChild(headerInfo);

  const clearBtn = createElement(doc, "button", "llm-btn-icon", {
    id: "llm-clear",
    textContent: "Clear",
  });
  headerTop.appendChild(clearBtn);
  header.appendChild(headerTop);
  container.appendChild(header);

  // Chat display area
  const chatBox = createElement(doc, "div", "llm-messages", {
    id: "llm-chat-box",
  });
  container.appendChild(chatBox);

  // Shortcuts row
  const shortcutsRow = createElement(doc, "div", "llm-shortcuts", {
    id: "llm-shortcuts",
  });
  container.appendChild(shortcutsRow);

  // Shortcut context menu
  const shortcutMenu = createElement(doc, "div", "llm-shortcut-menu", {
    id: "llm-shortcut-menu",
  });
  shortcutMenu.style.display = "none";
  const menuEditBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-edit",
    type: "button",
    textContent: "Edit",
  });
  const menuDeleteBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-delete",
    type: "button",
    textContent: "Delete",
  });
  const menuAddBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-add",
    type: "button",
    textContent: "Add",
  });
  const menuMoveBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-move",
    type: "button",
    textContent: "Move",
  });
  const menuResetBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-reset",
    type: "button",
    textContent: "Reset",
  });
  shortcutMenu.append(
    menuEditBtn,
    menuDeleteBtn,
    menuAddBtn,
    menuMoveBtn,
    menuResetBtn,
  );
  container.appendChild(shortcutMenu);

  // Response context menu
  const responseMenu = createElement(doc, "div", "llm-response-menu", {
    id: "llm-response-menu",
  });
  responseMenu.style.display = "none";
  const responseMenuCopyBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-copy",
      type: "button",
      textContent: "Copy",
    },
  );
  const responseMenuNoteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-note",
      type: "button",
      textContent: "Create a new note",
    },
  );
  responseMenu.append(responseMenuCopyBtn, responseMenuNoteBtn);
  container.appendChild(responseMenu);

  // Input section
  const inputSection = createElement(doc, "div", "llm-input-section");
  const selectedContext = createElement(doc, "div", "llm-selected-context", {
    id: "llm-selected-context",
  });
  selectedContext.style.display = "none";
  const selectedContextTop = createElement(
    doc,
    "div",
    "llm-selected-context-top",
  );
  const selectedContextLabel = createElement(
    doc,
    "div",
    "llm-selected-context-label",
    {
      textContent: "Selected Context",
    },
  );
  const selectedContextClear = createElement(
    doc,
    "button",
    "llm-selected-context-clear",
    {
      id: "llm-selected-context-clear",
      type: "button",
      textContent: "Clear",
    },
  );
  const selectedContextText = createElement(
    doc,
    "div",
    "llm-selected-context-text",
    {
      id: "llm-selected-context-text",
    },
  );
  selectedContextTop.append(selectedContextLabel, selectedContextClear);
  selectedContext.append(selectedContextTop, selectedContextText);
  inputSection.appendChild(selectedContext);

  const inputBox = createElement(doc, "textarea", "llm-input", {
    id: "llm-input",
    placeholder: hasItem
      ? "Ask a question about this paper..."
      : "Open a PDF first",
    disabled: !hasItem,
  });
  inputSection.appendChild(inputBox);

  // Image preview area (shows selected screenshot)
  const imagePreview = createElement(doc, "div", "llm-image-preview", {
    id: "llm-image-preview",
  });
  imagePreview.style.display = "none";

  const imagePreviewMeta = createElement(doc, "div", "llm-image-preview-meta", {
    id: "llm-image-preview-meta",
    textContent: "0 images selected",
  });
  const previewStrip = createElement(doc, "div", "llm-image-preview-strip", {
    id: "llm-image-preview-strip",
  });

  const removeImgBtn = createElement(doc, "button", "llm-remove-img-btn", {
    id: "llm-remove-img",
    textContent: "Clear All",
    title: "Clear selected screenshots",
  });

  imagePreview.append(imagePreviewMeta, previewStrip, removeImgBtn);

  // Actions row
  const actionsRow = createElement(doc, "div", "llm-actions");
  const actionsLeft = createElement(doc, "div", "llm-actions-left");
  const actionsRight = createElement(doc, "div", "llm-actions-right");

  const selectTextBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-select-text-btn",
    {
      id: "llm-select-text",
      textContent: SELECT_TEXT_EXPANDED_LABEL,
      title: "Include selected reader text",
      disabled: !hasItem,
    },
  );
  const selectTextSlot = createElement(doc, "div", "llm-action-slot");
  selectTextSlot.appendChild(selectTextBtn);

  // Screenshot button
  const screenshotBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-screenshot-btn",
    {
      id: "llm-screenshot",
      textContent: SCREENSHOT_EXPANDED_LABEL,
      title: "Select figure screenshot",
      disabled: !hasItem,
    },
  );
  const screenshotSlot = createElement(doc, "div", "llm-action-slot");
  screenshotSlot.appendChild(screenshotBtn);

  const {
    slot: modelDropdown,
    button: modelBtn,
    menu: modelMenu,
  } = createActionDropdown(doc, {
    slotId: "llm-model-dropdown",
    slotClassName: "llm-model-dropdown",
    buttonId: "llm-model-toggle",
    buttonClassName:
      "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-model-btn",
    buttonText: "Model: ...",
    menuId: "llm-model-menu",
    menuClassName: "llm-model-menu",
    disabled: !hasItem,
  });

  const {
    slot: reasoningDropdown,
    button: reasoningBtn,
    menu: reasoningMenu,
  } = createActionDropdown(doc, {
    slotId: "llm-reasoning-dropdown",
    slotClassName: "llm-reasoning-dropdown",
    buttonId: "llm-reasoning-toggle",
    buttonClassName:
      "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-reasoning-btn",
    buttonText: "Reasoning",
    menuId: "llm-reasoning-menu",
    menuClassName: "llm-reasoning-menu",
    disabled: !hasItem,
  });

  const sendBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-primary llm-send-btn",
    {
      id: "llm-send",
      textContent: "Send",
      title: "Send",
      disabled: !hasItem,
    },
  );
  const cancelBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-danger llm-send-btn llm-cancel-btn",
    {
      id: "llm-cancel",
      textContent: "Cancel",
    },
  );
  cancelBtn.style.display = "none";
  const sendSlot = createElement(doc, "div", "llm-action-slot");
  sendSlot.append(sendBtn, cancelBtn);

  const statusLine = createElement(doc, "div", "llm-status", {
    id: "llm-status",
    textContent: hasItem ? "Ready" : "Select an item or open a PDF",
  });

  actionsLeft.append(
    selectTextSlot,
    screenshotSlot,
    modelDropdown,
    reasoningDropdown,
  );
  actionsRight.append(sendSlot);
  actionsRow.append(actionsLeft, actionsRight);
  inputSection.appendChild(imagePreview);
  inputSection.appendChild(actionsRow);
  container.appendChild(inputSection);
  container.appendChild(statusLine);
  body.appendChild(container);
}

async function cachePDFText(item: Zotero.Item) {
  if (pdfTextCache.has(item.id)) return;

  try {
    let pdfText = "";
    const mainItem =
      item.isAttachment() && item.parentID
        ? Zotero.Items.get(item.parentID)
        : null;

    const title = mainItem?.getField("title") || item.getField("title") || "";

    const pdfItem =
      item.isAttachment() && item.attachmentContentType === "application/pdf"
        ? item
        : null;

    if (pdfItem) {
      try {
        const result = await Zotero.PDFWorker.getFullText(pdfItem.id);
        if (result && result.text) {
          pdfText = result.text;
        }
      } catch (e) {
        ztoolkit.log("PDF extraction failed:", e);
      }
    }

    if (pdfText) {
      const chunks = splitIntoChunks(pdfText, CHUNK_TARGET_LENGTH);
      const { chunkStats, docFreq, avgChunkLength } = buildChunkIndex(chunks);
      pdfTextCache.set(item.id, {
        title,
        chunks,
        chunkStats,
        docFreq,
        avgChunkLength,
        fullLength: pdfText.length,
        embeddingFailed: false,
      });
    } else {
      pdfTextCache.set(item.id, {
        title,
        chunks: [],
        chunkStats: [],
        docFreq: {},
        avgChunkLength: 0,
        fullLength: 0,
        embeddingFailed: false,
      });
    }
  } catch (e) {
    ztoolkit.log("Error caching PDF:", e);
    pdfTextCache.set(item.id, {
      title: "",
      chunks: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
      embeddingFailed: false,
    });
  }
}

async function ensurePDFTextCached(item: Zotero.Item): Promise<void> {
  if (pdfTextCache.has(item.id)) return;
  const existingTask = pdfTextLoadingTasks.get(item.id);
  if (existingTask) {
    await existingTask;
    return;
  }
  const task = (async () => {
    try {
      await cachePDFText(item);
    } finally {
      pdfTextLoadingTasks.delete(item.id);
    }
  })();
  pdfTextLoadingTasks.set(item.id, task);
  await task;
}

type ChunkStat = {
  index: number;
  length: number;
  tf: Record<string, number>;
  uniqueTerms: string[];
};

function splitIntoChunks(text: string, targetLength: number): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    if (p.length > targetLength) {
      pushCurrent();
      let start = 0;
      while (start < p.length) {
        const end = Math.min(start + targetLength, p.length);
        const slice = p.slice(start, end).trim();
        if (slice) chunks.push(slice);
        if (end === p.length) break;
        start = Math.max(0, end - CHUNK_OVERLAP);
      }
      continue;
    }
    if (current.length + p.length + 2 <= targetLength) {
      current = current ? `${current}\n\n${p}` : p;
    } else {
      pushCurrent();
      current = p;
    }
  }
  pushCurrent();
  return chunks;
}

function tokenizeText(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function buildChunkIndex(chunks: string[]): {
  chunkStats: ChunkStat[];
  docFreq: Record<string, number>;
  avgChunkLength: number;
} {
  const docFreq: Record<string, number> = {};
  const chunkStats: ChunkStat[] = [];
  let totalLength = 0;

  chunks.forEach((chunk, index) => {
    const tokens = tokenizeText(chunk);
    const tf: Record<string, number> = {};
    for (const term of tokens) {
      tf[term] = (tf[term] || 0) + 1;
    }
    const uniqueTerms = Object.keys(tf);
    for (const term of uniqueTerms) {
      docFreq[term] = (docFreq[term] || 0) + 1;
    }
    const length = tokens.length;
    totalLength += length;
    chunkStats.push({ index, length, tf, uniqueTerms });
  });

  const avgChunkLength = chunks.length ? totalLength / chunks.length : 0;
  return { chunkStats, docFreq, avgChunkLength };
}

function tokenizeQuery(query: string): string[] {
  const tokens = tokenizeText(query);
  return Array.from(new Set(tokens));
}

function scoreChunkBM25(
  chunk: ChunkStat,
  terms: string[],
  docFreq: Record<string, number>,
  totalChunks: number,
  avgChunkLength: number,
): number {
  if (!terms.length || !chunk.length) return 0;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;

  for (const term of terms) {
    const tf = chunk.tf[term] || 0;
    if (!tf) continue;
    const df = docFreq[term] || 0;
    const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
    const norm =
      (tf * (k1 + 1)) /
      (tf + k1 * (1 - b + (b * chunk.length) / avgChunkLength));
    score += idf * norm;
  }

  return score;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeScores(scores: number[]): number[] {
  if (!scores.length) return [];
  let min = scores[0];
  let max = scores[0];
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (max === min) return scores.map(() => 0);
  return scores.map((s) => (s - min) / (max - min));
}

async function embedTexts(
  texts: string[],
  overrides?: { apiBase?: string; apiKey?: string },
): Promise<number[][]> {
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchEmbeddings = await callEmbeddings(batch, overrides);
    all.push(...batchEmbeddings);
  }
  return all;
}

async function ensureEmbeddings(
  pdfContext: PdfContext,
  overrides?: { apiBase?: string; apiKey?: string },
): Promise<boolean> {
  if (pdfContext.embeddingFailed) return false;
  if (pdfContext.embeddings && pdfContext.embeddings.length) {
    return pdfContext.embeddings.length === pdfContext.chunks.length;
  }

  if (pdfContext.embeddingPromise) {
    const result = await pdfContext.embeddingPromise;
    if (result) {
      pdfContext.embeddings = result;
      return result.length === pdfContext.chunks.length;
    }
    return false;
  }

  pdfContext.embeddingPromise = (async () => {
    try {
      const embeddings = await embedTexts(pdfContext.chunks, overrides);
      return embeddings;
    } catch (err) {
      ztoolkit.log("Embedding generation failed:", err);
      return null;
    }
  })();

  const result = await pdfContext.embeddingPromise;
  pdfContext.embeddingPromise = undefined;
  if (result) {
    pdfContext.embeddings = result;
    return result.length === pdfContext.chunks.length;
  }
  pdfContext.embeddingFailed = true;
  return false;
}

async function buildContext(
  pdfContext: PdfContext | undefined,
  question: string,
  hasImage: boolean,
  apiOverrides?: { apiBase?: string; apiKey?: string },
): Promise<string> {
  if (!pdfContext) return "";
  const { title, chunks, chunkStats, docFreq, avgChunkLength, fullLength } =
    pdfContext;
  const contextParts: string[] = [];
  if (title) contextParts.push(`Title: ${title}`);
  if (!chunks.length) return contextParts.join("\n\n");
  if (FORCE_FULL_CONTEXT && !hasImage) {
    if (!fullLength || fullLength <= FULL_CONTEXT_CHAR_LIMIT) {
      contextParts.push("Paper Text:");
      contextParts.push(chunks.join("\n\n"));
      if (fullLength) {
        contextParts.push(`\n[Full context ${fullLength} chars]`);
      }
      return contextParts.join("\n\n");
    }
    contextParts.push(
      `\n[Full context ${fullLength} chars exceeds ${FULL_CONTEXT_CHAR_LIMIT}. Falling back to retrieval.]`,
    );
  }

  const terms = tokenizeQuery(question);
  const bm25Scores = chunkStats.map((chunk) =>
    scoreChunkBM25(chunk, terms, docFreq, chunks.length, avgChunkLength || 1),
  );

  let embeddingScores: number[] | null = null;
  const embeddingsReady = await ensureEmbeddings(pdfContext, apiOverrides);
  if (embeddingsReady && pdfContext.embeddings) {
    try {
      const queryEmbedding =
        (await callEmbeddings([question], apiOverrides))[0] || [];
      if (queryEmbedding.length) {
        embeddingScores = pdfContext.embeddings.map((vec) =>
          cosineSimilarity(queryEmbedding, vec),
        );
      }
    } catch (err) {
      ztoolkit.log("Query embedding failed:", err);
    }
  }

  const bm25Norm = normalizeScores(bm25Scores);
  const embedNorm = embeddingScores ? normalizeScores(embeddingScores) : null;

  const bm25Weight = embedNorm ? HYBRID_WEIGHT_BM25 : 1;
  const embedWeight = embedNorm ? HYBRID_WEIGHT_EMBEDDING : 0;

  const scored = chunkStats.map((chunk, idx) => ({
    index: chunk.index,
    chunk: chunks[chunk.index],
    score:
      bm25Norm[idx] * bm25Weight +
      (embedNorm ? embedNorm[idx] * embedWeight : 0),
  }));

  scored.sort((a, b) => b.score - a.score);
  const picked = new Set<number>();
  const addIndex = (idx: number) => {
    if (idx < 0 || idx >= chunks.length) return;
    if (picked.size >= MAX_CONTEXT_CHUNKS) return;
    picked.add(idx);
  };

  for (const entry of scored) {
    if (picked.size >= MAX_CONTEXT_CHUNKS) break;
    if (entry.score === 0 && picked.size > 0) break;
    addIndex(entry.index);
  }

  if (picked.size === 0) {
    addIndex(0);
    addIndex(1);
  }

  if (picked.size < MAX_CONTEXT_CHUNKS) {
    const primary = Array.from(picked);
    for (const idx of primary) {
      if (picked.size >= MAX_CONTEXT_CHUNKS) break;
      addIndex(idx - 1);
      if (picked.size >= MAX_CONTEXT_CHUNKS) break;
      addIndex(idx + 1);
    }
  }

  const totalChunks = chunks.length;
  let remaining = hasImage ? MAX_CONTEXT_LENGTH_WITH_IMAGE : MAX_CONTEXT_LENGTH;
  if (title) remaining -= `Title: ${title}`.length + 2;

  const excerpts: string[] = [];
  const sortedPicked = Array.from(picked).sort((a, b) => a - b);
  for (const index of sortedPicked) {
    if (index < 0 || index >= totalChunks) continue;
    const label = `Excerpt ${index + 1}/${totalChunks}`;
    const body = chunks[index];
    const block = `${label}\n${body}`;
    if (remaining <= 0) break;
    if (block.length > remaining) {
      excerpts.push(block.slice(0, Math.max(0, remaining)));
      remaining = 0;
      break;
    }
    excerpts.push(block);
    remaining -= block.length + 2;
  }

  if (excerpts.length) {
    contextParts.push("Paper Text:");
    contextParts.push(excerpts.join("\n\n"));
  }

  if (fullLength) {
    contextParts.push(`\n[Context window from ${fullLength} chars total]`);
  }

  return contextParts.join("\n\n");
}

function setStatus(
  statusEl: HTMLElement,
  text: string,
  variant: "ready" | "sending" | "error",
) {
  statusEl.textContent = text;
  statusEl.className = `llm-status llm-status-${variant}`;
}

function formatTime(timestamp: number) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${hour}:${minute}`;
}

function sanitizeText(text: string) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    ) {
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else {
        out += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }
    out += text[i];
  }
  return out;
}

function normalizeSelectedText(text: string): string {
  return sanitizeText(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SELECTED_TEXT_MAX_LENGTH);
}

function truncateSelectedText(text: string): string {
  if (text.length <= SELECTED_TEXT_PREVIEW_LENGTH) return text;
  return `${text.slice(0, SELECTED_TEXT_PREVIEW_LENGTH - 1)}\u2026`;
}

function buildQuestionWithSelectedText(
  selectedText: string,
  userPrompt: string,
): string {
  const normalizedPrompt =
    userPrompt.trim() || "Please explain this selected text.";
  return `Selected text from the PDF reader:\n"""\n${selectedText}\n"""\n\nUser question:\n${normalizedPrompt}`;
}

function getActiveReaderForSelectedTab(): any | null {
  const tabs = getZoteroTabsState();
  const selectedTabId = tabs?.selectedID;
  if (selectedTabId === undefined || selectedTabId === null) return null;
  return (
    (
      Zotero as unknown as {
        Reader?: { getByTabID?: (id: string | number) => any };
      }
    ).Reader?.getByTabID?.(selectedTabId as string | number) || null
  );
}

function parseItemID(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type ZoteroTabsState = {
  selectedID?: string | number;
  selectedType?: string;
  _tabs?: Array<{ id?: string | number; type?: string; data?: any }>;
};

function isTabsState(value: unknown): value is ZoteroTabsState {
  if (!value || typeof value !== "object") return false;
  const obj = value as any;
  return (
    "selectedID" in obj || "selectedType" in obj || Array.isArray(obj._tabs)
  );
}

function getZoteroTabsStateWithSource(): {
  tabs: ZoteroTabsState | null;
  source: string;
} {
  const candidates: Array<{ source: string; value: unknown }> = [];
  const push = (source: string, value: unknown) => {
    candidates.push({ source, value });
  };

  push(
    "local.Zotero.Tabs",
    (Zotero as unknown as { Tabs?: ZoteroTabsState }).Tabs,
  );

  let mainWindow: any = null;
  try {
    mainWindow = Zotero.getMainWindow?.() || null;
  } catch {}
  if (mainWindow) {
    push("mainWindow.Zotero.Tabs", mainWindow.Zotero?.Tabs);
    push("mainWindow.Zotero_Tabs", mainWindow.Zotero_Tabs);
    push("mainWindow.Tabs", mainWindow.Tabs);
  }

  let activePaneWindow: any = null;
  try {
    activePaneWindow =
      Zotero.getActiveZoteroPane?.()?.document?.defaultView || null;
  } catch {}
  if (activePaneWindow) {
    push("activePaneWindow.Zotero.Tabs", activePaneWindow.Zotero?.Tabs);
    push("activePaneWindow.Zotero_Tabs", activePaneWindow.Zotero_Tabs);
  }

  let anyMainWindow: any = null;
  try {
    const windows = Zotero.getMainWindows?.() || [];
    anyMainWindow = windows[0] || null;
  } catch {}
  if (anyMainWindow) {
    push("mainWindows[0].Zotero.Tabs", anyMainWindow.Zotero?.Tabs);
    push("mainWindows[0].Zotero_Tabs", anyMainWindow.Zotero_Tabs);
  }

  try {
    const wmRecent = (Services as any).wm?.getMostRecentWindow?.(
      "navigator:browser",
    ) as any;
    push("wm:navigator:browser.Zotero.Tabs", wmRecent?.Zotero?.Tabs);
    push("wm:navigator:browser.Zotero_Tabs", wmRecent?.Zotero_Tabs);
  } catch {}
  try {
    const wmAny = (Services as any).wm?.getMostRecentWindow?.("") as any;
    push("wm:any.Zotero.Tabs", wmAny?.Zotero?.Tabs);
    push("wm:any.Zotero_Tabs", wmAny?.Zotero_Tabs);
  } catch {}

  const globalAny = globalThis as any;
  push("globalThis.Zotero_Tabs", globalAny.Zotero_Tabs);
  push("globalThis.window.Zotero_Tabs", globalAny.window?.Zotero_Tabs);

  for (const candidate of candidates) {
    if (isTabsState(candidate.value)) {
      return { tabs: candidate.value, source: candidate.source };
    }
  }
  return { tabs: null, source: "none" };
}

function getZoteroTabsState(): ZoteroTabsState | null {
  return getZoteroTabsStateWithSource().tabs;
}

function collectCandidateItemIDsFromObject(source: any): number[] {
  if (!source || typeof source !== "object") return [];
  const directCandidates = [
    source.itemID,
    source.itemId,
    source.attachmentID,
    source.attachmentId,
    source.readerItemID,
    source.readerItemId,
    source.id,
  ];
  const nestedObjects = [
    source.item,
    source.attachment,
    source.reader,
    source.state,
    source.params,
    source.extraData,
  ];
  const out: number[] = [];
  const seen = new Set<number>();
  const pushParsed = (value: unknown) => {
    const parsed = parseItemID(value);
    if (parsed === null || seen.has(parsed)) return;
    seen.add(parsed);
    out.push(parsed);
  };

  for (const candidate of directCandidates) {
    pushParsed(candidate);
  }
  for (const nested of nestedObjects) {
    if (!nested || typeof nested !== "object") continue;
    pushParsed((nested as any).itemID);
    pushParsed((nested as any).itemId);
    pushParsed((nested as any).attachmentID);
    pushParsed((nested as any).attachmentId);
    pushParsed((nested as any).id);
  }
  return out;
}

function getActiveContextAttachmentFromTabs(): Zotero.Item | null {
  const tabs = getZoteroTabsState();
  if (!tabs) return null;
  const selectedType = `${tabs.selectedType || ""}`.toLowerCase();
  if (selectedType && !selectedType.includes("reader")) return null;

  const selectedId =
    tabs.selectedID === undefined || tabs.selectedID === null
      ? ""
      : `${tabs.selectedID}`;
  if (!selectedId) return null;

  const tabList = Array.isArray(tabs._tabs) ? tabs._tabs : [];
  const activeTab = tabList.find((tab) => `${tab?.id || ""}` === selectedId);
  const activeType = `${activeTab?.type || ""}`.toLowerCase();
  if (!activeTab || (activeType && !activeType.includes("reader"))) return null;

  const data = activeTab.data || {};
  const candidateIDs = collectCandidateItemIDsFromObject(data);
  for (const itemId of candidateIDs) {
    const item = Zotero.Items.get(itemId);
    if (isSupportedContextAttachment(item)) return item;
  }

  // Fallback: map selected tab id to reader instance if available.
  const reader = (
    Zotero as unknown as {
      Reader?: { getByTabID?: (id: string | number) => any };
    }
  ).Reader?.getByTabID?.(selectedId);
  const readerItemId = parseItemID(reader?._item?.id ?? reader?.itemID);
  if (readerItemId !== null) {
    const readerItem = Zotero.Items.get(readerItemId);
    if (isSupportedContextAttachment(readerItem)) return readerItem;
  }

  return null;
}

function isSupportedContextAttachment(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
  return Boolean(
    item &&
    item.isAttachment() &&
    item.attachmentContentType === "application/pdf",
  );
}

function getContextItemLabel(item: Zotero.Item): string {
  const title = sanitizeText(item.getField("title") || "").trim();
  if (title) return title;
  return `Attachment ${item.id}`;
}

function resolveContextSourceItem(
  panelItem: Zotero.Item,
): ResolvedContextSource {
  void panelItem;
  const activeItem = getActiveContextAttachmentFromTabs();
  if (activeItem) {
    const label = getContextItemLabel(activeItem);
    return {
      contextItem: activeItem,
      statusText: `Using context: ${label} (active tab)`,
    };
  }

  const selectedTab = getZoteroTabsState();
  const selectedId =
    selectedTab?.selectedID === undefined || selectedTab?.selectedID === null
      ? ""
      : `${selectedTab.selectedID}`;
  const activeTab = Array.isArray(selectedTab?._tabs)
    ? selectedTab!._tabs!.find((tab) => `${tab?.id || ""}` === selectedId)
    : null;
  const dataKeys = activeTab?.data
    ? Object.keys(activeTab.data).slice(0, 6)
    : [];
  return {
    contextItem: null,
    statusText: `No active tab PDF context (tab=${selectedTab?.selectedID ?? "?"}, type=${selectedTab?.selectedType ?? "?"}, tabType=${activeTab?.type ?? "?"}, dataKeys=${dataKeys.join("|") || "-"})`,
  };
}

function getItemSelectionCacheKeys(
  item: Zotero.Item | null | undefined,
): number[] {
  if (!item) return [];
  const keys = new Set<number>();
  keys.add(item.id);
  if (item.isAttachment() && item.parentID) {
    keys.add(item.parentID);
  } else {
    const attachments = item.getAttachments();
    for (const attId of attachments) {
      const att = Zotero.Items.get(attId);
      if (att && att.attachmentContentType === "application/pdf") {
        keys.add(att.id);
      }
    }
  }
  return Array.from(keys);
}

function getActiveReaderSelectionText(
  panelDoc: Document,
  currentItem?: Zotero.Item | null,
): string {
  const reader = getActiveReaderForSelectedTab();

  const selectionFrom = (doc?: Document | null): string => {
    if (!doc) return "";
    const selected = doc.defaultView?.getSelection?.()?.toString() || "";
    return normalizeSelectedText(selected);
  };

  // 1. Check the reader's outer iframe document
  const readerDoc =
    (reader?._iframeWindow?.document as Document | undefined) ||
    (reader?._iframe?.contentDocument as Document | undefined) ||
    (reader?._window?.document as Document | undefined);
  const fromReaderDoc = selectionFrom(readerDoc);
  if (fromReaderDoc) return fromReaderDoc;

  // 2. Check the inner view iframe(s) (PDF text-layer, EPUB, snapshot)
  const internalReader = reader?._internalReader;
  const views = [internalReader?._primaryView, internalReader?._secondaryView];
  for (const view of views) {
    if (!view) continue;
    const viewDoc =
      (view._iframeWindow?.document as Document | undefined) ||
      (view._iframe?.contentDocument as Document | undefined);
    if (viewDoc) {
      const fromView = selectionFrom(viewDoc);
      if (fromView) return fromView;
    }
  }

  // 3. Check the panel document and its iframes
  const fromPanelDoc = selectionFrom(panelDoc);
  if (fromPanelDoc) return fromPanelDoc;

  const iframes = Array.from(
    panelDoc.querySelectorAll("iframe"),
  ) as HTMLIFrameElement[];
  for (const frame of iframes) {
    const fromFrame = selectionFrom(frame.contentDocument);
    if (fromFrame) return fromFrame;
  }

  // 4. Cache fallback — populated by the renderTextSelectionPopup event
  //    handler which also tracks popup lifecycle via a sentinel element.
  //    When the popup is dismissed the sentinel becomes disconnected and
  //    the cache entry is automatically cleared, preventing stale results.
  const itemId = reader?._item?.id || reader?.itemID;
  if (typeof itemId === "number") {
    const readerItem = Zotero.Items.get(itemId) || null;
    const readerKeys = getItemSelectionCacheKeys(readerItem);
    for (const key of readerKeys) {
      const fromCache = recentReaderSelectionCache.get(key) || "";
      if (fromCache) return fromCache;
    }
  }

  const panelKeys = getItemSelectionCacheKeys(currentItem || null);
  for (const key of panelKeys) {
    const fromCache = recentReaderSelectionCache.get(key) || "";
    if (fromCache) return fromCache;
  }

  return "";
}

function applySelectedTextPreview(body: Element, itemId: number) {
  const previewBox = body.querySelector(
    "#llm-selected-context",
  ) as HTMLDivElement | null;
  const previewText = body.querySelector(
    "#llm-selected-context-text",
  ) as HTMLDivElement | null;
  const selectTextBtn = body.querySelector(
    "#llm-select-text",
  ) as HTMLButtonElement | null;
  if (!previewBox || !previewText) return;
  const selectedText = selectedTextCache.get(itemId) || "";
  if (!selectedText) {
    previewBox.style.display = "none";
    previewText.textContent = "";
    if (selectTextBtn) {
      selectTextBtn.classList.remove("llm-action-btn-active");
    }
    return;
  }
  previewBox.style.display = "flex";
  previewText.textContent = truncateSelectedText(selectedText);
  if (selectTextBtn) {
    selectTextBtn.classList.add("llm-action-btn-active");
  }
}

function includeSelectedTextFromReader(
  body: Element,
  item: Zotero.Item,
  prefetchedText?: string,
): boolean {
  const selectedText =
    normalizeSelectedText(prefetchedText || "") ||
    getActiveReaderSelectionText(body.ownerDocument as Document, item);
  const status = body.querySelector("#llm-status") as HTMLElement | null;
  if (!selectedText) {
    if (status) setStatus(status, "No text selected in reader", "error");
    return false;
  }
  selectedTextCache.set(item.id, selectedText);
  applySelectedTextPreview(body, item.id);
  if (status) setStatus(status, "Selected text included", "ready");
  const inputEl = body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  inputEl?.focus();
  return true;
}

function escapeNoteHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveParentItemForNote(item: Zotero.Item): Zotero.Item | null {
  if (item.isAttachment() && item.parentID) {
    return Zotero.Items.get(item.parentID) || null;
  }
  return item;
}

function buildAssistantNoteHtml(
  contentText: string,
  modelName: string,
): string {
  const response = sanitizeText(contentText || "").trim();
  const source = modelName.trim() || "unknown";
  let responseHtml = "";
  try {
    responseHtml = renderMarkdown(response);
  } catch (err) {
    ztoolkit.log("Note markdown render error:", err);
    responseHtml = escapeNoteHtml(response).replace(/\n/g, "<br/>");
  }
  return `<div>${responseHtml}</div><hr/><p>Generated by ${escapeNoteHtml(source)} model, written by Zotero-LLM plugin</p>`;
}

function buildAssistantNoteHtmlFromRenderedSelection(
  renderedHtml: string,
  modelName: string,
): string {
  const source = modelName.trim() || "unknown";
  const body = renderedHtml.trim();
  if (!body) {
    return buildAssistantNoteHtml("", modelName);
  }
  return `<div>${body}</div><hr/><p>Generated by ${escapeNoteHtml(source)} model, written by Zotero-LLM plugin</p>`;
}

function sanitizeHtmlFragmentForNote(
  doc: Document,
  fragmentHtml: string,
): string {
  const wrapper = doc.createElement("div");
  wrapper.innerHTML = fragmentHtml;

  const blockedTags = new Set([
    "SCRIPT",
    "STYLE",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "LINK",
    "META",
    "FORM",
    "INPUT",
    "BUTTON",
    "TEXTAREA",
    "SELECT",
  ]);

  const walk = (node: Node) => {
    const childNodes = Array.from(node.childNodes);
    for (const child of childNodes) {
      if (!child) continue;
      if (child.nodeType !== 1) {
        walk(child);
        continue;
      }
      const el = child as Element;
      const tag = (el.tagName || "").toUpperCase();
      if (blockedTags.has(tag)) {
        el.remove();
        continue;
      }

      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = (attr.value || "").trim().toLowerCase();
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
          continue;
        }
        if (name === "style" || name === "id" || name === "class") {
          el.removeAttribute(attr.name);
          continue;
        }
        if (
          (name === "href" || name === "src" || name === "xlink:href") &&
          (value.startsWith("javascript:") ||
            value.startsWith("data:text/html"))
        ) {
          el.removeAttribute(attr.name);
        }
      }

      walk(el);
    }
  };

  walk(wrapper);
  return wrapper.innerHTML.trim();
}

function getSelectedTextWithinElement(
  doc: Document,
  container: HTMLElement,
): string {
  const win = doc.defaultView;
  const selection = win?.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }
  const selected = sanitizeText(selection.toString() || "").trim();
  if (!selected) return "";
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const anchorInside = !!(anchorNode && container.contains(anchorNode));
  const focusInside = !!(focusNode && container.contains(focusNode));
  if (!anchorInside || !focusInside) {
    return "";
  }
  return selected;
}

function getSelectedHtmlWithinElement(
  doc: Document,
  container: HTMLElement,
): string {
  const win = doc.defaultView;
  const selection = win?.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const anchorInside = !!(anchorNode && container.contains(anchorNode));
  const focusInside = !!(focusNode && container.contains(focusNode));
  if (!anchorInside || !focusInside) {
    return "";
  }

  try {
    const range = selection.getRangeAt(0);
    const fragment = range.cloneContents();
    const temp = doc.createElement("div");
    temp.appendChild(fragment);
    const selectedHtml = String(temp.innerHTML || "");
    return sanitizeHtmlFragmentForNote(doc, selectedHtml);
  } catch (err) {
    ztoolkit.log("Selected HTML extraction failed:", err);
    return "";
  }
}

function positionMenuAtPointer(
  body: Element,
  menu: HTMLDivElement,
  clientX: number,
  clientY: number,
): void {
  const win = body.ownerDocument?.defaultView;
  if (!win) return;

  const viewportMargin = 8;
  menu.style.position = "fixed";
  menu.style.display = "grid";
  menu.style.visibility = "hidden";
  menu.style.maxHeight = `${Math.max(120, win.innerHeight - viewportMargin * 2)}px`;
  menu.style.overflowY = "auto";

  const menuRect = menu.getBoundingClientRect();
  const maxLeft = Math.max(
    viewportMargin,
    win.innerWidth - menuRect.width - viewportMargin,
  );
  const maxTop = Math.max(
    viewportMargin,
    win.innerHeight - menuRect.height - viewportMargin,
  );
  const left = Math.min(Math.max(viewportMargin, clientX), maxLeft);
  const top = Math.min(Math.max(viewportMargin, clientY), maxTop);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = "visible";
}

async function copyTextToClipboard(body: Element, text: string): Promise<void> {
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

function htmlToPlainText(doc: Document, html: string): string {
  const temp = doc.createElement("div");
  temp.innerHTML = html;
  return sanitizeText(temp.textContent || "").trim();
}

async function copyNotePayloadToClipboard(
  body: Element,
  noteHtml: string,
  noteText: string,
): Promise<void> {
  const doc = body.ownerDocument;
  if (!doc) {
    await copyTextToClipboard(body, noteText);
    return;
  }
  const html = sanitizeHtmlFragmentForNote(doc, noteHtml || "");
  const plain = html
    ? htmlToPlainText(doc, html)
    : sanitizeText(noteText || "").trim();
  const win = doc.defaultView as
    | (Window & {
        navigator?: Navigator;
        ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem;
      })
    | undefined;

  if (html && plain && win?.navigator?.clipboard?.write && win.ClipboardItem) {
    try {
      const item = new win.ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      });
      await win.navigator.clipboard.write([item]);
      return;
    } catch (err) {
      ztoolkit.log("Clipboard rich copy failed:", err);
    }
  }

  await copyTextToClipboard(body, plain);
}

async function createNoteFromAssistantText(
  item: Zotero.Item,
  contentText: string,
  modelName: string,
  renderedSelectionHtml = "",
): Promise<void> {
  const parentItem = resolveParentItemForNote(item);
  if (!parentItem?.id) {
    throw new Error("No parent item available for note creation");
  }

  const note = new Zotero.Item("note");
  note.libraryID = parentItem.libraryID;
  note.parentID = parentItem.id;
  const html =
    renderedSelectionHtml.trim() !== ""
      ? buildAssistantNoteHtmlFromRenderedSelection(
          renderedSelectionHtml,
          modelName,
        )
      : buildAssistantNoteHtml(contentText, modelName);
  note.setNote(html);
  await note.saveTx();
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function applyPanelFontScale(panel: HTMLElement | null): void {
  if (!panel) return;
  panel.style.setProperty("--llm-font-scale", `${panelFontScalePercent / 100}`);
}

function getStringPref(key: string): string {
  const value = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
  return typeof value === "string" ? value : "";
}

function normalizeTemperaturePref(raw: string): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return DEFAULT_TEMPERATURE;
  return Math.min(2, Math.max(0, value));
}

function normalizeMaxTokensPref(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_MAX_TOKENS;
  return Math.min(value, MAX_ALLOWED_TOKENS);
}

function getApiProfiles(): {
  primary: { apiBase: string; apiKey: string; model: string };
  secondary: { apiBase: string; apiKey: string; model: string };
} {
  const primary = {
    apiBase: getStringPref("apiBasePrimary") || getStringPref("apiBase") || "",
    apiKey: getStringPref("apiKeyPrimary") || getStringPref("apiKey") || "",
    model:
      getStringPref("modelPrimary") || getStringPref("model") || "gpt-4o-mini",
  };
  const secondary = {
    apiBase: getStringPref("apiBaseSecondary") || "",
    apiKey: getStringPref("apiKeySecondary") || "",
    model: getStringPref("modelSecondary") || "",
  };
  return {
    primary: {
      apiBase: primary.apiBase.trim(),
      apiKey: primary.apiKey.trim(),
      model: primary.model.trim(),
    },
    secondary: {
      apiBase: secondary.apiBase.trim(),
      apiKey: secondary.apiKey.trim(),
      model: secondary.model.trim(),
    },
  };
}

function getSelectedProfileForItem(itemId: number): {
  key: ModelProfileKey;
  apiBase: string;
  apiKey: string;
  model: string;
} {
  const { primary, secondary } = getApiProfiles();
  const selected = selectedModelCache.get(itemId) || "primary";
  if (selected === "secondary" && secondary.model) {
    return { key: "secondary", ...secondary };
  }
  return { key: "primary", ...primary };
}

function getAdvancedModelParamsForProfile(
  profileKey: ModelProfileKey,
): AdvancedModelParams {
  const suffix = profileKey === "secondary" ? "Secondary" : "Primary";
  return {
    temperature: normalizeTemperaturePref(
      getStringPref(`temperature${suffix}`),
    ),
    maxTokens: normalizeMaxTokensPref(getStringPref(`maxTokens${suffix}`)),
  };
}

function getSelectedReasoningForItem(
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

/** Get/set JSON preferences with error handling */
function getJsonPref(key: string): Record<string, string> {
  const raw =
    (Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as string) || "";
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function setJsonPref(key: string, value: Record<string, string>): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, JSON.stringify(value), true);
}

const getShortcutOverrides = () => getJsonPref("shortcuts");
const setShortcutOverrides = (v: Record<string, string>) =>
  setJsonPref("shortcuts", v);
const getShortcutLabelOverrides = () => getJsonPref("shortcutLabels");
const setShortcutLabelOverrides = (v: Record<string, string>) =>
  setJsonPref("shortcutLabels", v);
const getDeletedShortcutIds = () => getStringArrayPref("shortcutDeleted");
const setDeletedShortcutIds = (v: string[]) =>
  setStringArrayPref("shortcutDeleted", v);
const getCustomShortcuts = () => getCustomShortcutsPref("customShortcuts");
const setCustomShortcuts = (v: CustomShortcut[]) =>
  setCustomShortcutsPref("customShortcuts", v);
const getShortcutOrder = () => getStringArrayPref("shortcutOrder");
const setShortcutOrder = (v: string[]) =>
  setStringArrayPref("shortcutOrder", v);

function getStringArrayPref(key: string): string[] {
  const raw =
    (Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as string) || "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function setStringArrayPref(key: string, value: string[]): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, JSON.stringify(value), true);
}

function getCustomShortcutsPref(key: string): CustomShortcut[] {
  const raw =
    (Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as string) || "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const shortcuts: CustomShortcut[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const id =
        typeof (entry as any).id === "string" ? (entry as any).id.trim() : "";
      const label =
        typeof (entry as any).label === "string"
          ? (entry as any).label.trim()
          : "";
      const prompt =
        typeof (entry as any).prompt === "string"
          ? (entry as any).prompt.trim()
          : "";
      if (!id || !prompt) continue;
      shortcuts.push({
        id,
        label: label || "Custom Shortcut",
        prompt,
      });
    }
    return shortcuts;
  } catch {
    return [];
  }
}

function setCustomShortcutsPref(key: string, value: CustomShortcut[]): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, JSON.stringify(value), true);
}

function createCustomShortcutId(): string {
  const token = Math.random().toString(36).slice(2, 8);
  return `${CUSTOM_SHORTCUT_ID_PREFIX}-${Date.now()}-${token}`;
}

function resetShortcutsToDefault(): void {
  setShortcutOverrides({});
  setShortcutLabelOverrides({});
  setDeletedShortcutIds([]);
  setCustomShortcuts([]);
  setShortcutOrder([]);
}

async function loadShortcutText(file: string): Promise<string> {
  if (shortcutTextCache.has(file)) {
    return shortcutTextCache.get(file)!;
  }
  const uri = `chrome://${config.addonRef}/content/shortcuts/${file}`;
  const fetchFn = ztoolkit.getGlobal("fetch") as typeof fetch;
  const res = await fetchFn(uri);
  if (!res.ok) {
    throw new Error(`Failed to load ${file}`);
  }
  const text = await res.text();
  shortcutTextCache.set(file, text);
  return text;
}

async function renderShortcuts(body: Element, item?: Zotero.Item | null) {
  shortcutRenderItemState.set(body, item);
  const container = body.querySelector(
    "#llm-shortcuts",
  ) as HTMLDivElement | null;
  const menu = body.querySelector(
    "#llm-shortcut-menu",
  ) as HTMLDivElement | null;
  const menuEdit = body.querySelector(
    "#llm-shortcut-menu-edit",
  ) as HTMLButtonElement | null;
  const menuDelete = body.querySelector(
    "#llm-shortcut-menu-delete",
  ) as HTMLButtonElement | null;
  const menuAdd = body.querySelector(
    "#llm-shortcut-menu-add",
  ) as HTMLButtonElement | null;
  const menuMove = body.querySelector(
    "#llm-shortcut-menu-move",
  ) as HTMLButtonElement | null;
  const menuReset = body.querySelector(
    "#llm-shortcut-menu-reset",
  ) as HTMLButtonElement | null;
  if (!container) return;

  const moveMode = shortcutMoveModeState.get(body) === true;
  container.innerHTML = "";
  const overrides = getShortcutOverrides();
  const labelOverrides = getShortcutLabelOverrides();
  const deletedIds = new Set(getDeletedShortcutIds());
  const builtins = BUILTIN_SHORTCUT_FILES.filter(
    (shortcut) => !deletedIds.has(shortcut.id),
  );
  const customShortcuts = getCustomShortcuts();

  const availableCustomSlots = Math.max(
    0,
    MAX_EDITABLE_SHORTCUTS - builtins.length,
  );
  const visibleCustomShortcuts = customShortcuts.slice(0, availableCustomSlots);
  const editableShortcutsRaw: Array<{
    id: string;
    kind: "builtin" | "custom";
    prompt: string;
    label: string;
    defaultLabel: string;
  }> = [];

  for (const shortcut of builtins) {
    let promptText = (overrides[shortcut.id] || "").trim();
    if (!promptText) {
      try {
        promptText = (await loadShortcutText(shortcut.file)).trim();
      } catch {
        promptText = "";
      }
    }
    const labelText = (labelOverrides[shortcut.id] || shortcut.label).trim();
    editableShortcutsRaw.push({
      id: shortcut.id,
      kind: "builtin",
      prompt: promptText,
      label: labelText || shortcut.label,
      defaultLabel: shortcut.label,
    });
  }

  for (const shortcut of visibleCustomShortcuts) {
    const label = shortcut.label.trim() || "Custom Shortcut";
    editableShortcutsRaw.push({
      id: shortcut.id,
      kind: "custom",
      prompt: shortcut.prompt.trim(),
      label,
      defaultLabel: label,
    });
  }
  const currentVisibleIds = editableShortcutsRaw.map((shortcut) => shortcut.id);
  const currentVisibleSet = new Set(currentVisibleIds);
  const savedOrder = getShortcutOrder();
  const normalizedOrder = [
    ...savedOrder.filter((id) => currentVisibleSet.has(id)),
    ...currentVisibleIds.filter((id) => !savedOrder.includes(id)),
  ];
  if (
    normalizedOrder.length !== savedOrder.length ||
    normalizedOrder.some((id, index) => id !== savedOrder[index])
  ) {
    setShortcutOrder(normalizedOrder);
  }
  const orderIndex = new Map(
    normalizedOrder.map((shortcutId, index) => [shortcutId, index]),
  );
  const editableShortcuts = editableShortcutsRaw.sort(
    (a, b) =>
      (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  const orderedEditableIds = editableShortcuts.map((shortcut) => shortcut.id);
  const canAddShortcut = editableShortcuts.length < MAX_EDITABLE_SHORTCUTS;
  let draggingShortcutId = "";
  let draggingButton: HTMLButtonElement | null = null;

  const setMoveMode = async (next: boolean) => {
    shortcutMoveModeState.set(body, next);
    await renderShortcuts(body, item);
  };

  const removeShortcut = async (
    shortcutId: string,
    kind: "builtin" | "custom",
  ) => {
    if (kind === "custom") {
      const nextCustomShortcuts = getCustomShortcuts().filter(
        (shortcut) => shortcut.id !== shortcutId,
      );
      setCustomShortcuts(nextCustomShortcuts);
    } else {
      const nextDeletedIds = new Set(getDeletedShortcutIds());
      nextDeletedIds.add(shortcutId);
      setDeletedShortcutIds(Array.from(nextDeletedIds));

      const nextOverrides = getShortcutOverrides();
      delete nextOverrides[shortcutId];
      setShortcutOverrides(nextOverrides);

      const nextLabelOverrides = getShortcutLabelOverrides();
      delete nextLabelOverrides[shortcutId];
      setShortcutLabelOverrides(nextLabelOverrides);
    }

    const nextOrder = getShortcutOrder().filter((id) => id !== shortcutId);
    setShortcutOrder(nextOrder);
    await renderShortcuts(body, item);
  };

  const addShortcut = async () => {
    const updated = await openShortcutEditDialog("", "", "Add Shortcut");
    if (!updated) return;

    const prompt = updated.prompt.trim();
    if (!prompt) {
      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (status) setStatus(status, "Shortcut prompt cannot be empty", "error");
      return;
    }

    const currentDeleted = new Set(getDeletedShortcutIds());
    const visibleBuiltinCount = BUILTIN_SHORTCUT_FILES.filter(
      (shortcut) => !currentDeleted.has(shortcut.id),
    ).length;
    const currentCustomShortcuts = getCustomShortcuts();
    if (
      visibleBuiltinCount + currentCustomShortcuts.length >=
      MAX_EDITABLE_SHORTCUTS
    ) {
      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (status) {
        setStatus(
          status,
          `Maximum ${MAX_EDITABLE_SHORTCUTS} editable shortcuts allowed`,
          "error",
        );
      }
      return;
    }

    const nextCustomShortcut: CustomShortcut = {
      id: createCustomShortcutId(),
      label: updated.label.trim() || "Custom Shortcut",
      prompt,
    };
    const nextCustomShortcuts = [...currentCustomShortcuts, nextCustomShortcut];
    setCustomShortcuts(nextCustomShortcuts);
    const currentOrder = getShortcutOrder().filter((id) =>
      currentVisibleSet.has(id),
    );
    setShortcutOrder([...currentOrder, nextCustomShortcut.id]);
    await renderShortcuts(body, item);
  };

  const positionShortcutMenu = (x: number, y: number) => {
    if (!menu) return;
    const win = body.ownerDocument?.defaultView;
    if (!win) return;

    const viewportMargin = 8;
    menu.style.position = "fixed";
    menu.style.display = "grid";
    menu.style.visibility = "hidden";
    menu.style.maxHeight = `${Math.max(120, win.innerHeight - viewportMargin * 2)}px`;
    menu.style.overflowY = "auto";

    const menuRect = menu.getBoundingClientRect();
    const maxLeft = win.innerWidth - menuRect.width - viewportMargin;
    const maxTop = win.innerHeight - menuRect.height - viewportMargin;
    const left = Math.min(
      Math.max(viewportMargin, x),
      Math.max(viewportMargin, maxLeft),
    );
    const top = Math.min(
      Math.max(viewportMargin, y),
      Math.max(viewportMargin, maxTop),
    );

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = "visible";
  };

  const openMenuForShortcut = (
    event: MouseEvent,
    shortcutId: string,
    shortcutKind: "builtin" | "custom",
  ) => {
    if (
      !menu ||
      !menuEdit ||
      !menuDelete ||
      !menuAdd ||
      !menuMove ||
      !menuReset
    ) {
      return;
    }
    menu.dataset.menuKind = "shortcut";
    menu.dataset.shortcutId = shortcutId;
    menu.dataset.shortcutKind = shortcutKind;
    menuEdit.style.display = "flex";
    menuDelete.style.display = "flex";
    menuAdd.style.display = "none";
    menuMove.style.display = "none";
    menuReset.style.display = "none";
    menu.style.display = "grid";
    positionShortcutMenu(event.clientX + 4, event.clientY + 4);
  };

  const openMenuForPanel = (event: MouseEvent) => {
    if (
      !menu ||
      !menuEdit ||
      !menuDelete ||
      !menuAdd ||
      !menuMove ||
      !menuReset
    ) {
      return;
    }
    menu.dataset.menuKind = "panel";
    menu.dataset.shortcutId = "";
    menu.dataset.shortcutKind = "";
    menuEdit.style.display = "none";
    menuDelete.style.display = "none";
    menuAdd.style.display = "flex";
    menuMove.style.display = "flex";
    menuReset.style.display = "flex";
    menuAdd.disabled = !canAddShortcut;
    menuMove.disabled = orderedEditableIds.length < 2;
    menu.style.display = "grid";
    positionShortcutMenu(event.clientX + 4, event.clientY + 4);
  };

  for (const shortcut of editableShortcuts) {
    const btn = body.ownerDocument!.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    btn.className = "llm-shortcut-btn";
    btn.type = "button";
    btn.textContent = "";
    btn.dataset.shortcutId = shortcut.id;
    btn.dataset.shortcutKind = shortcut.kind;
    btn.dataset.prompt = shortcut.prompt;
    btn.dataset.label = shortcut.label;
    btn.dataset.defaultLabel = shortcut.defaultLabel;
    btn.disabled = !moveMode && (!item || !shortcut.prompt);
    btn.draggable = moveMode;
    if (moveMode) btn.classList.add("llm-shortcut-move-mode");

    if (moveMode) {
      const handle = body.ownerDocument!.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "span",
      ) as HTMLSpanElement;
      handle.className = "llm-shortcut-drag-handle";
      handle.textContent = "≡";
      handle.title = "Drag to reorder";
      handle.draggable = false;
      handle.addEventListener("click", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.appendChild(handle);
    }

    const label = body.ownerDocument!.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLSpanElement;
    label.className = "llm-shortcut-label";
    label.textContent = shortcut.label;
    btn.appendChild(label);

    container.appendChild(btn);
  }

  const getShortcutButtonFromEventTarget = (
    target: EventTarget | null,
  ): HTMLButtonElement | null => {
    const node = target as Node | null;
    if (!node || typeof node !== "object") return null;
    let element: Element | null = null;
    if ((node as any).nodeType === 1) {
      element = node as unknown as Element;
    } else if ((node as any).nodeType === 3) {
      element = (node as any).parentElement || null;
    }
    if (!element || typeof (element as any).closest !== "function") return null;
    const btn = element.closest(
      ".llm-shortcut-btn",
    ) as HTMLButtonElement | null;
    if (!btn || !container.contains(btn)) return null;
    return btn;
  };

  container.onclick = (e: Event) => {
    const mouseEvent = e as MouseEvent;
    const btn = getShortcutButtonFromEventTarget(mouseEvent.target);
    if (!btn) return;
    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
    const shortcutId = btn.dataset.shortcutId || "";
    if (!shortcutId || moveMode || !item) return;
    const nextPrompt = (btn.dataset.prompt || "").trim();
    if (!nextPrompt) return;
    sendQuestion(body, item, nextPrompt);
  };

  container.oncontextmenu = (e: Event) => {
    const mouseEvent = e as MouseEvent;
    const btn = getShortcutButtonFromEventTarget(mouseEvent.target);
    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
    if (!btn) {
      openMenuForPanel(mouseEvent);
      return;
    }
    const shortcutId = btn.dataset.shortcutId || "";
    const shortcutKind = btn.dataset.shortcutKind || "";
    if (
      shortcutId &&
      (shortcutKind === "builtin" || shortcutKind === "custom")
    ) {
      openMenuForShortcut(mouseEvent, shortcutId, shortcutKind);
    }
  };

  container.ondragstart = (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    if (!btn) return;
    const shortcutId = btn.dataset.shortcutId || "";
    if (!shortcutId) {
      dragEvent.preventDefault();
      return;
    }
    draggingShortcutId = shortcutId;
    draggingButton = btn;
    btn.classList.add("llm-shortcut-dragging");
    if (dragEvent.dataTransfer) {
      dragEvent.dataTransfer.effectAllowed = "move";
      dragEvent.dataTransfer.setData("text/plain", shortcutId);
      const rect = btn.getBoundingClientRect();
      dragEvent.dataTransfer.setDragImage(
        btn,
        Math.floor(rect.width / 2),
        Math.floor(rect.height / 2),
      );
    }
  };

  container.ondragenter = (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    dragEvent.preventDefault();
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    if (!btn) return;
    const targetId = btn.dataset.shortcutId || "";
    if (!draggingShortcutId || !targetId || draggingShortcutId === targetId) {
      return;
    }
    btn.classList.add("llm-shortcut-drop-target");
  };

  container.ondragover = (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    dragEvent.preventDefault();
    if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "move";
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    if (!btn) return;
    const targetId = btn.dataset.shortcutId || "";
    if (!draggingShortcutId || !targetId || draggingShortcutId === targetId) {
      return;
    }
    btn.classList.add("llm-shortcut-drop-target");
  };

  container.ondragleave = (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    btn?.classList.remove("llm-shortcut-drop-target");
  };

  container.ondrop = async (e: Event) => {
    const dragEvent = e as DragEvent;
    if (!moveMode) return;
    dragEvent.preventDefault();
    const btn = getShortcutButtonFromEventTarget(dragEvent.target);
    if (!btn) return;
    btn.classList.remove("llm-shortcut-drop-target");
    const targetId = btn.dataset.shortcutId || "";
    if (!targetId || !draggingShortcutId || draggingShortcutId === targetId) {
      return;
    }
    const sourceId =
      draggingShortcutId ||
      (dragEvent.dataTransfer
        ? dragEvent.dataTransfer.getData("text/plain")
        : "");
    if (!sourceId) return;
    const nextOrder = orderedEditableIds.slice();
    const fromIndex = nextOrder.indexOf(sourceId);
    const toIndex = nextOrder.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved);
    setShortcutOrder(nextOrder);
    await renderShortcuts(body, item);
  };

  container.ondragend = () => {
    draggingShortcutId = "";
    if (draggingButton) {
      draggingButton.classList.remove("llm-shortcut-dragging");
      draggingButton = null;
    }
    const highlighted = container.querySelectorAll(".llm-shortcut-drop-target");
    highlighted.forEach((el: Element) =>
      (el as HTMLElement).classList.remove("llm-shortcut-drop-target"),
    );
  };

  if (menu && menuEdit && menuDelete && menuAdd && menuMove && menuReset) {
    menuEdit.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "shortcut") return;
      const shortcutId = menu.dataset.shortcutId || "";
      const shortcutKind = menu.dataset.shortcutKind || "";
      if (!shortcutId || !shortcutKind) return;
      const target = container.querySelector(
        `.llm-shortcut-btn[data-shortcut-id="${shortcutId}"]`,
      ) as HTMLButtonElement | null;
      const currentPrompt = target?.dataset.prompt || "";
      const currentLabel = target?.dataset.label || "";
      const updated = await openShortcutEditDialog(currentLabel, currentPrompt);
      if (!updated) {
        menu.style.display = "none";
        return;
      }
      const nextPrompt = updated.prompt.trim();
      if (!nextPrompt) {
        const status = body.querySelector("#llm-status") as HTMLElement | null;
        if (status)
          setStatus(status, "Shortcut prompt cannot be empty", "error");
        menu.style.display = "none";
        return;
      }
      const nextLabel = updated.label.trim();

      if (shortcutKind === "custom") {
        const nextCustomShortcuts = getCustomShortcuts().map((shortcut) =>
          shortcut.id === shortcutId
            ? {
                ...shortcut,
                label: nextLabel || shortcut.label || "Custom Shortcut",
                prompt: nextPrompt,
              }
            : shortcut,
        );
        setCustomShortcuts(nextCustomShortcuts);
      } else {
        const nextOverrides = getShortcutOverrides();
        nextOverrides[shortcutId] = nextPrompt;
        setShortcutOverrides(nextOverrides);

        const nextLabelOverrides = getShortcutLabelOverrides();
        if (nextLabel) {
          nextLabelOverrides[shortcutId] = nextLabel;
        } else {
          delete nextLabelOverrides[shortcutId];
        }
        setShortcutLabelOverrides(nextLabelOverrides);
      }

      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
      await renderShortcuts(body, item);
    };

    menuDelete.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "shortcut") return;
      const shortcutId = menu.dataset.shortcutId || "";
      const shortcutKind = menu.dataset.shortcutKind || "";
      if (
        !shortcutId ||
        (shortcutKind !== "builtin" && shortcutKind !== "custom")
      ) {
        return;
      }
      await removeShortcut(shortcutId, shortcutKind);
      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
    };

    menuAdd.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "panel" || menuAdd.disabled) return;
      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
      await addShortcut();
    };

    menuMove.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "panel" || menuMove.disabled) return;
      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
      const next = shortcutMoveModeState.get(body) !== true;
      await setMoveMode(next);
    };

    menuReset.onclick = async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu.dataset.menuKind !== "panel") return;
      const shouldReset = await openResetShortcutsDialog();
      if (!shouldReset) {
        menu.style.display = "none";
        menu.dataset.menuKind = "";
        menu.dataset.shortcutId = "";
        menu.dataset.shortcutKind = "";
        return;
      }
      resetShortcutsToDefault();
      shortcutMoveModeState.set(body, false);
      menu.style.display = "none";
      menu.dataset.menuKind = "";
      menu.dataset.shortcutId = "";
      menu.dataset.shortcutKind = "";
      await renderShortcuts(body, item);
    };

    const bodyEl = body as HTMLElement;
    if (!bodyEl.dataset.llmShortcutBodyClickAttached) {
      bodyEl.dataset.llmShortcutBodyClickAttached = "true";
      body.addEventListener("click", (e: Event) => {
        const target = e.target as Node | null;
        const targetEl = target as Element | null;
        const clickedShortcutButton = Boolean(
          targetEl?.closest(".llm-shortcut-btn"),
        );
        menu.style.display = "none";
        menu.dataset.menuKind = "";
        menu.dataset.shortcutId = "";
        menu.dataset.shortcutKind = "";
        if (
          shortcutMoveModeState.get(body) === true &&
          !clickedShortcutButton
        ) {
          shortcutMoveModeState.set(body, false);
          const latestItem = shortcutRenderItemState.get(body);
          void renderShortcuts(body, latestItem);
        }
        if (shortcutMoveModeState.get(body) === true && !target) {
          shortcutMoveModeState.set(body, false);
          const latestItem = shortcutRenderItemState.get(body);
          void renderShortcuts(body, latestItem);
        }
      });
    }

    const ownerDoc = body.ownerDocument;
    if (ownerDoc && !shortcutEscapeListenerAttached.has(ownerDoc)) {
      shortcutEscapeListenerAttached.add(ownerDoc);
      ownerDoc.addEventListener(
        "keydown",
        (e: Event) => {
          const keyEvent = e as KeyboardEvent;
          if (keyEvent.key !== "Escape") return;
          if (shortcutMoveModeState.get(body) !== true) return;
          keyEvent.preventDefault();
          shortcutMoveModeState.set(body, false);
          const latestItem = shortcutRenderItemState.get(body);
          void renderShortcuts(body, latestItem);
        },
        true,
      );
    }
  }
}

async function openShortcutEditDialog(
  initialLabel: string,
  initialPrompt: string,
  dialogTitle = "Edit Shortcut",
): Promise<{ label: string; prompt: string } | null> {
  const dialogData: { [key: string]: any } = {
    labelValue: initialLabel || "",
    promptValue: initialPrompt || "",
    loadCallback: () => {
      return;
    },
    unloadCallback: () => {
      return;
    },
  };

  const dialog = new ztoolkit.Dialog(3, 2)
    .addCell(0, 0, {
      tag: "h2",
      properties: { innerHTML: dialogTitle },
      styles: { margin: "0 0 8px 0" },
    })
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      attributes: { for: "llm-shortcut-label-input" },
      properties: { innerHTML: "Label" },
    })
    .addCell(
      1,
      1,
      {
        tag: "input",
        namespace: "html",
        id: "llm-shortcut-label-input",
        attributes: {
          "data-bind": "labelValue",
          "data-prop": "value",
          type: "text",
        },
        styles: {
          width: "300px",
        },
      },
      false,
    )
    .addCell(2, 0, {
      tag: "label",
      namespace: "html",
      attributes: { for: "llm-shortcut-prompt-input" },
      properties: { innerHTML: "Prompt" },
    })
    .addCell(
      2,
      1,
      {
        tag: "textarea",
        namespace: "html",
        id: "llm-shortcut-prompt-input",
        attributes: {
          "data-bind": "promptValue",
          "data-prop": "value",
          rows: "6",
        },
        styles: {
          width: "300px",
        },
      },
      false,
    )
    .addButton("Save", "save")
    .addButton("Cancel", "cancel")
    .setDialogData(dialogData)
    .open(dialogTitle);

  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  addon.data.dialog = undefined;

  if (dialogData._lastButtonId !== "save") return null;

  return {
    label: dialogData.labelValue || "",
    prompt: dialogData.promptValue || "",
  };
}

async function openResetShortcutsDialog(): Promise<boolean> {
  const dialogData: { [key: string]: any } = {
    loadCallback: () => {
      return;
    },
    unloadCallback: () => {
      return;
    },
  };

  const dialog = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: {
        innerHTML: "Reset all shortcuts to default settings?",
      },
      styles: {
        width: "320px",
        lineHeight: "1.45",
      },
    })
    .addButton("Reset", "reset")
    .addButton("Cancel", "cancel")
    .setDialogData(dialogData)
    .open("Reset Shortcuts");

  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  addon.data.dialog = undefined;
  return dialogData._lastButtonId === "reset";
}

function setupHandlers(body: Element, item?: Zotero.Item | null) {
  // Use querySelector on body to find elements
  const inputBox = body.querySelector(
    "#llm-input",
  ) as HTMLTextAreaElement | null;
  const sendBtn = body.querySelector("#llm-send") as HTMLButtonElement | null;
  const cancelBtn = body.querySelector(
    "#llm-cancel",
  ) as HTMLButtonElement | null;
  const modelBtn = body.querySelector(
    "#llm-model-toggle",
  ) as HTMLButtonElement | null;
  const modelSlot = body.querySelector(
    "#llm-model-dropdown",
  ) as HTMLDivElement | null;
  const modelMenu = body.querySelector(
    "#llm-model-menu",
  ) as HTMLDivElement | null;
  const reasoningBtn = body.querySelector(
    "#llm-reasoning-toggle",
  ) as HTMLButtonElement | null;
  const reasoningSlot = body.querySelector(
    "#llm-reasoning-dropdown",
  ) as HTMLDivElement | null;
  const reasoningMenu = body.querySelector(
    "#llm-reasoning-menu",
  ) as HTMLDivElement | null;
  const actionsRow = body.querySelector(
    ".llm-actions",
  ) as HTMLDivElement | null;
  const actionsLeft = body.querySelector(
    ".llm-actions-left",
  ) as HTMLDivElement | null;
  const actionsRight = body.querySelector(
    ".llm-actions-right",
  ) as HTMLDivElement | null;
  const clearBtn = body.querySelector("#llm-clear") as HTMLButtonElement | null;
  const selectTextBtn = body.querySelector(
    "#llm-select-text",
  ) as HTMLButtonElement | null;
  const screenshotBtn = body.querySelector(
    "#llm-screenshot",
  ) as HTMLButtonElement | null;
  const imagePreview = body.querySelector(
    "#llm-image-preview",
  ) as HTMLDivElement | null;
  const selectedContextClear = body.querySelector(
    "#llm-selected-context-clear",
  ) as HTMLButtonElement | null;
  const previewStrip = body.querySelector(
    "#llm-image-preview-strip",
  ) as HTMLDivElement | null;
  const previewMeta = body.querySelector(
    "#llm-image-preview-meta",
  ) as HTMLDivElement | null;
  const removeImgBtn = body.querySelector(
    "#llm-remove-img",
  ) as HTMLButtonElement | null;
  const responseMenu = body.querySelector(
    "#llm-response-menu",
  ) as HTMLDivElement | null;
  const responseMenuCopyBtn = body.querySelector(
    "#llm-response-menu-copy",
  ) as HTMLButtonElement | null;
  const responseMenuNoteBtn = body.querySelector(
    "#llm-response-menu-note",
  ) as HTMLButtonElement | null;
  const status = body.querySelector("#llm-status") as HTMLElement | null;

  if (!inputBox || !sendBtn) {
    ztoolkit.log("LLM: Could not find input or send button");
    return;
  }

  const panelRoot = body.querySelector("#llm-main") as HTMLDivElement | null;
  if (!panelRoot) {
    ztoolkit.log("LLM: Could not find panel root");
    return;
  }
  panelRoot.tabIndex = 0;
  applyPanelFontScale(panelRoot);
  const MODEL_MENU_OPEN_CLASS = "llm-model-menu-open";
  const REASONING_MENU_OPEN_CLASS = "llm-reasoning-menu-open";
  const setFloatingMenuOpen = (
    menu: HTMLDivElement | null,
    openClass: string,
    isOpen: boolean,
  ) => {
    if (!menu) return;
    if (isOpen) {
      menu.style.display = "grid";
      menu.classList.add(openClass);
      return;
    }
    menu.classList.remove(openClass);
    menu.style.display = "none";
  };
  const isFloatingMenuOpen = (menu: HTMLDivElement | null) =>
    Boolean(menu && menu.style.display !== "none");
  const closeResponseMenu = () => {
    if (responseMenu) responseMenu.style.display = "none";
    responseMenuTarget = null;
  };

  if (responseMenu && responseMenuCopyBtn && responseMenuNoteBtn) {
    if (!responseMenu.dataset.listenerAttached) {
      responseMenu.dataset.listenerAttached = "true";
      responseMenu.addEventListener("mousedown", (e: Event) => {
        e.stopPropagation();
      });
      responseMenu.addEventListener("contextmenu", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      });
      responseMenuCopyBtn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!responseMenuTarget) return;
        await copyNotePayloadToClipboard(
          body,
          responseMenuTarget.noteHtml,
          responseMenuTarget.noteText,
        );
        if (status) setStatus(status, "Copied response", "ready");
        closeResponseMenu();
      });
      responseMenuNoteBtn.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!responseMenuTarget) return;
        try {
          await createNoteFromAssistantText(
            responseMenuTarget.item,
            responseMenuTarget.noteText,
            responseMenuTarget.modelName,
            responseMenuTarget.noteHtml,
          );
          if (status) setStatus(status, "Created a new note", "ready");
        } catch (err) {
          ztoolkit.log("Create note failed:", err);
          if (status) setStatus(status, "Failed to create note", "error");
        } finally {
          closeResponseMenu();
        }
      });
    }
  }

  // Clicking non-interactive panel area gives keyboard focus to the panel.
  panelRoot.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    if (me.button !== 0) return;
    const target = me.target as Element | null;
    if (!target) return;
    const isInteractive = Boolean(
      target.closest(
        "input, textarea, button, select, option, a[href], [contenteditable='true']",
      ),
    );
    if (!isInteractive) {
      panelRoot.focus();
    }
  });

  // Helper to update image preview UI
  const updateImagePreview = () => {
    if (
      !item ||
      !imagePreview ||
      !previewStrip ||
      !previewMeta ||
      !screenshotBtn
    )
      return;
    const ownerDoc = body.ownerDocument;
    if (!ownerDoc) return;
    const selectedImages = selectedImageCache.get(item.id) || [];
    if (selectedImages.length) {
      previewStrip.innerHTML = "";
      for (const [index, imageUrl] of selectedImages.entries()) {
        const thumbItem = createElement(ownerDoc, "div", "llm-preview-item");
        const thumb = createElement(ownerDoc, "img", "llm-preview-img", {
          alt: "Selected screenshot",
        }) as HTMLImageElement;
        thumb.src = imageUrl;
        const removeOneBtn = createElement(
          ownerDoc,
          "button",
          "llm-preview-remove-one",
          {
            type: "button",
            textContent: "×",
            title: `Remove screenshot ${index + 1}`,
          },
        );
        removeOneBtn.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          const currentImages = selectedImageCache.get(item.id) || [];
          if (index < 0 || index >= currentImages.length) return;
          const nextImages = currentImages.filter((_, i) => i !== index);
          if (nextImages.length) {
            selectedImageCache.set(item.id, nextImages);
          } else {
            selectedImageCache.delete(item.id);
          }
          updateImagePreview();
          if (status) {
            setStatus(
              status,
              `Screenshot removed (${nextImages.length}/${MAX_SELECTED_IMAGES})`,
              "ready",
            );
          }
        });
        thumbItem.append(thumb, removeOneBtn);
        previewStrip.appendChild(thumbItem);
      }
      previewMeta.textContent = `${selectedImages.length}/${MAX_SELECTED_IMAGES} screenshot${selectedImages.length > 1 ? "s" : ""}`;
      imagePreview.style.display = "flex";
      screenshotBtn.disabled = selectedImages.length >= MAX_SELECTED_IMAGES;
      screenshotBtn.title =
        selectedImages.length >= MAX_SELECTED_IMAGES
          ? `Max ${MAX_SELECTED_IMAGES} screenshots`
          : `Add screenshot (${selectedImages.length}/${MAX_SELECTED_IMAGES})`;
    } else {
      imagePreview.style.display = "none";
      previewStrip.innerHTML = "";
      previewMeta.textContent = "0 images selected";
      screenshotBtn.disabled = false;
      screenshotBtn.title = "Select figure screenshot";
    }
    applyResponsiveActionButtonsLayout();
  };

  const updateSelectedTextPreview = () => {
    if (!item) return;
    applySelectedTextPreview(body, item.id);
  };

  const getModelChoices = () => {
    const { primary, secondary } = getApiProfiles();
    const normalize = (value: string) =>
      value.trim().replace(/\s+/g, " ").toLowerCase();
    const primaryModel = (primary.model || "default").trim() || "default";
    const secondaryModel = (secondary.model || "").trim();
    const choices: Array<{ key: "primary" | "secondary"; model: string }> = [
      { key: "primary", model: primaryModel },
    ];
    if (
      secondaryModel &&
      normalize(secondaryModel) !== normalize(primaryModel)
    ) {
      choices.push({ key: "secondary", model: secondaryModel });
    }
    return { primary, secondary, choices };
  };

  const getSelectedModelInfo = () => {
    const { choices } = getModelChoices();
    if (!item) {
      return {
        selected: "primary" as const,
        choices,
        currentModel: choices[0]?.model || "default",
      };
    }
    let selected = selectedModelCache.get(item.id) || "primary";
    if (!choices.some((entry) => entry.key === selected)) {
      selected = "primary";
      selectedModelCache.set(item.id, selected);
    }
    const current =
      choices.find((entry) => entry.key === selected) || choices[0];
    return {
      selected,
      choices,
      currentModel: current?.model || "default",
    };
  };

  const setActionButtonLabel = (
    button: HTMLButtonElement | null,
    expandedLabel: string,
    compactLabel: string,
    mode: "icon" | "full",
  ) => {
    if (!button) return;
    const nextLabel = mode === "icon" ? compactLabel : expandedLabel;
    if (button.textContent !== nextLabel) {
      button.textContent = nextLabel;
    }
    button.classList.toggle("llm-action-icon-only", mode === "icon");
  };

  let layoutRetryScheduled = false;
  const applyResponsiveActionButtonsLayout = () => {
    if (!modelBtn) return;
    const modelLabel = modelBtn.dataset.modelLabel || "default";
    const modelCanUseTwoLineWrap =
      [...(modelLabel || "").trim()].length >
      ACTION_LAYOUT_MODEL_WRAP_MIN_CHARS;
    const modelHint = modelBtn.dataset.modelHint || "";
    const reasoningLabel =
      reasoningBtn?.dataset.reasoningLabel ||
      reasoningBtn?.textContent ||
      "Reasoning";
    const reasoningHint = reasoningBtn?.dataset.reasoningHint || "";
    modelBtn.classList.remove("llm-model-btn-collapsed");
    modelSlot?.classList.remove("llm-model-dropdown-collapsed");
    reasoningBtn?.classList.remove("llm-reasoning-btn-collapsed");
    reasoningSlot?.classList.remove("llm-reasoning-dropdown-collapsed");
    modelBtn.textContent = modelLabel;
    modelBtn.title = modelHint;
    if (reasoningBtn) {
      reasoningBtn.textContent = reasoningLabel;
      reasoningBtn.title = reasoningHint;
    }
    if (!actionsLeft) return;
    const immediateAvailableWidth = (() => {
      const rowWidth = actionsRow?.clientWidth || 0;
      if (rowWidth > 0) return rowWidth;
      const leftWidth = actionsLeft.clientWidth || 0;
      if (leftWidth > 0) return leftWidth;
      return panelRoot?.clientWidth || 0;
    })();
    if (immediateAvailableWidth <= 0) {
      const view = body.ownerDocument?.defaultView;
      if (view && !layoutRetryScheduled) {
        layoutRetryScheduled = true;
        view.requestAnimationFrame(() => {
          layoutRetryScheduled = false;
          applyResponsiveActionButtonsLayout();
        });
      }
      return;
    }
    const getComputedSizePx = (
      style: CSSStyleDeclaration | null | undefined,
      property: string,
      fallback = 0,
    ) => {
      if (!style) return fallback;
      const value = Number.parseFloat(style.getPropertyValue(property));
      return Number.isFinite(value) ? value : fallback;
    };
    const textMeasureContext = (() => {
      const canvas = body.ownerDocument?.createElement(
        "canvas",
      ) as HTMLCanvasElement | null;
      return (
        (canvas?.getContext("2d") as CanvasRenderingContext2D | null) || null
      );
    })();
    const measureLabelTextWidth = (
      button: HTMLButtonElement | null,
      label: string,
    ) => {
      if (!button || !label) return 0;
      const view = body.ownerDocument?.defaultView;
      const style = view?.getComputedStyle(button);
      if (textMeasureContext && style) {
        const font =
          style.font && style.font !== ""
            ? style.font
            : `${style.fontWeight || "400"} ${style.fontSize || "12px"} ${style.fontFamily || "sans-serif"}`;
        textMeasureContext.font = font;
        return textMeasureContext.measureText(label).width;
      }
      return label.length * 8;
    };
    const getElementGapPx = (element: HTMLElement | null) => {
      if (!element) return 0;
      const view = body.ownerDocument?.defaultView;
      const style = view?.getComputedStyle(element);
      const columnGap = getComputedSizePx(style, "column-gap", NaN);
      if (Number.isFinite(columnGap)) return columnGap;
      return getComputedSizePx(style, "gap", 0);
    };
    const getButtonNaturalWidth = (
      button: HTMLButtonElement | null,
      label: string,
      maxLines = 1,
    ) => {
      if (!button) return 0;
      const view = body.ownerDocument?.defaultView;
      const style = view?.getComputedStyle(button);
      const textWidth = measureLabelTextWidth(button, label);
      const normalizedMaxLines = Math.max(1, Math.floor(maxLines));
      const wrappedTextWidth =
        normalizedMaxLines > 1
          ? (() => {
              // Keep enough width for the longest segment while allowing
              // balanced two-line wrapping for long model names.
              const segments = label
                .split(/[\s._-]+/g)
                .map((segment) => segment.trim())
                .filter(Boolean);
              const longestSegmentWidth = segments.reduce((max, segment) => {
                return Math.max(max, measureLabelTextWidth(button, segment));
              }, 0);
              return Math.max(
                textWidth / normalizedMaxLines,
                longestSegmentWidth,
              );
            })()
          : textWidth;
      const paddingWidth =
        getComputedSizePx(style, "padding-left") +
        getComputedSizePx(style, "padding-right");
      const borderWidth =
        getComputedSizePx(style, "border-left-width") +
        getComputedSizePx(style, "border-right-width");
      const chevronAllowance =
        button === modelBtn || button === reasoningBtn ? 4 : 0;
      const measuredWidth =
        wrappedTextWidth + paddingWidth + borderWidth + chevronAllowance;
      // Use text-metric width instead of current rendered width so thresholding
      // does not become stricter just because buttons are currently expanded.
      return Math.ceil(measuredWidth);
    };
    const getSlotWidthBounds = (slot: HTMLElement | null) => {
      const view = body.ownerDocument?.defaultView;
      const style = slot ? view?.getComputedStyle(slot) : null;
      const minWidth = getComputedSizePx(style, "min-width", 0);
      const maxRaw = getComputedSizePx(
        style,
        "max-width",
        Number.POSITIVE_INFINITY,
      );
      const maxWidth = Number.isFinite(maxRaw)
        ? maxRaw
        : Number.POSITIVE_INFINITY;
      return { minWidth, maxWidth };
    };
    const getFullSlotRequiredWidth = (
      slot: HTMLElement | null,
      button: HTMLButtonElement | null,
      label: string,
      maxLines = 1,
    ) => {
      if (!button) return 0;
      const naturalWidth = getButtonNaturalWidth(button, label, maxLines);
      if (!slot) return naturalWidth;
      const { minWidth, maxWidth } = getSlotWidthBounds(slot);
      return Math.min(maxWidth, Math.max(minWidth, naturalWidth));
    };
    const getModeRequiredWidth = (
      dropdownMode: DropdownMode,
      contextButtonMode: ContextButtonMode,
      modelWrapMode: ModelWrapMode,
    ) => {
      const getRenderedWidthPx = (
        element: HTMLElement | null,
        fallback: number,
      ) => {
        const width = element?.getBoundingClientRect?.().width || 0;
        return width > 0 ? Math.ceil(width) : fallback;
      };
      const selectTextSlot = selectTextBtn?.parentElement as HTMLElement | null;
      const screenshotSlot = screenshotBtn?.parentElement as HTMLElement | null;
      const leftSlotWidths = [
        contextButtonMode === "full"
          ? getFullSlotRequiredWidth(
              selectTextSlot,
              selectTextBtn,
              SELECT_TEXT_EXPANDED_LABEL,
            )
          : selectTextBtn
            ? getRenderedWidthPx(
                selectTextBtn,
                ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
              )
            : 0,
        contextButtonMode === "full"
          ? getFullSlotRequiredWidth(
              screenshotSlot,
              screenshotBtn,
              SCREENSHOT_EXPANDED_LABEL,
            )
          : screenshotBtn
            ? getRenderedWidthPx(
                screenshotBtn,
                ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX,
              )
            : 0,
        dropdownMode === "full"
          ? getFullSlotRequiredWidth(
              modelSlot,
              modelBtn,
              modelLabel,
              modelWrapMode === "wrap2"
                ? ACTION_LAYOUT_MODEL_FULL_MAX_LINES
                : 1,
            )
          : modelBtn
            ? getRenderedWidthPx(modelBtn, ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX)
            : 0,
        dropdownMode === "full"
          ? getFullSlotRequiredWidth(
              reasoningSlot,
              reasoningBtn,
              reasoningLabel,
            )
          : reasoningBtn
            ? getRenderedWidthPx(
                reasoningBtn,
                ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX,
              )
            : 0,
      ].filter((width) => width > 0);
      const leftGap = getElementGapPx(actionsLeft);
      const leftRequiredWidth =
        leftSlotWidths.reduce((sum, width) => sum + width, 0) +
        Math.max(0, leftSlotWidths.length - 1) * leftGap;
      const rightRequiredWidth =
        actionsRight?.scrollWidth || sendBtn?.scrollWidth || 0;
      const rowGap = getElementGapPx(actionsRow);
      return leftRequiredWidth + rightRequiredWidth + rowGap;
    };
    const getAvailableRowWidth = () => {
      const rowWidth = actionsRow?.clientWidth || 0;
      if (rowWidth > 0) return rowWidth;
      const panelWidth = panelRoot?.clientWidth || 0;
      if (panelWidth > 0) return panelWidth;
      return actionsLeft.clientWidth || 0;
    };
    const doesModeFit = (
      dropdownMode: DropdownMode,
      contextButtonMode: ContextButtonMode,
      modelWrapMode: ModelWrapMode,
    ) => {
      const modeRequiredWidth = getModeRequiredWidth(
        dropdownMode,
        contextButtonMode,
        modelWrapMode,
      );
      const modeBuffer =
        dropdownMode === "full" && contextButtonMode === "full"
          ? ACTION_LAYOUT_FULL_MODE_BUFFER_PX
          : dropdownMode === "full" && contextButtonMode === "icon"
            ? ACTION_LAYOUT_PARTIAL_MODE_BUFFER_PX
            : 0;
      return getAvailableRowWidth() + 1 >= modeRequiredWidth + modeBuffer;
    };

    type DropdownMode = "icon" | "full";
    type ContextButtonMode = "icon" | "full";
    type ModelWrapMode = "single" | "wrap2";

    const applyLayoutModes = (
      dropdownMode: DropdownMode,
      contextButtonMode: ContextButtonMode,
      modelWrapMode: ModelWrapMode,
    ) => {
      setActionButtonLabel(
        selectTextBtn,
        SELECT_TEXT_EXPANDED_LABEL,
        SELECT_TEXT_COMPACT_LABEL,
        contextButtonMode,
      );
      setActionButtonLabel(
        screenshotBtn,
        SCREENSHOT_EXPANDED_LABEL,
        SCREENSHOT_COMPACT_LABEL,
        contextButtonMode,
      );

      modelBtn.classList.remove("llm-model-btn-collapsed");
      modelSlot?.classList.remove("llm-model-dropdown-collapsed");
      reasoningBtn?.classList.remove("llm-reasoning-btn-collapsed");
      reasoningSlot?.classList.remove("llm-reasoning-dropdown-collapsed");
      modelBtn.classList.toggle(
        "llm-model-btn-wrap-2line",
        dropdownMode !== "icon" && modelWrapMode === "wrap2",
      );
      modelBtn.textContent = modelLabel;
      modelBtn.title = modelHint;
      if (reasoningBtn) {
        reasoningBtn.textContent = reasoningLabel;
        reasoningBtn.title = reasoningHint;
      }

      if (dropdownMode !== "icon") return;
      modelBtn.classList.add("llm-model-btn-collapsed");
      modelSlot?.classList.add("llm-model-dropdown-collapsed");
      modelBtn.textContent = "\ud83e\udde0";
      modelBtn.title = modelHint ? `${modelLabel}\n${modelHint}` : modelLabel;
      if (reasoningBtn) {
        reasoningBtn.classList.add("llm-reasoning-btn-collapsed");
        reasoningSlot?.classList.add("llm-reasoning-dropdown-collapsed");
        reasoningBtn.textContent = REASONING_COMPACT_LABEL;
        reasoningBtn.title = reasoningHint
          ? `${reasoningLabel}\n${reasoningHint}`
          : reasoningLabel;
      }
    };

    const layoutHasIssues = (
      currentDropdownMode: DropdownMode,
      currentContextButtonMode: ContextButtonMode,
      currentModelWrapMode: ModelWrapMode,
    ) =>
      !doesModeFit(
        currentDropdownMode,
        currentContextButtonMode,
        currentModelWrapMode,
      );

    const candidateModes: ReadonlyArray<
      [DropdownMode, ContextButtonMode, ModelWrapMode]
    > = modelCanUseTwoLineWrap
      ? [
          ["full", "full", "single"],
          ["full", "icon", "single"],
          ["full", "icon", "wrap2"],
          ["icon", "icon", "single"],
        ]
      : [
          ["full", "full", "single"],
          ["full", "icon", "single"],
          ["icon", "icon", "single"],
        ];
    for (const [
      dropdownMode,
      contextButtonMode,
      modelWrapMode,
    ] of candidateModes) {
      applyLayoutModes(dropdownMode, contextButtonMode, modelWrapMode);
      if (!layoutHasIssues(dropdownMode, contextButtonMode, modelWrapMode)) {
        return;
      }
    }
  };

  const updateModelButton = () => {
    if (!item || !modelBtn) return;
    const { choices, currentModel } = getSelectedModelInfo();
    const hasSecondary = choices.length > 1;
    modelBtn.dataset.modelLabel = `${currentModel || "default"}`;
    modelBtn.dataset.modelHint = hasSecondary
      ? "Click to choose a model"
      : "Only one model is configured";
    modelBtn.disabled = !item;
    applyResponsiveActionButtonsLayout();
  };

  const isPrimaryPointerEvent = (e: Event): boolean => {
    const me = e as MouseEvent;
    return typeof me.button !== "number" || me.button === 0;
  };

  const rebuildModelMenu = () => {
    if (!item || !modelMenu) return;
    const { choices, selected } = getSelectedModelInfo();

    modelMenu.innerHTML = "";
    for (const entry of choices) {
      const isSelected = entry.key === selected;
      const option = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-model-option",
        {
          type: "button",
          textContent: isSelected
            ? `\u2713 ${entry.model || "default"}`
            : entry.model || "default",
        },
      );
      const applyModelSelection = (e: Event) => {
        if (!isPrimaryPointerEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (!item) return;
        selectedModelCache.set(item.id, entry.key);
        setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
        setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
        selectedReasoningCache.set(item.id, "none");
        updateModelButton();
        updateReasoningButton();
      };
      option.addEventListener("pointerdown", applyModelSelection);
      option.addEventListener("click", applyModelSelection);
      modelMenu.appendChild(option);
    }
  };

  const getReasoningLevelDisplayLabel = (
    level: LLMReasoningLevel,
    provider: ReasoningProviderKind,
    modelName: string,
    options: ReasoningOption[],
  ): string => {
    const option = options.find((entry) => entry.level === level);
    if (option?.label) {
      return option.label;
    }
    if (level !== "default") {
      return level;
    }
    // Align UI wording with provider payload semantics in llmClient.ts:
    // - DeepSeek: thinking.type = "enabled"
    // - Kimi: reasoning is model-native (no separate level payload)
    if (provider === "deepseek") {
      return "enabled";
    }
    if (provider === "kimi") {
      return "model";
    }
    // Keep "default" as final fallback when no runtime label is available.
    void modelName;
    return "default";
  };

  const getReasoningState = () => {
    if (!item) {
      return {
        provider: "unsupported" as const,
        currentModel: "",
        options: [] as ReasoningOption[],
        enabledLevels: [] as LLMReasoningLevel[],
        selectedLevel: "none" as ReasoningLevelSelection,
      };
    }
    const { currentModel } = getSelectedModelInfo();
    const selectedProfile = getSelectedProfileForItem(item.id);
    const provider = detectReasoningProvider(currentModel);
    const options = getReasoningOptions(
      provider,
      currentModel,
      selectedProfile.apiBase,
    );
    const enabledLevels = options
      .filter((option) => option.enabled)
      .map((option) => option.level);
    let selectedLevel = selectedReasoningCache.get(item.id) || "none";
    if (enabledLevels.length > 0) {
      if (
        selectedLevel === "none" ||
        !enabledLevels.includes(selectedLevel as LLMReasoningLevel)
      ) {
        selectedLevel = enabledLevels[0];
      }
    } else {
      selectedLevel = "none";
    }
    selectedReasoningCache.set(item.id, selectedLevel);
    return { provider, currentModel, options, enabledLevels, selectedLevel };
  };

  const updateReasoningButton = () => {
    if (!item || !reasoningBtn) return;
    const { provider, currentModel, options, enabledLevels, selectedLevel } =
      getReasoningState();
    const available = enabledLevels.length > 0;
    const active = available && selectedLevel !== "none";
    const reasoningLabel = active
      ? getReasoningLevelDisplayLabel(
          selectedLevel as LLMReasoningLevel,
          provider,
          currentModel,
          options,
        )
      : "Reasoning";
    reasoningBtn.disabled = !item || !available;
    reasoningBtn.classList.toggle("llm-reasoning-btn-unavailable", !available);
    reasoningBtn.classList.toggle("llm-reasoning-btn-active", active);
    reasoningBtn.style.background = "";
    reasoningBtn.style.borderColor = "";
    reasoningBtn.style.color = "";
    const reasoningHint = available
      ? "Click to choose reasoning level"
      : "Reasoning unavailable for current model";
    reasoningBtn.dataset.reasoningLabel = reasoningLabel;
    reasoningBtn.dataset.reasoningHint = reasoningHint;
    applyResponsiveActionButtonsLayout();
  };

  const rebuildReasoningMenu = () => {
    if (!item || !reasoningMenu) return;
    const { provider, currentModel, options, selectedLevel } =
      getReasoningState();
    reasoningMenu.innerHTML = "";
    for (const optionState of options) {
      const level = optionState.level;
      const option = createElement(
        body.ownerDocument as Document,
        "button",
        "llm-reasoning-option",
        {
          type: "button",
          textContent:
            selectedLevel === level
              ? `\u2713 ${getReasoningLevelDisplayLabel(level, provider, currentModel, options)}`
              : getReasoningLevelDisplayLabel(
                  level,
                  provider,
                  currentModel,
                  options,
                ),
        },
      );
      if (optionState.enabled) {
        const applyReasoningSelection = (e: Event) => {
          if (!isPrimaryPointerEvent(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          selectedReasoningCache.set(item.id, level);
          setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
          updateReasoningButton();
        };
        option.addEventListener("pointerdown", applyReasoningSelection);
        option.addEventListener("click", applyReasoningSelection);
      } else {
        option.disabled = true;
        option.classList.add("llm-reasoning-option-disabled");
      }
      reasoningMenu.appendChild(option);
    }
  };

  const syncModelFromPrefs = () => {
    updateModelButton();
    updateReasoningButton();
    if (isFloatingMenuOpen(modelMenu)) {
      rebuildModelMenu();
    }
    if (isFloatingMenuOpen(reasoningMenu)) {
      rebuildReasoningMenu();
    }
  };

  // Initialize image preview state
  updateImagePreview();
  updateSelectedTextPreview();
  syncModelFromPrefs();

  // Preferences can change outside this panel (e.g., settings window).
  // Re-sync model label when the user comes back and interacts.
  body.addEventListener("pointerenter", syncModelFromPrefs);
  body.addEventListener("focusin", syncModelFromPrefs);
  const ResizeObserverCtor = body.ownerDocument?.defaultView?.ResizeObserver;
  if (ResizeObserverCtor && panelRoot && modelBtn) {
    const ro = new ResizeObserverCtor(() => {
      applyResponsiveActionButtonsLayout();
    });
    ro.observe(panelRoot);
    if (actionsRow) ro.observe(actionsRow);
    if (actionsLeft) ro.observe(actionsLeft);
  }

  const getSelectedProfile = () => {
    if (!item) return null;
    const { primary, secondary } = getApiProfiles();
    const { selected } = getSelectedModelInfo();
    if (selected === "secondary" && secondary.model) {
      return { key: "secondary" as const, ...secondary };
    }
    return { key: "primary" as const, ...primary };
  };

  const getAdvancedModelParams = (
    profileKey: ModelProfileKey | undefined,
  ): AdvancedModelParams | undefined => {
    if (!profileKey) return undefined;
    return getAdvancedModelParamsForProfile(profileKey);
  };

  const getSelectedReasoning = (): LLMReasoningConfig | undefined => {
    if (!item) return undefined;
    const { provider, enabledLevels, selectedLevel } = getReasoningState();
    if (provider === "unsupported" || selectedLevel === "none")
      return undefined;
    if (!enabledLevels.includes(selectedLevel as LLMReasoningLevel)) {
      return undefined;
    }
    return { provider, level: selectedLevel as LLMReasoningLevel };
  };

  const doSend = async () => {
    if (!item) return;
    const text = inputBox.value.trim();
    const selectedText = selectedTextCache.get(item.id) || "";
    if (!text && !selectedText) return;
    const composedQuestion = selectedText
      ? buildQuestionWithSelectedText(selectedText, text)
      : text;
    const displayQuestion = selectedText
      ? `[Selected text included]\n${text || "Please explain this selected text."}`
      : text;
    inputBox.value = "";
    const images = (selectedImageCache.get(item.id) || []).slice(
      0,
      MAX_SELECTED_IMAGES,
    );
    // Clear selected images after sending
    selectedImageCache.delete(item.id);
    updateImagePreview();
    if (selectedText) {
      selectedTextCache.delete(item.id);
      updateSelectedTextPreview();
    }
    const selectedProfile = getSelectedProfile();
    const selectedReasoning = getSelectedReasoning();
    const advancedParams = getAdvancedModelParams(selectedProfile?.key);
    await sendQuestion(
      body,
      item,
      composedQuestion,
      images,
      selectedProfile?.model,
      selectedProfile?.apiBase,
      selectedProfile?.apiKey,
      selectedReasoning,
      advancedParams,
      displayQuestion,
    );
  };

  // Send button - use addEventListener
  sendBtn.addEventListener("click", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    doSend();
  });

  // Enter key (Shift+Enter for newline)
  inputBox.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      doSend();
    }
  });

  const panelDoc = body.ownerDocument;
  if (
    panelDoc &&
    !(panelDoc as unknown as { __llmFontScaleShortcut?: boolean })
      .__llmFontScaleShortcut
  ) {
    const isEventWithinActivePanel = (event: Event) => {
      const panel = panelDoc.querySelector("#llm-main") as HTMLElement | null;
      if (!panel) return null;
      const target = event.target as Node | null;
      const activeEl = panelDoc.activeElement;
      const inPanel = Boolean(
        (target && panel.contains(target)) ||
        (activeEl && panel.contains(activeEl)),
      );
      if (!inPanel) return null;
      return panel;
    };

    const applyDelta = (
      event: Event,
      delta: number | null,
      reset: boolean = false,
    ) => {
      if (!reset && delta === null) return;
      const panel = isEventWithinActivePanel(event);
      if (!panel) return;
      panelFontScalePercent = reset
        ? FONT_SCALE_DEFAULT_PERCENT
        : clampNumber(
            panelFontScalePercent + (delta || 0),
            FONT_SCALE_MIN_PERCENT,
            FONT_SCALE_MAX_PERCENT,
          );
      event.preventDefault();
      event.stopPropagation();
      applyPanelFontScale(panel);
    };

    panelDoc.addEventListener(
      "keydown",
      (e: Event) => {
        const ke = e as KeyboardEvent;
        if (!(ke.metaKey || ke.ctrlKey) || ke.altKey) return;

        if (
          ke.key === "+" ||
          ke.key === "=" ||
          ke.code === "Equal" ||
          ke.code === "NumpadAdd"
        ) {
          applyDelta(ke, FONT_SCALE_STEP_PERCENT);
        } else if (
          ke.key === "-" ||
          ke.key === "_" ||
          ke.code === "Minus" ||
          ke.code === "NumpadSubtract"
        ) {
          applyDelta(ke, -FONT_SCALE_STEP_PERCENT);
        } else if (
          ke.key === "0" ||
          ke.code === "Digit0" ||
          ke.code === "Numpad0"
        ) {
          applyDelta(ke, null, true);
        }
      },
      true,
    );

    // Some platforms route Cmd/Ctrl +/- through zoom commands instead of keydown.
    panelDoc.addEventListener(
      "command",
      (e: Event) => {
        const target = e.target as Element | null;
        const commandId = target?.id || "";
        if (
          commandId === "cmd_fullZoomEnlarge" ||
          commandId === "cmd_textZoomEnlarge"
        ) {
          applyDelta(e, FONT_SCALE_STEP_PERCENT);
        } else if (
          commandId === "cmd_fullZoomReduce" ||
          commandId === "cmd_textZoomReduce"
        ) {
          applyDelta(e, -FONT_SCALE_STEP_PERCENT);
        } else if (
          commandId === "cmd_fullZoomReset" ||
          commandId === "cmd_textZoomReset"
        ) {
          applyDelta(e, null, true);
        }
      },
      true,
    );

    (
      panelDoc as unknown as { __llmFontScaleShortcut?: boolean }
    ).__llmFontScaleShortcut = true;
  }

  if (selectTextBtn) {
    let pendingSelectedText = "";
    const cacheSelectionBeforeFocusShift = () => {
      if (!item) return;
      pendingSelectedText = getActiveReaderSelectionText(
        body.ownerDocument as Document,
        item,
      );
    };
    selectTextBtn.addEventListener(
      "pointerdown",
      cacheSelectionBeforeFocusShift,
    );
    selectTextBtn.addEventListener("mousedown", cacheSelectionBeforeFocusShift);
    selectTextBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      const selectedText = pendingSelectedText;
      pendingSelectedText = "";
      includeSelectedTextFromReader(body, item, selectedText);
    });
  }

  // Screenshot button
  if (screenshotBtn) {
    screenshotBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;

      // Get the main Zotero window
      // Try multiple methods to find the correct window
      let mainWindow: Window | null = null;

      // Method 1: Try Zotero.getMainWindow()
      mainWindow = Zotero.getMainWindow();
      ztoolkit.log("Screenshot: Zotero.getMainWindow() =", mainWindow);

      // Method 2: If that doesn't work, try getting top window from our document
      if (!mainWindow) {
        const panelWin = body.ownerDocument?.defaultView;
        mainWindow = panelWin?.top || panelWin || null;
        ztoolkit.log("Screenshot: Using panel's top window");
      }

      if (!mainWindow) {
        ztoolkit.log("Screenshot: No window found");
        return;
      }

      ztoolkit.log(
        "Screenshot: Using window, body exists:",
        !!mainWindow.document.body,
      );
      ztoolkit.log(
        "Screenshot: documentElement exists:",
        !!mainWindow.document.documentElement,
      );

      const status = body.querySelector("#llm-status") as HTMLElement | null;
      const currentImages = selectedImageCache.get(item.id) || [];
      if (currentImages.length >= MAX_SELECTED_IMAGES) {
        if (status) {
          setStatus(
            status,
            `Maximum ${MAX_SELECTED_IMAGES} screenshots allowed`,
            "error",
          );
        }
        updateImagePreview();
        return;
      }
      if (status) setStatus(status, "Select a region...", "sending");

      try {
        ztoolkit.log("Screenshot: Starting capture selection...");
        const dataUrl = await captureScreenshotSelection(mainWindow);
        ztoolkit.log(
          "Screenshot: Capture returned:",
          dataUrl ? "image data" : "null",
        );
        if (dataUrl) {
          const optimized = await optimizeImageDataUrl(mainWindow, dataUrl);
          const existingImages = selectedImageCache.get(item.id) || [];
          const nextImages = [...existingImages, optimized].slice(
            0,
            MAX_SELECTED_IMAGES,
          );
          selectedImageCache.set(item.id, nextImages);
          updateImagePreview();
          if (status) {
            setStatus(
              status,
              `Screenshot captured (${nextImages.length}/${MAX_SELECTED_IMAGES})`,
              "ready",
            );
          }
        } else {
          if (status) setStatus(status, "Selection cancelled", "ready");
        }
      } catch (err) {
        ztoolkit.log("Screenshot selection error:", err);
        if (status) setStatus(status, "Screenshot failed", "error");
      }
    });
  }

  const positionFloatingMenu = (
    menu: HTMLDivElement,
    anchor: HTMLButtonElement,
  ) => {
    const win = body.ownerDocument?.defaultView;
    if (!win) return;

    const viewportMargin = 8;
    const gap = 6;

    menu.style.position = "fixed";
    menu.style.display = "grid";
    menu.style.visibility = "hidden";
    menu.style.maxHeight = `${Math.max(120, win.innerHeight - viewportMargin * 2)}px`;
    menu.style.overflowY = "auto";

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    let left = anchorRect.left;
    const maxLeft = Math.max(
      viewportMargin,
      win.innerWidth - menuRect.width - viewportMargin,
    );
    left = Math.min(Math.max(viewportMargin, left), maxLeft);

    const belowTop = anchorRect.bottom + gap;
    const aboveTop = anchorRect.top - gap - menuRect.height;
    let top = belowTop;

    if (belowTop + menuRect.height > win.innerHeight - viewportMargin) {
      if (aboveTop >= viewportMargin) {
        top = aboveTop;
      } else {
        top = Math.max(
          viewportMargin,
          win.innerHeight - menuRect.height - viewportMargin,
        );
      }
    }

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = "visible";
  };

  const openModelMenu = () => {
    if (!modelMenu || !modelBtn) return;
    closeReasoningMenu();
    updateModelButton();
    rebuildModelMenu();
    if (!modelMenu.childElementCount) {
      closeModelMenu();
      return;
    }
    positionFloatingMenu(modelMenu, modelBtn);
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, true);
  };

  const closeModelMenu = () => {
    setFloatingMenuOpen(modelMenu, MODEL_MENU_OPEN_CLASS, false);
  };

  const openReasoningMenu = () => {
    if (!reasoningMenu || !reasoningBtn) return;
    closeModelMenu();
    updateReasoningButton();
    rebuildReasoningMenu();
    if (!reasoningMenu.childElementCount) {
      closeReasoningMenu();
      return;
    }
    positionFloatingMenu(reasoningMenu, reasoningBtn);
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, true);
  };

  const closeReasoningMenu = () => {
    setFloatingMenuOpen(reasoningMenu, REASONING_MENU_OPEN_CLASS, false);
  };

  if (modelMenu) {
    modelMenu.addEventListener("pointerdown", (e: Event) => {
      e.stopPropagation();
    });
    modelMenu.addEventListener("mousedown", (e: Event) => {
      e.stopPropagation();
    });
  }

  if (reasoningMenu) {
    reasoningMenu.addEventListener("pointerdown", (e: Event) => {
      e.stopPropagation();
    });
    reasoningMenu.addEventListener("mousedown", (e: Event) => {
      e.stopPropagation();
    });
  }

  if (modelBtn) {
    modelBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || !modelMenu) return;
      if (!isFloatingMenuOpen(modelMenu)) {
        openModelMenu();
      } else {
        closeModelMenu();
      }
    });
  }

  if (reasoningBtn) {
    reasoningBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || !reasoningMenu || reasoningBtn.disabled) return;
      if (!isFloatingMenuOpen(reasoningMenu)) {
        openReasoningMenu();
      } else {
        closeReasoningMenu();
      }
    });
  }

  const doc = body.ownerDocument;
  if (
    doc &&
    !(doc as unknown as { __llmModelMenuDismiss?: boolean })
      .__llmModelMenuDismiss
  ) {
    doc.addEventListener("mousedown", (e: Event) => {
      const me = e as MouseEvent;
      const modelMenuEl = doc.querySelector(
        "#llm-model-menu",
      ) as HTMLDivElement | null;
      const modelButtonEl = doc.querySelector(
        "#llm-model-toggle",
      ) as HTMLButtonElement | null;
      const reasoningMenuEl = doc.querySelector(
        "#llm-reasoning-menu",
      ) as HTMLDivElement | null;
      const reasoningButtonEl = doc.querySelector(
        "#llm-reasoning-toggle",
      ) as HTMLButtonElement | null;
      const responseMenuEl = doc.querySelector(
        "#llm-response-menu",
      ) as HTMLDivElement | null;
      const target = e.target as Node | null;
      if (
        modelMenuEl &&
        isFloatingMenuOpen(modelMenuEl) &&
        (!target ||
          (!modelMenuEl.contains(target) && !modelButtonEl?.contains(target)))
      ) {
        setFloatingMenuOpen(modelMenuEl, MODEL_MENU_OPEN_CLASS, false);
      }
      if (
        reasoningMenuEl &&
        isFloatingMenuOpen(reasoningMenuEl) &&
        (!target ||
          (!reasoningMenuEl.contains(target) &&
            !reasoningButtonEl?.contains(target)))
      ) {
        setFloatingMenuOpen(reasoningMenuEl, REASONING_MENU_OPEN_CLASS, false);
      }
      if (
        responseMenuEl &&
        responseMenuEl.style.display !== "none" &&
        me.button === 0 &&
        (!target || !responseMenuEl.contains(target))
      ) {
        responseMenuEl.style.display = "none";
        responseMenuTarget = null;
      }
    });
    (
      doc as unknown as { __llmModelMenuDismiss?: boolean }
    ).__llmModelMenuDismiss = true;
  }

  // Remove image button
  if (removeImgBtn) {
    removeImgBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      selectedImageCache.delete(item.id);
      updateImagePreview();
      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (status) setStatus(status, "Screenshots cleared", "ready");
    });
  }

  if (selectedContextClear) {
    selectedContextClear.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item) return;
      selectedTextCache.delete(item.id);
      updateSelectedTextPreview();
      if (status) setStatus(status, "Selected text removed", "ready");
    });
  }

  // Cancel button
  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (currentAbortController) {
        currentAbortController.abort();
      }
      cancelledRequestId = currentRequestId;
      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (status) setStatus(status, "Cancelled", "ready");
      // Re-enable UI
      if (inputBox) inputBox.disabled = false;
      if (sendBtn) {
        sendBtn.style.display = "";
        sendBtn.disabled = false;
      }
      cancelBtn.style.display = "none";
    });
  }

  // Clear button
  if (clearBtn) {
    clearBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (item) {
        const conversationKey = getConversationKey(item);
        chatHistory.delete(conversationKey);
        loadedConversationKeys.add(conversationKey);
        void clearStoredConversation(conversationKey).catch((err) => {
          ztoolkit.log("LLM: Failed to clear persisted chat history", err);
        });
        selectedImageCache.delete(item.id);
        selectedTextCache.delete(item.id);
        updateImagePreview();
        updateSelectedTextPreview();
        refreshChat(body, item);
        const status = body.querySelector("#llm-status") as HTMLElement | null;
        if (status) setStatus(status, "Cleared", "ready");
      }
    });
  }
}

async function sendQuestion(
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
  currentRequestId++;
  const thisRequestId = currentRequestId;

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
    currentAbortController = AbortControllerCtor
      ? new AbortControllerCtor()
      : null;
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
    currentAbortController = null;
  }
}

function refreshChat(body: Element, item?: Zotero.Item | null) {
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
          if (!responseMenu || !item) return;
          const selectedText = getSelectedTextWithinElement(doc, bubble);
          const selectedHtml = getSelectedHtmlWithinElement(doc, bubble);
          const fallbackText = sanitizeText(msg.text || "").trim();
          const noteText = selectedText || fallbackText;
          const noteHtml = selectedHtml || "";
          if (!noteText) return;
          responseMenuTarget = {
            item,
            noteText,
            noteHtml,
            modelName: msg.modelName?.trim() || "unknown",
          };
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

export function clearConversation(itemId: number) {
  chatHistory.delete(itemId);
  loadedConversationKeys.add(itemId);
  void clearStoredConversation(itemId).catch((err) => {
    ztoolkit.log("LLM: Failed to clear persisted chat history", err);
  });
}

export function getConversationHistory(itemId: number): Message[] {
  return chatHistory.get(itemId) || [];
}
