import type { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";

export type SelectedTextSource = "pdf" | "model";
export type SelectedTextContext = {
  text: string;
  source: SelectedTextSource;
  paperContext?: PaperContextRef;
};

export interface Message {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  selectedText?: string;
  selectedTextExpanded?: boolean;
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextExpandedIndex?: number;
  screenshotImages?: string[];
  paperContexts?: PaperContextRef[];
  paperContextsExpanded?: boolean;
  attachments?: ChatAttachment[];
  attachmentsExpanded?: boolean;
  attachmentActiveIndex?: number;
  screenshotExpanded?: boolean;
  screenshotActiveIndex?: number;
  modelName?: string;
  streaming?: boolean;
  reasoningSummary?: string;
  reasoningDetails?: string;
  reasoningOpen?: boolean;
}

export type ReasoningProviderKind =
  | "openai"
  | "gemini"
  | "deepseek"
  | "kimi"
  | "qwen"
  | "grok"
  | "anthropic"
  | "unsupported";
export type ReasoningLevelSelection = "none" | LLMReasoningLevel;
export type ReasoningOption = {
  level: LLMReasoningLevel;
  enabled: boolean;
  label?: string;
};
export type ActionDropdownSpec = {
  slotId: string;
  slotClassName: string;
  buttonId: string;
  buttonClassName: string;
  buttonText: string;
  menuId: string;
  menuClassName: string;
  disabled?: boolean;
};
export type AdvancedModelParams = {
  temperature: number;
  maxTokens: number;
};
export type ApiProfile = {
  apiBase: string;
  apiKey: string;
  model: string;
};
export type CustomShortcut = {
  id: string;
  label: string;
  prompt: string;
};
export type ResolvedContextSource = {
  contextItem: Zotero.Item | null;
  statusText: string;
};

export type ChatAttachmentCategory =
  | "image"
  | "pdf"
  | "markdown"
  | "code"
  | "text"
  | "file";

export type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  category: ChatAttachmentCategory;
  imageDataUrl?: string;
  textContent?: string;
  storedPath?: string;
  contentHash?: string;
};

export type PdfContext = {
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

export type PaperContextRef = {
  itemId: number;
  contextItemId: number;
  citationKey?: string;
  title: string;
  firstCreator?: string;
  year?: string;
};

export type GlobalConversationSummary = {
  conversationKey: number;
  libraryID: number;
  createdAt: number;
  title?: string;
  lastActivityAt: number;
  userTurnCount: number;
};

export type PaperConversationSummary = {
  conversationKey: number;
  libraryID: number;
  paperItemID: number;
  sessionVersion: number;
  createdAt: number;
  title?: string;
  lastActivityAt: number;
  userTurnCount: number;
};

export type GlobalPortalItem = {
  __llmGlobalPortalItem: true;
  id: number;
  libraryID: number;
  parentID?: number;
  attachmentContentType?: string;
  isAttachment: () => boolean;
  getAttachments: () => number[];
  getField: (field: string) => string;
  isRegularItem: () => boolean;
};

export type PaperPortalItem = {
  __llmPaperPortalItem: true;
  __llmPaperPortalBaseItemID: number;
  __llmPaperPortalSessionVersion: number;
  id: number;
  libraryID: number;
  parentID?: number;
  attachmentContentType?: string;
  isAttachment: () => boolean;
  getAttachments: () => number[];
  getField: (field: string) => string;
  isRegularItem: () => boolean;
};

export type ChunkStat = {
  index: number;
  length: number;
  tf: Record<string, number>;
  uniqueTerms: string[];
};

export type ZoteroTabsState = {
  selectedID?: string | number;
  selectedType?: string;
  _tabs?: Array<{ id?: string | number; type?: string; data?: any }>;
};
