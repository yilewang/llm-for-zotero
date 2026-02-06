import { getLocaleID } from "../utils/locale";
import { renderMarkdown } from "../utils/markdown";
import {
  callEmbeddings,
  callLLMStream,
  ChatMessage,
  ReasoningConfig as LLMReasoningConfig,
  ReasoningEvent,
  ReasoningLevel as LLMReasoningLevel,
} from "../utils/llmClient";
import { config } from "../../package.json";

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
const HTML_NS = "http://www.w3.org/1999/xhtml";
const AUTO_SCROLL_BOTTOM_THRESHOLD = 64;

const SHORTCUT_FILES = [
  { id: "summarize", label: "Summarize", file: "summarize.txt" },
  { id: "key-points", label: "Key Points", file: "key-points.txt" },
  { id: "methodology", label: "Methodology", file: "methodology.txt" },
  { id: "limitations", label: "Limitations", file: "limitations.txt" },
  { id: "future-work", label: "Future Work", file: "future-work.txt" },
] as const;

// =============================================================================
// Types
// =============================================================================

interface Message {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
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
};

// =============================================================================
// State
// =============================================================================

const chatHistory = new Map<number, Message[]>();
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
const shortcutTextCache = new Map<string, string>();

let currentRequestId = 0;
let cancelledRequestId = -1;
let currentAbortController: AbortController | null = null;

// Screenshot selection state (per item)
const selectedImageCache = new Map<number, string>();

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
  if (/^gpt-5(\b|[.-])/.test(name)) return "openai";
  return "unsupported";
}

function getReasoningOptions(
  provider: ReasoningProviderKind,
  modelName: string,
): ReasoningOption[] {
  if (provider === "openai") {
    return [
      { level: "default", enabled: true },
      { level: "medium", enabled: true },
      { level: "high", enabled: true },
      { level: "xhigh", enabled: true },
    ];
  }
  if (provider === "gemini") {
    const name = modelName.trim().toLowerCase();
    const isGemini3ProFamily =
      name === "gemini-3-pro" ||
      name === "gemini-3-pro-preview" ||
      name.startsWith("gemini-3-pro-preview-") ||
      name.startsWith("gemini-3-pro-");
    return [
      { level: "low", enabled: isGemini3ProFamily },
      { level: "medium", enabled: !isGemini3ProFamily },
      { level: "high", enabled: isGemini3ProFamily },
    ];
  }
  if (provider === "deepseek") {
    return [{ level: "default", enabled: true }];
  }
  if (provider === "kimi") {
    return [{ level: "default", enabled: true }];
  }
  return [];
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
async function captureScreenshotSelection(
  win: Window,
): Promise<string | null> {
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
      ztoolkit.log("Screenshot: Resolving with", value ? "image" : "null", "-", reason);
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
      ztoolkit.log("Screenshot: mousedown, isReady:", isReady, "target:", (e.target as Element)?.tagName);
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
      ztoolkit.log("Screenshot: mouseup, isReady:", isReady, "isSelecting:", isSelecting);
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
        await cachePDFText(item);
      }
      await renderShortcuts(body, item);
      setupHandlers(body, item);
      refreshChat(body, item);
    },
  });
}

