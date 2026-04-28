import { config } from "../../../package.json";
import { t } from "../../utils/i18n";
import { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";

// =============================================================================
// Constants
// =============================================================================

export const PANE_ID = "llm-context-panel";
export const PREFERENCES_PANE_ID = `${config.addonRef}-preferences`;
export const CHUNK_TARGET_LENGTH = 2000;
export const CHUNK_OVERLAP = 200;
export const EMBEDDING_BATCH_SIZE = 16;
export const RRF_K = 60;
export const RETRIEVAL_TOP_K_PER_PAPER = 24;
export const RETRIEVAL_MMR_LAMBDA = 0.7;
export const RETRIEVAL_MIN_ACTIVE_PAPER_CHUNKS = 2;
export const RETRIEVAL_MIN_OTHER_PAPER_CHUNKS = 1;
export const PAPER_FOLLOWUP_RETRIEVAL_MIN_CHUNKS = 2;
export const PAPER_FOLLOWUP_RETRIEVAL_MAX_CHUNKS = 5;
export const COLLECTION_RETRIEVAL_MAX_PAPERS = 50;
export const COLLECTION_RETRIEVAL_MIN_SCORE_FALLBACK_PAPERS = 10;
export const PERSISTED_HISTORY_LIMIT = 200;
export const AUTO_SCROLL_BOTTOM_THRESHOLD = 64;
export const FONT_SCALE_DEFAULT_PERCENT = 120;
export const FONT_SCALE_MIN_PERCENT = 80;
export const FONT_SCALE_MAX_PERCENT = 180;
export const FONT_SCALE_STEP_PERCENT = 10;
export const SELECTED_TEXT_MAX_LENGTH = 4000;
export const SELECTED_TEXT_PREVIEW_LENGTH = 240;
export const MAX_SELECTED_TEXT_CONTEXTS = 5;
export const MAX_EDITABLE_SHORTCUTS = 10;
export const MAX_SELECTED_IMAGES = 50;
export const MAX_UPLOAD_PDF_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_SELECTED_PAPER_CONTEXTS = 10;
export const CHAT_ATTACHMENTS_DIR_NAME = "chat-attachments";
export const PAPER_CONVERSATION_KEY_BASE = 1_500_000_000;
export const GLOBAL_CONVERSATION_KEY_BASE = 2_000_000_000;
export const GLOBAL_HISTORY_LIMIT = 50;

export function isUpstreamGlobalConversationKey(conversationKey: number): boolean {
  return Number.isFinite(conversationKey) && Math.floor(conversationKey) >= GLOBAL_CONVERSATION_KEY_BASE && Math.floor(conversationKey) < 3_000_000_000;
}

export function formatFigureCountLabel(
  count: number,
): string {
  if (count <= 0) return "";
  const noun = count === 1 ? t("Figure") : t("Figures");
  return `${noun} (${count})`;
}

export function formatFileCountLabel(count: number): string {
  if (count <= 0) return "";
  return `${t("Files")} (${count})`;
}

export function formatPaperCountLabel(count: number): string {
  if (count <= 0) return "";
  return t("Papers");
}

export function getSelectTextExpandedLabel() {
  return t("Add Text");
}
export const SELECT_TEXT_COMPACT_LABEL = "";
export function getScreenshotExpandedLabel() {
  return t("Screenshots");
}
export const SCREENSHOT_COMPACT_LABEL = "";
export const UPLOAD_FILE_EXPANDED_LABEL = "";
export const UPLOAD_FILE_COMPACT_LABEL = "";
export const REASONING_COMPACT_LABEL = "";
export const ACTION_LAYOUT_FULL_MODE_BUFFER_PX = 0;
export const ACTION_LAYOUT_PARTIAL_MODE_BUFFER_PX = 0;
export const ACTION_LAYOUT_CONTEXT_ICON_WIDTH_PX = 36;
export const ACTION_LAYOUT_DROPDOWN_ICON_WIDTH_PX = 56;
export const ACTION_LAYOUT_MODEL_WRAP_MIN_CHARS = 12;
export const ACTION_LAYOUT_MODEL_FULL_MAX_LINES = 3;
export const CUSTOM_SHORTCUT_ID_PREFIX = "custom-shortcut";

export const BUILTIN_SHORTCUT_FILES = [
  { id: "summarize", label: "Summarize", file: "summarize.txt" },
  { id: "key-points", label: "Key Points", file: "key-points.txt" },
  { id: "methodology", label: "Methodology", file: "methodology.txt" },
  { id: "limitations", label: "Limitations", file: "limitations.txt" },
] as const;


export const STOPWORDS = new Set([
  "an",
  "as",
  "at",
  "by",
  "do",
  "he",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "no",
  "of",
  "on",
  "or",
  "so",
  "to",
  "up",
  "we",
  "al",
  "and",
  "are",
  "the",
  "for",
  "but",
  "not",
  "you",
  "has",
  "had",
  "was",
  "its",
  "can",
  "may",
  "per",
  "via",
  "use",
  "who",
  "how",
  "why",
  "all",
  "did",
  "get",
  "got",
  "let",
  "our",
  "out",
  "she",
  "too",
  "yet",
  "about",
  "also",
  "been",
  "being",
  "between",
  "could",
  "from",
  "have",
  "into",
  "might",
  "over",
  "such",
  "than",
  "that",
  "them",
  "then",
  "their",
  "they",
  "this",
  "under",
  "used",
  "using",
  "were",
  "what",
  "when",
  "where",
  "which",
  "whom",
  "will",
  "with",
  "within",
  "would",
  "your",
  "et",
]);

export type ModelProfileKey =
  | "primary"
  | "secondary"
  | "tertiary"
  | "quaternary";

export const MODEL_PROFILE_ORDER: ModelProfileKey[] = [
  "primary",
  "secondary",
  "tertiary",
  "quaternary",
];
export const ASSISTANT_NOTE_MAP_PREF_KEY = "assistantNoteMap";

export function getModelProfileSuffix(): Record<ModelProfileKey, string> {
  return {
    primary: t("Primary"),
    secondary: t("Secondary"),
    tertiary: t("Tertiary"),
    quaternary: t("Quaternary"),
  };
}

export { config };
export type { LLMReasoningLevel };
