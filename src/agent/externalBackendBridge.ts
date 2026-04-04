import { config } from "../../package.json";
import type { AgentRuntime } from "./runtime";
import type {
  ActionConfirmationMode,
  ActionProgressEvent,
  ActionResult,
} from "./actions/types";
import type { AgentConfirmationResolution, AgentPendingAction } from "./types";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
} from "./types";

export type RunTurnParams = {
  request: AgentRuntimeRequest;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onStart?: (runId: string) => void | Promise<void>;
  signal?: AbortSignal;
};

type ResolveExternalConfirmation = (
  requestId: string,
  resolution: AgentConfirmationResolution,
) => Promise<void>;

export type AgentRuntimeLike = Pick<
  AgentRuntime,
  | "listTools"
  | "getToolDefinition"
  | "unregisterTool"
  | "registerTool"
  | "registerPendingConfirmation"
  | "resolveConfirmation"
  | "getRunTrace"
> & {
  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities;
  runTurn(params: RunTurnParams): Promise<AgentRuntimeOutcome>;
  listExternalActionsSync(): Array<{
    name: string;
    description: string;
    inputSchema: object;
    source: "backend";
    backendToolName: string;
    riskLevel: "low" | "medium" | "high";
    requiresConfirmation: boolean;
    mutability: "read" | "write";
  }>;
  refreshExternalActions(force?: boolean): Promise<void>;
  runExternalAction(
    name: string,
    input: unknown,
    opts?: {
      conversationKey?: number;
      libraryID?: number;
      confirmationMode?: ActionConfirmationMode;
      onProgress?: (event: ActionProgressEvent) => void;
      requestConfirmation?: (
        requestId: string,
        action: AgentPendingAction,
      ) => Promise<AgentConfirmationResolution>;
    },
  ): Promise<ActionResult<unknown>>;
};

type BridgeLine =
  | { type: "start"; runId: string }
  | { type: "event"; event: AgentEvent }
  | { type: "outcome"; outcome: AgentRuntimeOutcome }
  | { type: "error"; error: string };

type ToolMutability = "read" | "write";
type ToolRiskLevel = "low" | "medium" | "high";
type ToolSource = "claude-runtime" | "zotero-bridge" | "mcp";

type ExternalToolDescriptor = {
  name: string;
  description: string;
  inputSchema: object;
  mutability: ToolMutability;
  riskLevel: ToolRiskLevel;
  requiresConfirmation: boolean;
  source: ToolSource;
};

const EXTERNAL_ACTION_PREFIX = "cc_tool::";

type ContextEnvelope = {
  activeItemId?: number;
  libraryID?: number;
  selectedTextCount: number;
  selectedPaperCount: number;
  fullTextPaperCount: number;
  pinnedPaperCount: number;
  attachmentCount: number;
  screenshotCount: number;
  selectedTexts: Array<{
    source: string;
    text: string;
  }>;
  selectedPapers: Array<{
    itemId: number;
    contextItemId: number;
    title: string;
    citationKey?: string;
    firstCreator?: string;
    year?: string;
  }>;
  fullTextPapers: Array<{
    itemId: number;
    contextItemId: number;
    title: string;
  }>;
  pinnedPapers: Array<{
    itemId: number;
    contextItemId: number;
    title: string;
  }>;
  attachments: Array<{
    id: string;
    name: string;
    mimeType: string;
    category: string;
    sizeBytes: number;
  }>;
  activeNote?: {
    noteId: number;
    noteKind: string;
    title: string;
    parentItemId?: number;
    preview: string;
  };
};

type BridgeAttachment = {
  id: string;
  name: string;
  mimeType: string;
  category: string;
  sizeBytes: number;
  storedPath?: string;
  contentHash?: string;
};

type BridgePaperContext = {
  itemId?: number;
  contextItemId?: number;
  title?: string;
  attachmentTitle?: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
  mineruCacheDir?: string;
  mineruFullMdPath?: string;
  contextFilePath?: string;
};

type BridgeScopeType =
  | "paper"
  | "open"
  | "folder"
  | "tag"
  | "tagset"
  | "custom";

type BridgeScope = {
  scopeType: BridgeScopeType;
  scopeId: string;
  scopeLabel?: string;
};

export type ExternalBridgeSessionInfo = {
  originalConversationKey: string;
  scopedConversationKey: string;
  scopeType?: BridgeScopeType;
  scopeId?: string;
  scopeLabel?: string;
  runtimeCwdRelative?: string;
  cwd?: string;
};

type BridgeRuntimeRequest = {
  conversationKey: number;
  userText: string;
  activeItemId?: number;
  libraryID?: number;
  model?: string;
  apiBase?: string;
  authMode?: string;
  providerProtocol?: string;
  selectedTexts?: string[];
  selectedTextSources?: unknown[];
  selectedPaperContexts?: BridgePaperContext[];
  fullTextPaperContexts?: BridgePaperContext[];
  pinnedPaperContexts?: BridgePaperContext[];
  attachments?: BridgeAttachment[];
  screenshots?: string[];
  activeNoteContext?: {
    noteId: number;
    title: string;
    noteKind: string;
    parentItemId?: number;
    noteText?: string;
  };
};

