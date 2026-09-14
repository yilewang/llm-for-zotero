import { areExternalMcpWritesEnabled } from "./prefs";
import { createJournalId } from "../store/changeJournal";
import { createAbortController } from "../../utils/apiHelpers";
/**
 * MCP (Model Context Protocol) server for the llm-for-zotero plugin.
 *
 * Registers a JSON-RPC 2.0 endpoint on Zotero's built-in HTTP server at
 * "/llm-for-zotero/mcp". The endpoint is intended for local Codex app-server
 * use and requires a bearer token.
 */

import { config } from "../../../package.json";
import type {
  CollectionContextRef,
  PaperContentSourceMode,
  PaperContextRef,
  QuoteCitation,
  TagContextRef,
} from "../../shared/types";
import type { ReasoningConfig } from "../../shared/llm";
import { readNoteSnapshot } from "../../modules/contextPanel/noteSnapshot";
import { extractQuoteCitationsFromToolContent } from "../../modules/contextPanel/quoteCitations";
import type { AgentToolRegistry } from "../tools/registry";
import type { AgentActionReceipt } from "../contracts/types";
import type { ZoteroGateway } from "../services/zoteroGateway";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import type {
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
  AgentToolArtifact,
  AgentToolContext,
  ExhaustiveReadBackend,
  PreparedToolExecution,
  ToolSpec,
} from "../types";
import {
  resolveAgentRuntimeRequest,
  resolveZoteroTurnMetadataContext,
} from "../context/resolvedAgentRequest";
import {
  getActiveTurnPaper,
  type TurnPaperRole,
  type TurnPaperScope,
  type TurnPaperScopeWarning,
} from "../context/turnPaperScope";
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
import { loadPlanArtifact, loadPlanExecutionLedger } from "../plans/store";
import { loadLatestResearchMutationApprovalGrant } from "../research/store";
import { validateResearchMutationGrant } from "../research/mutationApproval";
import { extractVerifiedReadSources } from "../plans/readEvidence";
import type {
  TrustedReadObservation,
  VerifiedReadSource,
} from "../plans/types";
import { createTrustedReadObservations } from "../plans/readObservation";
import { resolveActiveLibraryID } from "../../utils/zoteroLibraryScope";

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
  "library_retrieve",
  "paper_read",
  "literature_search",
] as const;
export const ZOTERO_MCP_PLAN_TOOL_NAMES = [
  "request_user_input",
  "update_plan",
  "prepare_plan_execution",
  "amend_plan",
  "task_update",
  "research_update",
  "approve_research_expansion",
  "approve_research_mutation",
  "submit_document",
] as const;
export const ZOTERO_MCP_WRITE_TOOL_NAMES = [
  "amend_plan",
  "approve_research_expansion",
  "approve_research_mutation",
  "library_update",
  "collection_update",
  "note_write",
  "library_import",
  "library_delete",
  "attachment_update",
  "zotero_script",
  "undo_last_action",
  "revert_changes",
  "annotate_pdf",
] as const;

/**
 * Registered tools deliberately NOT exposed over MCP, and why.
 *
 * This list exists so a missing tool reads as a decision rather than drift —
 * the registry and these curated arrays are maintained by hand and have
 * silently diverged before.
 */
export const ZOTERO_MCP_EXCLUDED_TOOL_NAMES: Record<string, string> = {
  literature_review:
    "Ranked discovery review uses the Original Agent's conversation-scoped candidate store and interactive review channel; external MCP clients receive scholarly search results directly.",
  run_command:
    "External runtimes must use their native command tool so their selected permission profile and sandbox remain authoritative.",
  file_io:
    "External runtimes must use their native filesystem tools so their selected permission profile and sandbox remain authoritative.",
  // Runs unattended for minutes and reports only at the end. The MCP
  // transport has no progress channel and no way to drive the per-page
  // review the in-plugin surface offers, so an external backend would see a
  // single opaque call that either succeeds or times out. Revisit when the
  // paged result contract ({done, nextOffset, remaining}) lands.
  library_batch:
    "library_batch runs unattended with no progress channel over MCP; use the in-plugin agent or the slash-command surface.",
  // Deliberately absent and gated on a metadata flag the MCP path never
  // sets, so advertising it would offer a permanently unavailable tool.
  tool_result_read:
    "tool_result_read is gated on an in-plugin metadata flag that the MCP path does not set.",
};
const CURATED_READ_TOOL_NAMES = new Set<string>([
  ...ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ...ZOTERO_MCP_PLAN_TOOL_NAMES,
]);
const CURATED_PLAN_TOOL_NAMES = new Set<string>(ZOTERO_MCP_PLAN_TOOL_NAMES);
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
const CODEX_MCP_READ_APPROVAL_MODE = "approve";
const CODEX_MCP_EFFECT_APPROVAL_MODE = "auto";
const MCP_READ_DEDUPE_TTL_MS = 2 * 60 * 1000;
const MCP_READ_DEDUPE_TOOL_NAMES = new Set([
  "library_search",
  "library_read",
  "library_retrieve",
  "paper_read",
]);
const RAW_PDF_RETRIEVAL_TOOL_NAMES = new Set([
  "paper_read",
  "read_paper",
  "search_paper",
  "view_pdf_pages",
  "read_attachment",
  "library_read",
  "library_retrieve",
]);
const RAW_PDF_HIDDEN_NATIVE_TOOL_NAMES = new Set([
  "run_command",
  "file_io",
  "zotero_script",
]);
const RAW_PDF_HIDDEN_RETRIEVAL_TOOL_NAMES = new Set(["literature_search"]);

type ZoteroMcpScopeMetadata = {
  publishHostEvent?: (event: import("../types").AgentEvent) => Promise<void>;
  requestInteraction?: (
    action: import("../types").AgentPendingAction,
  ) => Promise<import("../types").AgentConfirmationResolution>;
  actionProgress?: AgentRuntimeRequest["actionProgress"];
  clarificationHistory?: AgentRuntimeRequest["clarificationHistory"];
  runtimeAuthority?: "claude" | "codex";
  /** Host lifecycle signal; never supplied by MCP tool arguments. */
  signal?: AbortSignal;
  /** Durable provider run that owns direct document artifacts. */
  runId?: string;
  sourceMessageTimestamp?: number;
  profileSignature?: string;
  conversationKey?: number;
  instanceID?: string;
  conversationGeneration?: number;
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
  model?: string;
  codexPath?: string;
  reasoning?: ReasoningConfig;
  planContext?: AgentRuntimeRequest["planContext"];
  actionContract?: AgentRuntimeRequest["actionContract"];
  classifiedIntent?: AgentRuntimeRequest["classifiedIntent"];
  actionPreparation?: AgentRuntimeRequest["actionPreparation"];
  semanticProvider?: AgentRuntimeRequest["semanticProvider"];
  documentOutcomePolicy?: AgentRuntimeRequest["documentOutcomePolicy"];
  documentReadObservations?: AgentRuntimeRequest["documentReadObservations"];
  documentArtifactObservations?: AgentRuntimeRequest["documentArtifactObservations"];
  skillRoutingReceipt?: AgentRuntimeRequest["skillRoutingReceipt"];
  exhaustiveReadBackend?: Extract<
    ExhaustiveReadBackend,
    "codex_responses" | "unavailable"
  >;
};

export type ZoteroMcpPaperScopeInput =
  | {
      turnPaperScope: TurnPaperScope;
      turnPaperScopeWarnings?: readonly TurnPaperScopeWarning[];
      paperContext?: never;
      selectedPaperContexts?: never;
      pdfPaperContexts?: never;
      fullTextPaperContexts?: never;
      pinnedPaperContexts?: never;
      selectedCollectionContexts?: never;
      selectedTagContexts?: never;
    }
  | {
      turnPaperScope?: never;
      turnPaperScopeWarnings?: never;
      paperContext?: PaperContextRef;
      selectedPaperContexts?: PaperContextRef[];
      pdfPaperContexts?: PaperContextRef[];
      fullTextPaperContexts?: PaperContextRef[];
      pinnedPaperContexts?: PaperContextRef[];
      selectedCollectionContexts?: CollectionContextRef[];
      selectedTagContexts?: TagContextRef[];
    };

