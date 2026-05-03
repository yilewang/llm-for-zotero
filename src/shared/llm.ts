import type {
  ReasoningLevel,
  ReasoningProvider,
} from "../utils/reasoningProfiles";

/** Image content for vision-capable models. */
export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
};

export type TextContent = {
  type: "text";
  text: string;
};

export type MessageContent = string | (TextContent | ImageContent)[];

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: MessageContent;
};

export type ReasoningConfig = {
  provider: ReasoningProvider;
  level: ReasoningLevel;
};

export type ReasoningEvent = {
  summary?: string;
  details?: string;
  /**
   * Adapter-provided reasoning item identity. App-server emits multiple
   * reasoning items inside one runtime round; preserving this lets the UI
   * render them as separate legacy-like thinking steps.
   */
  stepId?: string;
  stepLabel?: string;
};

export type UsageStats = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Active input/context tokens for the current model request. */
  contextTokens?: number;
  /** Input context window used for the current model request. */
  contextWindow?: number;
  /** True when contextTokens/contextWindow came from the provider/runtime. */
  contextWindowIsAuthoritative?: boolean;
};