function getClaudeConfigSourcePref(): "user-level" | "zotero-specific" {
  try {
    const raw = Zotero.Prefs.get(
      `${config.prefsPrefix}.agentClaudeConfigSource`,
      true,
    );
    return raw === "user-level" ? "user-level" : "zotero-specific";
  } catch {
    return "zotero-specific";
  }
}

function getClaudeSettingSourcesByPref(): Array<"user" | "project" | "local"> {
  return getClaudeConfigSourcePref() === "user-level"
    ? ["user"]
    : ["project", "local"];
}

function getAgentPermissionModePref(): "safe" | "yolo" {
  try {
    const raw = Zotero.Prefs.get(
      `${config.prefsPrefix}.agentPermissionMode`,
      true,
    );
    return raw === "yolo" ? "yolo" : "safe";
  } catch {
    return "safe";
  }
}

function getStringPref(key: string, fallback = ""): string {
  try {
    const value = Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true);
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

function normalizeScopeType(value: unknown): BridgeScopeType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "paper":
    case "open":
    case "folder":
    case "tag":
    case "tagset":
    case "custom":
      return normalized;
    default:
      return null;
  }
}

function normalizeScopeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function resolvePaperScopeFromRequest(request: AgentRuntimeRequest): BridgeScope | null {
  const libraryID =
    typeof request.libraryID === "number" && Number.isFinite(request.libraryID)
      ? Math.floor(request.libraryID)
      : undefined;

  let paperItemId: number | undefined;
  const fromActiveItem =
    typeof request.activeItemId === "number" && Number.isFinite(request.activeItemId)
      ? Math.floor(request.activeItemId)
      : undefined;
  if (fromActiveItem && fromActiveItem > 0) {
    const item = Zotero.Items.get(fromActiveItem);
    if (item?.isAttachment?.() && item.parentID) {
      paperItemId = Math.floor(item.parentID);
    } else if (item?.isRegularItem?.()) {
      paperItemId = Math.floor(item.id);
    }
  }

  if (!paperItemId || paperItemId <= 0) {
    const allRefs = [
      ...(Array.isArray(request.selectedPaperContexts)
        ? request.selectedPaperContexts
        : []),
      ...(Array.isArray(request.fullTextPaperContexts)
        ? request.fullTextPaperContexts
        : []),
      ...(Array.isArray(request.pinnedPaperContexts)
        ? request.pinnedPaperContexts
        : []),
    ];
    const firstRef = allRefs.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.itemId === "number" &&
        Number.isFinite(entry.itemId),
    );
    if (firstRef?.itemId) {
      paperItemId = Math.floor(firstRef.itemId);
    }
  }

  if (!paperItemId || paperItemId <= 0) {
    return null;
  }

  const titleItem = Zotero.Items.get(paperItemId);
  const scopeLabel =
    titleItem?.isRegularItem?.() && typeof titleItem.getField === "function"
      ? String(titleItem.getField("title") || "").trim() || undefined
      : undefined;

  const scopeId = `${libraryID ?? 0}:${paperItemId}`;
  return { scopeType: "paper", scopeId, scopeLabel };
}

function resolveBridgeScope(request: AgentRuntimeRequest): BridgeScope {
  const explicitType = normalizeScopeType(
    (request as unknown as { scopeType?: unknown }).scopeType,
  );
  const explicitId = normalizeScopeId(
    (request as unknown as { scopeId?: unknown }).scopeId,
  );
  const explicitLabel =
    typeof (request as unknown as { scopeLabel?: unknown }).scopeLabel === "string"
      ? String((request as unknown as { scopeLabel?: unknown }).scopeLabel).trim() || undefined
      : undefined;
  if (explicitType && explicitId) {
    return {
      scopeType: explicitType,
      scopeId: explicitId,
      scopeLabel: explicitLabel,
    };
  }

  const paperScope = resolvePaperScopeFromRequest(request);
  if (paperScope) {
    return paperScope;
  }

  const libraryID =
    typeof request.libraryID === "number" && Number.isFinite(request.libraryID)
      ? Math.floor(request.libraryID)
      : 0;
  return {
    scopeType: "open",
    scopeId: String(libraryID),
    scopeLabel: "Open Chat",
  };
}

function parseLine(raw: string): BridgeLine | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    return JSON.parse(line) as BridgeLine;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function toExternalActionName(toolName: string): string {
  return `${EXTERNAL_ACTION_PREFIX}${toolName}`;
}

