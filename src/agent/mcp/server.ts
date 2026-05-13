/**
 * MCP (Model Context Protocol) server for the llm-for-zotero plugin.
 *
 * Registers a JSON-RPC 2.0 endpoint on Zotero's built-in HTTP server at
 * "/llm-for-zotero/mcp". The endpoint is intended for local Codex app-server
 * use and requires a bearer token.
 */

import { config } from "../../../package.json";
import type { PaperContextRef } from "../../shared/types";
import { readNoteSnapshot } from "../../modules/contextPanel/noteSnapshot";
import type { AgentToolRegistry } from "../tools/registry";
import type { ZoteroGateway } from "../services/zoteroGateway";
import type {
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentRuntimeRequest,
  AgentToolContext,
  PreparedToolExecution,
  ToolSpec,
} from "../types";
import {
  MCP_METHODS,
  RPC_ERRORS,
  makeError,
  makeResult,
  type JsonRpcRequest,
  type McpServerInfo,
  type McpToolCallParams,
  type McpToolCallResult,
  type McpToolDefinition,
  type McpToolsListResult,
} from "./protocol";

export const ZOTERO_MCP_SERVER_NAME = "llm_for_zotero";
export const ZOTERO_MCP_ENDPOINT_PATH = "/llm-for-zotero/mcp";
export const ZOTERO_MCP_AUTH_HEADER = "Authorization";
export const ZOTERO_MCP_SCOPE_HEADER = "X-LLM-For-Zotero-Scope";
export const ZOTERO_MCP_TOKEN_PREF_KEY = `${config.prefsPrefix}.codexZoteroMcpBearerToken`;

const SERVER_VERSION = "1.0.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_ZOTERO_HTTP_PORT = 23119;
const SCOPED_MCP_SCOPE_TTL_MS = 2 * 60 * 60 * 1000;
export const ZOTERO_MCP_SAFE_READ_TOOL_NAMES = [
  "library_search",
  "library_read",
  "paper_read",
  "literature_search",
  "web_search",
] as const;
export const ZOTERO_MCP_WRITE_TOOL_NAMES = [
  "library_update",
  "collection_update",
  "note_write",
  "library_import",
  "library_delete",
  "attachment_update",
  "run_command",
  "file_io",
  "zotero_script",
  "undo_last_action",
] as const;
const CURATED_READ_TOOL_NAMES = new Set<string>(
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
);
const CURATED_WRITE_TOOL_NAMES = new Set<string>(ZOTERO_MCP_WRITE_TOOL_NAMES);
const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
} as const;
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
} as const;
const DESTRUCTIVE_WRITE_TOOL_NAMES = new Set<string>(["library_delete"]);
const DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS = {
  ...WRITE_TOOL_ANNOTATIONS,
  destructiveHint: true,
} as const;
const MCP_SCOPE_ARG_NAMES = new Set([
  "libraryID",
  "libraryId",
  "activeItemId",
  "activeItemID",
  "activeContextItemId",
  "activeContextItemID",
]);
const CODEX_MCP_TOOL_APPROVAL_MODE = "approve";
const MCP_READ_DEDUPE_TTL_MS = 2 * 60 * 1000;
const MCP_READ_DEDUPE_TOOL_NAMES = new Set([
  "library_search",
  "library_read",
  "paper_read",
]);
const MCP_TOOLS_WITH_OWN_CONFIRMATION_POLICY = new Set([
  "run_command",
  "file_io",
  "zotero_script",
]);

export type ZoteroMcpActiveScope = {
  profileSignature?: string;
  conversationKey?: number;
  libraryID?: number;
  kind?: "global" | "paper";
  paperItemID?: number;
  activeItemId?: number;
  activeContextItemId?: number;
  activeNoteId?: number;
  activeNoteKind?: "item" | "standalone";
  activeNoteTitle?: string;
  activeNoteParentItemId?: number;
  libraryName?: string;
  title?: string;
  userText?: string;
  paperContext?: PaperContextRef;
};

type McpServerDeps = {
  toolRegistry: AgentToolRegistry;
  zoteroGateway: ZoteroGateway;
};

type EndpointOptions = {
  method: string;
  data: unknown;
  headers?: Record<string, string>;
};

type McpHttpResponse = {
  status: number;
  contentType: string;
  body: string;
};

const scopedZoteroMcpScopes = new Map<
  string,
  { createdAt: number; expiresAt: number; scope: ZoteroMcpActiveScope }
>();
let activeZoteroMcpScope: ZoteroMcpActiveScope | null = null;
let registeredMcpDeps: McpServerDeps | null = null;
const mcpReadDedupeCache = new Map<
  string,
  { expiresAt: number; result: McpToolCallResult }
>();

export type ZoteroMcpToolActivityEvent = {
  requestId: string;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  serverName: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  profileSignature?: string;
  conversationKey?: number;
  libraryID?: number;
  kind?: "global" | "paper";
  timestamp: number;
};

