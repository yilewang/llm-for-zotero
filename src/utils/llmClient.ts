/**
 * LLM API Client
 *
 * Provides streaming and non-streaming API calls to OpenAI-compatible endpoints.
 */

import { config } from "../../package.json";

// =============================================================================
// Types
// =============================================================================

/** Image content for vision-capable models */
export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
};

/** Text content */
export type TextContent = {
  type: "text";
  text: string;
};

/** Message content can be string or array of content parts (for vision) */
export type MessageContent = string | (TextContent | ImageContent)[];

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: MessageContent;
};

export type ReasoningProvider = "openai" | "gemini" | "deepseek" | "kimi";
export type ReasoningLevel =
  | "default"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type ReasoningConfig = {
  provider: ReasoningProvider;
  level: ReasoningLevel;
};

export type ChatParams = {
  prompt: string;
  context?: string;
  history?: ChatMessage[];
  signal?: AbortSignal;
  /** Base64 data URL of an image to include with the prompt */
  image?: string;
  /** Override model for this request */
  model?: string;
  /** Override API base for this request */
  apiBase?: string;
  /** Override API key for this request */
  apiKey?: string;
  /** Optional reasoning control from UI */
  reasoning?: ReasoningConfig;
};

export type ReasoningEvent = {
  summary?: string;
  details?: string;
};

interface StreamChoice {
  delta?: {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
    thinking?: unknown;
    thought?: unknown;
  };
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
    thinking?: unknown;
    thought?: unknown;
  };
}

interface CompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
  }>;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SYSTEM_PROMPT = `You are an intelligent research assistant integrated into Zotero. You help users analyze and understand academic papers and documents.

When answering questions:
- Be concise but thorough
- Cite specific parts of the document when relevant
- Use markdown formatting for better readability (headers, lists, bold, code blocks)
- For mathematical expressions, use standard LaTeX syntax with dollar signs: use $...$ for inline math (e.g., $x^2 + y^2 = z^2$) and $$...$$ for display equations on their own line. IMPORTANT: Always use $ delimiters, never use \\( \\) or \\[ \\] delimiters.
- For tables, use markdown table syntax with pipes and a header divider row
- If you don't have enough information to answer, say so clearly
- Provide actionable insights when possible`;

const API_ENDPOINT = "/v1/chat/completions";
const RESPONSES_ENDPOINT = "/v1/responses";
const EMBEDDINGS_ENDPOINT = "/v1/embeddings";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 2048;

// =============================================================================
// Utilities
// =============================================================================

const prefKey = (key: string) => `${config.prefsPrefix}.${key}`;
const getPref = (key: string) => Zotero.Prefs.get(prefKey(key), true) as string;

