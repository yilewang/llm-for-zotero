import { usesMaxCompletionTokens } from "./apiHelpers";
import {
  isRecord,
  normalizeProfileOverride,
  profileOverrideAppliesTo,
} from "../modelCapabilities";
import { resolveUserExtraBody } from "./llmClient";
import type { ModelProviderAuthMode } from "./modelProviders";
import {
  describeAgentCapabilityClass,
  getAgentCapabilityClass,
  type ProviderProtocol,
} from "./providerProtocol";
import {
  buildProviderTransportHeaders,
  resolveProviderTransportEndpoint,
} from "./providerTransport";
import { createAgentModelAdapter } from "../agent/model/factory";
import type { AgentRuntimeRequestInput as AgentRuntimeRequest } from "../agent/types";
import { resolveAgentRuntimeRequest } from "../agent/context/resolvedAgentRequest";
import {
  destroyCachedCodexAppServerProcess,
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  resolveCodexAppServerBinaryPath,
  waitForCodexAppServerTurnCompletion,
} from "./codexAppServerProcess";
import { probeCodexZoteroMcpThroughAppServer } from "../codexAppServer/mcpSetup";
import {
  CODEX_DIRECT_RESPONSES_URL,
  fetchWithCodexAuth,
  type CodexAuthDependencies,
} from "../codexAuth/auth";
import { loadCodexDirectCatalog } from "../codexAuth/modelCatalog";

class CodexAppServerConnectionTestError extends Error {
  readonly mcpConnected: boolean;

  constructor(error: unknown, mcpConnected: boolean) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "CodexAppServerConnectionTestError";
    this.mcpConnected = mcpConnected;
  }
}

function extractTextFromCodexSSE(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let out = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as {
        delta?: string;
        response?: {
          output_text?: string;
          output?: Array<{
            content?: Array<{ type?: string; text?: string }>;
          }>;
        };
      };
      if (typeof parsed.delta === "string") {
        out += parsed.delta;
      }
      const completedText = parsed.response?.output_text;
      if (typeof completedText === "string" && completedText.trim()) {
        out += completedText;
      }
      const outputItems = parsed.response?.output || [];
      for (const item of outputItems) {
        const content = item.content || [];
        for (const part of content) {
          if (
            (part.type === "output_text" || part.type === "text") &&
            typeof part.text === "string"
          ) {
            out += part.text;
          }
        }
      }
    } catch (_error) {
      continue;
    }
  }
  return out.trim();
}

function extractAnthropicText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      return (entry as { type?: unknown; text?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string"
        ? (entry as { text: string }).text || ""
        : "";
    })
    .join("");
}

function extractGeminiText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const candidates = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return "";
  const parts = (
    candidates[0] as
      | {
          content?: { parts?: Array<{ text?: unknown }> };
        }
      | undefined
  )?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function buildConnectionRequestPayload(params: {
  protocol: ProviderProtocol;
  modelName: string;
}): { body: Record<string, unknown>; expectsSse: boolean } {
  if (params.protocol === "codex_responses") {
    return {
      expectsSse: true,
      body: {
        model: params.modelName,
        instructions: "You are a concise assistant. Reply with OK.",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Say OK" }],
          },
        ],
        store: false,
        stream: true,
      },
    };
  }
  if (params.protocol === "responses_api") {
    return {
      expectsSse: false,
      body: {
        model: params.modelName,
        instructions: "You are a concise assistant. Reply with OK.",
        input: "Say OK",
        max_output_tokens: 16,
      },
    };
  }
  if (params.protocol === "openai_chat_compat") {
    return {
      expectsSse: false,
      body: {
        model: params.modelName,
        messages: [{ role: "user", content: "Say OK" }],
        ...(usesMaxCompletionTokens(params.modelName)
          ? { max_completion_tokens: 5 }
          : { max_tokens: 5 }),
      },
    };
  }
  if (params.protocol === "anthropic_messages") {
    return {
      expectsSse: false,
      body: {
        model: params.modelName,
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Say OK" }],
          },
        ],
      },
    };
  }
  if (params.protocol === "ollama_native") {
    return {
      expectsSse: false,
      body: {
        model: params.modelName,
        messages: [{ role: "user", content: "Say OK" }],
        stream: false,
        // Thinking off: the test is about reachability, and a reasoning model
        // would otherwise burn the whole reply on thought.
        think: false,
        options: { num_predict: 16 },
      },
    };
  }
  return {
    expectsSse: false,
    body: {
      contents: [
        {
          role: "user",
          parts: [{ text: "Say OK" }],
        },
      ],
    },
  };
}