function buildUI(body: Element, item?: Zotero.Item | null) {
  body.textContent = "";
  const doc = body.ownerDocument!;
  const hasItem = Boolean(item);
  const iconUrl = `chrome://${config.addonRef}/content/icons/neuron.jpg`;

  // Main container
  const container = createElement(doc, "div", "llm-panel", { id: "llm-main" });

  // Header section
  const header = createElement(doc, "div", "llm-header");
  const headerTop = createElement(doc, "div", "llm-header-top");
  const headerInfo = createElement(doc, "div", "llm-header-info");

  const headerIcon = createElement(doc, "img", "llm-header-icon", {
    alt: "LLM",
    src: iconUrl,
  });
  const title = createElement(doc, "div", "llm-title", {
    textContent: "LLM Assistant",
  });
  const subtitle = createElement(doc, "div", "llm-subtitle", {
    textContent: "Ask questions about your documents",
  });

  headerInfo.append(headerIcon, title, subtitle);
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
  shortcutMenu.appendChild(menuEditBtn);
  container.appendChild(shortcutMenu);

  // Input section
  const inputSection = createElement(doc, "div", "llm-input-section");
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

  const previewImg = createElement(doc, "img", "llm-preview-img", {
    id: "llm-preview-img",
    alt: "Selected screenshot",
  });

  const removeImgBtn = createElement(doc, "button", "llm-remove-img-btn", {
    id: "llm-remove-img",
    textContent: "×",
    title: "Remove image",
  });

  imagePreview.append(previewImg, removeImgBtn);
  inputSection.appendChild(imagePreview);

  // Actions row
  const actionsRow = createElement(doc, "div", "llm-actions");

  // Screenshot button
  const screenshotBtn = createElement(doc, "button", "llm-screenshot-btn", {
    id: "llm-screenshot",
    textContent: "📷 Select Screenshot",
    disabled: !hasItem,
  });

  const modelDropdown = createElement(doc, "div", "llm-model-dropdown", {
    id: "llm-model-dropdown",
  });
  const modelBtn = createElement(doc, "button", "llm-model-btn", {
    id: "llm-model-toggle",
    textContent: "Model: ...",
    disabled: !hasItem,
  });
  const modelMenu = createElement(doc, "div", "llm-model-menu", {
    id: "llm-model-menu",
  });
  modelMenu.style.display = "none";
  modelDropdown.append(modelBtn, modelMenu);

  const reasoningDropdown = createElement(doc, "div", "llm-reasoning-dropdown", {
    id: "llm-reasoning-dropdown",
  });
  const reasoningBtn = createElement(doc, "button", "llm-reasoning-btn", {
    id: "llm-reasoning-toggle",
    textContent: "Reasoning",
    disabled: !hasItem,
  });
  const reasoningMenu = createElement(doc, "div", "llm-reasoning-menu", {
    id: "llm-reasoning-menu",
  });
  reasoningMenu.style.display = "none";
  reasoningDropdown.append(reasoningBtn, reasoningMenu);

  const sendBtn = createElement(doc, "button", "llm-send-btn", {
    id: "llm-send",
    textContent: "Send",
    disabled: !hasItem,
  });
  const cancelBtn = createElement(
    doc,
    "button",
    "llm-send-btn llm-cancel-btn",
    {
      id: "llm-cancel",
      textContent: "Cancel",
    },
  );
  cancelBtn.style.display = "none";

  const statusLine = createElement(doc, "div", "llm-status", {
    id: "llm-status",
    textContent: hasItem ? "Ready" : "Select an item or open a PDF",
  });

  actionsRow.append(
    screenshotBtn,
    modelDropdown,
    reasoningDropdown,
    sendBtn,
    cancelBtn,
    statusLine,
  );
  inputSection.appendChild(actionsRow);
  container.appendChild(inputSection);
  body.appendChild(container);
}