type ZoteroMcpToolActivityObserver = (
  event: ZoteroMcpToolActivityEvent,
) => void;

const zoteroMcpToolActivityObservers = new Set<ZoteroMcpToolActivityObserver>();

export type ZoteroMcpConfirmationRequest = {
  requestId: string;
  action: AgentPendingAction;
  toolName: string;
  scope: ZoteroMcpActiveScope | null;
};

type ZoteroMcpConfirmationHandler = (
  request: ZoteroMcpConfirmationRequest,
) => AgentConfirmationResolution | Promise<AgentConfirmationResolution>;

const zoteroMcpConfirmationHandlers = new Set<{
  scope: ZoteroMcpActiveScope;
  handler: ZoteroMcpConfirmationHandler;
}>();

export function addZoteroMcpToolActivityObserver(
  observer: ZoteroMcpToolActivityObserver,
): () => void {
  zoteroMcpToolActivityObservers.add(observer);
  return () => {
    zoteroMcpToolActivityObservers.delete(observer);
  };
}

function emitZoteroMcpToolActivity(event: ZoteroMcpToolActivityEvent): void {
  for (const observer of zoteroMcpToolActivityObservers) {
    try {
      observer(event);
    } catch {
      /* observer errors must not affect MCP tool execution */
    }
  }
}

function logZoteroMcp(message: string, details?: unknown): void {
  try {
    (
      globalThis as typeof globalThis & {
        ztoolkit?: { log?: (...args: unknown[]) => void };
      }
    ).ztoolkit?.log?.(message, details);
  } catch {
    /* diagnostics must not affect MCP execution */
  }
}

export function addZoteroMcpConfirmationHandler(
  scope: ZoteroMcpActiveScope,
  handler: ZoteroMcpConfirmationHandler,
): () => void {
  const entry = { scope: normalizeActiveScope(scope), handler };
  zoteroMcpConfirmationHandlers.add(entry);
  return () => {
    zoteroMcpConfirmationHandlers.delete(entry);
  };
}

