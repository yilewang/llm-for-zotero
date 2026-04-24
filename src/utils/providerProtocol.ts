import { isResponsesBase } from "./apiHelpers";
import { WEBCHAT_TARGETS } from "../webchat/types";

export type ProviderProtocol =
  | "codex_responses"
  | "responses_api"
  | "openai_chat_compat"
  | "anthropic_messages"
  | "gemini_native"
  | "web_sync"; // [webchat]

export type ProviderProtocolSpec = {
  id: ProviderProtocol;
  label: string;
  helperText: string;
  streaming: boolean;
  toolCalls: boolean;
  multimodal: boolean;
  fileInputs: boolean;
  reasoning: boolean;
};

export type AgentCapabilityClass =
  | "full_agent"
  | "agent_without_file_upload"
  | "chat_only";

export const PROVIDER_PROTOCOL_SPECS: ProviderProtocolSpec[] = [
  {
    id: "codex_responses",
    label: "Codex Responses",
    helperText: "Use ChatGPT/Codex auth with the Codex Responses endpoint.",
    streaming: true,
    toolCalls: true,
    multimodal: true,
    fileInputs: false,
    reasoning: true,
  },
  {
    id: "responses_api",
    label: "Responses API",
    helperText: "Use OpenAI-style Responses APIs with tool calls and direct file input.",
    streaming: true,
    toolCalls: true,
    multimodal: true,
    fileInputs: true,
    reasoning: true,
  },
  {
    id: "openai_chat_compat",
    label: "OpenAI-Compatible Chat",
    helperText:
      "Use OpenAI-compatible chat/completions APIs with tool calls, but without direct file input.",
    streaming: false,
    toolCalls: true,
    multimodal: true,
    fileInputs: false,
    reasoning: true,
  },
  {
    id: "anthropic_messages",
    label: "Anthropic Messages",
    helperText:
      "Use Anthropic's native Messages API with streaming tool use and image input.",
    streaming: true,
    toolCalls: true,
    multimodal: true,
    fileInputs: false,
    reasoning: true,
  },
  {
    id: "gemini_native",
    label: "Gemini Native",
    helperText:
      "Use Gemini's native generateContent API with streaming tool calls and image input.",
    streaming: true,
    toolCalls: true,
    multimodal: true,
    fileInputs: false,
    reasoning: true,
  },
  {
    id: "web_sync",
    label: "Web Sync (ChatGPT / DeepSeek)",
    helperText:
      `Relay questions to ${WEBCHAT_TARGETS.map((wt) => wt.label).join(", ")} via the browser extension web-sync bridge.`,
    streaming: false,
    toolCalls: false,
    multimodal: true,
    fileInputs: false,
    reasoning: false,
  },
];

const PROVIDER_PROTOCOL_IDS = new Set<ProviderProtocol>(
  PROVIDER_PROTOCOL_SPECS.map((entry) => entry.id),
);

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === "string" && PROVIDER_PROTOCOL_IDS.has(value as ProviderProtocol);
}

export function getProviderProtocolSpec(
  protocol: ProviderProtocol,
): ProviderProtocolSpec {
  const found = PROVIDER_PROTOCOL_SPECS.find((entry) => entry.id === protocol);
  if (!found) {
    throw new Error(`Unknown provider protocol: ${protocol}`);
  }
  return found;
}

export function inferLegacyProviderProtocol(params: {
  authMode?: string;
  apiBase?: string;
}): ProviderProtocol {
  if (params.authMode === "codex_auth" || params.authMode === "codex_app_server") {
    return "codex_responses";
  }
  if (params.authMode === "copilot_auth") {
    return "openai_chat_compat";
  }
  return isResponsesBase(params.apiBase || "")
    ? "responses_api"
    : "openai_chat_compat";
}

export function normalizeProviderProtocol(
  value: unknown,
  fallback: ProviderProtocol = "openai_chat_compat",
): ProviderProtocol {
  return isProviderProtocol(value) ? value : fallback;
}

export function normalizeProviderProtocolForAuthMode(params: {
  protocol?: unknown;
  authMode?: string;
  apiBase?: string;
  fallback?: ProviderProtocol;
  model?: string;
}): ProviderProtocol {
  const inferred = inferLegacyProviderProtocol(params);
  const fallback = params.fallback || inferred;
  const normalized = normalizeProviderProtocol(params.protocol, fallback);
  if (params.authMode === "codex_auth" || params.authMode === "codex_app_server") {
    return "codex_responses";
  }
  if (params.authMode === "copilot_auth") {
    // Copilot supports both responses_api and openai_chat_compat
    return normalized === "openai_chat_compat" || normalized === "responses_api"
      ? normalized
      : "openai_chat_compat";
  }
  if (params.authMode === "webchat") {
    return "web_sync";
  }
  if (normalized === "codex_responses") {
    return fallback === "codex_responses" ? inferred : fallback;
  }
  return normalized;
}

export function supportsProviderProtocolFileInputs(
  protocol: ProviderProtocol,
): boolean {
  return getProviderProtocolSpec(protocol).fileInputs;
}

export function getAgentCapabilityClass(params: {
  toolCalls: boolean;
  fileInputs: boolean;
}): AgentCapabilityClass {
  if (!params.toolCalls) return "chat_only";
  return params.fileInputs ? "full_agent" : "agent_without_file_upload";
}

export function describeAgentCapabilityClass(
  capabilityClass: AgentCapabilityClass,
): string {
  if (capabilityClass === "full_agent") return "full agent";
  if (capabilityClass === "agent_without_file_upload") {
    return "agent without file upload";
  }
  return "chat-only";
}
