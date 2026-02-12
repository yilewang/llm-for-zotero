import type { ReasoningLevel as LLMReasoningLevel } from "../../utils/llmClient";

export interface Message {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
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