function getZoteroPrefs(): {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
} | null {
  return (
    (
      Zotero as unknown as
        | {
            Prefs?: {
              get?: (key: string, global?: boolean) => unknown;
              set?: (key: string, value: unknown, global?: boolean) => void;
            };
          }
        | undefined
    )?.Prefs || null
  );
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getOrCreateZoteroMcpBearerToken(): string {
  const prefs = getZoteroPrefs();
  const existing = prefs?.get?.(ZOTERO_MCP_TOKEN_PREF_KEY, true);
  if (typeof existing === "string" && existing.trim().length >= 32) {
    return existing.trim();
  }
  const token = generateToken();
  prefs?.set?.(ZOTERO_MCP_TOKEN_PREF_KEY, token, true);
  return token;
}

export function resetZoteroMcpBearerToken(): string {
  const token = generateToken();
  getZoteroPrefs()?.set?.(ZOTERO_MCP_TOKEN_PREF_KEY, token, true);
  return token;
}

export function getZoteroHttpPort(): number {
  const raw = (
    Zotero as unknown as {
      Prefs?: { get?: (key: string, global?: boolean) => unknown };
    }
  )?.Prefs?.get?.("httpServer.port");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_ZOTERO_HTTP_PORT;
}

export function getZoteroMcpServerUrl(): string {
  return `http://127.0.0.1:${getZoteroHttpPort()}${ZOTERO_MCP_ENDPOINT_PATH}`;
}

export function getZoteroMcpAllowedToolNames(): string[] {
  return [
    ...Array.from(CURATED_READ_TOOL_NAMES),
    ...Array.from(CURATED_WRITE_TOOL_NAMES),
  ];
}

function getZoteroMcpToolApprovalOverrides(): Record<
  string,
  { approval_mode: typeof CODEX_MCP_TOOL_APPROVAL_MODE }
> {
  return Object.fromEntries(
    getZoteroMcpAllowedToolNames().map((name) => [
      name,
      { approval_mode: CODEX_MCP_TOOL_APPROVAL_MODE },
    ]),
  );
}

function normalizeServerNamePart(value: unknown): string {
  const normalized = normalizeText(value, 128)
    ?.replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || "";
}

export function getZoteroMcpServerName(profileSignature?: string): string {
  const suffix = normalizeServerNamePart(profileSignature);
  return suffix
    ? `${ZOTERO_MCP_SERVER_NAME}_${suffix}`
    : ZOTERO_MCP_SERVER_NAME;
}

export function buildZoteroMcpConfigValue(
  params: {
    scopeToken?: string;
    required?: boolean;
  } = {},
): Record<string, unknown> {
  const token = getOrCreateZoteroMcpBearerToken();
  const scopeToken = normalizeText(params.scopeToken, 256);
  return {
    url: getZoteroMcpServerUrl(),
    ...(params.required ? { required: true } : {}),
    default_tools_approval_mode: CODEX_MCP_TOOL_APPROVAL_MODE,
    tools: getZoteroMcpToolApprovalOverrides(),
    http_headers: {
      [ZOTERO_MCP_AUTH_HEADER]: `Bearer ${token}`,
      ...(scopeToken ? { [ZOTERO_MCP_SCOPE_HEADER]: scopeToken } : {}),
    },
    enabled_tools: getZoteroMcpAllowedToolNames(),
  };
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function normalizePaperContext(
  value: PaperContextRef | undefined,
): PaperContextRef | undefined {
  if (!value) return undefined;
  const itemId = normalizePositiveInt(value.itemId);
  const contextItemId = normalizePositiveInt(value.contextItemId);
  if (!itemId || !contextItemId) return undefined;
  return {
    itemId,
    contextItemId,
    title: normalizeText(value.title) || `Paper ${itemId}`,
    attachmentTitle: normalizeText(value.attachmentTitle),
    citationKey: normalizeText(value.citationKey),
    firstCreator: normalizeText(value.firstCreator),
    year: normalizeText(value.year, 32),
    mineruCacheDir: normalizeText(value.mineruCacheDir, 1024),
  };
}

function normalizeNoteKind(value: unknown): "item" | "standalone" | undefined {
  return value === "item" || value === "standalone" ? value : undefined;
}

function normalizeActiveScope(
  scope: ZoteroMcpActiveScope,
): ZoteroMcpActiveScope {
  const paperContext = normalizePaperContext(scope.paperContext);
  const paperItemID =
    normalizePositiveInt(scope.paperItemID) || paperContext?.itemId;
  const activeContextItemId =
    normalizePositiveInt(scope.activeContextItemId) ||
    paperContext?.contextItemId;
  return {
    profileSignature: normalizeText(scope.profileSignature, 128),
    conversationKey: normalizePositiveInt(scope.conversationKey),
    libraryID: normalizePositiveInt(scope.libraryID),
    kind: scope.kind === "paper" ? "paper" : "global",
    paperItemID,
    activeItemId:
      normalizePositiveInt(scope.activeItemId) || paperItemID || undefined,
    activeContextItemId,
    activeNoteId: normalizePositiveInt(scope.activeNoteId),
    activeNoteKind: normalizeNoteKind(scope.activeNoteKind),
    activeNoteTitle: normalizeText(scope.activeNoteTitle),
    activeNoteParentItemId: normalizePositiveInt(scope.activeNoteParentItemId),
    libraryName: normalizeText(scope.libraryName),
    title: normalizeText(scope.title),
    userText: normalizeText(scope.userText, 4000),
    paperContext,
  };
}

function pruneExpiredScopedMcpScopes(): void {
  const now = Date.now();
  for (const [token, entry] of scopedZoteroMcpScopes) {
    if (entry.expiresAt <= now) scopedZoteroMcpScopes.delete(token);
  }
}

export function registerScopedZoteroMcpScope(
  scope: ZoteroMcpActiveScope,
  options: { ttlMs?: number; token?: string } = {},
): { token: string; clear: () => void } {
  pruneExpiredScopedMcpScopes();
  const token = normalizeText(options.token, 256) || generateToken();
  const ttlMs =
    Number.isFinite(options.ttlMs) && Number(options.ttlMs) > 0
      ? Math.floor(Number(options.ttlMs))
      : SCOPED_MCP_SCOPE_TTL_MS;
  scopedZoteroMcpScopes.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    scope: normalizeActiveScope(scope),
  });
  return {
    token,
    clear: () => {
      scopedZoteroMcpScopes.delete(token);
    },
  };
}

export function setActiveZoteroMcpScope(
  scope: ZoteroMcpActiveScope,
): () => void {
  const normalized = normalizeActiveScope(scope);
  activeZoteroMcpScope = normalized;
  return () => {
    if (activeZoteroMcpScope === normalized) activeZoteroMcpScope = null;
  };
}

export function getActiveZoteroMcpScope(): ZoteroMcpActiveScope | null {
  return activeZoteroMcpScope ? { ...activeZoteroMcpScope } : null;
}

function getHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  if (!headers) return "";
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return String(value || "");
  }
  return "";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function pruneExpiredMcpReadDedupeCache(): void {
  const now = Date.now();
  for (const [key, entry] of mcpReadDedupeCache) {
    if (entry.expiresAt <= now) mcpReadDedupeCache.delete(key);
  }
}

function buildMcpReadDedupeKey(params: {
  toolName: string;
  toolArgs: unknown;
  headers?: Record<string, string>;
}): string | null {
  if (!MCP_READ_DEDUPE_TOOL_NAMES.has(params.toolName)) return null;
  const scopeToken = getHeader(params.headers, ZOTERO_MCP_SCOPE_HEADER).trim();
  const scope = resolveScopedMcpScope(params.headers);
  const scopeKey = scopeToken
    ? `token:${scopeToken}`
    : [
        "scope",
        scope?.profileSignature || "",
        scope?.conversationKey || "",
        scope?.libraryID || "",
        scope?.kind || "",
        normalizeText(scope?.userText, 512) || "",
      ].join(":");
  return `${scopeKey}:${params.toolName}:${stableStringify(params.toolArgs || {})}`;
}