export type ZoteroMcpActiveScope = ZoteroMcpScopeMetadata &
  ZoteroMcpPaperScopeInput;

type McpServerDeps = {
  toolRegistry: AgentToolRegistry;
  zoteroGateway: ZoteroGateway;
};

function getMcpScopePapers(
  scope: ZoteroMcpActiveScope | null,
  roles?: readonly TurnPaperRole[],
): PaperContextRef[] {
  if (scope?.turnPaperScope) {
    return scope.turnPaperScope.papers
      .filter(
        (entry) => !roles || entry.roles.some((role) => roles.includes(role)),
      )
      .map((entry) => entry.paper);
  }
  if (!scope) return [];
  const legacyByRole: Array<[TurnPaperRole, PaperContextRef[] | undefined]> = [
    ["selected", normalizePaperContexts(scope.selectedPaperContexts)],
    ["raw_pdf", normalizePaperContexts(scope.pdfPaperContexts)],
    ["full_text", normalizePaperContexts(scope.fullTextPaperContexts)],
    ["pinned", normalizePaperContexts(scope.pinnedPaperContexts)],
  ];
  return legacyByRole
    .filter(([role]) => !roles || roles.includes(role))
    .flatMap(([, papers]) => papers || []);
}

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
  {
    createdAt: number;
    expiresAt: number;
    scope: ZoteroMcpActiveScope;
    controller: AbortController;
  }
>();
const conversationScopeTokens = new Map<
  string,
  { token: string; instanceID?: string }
>();
let registeredMcpDeps: McpServerDeps | null = null;
const mcpReadDedupeCache = new Map<
  string,
  {
    expiresAt: number;
    result: McpToolCallResult;
    observations: readonly TrustedReadObservation[];
  }
>();

export type ZoteroMcpToolActivityEvent = {
  requestId: string;
  runId?: string;
  conversationGeneration?: number;
  phase: "started" | "completed";
  toolName: string;
  toolLabel?: string;
  serverName: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  artifacts?: AgentToolArtifact[];
  actionReceipts?: AgentActionReceipt[];
  mutability?: "read" | "write";
  profileSignature?: string;
  conversationKey?: number;
  libraryID?: number;
  kind?: "global" | "paper";
  quoteCitations?: QuoteCitation[];
  verifiedReadSources?: VerifiedReadSource[];
  readObservations?: readonly TrustedReadObservation[];
  timestamp: number;
};

type ZoteroMcpToolActivityObserver = (
  event: ZoteroMcpToolActivityEvent,
) => void;

const zoteroMcpToolActivityObservers = new Set<ZoteroMcpToolActivityObserver>();

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

/**
 * Direct-path PDF turns read PDFs through the provider's native filesystem
 * capability. Native filesystem tools and unscoped online retrieval stay
 * hidden; local paper retrieval is enforced per exact current-turn identity.
 */
export function getZoteroMcpDirectPdfToolNames(): string[] {
  return getZoteroMcpAllowedToolNames().filter(
    (name) =>
      !RAW_PDF_HIDDEN_NATIVE_TOOL_NAMES.has(name) &&
      !RAW_PDF_HIDDEN_RETRIEVAL_TOOL_NAMES.has(name),
  );
}

function getZoteroMcpToolApprovalOverrides(
  toolNames = getZoteroMcpAllowedToolNames(),
): Record<string, { approval_mode: "approve" | "auto" }> {
  return Object.fromEntries(
    toolNames.map((name) => [
      name,
      {
        approval_mode: CURATED_PLAN_TOOL_NAMES.has(name)
          ? CODEX_MCP_EFFECT_APPROVAL_MODE
          : CURATED_READ_TOOL_NAMES.has(name)
            ? CODEX_MCP_READ_APPROVAL_MODE
            : CODEX_MCP_EFFECT_APPROVAL_MODE,
      },
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
    rawPdfMode?: boolean;
    enabled?: boolean;
  } = {},
): Record<string, unknown> {
  const token = getOrCreateZoteroMcpBearerToken();
  const scopeToken = normalizeText(params.scopeToken, 256);
  const enabled = params.enabled !== false;
  const enabledToolNames = params.rawPdfMode
    ? getZoteroMcpDirectPdfToolNames()
    : getZoteroMcpAllowedToolNames();
  return {
    url: getZoteroMcpServerUrl(),
    ...(!enabled ? { enabled: false } : {}),
    ...(enabled && params.required ? { required: true } : {}),
    default_tools_approval_mode: CODEX_MCP_EFFECT_APPROVAL_MODE,
    tools: getZoteroMcpToolApprovalOverrides(enabledToolNames),
    http_headers: {
      [ZOTERO_MCP_AUTH_HEADER]: `Bearer ${token}`,
      ...(scopeToken ? { [ZOTERO_MCP_SCOPE_HEADER]: scopeToken } : {}),
    },
    enabled_tools: enabledToolNames,
  };
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutControlChars = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : char;
  }).join("");
  const normalized = withoutControlChars.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function normalizePaperContentSourceMode(
  value: unknown,
): PaperContentSourceMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "text":
    case "mineru":
    case "pdf":
    case "markdown":
    case "html":
    case "txt":
    case "docx":
      return normalized;
    default:
      return undefined;
  }
}

function normalizePaperContext(
  value: PaperContextRef | undefined,
): PaperContextRef | undefined {
  if (!value) return undefined;
  const libraryID = normalizePositiveInt(value.libraryID);
  const itemId = normalizePositiveInt(value.itemId);
  const contextItemId = normalizePositiveInt(value.contextItemId);
  if (!itemId || !contextItemId) return undefined;
  return {
    ...(libraryID ? { libraryID } : {}),
    itemId,
    contextItemId,
    title: normalizeText(value.title) || `Paper ${itemId}`,
    attachmentTitle: normalizeText(value.attachmentTitle),
    citationKey: normalizeText(value.citationKey),
    firstCreator: normalizeText(value.firstCreator),
    year: normalizeText(value.year, 32),
    contentSourceMode: normalizePaperContentSourceMode(value.contentSourceMode),
    mineruCacheDir: normalizeText(value.mineruCacheDir, 1024),
  };
}

function normalizePaperContexts(
  values: PaperContextRef[] | undefined,
): PaperContextRef[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePaperContext(value);
    if (!normalized) continue;
    const key = `${normalized.libraryID || 0}:${normalized.itemId}:${normalized.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out.length ? out : undefined;
}

function normalizeCollectionContexts(
  values: CollectionContextRef[] | undefined,
): CollectionContextRef[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: CollectionContextRef[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const collectionId = normalizePositiveInt(value?.collectionId);
    const libraryID = normalizePositiveInt(value?.libraryID);
    const name = normalizeText(value?.name);
    if (!collectionId || !libraryID || !name) continue;
    const key = `${libraryID}:${collectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ collectionId, libraryID, name });
  }
  return out.length ? out : undefined;
}

