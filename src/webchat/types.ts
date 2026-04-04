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
  /** The model name shown in the UI (e.g., "chatgpt.com", "chat.deepseek.com"). */
  modelName: string;
};

/**
 * Central registry of supported webchat targets.
 * To add a new site, add an entry here + adapter in the extension.
 */
export const WEBCHAT_TARGETS = [
  { id: "chatgpt", label: "ChatGPT", defaultHost: "http://127.0.0.1:23119/llm-for-zotero/webchat", modelName: "chatgpt.com" },
  { id: "deepseek", label: "DeepSeek", defaultHost: "http://127.0.0.1:23119/llm-for-zotero/webchat", modelName: "chat.deepseek.com" },
] as const satisfies readonly WebChatTargetEntry[];

export type WebChatTarget = (typeof WEBCHAT_TARGETS)[number]["id"];

export function getWebChatTarget(id: string): WebChatTargetEntry | undefined {
  return WEBCHAT_TARGETS.find((t) => t.id === id);
}

/** Resolve a WebChatTarget from a model name like "chatgpt.com" or "chat.deepseek.com". */
export function getWebChatTargetByModelName(modelName: string): WebChatTargetEntry | undefined {
  return WEBCHAT_TARGETS.find((t) => t.modelName === modelName);
}

export function getDefaultWebChatTarget(): WebChatTargetEntry {
  return WEBCHAT_TARGETS[0];
}
