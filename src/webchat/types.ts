/**
 * [webchat] Type definitions for the WebChat integration.
 *
 * Each WebChatTarget represents a web-based LLM chat service that can be
 * automated via a browser extension (e.g., ChatGPT via the sync-for-zotero
 * Chrome extension).
 */

export type WebChatTargetEntry = {
  id: string;
  label: string;
  defaultHost: string;
  /** Canonical model/site name used for prefs, routing, and history matching. */
  modelName: string;
  /** Exact HTTPS host accepted from extension heartbeats and history URLs. */
  hostname: string;
  /** Short UI label for tight status/header surfaces. */
  displayName: string;
  /** Provider-specific, observed path shape for an existing conversation. */
  conversationPathPattern: RegExp;
  /** Capture capability required before this target can be dispatched. */
  answerCapture: "network" | "dom";
};

/**
 * Central registry of supported webchat targets.
 * To add a new site, add an entry here + adapter in the extension.
 */
export const WEBCHAT_TARGETS = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    defaultHost: "http://127.0.0.1:23119/llm-for-zotero/webchat",
    modelName: "chatgpt.com",
    hostname: "chatgpt.com",
    displayName: "chatgpt",
    conversationPathPattern: /^\/c\/([A-Za-z0-9_-]+)\/?$/,
    answerCapture: "network",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultHost: "http://127.0.0.1:23119/llm-for-zotero/webchat",
    modelName: "chat.deepseek.com",
    hostname: "chat.deepseek.com",
    displayName: "deepseek",
    conversationPathPattern: /^\/a\/chat\/s\/([A-Za-z0-9_-]+)\/?$/,
    answerCapture: "network",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    defaultHost: "http://127.0.0.1:23119/llm-for-zotero/webchat",
    modelName: "gemini.google.com",
    hostname: "gemini.google.com",
    displayName: "gemini",
    conversationPathPattern: /^\/app\/([a-f0-9]{16})\/?$/,
    answerCapture: "dom",
  },
] as const satisfies readonly WebChatTargetEntry[];

export type WebChatTarget = (typeof WEBCHAT_TARGETS)[number]["id"];

export function getWebChatTarget(id: string): WebChatTargetEntry | undefined {
  return WEBCHAT_TARGETS.find((t) => t.id === id);
}

/** Resolve a WebChatTarget from a model name like "chatgpt.com" or "chat.deepseek.com". */
export function getWebChatTargetByModelName(
  modelName: string,
): WebChatTargetEntry | undefined {
  return WEBCHAT_TARGETS.find((t) => t.modelName === modelName);
}

/** Resolve only canonical HTTPS provider URLs; lookalike and www hosts fail. */
export function getWebChatTargetByUrl(
  value: string | null | undefined,
): WebChatTargetEntry | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port
    ) {
      return undefined;
    }
    return WEBCHAT_TARGETS.find((target) => parsed.host === target.hostname);
  } catch {
    return undefined;
  }
}

export function isWebChatUrlForTarget(
  value: string | null | undefined,
  targetId: string | null | undefined,
): boolean {
  return getWebChatTargetByUrl(value)?.id === targetId;
}

/** Extract a provider conversation id only from its observed canonical path. */
export function getWebChatConversationId(
  value: string | null | undefined,
  expectedTargetId?: string | null,
): string | null {
  const target = getWebChatTargetByUrl(value);
  if (!target || (expectedTargetId && target.id !== expectedTargetId)) {
    return null;
  }
  try {
    const match = new URL(value as string).pathname.match(
      target.conversationPathPattern,
    );
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export function getWebChatTargetDisplayName(modelName: string): string {
  return getWebChatTargetByModelName(modelName)?.displayName || modelName;
}

export function getDefaultWebChatTarget(): WebChatTargetEntry {
  return WEBCHAT_TARGETS[0];
}
