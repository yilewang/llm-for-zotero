import { config } from "../../../package.json";
import { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";

// =============================================================================
// Constants
// =============================================================================

export const PANE_ID = "llm-context-panel";
export const CHUNK_TARGET_LENGTH = 2000;
export const CHUNK_OVERLAP = 200;
export const EMBEDDING_BATCH_SIZE = 16;
export const HYBRID_WEIGHT_BM25 = 0.5;
export const HYBRID_WEIGHT_EMBEDDING = 0.5;
export const RETRIEVAL_TOP_K_PER_PAPER = 24;
export const RETRIEVAL_MMR_LAMBDA = 0.7;
export const RETRIEVAL_MIN_ACTIVE_PAPER_CHUNKS = 2;
export const RETRIEVAL_MIN_OTHER_PAPER_CHUNKS = 1;
export const MAX_HISTORY_MESSAGES = 12;
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
export const MAX_SELECTED_IMAGES = 10;
export const MAX_UPLOAD_PDF_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_SELECTED_PAPER_CONTEXTS = 5;
export const CHAT_ATTACHMENTS_DIR_NAME = "chat-attachments";
export const PAPER_CONVERSATION_KEY_BASE = 1_500_000_000;
export const GLOBAL_CONVERSATION_KEY_BASE = 2_000_000_000;
export const GLOBAL_HISTORY_LIMIT = 50;

export function formatFigureCountLabel(
  count: number,
  maxCount = MAX_SELECTED_IMAGES,
): string {
  if (count <= 0) return "";
  const noun = count === 1 ? "Figure" : "Figures";
  return `${noun} (${count}/${maxCount})`;
}

export function formatFileCountLabel(count: number): string {
  if (count <= 0) return "";
  return `Files (${count})`;
}

export function formatPaperCountLabel(count: number): string {
  if (count <= 0) return "";
  return "Papers";
}

export const SELECT_TEXT_EXPANDED_LABEL = "Add Text";
export const SELECT_TEXT_COMPACT_LABEL = "";
export const SCREENSHOT_EXPANDED_LABEL = "Screenshots";
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

export const MODEL_PROFILE_SUFFIX: Record<ModelProfileKey, string> = {
  primary: "Primary",
  secondary: "Secondary",
  tertiary: "Tertiary",
  quaternary: "Quaternary",
};

export { config };
export type { LLMReasoningLevel };