function normalizeTagContexts(
  values: TagContextRef[] | undefined,
): TagContextRef[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: TagContextRef[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const libraryID = normalizePositiveInt(value?.libraryID);
    const scope =
      value?.scope === "allTagged" || value?.scope === "untagged"
        ? value.scope
        : undefined;
    const name =
      normalizeText(value?.name) ||
      (scope === "allTagged"
        ? "All Tagged"
        : scope === "untagged"
          ? "Untagged"
          : undefined);
    if (!libraryID || !name) continue;
    const normalizedName = normalizeText(
      value?.normalizedName || value?.name,
    )?.toLowerCase();
    const includeAutomatic = value?.includeAutomatic === true;
    const key = scope
      ? `${libraryID}:scope:${scope}:${includeAutomatic ? "auto" : "manual"}`
      : `${libraryID}:tag:${normalizedName || name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      libraryID,
      normalizedName: normalizedName || undefined,
      scope,
      includeAutomatic: includeAutomatic || undefined,
    });
  }
  return out.length ? out : undefined;
}

function normalizeNoteKind(value: unknown): "item" | "standalone" | undefined {
  return value === "item" || value === "standalone" ? value : undefined;
}

function normalizeReasoningConfig(
  value: ReasoningConfig | undefined,
): ReasoningConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const providers = new Set<ReasoningConfig["provider"]>([
    "openai",
    "gemini",
    "deepseek",
    "kimi",
    "mimo",
    "qwen",
    "grok",
    "anthropic",
  ]);
  const levels = new Set<ReasoningConfig["level"]>([
    "default",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  if (!providers.has(value.provider) || !levels.has(value.level)) {
    return undefined;
  }
  const effort = normalizeText(value.effort, 128);
  return {
    provider: value.provider,
    level: value.level,
    ...(effort ? { effort } : {}),
  };
}

function normalizeActiveScope(
  scope: ZoteroMcpActiveScope,
): ZoteroMcpActiveScope {
  const rawScope = scope as ZoteroMcpActiveScope & Record<string, unknown>;
  const hasLegacyPaperScope = [
    "paperContext",
    "selectedPaperContexts",
    "pdfPaperContexts",
    "fullTextPaperContexts",
    "pinnedPaperContexts",
    "selectedCollectionContexts",
    "selectedTagContexts",
  ].some((field) => rawScope[field] !== undefined);
  if (scope.turnPaperScope && hasLegacyPaperScope) {
    throw new Error(
      "conflicting_paper_scope: send turnPaperScope or legacy paper arrays, not both.",
    );
  }
  const paperContext = normalizePaperContext(scope.paperContext);
  const canonicalActivePaper = scope.turnPaperScope
    ? getActiveTurnPaper(scope.turnPaperScope)
    : undefined;
  const conversationKey = normalizePositiveInt(scope.conversationKey);
  const paperItemID =
    normalizePositiveInt(scope.paperItemID) ||
    canonicalActivePaper?.itemId ||
    paperContext?.itemId;
  const activeContextItemId =
    normalizePositiveInt(scope.activeContextItemId) ||
    canonicalActivePaper?.contextItemId ||
    paperContext?.contextItemId;
  const metadataLibraryID = normalizePositiveInt(scope.libraryID);
  const canonicalLibraryID = normalizePositiveInt(
    scope.turnPaperScope?.libraryID,
  );
  if (
    metadataLibraryID &&
    canonicalLibraryID &&
    metadataLibraryID !== canonicalLibraryID
  ) {
    throw new Error(
      "conflicting_paper_scope: turnPaperScope belongs to a different Zotero library.",
    );
  }
  const metadata: ZoteroMcpScopeMetadata = {
    runtimeAuthority:
      scope.runtimeAuthority === "claude" || scope.runtimeAuthority === "codex"
        ? scope.runtimeAuthority
        : undefined,
    runId: normalizeText(scope.runId, 256),
    sourceMessageTimestamp: Number.isFinite(scope.sourceMessageTimestamp)
      ? Math.floor(Number(scope.sourceMessageTimestamp))
      : undefined,
    profileSignature: normalizeText(scope.profileSignature, 128),
    conversationKey,
    instanceID: normalizeText(scope.instanceID, 128),
    conversationGeneration: conversationKey
      ? Number.isFinite(scope.conversationGeneration)
        ? Math.max(0, Math.floor(Number(scope.conversationGeneration)))
        : getConversationWriteGeneration(conversationKey)
      : undefined,
    libraryID: canonicalLibraryID || metadataLibraryID,
    kind:
      scope.turnPaperScope?.conversationKind ||
      (scope.kind === "paper" ? "paper" : "global"),
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
    userText: typeof scope.userText === "string" ? scope.userText : "",
    model: normalizeText(scope.model, 256),
    codexPath: normalizeText(scope.codexPath, 4096),
    reasoning: normalizeReasoningConfig(scope.reasoning),
    signal: scope.signal,
    planContext: scope.planContext,
    requestInteraction: scope.requestInteraction,
    publishHostEvent: scope.publishHostEvent,
    actionProgress: scope.actionProgress,
    clarificationHistory: scope.clarificationHistory,
    actionContract: scope.actionContract,
    classifiedIntent: scope.classifiedIntent || scope.actionContract?.intent,
    actionPreparation: scope.actionPreparation,
    semanticProvider: scope.semanticProvider,
    documentOutcomePolicy: scope.documentOutcomePolicy,
    documentReadObservations: scope.documentReadObservations
      ? cloneTrustedReadObservations(scope.documentReadObservations)
      : undefined,
    documentArtifactObservations: scope.documentArtifactObservations
      ? cloneToolArtifacts(scope.documentArtifactObservations)
      : undefined,
    skillRoutingReceipt: scope.skillRoutingReceipt,
    exhaustiveReadBackend:
      scope.exhaustiveReadBackend === "codex_responses"
        ? "codex_responses"
        : "unavailable",
  };
  if (scope.turnPaperScope) {
    return {
      ...metadata,
      turnPaperScope: scope.turnPaperScope,
      turnPaperScopeWarnings: scope.turnPaperScopeWarnings,
    };
  }
  return {
    ...metadata,
    paperContext,
    selectedPaperContexts: normalizePaperContexts(scope.selectedPaperContexts),
    pdfPaperContexts: (
      normalizePaperContexts(scope.pdfPaperContexts) || []
    ).map((paper) => ({ ...paper, contentSourceMode: "pdf" as const })),
    fullTextPaperContexts: normalizePaperContexts(scope.fullTextPaperContexts),
    pinnedPaperContexts: normalizePaperContexts(scope.pinnedPaperContexts),
    selectedCollectionContexts: normalizeCollectionContexts(
      scope.selectedCollectionContexts,
    ),
    selectedTagContexts: normalizeTagContexts(scope.selectedTagContexts),
  };
}

function pruneExpiredScopedMcpScopes(): void {
  const now = Date.now();
  for (const [token, entry] of scopedZoteroMcpScopes) {
    if (entry.expiresAt <= now) {
      releaseScopedMcpScope(token);
    }
  }
}

export function registerScopedZoteroMcpScope(
  scope: ZoteroMcpActiveScope,
  options: { ttlMs?: number; token?: string } = {},
): {
  token: string;
  clear: () => void;
  getState: () => ZoteroMcpActiveScope | null;
} {
  pruneExpiredScopedMcpScopes();
  const token = normalizeText(options.token, 256) || generateToken();
  const ttlMs =
    Number.isFinite(options.ttlMs) && Number(options.ttlMs) > 0
      ? Math.floor(Number(options.ttlMs))
      : SCOPED_MCP_SCOPE_TTL_MS;
  releaseScopedMcpScope(token);
  const controller = createAbortController();
  const entry = {
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    controller,
    scope: normalizeActiveScope({ ...scope, signal: controller.signal }),
  };
  scopedZoteroMcpScopes.set(token, entry);
  return {
    token,
    getState: () => {
      pruneExpiredScopedMcpScopes();
      return scopedZoteroMcpScopes.get(token) === entry ? entry.scope : null;
    },
    clear: () => {
      if (scopedZoteroMcpScopes.get(token) === entry)
        releaseScopedMcpScope(token);
    },
  };
}

function releaseScopedMcpScope(token: string): void {
  scopedZoteroMcpScopes.get(token)?.controller.abort();
  scopedZoteroMcpScopes.delete(token);
  clearMcpReadDedupeCacheForScopeToken(token);
}

/** Refreshes the mutable per-turn authority carried by an already-issued
 * scope token. The token remains stable while the provider reports its run ID
 * and while verified read attestations accumulate between MCP calls. */
export function updateScopedZoteroMcpScope(
  token: string,
  update: Partial<ZoteroMcpScopeMetadata>,
): boolean {
  const normalizedToken = normalizeText(token, 256);
  if (!normalizedToken) return false;
  pruneExpiredScopedMcpScopes();
  const entry = scopedZoteroMcpScopes.get(normalizedToken);
  if (!entry) return false;
  entry.scope = normalizeActiveScope({
    ...entry.scope,
    ...update,
  } as ZoteroMcpActiveScope);
  return true;
}

/**
 * Returns a scope token that stays stable for one conversation.
 *
 * Agent runtimes bind the scope header when they create their conversation and
 * keep reusing it on resume, so a token that only lives for one turn is already
 * stale by the next turn. A conversation-stable token lets every turn re-register
 * its own scope under the same header value.
 *
 * Callers pass the identity rather than a pre-joined key so that the turn runner
 * and the fork path cannot drift on the key format: two spellings of the same
 * conversation would yield two tokens and bring the stale-header failure back.
 *
 * Entries hold only the token. The scope itself is registered per turn in
 * `scopedZoteroMcpScopes` and released when the turn ends. They are not expired
 * on a timer: a token whose conversation is still live in the agent runtime must
 * keep resolving, because the runtime keeps sending the header it captured when
 * the conversation was created. Endpoint restarts preserve the map; durable
 * conversation deletion releases its exact entry.
 */
export function resolveConversationScopeToken(params: {
  profileSignature?: string;
  conversationKey: number;
  instanceID?: string;
}): string {
  const conversationKey = Math.floor(Number(params.conversationKey));
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) {
    return generateToken();
  }
  const instanceID = normalizeText(params.instanceID, 128);
  const key = `${normalizeText(params.profileSignature, 256) || ""} ${conversationKey}${instanceID ? ` ${instanceID}` : ""}`;
  const existing = conversationScopeTokens.get(key);
  if (existing) return existing.token;
  const token = generateToken();
  conversationScopeTokens.set(key, {
    token,
    ...(instanceID ? { instanceID } : {}),
  });
  return token;
}

/**
 * Releases the stable token after its conversation has been durably deleted.
 * This is deliberately identity-specific: another Zotero profile can use the
 * same numeric conversation key and must keep its own live runtime binding.
 */
export function releaseConversationScopeToken(params: {
  profileSignature?: string;
  conversationKey: number;
  instanceID?: string;
}): void {
  const conversationKey = Math.floor(Number(params.conversationKey));
  if (!Number.isFinite(conversationKey) || conversationKey <= 0) return;
  const instanceID = normalizeText(params.instanceID, 128);
  const key = `${normalizeText(params.profileSignature, 256) || ""} ${conversationKey}${instanceID ? ` ${instanceID}` : ""}`;
  const entry = conversationScopeTokens.get(key);
  if (!entry) {
    // Older builds used a key-only token.  Once deletion supplies the old
    // immutable instance, removing that legacy entry is safe and prevents a
    // stale provider header from resolving into a later runtime.
    if (instanceID) {
      const legacyKey = `${normalizeText(params.profileSignature, 256) || ""} ${conversationKey}`;
      const legacyEntry = conversationScopeTokens.get(legacyKey);
      if (legacyEntry) {
        conversationScopeTokens.delete(legacyKey);
        releaseScopedMcpScope(legacyEntry.token);
      }
    }
    return;
  }
  // A deletion carrying an immutable instance identity must never fall back
  // to the legacy key-only lane: that key may already belong to a newer
  // conversation. Legacy callers may still release legacy tokens by key.
  if (instanceID && entry.instanceID !== instanceID) return;
  conversationScopeTokens.delete(key);
  releaseScopedMcpScope(entry.token);
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

function mcpReadDedupeScopePrefix(scopeToken: string): string {
  return `token:${JSON.stringify(scopeToken)}:`;
}

function clearMcpReadDedupeCacheForScopeToken(scopeToken: string): void {
  const prefix = mcpReadDedupeScopePrefix(scopeToken);
  for (const key of mcpReadDedupeCache.keys()) {
    if (key.startsWith(prefix)) mcpReadDedupeCache.delete(key);
  }
}

function buildMcpReadDedupeKey(params: {
  toolName: string;
  toolArgs: unknown;
  libraryID: number;
  activeItemId?: number;
  activeContextItemId?: number;
  headers?: Record<string, string>;
}): string | null {
  if (!MCP_READ_DEDUPE_TOOL_NAMES.has(params.toolName)) return null;
  const scopeToken = getHeader(params.headers, ZOTERO_MCP_SCOPE_HEADER).trim();
  if (!scopeToken) return null;
  pruneExpiredScopedMcpScopes();
  if (!scopedZoteroMcpScopes.has(scopeToken)) return null;
  return `${mcpReadDedupeScopePrefix(scopeToken)}${params.toolName}:${stableStringify(
    {
      libraryID: params.libraryID,
      activeItemId: params.activeItemId,
      activeContextItemId: params.activeContextItemId,
      arguments: params.toolArgs || {},
    },
  )}`;
}

function cloneMcpResultWithDuplicateMarker(
  result: McpToolCallResult,
): McpToolCallResult {
  const content = result.content.map((part, index) => {
    if (index !== 0) return { ...part };
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
        text: `${part.text}\n\n{"duplicate":true}`,
      };
    }
  });
  return {
    content,
    ...(result.isError ? { isError: result.isError } : {}),
  };
}

function cloneTrustedReadObservations(
  observations: readonly TrustedReadObservation[],
): TrustedReadObservation[] {
  return observations.map((observation) => ({
    ...observation,
    capabilities: [...observation.capabilities],
  }));
}

function cloneToolArtifacts(
  artifacts: readonly AgentToolArtifact[],
): AgentToolArtifact[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    paperContext: artifact.paperContext
      ? { ...artifact.paperContext }
      : undefined,
  }));
}

function getCachedMcpReadResult(key: string | null): {
  result: McpToolCallResult;
  observations: readonly TrustedReadObservation[];
} | null {
  if (!key) return null;
  pruneExpiredMcpReadDedupeCache();
  const cached = mcpReadDedupeCache.get(key);
  if (!cached) return null;
  return {
    result: cloneMcpResultWithDuplicateMarker(cached.result),
    observations: cloneTrustedReadObservations(cached.observations),
  };
}

function collectPaperIdentities(value: unknown): Array<{
  itemId?: number;
  contextItemId?: number;
}> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectPaperIdentities);
  const record = value as Record<string, unknown>;
  const itemId = normalizePositiveInt(record.itemId ?? record.itemID);
  const contextItemId = normalizePositiveInt(
    record.contextItemId ?? record.contextItemID,
  );
  const current = itemId || contextItemId ? [{ itemId, contextItemId }] : [];
  return [...current, ...Object.values(record).flatMap(collectPaperIdentities)];
}

function collectLibraryRetrieveItemIdentities(
  value: unknown,
): Array<{ itemId: number }> {
  const record = normalizeRecord(value);
  const scope = normalizeRecord(record.scope);
  if (!Array.isArray(scope.itemIds)) return [];
  return scope.itemIds
    .map((itemId) => normalizePositiveInt(itemId))
    .filter((itemId): itemId is number => Boolean(itemId))
    .map((itemId) => ({ itemId }));
}

function collectLibraryReadItemIdentities(
  value: unknown,
): Array<{ itemId: number }> {
  const record = normalizeRecord(value);
  if (!Array.isArray(record.itemIds)) return [];
  return record.itemIds
    .map((itemId) => normalizePositiveInt(itemId))
    .filter((itemId): itemId is number => Boolean(itemId))
    .map((itemId) => ({ itemId }));
}

function getAttachmentParentItemId(itemId: number): number | null {
  try {
    const item = Zotero?.Items?.get?.(itemId);
    if (!item || typeof item.isAttachment !== "function") return null;
    if (!item.isAttachment()) return null;
    return normalizePositiveInt(item.parentID) || null;
  } catch {
    return null;
  }
}

function identityUsesAttachmentUnderRawParent(
  identity: { itemId?: number; contextItemId?: number },
  rawParentItemIds: ReadonlySet<number>,
): boolean {
  return [identity.itemId, identity.contextItemId].some((value) => {
    const itemId = normalizePositiveInt(value);
    if (!itemId) return false;
    const parentItemId = getAttachmentParentItemId(itemId);
    return Boolean(parentItemId && rawParentItemIds.has(parentItemId));
  });
}

function shouldBlockRawPdfRetrieval(params: {
  toolName: string;
  rawArgs: unknown;
  scope: ZoteroMcpActiveScope | null;
}): boolean {
  if (!RAW_PDF_RETRIEVAL_TOOL_NAMES.has(params.toolName)) return false;
  const rawPdfs = getMcpScopePapers(params.scope, ["raw_pdf"]);
  if (!rawPdfs.length) return false;
  const isLibraryAttachmentEnumeration =
    params.toolName === "library_read" &&
    Array.isArray(normalizeRecord(params.rawArgs).sections) &&
    (normalizeRecord(params.rawArgs).sections as unknown[]).includes(
      "attachments",
    );
  const identities: Array<{
    itemId?: number;
    contextItemId?: number;
  }> = [
    ...collectPaperIdentities(params.rawArgs),
    ...(params.toolName === "library_retrieve"
      ? collectLibraryRetrieveItemIdentities(params.rawArgs)
      : []),
    ...(params.toolName === "library_read"
      ? collectLibraryReadItemIdentities(params.rawArgs)
      : []),
  ];
  const rawParentItemIds = new Set(rawPdfs.map((paper) => paper.itemId));
  const rawContextItemIds = new Set(
    rawPdfs.map((paper) => paper.contextItemId),
  );
  if (params.toolName === "library_read" && !isLibraryAttachmentEnumeration) {
    // Parent metadata and notes remain available, but an attachment ID can be
    // silently canonicalized to its parent by library_read. Block raw and
    // same-parent attachment aliases before that canonicalization occurs.
    return identities.some((identity) => {
      const suppliedValues = [identity.itemId, identity.contextItemId]
        .map(normalizePositiveInt)
        .filter((value): value is number => Boolean(value));
      return (
        suppliedValues.some((value) => rawContextItemIds.has(value)) ||
        identityUsesAttachmentUnderRawParent(identity, rawParentItemIds)
      );
    });
  }
  if (!identities.length) {
    // A global or implicit retrieval can traverse any paper in scope. Once a
    // current turn contains a raw PDF, fail closed unless the tool names an
    // exact non-PDF paper identity.
    return true;
  }
  const explicitTextContexts = params.scope?.turnPaperScope
    ? params.scope.turnPaperScope.papers
        .filter((entry) => !entry.roles.includes("raw_pdf"))
        .map((entry) => entry.paper)
    : getMcpScopePapers(params.scope, [
        "selected",
        "full_text",
        "pinned",
      ]).filter((paper) => paper.contentSourceMode !== "pdf");
  const explicitTextKeys = new Set(
    explicitTextContexts.map(
      (paper) => `${paper.itemId}:${paper.contextItemId}`,
    ),
  );
  const explicitTextItemIds = new Set(
    explicitTextContexts.map((paper) => paper.itemId),
  );
  return identities.some((identity) => {
    const itemId = normalizePositiveInt(identity.itemId);
    const contextItemId = normalizePositiveInt(identity.contextItemId);
    if (!itemId && !contextItemId) return true;

    const suppliedValues = [itemId, contextItemId].filter(
      (value): value is number => Boolean(value),
    );
    if (suppliedValues.some((value) => rawContextItemIds.has(value))) {
      return true;
    }

    if (
      itemId &&
      contextItemId &&
      !isLibraryAttachmentEnumeration &&
      explicitTextKeys.has(`${itemId}:${contextItemId}`)
    ) {
      return false;
    }

    if (
      suppliedValues.some((value) => rawParentItemIds.has(value)) ||
      identityUsesAttachmentUnderRawParent(identity, rawParentItemIds)
    ) {
      // A parent-only target includes the raw attachment, while an unselected
      // sibling under the same parent is not independently authorized as
      // Text/MinerU context.
      return true;
    }

    if (itemId && !contextItemId && explicitTextItemIds.has(itemId)) {
      return false;
    }

    // Content retrieval in a direct-PDF turn is allowed only for an exact
    // current-turn Text/MinerU identity. Any other target could silently
    // substitute unrelated or previously selected paper text.
    return true;
  });
}

function getRawPdfNativeFilesystemViolation(params: {
  toolName: string;
  scope: ZoteroMcpActiveScope | null;
}): string | null {
  if (!hasRawPdfScope(params.scope)) return null;
  if (RAW_PDF_HIDDEN_NATIVE_TOOL_NAMES.has(params.toolName)) {
    return `${params.toolName} is unavailable while this turn contains a direct-path PDF. Read only the exact current-turn local PDF path with Codex's native shell capability.`;
  }
  if (RAW_PDF_HIDDEN_RETRIEVAL_TOOL_NAMES.has(params.toolName)) {
    return `${params.toolName} is unavailable for direct-path PDF identities. Read only the exact current-turn local PDF path with Codex's native shell capability.`;
  }
  return null;
}

