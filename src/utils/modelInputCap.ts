/**
 * Model-aware input-token capping helpers.
 *
 * Providers use different tokenizers and context semantics. We therefore
 * use conservative estimates and per-model limits to reduce context-length
 * failures before sending requests.
 */

import { DEFAULT_INPUT_TOKEN_CAP } from "./llmDefaults";
import { normalizeInputTokenCap } from "./normalization";

type TextPart = {
  type: "text";
  text: string;
};

type ImagePart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
};

export type InputCapMessageContent = string | (TextPart | ImagePart)[];

export type InputCapMessage = {
  role: "user" | "assistant" | "system";
  content: InputCapMessageContent;
};

type ModelInputLimitRule = {
  pattern: RegExp;
  limit: number;
};

export const DEFAULT_MODEL_INPUT_TOKEN_LIMIT = DEFAULT_INPUT_TOKEN_CAP;
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

const IMAGE_PART_ESTIMATED_TOKENS = 1_024;
const MESSAGE_OVERHEAD_ESTIMATED_TOKENS = 4;
const TOKEN_SAFETY_RATIO = 0.9;
const MIN_SOFT_LIMIT_TOKENS = 1_024;
const MIN_CONTEXT_CHARS = 256;
const MIN_PROMPT_CHARS = 64;
const CONTEXT_PREFIX = "Document Context:\n";
const CONTEXT_TRUNCATION_NOTICE =
  "[Context truncated to fit model input limit]";
const PROMPT_TRUNCATION_NOTICE = "[Prompt truncated to fit model input limit]";

const MODEL_INPUT_LIMIT_RULES: ModelInputLimitRule[] = [
  // Qwen (Alibaba Model Studio)
  { pattern: /^qwen-long(?:[.-]|$)/, limit: 10_000_000 },
  { pattern: /^qwen-turbo(?:[.-]|$)/, limit: 1_000_000 },
  { pattern: /^qwen-max(?:-latest)?(?:[.-]|$)/, limit: 129_024 },

  // Gemini
  { pattern: /^gemini-2[.-]?5(?:[.-]|$)/, limit: 1_048_576 },
  { pattern: /^gemini-3(?:[.-]|$)/, limit: 1_000_000 },
  { pattern: /^gemini-1[.-]?5(?:[.-]|$)/, limit: 1_000_000 },

  // OpenAI
  { pattern: /^gpt-4[.-]?1(?:[.-]|$)/, limit: 1_047_576 },
  { pattern: /^gpt-5(?:[.-]|$)/, limit: 400_000 },
  { pattern: /^o(?:3|1(?:-pro)?)(?:[.-]|$)/, limit: 200_000 },
  { pattern: /^gpt-4o(?:[.-]|$)/, limit: 128_000 },

  // Anthropic
  { pattern: /^claude(?:[.-]|$)/, limit: 200_000 },

  // xAI
  { pattern: /^grok-(?:4[.-]?1-fast|4-fast)(?:[.-]|$)/, limit: 2_000_000 },
  { pattern: /^grok-code-fast-1(?:[.-]|$)/, limit: 256_000 },
  { pattern: /^grok-4(?:[.-]|$)/, limit: 256_000 },
  { pattern: /^grok-3(?:[.-]|$)/, limit: 131_072 },

  // Cohere
  { pattern: /^command-a(?:-reasoning)?(?:[.-]|$)/, limit: 256_000 },
  { pattern: /^command-r(?:\+|-plus)?(?:[.-]|$)/, limit: 128_000 },

  // Mistral
  { pattern: /^mistral-large-3(?:[.-]|$)/, limit: 256_000 },
  { pattern: /^ministral-3(?:-14b)?(?:[.-]|$)/, limit: 256_000 },
  { pattern: /^mistral-medium-3(?:[.-]|$)/, limit: 128_000 },
  { pattern: /^mistral-small-3(?:[.-]|$)/, limit: 128_000 },
  { pattern: /^codestral(?:[.-]|$)/, limit: 128_000 },

  // DeepSeek
  { pattern: /^deepseek-(?:chat|reasoner)(?:[.-]|$)/, limit: 128_000 },
  { pattern: /^deepseek(?:[.-]|$)/, limit: 128_000 },
];

function stripTrailingNotice(text: string, notice: string): string {
  if (!text) return "";
  const suffix = `\n\n${notice}`;
  if (text.endsWith(suffix)) {
    return text.slice(0, text.length - suffix.length).trimEnd();
  }
  return text;
}