function extractConnectionReply(params: {
  protocol: ProviderProtocol;
  rawText: string;
  jsonData?: unknown;
}): string {
  if (params.protocol === "codex_responses") {
    return extractTextFromCodexSSE(params.rawText);
  }
  if (params.protocol === "responses_api") {
    const data = params.jsonData as {
      output_text?: string;
      output?: Array<{
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };
    const outputText = data?.output_text;
    if (typeof outputText === "string" && outputText.trim()) return outputText;
    const content = data?.output?.[0]?.content || [];
    const part = content.find(
      (entry) =>
        entry &&
        (entry.type === "output_text" || entry.type === "text") &&
        typeof entry.text === "string",
    );
    return part?.text || "OK";
  }
  if (params.protocol === "openai_chat_compat") {
    const data = params.jsonData as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data?.choices?.[0]?.message?.content || "OK";
  }
  if (params.protocol === "anthropic_messages") {
    return extractAnthropicText(params.jsonData) || "OK";
  }
  if (params.protocol === "ollama_native") {
    return extractOllamaText(params.jsonData).content || "OK";
  }
  return extractGeminiText(params.jsonData) || "OK";
}

function extractOllamaText(jsonData: unknown): {
  content: string;
  thinking: string;
} {
  const message = (
    jsonData as { message?: { content?: unknown; thinking?: unknown } }
  )?.message;
  return {
    content: typeof message?.content === "string" ? message.content.trim() : "",
    thinking:
      typeof message?.thinking === "string" ? message.thinking.trim() : "",
  };
}

export function getProviderConnectionCapabilityLabel(params: {
  protocol: ProviderProtocol;
  authMode: ModelProviderAuthMode;
  apiBase: string;
  apiKey: string;
  modelName: string;
}): string {
  const request: AgentRuntimeRequest = {
    conversationKey: 0,
    mode: "agent",
    userText: "test",
    model: params.modelName,
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    authMode: params.authMode,
    providerProtocol: params.protocol,
  };
  const resolvedRequest = resolveAgentRuntimeRequest(request);
  const capabilities =
    createAgentModelAdapter(resolvedRequest).getCapabilities(resolvedRequest);
  return describeAgentCapabilityClass(
    getAgentCapabilityClass({
      toolCalls: capabilities.toolCalls,
      fileInputs: capabilities.fileInputs,
    }),
  );
}

export async function runCodexAppServerConnectionTest(params: {
  modelName: string;
  codexPath?: string;
  testZoteroMcp?: boolean;
}): Promise<{
  reply: string;
  capabilityLabel: string;
  mcpConnected: boolean;
}> {
  const processKey = `codex_app_server_connection_test_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
  const processOptions = {
    codexPath: resolveCodexAppServerBinaryPath(params.codexPath),
  };
  const proc = await getOrCreateCodexAppServerProcess(
    processKey,
    processOptions,
  );
  try {
    let mcpConnected = false;
    if (params.testZoteroMcp) {
      await probeCodexZoteroMcpThroughAppServer({
        proc,
      });
      mcpConnected = true;
    }
    let reply: string;
    try {
      reply = await proc.runTurnExclusive(async () => {
        const threadResp = await proc.sendRequest("thread/start", {
          model: params.modelName || undefined,
          ephemeral: true,
          approvalPolicy: "never",
        });
        const threadId = extractCodexAppServerThreadId(threadResp);
        if (!threadId) {
          throw new Error("Codex app-server did not return a thread ID");
        }

        const turnResp = await proc.sendRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: "Say OK" }],
        });
        const turnId = extractCodexAppServerTurnId(turnResp);
        if (!turnId) {
          throw new Error("Codex app-server did not return a turn ID");
        }

        return waitForCodexAppServerTurnCompletion({
          proc,
          turnId,
          cacheKey: processKey,
          processOptions,
        });
      });
    } catch (error) {
      throw new CodexAppServerConnectionTestError(error, mcpConnected);
    }

    const request = {
      conversationKey: 0,
      mode: "agent" as const,
      userText: "",
      authMode: "codex_app_server" as const,
      model: params.modelName,
    } as AgentRuntimeRequest;
    const resolvedRequest = resolveAgentRuntimeRequest(request);
    const capabilities =
      createAgentModelAdapter(resolvedRequest).getCapabilities(resolvedRequest);
    const capabilityLabel = describeAgentCapabilityClass(
      getAgentCapabilityClass({
        toolCalls: capabilities.toolCalls,
        fileInputs: capabilities.fileInputs,
      }),
    );
    return {
      reply: reply.trim() || "OK",
      capabilityLabel,
      mcpConnected,
    };
  } finally {
    destroyCachedCodexAppServerProcess(processKey, undefined, processOptions);
  }
}

export async function runCodexDirectConnectionTest(
  params: CodexAuthDependencies & { modelName?: string } = {},
): Promise<
  | {
      catalogCount: number;
      modelName: string;
      reply: string;
      inferenceError?: never;
    }
  | {
      catalogCount: number;
      modelName: string;
      reply?: never;
      inferenceError: string;
    }
> {
  const { modelName: requestedModelName = "", ...authDependencies } = params;
  const catalog = await loadCodexDirectCatalog({
    force: true,
    ...authDependencies,
  });
  const requestedModel = requestedModelName.trim();
  const catalogModel = requestedModel
    ? catalog.models.find(
        (model) => model.model.toLowerCase() === requestedModel.toLowerCase(),
      )
    : catalog.models[0];
  const modelName = catalogModel?.model || requestedModel;
  if (!modelName)
    throw new Error("Codex Direct returned an empty model catalog");
  if (!catalogModel) {
    return {
      catalogCount: catalog.models.length,
      modelName,
      inferenceError:
        "The selected Codex Direct model is not available in the current catalog.",
    };
  }
  try {
    const response = await fetchWithCodexAuth(
      CODEX_DIRECT_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
          instructions: "You are a concise assistant. Reply with OK.",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Say OK" }],
            },
          ],
          store: false,
          stream: true,
        }),
      },
      authDependencies,
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const reply = extractTextFromCodexSSE(await response.text()).trim();
    if (!reply) throw new Error("The server returned no model output.");
    return { catalogCount: catalog.models.length, modelName, reply };
  } catch (error) {
    return {
      catalogCount: catalog.models.length,
      modelName,
      inferenceError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runProviderConnectionTest(params: {
  fetchFn: typeof fetch;
  protocol: ProviderProtocol;
  authMode: ModelProviderAuthMode;
  apiBase: string;
  apiKey: string;
  modelName: string;
}): Promise<{ reply: string; capabilityLabel: string; warning?: string }> {
  const { body, expectsSse } = buildConnectionRequestPayload({
    protocol: params.protocol,
    modelName: params.modelName,
  });
  const url = resolveProviderTransportEndpoint({
    protocol: params.protocol,
    apiBase: params.apiBase,
    model: params.modelName,
    stream: expectsSse,
    authMode: params.authMode,
  });
  const response = await params.fetchFn(url, {
    method: "POST",
    headers: buildProviderTransportHeaders({
      protocol: params.protocol,
      apiKey: params.apiKey,
      authMode: params.authMode,
    }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  if (expectsSse) {
    const rawText = await response.text();
    const reply = extractConnectionReply({
      protocol: params.protocol,
      rawText,
    }).trim();
    if (!reply) throw new Error("The server returned no model output.");
    return {
      reply,
      capabilityLabel: getProviderConnectionCapabilityLabel(params),
    };
  }
  const jsonData = await response.json();
  return {
    reply: extractConnectionReply({
      protocol: params.protocol,
      rawText: "",
      jsonData,
    }),
    capabilityLabel: getProviderConnectionCapabilityLabel(params),
    ...(resolveEmptyAnswerWarning(params.protocol, jsonData) || {}),
  };
}

// ── Custom-settings checks ───────────────────────────────────────────────────

export type ConnectionSettingsCheck = {
  /** "extra" = the JSON parameter object; "level" = one reasoning level. */
  kind: "extra" | "level";
  /** The level id for kind "level". */
  id?: string;
  ok: boolean;
  /** Server-reported failure, truncated for the status line. */
  error?: string;
};

/**
 * One-level-deep merge so a patch lands inside nested envelopes (`options`,
 * `reasoning`, `generationConfig`) instead of replacing them — mirroring how
 * the real payload builders fold user parameters in.
 */
/**
 * Put a reasoning level's body where its protocol actually reads it.
 *
 * A probe is only worth anything if it sends the request the plugin sends.
 * Gemini's thinking controls live under `generationConfig`; sent at the top
 * level they are not a field of `generateContent` at all, so a level that works
 * would be reported as broken. Only the level body is placed — the open JSON
 * field addresses the whole request and stays exactly where the user put it.
 */
function placeLevelBody(
  protocol: ProviderProtocol,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (protocol !== "gemini_native") return body;
  const nested: Record<string, unknown> = {};
  const top: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    // A body that already names its container is left alone.
    if (key === "generationConfig" || key === "generation_config") {
      top[key] = value;
    } else {
      nested[key] = value;
    }
  }
  if (!Object.keys(nested).length) return top;
  const existing = top.generationConfig;
  return {
    ...top,
    generationConfig: {
      ...(isRecord(existing) ? existing : {}),
      ...nested,
    },
  };
}

function mergeBodyPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key];
    merged[key] =
      isRecord(value) && isRecord(existing) ? { ...existing, ...value } : value;
  }
  return merged;
}

function truncateErrorText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
}

/** POST one probe request with a body patch; report pass/fail, never throw. */
async function postConnectionProbe(params: {
  fetchFn: typeof fetch;
  protocol: ProviderProtocol;
  authMode: ModelProviderAuthMode;
  apiBase: string;
  apiKey: string;
  modelName: string;
  patch: Record<string, unknown>;
}): Promise<{ ok: boolean; error?: string }> {
  const { body, expectsSse } = buildConnectionRequestPayload({
    protocol: params.protocol,
    modelName: params.modelName,
  });
  const url = resolveProviderTransportEndpoint({
    protocol: params.protocol,
    apiBase: params.apiBase,
    model: params.modelName,
    stream: expectsSse,
    authMode: params.authMode,
  });
  try {
    const response = await params.fetchFn(url, {
      method: "POST",
      headers: buildProviderTransportHeaders({
        protocol: params.protocol,
        apiKey: params.apiKey,
        authMode: params.authMode,
      }),
      body: JSON.stringify(mergeBodyPatch(body, params.patch)),
    });
    const rawText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: truncateErrorText(`HTTP ${response.status}: ${rawText}`),
      };
    }
    // Ollama reports some request errors inside a 200 body.
    try {
      const parsed = JSON.parse(rawText) as { error?: unknown };
      if (typeof parsed?.error === "string" && parsed.error) {
        return { ok: false, error: truncateErrorText(parsed.error) };
      }
    } catch {
      // SSE or non-JSON success bodies are fine.
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: truncateErrorText(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

/**
 * Try the user's customized settings against the live server, one request per
 * item, and report which pass. The editor deliberately validates nothing about
 * a level's meaning — users provide ids, the plugin encodes them, and the
 * model is the judge — so this is where the judgement is fetched and shown.
 *
 * Attribution stays clean: the extra JSON is probed alone first, and level
 * probes include it only when it passed, so one bad parameter cannot make
 * every level read as broken.
 */
export async function runProviderSettingsChecks(params: {
  fetchFn: typeof fetch;
  protocol: ProviderProtocol;
  authMode: ModelProviderAuthMode;
  apiBase: string;
  apiKey: string;
  modelName: string;
  profileOverride?: unknown;
}): Promise<ConnectionSettingsCheck[]> {
  const override = normalizeProfileOverride(params.profileOverride);
  if (!override || !profileOverrideAppliesTo(override, params.modelName)) {
    return [];
  }
  const checks: ConnectionSettingsCheck[] = [];
  const probe = (patch: Record<string, unknown>) =>
    postConnectionProbe({ ...params, patch });

  const extraBody = resolveUserExtraBody(override, params.modelName);
  let extraUsable = false;
  if (extraBody) {
    const result = await probe(extraBody);
    extraUsable = result.ok;
    checks.push({ kind: "extra", ok: result.ok, error: result.error });
  }

  const options =
    override.reasoning?.kind === "select" ? override.reasoning.options : [];
  for (const option of options) {
    const declared = option.controls?.body;
    if (!declared || !Object.keys(declared).length) continue;
    const body = placeLevelBody(params.protocol, declared);
    const result = await probe(
      extraBody && extraUsable ? mergeBodyPatch(extraBody, body) : body,
    );
    checks.push({
      kind: "level",
      id: option.id,
      ok: result.ok,
      error: result.error,
    });
  }
  return checks;
}

/**
 * The reply extractors fall back to a literal "OK" when a provider returns no
 * text, which reads as success even though the model answered nothing. For
 * Ollama we can tell the two apart: content empty while thinking is populated
 * is the failure mode behind #363, and the user needs to see it rather than a
 * green tick.
 */
function resolveEmptyAnswerWarning(
  protocol: ProviderProtocol,
  jsonData: unknown,
): { warning: string } | null {
  if (protocol !== "ollama_native") return null;
  const { content, thinking } = extractOllamaText(jsonData);
  if (content || !thinking) return null;
  return {
    warning:
      "The model returned reasoning but no answer. Turn thinking off for " +
      "this model, or pick a different one — some models only produce an " +
      "answer with thinking disabled.",
  };
}
