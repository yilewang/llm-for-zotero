/**
 * Environment for agent programs the plugin starts (Codex app-server,
 * Antigravity's `agy acp`).
 *
 * Zotero's own environment can be thin (a GUI launch on macOS has a short
 * PATH), and a system proxy would intercept the agent's calls to the
 * plugin's Zotero MCP server on localhost. These helpers read the real
 * environment and keep loopback traffic off the proxy.
 */

const LOOPBACK_NO_PROXY_ENTRIES = ["localhost", "127.0.0.1", "::1"];

/** A variable from Zotero's environment, trimmed; undefined when empty. */
export function readRuntimeEnvValue(key: string): string | undefined {
  const processValue = (globalThis as any).process?.env?.[key];
  if (typeof processValue === "string" && processValue.trim()) {
    return processValue.trim();
  }
  try {
    const servicesValue = (globalThis as any).Services?.env?.get?.(key);
    if (typeof servicesValue === "string" && servicesValue.trim()) {
      return servicesValue.trim();
    }
  } catch {
    /* no environment service */
  }
  return undefined;
}

/**
 * Joins NO_PROXY lists and adds the loopback hosts, without duplicates
 * (case-insensitive), keeping the first spelling of each entry.
 */
export function mergeLoopbackNoProxyValues(
  ...values: Array<string | undefined>
): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const value of [...values, LOOPBACK_NO_PROXY_ENTRIES.join(",")]) {
    for (const rawEntry of String(value || "").split(",")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries.join(",");
}

/** NO_PROXY and no_proxy for a child, with loopback hosts added. */
export function buildLoopbackNoProxyEnvironment(
  env: Record<string, string | undefined>,
): { NO_PROXY: string; no_proxy: string } {
  const noProxy = mergeLoopbackNoProxyValues(env.NO_PROXY, env.no_proxy);
  return { NO_PROXY: noProxy, no_proxy: noProxy };
}