/** Get configured API settings */
function resolveEndpoint(baseOrUrl: string, path: string): string {
  const cleaned = baseOrUrl.trim().replace(/\/$/, "");
  if (!cleaned) return "";
  const chatSuffix = "/chat/completions";
  const responsesSuffix = "/responses";
  const embeddingSuffix = "/embeddings";
  const hasChat = cleaned.endsWith(chatSuffix);
  const hasResponses = cleaned.endsWith(responsesSuffix);
  const hasEmbeddings = cleaned.endsWith(embeddingSuffix);

  if (hasChat) {
    if (path === EMBEDDINGS_ENDPOINT) {
      return cleaned.replace(/\/chat\/completions$/, embeddingSuffix);
    }
    if (path === RESPONSES_ENDPOINT) {
      return cleaned.replace(/\/chat\/completions$/, responsesSuffix);
    }
    return cleaned;
  }

  if (hasResponses) {
    if (path === EMBEDDINGS_ENDPOINT) {
      return cleaned.replace(/\/responses$/, embeddingSuffix);
    }
    if (path === API_ENDPOINT) {
      return cleaned.replace(/\/responses$/, chatSuffix);
    }
    return cleaned;
  }

  if (hasEmbeddings) {
    return path === API_ENDPOINT
      ? cleaned.replace(/\/embeddings$/, chatSuffix)
      : cleaned;
  }

  // If a version segment is already present (e.g., /v1 or /v1beta),
  // avoid appending a second /v1 from the default OpenAI path.
  const hasVersion = /\/v\d+(?:beta)?\b/.test(cleaned);
  const normalizedPath =
    hasVersion && path.startsWith("/v1/")
      ? path.replace(/^\/v1\//, "/")
      : path;

  return `${cleaned}${normalizedPath}`;
}

function getApiConfig(overrides?: {
  apiBase?: string;
  apiKey?: string;
  model?: string;
}) {
  const prefApiBase =
    getPref("apiBasePrimary") || getPref("apiBase") || "";
  const apiBase = (overrides?.apiBase || prefApiBase).trim().replace(/\/$/, "");
  const apiKey =
    (overrides?.apiKey || getPref("apiKeyPrimary") || getPref("apiKey") || "")
      .trim();
  const modelPrimary =
    getPref("modelPrimary") || getPref("model") || DEFAULT_MODEL;
  const model = (overrides?.model || modelPrimary).trim();
  const embeddingModel = getPref("embeddingModel") || DEFAULT_EMBEDDING_MODEL;
  const customSystemPrompt = getPref("systemPrompt") || "";

  if (!apiBase) {
    throw new Error("API URL is missing in preferences");
  }

  return {
    apiBase,
    apiKey,
    model,
    embeddingModel,
    systemPrompt: customSystemPrompt || DEFAULT_SYSTEM_PROMPT,
  };
}

/** Build messages array from params */
function buildMessages(
  params: ChatParams,
  systemPrompt: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

  if (params.context) {
    messages.push({
      role: "system",
      content: `Document Context:\n${params.context}`,
    });
  }

  if (params.history?.length) {
    messages.push(...params.history);
  }

  // Build user message - with image if provided (vision API format)
  if (params.image) {
    const contentParts: (TextContent | ImageContent)[] = [
      { type: "text", text: params.prompt },
      {
        type: "image_url",
        image_url: {
          url: params.image,
          detail: "high",
        },
      },
    ];
    messages.push({
      role: "user",
      content: contentParts,
    });
  } else {
    messages.push({
      role: "user",
      content: params.prompt,
    });
  }

  return messages;
}

/** Build request headers */
function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Get fetch function from Zotero global */
function getFetch(): typeof fetch {
  return ztoolkit.getGlobal("fetch") as typeof fetch;
}

function isResponsesBase(baseOrUrl: string): boolean {
  const cleaned = baseOrUrl.trim().replace(/\/$/, "");
  return cleaned.endsWith("/v1/responses") || cleaned.endsWith("/responses");
}

function normalizeStreamText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeStreamText(entry))
      .filter(Boolean)
      .join("");
  }
  if (value && typeof value === "object") {
    const row = value as {
      text?: unknown;
      content?: unknown;
      reasoning?: unknown;
      summary?: unknown;
      delta?: unknown;
      thinking?: unknown;
      thought?: unknown;
    };
    return (
      normalizeStreamText(row.text) ||
      normalizeStreamText(row.content) ||
      normalizeStreamText(row.reasoning) ||
      normalizeStreamText(row.summary) ||
      normalizeStreamText(row.delta) ||
      normalizeStreamText(row.thinking) ||
      normalizeStreamText(row.thought)
    );
  }
  return "";
}

type ThoughtTagState = {
  inThought: boolean;
  buffer: string;
};

function getPartialTagTailLength(text: string, tag: string): number {
  const textLower = text.toLowerCase();
  const tagLower = tag.toLowerCase();
  const max = Math.min(textLower.length, tagLower.length - 1);
  for (let len = max; len > 0; len--) {
    if (tagLower.startsWith(textLower.slice(-len))) {
      return len;
    }
  }
  return 0;
}