function fromExternalActionName(actionName: string): string | null {
  if (!actionName.startsWith(EXTERNAL_ACTION_PREFIX)) return null;
  const tool = actionName.slice(EXTERNAL_ACTION_PREFIX.length).trim();
  return tool || null;
}

async function streamBridgeLines(
  response: Response,
  onLine: (line: BridgeLine) => void | Promise<void>,
): Promise<void> {
  if (!response.body) {
    const text = await response.text();
    for (const chunk of text.split("\n")) {
      const line = parseLine(chunk);
      if (line) await onLine(line);
    }
    return;
  }

  const reader = (response.body as any).getReader() as {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  };
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const rawLine = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const line = parseLine(rawLine);
      if (line) await onLine(line);
      idx = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode(new Uint8Array());
  if (buffer.trim()) {
    const line = parseLine(buffer);
    if (line) await onLine(line);
  }
}

async function runExternalBridgeTurn(
  baseUrl: string,
  params: RunTurnParams & {
    contextEnvelope?: ContextEnvelope;
    runtimeRequest?: BridgeRuntimeRequest;
    scope?: BridgeScope;
    registerPendingConfirmation?: (
      requestId: string,
      resolve: (resolution: AgentConfirmationResolution) => void,
    ) => void;
    resolveExternalConfirmation?: ResolveExternalConfirmation;
  },
): Promise<AgentRuntimeOutcome> {
  const url = `${normalizeBaseUrl(baseUrl)}/run-turn`;
  const reasoningLevel =
    typeof params.request.reasoning?.level === "string"
      ? params.request.reasoning.level
      : "";
  const effort =
    reasoningLevel === "xhigh"
      ? "max"
      : reasoningLevel === "high" ||
          reasoningLevel === "medium" ||
          reasoningLevel === "low"
        ? reasoningLevel
        : reasoningLevel === "default"
          ? "auto"
        : undefined;
  const traceVerbosity = getStringPref("agentTraceVerbosity").trim().toLowerCase();
  const rawLogVisibility = getStringPref("agentRawLogVisibility")
    .trim()
    .toLowerCase();
  const debugModeEnabled =
    traceVerbosity === "verbose" ||
    traceVerbosity === "raw" ||
    rawLogVisibility === "debug_only";

  const userTextRaw = params.request.userText || "";
  const probeMatch = userTextRaw.match(/^\s*\/(?:debug-)?permission-probe\b\s*(.*)$/i);
  const probeRequested = Boolean(probeMatch && debugModeEnabled);
  const probeStrippedText = probeMatch?.[1]?.trim() || "";
  const userTextForBridge = probeRequested
    ? probeStrippedText || "Permission probe run."
    : userTextRaw;

  const payload = {
    conversationKey: params.request.conversationKey,
    userText: userTextForBridge,
    scopeType: params.scope?.scopeType,
    scopeId: params.scope?.scopeId,
    scopeLabel: params.scope?.scopeLabel,
    runtimeRequest: params.runtimeRequest,
    metadata: {
      runType: "chat",
      claudeConfigSource: getClaudeConfigSourcePref(),
      claudeSettingSources: getClaudeSettingSourcesByPref(),
      permissionMode: getAgentPermissionModePref(),
      model:
        typeof params.request.model === "string" &&
        params.request.model.trim().toLowerCase() !== "default"
          ? params.request.model.trim()
          : undefined,
      effort,
      activeItemId: params.request.activeItemId,
      libraryID: params.request.libraryID,
      contextEnvelope: params.contextEnvelope,
      scopeType: params.scope?.scopeType,
      scopeId: params.scope?.scopeId,
      scopeLabel: params.scope?.scopeLabel,
      debugPermissionProbe: probeRequested,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: params.signal,
  });

  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }

  let finalOutcome: AgentRuntimeOutcome | null = null;

  await streamBridgeLines(response, async (line) => {
    if (line.type === "start") {
      await params.onStart?.(line.runId);
      return;
    }
    if (line.type === "event") {
      if (
        line.event.type === "confirmation_required" &&
        params.registerPendingConfirmation &&
        params.resolveExternalConfirmation
      ) {
        const requestId = line.event.requestId;
        params.registerPendingConfirmation(requestId, (resolution) => {
          void params.resolveExternalConfirmation?.(requestId, resolution);
        });
      }
      await params.onEvent?.(line.event);
      return;
    }
    if (line.type === "outcome") {
      finalOutcome = line.outcome;
      return;
    }
    if (line.type === "error") {
      throw new Error(line.error || "Bridge stream error");
    }
  });

  if (!finalOutcome) {
    return {
      kind: "fallback",
      runId: `bridge-${Date.now()}`,
      reason: "Bridge ended without outcome",
      usedFallback: true,
    };
  }

  return finalOutcome;
}

