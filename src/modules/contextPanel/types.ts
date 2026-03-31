import type { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";
import type {
  SelectedTextSource,
  ChatAttachmentCategory,
  ChatAttachment,
  AdvancedModelParams,
  ActiveNoteSession,
  PaperContextRef,
  NoteContextRef,
  OtherContextRef,
  GlobalConversationSummary,
  PaperConversationSummary,
} from "../../shared/types";

export type {
  SelectedTextSource,
  ChatAttachmentCategory,
  ChatAttachment,
  AdvancedModelParams,
  ActiveNoteSession,
  PaperContextRef,
  NoteContextRef,
  OtherContextRef,
  GlobalConversationSummary,
  PaperConversationSummary,
} from "../../shared/types";

export type SelectedTextContext = {
  text: string;
  source: SelectedTextSource;
  paperContext?: PaperContextRef;
  noteContext?: NoteContextRef;
  contextItemId?: number;
  pageIndex?: number;
  pageLabel?: string;
};

export interface Message {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  runMode?: "chat" | "agent";
  agentRunId?: string;
  selectedText?: string;
  selectedTextExpanded?: boolean;
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  selectedTextExpandedIndex?: number;
  screenshotImages?: string[];
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  pinnedPaperContexts?: PaperContextRef[];
  paperContextsExpanded?: boolean;
  attachments?: ChatAttachment[];
  attachmentsExpanded?: boolean;
  attachmentActiveIndex?: number;
  screenshotExpanded?: boolean;
  screenshotActiveIndex?: number;
  modelName?: string;
  modelEntryId?: string;
  modelProviderLabel?: string;
  streaming?: boolean;
  reasoningSummary?: string;
  reasoningDetails?: string;
  reasoningOpen?: boolean;
}

export type ChatRuntimeMode = "chat" | "agent";
export type PaperContextSendMode =
  | "retrieval"
  | "full-next"
  | "full-sticky";

export type PaperContentSourceMode = "text" | "mineru" | "pdf";

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
export type CustomShortcut = {
  id: string;
  label: string;
  prompt: string;
};
export type ResolvedContextSource = {
  contextItem: Zotero.Item | null;
  statusText: string;
};

export type PdfContext = {
  title: string;
  chunks: string[];
  chunkMeta: PdfChunkMeta[];
  chunkStats: ChunkStat[];
  docFreq: Record<string, number>;
  avgChunkLength: number;
  fullLength: number;
  embeddings?: number[][];
  embeddingPromise?: Promise<number[][] | null>;
  embeddingFailed?: boolean;
  sourceType?: "mineru" | "zotero-worker";
};

export type PdfChunkKind =
  | "abstract"
  | "introduction"
  | "methods"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "figure-caption"
  | "table-caption"
  | "appendix"
  | "body"
  | "unknown";

export type PdfChunkMeta = {
  chunkIndex: number;
  text: string;
  normalizedText: string;
  sectionLabel?: string;
  chunkKind: PdfChunkKind;
  anchorText?: string;
  leadingNoiseRemoved?: boolean;
};

export type ContextAssemblyMode = "full" | "retrieval";
export type ContextAssemblyStrategy =
  | "paper-first-full"
  | "paper-manual-full"
  | "paper-explicit-retrieval"
  | "paper-followup-retrieval"
  | "general-full"
  | "general-retrieval";

export type ContextBudgetPlan = {
  modelLimitTokens: number;
  limitTokens: number;
  softLimitTokens: number;
  baseInputTokens: number;
  outputReserveTokens: number;
  reasoningReserveTokens: number;
  contextBudgetTokens: number;
};

export type PaperContextCandidate = {
  paperKey: string;
  itemId: number;
  contextItemId: number;
  title: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
  chunkIndex: number;
  chunkText: string;
  sectionLabel?: string;
  chunkKind?: PdfChunkKind;
  anchorText?: string;
  leadingNoiseRemoved?: boolean;
  estimatedTokens: number;
  bm25Score: number;
  embeddingScore: number;
  hybridScore: number;
  evidenceScore: number;
};

export type MultiContextPlan = {
  mode: ContextAssemblyMode;
  strategy: ContextAssemblyStrategy;
  contextText: string;
  contextBudget: ContextBudgetPlan;
  usedContextTokens: number;
  selectedPaperCount: number;
  selectedChunkCount: number;
  assistantInstruction?: string;
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

// ── Send flow options ─────────────────────────────────────────────────────

import type { ReasoningConfig as LLMReasoningConfig } from "../../utils/llmClient";

export type SendQuestionOptions = {
  body: Element;
  item: Zotero.Item;
  question: string;
  images?: string[];
  model?: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
  displayQuestion?: string;
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  attachments?: ChatAttachment[];
  runtimeMode?: ChatRuntimeMode;
  agentRunId?: string;
  skipAgentDispatch?: boolean;
  pdfModePaperKeys?: Set<string>;
  /** System messages injected by provider-side PDF upload (Qwen fileid://, Kimi extracted text). */
  pdfUploadSystemMessages?: string[];
};

export type EditRetryOptions = {
  body: Element;
  item: Zotero.Item;
  displayQuestion: string;
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
  selectedTextPaperContexts?: (PaperContextRef | undefined)[];
  selectedTextNoteContexts?: (NoteContextRef | undefined)[];
  screenshotImages?: string[];
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  attachments?: ChatAttachment[];
  pdfUploadSystemMessages?: string[];
  targetRuntimeMode?: ChatRuntimeMode;
  expected?: { conversationKey: number; userTimestamp: number; assistantTimestamp: number };
  model?: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: LLMReasoningConfig;
  advanced?: AdvancedModelParams;
};