function splitThoughtTaggedText(
  chunk: string,
  state: ThoughtTagState,
): { answer: string; thought: string } {
  const OPEN_TAG = "<thought>";
  const CLOSE_TAG = "</thought>";
  const input = `${state.buffer}${chunk}`;
  state.buffer = "";
  if (!input) return { answer: "", thought: "" };

  const inputLower = input.toLowerCase();
  let answer = "";
  let thought = "";
  let cursor = 0;

  while (cursor < input.length) {
    if (state.inThought) {
      const closeIdx = inputLower.indexOf(CLOSE_TAG, cursor);
      if (closeIdx === -1) {
        const segment = input.slice(cursor);
        const tailLen = getPartialTagTailLength(segment, CLOSE_TAG);
        thought += segment.slice(0, segment.length - tailLen);
        state.buffer = segment.slice(segment.length - tailLen);
        break;
      }
      thought += input.slice(cursor, closeIdx);
      cursor = closeIdx + CLOSE_TAG.length;
      state.inThought = false;
      continue;
    }

    const openIdx = inputLower.indexOf(OPEN_TAG, cursor);
    if (openIdx === -1) {
      const segment = input.slice(cursor);
      const tailLen = getPartialTagTailLength(segment, OPEN_TAG);
      answer += segment.slice(0, segment.length - tailLen);
      state.buffer = segment.slice(segment.length - tailLen);
      break;
    }
    answer += input.slice(cursor, openIdx);
    cursor = openIdx + OPEN_TAG.length;
    state.inThought = true;
  }

  return { answer, thought };
}

function usesMaxCompletionTokens(model: string): boolean {
  const name = model.toLowerCase();
  return (
    name.startsWith("gpt-5") ||
    name.startsWith("o") ||
    name.includes("reasoning")
  );
}

function buildTokenParam(model: string, maxTokens: number) {
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function buildResponsesTokenParam(maxTokens: number) {
  return { max_output_tokens: maxTokens };
}

function stringifyContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function buildResponsesInput(messages: ChatMessage[]) {
  const instructionsParts: string[] = [];
  const input: Array<{
    type: "message";
    role: "user" | "assistant";
    content:
      | string
      | Array<
          | { type: "input_text"; text: string }
          | { type: "input_image"; image_url: string; detail?: string }
        >;
  }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = stringifyContent(message.content);
      if (text) instructionsParts.push(text);
      continue;
    }

    if (typeof message.content === "string") {
      input.push({
        type: "message",
        role: message.role,
        content: message.content,
      });
      continue;
    }

    const contentParts = message.content.map((part) => {
      if (part.type === "text") {
        return { type: "input_text" as const, text: part.text };
      }
      return {
        type: "input_image" as const,
        image_url: part.image_url.url,
        detail: part.image_url.detail,
      };
    });

    input.push({
      type: "message",
      role: message.role,
      content: contentParts,
    });
  }

  return {
    instructions: instructionsParts.length
      ? instructionsParts.join("\n\n")
      : undefined,
    input,
  };
}

function buildReasoningPayload(
  reasoning: ReasoningConfig | undefined,
  useResponses: boolean,
  modelName?: string,
): { extra: Record<string, unknown>; omitTemperature: boolean } {
  if (!reasoning) {
    return { extra: {}, omitTemperature: false };
  }

  if (reasoning.provider === "openai") {
    const effort = reasoning.level === "default" ? "medium" : reasoning.level;
    if (useResponses) {
      return {
        extra: {
          reasoning: {
            effort,
            summary: "detailed",
          },
        },
        // GPT-5 reasoning modes may reject temperature when effort is enabled.
        omitTemperature: true,
      };
    }
    return {
      extra: {
        reasoning_effort: effort,
      },
      omitTemperature: true,
    };
  }

  if (reasoning.provider === "gemini") {
    let effort: "low" | "medium" | "high" =
      reasoning.level === "default"
        ? "medium"
        : reasoning.level === "xhigh"
          ? "high"
          : reasoning.level === "low" ||
              reasoning.level === "medium" ||
              reasoning.level === "high"
            ? reasoning.level
            : "medium";
    const normalizedModel = (modelName || "").trim().toLowerCase();
    const isGemini3ProFamily =
      normalizedModel === "gemini-3-pro" ||
      normalizedModel === "gemini-3-pro-preview" ||
      normalizedModel.startsWith("gemini-3-pro-preview-") ||
      normalizedModel.startsWith("gemini-3-pro-");
    const isGemini25 = normalizedModel.startsWith("gemini-2.5");

    // Keep request valid if a stale/unsupported level is selected.
    if (isGemini3ProFamily && effort === "medium") {
      effort = "high";
    }
    if (!isGemini3ProFamily && (effort === "low" || effort === "high")) {
      effort = "medium";
    }

    const thinkingConfig: Record<string, unknown> = {
      include_thoughts: true,
    };
    if (isGemini25) {
      thinkingConfig.thinking_budget =
        effort === "low" ? 1024 : effort === "high" ? 24576 : 8192;
    } else {
      thinkingConfig.thinking_level = effort;
    }

    return {
      extra: {
        extra_body: {
          google: {
            thinking_config: thinkingConfig,
          },
        },
      },
      omitTemperature: false,
    };
  }

  if (reasoning.provider === "deepseek") {
    return {
      extra: {
        thinking: {
          type: "enabled",
        },
      },
      omitTemperature: false,
    };
  }

  if (reasoning.provider === "kimi") {
    // Kimi reasoning models generally expose reasoning by model choice;
    // keep payload conservative to avoid provider-specific parameter errors.
    return {
      extra: {},
      omitTemperature: false,
    };
  }

  return { extra: {}, omitTemperature: false };
}