function rememberMcpReadResult(
  key: string | null,
  result: McpToolCallResult,
  observations: readonly TrustedReadObservation[],
): void {
  if (!key || result.isError) return;
  pruneExpiredMcpReadDedupeCache();
  mcpReadDedupeCache.set(key, {
    expiresAt: Date.now() + MCP_READ_DEDUPE_TTL_MS,
    result,
    observations: cloneTrustedReadObservations(observations),
  });
}

function clearMcpReadDedupeCacheAfterToolResult(
  tool: ToolSpec,
  result: McpToolCallResult,
): void {
  if (tool.executionClass !== "external_effect" || result.isError) return;
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
  if (tool.executionClass !== "external_effect")
    return CURATED_READ_TOOL_NAMES.has(tool.name);
  if (tool.executionClass === "external_effect")
    return CURATED_WRITE_TOOL_NAMES.has(tool.name);
  return false;
}

function getMcpToolAnnotations(
  toolName: string,
  executionClass: ToolSpec["executionClass"],
): McpToolDefinition["annotations"] {
  if (executionClass !== "external_effect") return READ_ONLY_TOOL_ANNOTATIONS;
  return DESTRUCTIVE_WRITE_TOOL_NAMES.has(toolName)
    ? DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS
    : WRITE_TOOL_ANNOTATIONS;
}