function trimText(value: unknown, max = 360): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function normalizePaperRefs(list: unknown, limit = 8): Array<{
  itemId: number;
  contextItemId: number;
  title: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
}> {
  if (!Array.isArray(list)) return [];
  const refs: Array<{
    itemId: number;
    contextItemId: number;
    title: string;
    citationKey?: string;
    firstCreator?: string;
    year?: string;
  }> = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const itemId = typeof record.itemId === "number" ? record.itemId : undefined;
    const contextItemId =
      typeof record.contextItemId === "number" ? record.contextItemId : undefined;
    const title = trimText(record.title, 180);
    if (!itemId || !contextItemId || !title) continue;
    refs.push({
      itemId,
      contextItemId,
      title,
      citationKey:
        typeof record.citationKey === "string" ? trimText(record.citationKey, 80) : undefined,
      firstCreator:
        typeof record.firstCreator === "string" ? trimText(record.firstCreator, 80) : undefined,
      year: typeof record.year === "string" ? trimText(record.year, 16) : undefined,
    });
    if (refs.length >= limit) break;
  }
  return refs;
}

function buildContextEnvelope(request: AgentRuntimeRequest): ContextEnvelope {
  const selectedTexts = Array.isArray(request.selectedTexts) ? request.selectedTexts : [];
  const selectedSources = Array.isArray(request.selectedTextSources)
    ? request.selectedTextSources
    : [];
  const selectedTextRows = selectedTexts.slice(0, 6).map((text, index) => ({
    source: typeof selectedSources[index] === "string" ? selectedSources[index] : "unknown",
    text: trimText(text, 280),
  })).filter((row) => row.text);
  const selectedPapers = normalizePaperRefs(request.selectedPaperContexts, 10);
  const fullTextPapers = normalizePaperRefs(request.fullTextPaperContexts, 8).map((paper) => ({
    itemId: paper.itemId,
    contextItemId: paper.contextItemId,
    title: paper.title,
  }));
  const pinnedPapers = normalizePaperRefs(request.pinnedPaperContexts, 8).map((paper) => ({
    itemId: paper.itemId,
    contextItemId: paper.contextItemId,
    title: paper.title,
  }));
  const attachments = (Array.isArray(request.attachments) ? request.attachments : [])
    .slice(0, 10)
    .map((attachment) => ({
      id: attachment.id,
      name: trimText(attachment.name, 120),
      mimeType: attachment.mimeType,
      category: attachment.category,
      sizeBytes: attachment.sizeBytes,
    }));
  const activeNote = request.activeNoteContext
    ? {
        noteId: request.activeNoteContext.noteId,
        noteKind: request.activeNoteContext.noteKind,
        title: trimText(request.activeNoteContext.title, 120),
        parentItemId: request.activeNoteContext.parentItemId,
        preview: trimText(request.activeNoteContext.noteText, 420),
      }
    : undefined;

  return {
    activeItemId: request.activeItemId,
    libraryID: request.libraryID,
    selectedTextCount: selectedTexts.length,
    selectedPaperCount: Array.isArray(request.selectedPaperContexts)
      ? request.selectedPaperContexts.length
      : 0,
    fullTextPaperCount: Array.isArray(request.fullTextPaperContexts)
      ? request.fullTextPaperContexts.length
      : 0,
    pinnedPaperCount: Array.isArray(request.pinnedPaperContexts)
      ? request.pinnedPaperContexts.length
      : 0,
    attachmentCount: Array.isArray(request.attachments) ? request.attachments.length : 0,
    screenshotCount: Array.isArray(request.screenshots) ? request.screenshots.length : 0,
    selectedTexts: selectedTextRows,
    selectedPapers,
    fullTextPapers,
    pinnedPapers,
    attachments,
    activeNote,
  };
}

