import type { AgentRuntimeRequest } from "../types";
import {
  normalizeProviderProtocolForAuthMode,
  type ProviderProtocol,
} from "../../utils/providerProtocol";
import { isGeminiBase } from "../../utils/apiHelpers";
import { providerSupportsResponsesEndpoint } from "../../utils/providerPresets";
import type { AgentModelAdapter } from "./adapter";
import { CodexResponsesAgentAdapter } from "./codexResponses";
import { OpenAIResponsesAgentAdapter } from "./openaiResponses";
import { OpenAIChatCompatAgentAdapter } from "./openaiCompatible";
import { AnthropicMessagesAgentAdapter } from "./anthropicMessages";
import { GeminiNativeAgentAdapter } from "./geminiNative";

export function resolveRequestProviderProtocol(
  request: Pick<AgentRuntimeRequest, "providerProtocol" | "authMode" | "apiBase">,
): ProviderProtocol {
  return normalizeProviderProtocolForAuthMode({
    protocol: request.providerProtocol,
    authMode: request.authMode,
    apiBase: request.apiBase,
  });
}

export function createAgentModelAdapter(
  request: AgentRuntimeRequest,
): AgentModelAdapter {
  const protocol = resolveRequestProviderProtocol(request);
  if (
    protocol === "openai_chat_compat" &&
    isGeminiBase((request.apiBase || "").trim())
  ) {
    // Gemini's OpenAI-compatible chat endpoint drops thought signatures on
    // returned tool calls, which breaks multi-step agent continuation.
    return new GeminiNativeAgentAdapter();
  }
  if (protocol === "codex_responses") {
    return new CodexResponsesAgentAdapter();
  }
  if (protocol === "responses_api") {
    // Only use the Responses adapter (which uploads files via /v1/files)
    // for providers that actually host that endpoint.  Third-party relays
    // fall back to the chat-compat adapter which sends PDFs as base64
    // data URIs inside image_url content parts.
    if (providerSupportsResponsesEndpoint(request.apiBase || "")) {
      return new OpenAIResponsesAgentAdapter();
    }
    return new OpenAIChatCompatAgentAdapter();
  }
  if (protocol === "anthropic_messages") {
    return new AnthropicMessagesAgentAdapter();
  }
  if (protocol === "gemini_native") {
    return new GeminiNativeAgentAdapter();
  }
  return new OpenAIChatCompatAgentAdapter();
}