function truncateWithNotice(
  text: string,
  maxChars: number,
  notice: string,
): string {
  if (maxChars <= 0) return notice;
  const source = stripTrailingNotice(text, notice);
  if (source.length <= maxChars) return source;
  const suffix = `\n\n${notice}`;
  if (maxChars <= suffix.length + 8) {
    return source.slice(0, maxChars).trimEnd();
  }
  const bodyLimit = Math.max(0, maxChars - suffix.length);
  return `${source.slice(0, bodyLimit).trimEnd()}${suffix}`;
}

function cloneMessageContent(
  content: InputCapMessageContent,
): InputCapMessageContent {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
    }
    return {
      type: "image_url" as const,
      image_url: {
        url: part.image_url.url,
        detail: part.image_url.detail,
      },
    };
  });
}

function cloneMessages(messages: InputCapMessage[]): InputCapMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: cloneMessageContent(message.content),
  }));
}

function findLastUserIndex(messages: InputCapMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function findContextMessageIndex(messages: InputCapMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (
      messages[i].role === "system" &&
      typeof content === "string" &&
      content.startsWith(CONTEXT_PREFIX)
    ) {
      return i;
    }
  }
  return -1;
}

function estimateContentTokens(content: InputCapMessageContent): number {
  if (typeof content === "string") {
    return estimateTextTokens(content);
  }
  let total = 0;
  for (const part of content) {
    if (part.type === "text") {
      total += estimateTextTokens(part.text);
    } else {
      total += IMAGE_PART_ESTIMATED_TOKENS;
    }
  }
  return total;
}

function trimContextMessage(
  message: InputCapMessage,
  overflowTokens: number,
): boolean {
  if (typeof message.content !== "string") return false;
  if (!message.content.startsWith(CONTEXT_PREFIX)) return false;
  const body = stripTrailingNotice(
    message.content.slice(CONTEXT_PREFIX.length),
    CONTEXT_TRUNCATION_NOTICE,
  );
  if (!body) return false;
  const overflowChars = Math.max(
    TOKEN_ESTIMATE_CHARS_PER_TOKEN,
    overflowTokens * TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  );
  const nextBodyChars = Math.max(
    MIN_CONTEXT_CHARS,
    body.length - overflowChars,
  );
  if (nextBodyChars >= body.length) return false;
  const nextBody = truncateWithNotice(
    body,
    nextBodyChars,
    CONTEXT_TRUNCATION_NOTICE,
  );
  message.content = `${CONTEXT_PREFIX}${nextBody}`;
  return true;
}

function trimUserMessage(
  message: InputCapMessage,
  overflowTokens: number,
): boolean {
  const overflowChars = Math.max(
    TOKEN_ESTIMATE_CHARS_PER_TOKEN,
    overflowTokens * TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  );
  if (typeof message.content === "string") {
    const source = stripTrailingNotice(
      message.content,
      PROMPT_TRUNCATION_NOTICE,
    );
    if (!source) return false;
    const nextChars = Math.max(MIN_PROMPT_CHARS, source.length - overflowChars);
    if (nextChars >= source.length) return false;
    message.content = truncateWithNotice(
      source,
      nextChars,
      PROMPT_TRUNCATION_NOTICE,
    );
    return true;
  }

  const contentParts = message.content;
  const firstTextIndex = contentParts.findIndex((part) => part.type === "text");
  if (firstTextIndex >= 0) {
    const part = contentParts[firstTextIndex] as TextPart;
    const source = stripTrailingNotice(part.text, PROMPT_TRUNCATION_NOTICE);
    const nextChars = Math.max(MIN_PROMPT_CHARS, source.length - overflowChars);
    if (nextChars < source.length) {
      part.text = truncateWithNotice(
        source,
        nextChars,
        PROMPT_TRUNCATION_NOTICE,
      );
      return true;
    }
  }

  for (let i = contentParts.length - 1; i >= 0; i--) {
    if (contentParts[i].type === "image_url") {
      contentParts.splice(i, 1);
      if (!contentParts.length) {
        contentParts.push({
          type: "text",
          text: PROMPT_TRUNCATION_NOTICE,
        });
      }
      return true;
    }
  }

  return false;
}

function buildFallbackMessages(
  messages: InputCapMessage[],
  lastUserIndex: number,
): InputCapMessage[] {
  const fallback = messages.filter(
    (message, index) => message.role === "system" || index === lastUserIndex,
  );
  if (fallback.length) return fallback;
  return messages.length ? [messages[messages.length - 1]] : [];
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

export function estimateConversationTokens(
  messages: InputCapMessage[],
): number {
  let total = 0;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_ESTIMATED_TOKENS;
    total += estimateContentTokens(message.content);
  }
  return total;
}