async function buildBridgeRuntimeRequest(
  request: AgentRuntimeRequest,
): Promise<BridgeRuntimeRequest> {
  const joinPath = (base: string, segment: string): string => {
    if (!base) return segment;
    if (!segment) return base;
    const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    const normalizedSegment = segment.startsWith("/")
      ? segment.slice(1)
      : segment;
    return `${normalizedBase}/${normalizedSegment}`;
  };

  const resolveAttachmentAbsolutePath = async (
    contextItemId: unknown,
    fallbackItemId?: unknown,
  ): Promise<string | undefined> => {
    const normalizedId =
      typeof contextItemId === "number" && Number.isFinite(contextItemId)
        ? Math.floor(contextItemId)
        : 0;
    const readAttachmentPath = async (
      attachmentId: number,
    ): Promise<string | undefined> => {
      if (attachmentId <= 0) return undefined;
      const attachment = Zotero.Items.get(attachmentId);
      if (!attachment?.isAttachment?.()) return undefined;
      const asyncPath = await (
        attachment as unknown as { getFilePathAsync?: () => Promise<string | false> }
      ).getFilePathAsync?.();
      const directPath =
        typeof asyncPath === "string" && asyncPath.trim()
          ? asyncPath.trim()
          : typeof (attachment as { getFilePath?: () => string | undefined }).getFilePath ===
              "function"
            ? (attachment as { getFilePath: () => string | undefined }).getFilePath()
            : (attachment as unknown as { attachmentPath?: string }).attachmentPath;
      if (typeof directPath !== "string") return undefined;
      const normalizedPath = directPath.trim();
      return normalizedPath.startsWith("/") ? normalizedPath : undefined;
    };

    const normalizedFallbackItemId =
      typeof fallbackItemId === "number" && Number.isFinite(fallbackItemId)
        ? Math.floor(fallbackItemId)
        : 0;
    const scoreAttachment = (attachment: Zotero.Item): number => {
      const contentType = String(
        (attachment as unknown as { attachmentContentType?: string })
          .attachmentContentType || "",
      )
        .trim()
        .toLowerCase();
      const pathHint = String(
        (attachment as unknown as { attachmentFilename?: string })
          .attachmentFilename || "",
      )
        .trim()
        .toLowerCase();
      if (contentType === "text/markdown" || pathHint.endsWith(".md")) return 100;
      if (contentType === "application/pdf" || pathHint.endsWith(".pdf")) return 90;
      if (contentType === "text/html" || pathHint.endsWith(".html") || pathHint.endsWith(".htm")) return 80;
      if (contentType.startsWith("text/")) return 70;
      return 10;
    };

    try {
      if (normalizedId > 0) {
        const direct = await readAttachmentPath(normalizedId);
        if (direct) return direct;
      }
      if (normalizedFallbackItemId > 0) {
        const parentItem = Zotero.Items.get(normalizedFallbackItemId);
        if (parentItem?.isRegularItem?.()) {
          const attachmentIds = parentItem.getAttachments?.() || [];
          const scoredAttachments = attachmentIds
            .map((attachmentId) => Zotero.Items.get(attachmentId))
            .filter((attachment): attachment is Zotero.Item =>
              Boolean(attachment?.isAttachment?.()),
            )
            .map((attachment) => ({
              attachment,
              score: scoreAttachment(attachment),
            }))
            .sort((a, b) => b.score - a.score);
          for (const { attachment } of scoredAttachments) {
            const path = await readAttachmentPath(attachment.id);
            if (path) return path;
          }
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const enrichPaperContexts = async (
    list: unknown,
  ): Promise<BridgePaperContext[] | undefined> => {
    if (!Array.isArray(list) || !list.length) return undefined;
    const enriched: BridgePaperContext[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const paper = raw as Record<string, unknown>;
      const mineruCacheDir =
        typeof paper.mineruCacheDir === "string" && paper.mineruCacheDir.trim()
          ? paper.mineruCacheDir.trim()
          : undefined;
      const contextFilePath = await resolveAttachmentAbsolutePath(
        paper.contextItemId,
        paper.itemId,
      );
      const context: BridgePaperContext = {
        itemId:
          typeof paper.itemId === "number" && Number.isFinite(paper.itemId)
            ? Math.floor(paper.itemId)
            : undefined,
        contextItemId:
          typeof paper.contextItemId === "number" &&
          Number.isFinite(paper.contextItemId)
            ? Math.floor(paper.contextItemId)
            : undefined,
        title: typeof paper.title === "string" ? paper.title : undefined,
        attachmentTitle:
          typeof paper.attachmentTitle === "string"
            ? paper.attachmentTitle
            : undefined,
        citationKey:
          typeof paper.citationKey === "string" ? paper.citationKey : undefined,
        firstCreator:
          typeof paper.firstCreator === "string"
            ? paper.firstCreator
            : undefined,
        year: typeof paper.year === "string" ? paper.year : undefined,
        mineruCacheDir,
        mineruFullMdPath: mineruCacheDir
          ? joinPath(mineruCacheDir, "full.md")
          : undefined,
        contextFilePath,
      };
      enriched.push(context);
    }
    return enriched.length ? enriched : undefined;
  };

  const attachments = (Array.isArray(request.attachments)
    ? request.attachments
    : []
  )
    .filter((entry) => Boolean(entry))
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      category: attachment.category,
      sizeBytes: attachment.sizeBytes,
      storedPath:
        typeof attachment.storedPath === "string" &&
        attachment.storedPath.trim()
          ? attachment.storedPath.trim()
          : undefined,
      contentHash:
        typeof attachment.contentHash === "string" &&
        attachment.contentHash.trim()
          ? attachment.contentHash.trim()
          : undefined,
    }));

  const screenshots = Array.isArray(request.screenshots)
    ? request.screenshots.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  const [selectedPaperContexts, fullTextPaperContexts, pinnedPaperContexts] =
    await Promise.all([
      enrichPaperContexts(request.selectedPaperContexts),
      enrichPaperContexts(request.fullTextPaperContexts),
      enrichPaperContexts(request.pinnedPaperContexts),
    ]);

  return {
    conversationKey: request.conversationKey,
    userText: request.userText,
    activeItemId: request.activeItemId,
    libraryID: request.libraryID,
    model: request.model,
    apiBase: request.apiBase,
    authMode: request.authMode,
    providerProtocol: request.providerProtocol,
    selectedTexts: Array.isArray(request.selectedTexts) ? request.selectedTexts : undefined,
    selectedTextSources: Array.isArray(request.selectedTextSources)
      ? request.selectedTextSources
      : undefined,
    selectedPaperContexts,
    fullTextPaperContexts,
    pinnedPaperContexts,
    attachments: attachments.length ? attachments : undefined,
    screenshots: screenshots.length ? screenshots : undefined,
    activeNoteContext: request.activeNoteContext
      ? {
          noteId: request.activeNoteContext.noteId,
          title: request.activeNoteContext.title,
          noteKind: request.activeNoteContext.noteKind,
          parentItemId: request.activeNoteContext.parentItemId,
          noteText: request.activeNoteContext.noteText,
        }
      : undefined,
  };
}

function signatureForContextEnvelope(envelope: ContextEnvelope): string {
  return JSON.stringify({
    activeItemId: envelope.activeItemId,
    libraryID: envelope.libraryID,
    selectedTextCount: envelope.selectedTextCount,
    selectedPaperCount: envelope.selectedPaperCount,
    fullTextPaperCount: envelope.fullTextPaperCount,
    pinnedPaperCount: envelope.pinnedPaperCount,
    attachmentCount: envelope.attachmentCount,
    screenshotCount: envelope.screenshotCount,
    selectedPaperIds: envelope.selectedPapers.map((paper) => paper.contextItemId).sort(),
    fullTextPaperIds: envelope.fullTextPapers.map((paper) => paper.contextItemId).sort(),
    pinnedPaperIds: envelope.pinnedPapers.map((paper) => paper.contextItemId).sort(),
    selectedTextFingerprints: envelope.selectedTexts.map((row) => row.text.slice(0, 80)),
    activeNoteId: envelope.activeNote?.noteId,
  });
}

async function fetchExternalTools(baseUrl: string): Promise<ExternalToolDescriptor[]> {
  const sources = encodeURIComponent(getClaudeSettingSourcesByPref().join(","));
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/tools?settingSources=${sources}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  const json = await response.json() as { tools?: unknown[] };
  const rawTools = Array.isArray(json.tools) ? json.tools : [];
  const tools: ExternalToolDescriptor[] = [];
  for (const raw of rawTools) {
    if (!raw || typeof raw !== "object") continue;
    const tool = raw as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name.trim()) continue;
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : tool.name,
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as object)
          : { type: "object", properties: {} },
      mutability: tool.mutability === "write" ? "write" : "read",
      riskLevel:
        tool.riskLevel === "high" || tool.riskLevel === "medium" || tool.riskLevel === "low"
          ? tool.riskLevel
          : "medium",
      requiresConfirmation: Boolean(tool.requiresConfirmation),
      source:
        tool.source === "claude-runtime" || tool.source === "mcp" || tool.source === "zotero-bridge"
          ? tool.source
          : "claude-runtime",
    });
  }
  return tools;
}

