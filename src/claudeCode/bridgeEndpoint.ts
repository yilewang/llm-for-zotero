/**
 * Where the plugin-managed Claude Code bridge is listening right now.
 *
 * The bridge picks a free port each time it starts, but callers build request
 * URLs synchronously from getClaudeBridgeUrl(). Before the bridge is up they
 * get a placeholder base; claudeBridgeFetch() starts the bridge and rewrites
 * the placeholder, or a base left over from an earlier bridge, to the live one.
 *
 * This module has no imports so prefs.ts can read it without a cycle.
 */

export const MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL =
  "http://127.0.0.1:0/llm-for-zotero-claude-bridge";

let currentBaseUrl = "";
const earlierBaseUrls = new Set<string>();

export function getManagedClaudeBridgeBaseUrl(): string {
  return currentBaseUrl || MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL;
}

export function setManagedClaudeBridgeBaseUrl(baseUrl: string): void {
  if (currentBaseUrl && currentBaseUrl !== baseUrl) {
    earlierBaseUrls.add(currentBaseUrl);
  }
  currentBaseUrl = baseUrl;
}

export function clearManagedClaudeBridgeBaseUrl(): void {
  if (currentBaseUrl) earlierBaseUrls.add(currentBaseUrl);
  currentBaseUrl = "";
}

function startsWithBase(url: string, base: string): boolean {
  if (!url.startsWith(base)) return false;
  const next = url.charAt(base.length);
  return next === "" || next === "/" || next === "?";
}

/**
 * Returns the managed base that `url` starts with (live, placeholder or an
 * earlier one), or "" when the URL is not for the managed bridge.
 */
export function matchManagedClaudeBridgeBase(url: string): string {
  for (const base of [
    currentBaseUrl,
    MANAGED_CLAUDE_BRIDGE_PLACEHOLDER_URL,
    ...earlierBaseUrls,
  ]) {
    if (base && startsWithBase(url, base)) return base;
  }
  return "";
}

export function resetManagedClaudeBridgeEndpointForTests(): void {
  currentBaseUrl = "";
  earlierBaseUrls.clear();
}
