import {
  buildZoteroMcpConfigValue,
  getZoteroMcpAllowedToolNames,
  getZoteroMcpServerName,
  getZoteroMcpServerUrl,
  ZOTERO_MCP_SERVER_NAME,
  ZOTERO_MCP_SCOPE_HEADER,
} from "../agent/mcp/server";
import { MCP_METHODS } from "../agent/mcp/protocol";
import {
  getOrCreateCodexAppServerProcess,
  resolveCodexAppServerBinaryPath,
  type CodexAppServerProcess,
} from "../utils/codexAppServerProcess";

const DEFAULT_CODEX_APP_SERVER_NATIVE_PROCESS_KEY = "codex_app_server_native";
const MCP_PREFLIGHT_SUCCESS_TTL_MS = 5 * 60 * 1000;
const MCP_PREFLIGHT_FAILURE_TTL_MS = 10 * 1000;
export const REQUIRED_CODEX_ZOTERO_MCP_TOOL_NAMES = [
  "query_library",
  "read_library",
] as const;

export type CodexNativeMcpSetupStatus = {
  enabled: boolean;
  serverName: string;
  serverUrl: string;
  configured: boolean;
  connected: boolean | null;
  toolNames: string[];
  config?: unknown;
  mcpStatus?: unknown;
  skills?: unknown;
  plugins?: unknown;
  errors: string[];
};

type SetupParams = {
  codexPath?: string;
  processKey?: string;
  proc?: CodexAppServerProcess;
  serverName?: string;
  serverUrl?: string;
  scopeToken?: string;
  required?: boolean;
};

type PreflightCacheEntry =
  | {
      expiresAt: number;
      ok: true;
      status: CodexNativeMcpSetupStatus;
    }
  | {
      expiresAt: number;
      ok: false;
      error: string;
    };

const preflightCache = new Map<string, PreflightCacheEntry>();

export function clearCodexZoteroMcpPreflightCache(): void {
  preflightCache.clear();
}

async function resolveProcess(
  params: SetupParams,
): Promise<CodexAppServerProcess> {
  if (params.proc) return params.proc;
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  return getOrCreateCodexAppServerProcess(
    params.processKey || DEFAULT_CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
}

async function sendOptional(
  proc: CodexAppServerProcess,
  method: string,
  params?: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await proc.sendRequest(method, params) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function collectToolNames(value: unknown, names = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectToolNames(entry, names);
    return Array.from(names);
  }
  if (!value || typeof value !== "object") return Array.from(names);
  const record = value as Record<string, unknown>;
  const type = normalizeString(record.type).toLowerCase();
  const name = normalizeString(record.name);
  if (name && (!type || type.includes("tool") || record.inputSchema)) {
    names.add(name);
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") collectToolNames(nested, names);
  }
  return Array.from(names);
}

function objectContainsServerName(value: unknown, serverName: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => objectContainsServerName(entry, serverName));
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of ["name", "serverName", "id"]) {
    if (normalizeString(record[key]) === serverName) return true;
  }
  return Object.values(record).some((entry) =>
    objectContainsServerName(entry, serverName),
  );
}

function objectContainsServerUrl(value: unknown, serverUrl: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => objectContainsServerUrl(entry, serverUrl));
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    Object.values(record).some((entry) => normalizeString(entry) === serverUrl)
  ) {
    return true;
  }
  return Object.values(record).some((entry) =>
    objectContainsServerUrl(entry, serverUrl),
  );
}

function resolveConnected(mcpStatus: unknown, serverName: string): boolean | null {
  if (!mcpStatus) return null;
  if (!objectContainsServerName(mcpStatus, serverName)) return false;
  const serialized = JSON.stringify(mcpStatus).toLowerCase();
  if (
    serialized.includes('"status":"failed"') ||
    serialized.includes('"status":"error"') ||
    serialized.includes('"authstatus":"error"')
  ) {
    return false;
  }
  return true;
}

function getFetch(): typeof fetch {
  const fetchFn = (globalThis as typeof globalThis & { fetch?: typeof fetch })
    .fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("fetch is unavailable for Zotero MCP preflight");
  }
  return fetchFn.bind(globalThis);
}