async function fetchExternalCommands(baseUrl: string): Promise<ExternalSlashCommandDescriptor[]> {
  const sources = encodeURIComponent(getClaudeSettingSourcesByPref().join(","));
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/commands?settingSources=${sources}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  const json = await response.json() as { commands?: unknown[] };
  const rawCommands = Array.isArray(json.commands) ? json.commands : [];
  const commands: ExternalSlashCommandDescriptor[] = [];
  for (const raw of rawCommands) {
    if (!raw || typeof raw !== "object") continue;
    const command = raw as Record<string, unknown>;
    const name = typeof command.name === "string" ? command.name.trim().replace(/^\/+/, "") : "";
    if (!name) continue;
    commands.push({
      name,
      description:
        typeof command.description === "string" && command.description.trim()
          ? command.description.trim()
          : `Claude Code slash command: /${name}`,
      argumentHint:
        typeof command.argumentHint === "string" ? command.argumentHint.trim() : "",
      source: command.source === "fallback" ? "fallback" : "sdk",
    });
  }
  return commands;
}

export async function fetchExternalBridgeSessionInfo(params: {
  baseUrl: string;
  conversationKey: number;
  scopeType?: BridgeScopeType;
  scopeId?: string;
  scopeLabel?: string;
}): Promise<ExternalBridgeSessionInfo | null> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  if (!baseUrl) return null;
  const qs = new URLSearchParams();
  qs.set("conversationKey", String(params.conversationKey));
  if (params.scopeType) qs.set("scopeType", params.scopeType);
  if (params.scopeId) qs.set("scopeId", params.scopeId);
  if (params.scopeLabel) qs.set("scopeLabel", params.scopeLabel);
  const response = await fetch(`${baseUrl}/session-info?${qs.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  const json = (await response.json()) as {
    session?: ExternalBridgeSessionInfo | null;
  };
  return json?.session || null;
}

async function runExternalBridgeAction(
  baseUrl: string,
  params: {
    conversationKey: number;
    toolName: string;
    args: unknown;
    libraryID?: number;
    approved?: boolean;
    signal?: AbortSignal;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
    onStart?: (runId: string) => void | Promise<void>;
    metadata?: Record<string, unknown>;
  },
): Promise<AgentRuntimeOutcome> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/run-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationKey: params.conversationKey,
      toolName: params.toolName,
      args: params.args,
      libraryID: params.libraryID,
      approved: Boolean(params.approved),
      scopeType:
        typeof params.metadata?.scopeType === "string"
          ? params.metadata.scopeType
          : undefined,
      scopeId:
        typeof params.metadata?.scopeId === "string"
          ? params.metadata.scopeId
          : undefined,
      scopeLabel:
        typeof params.metadata?.scopeLabel === "string"
          ? params.metadata.scopeLabel
          : undefined,
      metadata: params.metadata,
    }),
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`Bridge HTTP ${response.status}`);
  }
  let finalOutcome: AgentRuntimeOutcome | null = null;
  await streamBridgeLines(response, async (line) => {
    if (line.type === "start") {
      await params.onStart?.(line.runId);
      return;
    }
    if (line.type === "event") {
      await params.onEvent?.(line.event);
      return;
    }
    if (line.type === "outcome") {
      finalOutcome = line.outcome;
      return;
    }
    if (line.type === "error") {
      throw new Error(line.error || "Bridge stream error");
    }
  });

  if (!finalOutcome) {
    return {
      kind: "fallback",
      runId: `bridge-action-${Date.now()}`,
      reason: "Bridge ended without outcome",
      usedFallback: true,
    };
  }
  return finalOutcome;
}

export function createExternalBackendBridgeRuntime(options: {
  coreRuntime: AgentRuntime;
  getBridgeUrl: () => string;
}): AgentRuntimeLike {
  const { coreRuntime, getBridgeUrl } = options;
  let cachedTools: ExternalToolDescriptor[] = [];
  let cacheExpiresAt = 0;
  let refreshInFlight: Promise<void> | null = null;
  const conversationContextSignature = new Map<number, string>();
  const conversationScopeByKey = new Map<number, BridgeScope>();
  const TOOL_CACHE_TTL_MS = 60_000;
  let lastToolConfigKey = "";

  const resolveToolConfigKey = (): string => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    const source = getClaudeConfigSourcePref();
    return `${bridgeUrl}|${source}`;
  };

  const refreshExternalActions = async (force = false): Promise<void> => {
    const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
    if (!bridgeUrl) {
      cachedTools = [];
      cacheExpiresAt = 0;
      lastToolConfigKey = "";
      return;
    }
    const configKey = resolveToolConfigKey();
    if (configKey !== lastToolConfigKey) {
      force = true;
      cachedTools = [];
      cacheExpiresAt = 0;
      lastToolConfigKey = configKey;
    }
    if (!force && Date.now() < cacheExpiresAt && cachedTools.length > 0) {
      return;
    }
    if (refreshInFlight) {
      await refreshInFlight;
      return;
    }
    refreshInFlight = (async () => {
      try {
        cachedTools = await fetchExternalTools(bridgeUrl);
        cacheExpiresAt = Date.now() + TOOL_CACHE_TTL_MS;
      } catch (error) {
        ztoolkit.log("LLM Agent: Failed to refresh external actions", error);
      } finally {
        refreshInFlight = null;
      }
    })();
    await refreshInFlight;
  };

  return {
    listTools: () => coreRuntime.listTools(),
    getToolDefinition: (name: string) => coreRuntime.getToolDefinition(name),
    unregisterTool: (name: string) => coreRuntime.unregisterTool(name),
    registerTool: (tool) => coreRuntime.registerTool(tool),
    registerPendingConfirmation: (requestId, resolve) =>
      coreRuntime.registerPendingConfirmation(requestId, resolve),
    resolveConfirmation: (requestId, approvedOrResolution, data) =>
      coreRuntime.resolveConfirmation(requestId, approvedOrResolution, data),
    getRunTrace: (runId: string) => coreRuntime.getRunTrace(runId),
    getCapabilities: (request) => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        return coreRuntime.getCapabilities(request);
      }
      return {
        streaming: true,
        toolCalls: true,
        multimodal: true,
        fileInputs: true,
        reasoning: true,
      };
    },
    listExternalActionsSync: () => {
      if (!normalizeBaseUrl(getBridgeUrl())) {
        return [];
      }
      return cachedTools.map((tool) => ({
        name: toExternalActionName(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
        source: "backend" as const,
        backendToolName: tool.name,
        riskLevel: tool.riskLevel,
        requiresConfirmation: tool.requiresConfirmation,
        mutability: tool.mutability,
      }));
    },
    refreshExternalActions,
    runExternalAction: async (name, input, opts = {}) => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        return { ok: false, error: "External backend bridge is not configured" };
      }
      const toolName = fromExternalActionName(name);
      if (!toolName) {
        return { ok: false, error: `Not an external action: ${name}` };
      }
      const tool = cachedTools.find((entry) => entry.name === toolName);
      const onProgress = opts.onProgress ?? (() => {});
      const actionConversationKey =
        typeof opts.conversationKey === "number" && Number.isFinite(opts.conversationKey)
          ? Math.floor(opts.conversationKey)
          : Date.now();
      const actionScope = conversationScopeByKey.get(actionConversationKey);

      onProgress({ type: "step_start", step: `Run ${toolName}`, index: 1, total: 1 });
      const doRun = async (approved = false): Promise<ActionResult<unknown>> => {
        const outcome = await runExternalBridgeAction(bridgeUrl, {
          conversationKey: actionConversationKey,
          toolName,
          args: input,
          libraryID: opts.libraryID,
          approved,
          metadata: {
            runType: "action",
            claudeConfigSource: getClaudeConfigSourcePref(),
            claudeSettingSources: getClaudeSettingSourcesByPref(),
            permissionMode: getAgentPermissionModePref(),
            scopeType: actionScope?.scopeType,
            scopeId: actionScope?.scopeId,
            scopeLabel: actionScope?.scopeLabel,
          },
          onEvent: async (event) => {
            if (event.type === "status") {
              onProgress({ type: "status", message: event.text });
            }
          },
        });

        if (outcome.kind === "fallback" && outcome.reason === "approval_required") {
          if (
            tool?.requiresConfirmation &&
            opts.confirmationMode === "native_ui" &&
            typeof opts.requestConfirmation === "function"
          ) {
            const requestId = `ext-confirm-${Date.now()}`;
            const pendingAction: AgentPendingAction = {
              toolName,
              title: `Approve ${toolName}`,
              mode: "approval",
              confirmLabel: "Run",
              cancelLabel: "Cancel",
              description: `This action is marked as ${tool.riskLevel} risk.`,
              fields: [],
            };
            onProgress({ type: "confirmation_required", requestId, action: pendingAction });
            const resolution = await opts.requestConfirmation(requestId, pendingAction);
            if (!resolution.approved) {
              return { ok: false, error: "User denied action" };
            }
            return doRun(true);
          }
          return { ok: false, error: "Approval required" };
        }

        if (outcome.kind === "fallback") {
          return { ok: false, error: outcome.reason || "Action failed" };
        }
        return { ok: true, output: outcome.text };
      };

      const result = await doRun(false);
      onProgress({
        type: "step_done",
        step: `Run ${toolName}`,
        summary: result.ok ? "Completed" : `Failed: ${result.error}`,
      });
      return result;
    },
    runTurn: async (params: RunTurnParams): Promise<AgentRuntimeOutcome> => {
      const bridgeUrl = normalizeBaseUrl(getBridgeUrl());
      if (!bridgeUrl) {
        return coreRuntime.runTurn(params);
      }
      const contextEnvelope = buildContextEnvelope(params.request);
      const runtimeRequest = await buildBridgeRuntimeRequest(params.request);
      const scope = resolveBridgeScope(params.request);
      conversationScopeByKey.set(params.request.conversationKey, scope);
      const currentSignature = signatureForContextEnvelope(contextEnvelope);
      const previousSignature = conversationContextSignature.get(
        params.request.conversationKey,
      );
      const contextStatus =
        previousSignature && previousSignature === currentSignature
          ? "Reused previous context"
          : "Detected updated context";
      conversationContextSignature.set(params.request.conversationKey, currentSignature);
      await params.onEvent?.({ type: "status", text: contextStatus });
      try {
        return await runExternalBridgeTurn(bridgeUrl, {
          ...params,
          contextEnvelope,
          runtimeRequest,
          scope,
          registerPendingConfirmation: (requestId, resolve) =>
            coreRuntime.registerPendingConfirmation(requestId, resolve),
          resolveExternalConfirmation: async (requestId, resolution) => {
            await fetch(`${normalizeBaseUrl(bridgeUrl)}/resolve-confirmation`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                requestId,
                approved: Boolean(resolution.approved),
                actionId: resolution.actionId,
                data: resolution.data,
              }),
            });
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (typeof ztoolkit !== "undefined" && typeof ztoolkit.log === "function") {
          ztoolkit.log("LLM Agent: External bridge unavailable, fallback to local runtime", message);
        }
        await params.onEvent?.({
          type: "status",
          text: "External agent backend unavailable; fell back to local runtime",
        });
        return coreRuntime.runTurn(params);
      }
    },
  };
}