export function getModelInputTokenLimit(modelName: string): number {
  const normalized = (modelName || "").trim().toLowerCase();
  if (!normalized) return DEFAULT_MODEL_INPUT_TOKEN_LIMIT;
  const normalizedTail = normalized.split("/").pop() || "";
  const candidates =
    normalizedTail && normalizedTail !== normalized
      ? [normalized, normalizedTail]
      : [normalized];
  for (const rule of MODEL_INPUT_LIMIT_RULES) {
    for (const candidate of candidates) {
      if (rule.pattern.test(candidate)) {
        return rule.limit;
      }
    }
  }
  return DEFAULT_MODEL_INPUT_TOKEN_LIMIT;
}

export type InputCapResult = {
  messages: InputCapMessage[];
  capped: boolean;
  limitTokens: number;
  softLimitTokens: number;
  estimatedBeforeTokens: number;
  estimatedAfterTokens: number;
};

export function applyModelInputTokenCap(
  messages: InputCapMessage[],
  modelName: string,
  inputTokenCapOverride?: number,
): InputCapResult {
  const modelLimitTokens = getModelInputTokenLimit(modelName);
  const limitTokens = normalizeInputTokenCap(
    inputTokenCapOverride,
    modelLimitTokens,
  );
  const softLimitTokens = Math.max(
    MIN_SOFT_LIMIT_TOKENS,
    Math.floor(limitTokens * TOKEN_SAFETY_RATIO),
  );
  let working = cloneMessages(messages);
  const estimatedBeforeTokens = estimateConversationTokens(working);
  let estimatedAfterTokens = estimatedBeforeTokens;

  if (estimatedAfterTokens <= softLimitTokens) {
    return {
      messages: working,
      capped: false,
      limitTokens,
      softLimitTokens,
      estimatedBeforeTokens,
      estimatedAfterTokens,
    };
  }

  let lastUserIndex = findLastUserIndex(working);

  for (
    let i = 0;
    i < working.length && estimatedAfterTokens > softLimitTokens;
  ) {
    if (i === lastUserIndex || working[i].role === "system") {
      i++;
      continue;
    }
    working.splice(i, 1);
    if (lastUserIndex >= 0 && i < lastUserIndex) {
      lastUserIndex -= 1;
    }
    estimatedAfterTokens = estimateConversationTokens(working);
  }

  let contextTrimGuard = 0;
  while (estimatedAfterTokens > softLimitTokens && contextTrimGuard < 24) {
    contextTrimGuard += 1;
    const contextIndex = findContextMessageIndex(working);
    if (contextIndex < 0) break;
    const overflow = estimatedAfterTokens - softLimitTokens;
    const changed = trimContextMessage(working[contextIndex], overflow);
    if (!changed) {
      working.splice(contextIndex, 1);
      if (lastUserIndex >= 0 && contextIndex < lastUserIndex) {
        lastUserIndex -= 1;
      }
    }
    estimatedAfterTokens = estimateConversationTokens(working);
  }

  let userTrimGuard = 0;
  while (
    estimatedAfterTokens > softLimitTokens &&
    lastUserIndex >= 0 &&
    userTrimGuard < 32
  ) {
    userTrimGuard += 1;
    const overflow = estimatedAfterTokens - softLimitTokens;
    const changed = trimUserMessage(working[lastUserIndex], overflow);
    if (!changed) break;
    estimatedAfterTokens = estimateConversationTokens(working);
  }

  if (estimatedAfterTokens > softLimitTokens) {
    working = buildFallbackMessages(working, lastUserIndex);
    estimatedAfterTokens = estimateConversationTokens(working);
    const fallbackUserIndex = findLastUserIndex(working);
    let fallbackGuard = 0;
    while (
      estimatedAfterTokens > softLimitTokens &&
      fallbackUserIndex >= 0 &&
      fallbackGuard < 32
    ) {
      fallbackGuard += 1;
      const overflow = estimatedAfterTokens - softLimitTokens;
      const changed = trimUserMessage(working[fallbackUserIndex], overflow);
      if (!changed) break;
      estimatedAfterTokens = estimateConversationTokens(working);
    }
  }

  return {
    messages: working,
    capped: true,
    limitTokens,
    softLimitTokens,
    estimatedBeforeTokens,
    estimatedAfterTokens,
  };
}
