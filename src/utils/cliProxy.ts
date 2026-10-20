import { config } from "../../package.json";

/**
 * The network proxy handed to the command-line runtimes the plugin starts
 * (Codex and Antigravity). It only shapes the environment of those child
 * processes: requests Zotero sends itself follow Zotero's own network
 * settings, and the Claude Code bridge runs with whatever environment it was
 * started in.
 *
 * - "system": each CLI keeps its usual behaviour. Codex reads the macOS
 *   system proxy itself; agy (Go) cannot, so it is given `scutil --proxy`.
 * - "manual": every CLI uses the proxy typed in Settings.
 * - "none": proxy variables are cleared and NO_PROXY=* makes each CLI
 *   connect directly, the system proxy included.
 */
export type CliProxyMode = "system" | "manual" | "none";
export type CliProxyProtocol = "http" | "https" | "socks5";

export const CLI_PROXY_MODES: readonly CliProxyMode[] = [
  "system",
  "manual",
  "none",
];
export const CLI_PROXY_PROTOCOLS: readonly CliProxyProtocol[] = [
  "http",
  "https",
  "socks5",
];

export type CliProxySettings = {
  mode: CliProxyMode;
  protocol: CliProxyProtocol;
  host: string;
  port: string;
};

const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];
const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function prefs(): ZoteroPrefsAPI | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { Prefs?: ZoteroPrefsAPI } })
      .Zotero?.Prefs || null
  );
}

function readPref(key: string): string {
  const value = prefs()?.get?.(`${config.prefsPrefix}.${key}`, true);
  return typeof value === "string" ? value.trim() : "";
}

function writePref(key: string, value: string): void {
  prefs()?.set?.(`${config.prefsPrefix}.${key}`, value, true);
}

export function getCliProxySettings(): CliProxySettings {
  const mode = readPref("cliProxyMode") as CliProxyMode;
  const protocol = readPref("cliProxyProtocol") as CliProxyProtocol;
  return {
    mode: CLI_PROXY_MODES.includes(mode) ? mode : "system",
    protocol: CLI_PROXY_PROTOCOLS.includes(protocol) ? protocol : "http",
    host: readPref("cliProxyHost"),
    port: readPref("cliProxyPort"),
  };
}

export function setCliProxySettings(settings: Partial<CliProxySettings>): void {
  if (settings.mode !== undefined) writePref("cliProxyMode", settings.mode);
  if (settings.protocol !== undefined) {
    writePref("cliProxyProtocol", settings.protocol);
  }
  if (settings.host !== undefined) writePref("cliProxyHost", settings.host);
  if (settings.port !== undefined) writePref("cliProxyPort", settings.port);
}

/** `http://127.0.0.1:7890`, or "" when the host or port is unusable. */
export function formatManualProxyUrl(
  settings: Pick<CliProxySettings, "protocol" | "host" | "port">,
): string {
  const host = settings.host
    .trim()
    .replace(/^[a-z0-9]+:\/\//i, "")
    .replace(/\/+$/, "");
  const port = Number(settings.port.trim());
  if (!host || /\s/.test(host)) return "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "";
  const bracketed = host.includes(":") && !host.startsWith("[");
  return `${settings.protocol}://${bracketed ? `[${host}]` : host}:${port}`;
}

/** Proxy variables pointing every CLI at one proxy URL. */
export function buildProxyVariables(
  httpsProxy: string,
  options: { httpProxy?: string; allProxy?: string } = {},
): Record<string, string> {
  const httpProxy = options.httpProxy || httpsProxy;
  const allProxy = options.allProxy || httpsProxy;
  return {
    HTTPS_PROXY: httpsProxy,
    https_proxy: httpsProxy,
    HTTP_PROXY: httpProxy,
    http_proxy: httpProxy,
    ALL_PROXY: allProxy,
    all_proxy: allProxy,
    NO_PROXY: LOOPBACK_NO_PROXY,
    no_proxy: LOOPBACK_NO_PROXY,
  };
}

/** Clears every inherited proxy and tells each CLI to connect directly. */
export function buildDirectConnectionVariables(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PROXY_VARIABLES) env[key] = "";
  env.NO_PROXY = "*";
  env.no_proxy = "*";
  return env;
}

/**
 * The variables the "manual" and "none" modes impose, or null in "system"
 * mode, where each CLI keeps its own default. A manual proxy with no usable
 * host or port is treated as "system" rather than breaking every turn.
 */
export function getCliProxyOverride(
  settings: CliProxySettings = getCliProxySettings(),
): Record<string, string> | null {
  if (settings.mode === "none") return buildDirectConnectionVariables();
  if (settings.mode === "manual") {
    const url = formatManualProxyUrl(settings);
    return url ? buildProxyVariables(url) : null;
  }
  return null;
}

/**
 * The proxy macOS is set to use, from `scutil --proxy` output. Clash and
 * similar tools in system-proxy mode set the HTTP, HTTPS and SOCKS entries.
 */
export function parseScutilProxy(raw: string): Record<string, string> {
  const fields = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(\S+)\s*$/);
    if (match) fields.set(match[1]!, match[2]!);
  }
  const endpoint = (kind: "HTTPS" | "HTTP" | "SOCKS") => {
    if (fields.get(`${kind}Enable`) !== "1") return "";
    const host = fields.get(`${kind}Proxy`);
    const port = fields.get(`${kind}Port`);
    return host && port ? `${host}:${port}` : "";
  };
  const https = endpoint("HTTPS");
  const http = endpoint("HTTP");
  const socks = endpoint("SOCKS");
  const httpsProxy = https
    ? `http://${https}`
    : http
      ? `http://${http}`
      : socks
        ? `socks5://${socks}`
        : "";
  if (!httpsProxy) return {};
  const env = buildProxyVariables(httpsProxy, {
    httpProxy: http ? `http://${http}` : httpsProxy,
    allProxy: socks ? `socks5://${socks}` : httpsProxy,
  });
  if (!socks) {
    delete env.ALL_PROXY;
    delete env.all_proxy;
  }
  return env;
}
