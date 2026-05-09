import { usesMaxCompletionTokens } from "./apiHelpers";
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
import type { AgentRuntimeRequest } from "../agent/types";
import {
  destroyCachedCodexAppServerProcess,
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  resolveCodexAppServerBinaryPath,
  waitForCodexAppServerTurnCompletion,
} from "./codexAppServerProcess";

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
    return extractTextFromCodexSSE(params.rawText) || "OK";
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
  return extractGeminiText(params.jsonData) || "OK";
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
  const capabilities =
    createAgentModelAdapter(request).getCapabilities(request);
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
}): Promise<{ reply: string; capabilityLabel: string }> {
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
    const reply = await proc.runTurnExclusive(async () => {
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

    const request = {
      conversationKey: 0,
      mode: "agent" as const,
      userText: "",
      authMode: "codex_app_server" as const,
      model: params.modelName,
    } as AgentRuntimeRequest;
    const capabilities =
      createAgentModelAdapter(request).getCapabilities(request);
    const capabilityLabel = describeAgentCapabilityClass(
      getAgentCapabilityClass({
        toolCalls: capabilities.toolCalls,
        fileInputs: capabilities.fileInputs,
      }),
    );
    return { reply: reply.trim() || "OK", capabilityLabel };
  } finally {
    destroyCachedCodexAppServerProcess(processKey, undefined, processOptions);
  }
}

export async function runProviderConnectionTest(params: {
  fetchFn: typeof fetch;
  protocol: ProviderProtocol;
  authMode: ModelProviderAuthMode;
  apiBase: string;
  apiKey: string;
  modelName: string;
}): Promise<{ reply: string; capabilityLabel: string }> {
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
    return {
      reply: extractConnectionReply({
        protocol: params.protocol,
        rawText,
      }),
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
  };
}