function cloneMcpResultWithDuplicateMarker(
  result: McpToolCallResult,
): McpToolCallResult {
  const content = result.content.map((part, index) => {
    if (index !== 0 || part.type !== "text") return { ...part };
    try {
      const parsed = JSON.parse(part.text) as Record<string, unknown>;
      return {
        ...part,
        text: JSON.stringify(
          {
            ...parsed,
            duplicate: true,
          },
          null,
          2,
        ),
      };
    } catch {
      return {
        ...part,
        text: `${part.text}\n\n{\"duplicate\":true}`,
      };
    }
  });
  return {
    content,
    ...(result.isError ? { isError: result.isError } : {}),
  };
}

function getCachedMcpReadResult(key: string | null): McpToolCallResult | null {
  if (!key) return null;
  pruneExpiredMcpReadDedupeCache();
  const cached = mcpReadDedupeCache.get(key);
  if (!cached) return null;
  return cloneMcpResultWithDuplicateMarker(cached.result);
}

function rememberMcpReadResult(
  key: string | null,
  result: McpToolCallResult,
): void {
  if (!key || result.isError) return;
  pruneExpiredMcpReadDedupeCache();
  mcpReadDedupeCache.set(key, {
    expiresAt: Date.now() + MCP_READ_DEDUPE_TTL_MS,
    result,
  });
}

function clearMcpReadDedupeCacheAfterToolResult(
  tool: ToolSpec,
  result: McpToolCallResult,
): void {
  if (tool.mutability !== "write" || result.isError) return;
  mcpReadDedupeCache.clear();
}

function isAuthorized(headers: Record<string, string> | undefined): boolean {
  const expected = getOrCreateZoteroMcpBearerToken();
  const authorization = getHeader(headers, ZOTERO_MCP_AUTH_HEADER);
  return authorization.trim() === `Bearer ${expected}`;
}

async function handleInitialize(): Promise<McpServerInfo> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: "llm-for-zotero",
      version: SERVER_VERSION,
    },
    capabilities: {
      tools: {},
    },
  };
}