async function cachePDFText(item: Zotero.Item) {
  if (pdfTextCache.has(item.id)) return;

  try {
    let pdfText = "";
    const mainItem =
      item.isAttachment() && item.parentID
        ? Zotero.Items.get(item.parentID)
        : item;

    const title = mainItem?.getField("title") || "";

    let pdfItem: Zotero.Item | null = null;
    if (
      item.isAttachment() &&
      item.attachmentContentType === "application/pdf"
    ) {
      pdfItem = item;
    } else if (mainItem) {
      const attachments = mainItem.getAttachments();
      for (const attId of attachments) {
        const att = Zotero.Items.get(attId);
        if (att && att.attachmentContentType === "application/pdf") {
          pdfItem = att;
          break;
        }
      }
    }

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

function getStringPref(key: string): string {
  const value = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
  return typeof value === "string" ? value : "";
}

function getApiProfiles(): {
  primary: { apiBase: string; apiKey: string; model: string };
  secondary: { apiBase: string; apiKey: string; model: string };
} {
  const primary = {
    apiBase:
      getStringPref("apiBasePrimary") || getStringPref("apiBase") || "",
    apiKey: getStringPref("apiKeyPrimary") || getStringPref("apiKey") || "",
    model:
      getStringPref("modelPrimary") ||
      getStringPref("model") ||
      "gpt-4o-mini",
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
  const container = body.querySelector(
    "#llm-shortcuts",
  ) as HTMLDivElement | null;
  const menu = body.querySelector(
    "#llm-shortcut-menu",
  ) as HTMLDivElement | null;
  const menuEdit = body.querySelector(
    "#llm-shortcut-menu-edit",
  ) as HTMLButtonElement | null;
  if (!container) return;

  container.innerHTML = "";
  const overrides = getShortcutOverrides();
  const labelOverrides = getShortcutLabelOverrides();

  for (const shortcut of SHORTCUT_FILES) {
    let promptText = overrides[shortcut.id];
    if (!promptText) {
      try {
        promptText = (await loadShortcutText(shortcut.file)).trim();
      } catch {
        promptText = "";
      }
    }

    const labelText = labelOverrides[shortcut.id] || shortcut.label;

    const btn = body.ownerDocument!.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    btn.className = "llm-shortcut-btn";
    btn.type = "button";
    btn.textContent = labelText;
    btn.dataset.shortcutId = shortcut.id;
    btn.dataset.prompt = promptText || "";
    btn.dataset.label = labelText;
    btn.disabled = !item || !promptText;

    btn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || !promptText) return;
      sendQuestion(body, item, btn.dataset.prompt || "");
    });

    btn.addEventListener("contextmenu", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!menu) return;
      const evt = e as MouseEvent;
      const panel = body.querySelector("#llm-main") as HTMLElement | null;
      const panelRect = panel?.getBoundingClientRect();
      if (panelRect) {
        menu.style.left = `${evt.clientX - panelRect.left}px`;
        menu.style.top = `${evt.clientY - panelRect.top}px`;
      } else {
        menu.style.left = `${evt.clientX}px`;
        menu.style.top = `${evt.clientY}px`;
      }
      menu.dataset.shortcutId = shortcut.id;
      (menu as any)._target = btn;
      menu.style.display = "block";
    });

    container.appendChild(btn);
  }

  if (menu && menuEdit) {
    if (!menu.dataset.listenerAttached) {
      menu.dataset.listenerAttached = "true";
      menuEdit.addEventListener("click", async (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const shortcutId = menu.dataset.shortcutId || "";
        if (!shortcutId) return;
        const target = (menu as any)._target as HTMLButtonElement | null;
        const currentPrompt = target?.dataset.prompt || "";
        const currentLabel = target?.dataset.label || "";
        const updated = await openShortcutEditDialog(
          currentLabel,
          currentPrompt,
        );
        if (!updated) {
          menu.style.display = "none";
          return;
        }
        const { label: nextLabel, prompt: nextPrompt } = updated;
        const next = nextPrompt.trim();
        const nextOverrides = getShortcutOverrides();
        nextOverrides[shortcutId] = next;
        setShortcutOverrides(nextOverrides);
        const nextLabelOverrides = getShortcutLabelOverrides();
        const labelValue = nextLabel.trim();
        if (labelValue) {
          nextLabelOverrides[shortcutId] = labelValue;
        } else {
          delete nextLabelOverrides[shortcutId];
        }
        setShortcutLabelOverrides(nextLabelOverrides);
        if (target) {
          target.dataset.prompt = next;
          target.disabled = !next;
          target.dataset.label =
            labelValue || target.dataset.label || shortcutId;
          target.textContent = labelValue || target.dataset.label || shortcutId;
        }
        menu.style.display = "none";
      });

      body.addEventListener("click", () => {
        menu.style.display = "none";
        menu.dataset.shortcutId = "";
        (menu as any)._target = null;
      });
    }
  }
}