function stripTemperature(payload: Record<string, unknown>) {
  if (!Object.prototype.hasOwnProperty.call(payload, "temperature")) {
    return payload;
  }
  const clone = { ...payload };
  delete clone.temperature;
  return clone;
}

type TemperaturePolicy =
  | { mode: "default" }
  | { mode: "omit" }
  | { mode: "fixed"; value: number };

const temperaturePolicyCache = new Map<string, TemperaturePolicy>();

function getTemperaturePolicyKey(url: string, payload: Record<string, unknown>) {
  const model =
    typeof payload.model === "string" ? payload.model.trim().toLowerCase() : "";
  return `${url}::${model}`;
}

function applyTemperaturePolicy(
  payload: Record<string, unknown>,
  policy: TemperaturePolicy,
) {
  if (policy.mode === "omit") {
    return stripTemperature(payload);
  }
  if (policy.mode === "fixed") {
    return {
      ...payload,
      temperature: policy.value,
    };
  }
  return payload;
}

function extractFixedTemperature(message: string): number | null {
  const text = message.toLowerCase();
  const patterns = [
    /only\s+(-?\d+(?:\.\d+)?)\s+is\s+allowed/,
    /temperature[^.\n]*must\s+be\s+(-?\d+(?:\.\d+)?)/,
    /temperature[^.\n]*should\s+be\s+(-?\d+(?:\.\d+)?)/,
    /allowed\s+temperature[^.\n]*:\s*(-?\d+(?:\.\d+)?)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function getTemperatureRecoveryPolicy(
  status: number,
  message: string,
): TemperaturePolicy | null {
  if (status !== 400 && status !== 422) return null;
  const text = message.toLowerCase();
  if (!text.includes("temperature")) return null;

  const fixedValue = extractFixedTemperature(text);
  if (fixedValue !== null) {
    return { mode: "fixed", value: fixedValue };
  }

  if (
    text.includes("not supported") ||
    text.includes("unsupported") ||
    text.includes("not allowed") ||
    text.includes("unknown parameter") ||
    text.includes("invalid parameter") ||
    text.includes("invalid temperature")
  ) {
    return { mode: "omit" };
  }

  return null;
}

async function postWithTemperatureFallback(params: {
  url: string;
  apiKey: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}) {
  const policyKey = getTemperaturePolicyKey(params.url, params.payload);
  const hasTemperature = Object.prototype.hasOwnProperty.call(
    params.payload,
    "temperature",
  );
  const send = (bodyPayload: Record<string, unknown>) =>
    getFetch()(params.url, {
      method: "POST",
      headers: buildHeaders(params.apiKey),
      body: JSON.stringify(bodyPayload),
      signal: params.signal,
    });

  let requestPayload = params.payload;
  const cachedPolicy = temperaturePolicyCache.get(policyKey);
  if (hasTemperature && cachedPolicy) {
    requestPayload = applyTemperaturePolicy(params.payload, cachedPolicy);
  }

  let res = await send(requestPayload);
  if (res.ok) return res;

  const firstErr = await res.text();
  const recoveryPolicy = hasTemperature
    ? getTemperatureRecoveryPolicy(res.status, firstErr)
    : null;
  if (recoveryPolicy) {
    const fallbackPayload = applyTemperaturePolicy(params.payload, recoveryPolicy);
    res = await send(fallbackPayload);
    if (res.ok) {
      temperaturePolicyCache.set(policyKey, recoveryPolicy);
      return res;
    }
    const secondErr = await res.text();
    throw new Error(`${res.status} ${res.statusText} - ${secondErr}`);
  }

  throw new Error(`${res.status} ${res.statusText} - ${firstErr}`);
}

function extractResponsesOutputText(data: {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}): string {
  if (data?.output_text) return data.output_text;
  const firstText =
    data?.output
      ?.flatMap((item) => item.content || [])
      .find((content) => content.type === "output_text" && content.text)?.text ||
    "";
  return firstText || JSON.stringify(data);
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * Call LLM API (non-streaming)
 */
export async function callLLM(params: ChatParams): Promise<string> {
  const { apiBase, apiKey, model, systemPrompt } = getApiConfig({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    model: params.model,
  });
  const messages = buildMessages(params, systemPrompt);
  const useResponses = isResponsesBase(apiBase);
  const reasoningPayload = buildReasoningPayload(
    params.reasoning,
    useResponses,
    model,
  );
  const temperatureParam = reasoningPayload.omitTemperature
    ? {}
    : { temperature: DEFAULT_TEMPERATURE };

  const payload = (useResponses
    ? {
        model,
        ...buildResponsesInput(messages),
        ...reasoningPayload.extra,
        ...temperatureParam,
        ...buildResponsesTokenParam(DEFAULT_MAX_TOKENS),
      }
    : {
        model,
        messages,
        ...reasoningPayload.extra,
        ...temperatureParam,
        ...buildTokenParam(model, DEFAULT_MAX_TOKENS),
      }) as Record<string, unknown>;

  const url = resolveEndpoint(
    apiBase,
    useResponses ? RESPONSES_ENDPOINT : API_ENDPOINT,
  );
  const res = await postWithTemperatureFallback({
    url,
    apiKey,
    payload,
    signal: params.signal,
  });

  const data = (await res.json()) as CompletionResponse & {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (useResponses) {
    return extractResponsesOutputText(data);
  }
  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    JSON.stringify(data)
  );
}

/**
 * Call LLM API with streaming response
 */
export async function callLLMStream(
  params: ChatParams,
  onDelta: (delta: string) => void,
  onReasoning?: (event: ReasoningEvent) => void,
): Promise<string> {
  const { apiBase, apiKey, model, systemPrompt } = getApiConfig({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    model: params.model,
  });
  const messages = buildMessages(params, systemPrompt);
  const useResponses = isResponsesBase(apiBase);
  const reasoningPayload = buildReasoningPayload(
    params.reasoning,
    useResponses,
    model,
  );
  const temperatureParam = reasoningPayload.omitTemperature
    ? {}
    : { temperature: DEFAULT_TEMPERATURE };

  const payload = (useResponses
    ? {
        model,
        ...buildResponsesInput(messages),
        ...reasoningPayload.extra,
        ...temperatureParam,
        ...buildResponsesTokenParam(DEFAULT_MAX_TOKENS),
        stream: true,
      }
    : {
        model,
        messages,
        ...reasoningPayload.extra,
        ...temperatureParam,
        ...buildTokenParam(model, DEFAULT_MAX_TOKENS),
        stream: true,
      }) as Record<string, unknown>;

  const url = resolveEndpoint(
    apiBase,
    useResponses ? RESPONSES_ENDPOINT : API_ENDPOINT,
  );
  const res = await postWithTemperatureFallback({
    url,
    apiKey,
    payload,
    signal: params.signal,
  });

  // Fallback to non-streaming if body is not available
  if (!res.body) {
    return callLLM(params);
  }

  return useResponses
    ? parseResponsesStream(res.body, onDelta, onReasoning)
    : parseStreamResponse(res.body, onDelta, onReasoning);
}

/**
 * Call embeddings API
 */
export async function callEmbeddings(
  input: string[],
  overrides?: { apiBase?: string; apiKey?: string },
): Promise<number[][]> {
  const { apiBase, apiKey, embeddingModel } = getApiConfig({
    apiBase: overrides?.apiBase,
    apiKey: overrides?.apiKey,
  });
  const payload = {
    model: embeddingModel,
    input,
  };

  const url = resolveEndpoint(apiBase, EMBEDDINGS_ENDPOINT);
  const res = await getFetch()(url, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText} - ${text}`);
  }

  const data = (await res.json()) as EmbeddingResponse;
  const embeddings = data?.data?.map((item) => item.embedding || []) || [];
  return embeddings;
}

/**
 * Parse SSE stream response
 */
async function parseStreamResponse(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  onReasoning?: (event: ReasoningEvent) => void,
): Promise<string> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  const thoughtState: ThoughtTagState = { inThought: false, buffer: "" };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as { choices?: StreamChoice[] };
          const choice = parsed?.choices?.[0];
          const reasoningDelta = normalizeStreamText(
            choice?.delta?.reasoning_content ??
              choice?.delta?.reasoning ??
              choice?.delta?.thinking ??
              choice?.delta?.thought ??
              choice?.message?.reasoning_content ??
              choice?.message?.reasoning ??
              choice?.message?.thinking ??
              choice?.message?.thought ??
              "",
          );
          if (reasoningDelta && onReasoning) {
            onReasoning({ details: reasoningDelta });
          }

          const deltaRaw = normalizeStreamText(
            choice?.delta?.content ?? choice?.message?.content ?? "",
          );
          const { answer, thought } = splitThoughtTaggedText(
            deltaRaw,
            thoughtState,
          );
          if (thought && onReasoning) {
            onReasoning({ details: thought });
          }

          if (answer) {
            fullText += answer;
            onDelta(answer);
          }
        } catch (err) {
          ztoolkit.log("LLM stream parse error:", err);
        }
      }
    }
  } finally {
    if (thoughtState.buffer) {
      if (thoughtState.inThought && onReasoning) {
        onReasoning({ details: thoughtState.buffer });
      } else {
        fullText += thoughtState.buffer;
        onDelta(thoughtState.buffer);
      }
    }
    reader.releaseLock();
  }

  return fullText;
}

async function parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  onReasoning?: (event: ReasoningEvent) => void,
): Promise<string> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  const thoughtState: ThoughtTagState = { inThought: false, buffer: "" };
  let sawSummaryDelta = false;
  let sawDetailsDelta = false;
  let sawSummaryFinal = false;
  let sawDetailsFinal = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            type?: string;
            delta?: string;
            text?: string;
            summary?: Array<{ type?: string; text?: string }> | string;
            reasoning?: string | Array<{ text?: string; summary?: string }>;
            message?: { content?: string };
            response?: {
              output_text?: string;
              output?: Array<{
                type?: string;
                content?: Array<{
                  type?: string;
                  text?: string;
                  summary?: string;
                }>;
                summary?: Array<{ type?: string; text?: string }> | string;
              }>;
            };
          };

          const normalizeReasoningText = (value: unknown): string => {
            if (typeof value === "string") return value;
            if (Array.isArray(value)) {
              return value
                .map((entry) => {
                  if (typeof entry === "string") return entry;
                  if (entry && typeof entry === "object") {
                    const row = entry as { text?: string; summary?: string };
                    return row.text || row.summary || "";
                  }
                  return "";
                })
                .filter(Boolean)
                .join("\n");
            }
            if (value && typeof value === "object") {
              const row = value as { text?: string; summary?: string };
              return row.text || row.summary || "";
            }
            return "";
          };

          const extractSummary = (
            value: Array<{ type?: string; text?: string }> | string | undefined,
          ): string => {
            if (!value) return "";
            if (typeof value === "string") return value;
            return value
              .map((entry) => entry.text || "")
              .filter(Boolean)
              .join("\n");
          };

          const emitReasoning = (event: ReasoningEvent) => {
            if (!onReasoning) return;
            const summary =
              typeof event.summary === "string" && event.summary.length > 0
                ? event.summary
                : undefined;
            const details =
              typeof event.details === "string" && event.details.length > 0
                ? event.details
                : undefined;
            if (!summary && !details) return;
            onReasoning({ summary, details });
          };

          if (parsed.type === "response.output_text.delta" && parsed.delta) {
            const { answer, thought } = splitThoughtTaggedText(
              parsed.delta,
              thoughtState,
            );
            if (thought && onReasoning) {
              onReasoning({ details: thought });
            }
            if (answer) {
              fullText += answer;
              onDelta(answer);
            }
            continue;
          }

          if (parsed.type === "response.output_text.done" && parsed.text) {
            const { answer, thought } = splitThoughtTaggedText(
              parsed.text,
              thoughtState,
            );
            if (thought && onReasoning) {
              onReasoning({ details: thought });
            }
            if (answer) {
              fullText += answer;
              onDelta(answer);
            }
            continue;
          }

          if (parsed.type === "response.completed" && parsed.response?.output_text) {
            if (!fullText) {
              const { answer, thought } = splitThoughtTaggedText(
                parsed.response.output_text,
                thoughtState,
              );
              if (thought && onReasoning) {
                onReasoning({ details: thought });
              }
              if (answer) {
                fullText = answer;
                onDelta(answer);
              }
            }
          }

          if (
            (parsed.type === "response.reasoning_summary.delta" ||
              parsed.type === "response.reasoning_summary_text.delta") &&
            parsed.delta
          ) {
            sawSummaryDelta = true;
            emitReasoning({ summary: parsed.delta });
            continue;
          }

          if (
            (parsed.type === "response.reasoning_summary.done" ||
              parsed.type === "response.reasoning_summary_text.done") &&
            (parsed.text || parsed.delta)
          ) {
            sawSummaryFinal = true;
            if (!sawSummaryDelta) {
              emitReasoning({ summary: parsed.text || parsed.delta });
            }
            continue;
          }

          if (
            (parsed.type === "response.reasoning.delta" ||
              parsed.type === "response.reasoning_text.delta") &&
            parsed.delta
          ) {
            sawDetailsDelta = true;
            emitReasoning({ details: parsed.delta });
            continue;
          }

          if (
            (parsed.type === "response.reasoning.done" ||
              parsed.type === "response.reasoning_text.done") &&
            (parsed.text || parsed.delta)
          ) {
            sawDetailsFinal = true;
            if (!sawDetailsDelta) {
              emitReasoning({ details: parsed.text || parsed.delta });
            }
            continue;
          }

          if (parsed.type === "response.reasoning" && parsed.reasoning) {
            sawDetailsFinal = true;
            if (!sawDetailsDelta) {
              emitReasoning({ details: normalizeReasoningText(parsed.reasoning) });
            }
            continue;
          }

          if (
            parsed.type === "response.output_item.added" ||
            parsed.type === "response.output_item.done" ||
            parsed.type === "response.completed"
          ) {
            const outputs = parsed.response?.output || [];
            for (const out of outputs) {
              if (out.type !== "reasoning") continue;
              if (!sawSummaryDelta && !sawSummaryFinal) {
                emitReasoning({
                  summary: extractSummary(out.summary),
                });
              }
              if (!sawDetailsDelta && !sawDetailsFinal) {
                emitReasoning({
                  details: normalizeReasoningText(out.content),
                });
              }
            }
          }
        } catch (err) {
          ztoolkit.log("LLM responses stream parse error:", err);
        }
      }
    }
  } finally {
    if (thoughtState.buffer) {
      if (thoughtState.inThought && onReasoning) {
        onReasoning({ details: thoughtState.buffer });
      } else {
        fullText += thoughtState.buffer;
        onDelta(thoughtState.buffer);
      }
    }
    reader.releaseLock();
  }

  return fullText;
}