function hasRawPdfScope(scope: ZoteroMcpActiveScope | null): boolean {
  return getMcpScopePapers(scope, ["raw_pdf"]).length > 0;
}

function isMcpToolVisibleInScope(
  tool: ToolSpec,
  scope: ZoteroMcpActiveScope | null,
): boolean {
  if (!isMcpExposedTool(tool)) return false;
  if (tool.name === "request_user_input")
    return Boolean(
      scope?.classifiedIntent?.semantic && scope.requestInteraction,
    );
  if (CURATED_PLAN_TOOL_NAMES.has(tool.name)) {
    if (tool.name === "submit_document") {
      return scope?.documentOutcomePolicy?.required === true;
    }
    const phase = scope?.planContext?.phase;
    if (tool.name === "update_plan")
      return phase === "planning" && !scope?.planContext?.nativePlanning;
    if (tool.name === "prepare_plan_execution")
      return (
        phase === "planning" && Boolean(scope?.planContext?.nativePlanning)
      );
    if (phase !== "executing") return false;
  }
  if (!hasRawPdfScope(scope)) return true;
  return getZoteroMcpDirectPdfToolNames().includes(tool.name);
}

function handleToolsList(
  toolRegistry: AgentToolRegistry,
  scope: ZoteroMcpActiveScope | null,
): McpToolsListResult {
  const tools: McpToolDefinition[] = toolRegistry
    .listTools()
    .filter((tool) => isMcpToolVisibleInScope(tool, scope))
    .map(({ name, description, inputSchema, executionClass }) => {
      const mutability =
        executionClass === "external_effect" ? "write" : "read";
      return {
        name,
        title: formatToolTitle(name),
        description: decorateMcpToolDescription(name, description, mutability),
        inputSchema: decorateMcpToolSchema(inputSchema),
        annotations: getMcpToolAnnotations(name, executionClass),
      };
    });
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

type ResolvedMcpCallScope = {
  scopeArgs: ReturnType<typeof extractMcpScopeArgs>;
  scope: ZoteroMcpActiveScope | null;
  libraryID: number;
  activeItemId?: number;
  activeContextItemId?: number;
};

function resolveLibraryRetrieveScopeID(
  toolName: string,
  toolArgs: Record<string, unknown>,
): number | undefined {
  if (toolName !== "library_retrieve") return undefined;
  const retrievalScope = normalizeRecord(toolArgs.scope);
  return normalizePositiveInt(
    retrievalScope.libraryID ?? retrievalScope.libraryId,
  );
}

function resolveMcpCallScope(params: {
  toolName: string;
  rawArgs: unknown;
  headers?: Record<string, string>;
}): ResolvedMcpCallScope {
  const scopeArgs = extractMcpScopeArgs(params.rawArgs);
  const scope = resolveScopedMcpScope(params.headers);
  const retrievalLibraryID = resolveLibraryRetrieveScopeID(
    params.toolName,
    scopeArgs.toolArgs,
  );
  if (
    scopeArgs.libraryID &&
    retrievalLibraryID &&
    scopeArgs.libraryID !== retrievalLibraryID
  ) {
    throw new Error(
      `Conflicting Zotero library IDs: top-level libraryID=${scopeArgs.libraryID} but library_retrieve scope.libraryID=${retrievalLibraryID}.`,
    );
  }
  return {
    scopeArgs,
    scope,
    libraryID:
      scopeArgs.libraryID ||
      retrievalLibraryID ||
      normalizePositiveInt(scope?.libraryID) ||
      resolveActiveLibraryID() ||
      0,
    activeItemId:
      scopeArgs.activeItemId ||
      scope?.activeItemId ||
      scope?.paperItemID ||
      undefined,
    activeContextItemId:
      scopeArgs.activeContextItemId || scope?.activeContextItemId || undefined,
  };
}

function decorateMcpToolDescription(
  toolName: string,
  description: string,
  mutability: "read" | "write",
): string {
  const scopeGuidance =
    "Zotero MCP scope: omit libraryID to use the exact turn-scoped chat library when a scope header is present, or the library currently selected in Zotero for a standalone MCP client. Omit activeItemId and activeContextItemId to use the current turn-scoped chat item when available. Use library_search with explicit entity and mode, for example library_search({ entity:'items', mode:'search', text:'...' }) or library_search({ entity:'collections', mode:'list', view:'tree' }), to discover Zotero items. Use library_retrieve for broad folder/library evidence search across a scoped resource pool: intent:'enumerate' for comprehensive quality-first local evidence search including which/all/how-many/list questions, intent:'summarize' for taxonomy/theme/commonality/comparison synthesis with body-evidence coverage in bounded selected pools, and intent:'verify' for exact presence/absence. Use library_read for structured item state, and paper_read for close reading one known paper: mode:'overview' for summaries/main message, mode:'targeted' for textual evidence/sections/pages, mode:'full' only for explicit exhaustive full-text requests with a coverage receipt, mode:'figures' for precise extracted PDF figures from Zotero library PDFs, mode:'visual' for rendered PDF pages/layout, and mode:'capture' for the currently visible reader page. Use literature_search for scholarly online search: workflow:'answer' returns scholarly results for source-cited answers, while workflow:'review' opens Zotero import/review-card workflows. No general web-search MCP tool is available. For counting questions, prefer library_search totalCount/returnedCount/limited metadata or library_retrieve intent:'enumerate' coverage instead of hand-counting listed results.";
  const writeGuidance =
    toolName === "zotero_script"
      ? "The calling agent owns approval for zotero_script. Zotero applies its facade, integrity, and recovery checks. Write scripts must call env.snapshot(item) before mutating existing items, env.recordCreatedItem(item) after creating items, or env.addInverse(data) for supported custom changes so durable recovery can describe the operation."
      : mutability === "write"
        ? "The calling agent owns write approval through its native runtime permission profile or external client settings; Original Agent permission modes do not apply. Standalone writes require the external MCP write setting. Zotero validates and verifies operations before reporting success. For Zotero note requests, call note_write instead of returning note-ready text in chat."
        : "";
  return [
    description,
    scopeGuidance,
    writeGuidance,
    toolName === "undo_last_action" || toolName === "revert_changes"
      ? "Standalone clients must supply explicit actionId/actionIds from write receipts; there is no shared external conversation history for relative undo."
      : "",
  ]
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
          "Optional Zotero library ID. Omit to use the exact turn-scoped chat library when available, otherwise the library currently selected in Zotero.",
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
  if (scope.turnPaperScope) {
    return (
      getActiveTurnPaper(scope.turnPaperScope) ||
      scope.turnPaperScope.papers[0]?.paper
    );
  }
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
  if (!token) return null;
  pruneExpiredScopedMcpScopes();
  const entry = scopedZoteroMcpScopes.get(token);
  if (entry) {
    // A valid token identifies one conversation, and every turn of that
    // conversation re-registers its own scope under the token.
    return entry.scope;
  }
  throw new Error(
    "Zotero MCP scope token is invalid or expired. Start a new Codex turn from Zotero so tools bind to the current profile and library.",
  );
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
  quoteCitations?: QuoteCitation[];
  artifacts?: AgentToolArtifact[];
  actionReceipts?: AgentActionReceipt[];
  verifiedReadSources?: VerifiedReadSource[];
  readObservations?: readonly TrustedReadObservation[];
  mutability?: "read" | "write";
  scope: ZoteroMcpActiveScope | null;
  libraryID: number;
}): ZoteroMcpToolActivityEvent {
  return {
    requestId: formatMcpToolActivityRequestId(params.id),
    runId: params.scope?.runId,
    conversationGeneration: params.scope?.conversationGeneration,
    phase: params.phase,
    toolName: params.toolName,
    toolLabel: params.toolLabel,
    serverName: ZOTERO_MCP_SERVER_NAME,
    arguments: params.args,
    ok: params.ok,
    error: params.error,
    artifacts: params.artifacts,
    actionReceipts: params.actionReceipts,
    mutability: params.mutability,
    quoteCitations: params.quoteCitations,
    verifiedReadSources: params.verifiedReadSources,
    readObservations: params.readObservations,
    profileSignature: params.scope?.profileSignature,
    conversationKey: params.scope?.conversationKey,
    libraryID: params.libraryID || undefined,
    kind: params.scope?.kind,
    timestamp: Date.now(),
  };
}