async function openShortcutEditDialog(
  initialLabel: string,
  initialPrompt: string,
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

  const dialog = new ztoolkit.Dialog(6, 2)
    .addCell(0, 0, {
      tag: "h2",
      properties: { innerHTML: "Edit Shortcut" },
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
    .open("Edit Shortcut");

  addon.data.dialog = dialog;
  await dialogData.unloadLock.promise;
  addon.data.dialog = undefined;

  if (dialogData._lastButtonId !== "save") return null;

  return {
    label: dialogData.labelValue || "",
    prompt: dialogData.promptValue || "",
  };
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
  const modelMenu = body.querySelector(
    "#llm-model-menu",
  ) as HTMLDivElement | null;
  const reasoningBtn = body.querySelector(
    "#llm-reasoning-toggle",
  ) as HTMLButtonElement | null;
  const reasoningMenu = body.querySelector(
    "#llm-reasoning-menu",
  ) as HTMLDivElement | null;
  const clearBtn = body.querySelector("#llm-clear") as HTMLButtonElement | null;
  const screenshotBtn = body.querySelector(
    "#llm-screenshot",
  ) as HTMLButtonElement | null;
  const imagePreview = body.querySelector(
    "#llm-image-preview",
  ) as HTMLDivElement | null;
  const previewImg = body.querySelector(
    "#llm-preview-img",
  ) as HTMLImageElement | null;
  const removeImgBtn = body.querySelector(
    "#llm-remove-img",
  ) as HTMLButtonElement | null;

  if (!inputBox || !sendBtn) {
    ztoolkit.log("LLM: Could not find input or send button");
    return;
  }

  // Helper to update image preview UI
  const updateImagePreview = () => {
    if (!item || !imagePreview || !previewImg || !screenshotBtn) return;
    const selectedImage = selectedImageCache.get(item.id);
    if (selectedImage) {
      previewImg.src = selectedImage;
      imagePreview.style.display = "flex";
      screenshotBtn.disabled = true;
      screenshotBtn.textContent = "📷 Screenshot Selected";
    } else {
      imagePreview.style.display = "none";
      previewImg.src = "";
      screenshotBtn.disabled = false;
      screenshotBtn.textContent = "📷 Select Screenshot";
    }
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

  const updateModelButton = () => {
    if (!item || !modelBtn) return;
    const { choices, currentModel } = getSelectedModelInfo();
    const hasSecondary = choices.length > 1;
    modelBtn.textContent = `${currentModel || "default"}`;
    modelBtn.disabled = !item;
    modelBtn.title = hasSecondary
      ? "Click to choose a model"
      : "Only one model is configured";
  };

  const rebuildModelMenu = () => {
    if (!item || !modelMenu) return;
    const { choices } = getModelChoices();
    const selected = selectedModelCache.get(item.id) || "primary";

    modelMenu.innerHTML = "";
    for (const entry of choices) {
      if (entry.key === selected) continue;
      const option = createElement(
        (body.ownerDocument as Document),
        "button",
        "llm-model-option",
        {
          type: "button",
          textContent: entry.model || "default",
        },
      );
      option.addEventListener("click", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (!item) return;
        selectedModelCache.set(item.id, entry.key);
        modelMenu.classList.remove("llm-model-menu-open");
        modelMenu.style.display = "none";
        if (reasoningMenu) {
          reasoningMenu.classList.remove("llm-reasoning-menu-open");
          reasoningMenu.style.display = "none";
        }
        selectedReasoningCache.set(item.id, "none");
        updateModelButton();
        updateReasoningButton();
      });
      modelMenu.appendChild(option);
    }
  };

  const getReasoningState = () => {
    if (!item) {
      return {
        provider: "unsupported" as const,
        options: [] as ReasoningOption[],
        enabledLevels: [] as LLMReasoningLevel[],
        selectedLevel: "none" as ReasoningLevelSelection,
      };
    }
    const { currentModel } = getSelectedModelInfo();
    const provider = detectReasoningProvider(currentModel);
    const options = getReasoningOptions(provider, currentModel);
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
    return { provider, options, enabledLevels, selectedLevel };
  };

  const updateReasoningButton = () => {
    if (!item || !reasoningBtn) return;
    const { enabledLevels, selectedLevel } = getReasoningState();
    const available = enabledLevels.length > 0;
    const active = available && selectedLevel !== "none";
    reasoningBtn.textContent = active
      ? `Level: ${selectedLevel}`
      : "Reasoning";
    reasoningBtn.disabled = !item || !available;
    reasoningBtn.classList.toggle(
      "llm-reasoning-btn-unavailable",
      !available,
    );
    reasoningBtn.classList.toggle(
      "llm-reasoning-btn-active",
      active,
    );
    // Inline style ensures visible state change even if theme/CSS caching overrides classes.
    if (active) {
      reasoningBtn.style.background = "#2563eb";
      reasoningBtn.style.borderColor = "#2563eb";
      reasoningBtn.style.color = "#fff";
    } else if (!available) {
      reasoningBtn.style.background = "var(--fill-quaternary)";
      reasoningBtn.style.borderColor = "var(--stroke-secondary)";
      reasoningBtn.style.color = "var(--fill-tertiary)";
    } else {
      reasoningBtn.style.background = "";
      reasoningBtn.style.borderColor = "";
      reasoningBtn.style.color = "";
    }
    reasoningBtn.title = available
      ? "Click to choose reasoning level"
      : "Reasoning unavailable for current model";
  };

  const rebuildReasoningMenu = () => {
    if (!item || !reasoningMenu) return;
    const { options, selectedLevel } = getReasoningState();
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
            selectedLevel === level ? `\u2713 ${level}` : level,
        },
      );
      if (optionState.enabled) {
        option.addEventListener("click", (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          if (!item) return;
          selectedReasoningCache.set(item.id, level);
          reasoningMenu.classList.remove("llm-reasoning-menu-open");
          reasoningMenu.style.display = "none";
          updateReasoningButton();
        });
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
    if (modelMenu && modelMenu.style.display !== "none") {
      rebuildModelMenu();
    }
    if (reasoningMenu && reasoningMenu.style.display !== "none") {
      rebuildReasoningMenu();
    }
  };

  // Initialize image preview state
  updateImagePreview();
  syncModelFromPrefs();

  // Preferences can change outside this panel (e.g., settings window).
  // Re-sync model label when the user comes back and interacts.
  body.addEventListener("pointerenter", syncModelFromPrefs);
  body.addEventListener("focusin", syncModelFromPrefs);

  const getSelectedProfile = () => {
    if (!item) return null;
    const { primary, secondary } = getApiProfiles();
    const { selected } = getSelectedModelInfo();
    if (selected === "secondary" && secondary.model) {
      return { key: "secondary" as const, ...secondary };
    }
    return { key: "primary" as const, ...primary };
  };

  const getSelectedReasoning = (): LLMReasoningConfig | undefined => {
    if (!item) return undefined;
    const { provider, enabledLevels, selectedLevel } = getReasoningState();
    if (provider === "unsupported" || selectedLevel === "none") return undefined;
    if (!enabledLevels.includes(selectedLevel as LLMReasoningLevel)) {
      return undefined;
    }
    return { provider, level: selectedLevel as LLMReasoningLevel };
  };

  const doSend = async () => {
    if (!item) return;
    const text = inputBox.value.trim();
    if (!text) return;
    inputBox.value = "";
    const image = selectedImageCache.get(item.id);
    // Clear the selected image after sending
    selectedImageCache.delete(item.id);
    updateImagePreview();
    const selectedProfile = getSelectedProfile();
    const selectedReasoning = getSelectedReasoning();
    await sendQuestion(
      body,
      item,
      text,
      image,
      selectedProfile?.model,
      selectedProfile?.apiBase,
      selectedProfile?.apiKey,
      selectedReasoning,
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

      ztoolkit.log("Screenshot: Using window, body exists:", !!mainWindow.document.body);
      ztoolkit.log("Screenshot: documentElement exists:", !!mainWindow.document.documentElement);

      const status = body.querySelector("#llm-status") as HTMLElement | null;
      if (status) setStatus(status, "Select a region...", "sending");

      try {
        ztoolkit.log("Screenshot: Starting capture selection...");
        const dataUrl = await captureScreenshotSelection(mainWindow);
        ztoolkit.log("Screenshot: Capture returned:", dataUrl ? "image data" : "null");
        if (dataUrl) {
          const optimized = await optimizeImageDataUrl(mainWindow, dataUrl);
          selectedImageCache.set(item.id, optimized);
          updateImagePreview();
          if (status) setStatus(status, "Screenshot captured", "ready");
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
    modelMenu.classList.add("llm-model-menu-open");
  };

  const closeModelMenu = () => {
    if (!modelMenu) return;
    modelMenu.classList.remove("llm-model-menu-open");
    modelMenu.style.display = "none";
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
    reasoningMenu.classList.add("llm-reasoning-menu-open");
  };

  const closeReasoningMenu = () => {
    if (!reasoningMenu) return;
    reasoningMenu.classList.remove("llm-reasoning-menu-open");
    reasoningMenu.style.display = "none";
  };

  if (modelBtn) {
    modelBtn.addEventListener("click", (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item || !modelMenu) return;
      if (modelMenu.style.display === "none") {
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
      if (reasoningMenu.style.display === "none") {
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
    doc.addEventListener("click", (e: Event) => {
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
      const target = e.target as Node | null;
      if (
        modelMenuEl &&
        modelMenuEl.style.display !== "none" &&
        (!target ||
          (!modelMenuEl.contains(target) && !modelButtonEl?.contains(target)))
      ) {
        modelMenuEl.classList.remove("llm-model-menu-open");
        modelMenuEl.style.display = "none";
      }
      if (
        reasoningMenuEl &&
        reasoningMenuEl.style.display !== "none" &&
        (!target ||
          (!reasoningMenuEl.contains(target) &&
            !reasoningButtonEl?.contains(target)))
      ) {
        reasoningMenuEl.classList.remove("llm-reasoning-menu-open");
        reasoningMenuEl.style.display = "none";
      }
    });
    (doc as unknown as { __llmModelMenuDismiss?: boolean }).__llmModelMenuDismiss =
      true;
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
      if (status) setStatus(status, "Image removed", "ready");
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
        chatHistory.delete(item.id);
        selectedImageCache.delete(item.id);
        updateImagePreview();
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
  image?: string,
  model?: string,
  apiBase?: string,
  apiKey?: string,
  reasoning?: LLMReasoningConfig,
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
  if (status) {
    const statusText = image ? "Analyzing image..." : "Thinking...";
    setStatus(status, statusText, "sending");
  }

  // Add user message (include indicator if image was attached)
  if (!chatHistory.has(item.id)) {
    chatHistory.set(item.id, []);
  }
  const history = chatHistory.get(item.id)!;
  const historyForLLM = history.slice(-MAX_HISTORY_MESSAGES);
  const userMessageText = image ? `${question}\n[📷 Image attached]` : question;
  history.push({ role: "user", text: userMessageText, timestamp: Date.now() });
  const assistantMessage: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    streaming: true,
  };
  history.push(assistantMessage);
  if (history.length > MAX_HISTORY_MESSAGES * 2) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES * 2);
  }
  refreshChat(body, item);

  try {
    const pdfContext = await buildContext(
      pdfTextCache.get(item.id),
      question,
      Boolean(image),
      { apiBase, apiKey },
    );
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
        image: image,
        model: model,
        apiBase: apiBase,
        apiKey: apiKey,
        reasoning,
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

    if (cancelledRequestId >= thisRequestId) {
      return;
    }

    assistantMessage.text =
      sanitizeText(answer) || assistantMessage.text || "No response.";
    assistantMessage.streaming = false;
    refreshChat(body, item);

    if (status) setStatus(status, "Ready", "ready");
  } catch (err) {
    if (cancelledRequestId >= thisRequestId) {
      return;
    }

    const errMsg = (err as Error).message || "Error";
    assistantMessage.text = `Error: ${errMsg}`;
    assistantMessage.streaming = false;
    refreshChat(body, item);

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
  const shouldStickToBottom = distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD;

  if (!item) {
    chatBox.innerHTML = `
      <div class="llm-welcome">
        <div class="llm-welcome-icon">📄</div>
        <div class="llm-welcome-text">Select an item or open a PDF to start.</div>
      </div>
    `;
    return;
  }

  const history = chatHistory.get(item.id) || [];

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
          const next = !Boolean(msg.reasoningOpen);
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
}

export function getConversationHistory(itemId: number): Message[] {
  return chatHistory.get(itemId) || [];
}