function getConfigHeaders(configValue: Record<string, unknown>): Record<string, string> {
  const rawHeaders = configValue.http_headers;
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(rawHeaders as Record<string, unknown>).map(([key, value]) => [
      key,
      String(value || ""),
    ]),
  );
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function buildPreflightConfigSignature(
  configValue: Record<string, unknown>,
): Record<string, unknown> {
  const headers = getConfigHeaders(configValue);
  const stableHeaders = Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => key.toLowerCase() !== ZOTERO_MCP_SCOPE_HEADER.toLowerCase())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, hashString(value)]),
  );
  const toolApprovals =
    configValue.tools && typeof configValue.tools === "object"
      ? Object.fromEntries(
          Object.entries(configValue.tools as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, value]) => [
              name,
              typeof value === "object" && value
                ? (value as Record<string, unknown>).approval_mode
                : value,
            ]),
        )
      : {};
  return {
    required: Boolean(configValue.required),
    defaultToolsApprovalMode: configValue.default_tools_approval_mode,
    enabledTools: Array.isArray(configValue.enabled_tools)
      ? [...configValue.enabled_tools].map(String).sort()
      : [],
    tools: toolApprovals,
    headers: stableHeaders,
  };
}

export function buildCodexZoteroMcpPreflightCacheKey(params: {
  serverName: string;
  serverUrl: string;
  configValue: Record<string, unknown>;
}): string {
  return JSON.stringify({
    serverName: params.serverName,
    serverUrl: params.serverUrl,
    config: buildPreflightConfigSignature(params.configValue),
  });
}

function buildStatusConfig(
  serverName: string,
  configValue: Record<string, unknown>,
): Record<string, unknown> {
  return {
    mcp_servers: {
      [serverName]: configValue,
    },
  };
}

function clonePreflightStatusForConfig(params: {
  status: CodexNativeMcpSetupStatus;
  serverName: string;
  serverUrl: string;
  configValue: Record<string, unknown>;
}): CodexNativeMcpSetupStatus {
  return {
    ...params.status,
    serverName: params.serverName,
    serverUrl: params.serverUrl,
    config: buildStatusConfig(params.serverName, params.configValue),
    toolNames: [...params.status.toolNames],
    errors: [...params.status.errors],
  };
}