function createToolContext(
  rawArgs: unknown,
  callScope: ResolvedMcpCallScope,
  zoteroGateway?: ZoteroGateway,
): AgentToolContext {
  const { scope, libraryID, activeItemId, activeContextItemId } = callScope;
  const itemLookupId = activeItemId || activeContextItemId;
  const item = itemLookupId
    ? (
        Zotero as unknown as {
          Items?: { get?: (id: number) => Zotero.Item | false | null };
        }
      ).Items?.get?.(itemLookupId) || null
    : null;
  const paperContext = resolveScopePaperContext(scope);
  const selectedPaperContexts = normalizePaperContexts(
    scope?.selectedPaperContexts,
  );
  const pdfPaperContexts = (
    normalizePaperContexts(scope?.pdfPaperContexts) || []
  ).map((paper) => ({ ...paper, contentSourceMode: "pdf" as const }));
  const fullTextPaperContexts = normalizePaperContexts(
    scope?.fullTextPaperContexts,
  );
  const pinnedPaperContexts = normalizePaperContexts(
    scope?.pinnedPaperContexts,
  );
  const hasExplicitPaperScope = Boolean(
    selectedPaperContexts?.length ||
    pdfPaperContexts.length ||
    fullTextPaperContexts?.length ||
    pinnedPaperContexts?.length,
  );
  const activeNoteContext = resolveScopeActiveNoteContext(scope);
  const exhaustiveReadBackend =
    scope?.exhaustiveReadBackend === "codex_responses"
      ? ("codex_responses" as const)
      : ("unavailable" as const);
  const requestBase = {
    conversationKey: scope?.conversationKey || 0,
    conversationGeneration: scope?.conversationGeneration,
    mode: "agent" as const,
    userText: scope?.userText || "",
    activeItemId,
    libraryID,
    conversationKind: scope?.kind,
    model: scope?.model,
    apiBase: scope?.codexPath,
    authMode:
      exhaustiveReadBackend === "codex_responses"
        ? ("codex_app_server" as const)
        : undefined,
    providerProtocol:
      exhaustiveReadBackend === "codex_responses"
        ? ("codex_responses" as const)
        : undefined,
    reasoning: scope?.reasoning,
    planContext: scope?.planContext,
    actionProgress: scope?.actionProgress,
    clarificationHistory: scope?.clarificationHistory,
    actionContract: scope?.actionContract,
    classifiedIntent: scope?.classifiedIntent || scope?.actionContract?.intent,
    actionPreparation: scope?.actionPreparation,
    semanticProvider: scope?.semanticProvider,
    documentOutcomePolicy: scope?.documentOutcomePolicy,
    documentReadObservations: scope?.documentReadObservations,
    documentArtifactObservations: scope?.documentArtifactObservations,
    skillRoutingReceipt: scope?.skillRoutingReceipt,
    exhaustiveReadBackend,
    activeNoteContext,
    metadata: {
      sourceMessageTimestamp: scope?.sourceMessageTimestamp,
    },
  };
  const request: AgentRuntimeRequest = scope?.turnPaperScope
    ? {
        ...requestBase,
        turnPaperScope: scope.turnPaperScope,
        zoteroMetadataContext: resolveZoteroTurnMetadataContext(
          scope.turnPaperScope,
        ),
        turnPaperScopeWarnings: scope.turnPaperScopeWarnings,
      }
    : resolveAgentRuntimeRequest(
        {
          ...requestBase,
          selectedPaperContexts:
            selectedPaperContexts ||
            (!hasExplicitPaperScope && paperContext
              ? [paperContext]
              : undefined),
          pdfPaperContexts: pdfPaperContexts.length
            ? pdfPaperContexts
            : undefined,
          fullTextPaperContexts:
            fullTextPaperContexts ||
            (!hasExplicitPaperScope && paperContext
              ? [paperContext]
              : undefined),
          pinnedPaperContexts,
          selectedCollectionContexts: scope?.selectedCollectionContexts,
          selectedTagContexts: scope?.selectedTagContexts,
        } satisfies AgentRuntimeRequestInput,
        {
          resolvePaperContext: zoteroGateway
            ? (selector) => zoteroGateway.resolvePaperContextTarget(selector)
            : undefined,
        },
      );
  return {
    request,
    authorization: {
      kind: "external_runtime",
      standalone: !scope?.runtimeAuthority,
    },
    signal: scope?.signal,
    runId: scope?.runId || createJournalId("mcp-run"),
    item,
    currentAnswerText: "",
    modelName: scope?.model || "external-mcp",
    modelProviderLabel:
      exhaustiveReadBackend === "codex_responses" ? "Codex" : "External MCP",
  };
}