function formatToolTitle(name: string): string {
  return name
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function isMcpExposedTool(tool: ToolSpec): boolean {
  if (tool.exposure === "internal") return false;
  if (tool.mutability === "read") return CURATED_READ_TOOL_NAMES.has(tool.name);
  if (tool.mutability === "write")
    return CURATED_WRITE_TOOL_NAMES.has(tool.name);
  return false;
}

function getMcpToolAnnotations(
  toolName: string,
  mutability: ToolSpec["mutability"],
): McpToolDefinition["annotations"] {
  if (mutability === "read") return READ_ONLY_TOOL_ANNOTATIONS;
  return DESTRUCTIVE_WRITE_TOOL_NAMES.has(toolName)
    ? DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS
    : WRITE_TOOL_ANNOTATIONS;
}

function handleToolsList(toolRegistry: AgentToolRegistry): McpToolsListResult {
  const tools: McpToolDefinition[] = toolRegistry
    .listTools()
    .filter(isMcpExposedTool)
    .map(({ name, description, inputSchema, mutability }) => ({
      name,
      title: formatToolTitle(name),
      description: decorateMcpToolDescription(name, description, mutability),
      inputSchema: decorateMcpToolSchema(inputSchema),
      annotations: getMcpToolAnnotations(name, mutability),
    }));
  return { tools };
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasJsonRpcId(request: JsonRpcRequest): boolean {
  return Object.prototype.hasOwnProperty.call(request, "id");
}

function makeJsonRpcHttpResponse(body: unknown): McpHttpResponse {
  return {
    status: 200,
    contentType: "application/json",
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function makeJsonRpcNotificationResponse(): McpHttpResponse {
  return {
    status: 202,
    contentType: "text/plain",
    body: "",
  };
}

function extractMcpScopeArgs(rawArgs: unknown): {
  toolArgs: Record<string, unknown>;
  libraryID?: number;
  activeItemId?: number;
  activeContextItemId?: number;
} {
  const args = normalizeRecord(rawArgs);
  const toolArgs = { ...args };
  for (const key of MCP_SCOPE_ARG_NAMES) delete toolArgs[key];
  return {
    toolArgs,
    libraryID: normalizePositiveInt(args.libraryID ?? args.libraryId),
    activeItemId: normalizePositiveInt(args.activeItemId ?? args.activeItemID),
    activeContextItemId: normalizePositiveInt(
      args.activeContextItemId ?? args.activeContextItemID,
    ),
  };
}

function decorateMcpToolDescription(
  toolName: string,
  description: string,
  mutability: ToolSpec["mutability"],
): string {
  const scopeGuidance =
    "Zotero MCP scope: omit libraryID, activeItemId, and activeContextItemId to use the current Codex Zotero chat scope. Use library_search with explicit entity and mode, for example library_search({ entity:'items', mode:'search', text:'...' }) or library_search({ entity:'collections', mode:'list', view:'tree' }), to discover Zotero items, and library_read for structured item state. Use paper_read for in-context paper content: mode:'overview' for summaries/main message, mode:'targeted' for textual evidence/sections/pages, mode:'visual' for rendered PDF pages, and mode:'capture' for the currently visible reader page. Use literature_search for scholarly discovery/import workflows and web_search for general web lookup. For counting questions, prefer library_search totalCount/returnedCount/limited metadata instead of hand-counting listed results.";
  const writeGuidance =
    toolName === "zotero_script"
      ? "zotero_script runs directly without a review card. Write scripts must call env.snapshot(item) before mutating items, or env.addUndoStep(fn) for custom changes, so undo_last_action can revert the operation."
      : mutability === "write"
        ? "Write operations pause in Zotero for user review before execution. For Zotero note requests, call note_write instead of returning note-ready text in chat."
        : "";
  return [description, scopeGuidance, writeGuidance]
    .filter(Boolean)
    .join("\n\n");
}

function decorateMcpToolSchema(inputSchema: object): object {
  if (
    !inputSchema ||
    typeof inputSchema !== "object" ||
    Array.isArray(inputSchema)
  ) {
    return inputSchema;
  }
  const record = inputSchema as Record<string, unknown>;
  const rawProperties = normalizeRecord(record.properties);
  return {
    ...record,
    properties: {
      ...rawProperties,
      libraryID: {
        type: "number",
        description:
          "Optional Zotero library ID. Omit to use the active library for the current Codex Zotero chat.",
      },
      activeItemId: {
        type: "number",
        description:
          "Optional active Zotero parent item ID. Omit to use the active paper/item for the current Codex Zotero chat.",
      },
      activeContextItemId: {
        type: "number",
        description:
          "Optional active Zotero attachment/context item ID. Omit to use the active paper attachment for the current Codex Zotero chat.",
      },
    },
  };
}

function resolveScopePaperContext(
  scope: ZoteroMcpActiveScope | null,
): PaperContextRef | undefined {
  if (!scope) return undefined;
  const paperContext = normalizePaperContext(scope.paperContext);
  if (paperContext) return paperContext;
  const itemId = normalizePositiveInt(scope.paperItemID || scope.activeItemId);
  const contextItemId = normalizePositiveInt(scope.activeContextItemId);
  if (!itemId || !contextItemId) return undefined;
  return {
    itemId,
    contextItemId,
    title: normalizeText(scope.title) || `Paper ${itemId}`,
  };
}

function resolveScopeActiveNoteContext(
  scope: ZoteroMcpActiveScope | null,
): AgentRuntimeRequest["activeNoteContext"] {
  const noteId = normalizePositiveInt(scope?.activeNoteId);
  if (!noteId) return undefined;
  const noteItem =
    (
      Zotero as unknown as {
        Items?: { get?: (id: number) => Zotero.Item | false | null };
      }
    ).Items?.get?.(noteId) || null;
  const snapshot = readNoteSnapshot(noteItem);
  if (snapshot) {
    return {
      noteId: snapshot.noteId,
      title: snapshot.title,
      noteKind: snapshot.noteKind,
      parentItemId: snapshot.parentItemId,
      noteText: snapshot.text,
      noteHtml: /<[^>]+\bstyle\s*=/i.test(snapshot.html)
        ? snapshot.html.slice(0, 10_000)
        : undefined,
    };
  }
  return {
    noteId,
    title: normalizeText(scope?.activeNoteTitle) || `Note ${noteId}`,
    noteKind: normalizeNoteKind(scope?.activeNoteKind) || "standalone",
    parentItemId: normalizePositiveInt(scope?.activeNoteParentItemId),
    noteText: "",
  };
}

function resolveScopedMcpScope(
  headers: Record<string, string> | undefined,
): ZoteroMcpActiveScope | null {
  const token = getHeader(headers, ZOTERO_MCP_SCOPE_HEADER).trim();
  if (!token) return activeZoteroMcpScope;
  pruneExpiredScopedMcpScopes();
  const entry = scopedZoteroMcpScopes.get(token);
  if (entry) {
    if (
      activeZoteroMcpScope &&
      scopesMatchCurrentProfile(entry.scope, activeZoteroMcpScope)
    ) {
      return activeZoteroMcpScope;
    }
    return entry.scope;
  }
  if (activeZoteroMcpScope) {
    logZoteroMcp(
      "Zotero MCP scope token was stale; using active Codex turn scope",
      {
        conversationKey: activeZoteroMcpScope.conversationKey,
        profileSignature: activeZoteroMcpScope.profileSignature,
        libraryID: activeZoteroMcpScope.libraryID,
      },
    );
    return activeZoteroMcpScope;
  }
  throw new Error(
    "Zotero MCP scope token is invalid or expired. Start a new Codex turn from Zotero so tools bind to the current profile and library.",
  );
}

function resolveMcpToolActivityScope(
  headers: Record<string, string> | undefined,
): ZoteroMcpActiveScope | null {
  try {
    return resolveScopedMcpScope(headers);
  } catch {
    return null;
  }
}

function formatMcpToolActivityRequestId(
  id: string | number | null | undefined,
): string {
  if (typeof id === "string" && id.trim()) return `jsonrpc:${id.trim()}`;
  if (typeof id === "number" && Number.isFinite(id)) return `jsonrpc:${id}`;
  return `mcp:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function getMcpToolPresentationLabel(
  deps: McpServerDeps,
  toolName: string,
): string | undefined {
  const label = deps.toolRegistry
    .getTool(toolName)
    ?.presentation?.label?.trim();
  return label || undefined;
}

function buildMcpToolActivityEvent(params: {
  id: string | number | null | undefined;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  args?: unknown;
  ok?: boolean;
  error?: string;
  headers?: Record<string, string>;
}): ZoteroMcpToolActivityEvent {
  const scope = resolveMcpToolActivityScope(params.headers);
  return {
    requestId: formatMcpToolActivityRequestId(params.id),
    phase: params.phase,
    toolName: params.toolName,
    toolLabel: params.toolLabel,
    serverName: ZOTERO_MCP_SERVER_NAME,
    arguments: params.args,
    ok: params.ok,
    error: params.error,
    profileSignature: scope?.profileSignature,
    conversationKey: scope?.conversationKey,
    libraryID: scope?.libraryID,
    kind: scope?.kind,
    timestamp: Date.now(),
  };
}

function scopesMatchForConfirmation(
  handlerScope: ZoteroMcpActiveScope,
  requestScope: ZoteroMcpActiveScope | null,
): boolean {
  if (!requestScope) return false;
  if (
    handlerScope.profileSignature &&
    requestScope.profileSignature &&
    handlerScope.profileSignature !== requestScope.profileSignature
  ) {
    return false;
  }
  if (
    handlerScope.conversationKey &&
    requestScope.conversationKey &&
    handlerScope.conversationKey !== requestScope.conversationKey
  ) {
    return false;
  }
  return Boolean(handlerScope.profileSignature || handlerScope.conversationKey);
}

function scopesMatchCurrentProfile(
  tokenScope: ZoteroMcpActiveScope,
  currentScope: ZoteroMcpActiveScope,
): boolean {
  if (
    tokenScope.profileSignature &&
    currentScope.profileSignature &&
    tokenScope.profileSignature !== currentScope.profileSignature
  ) {
    return false;
  }
  return true;
}

function findZoteroMcpConfirmationHandler(
  scope: ZoteroMcpActiveScope | null,
): ZoteroMcpConfirmationHandler | null {
  for (const entry of Array.from(zoteroMcpConfirmationHandlers).reverse()) {
    if (scopesMatchForConfirmation(entry.scope, scope)) return entry.handler;
  }
  return null;
}

function createToolContext(
  rawArgs: unknown,
  headers?: Record<string, string>,
): AgentToolContext {
  const scopeArgs = extractMcpScopeArgs(rawArgs);
  const scope = resolveScopedMcpScope(headers);
  const activeItemId =
    scopeArgs.activeItemId ||
    scope?.activeItemId ||
    scope?.paperItemID ||
    undefined;
  const activeContextItemId =
    scopeArgs.activeContextItemId || scope?.activeContextItemId || undefined;
  const itemLookupId = activeItemId || activeContextItemId;
  const item = itemLookupId
    ? (
        Zotero as unknown as {
          Items?: { get?: (id: number) => Zotero.Item | false | null };
        }
      ).Items?.get?.(itemLookupId) || null
    : null;
  const paperContext = resolveScopePaperContext(scope);
  const activeNoteContext = resolveScopeActiveNoteContext(scope);
  const request: AgentRuntimeRequest = {
    conversationKey: scope?.conversationKey || 0,
    mode: "agent",
    userText:
      normalizeText(
        normalizeRecord(rawArgs).question || normalizeRecord(rawArgs).text,
        4000,
      ) ||
      scope?.userText ||
      "",
    activeItemId,
    libraryID: scopeArgs.libraryID || scope?.libraryID || 0,
    model: "codex-app-server",
    authMode: "codex_app_server",
    selectedPaperContexts: paperContext ? [paperContext] : undefined,
    fullTextPaperContexts: paperContext ? [paperContext] : undefined,
    activeNoteContext,
  };
  return {
    request,
    item,
    currentAnswerText: "",
    modelName: "codex-app-server",
    modelProviderLabel: "Codex",
  };
}

function formatToolResult(
  execution: Extract<PreparedToolExecution, { kind: "result" }>["execution"],
): McpToolCallResult {
  const { result } = execution;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: result.ok,
            result: result.content,
            artifacts: result.artifacts,
          },
          null,
          2,
        ),
      },
    ],
    ...(result.ok ? {} : { isError: true }),
  };
}

function extractToolCallErrorText(
  result: McpToolCallResult,
): string | undefined {
  if (!result.isError) return undefined;
  for (const part of result.content) {
    const text = normalizeText(part.text, 1000);
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as {
        error?: unknown;
        result?: { error?: unknown };
      };
      return (
        normalizeText(parsed.result?.error, 1000) ||
        normalizeText(parsed.error, 1000) ||
        text
      );
    } catch {
      return text;
    }
  }
  return undefined;
}

async function requestZoteroMcpConfirmation(params: {
  execution: Extract<PreparedToolExecution, { kind: "confirmation" }>;
  headers?: Record<string, string>;
}): Promise<McpToolCallResult> {
  const scope = resolveScopedMcpScope(params.headers);
  const handler = findZoteroMcpConfirmationHandler(scope);
  if (!handler) {
    logZoteroMcp("Zotero MCP confirmation unavailable", {
      requestId: params.execution.requestId,
      toolName: params.execution.action.toolName,
      conversationKey: scope?.conversationKey,
      profileSignature: scope?.profileSignature,
    });
    return {
      content: [
        {
          type: "text",
          text:
            "Zotero MCP confirmation UI is unavailable for this Codex turn. " +
            "Start a new Codex turn from Zotero and try again.",
        },
      ],
      isError: true,
    };
  }

  logZoteroMcp("Zotero MCP confirmation requested", {
    requestId: params.execution.requestId,
    toolName: params.execution.action.toolName,
    conversationKey: scope?.conversationKey,
    profileSignature: scope?.profileSignature,
  });
  const resolution = await handler({
    requestId: params.execution.requestId,
    action: params.execution.action,
    toolName: params.execution.action.toolName,
    scope: scope ? { ...scope } : null,
  });
  logZoteroMcp("Zotero MCP confirmation resolved", {
    requestId: params.execution.requestId,
    toolName: params.execution.action.toolName,
    approved: resolution.approved,
    actionId: resolution.actionId,
  });
  const execution = resolution.approved
    ? await params.execution.execute(resolution.data)
    : params.execution.deny(resolution.data);
  return formatToolResult(execution);
}

async function handleToolsCall(
  params: McpToolCallParams,
  deps: McpServerDeps,
  headers?: Record<string, string>,
  id?: string | number | null,
): Promise<McpToolCallResult> {
  const { name, arguments: rawArgs } = params;

  const scopeArgs = extractMcpScopeArgs(rawArgs);
  const toolLabel = getMcpToolPresentationLabel(deps, name);
  emitZoteroMcpToolActivity(
    buildMcpToolActivityEvent({
      id,
      phase: "started",
      toolName: name,
      toolLabel,
      args: scopeArgs.toolArgs,
      headers,
    }),
  );

  const completeActivity = (result: { ok: boolean; error?: string }) => {
    emitZoteroMcpToolActivity(
      buildMcpToolActivityEvent({
        id,
        phase: "completed",
        toolName: name,
        toolLabel,
        args: scopeArgs.toolArgs,
        ok: result.ok,
        error: result.error,
        headers,
      }),
    );
  };

  const tool = deps.toolRegistry.getTool(name);
  if (!tool || !isMcpExposedTool(tool.spec)) {
    completeActivity({ ok: false, error: "Tool unavailable in native mode" });
    return {
      content: [
        {
          type: "text",
          text: `Zotero MCP tool is not available in Codex native mode: ${name}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const readDedupeKey =
      tool.spec.mutability === "read"
        ? buildMcpReadDedupeKey({
            toolName: name,
            toolArgs: scopeArgs.toolArgs,
            headers,
          })
        : null;
    const cachedReadResult = getCachedMcpReadResult(readDedupeKey);
    if (cachedReadResult) {
      completeActivity({ ok: true });
      return cachedReadResult;
    }

    const prepared = await deps.toolRegistry.prepareExecution(
      {
        id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: scopeArgs.toolArgs,
      },
      createToolContext(rawArgs, headers),
      {
        forceConfirmation:
          tool.spec.mutability === "write" &&
          !MCP_TOOLS_WITH_OWN_CONFIRMATION_POLICY.has(name),
      },
    );

    if (prepared.kind === "confirmation") {
      const result = await requestZoteroMcpConfirmation({
        execution: prepared,
        headers,
      });
      completeActivity({
        ok: !result.isError,
        error: extractToolCallErrorText(result),
      });
      clearMcpReadDedupeCacheAfterToolResult(tool.spec, result);
      return result;
    }
    const result = formatToolResult(prepared.execution);
    completeActivity({
      ok: !result.isError,
      error: extractToolCallErrorText(result),
    });
    clearMcpReadDedupeCacheAfterToolResult(tool.spec, result);
    rememberMcpReadResult(readDedupeKey, result);
    return result;
  } catch (error) {
    completeActivity({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function handleRequest(
  body: string,
  deps: McpServerDeps,
  headers?: Record<string, string>,
): Promise<McpHttpResponse> {
  let request: JsonRpcRequest;

  try {
    const parsed = JSON.parse(body);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.jsonrpc !== "2.0" ||
      typeof parsed.method !== "string"
    ) {
      return makeJsonRpcHttpResponse(
        makeError(
          null,
          RPC_ERRORS.INVALID_REQUEST.code,
          RPC_ERRORS.INVALID_REQUEST.message,
        ),
      );
    }
    request = parsed as JsonRpcRequest;
  } catch {
    return makeJsonRpcHttpResponse(
      makeError(
        null,
        RPC_ERRORS.PARSE_ERROR.code,
        RPC_ERRORS.PARSE_ERROR.message,
      ),
    );
  }

  const { id, method, params } = request;
  const isNotification = !hasJsonRpcId(request);

  try {
    if (method === MCP_METHODS.INITIALIZE) {
      const result = await handleInitialize();
      return makeJsonRpcHttpResponse(makeResult(id ?? null, result));
    }

    if (method === MCP_METHODS.INITIALIZED) {
      return makeJsonRpcNotificationResponse();
    }

    if (method === MCP_METHODS.TOOLS_LIST) {
      const result = handleToolsList(deps.toolRegistry);
      return makeJsonRpcHttpResponse(makeResult(id ?? null, result));
    }

    if (method === MCP_METHODS.TOOLS_CALL) {
      if (
        !params ||
        typeof params !== "object" ||
        typeof (params as McpToolCallParams).name !== "string"
      ) {
        return makeJsonRpcHttpResponse(
          makeError(
            id ?? null,
            RPC_ERRORS.INVALID_PARAMS.code,
            "tools/call requires { name, arguments }",
          ),
        );
      }
      const result = await handleToolsCall(
        params as McpToolCallParams,
        deps,
        headers,
        id ?? null,
      );
      return makeJsonRpcHttpResponse(makeResult(id ?? null, result));
    }

    if (isNotification) {
      return makeJsonRpcNotificationResponse();
    }

    return makeJsonRpcHttpResponse(
      makeError(
        id ?? null,
        RPC_ERRORS.METHOD_NOT_FOUND.code,
        `Unknown method: ${method}`,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotification) {
      (
        globalThis as typeof globalThis & {
          ztoolkit?: { log?: (...args: unknown[]) => void };
        }
      ).ztoolkit?.log?.("Zotero MCP notification failed", method, error);
      return makeJsonRpcNotificationResponse();
    }
    return makeJsonRpcHttpResponse(
      makeError(
        id ?? null,
        RPC_ERRORS.INTERNAL_ERROR.code,
        `Internal error: ${message}`,
      ),
    );
  }
}

/**
 * Registers the MCP endpoint on Zotero's built-in HTTP server.
 * Call this after the agent subsystem is initialized.
 */
export function registerMcpServer(deps: McpServerDeps): void {
  const capturedDeps = deps;
  registeredMcpDeps = capturedDeps;

  class McpEndpoint {
    supportedMethods = ["POST"];
    supportedDataTypes = ["application/json"];

    init = async (
      options: EndpointOptions,
    ): Promise<[number, string, string]> => {
      if (!isAuthorized(options.headers)) {
        return [
          401,
          "application/json",
          JSON.stringify({ error: "unauthorized" }),
        ];
      }
      const body =
        typeof options.data === "string"
          ? options.data
          : JSON.stringify(options.data);

      const response = await handleRequest(body, capturedDeps, options.headers);
      return [response.status, response.contentType, response.body];
    };
  }

  Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH] = McpEndpoint;
}

export async function invokeRegisteredZoteroMcpEndpoint(
  options: EndpointOptions,
): Promise<[number, string, string] | null> {
  const deps = registeredMcpDeps;
  if (!deps) return null;
  if (!isAuthorized(options.headers)) {
    return [401, "application/json", JSON.stringify({ error: "unauthorized" })];
  }
  const body =
    typeof options.data === "string"
      ? options.data
      : JSON.stringify(options.data);
  const response = await handleRequest(body, deps, options.headers);
  return [response.status, response.contentType, response.body];
}

/**
 * Removes the MCP endpoint from Zotero's server (call on plugin shutdown).
 */
export function unregisterMcpServer(): void {
  scopedZoteroMcpScopes.clear();
  mcpReadDedupeCache.clear();
  zoteroMcpConfirmationHandlers.clear();
  registeredMcpDeps = null;
  delete Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
}