async function postMcpJson(params: {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}): Promise<unknown> {
  const response = await getFetch()(params.url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify(params.payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status}${text.trim() ? `: ${text.trim().slice(0, 240)}` : ""}`,
    );
  }
  if (response.status === 202 || response.status === 204) {
    return undefined;
  }
  const text = await response.text();
  if (!text.trim()) return undefined;
  const parsed = JSON.parse(text) as {
    result?: unknown;
    error?: { message?: unknown };
  };
  if (parsed.error) {
    throw new Error(String(parsed.error.message || JSON.stringify(parsed.error)));
  }
  return parsed.result;
}

export async function preflightCodexZoteroMcpServer(params: {
  serverName?: string;
  scopeToken?: string;
  required?: boolean;
} = {}): Promise<CodexNativeMcpSetupStatus> {
  const serverName = params.serverName || ZOTERO_MCP_SERVER_NAME;
  const cacheConfigValue = buildZoteroMcpConfigValue({
    required: params.required,
  });
  const configValue = buildZoteroMcpConfigValue({
    scopeToken: params.scopeToken,
    required: params.required,
  });
  const serverUrl =
    typeof configValue.url === "string" && configValue.url.trim()
      ? configValue.url.trim()
      : getZoteroMcpServerUrl();
  const headers = getConfigHeaders(configValue);
  const cacheKey = buildCodexZoteroMcpPreflightCacheKey({
    serverName,
    serverUrl,
    configValue: cacheConfigValue,
  });
  const now = Date.now();
  const cached = preflightCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if (!cached.ok) throw new Error(cached.error);
    return clonePreflightStatusForConfig({
      status: cached.status,
      serverName,
      serverUrl,
      configValue,
    });
  }
  if (cached) preflightCache.delete(cacheKey);

  try {
    await postMcpJson({
      url: serverUrl,
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: MCP_METHODS.INITIALIZE,
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "llm-for-zotero-codex-preflight",
            version: "1.0.0",
          },
        },
      },
    });
    await postMcpJson({
      url: serverUrl,
      headers,
      payload: {
        jsonrpc: "2.0",
        method: MCP_METHODS.INITIALIZED,
      },
    });
    const toolsResult = await postMcpJson({
      url: serverUrl,
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: MCP_METHODS.TOOLS_LIST,
        params: {},
      },
    });
    const status: CodexNativeMcpSetupStatus = {
      enabled: true,
      serverName,
      serverUrl,
      configured: true,
      connected: true,
      toolNames: collectToolNames(toolsResult).filter((name) =>
        getZoteroMcpAllowedToolNames().includes(name),
      ),
      config: buildStatusConfig(serverName, configValue),
      mcpStatus: toolsResult,
      errors: [],
    };
    preflightCache.set(cacheKey, {
      expiresAt: now + MCP_PREFLIGHT_SUCCESS_TTL_MS,
      ok: true,
      status,
    });
    return clonePreflightStatusForConfig({
      status,
      serverName,
      serverUrl,
      configValue,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    preflightCache.set(cacheKey, {
      expiresAt: now + MCP_PREFLIGHT_FAILURE_TTL_MS,
      ok: false,
      error: message,
    });
    throw error;
  }
}

export async function readCodexNativeMcpSetupStatus(
  params: SetupParams = {},
): Promise<CodexNativeMcpSetupStatus> {
  const proc = await resolveProcess(params);
  const errors: string[] = [];
  const serverName = params.serverName || ZOTERO_MCP_SERVER_NAME;
  const serverUrl = params.serverUrl || getZoteroMcpServerUrl();

  const [configResult, statusResult, skillsResult, pluginsResult] =
    await Promise.all([
      sendOptional(proc, "config/read"),
      sendOptional(proc, "mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        limit: 100,
      }),
      sendOptional(proc, "skills/list", { cwds: [] }),
      sendOptional(proc, "plugin/list", { limit: 100 }),
    ]);

  for (const result of [
    configResult,
    statusResult,
    skillsResult,
    pluginsResult,
  ]) {
    if (!result.ok) errors.push(result.error);
  }

  const configValue = configResult.ok ? configResult.value : undefined;
  const mcpStatus = statusResult.ok ? statusResult.value : undefined;
  return {
    enabled: true,
    serverName,
    serverUrl,
    configured:
      objectContainsServerName(configValue, serverName) ||
      objectContainsServerUrl(configValue, serverUrl),
    connected: resolveConnected(mcpStatus, serverName),
    toolNames: collectToolNames(mcpStatus).filter((name) =>
      getZoteroMcpAllowedToolNames().includes(name),
    ),
    config: configValue,
    mcpStatus,
    skills: skillsResult.ok ? skillsResult.value : undefined,
    plugins: pluginsResult.ok ? pluginsResult.value : undefined,
    errors,
  };
}

export async function installOrUpdateCodexZoteroMcpConfig(
  params: SetupParams = {},
): Promise<CodexNativeMcpSetupStatus> {
  clearCodexZoteroMcpPreflightCache();
  const proc = await resolveProcess(params);
  const serverName = params.serverName || ZOTERO_MCP_SERVER_NAME;
  const value = buildZoteroMcpConfigValue({
    scopeToken: params.scopeToken,
    required: params.required,
  });
  const dottedKeyPath = `mcp_servers.${serverName}`;
  const arrayKeyPath = ["mcp_servers", serverName];
  const writeAttempts = [
    { keyPath: dottedKeyPath, mergeStrategy: "upsert", value },
    { keyPath: dottedKeyPath, mergeStrategy: "replace", value },
    { keyPath: arrayKeyPath, value },
    { key: dottedKeyPath, value },
    { path: arrayKeyPath, value },
  ];
  const errors: string[] = [];
  let wroteConfig = false;
  for (const attempt of writeAttempts) {
    const result = await sendOptional(proc, "config/value/write", attempt);
    if (result.ok) {
      wroteConfig = true;
      break;
    }
    errors.push(result.error);
  }
  if (!wroteConfig) {
    throw new Error(`Failed to write Codex MCP config: ${errors.join("; ")}`);
  }

  const reload = await sendOptional(proc, "config/mcpServer/reload", {});
  if (!reload.ok) {
    ztoolkit.log("Codex app-server MCP reload failed", reload.error);
  }

  clearCodexZoteroMcpPreflightCache();
  return readCodexNativeMcpSetupStatus({ ...params, proc });
}

export async function ensureCodexZoteroMcpConfig(
  params: SetupParams = {},
): Promise<void> {
  await installOrUpdateCodexZoteroMcpConfig(params);
}

export function buildCodexZoteroMcpThreadConfig(params: {
  profileSignature?: string;
  scopeToken?: string;
  required?: boolean;
}): { serverName: string; config: Record<string, unknown> } {
  const serverName = getZoteroMcpServerName(params.profileSignature);
  return {
    serverName,
    config: {
      features: {
        shell_tool: false,
      },
      mcp_servers: {
        [serverName]: buildZoteroMcpConfigValue({
          scopeToken: params.scopeToken,
          required: params.required,
        }),
      },
    },
  };
}

export function assertRequiredCodexZoteroMcpToolsReady(
  status: CodexNativeMcpSetupStatus,
  requiredToolNames: readonly string[] = REQUIRED_CODEX_ZOTERO_MCP_TOOL_NAMES,
): void {
  const missing = requiredToolNames.filter(
    (name) => !status.toolNames.includes(name),
  );
  if (status.connected !== true || missing.length > 0) {
    const reason =
      status.connected === false
        ? "server is not connected"
        : status.connected === null
          ? "server status is unavailable"
          : `missing required tools: ${missing.join(", ")}`;
    throw new Error(
      `Zotero MCP tools are not ready for ${status.serverName}: ${reason}`,
    );
  }
}