async function restorePlanExecutionContext(
  context: AgentToolContext,
  toolRegistry: AgentToolRegistry,
): Promise<void> {
  const plan = context.request.planContext;
  if (plan?.phase !== "executing") return;
  const ledger = await loadPlanExecutionLedger(plan.executionId);
  if (
    !ledger ||
    ledger.planId !== plan.planId ||
    ledger.revision !== plan.revision ||
    ledger.planDigest !== plan.approvedDigest ||
    ledger.conversationKey !== context.request.conversationKey
  ) {
    throw new Error(
      "The MCP plan execution no longer matches its saved ledger",
    );
  }
  // A scoped token lasts for the provider turn, while each successful tool may
  // advance the durable task. Never use the dispatch-time active task hint.
  context.request.planContext = { ...plan, activeTaskId: ledger.activeTaskId };
  if (context.request.actionContract) return;
  const artifact = await loadPlanArtifact(plan.planId, plan.revision);
  if (
    !artifact ||
    artifact.digest !== plan.approvedDigest ||
    artifact.contract?.effects?.libraryMutation.approval !== "after_research"
  ) {
    return;
  }
  const grant = await loadLatestResearchMutationApprovalGrant(plan.executionId);
  if (!grant || grant.status !== "approved") return;
  const contract = await validateResearchMutationGrant({ grant, artifact });
  context.request.actionContract = contract;
  context.request.actionProgress = toolRegistry.createActionProgress(contract);
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
            effect: result.effect,
            ...(result.actionReceipts.length
              ? { actionReceipts: result.actionReceipts }
              : {}),
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

function rememberDocumentReadObservations(
  headers: Record<string, string> | undefined,
  observations: readonly TrustedReadObservation[],
): void {
  if (!observations.length) return;
  const scope = resolveScopedMcpScope(headers);
  if (!scope?.documentOutcomePolicy?.required) return;
  const merged = new Map(
    (scope.documentReadObservations || []).map((entry) => [
      entry.observationId,
      entry,
    ]),
  );
  for (const observation of observations) {
    merged.set(observation.observationId, observation);
  }
  scope.documentReadObservations = cloneTrustedReadObservations([
    ...merged.values(),
  ]);
}

function rememberDocumentArtifacts(
  headers: Record<string, string> | undefined,
  artifacts: readonly AgentToolArtifact[],
): void {
  if (!artifacts.length) return;
  const scope = resolveScopedMcpScope(headers);
  if (!scope?.documentOutcomePolicy?.required) return;
  const merged = new Map(
    (scope.documentArtifactObservations || []).map((artifact) => [
      artifact.storedPath,
      artifact,
    ]),
  );
  for (const artifact of artifacts) merged.set(artifact.storedPath, artifact);
  scope.documentArtifactObservations = cloneToolArtifacts([...merged.values()]);
}

function appendDocumentEvidenceRefs(
  result: McpToolCallResult,
  observations: readonly TrustedReadObservation[],
): McpToolCallResult {
  if (!observations.length || !result.content.length) return result;
  const content = result.content.map((part, index) => {
    if (index !== 0 || part.type !== "text") return part;
    try {
      const parsed = JSON.parse(part.text) as Record<string, unknown>;
      return {
        ...part,
        text: JSON.stringify(
          {
            ...parsed,
            documentEvidenceRefs: observations.map((observation) => ({
              evidenceRef: observation.observationId,
              libraryID: observation.libraryID,
              itemKey: observation.itemKey,
              capabilities: observation.capabilities,
              attachmentItemKey: observation.attachmentItemKey,
              pageIndex: observation.pageIndex,
              sourceFingerprint: observation.sourceFingerprint,
            })),
          },
          null,
          2,
        ),
      };
    } catch {
      return part;
    }
  });
  return { ...result, content };
}

function extractArtifactsFromMcpToolCallResult(
  result: McpToolCallResult,
): AgentToolArtifact[] | undefined {
  for (const part of result.content || []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    try {
      const parsed = JSON.parse(part.text) as { artifacts?: unknown };
      if (Array.isArray(parsed.artifacts)) {
        return parsed.artifacts as AgentToolArtifact[];
      }
    } catch {
      continue;
    }
  }
  return undefined;
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

async function handleToolsCall(
  params: McpToolCallParams,
  deps: McpServerDeps,
  headers?: Record<string, string>,
  id?: string | number | null,
): Promise<McpToolCallResult> {
  const { name, arguments: rawArgs } = params;

  const callScope = resolveMcpCallScope({
    toolName: name,
    rawArgs,
    headers,
  });
  const { scopeArgs, scope } = callScope;
  const toolLabel = getMcpToolPresentationLabel(deps, name);
  emitZoteroMcpToolActivity(
    buildMcpToolActivityEvent({
      id,
      phase: "started",
      toolName: name,
      toolLabel,
      args: scopeArgs.toolArgs,
      scope,
      libraryID: callScope.libraryID,
    }),
  );

  const completeActivity = (result: {
    ok: boolean;
    error?: string;
    quoteCitations?: QuoteCitation[];
    artifacts?: AgentToolArtifact[];
    actionReceipts?: AgentActionReceipt[];
    verifiedReadSources?: VerifiedReadSource[];
    readObservations?: readonly TrustedReadObservation[];
  }) => {
    emitZoteroMcpToolActivity(
      buildMcpToolActivityEvent({
        id,
        phase: "completed",
        toolName: name,
        toolLabel,
        args: scopeArgs.toolArgs,
        ok: result.ok,
        error: result.error,
        artifacts: result.artifacts,
        actionReceipts: result.actionReceipts,
        verifiedReadSources: result.verifiedReadSources,
        readObservations: result.readObservations,
        mutability:
          tool?.spec.executionClass === "external_effect" ? "write" : "read",
        quoteCitations: result.quoteCitations,
        scope,
        libraryID: callScope.libraryID,
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

  const scopeConversationKey = scope?.conversationKey || 0;
  const scopeGeneration = scopeConversationKey
    ? Number.isFinite(scope?.conversationGeneration)
      ? Number(scope?.conversationGeneration)
      : getConversationWriteGeneration(scopeConversationKey)
    : 0;
  if (
    tool.spec.executionClass === "external_effect" &&
    !scope?.runtimeAuthority &&
    !areExternalMcpWritesEnabled()
  ) {
    const error =
      'Standalone MCP writes are disabled. Enable "Allow writes from external MCP clients" in Zotero preferences to delegate approval to the connected client.';
    completeActivity({ ok: false, error });
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error }) }],
      isError: true,
    };
  }
  const nativeFilesystemViolation = getRawPdfNativeFilesystemViolation({
    toolName: name,
    scope,
  });
  if (nativeFilesystemViolation) {
    completeActivity({ ok: false, error: nativeFilesystemViolation });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: nativeFilesystemViolation,
          }),
        },
      ],
      isError: true,
    };
  }

  if (
    shouldBlockRawPdfRetrieval({
      toolName: name,
      rawArgs,
      scope,
    })
  ) {
    const error =
      "This paper is in raw PDF mode. Read the exact current-turn local PDF path, or switch to Text/MinerU to use Zotero retrieval.";
    completeActivity({ ok: false, error });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, error }),
        },
      ],
      isError: true,
    };
  }

  try {
    const readDedupeKey =
      tool.spec.executionClass === "read"
        ? buildMcpReadDedupeKey({
            toolName: name,
            toolArgs: scopeArgs.toolArgs,
            libraryID: callScope.libraryID,
            activeItemId: callScope.activeItemId,
            activeContextItemId: callScope.activeContextItemId,
            headers,
          })
        : null;
    const cachedReadResult = getCachedMcpReadResult(readDedupeKey);
    if (cachedReadResult) {
      rememberDocumentReadObservations(headers, cachedReadResult.observations);
      rememberDocumentArtifacts(
        headers,
        extractArtifactsFromMcpToolCallResult(cachedReadResult.result) || [],
      );
      completeActivity({
        ok: true,
        quoteCitations: extractQuoteCitationsFromToolContent(
          cachedReadResult.result,
        ),
        artifacts: extractArtifactsFromMcpToolCallResult(
          cachedReadResult.result,
        ),
        verifiedReadSources: cachedReadResult.observations.map(
          ({
            libraryID,
            itemKey,
            attachmentItemKey,
            pageIndex,
            sourceFingerprint,
          }) => ({
            libraryID,
            itemKey,
            attachmentItemKey,
            pageIndex,
            sourceFingerprint,
          }),
        ),
        readObservations: cachedReadResult.observations,
      });
      return cachedReadResult.result;
    }

    const toolContext = createToolContext(
      rawArgs,
      callScope,
      deps.zoteroGateway,
    );
    toolContext.checkpointActionProgress = async () => {
      const request = toolContext.request;
      if (!scope?.publishHostEvent)
        throw new Error(
          "The provider turn cannot persist its execution authority.",
        );
      if (
        request.actionContract &&
        request.actionProgress?.contractId !== request.actionContract.id
      )
        request.actionProgress = deps.toolRegistry.createActionProgress(
          request.actionContract,
        );
      if (scope) {
        scope.classifiedIntent = request.classifiedIntent;
        scope.actionContract = request.actionContract;
        scope.actionPreparation = request.actionPreparation;
        scope.actionProgress = request.actionProgress;
        scope.clarificationHistory = request.clarificationHistory;
        if (request.classifiedIntent?.semantic)
          await scope.publishHostEvent?.({
            type: "provider_event",
            providerType: "agent_semantic_intent",
            payload: {
              intent: request.classifiedIntent,
              clarificationHistory: request.clarificationHistory || [],
            },
          });
        if (request.actionPreparation)
          await scope.publishHostEvent?.({
            type: "provider_event",
            providerType: "agent_action_preparation",
            payload: request.actionPreparation,
          });
        if (request.actionContract && request.actionProgress)
          await scope.publishHostEvent?.({
            type: "provider_event",
            providerType: "agent_action_contract",
            payload: {
              contract: request.actionContract,
              progress: request.actionProgress,
            },
          });
      }
    };
    await restorePlanExecutionContext(toolContext, deps.toolRegistry);
    let prepared = await deps.toolRegistry.prepareExecution(
      {
        id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: scopeArgs.toolArgs,
      },
      toolContext,
      {
        callerKind: "mcp",
        isExecutionAllowed: () => {
          return (
            (Boolean(scope?.runtimeAuthority) ||
              tool.spec.executionClass !== "external_effect" ||
              areExternalMcpWritesEnabled()) &&
            (!scopeConversationKey ||
              (!areConversationWritesFrozen(scopeConversationKey) &&
                isConversationWriteGenerationCurrent(
                  scopeConversationKey,
                  scopeGeneration,
                )))
          );
        },
        executeWithLock: (task) => {
          return scopeConversationKey
            ? withConversationWriteLock(scopeConversationKey, task)
            : task();
        },
      },
    );

    while (prepared.kind === "confirmation") {
      if (!scope?.requestInteraction) {
        const error =
          "The native turn has no host interaction channel for this review. No action was applied.";
        completeActivity({ ok: false, error });
        return { content: [{ type: "text", text: error }], isError: true };
      }
      const resolution = await scope.requestInteraction(prepared.action);
      prepared = resolution.approved
        ? await prepared.execute(resolution)
        : { kind: "result", execution: prepared.deny(resolution.data) };
    }
    if (scope) {
      scope.classifiedIntent = toolContext.request.classifiedIntent;
      scope.actionContract = toolContext.request.actionContract;
      scope.actionPreparation = toolContext.request.actionPreparation;
      scope.actionProgress = toolContext.request.actionProgress;
      scope.clarificationHistory = toolContext.request.clarificationHistory;
    }
    let result = formatToolResult(prepared.execution);
    const readObservations =
      tool.spec.executionClass === "read" && !result.isError
        ? await createTrustedReadObservations({
            toolName: name,
            callId: prepared.execution.result.callId,
            input: prepared.execution.input,
            result: prepared.execution.result.content,
          })
        : [];
    rememberDocumentReadObservations(headers, readObservations);
    rememberDocumentArtifacts(
      headers,
      prepared.execution.result.artifacts || [],
    );
    result = appendDocumentEvidenceRefs(result, readObservations);
    completeActivity({
      ok: !result.isError,
      error: extractToolCallErrorText(result),
      quoteCitations: extractQuoteCitationsFromToolContent(
        prepared.execution.result.content,
      ),
      artifacts: prepared.execution.result.artifacts,
      actionReceipts: prepared.execution.result.actionReceipts,
      verifiedReadSources: readObservations.map(
        ({
          libraryID,
          itemKey,
          attachmentItemKey,
          pageIndex,
          sourceFingerprint,
        }) => ({
          libraryID,
          itemKey,
          attachmentItemKey,
          pageIndex,
          sourceFingerprint,
        }),
      ),
      readObservations,
    });
    clearMcpReadDedupeCacheAfterToolResult(tool.spec, result);
    rememberMcpReadResult(readDedupeKey, result, readObservations);
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
      const result = handleToolsList(
        deps.toolRegistry,
        resolveScopedMcpScope(headers),
      );
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
  for (const token of scopedZoteroMcpScopes.keys())
    releaseScopedMcpScope(token);
  mcpReadDedupeCache.clear();
  registeredMcpDeps = null;
  delete Zotero.Server.Endpoints[ZOTERO_MCP_ENDPOINT_PATH];
}
