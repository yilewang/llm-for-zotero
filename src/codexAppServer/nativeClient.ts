import type {
  ChatMessage,
  MessageContent,
  ReasoningConfig,
  ReasoningEvent,
  TextContent,
  UsageStats,
} from "../shared/llm";
import type { AgentConfirmationResolution } from "../agent/types";
import type {
  ChatAttachment,
  CodexConversationKind,
  CollectionContextRef,
  PaperContextRef,
  SelectedTextSource,
} from "../shared/types";
import {
  addZoteroMcpToolActivityObserver,
  addZoteroMcpConfirmationHandler,
  ZOTERO_MCP_SERVER_NAME,
  registerScopedZoteroMcpScope,
  setActiveZoteroMcpScope,
  type ZoteroMcpConfirmationRequest,
  type ZoteroMcpToolActivityEvent,
} from "../agent/mcp/server";
import {
  buildLegacyCodexAppServerChatInput,
  prepareCodexAppServerChatTurn,
} from "../utils/codexAppServerInput";
import {
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  isCodexAppServerThreadStartInstructionsUnsupportedError,
  resolveCodexAppServerBinaryPath,
  resolveCodexAppServerReasoningParams,
  resolveCodexAppServerTurnInputWithFallback,
  waitForCodexAppServerTurnCompletion,
  type CodexAppServerAgentMessageDeltaEvent,
  type CodexAppServerItemEvent,
  type CodexAppServerProcess,
} from "../utils/codexAppServerProcess";
import {
  getCodexConversationSummary,
  upsertCodexConversationSummary,
} from "./store";
import { isCodexZoteroMcpToolsEnabled } from "./prefs";
import { getCodexProfileSignature } from "./constants";
import {
  assertRequiredCodexZoteroMcpToolsReady,
  buildCodexZoteroMcpThreadConfig,
  preflightCodexZoteroMcpServer,
  type CodexNativeMcpSetupStatus,
} from "./mcpSetup";
import {
  resolveCodexNativeSkills,
  type CodexNativeSkillContext,
} from "./nativeSkills";
import {
  buildCodexNativePriorReadContextBlock,
  recordCodexNativeReadActivity,
} from "./nativeContextLedger";
import { buildNotesDirectoryConfigSection } from "../utils/notesDirectoryConfig";

export const CODEX_APP_SERVER_NATIVE_PROCESS_KEY = "codex_app_server_native";
const CODEX_APP_SERVER_SERVICE_NAME = "llm_for_zotero";

export type CodexNativeConversationScope = {
  profileSignature?: string;
  conversationKey: number;
  libraryID: number;
  kind: CodexConversationKind;
  paperItemID?: number;
  activeItemId?: number;
  activeContextItemId?: number;
  activeNoteId?: number;
  activeNoteKind?: "item" | "standalone";
  activeNoteTitle?: string;
  activeNoteParentItemId?: number;
  libraryName?: string;
  paperTitle?: string;
  paperContext?: PaperContextRef;
  title?: string;
};

export type CodexNativeStoreHooks = {
  loadProviderSessionId?: () => Promise<string | undefined>;
  persistProviderSessionId?: (threadId: string) => Promise<void>;
};

export type CodexNativeTurnResult = {
  text: string;
  threadId: string;
  resumed: boolean;
  diagnostics?: CodexNativeDiagnostics;
};

export type CodexNativeApprovalRequest = {
  method: string;
  params: unknown;
};

export type CodexNativeApprovalDecision = {
  approved: boolean;
  response: unknown;
  reason: string;
  target?: string;
};

type NativeThreadResolution = {
  threadId: string;
  resumed: boolean;
  developerInstructionsAccepted: boolean;
  threadSource?: string;
};

export type CodexNativeResourceDeltaCounts = {
  added: number;
  removed: number;
  changed: number;
};

export type CodexNativeDiagnostics = {
  threadId: string;
  threadSource?: string;
  profileSignature: string;
  libraryID: number;
  libraryName?: string;
  mcpServerName?: string;
  mcpReady: boolean;
  mcpToolNames: string[];
  skillIds: string[];
  lifecycleState?: CodexNativeLifecycleState;
  contextInjection?: CodexNativeContextInjection;
  resourceDelta?: CodexNativeResourceDeltaCounts;
  historyVerified?: boolean;
};

export type CodexNativeLifecycleState =
  | "setup-required"
  | "resources-changed"
  | "resources-delta"
  | "thin-followup";

export type CodexNativeContextInjection =
  | "full"
  | "delta"
  | "delta-visible-fallback"
  | "thin"
  | "thin-visible-fallback";

const CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS = [
  "item/tool/requestUserInput",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
  "tool/requestUserInput",
  "approval/request",
  "approval/requested",
  "turn/approval/request",
  "execCommandApproval",
  "applyPatchApproval",
];

const DISALLOWED_ZOTERO_MCP_APPROVAL_MARKERS = ["zotero_confirm_action"];
const CODEX_APP_SERVER_NATIVE_APPROVAL_PARAMS = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
};
const CODEX_NATIVE_HISTORY_VERIFICATION_TTL_MS = 5 * 60 * 1000;
const CODEX_NATIVE_RESOURCE_DELTA_MAX_LINES = 12;
const CODEX_APP_SERVER_GUARDIAN_REVIEW_COMPLETED_METHOD =
  "item/autoApprovalReview/completed";
const nativeHistoryVerificationState = new Map<string, number>();
type CodexNativeResourceRecord = {
  key: string;
  signature: string;
  line: string;
};

type CodexNativeResourceSnapshot = {
  baseScope: Record<string, unknown>;
  resources: {
    selectedPapers: CodexNativeResourceRecord[];
    fullTextPapers: CodexNativeResourceRecord[];
    collections: CodexNativeResourceRecord[];
    selectedTexts: CodexNativeResourceRecord[];
    screenshots: CodexNativeResourceRecord[];
    attachments: CodexNativeResourceRecord[];
  };
};

type CodexNativeResourceDelta = {
  added: CodexNativeResourceRecord[];
  removed: CodexNativeResourceRecord[];
  changed: CodexNativeResourceRecord[];
  unchanged: number;
};

type CodexNativeLifecycleEntry = {
  resourceSignature: string;
  resourceSnapshot: CodexNativeResourceSnapshot;
  developerInstructionsAccepted: boolean;
  lastSetupAt: number;
  mcpStatus?: CodexNativeMcpSetupStatus;
};

const nativeResourceLifecycleState = new Map<
  string,
  CodexNativeLifecycleEntry
>();

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function clearCodexNativeHistoryVerificationState(): void {
  nativeHistoryVerificationState.clear();
}

export function clearCodexNativeResourceLifecycleState(): void {
  nativeResourceLifecycleState.clear();
}

function serializeApprovalPayload(value: unknown): string {
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return String(value || "").toLowerCase();
  }
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function lifecycleKey(params: {
  profileSignature?: string;
  conversationKey: number;
  threadId: string;
}): string {
  return [
    normalizeNonEmptyString(params.profileSignature) || "default-profile",
    normalizePositiveInt(params.conversationKey) || 0,
    normalizeNonEmptyString(params.threadId),
  ].join(":");
}

function normalizePaperResource(
  paper: PaperContextRef | undefined,
): Record<string, unknown> | null {
  if (!paper) return null;
  return {
    itemId: normalizePositiveInt(paper.itemId) || 0,
    contextItemId: normalizePositiveInt(paper.contextItemId) || 0,
    mineruCacheDir: normalizeNonEmptyString(paper.mineruCacheDir),
  };
}

function sortNativeResourceRecords(
  records: CodexNativeResourceRecord[],
): CodexNativeResourceRecord[] {
  return [...records].sort((a, b) => a.key.localeCompare(b.key));
}

function formatResourceFields(fields: Array<[string, unknown]>): string {
  return fields
    .map(([key, value]) => {
      if (value === undefined || value === null || value === "") return "";
      return typeof value === "string"
        ? `${key}="${value}"`
        : `${key}=${String(value)}`;
    })
    .filter(Boolean)
    .join(", ");
}

function makeNativeResourceRecord(params: {
  key: string;
  label: string;
  signature: Record<string, unknown>;
  fields: Array<[string, unknown]>;
}): CodexNativeResourceRecord {
  return {
    key: normalizeNonEmptyString(params.key),
    signature: JSON.stringify(params.signature),
    line: `- ${params.label}: ${formatResourceFields(params.fields)}`,
  };
}

function normalizeSelectedTextSources(
  selectedTexts: string[] | undefined,
  selectedTextSources: SelectedTextSource[] | undefined,
): SelectedTextSource[] {
  const texts = Array.isArray(selectedTexts) ? selectedTexts : [];
  const sources = Array.isArray(selectedTextSources) ? selectedTextSources : [];
  return texts.map((_, index) => sources[index] || "pdf");
}

function buildPaperResourceRecord(params: {
  paper: PaperContextRef;
  label: string;
}): CodexNativeResourceRecord | null {
  const itemId = normalizePositiveInt(params.paper.itemId) || 0;
  const contextItemId = normalizePositiveInt(params.paper.contextItemId) || 0;
  if (!itemId && !contextItemId) return null;
  const title = normalizeNonEmptyString(params.paper.title);
  const citationKey = normalizeNonEmptyString(params.paper.citationKey);
  const firstCreator = normalizeNonEmptyString(params.paper.firstCreator);
  const year = normalizeNonEmptyString(params.paper.year);
  const attachmentTitle = normalizeNonEmptyString(params.paper.attachmentTitle);
  const mineruCacheDir = normalizeNonEmptyString(params.paper.mineruCacheDir);
  const signature = {
    itemId,
    contextItemId,
    title,
    citationKey,
    firstCreator,
    year,
    attachmentTitle,
    mineruCacheDir,
  };
  return makeNativeResourceRecord({
    key: `paper:${itemId}:${contextItemId}:${mineruCacheDir}`,
    label: params.label,
    signature,
    fields: [
      ["itemId", itemId],
      ["contextItemId", contextItemId],
      ["title", title],
      ["citationKey", citationKey],
      ["firstCreator", firstCreator],
      ["year", year],
      ["mineruCacheDir", mineruCacheDir],
    ],
  });
}

function buildPaperResourceRecords(params: {
  papers?: PaperContextRef[];
  label: string;
}): CodexNativeResourceRecord[] {
  return sortNativeResourceRecords(
    (Array.isArray(params.papers) ? params.papers : [])
      .map((paper) => buildPaperResourceRecord({ paper, label: params.label }))
      .filter((record): record is CodexNativeResourceRecord => Boolean(record)),
  );
}

function buildCollectionResourceRecords(
  collections: CollectionContextRef[] | undefined,
): CodexNativeResourceRecord[] {
  return sortNativeResourceRecords(
    (Array.isArray(collections) ? collections : []).map((collection) => {
      const collectionId = normalizePositiveInt(collection.collectionId) || 0;
      const libraryID = normalizePositiveInt(collection.libraryID) || 0;
      const name = normalizeNonEmptyString(collection.name);
      return makeNativeResourceRecord({
        key: `collection:${libraryID}:${collectionId}`,
        label: "Selected collection",
        signature: { collectionId, libraryID, name },
        fields: [
          ["collectionId", collectionId],
          ["libraryID", libraryID],
          ["name", name],
        ],
      });
    }),
  );
}

function buildSelectedTextResourceRecords(
  skillContext: CodexNativeSkillContext | undefined,
): CodexNativeResourceRecord[] {
  const selectedTexts = Array.isArray(skillContext?.selectedTexts)
    ? skillContext.selectedTexts
    : [];
  if (!selectedTexts.length) return [];
  const sources = normalizeSelectedTextSources(
    selectedTexts,
    skillContext?.selectedTextSources,
  );
  return selectedTexts
    .map((text, index) => ({
      source: sources[index],
      text,
      paper: normalizePaperResource(
        skillContext?.selectedTextPaperContexts?.[index],
      ),
    }))
    .filter((entry) => entry.source !== "model")
    .map((entry) => ({
      source: entry.source,
      textHash: hashString(normalizeNonEmptyString(entry.text)),
      textLength: normalizeNonEmptyString(entry.text).length,
      paper: entry.paper,
    }))
    .map((entry) =>
      makeNativeResourceRecord({
        key: `selected-text:${entry.source}:${entry.textHash}:${JSON.stringify(entry.paper || {})}`,
        label: "Selected text",
        signature: entry,
        fields: [
          ["source", entry.source],
          ["textHash", entry.textHash],
          ["textLength", entry.textLength],
          [
            "paperItemId",
            normalizePositiveInt(entry.paper?.itemId) || undefined,
          ],
          [
            "paperContextItemId",
            normalizePositiveInt(entry.paper?.contextItemId) || undefined,
          ],
        ],
      }),
    );
}

function buildScreenshotResourceRecords(
  screenshots: string[] | undefined,
): CodexNativeResourceRecord[] {
  return sortNativeResourceRecords(
    (Array.isArray(screenshots) ? screenshots : []).map((screenshot) => {
      const imageHash = hashString(normalizeNonEmptyString(screenshot));
      return makeNativeResourceRecord({
        key: `screenshot:${imageHash}`,
        label: "Screenshot",
        signature: { imageHash },
        fields: [["imageHash", imageHash]],
      });
    }),
  );
}

function buildAttachmentResourceRecords(
  attachments: ChatAttachment[] | undefined,
): CodexNativeResourceRecord[] {
  return sortNativeResourceRecords(
    (Array.isArray(attachments) ? attachments : []).map((attachment) => {
      const id = normalizeNonEmptyString(attachment.id);
      const name = normalizeNonEmptyString(attachment.name);
      const category = normalizeNonEmptyString(attachment.category);
      const mimeType = normalizeNonEmptyString(attachment.mimeType);
      const contentHash = normalizeNonEmptyString(attachment.contentHash);
      const storedPath = normalizeNonEmptyString(attachment.storedPath);
      const sizeBytes = normalizePositiveInt(attachment.sizeBytes) || 0;
      const key =
        contentHash ||
        id ||
        storedPath ||
        `${name}:${category}:${mimeType}:${sizeBytes}`;
      const signature = {
        id,
        name,
        category,
        mimeType,
        contentHash,
        storedPath,
        sizeBytes,
      };
      return makeNativeResourceRecord({
        key: `attachment:${key}`,
        label: "File attachment",
        signature,
        fields: [
          ["name", name],
          ["category", category],
          ["mimeType", mimeType],
          ["sizeBytes", sizeBytes || undefined],
          ["contentHash", contentHash],
        ],
      });
    }),
  );
}

function buildCodexNativeBaseScopeSnapshot(params: {
  scope: CodexNativeConversationScope;
  profileSignature: string;
}): Record<string, unknown> {
  const { scope } = params;
  return {
    profileSignature: params.profileSignature,
    conversationKey: normalizePositiveInt(scope.conversationKey) || 0,
    libraryID: normalizePositiveInt(scope.libraryID) || 0,
    kind: scope.kind,
    paperItemID: normalizePositiveInt(scope.paperItemID) || 0,
    activeItemId: normalizePositiveInt(scope.activeItemId) || 0,
    activeContextItemId: normalizePositiveInt(scope.activeContextItemId) || 0,
    activeNoteId: normalizePositiveInt(scope.activeNoteId) || 0,
    activeNoteKind: normalizeNonEmptyString(scope.activeNoteKind),
    activeNoteParentItemId:
      normalizePositiveInt(scope.activeNoteParentItemId) || 0,
    paperContext: normalizePaperResource(scope.paperContext),
  };
}

function buildCodexNativeResourceSnapshot(params: {
  scope: CodexNativeConversationScope;
  profileSignature: string;
  skillContext?: CodexNativeSkillContext;
}): CodexNativeResourceSnapshot {
  const { skillContext } = params;
  return {
    baseScope: buildCodexNativeBaseScopeSnapshot({
      scope: params.scope,
      profileSignature: params.profileSignature,
    }),
    resources: {
      selectedPapers: buildPaperResourceRecords({
        papers: skillContext?.selectedPaperContexts,
        label: "Selected paper",
      }),
      fullTextPapers: buildPaperResourceRecords({
        papers: skillContext?.fullTextPaperContexts,
        label: "Full-text paper",
      }),
      collections: buildCollectionResourceRecords(
        skillContext?.selectedCollectionContexts,
      ),
      selectedTexts: buildSelectedTextResourceRecords(skillContext),
      screenshots: buildScreenshotResourceRecords(skillContext?.screenshots),
      attachments: buildAttachmentResourceRecords(skillContext?.attachments),
    },
  };
}

function buildCodexNativeResourceSignatureFromSnapshot(
  snapshot: CodexNativeResourceSnapshot,
): string {
  return JSON.stringify(snapshot);
}

function flattenCodexNativeResourceSnapshot(
  snapshot: CodexNativeResourceSnapshot,
): CodexNativeResourceRecord[] {
  const records: CodexNativeResourceRecord[] = [];
  for (const [group, groupRecords] of Object.entries(snapshot.resources)) {
    for (const record of groupRecords) {
      records.push({
        ...record,
        key: `${group}:${record.key}`,
      });
    }
  }
  return sortNativeResourceRecords(records);
}

function diffCodexNativeResourceSnapshots(params: {
  previous: CodexNativeResourceSnapshot;
  current: CodexNativeResourceSnapshot;
}): CodexNativeResourceDelta {
  const previousRecords = new Map(
    flattenCodexNativeResourceSnapshot(params.previous).map((record) => [
      record.key,
      record,
    ]),
  );
  const currentRecords = new Map(
    flattenCodexNativeResourceSnapshot(params.current).map((record) => [
      record.key,
      record,
    ]),
  );
  const added: CodexNativeResourceRecord[] = [];
  const removed: CodexNativeResourceRecord[] = [];
  const changed: CodexNativeResourceRecord[] = [];
  let unchanged = 0;
  for (const [key, current] of currentRecords) {
    const previous = previousRecords.get(key);
    if (!previous) {
      added.push(current);
    } else if (previous.signature !== current.signature) {
      changed.push(current);
    } else {
      unchanged += 1;
    }
  }
  for (const [key, previous] of previousRecords) {
    if (!currentRecords.has(key)) removed.push(previous);
  }
  return {
    added: sortNativeResourceRecords(added),
    removed: sortNativeResourceRecords(removed),
    changed: sortNativeResourceRecords(changed),
    unchanged,
  };
}

function getCodexNativeResourceDeltaCounts(
  delta: CodexNativeResourceDelta | undefined,
): CodexNativeResourceDeltaCounts | undefined {
  if (!delta) return undefined;
  return {
    added: delta.added.length,
    removed: delta.removed.length,
    changed: delta.changed.length,
  };
}

function getLifecycleEntry(params: {
  profileSignature: string;
  conversationKey: number;
  threadId?: string;
}): CodexNativeLifecycleEntry | undefined {
  const threadId = normalizeNonEmptyString(params.threadId);
  if (!threadId) return undefined;
  return nativeResourceLifecycleState.get(
    lifecycleKey({
      profileSignature: params.profileSignature,
      conversationKey: params.conversationKey,
      threadId,
    }),
  );
}

function resolveCodexNativeLifecycleState(params: {
  storedThreadId?: string;
  lifecycleEntry?: CodexNativeLifecycleEntry;
  resourceSignature: string;
  resourceSnapshot: CodexNativeResourceSnapshot;
  forcedSkillIds?: string[];
}): CodexNativeLifecycleState {
  if (!normalizeNonEmptyString(params.storedThreadId)) return "setup-required";
  if (Array.isArray(params.forcedSkillIds) && params.forcedSkillIds.length) {
    return "resources-changed";
  }
  if (!params.lifecycleEntry) return "setup-required";
  if (params.lifecycleEntry.resourceSignature !== params.resourceSignature) {
    const previousBaseScope = JSON.stringify(
      params.lifecycleEntry.resourceSnapshot.baseScope,
    );
    const currentBaseScope = JSON.stringify(params.resourceSnapshot.baseScope);
    return previousBaseScope === currentBaseScope
      ? "resources-delta"
      : "resources-changed";
  }
  return "thin-followup";
}

function recordCodexNativeLifecycleSetup(params: {
  profileSignature: string;
  conversationKey: number;
  threadId: string;
  resourceSignature: string;
  resourceSnapshot: CodexNativeResourceSnapshot;
  developerInstructionsAccepted: boolean;
  mcpStatus?: CodexNativeMcpSetupStatus;
}): void {
  const threadId = normalizeNonEmptyString(params.threadId);
  if (!threadId) return;
  nativeResourceLifecycleState.set(
    lifecycleKey({
      profileSignature: params.profileSignature,
      conversationKey: params.conversationKey,
      threadId,
    }),
    {
      resourceSignature: params.resourceSignature,
      resourceSnapshot: params.resourceSnapshot,
      developerInstructionsAccepted: params.developerInstructionsAccepted,
      lastSetupAt: Date.now(),
      mcpStatus: params.mcpStatus,
    },
  );
}

function isCodexAppServerApprovalRequestMethod(method: string): boolean {
  return (
    CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS as readonly string[]
  ).includes(method);
}

function isTrustedZoteroMcpPayload(value: unknown): boolean {
  const serialized = serializeApprovalPayload(value);
  const isZoteroMcpRequest =
    serialized.includes(ZOTERO_MCP_SERVER_NAME) ||
    serialized.includes("llm-for-zotero") ||
    serialized.includes("zotero mcp");
  if (!isZoteroMcpRequest) return false;
  return !DISALLOWED_ZOTERO_MCP_APPROVAL_MARKERS.some((name) =>
    serialized.includes(name),
  );
}

function getApprovalRequestTarget(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const record = params as Record<string, unknown>;
  const direct = [
    "serverName",
    "server",
    "toolName",
    "tool",
    "itemId",
    "approvalId",
  ]
    .map((key) => normalizeNonEmptyString(record[key]))
    .filter(Boolean);
  if (direct.length) return direct.join("/");
  const questions = Array.isArray(record.questions) ? record.questions : [];
  const questionText = questions
    .map((entry) =>
      entry && typeof entry === "object"
        ? normalizeNonEmptyString((entry as Record<string, unknown>).question)
        : "",
    )
    .filter(Boolean)
    .join(" | ");
  return questionText.slice(0, 180);
}

function chooseToolUserInputAnswer(question: unknown): string[] {
  if (!question || typeof question !== "object") return ["approved"];
  const record = question as Record<string, unknown>;
  const options = Array.isArray(record.options) ? record.options : [];
  const choices = options
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const option = entry as Record<string, unknown>;
      const label = normalizeNonEmptyString(option.label);
      const value = normalizeNonEmptyString(option.value);
      const id = normalizeNonEmptyString(option.id);
      const answer = label || value || id;
      const searchable = [label, value, id].filter(Boolean).join(" ");
      return answer ? { answer, searchable } : null;
    })
    .filter((entry): entry is { answer: string; searchable: string } =>
      Boolean(entry),
    );
  const positivePattern =
    /\b(allow|approve|approved|accept|accepted|yes|continue|ok|trust|trusted)\b/i;
  const negativePattern =
    /\b(deny|denied|reject|rejected|decline|cancel|no)\b/i;
  const preferred =
    choices.find(
      (choice) =>
        positivePattern.test(choice.searchable) &&
        !negativePattern.test(choice.searchable),
    )?.answer ||
    choices.find(
      (choice) =>
        /\brecommended\b/i.test(choice.searchable) &&
        !negativePattern.test(choice.searchable),
    )?.answer ||
    choices.find((choice) => !negativePattern.test(choice.searchable))
      ?.answer ||
    choices[0]?.answer ||
    "approved";
  return [preferred];
}

function buildToolRequestUserInputResponse(params: unknown): {
  answers: Record<string, { answers: string[] }>;
} {
  const answers: Record<string, { answers: string[] }> = {};
  if (!params || typeof params !== "object") return { answers };
  const questions = Array.isArray((params as Record<string, unknown>).questions)
    ? ((params as Record<string, unknown>).questions as unknown[])
    : [];
  for (const [index, question] of questions.entries()) {
    const id =
      question && typeof question === "object"
        ? normalizeNonEmptyString((question as Record<string, unknown>).id)
        : "";
    answers[id || `q${index + 1}`] = {
      answers: chooseToolUserInputAnswer(question),
    };
  }
  return { answers };
}

function buildTrustedZoteroMcpApprovalResponse(
  request: CodexNativeApprovalRequest,
): unknown {
  if (request.method === "item/tool/requestUserInput") {
    return buildToolRequestUserInputResponse(request.params);
  }
  return { approved: true };
}

export function resolveSafeCodexNativeApprovalRequest(
  request: CodexNativeApprovalRequest,
): CodexNativeApprovalDecision | null {
  if (!isCodexAppServerApprovalRequestMethod(request.method)) {
    return null;
  }
  if (
    request.method !== "item/tool/requestUserInput" &&
    request.method !== "tool/requestUserInput" &&
    request.method !== "approval/request" &&
    request.method !== "approval/requested" &&
    request.method !== "turn/approval/request"
  ) {
    return null;
  }
  if (!isTrustedZoteroMcpPayload(request.params)) return null;

  return {
    approved: true,
    response: buildTrustedZoteroMcpApprovalResponse(request),
    reason: "trusted_zotero_mcp",
    target: getApprovalRequestTarget(request.params),
  };
}

export function resolveCodexNativeApprovalRequest(
  request: CodexNativeApprovalRequest,
): CodexNativeApprovalDecision {
  const safeDecision = resolveSafeCodexNativeApprovalRequest(request);
  if (safeDecision) return safeDecision;

  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return {
        approved: false,
        response: { decision: "decline" },
        reason: "blocked_builtin_command",
        target: getApprovalRequestTarget(request.params),
      };
    case "item/fileChange/requestApproval":
      return {
        approved: false,
        response: { decision: "decline" },
        reason: "blocked_builtin_file_change",
        target: getApprovalRequestTarget(request.params),
      };
    case "item/permissions/requestApproval":
      return {
        approved: false,
        response: { permissions: {}, scope: "turn" },
        reason: "blocked_builtin_permissions",
        target: getApprovalRequestTarget(request.params),
      };
    case "mcpServer/elicitation/request":
      return {
        approved: false,
        response: { action: "decline", content: null, _meta: null },
        reason: "unsupported_mcp_elicitation",
        target: getApprovalRequestTarget(request.params),
      };
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        approved: false,
        response: { decision: "denied" },
        reason: "blocked_legacy_builtin_approval",
        target: getApprovalRequestTarget(request.params),
      };
    default:
      return {
        approved: false,
        response: {
          approved: false,
          error:
            "Zotero only auto-approves trusted llm_for_zotero MCP access. " +
            "Built-in Codex approvals are disabled.",
        },
        reason: "untrusted_or_unsupported_approval",
        target: getApprovalRequestTarget(request.params),
      };
  }
}

function summarizeApprovalResponseShape(response: unknown): string {
  if (!response || typeof response !== "object") return typeof response;
  return (
    Object.keys(response as Record<string, unknown>)
      .sort()
      .join(",") || "{}"
  );
}

function logCodexNativeApprovalDecision(params: {
  method: string;
  requestParams: unknown;
  decision: CodexNativeApprovalDecision;
}): void {
  ztoolkit.log("Codex app-server native approval", {
    method: params.method,
    target:
      params.decision.target || getApprovalRequestTarget(params.requestParams),
    approved: params.decision.approved,
    reason: params.decision.reason,
    responseShape: summarizeApprovalResponseShape(params.decision.response),
  });
}

function buildGuardianAssessmentAction(
  action: Record<string, unknown>,
): unknown {
  const type = normalizeNonEmptyString(action.type);
  if (type === "mcpToolCall" || type === "mcp_tool_call") {
    return {
      type: "mcp_tool_call",
      server: normalizeNonEmptyString(action.server),
      tool_name: normalizeNonEmptyString(action.toolName || action.tool_name),
      connector_id:
        normalizeNonEmptyString(action.connectorId || action.connector_id) ||
        null,
      connector_name:
        normalizeNonEmptyString(
          action.connectorName || action.connector_name,
        ) || null,
      tool_title:
        normalizeNonEmptyString(action.toolTitle || action.tool_title) || null,
    };
  }
  return action;
}

function buildGuardianAssessmentEvent(
  rawParams: unknown,
): Record<string, unknown> {
  const params = normalizeRecord(rawParams);
  const review = normalizeRecord(params.review);
  const action = normalizeRecord(params.action);
  return {
    target_item_id:
      normalizeNonEmptyString(params.targetItemId || params.target_item_id) ||
      null,
    risk_level: review.riskLevel ?? review.risk_level ?? null,
    user_authorization:
      review.userAuthorization ?? review.user_authorization ?? null,
    rationale: review.rationale ?? null,
    decision_source: params.decisionSource ?? params.decision_source ?? "agent",
    action: buildGuardianAssessmentAction(action),
  };
}

function isDeniedTrustedZoteroMcpGuardianReview(rawParams: unknown): boolean {
  const params = normalizeRecord(rawParams);
  const review = normalizeRecord(params.review);
  const action = normalizeRecord(params.action);
  const status = normalizeNonEmptyString(review.status).toLowerCase();
  const actionType = normalizeNonEmptyString(action.type);
  if (status !== "denied") return false;
  if (actionType !== "mcpToolCall" && actionType !== "mcp_tool_call") {
    return false;
  }
  return isTrustedZoteroMcpPayload(action);
}

function registerNativeGuardianReviewHandlers(params: {
  proc: CodexAppServerProcess;
  threadId: string;
}): () => void {
  return params.proc.onNotification(
    CODEX_APP_SERVER_GUARDIAN_REVIEW_COMPLETED_METHOD,
    (rawParams) => {
      if (!isDeniedTrustedZoteroMcpGuardianReview(rawParams)) {
        ztoolkit.log("Codex app-server native guardian review observed", {
          method: CODEX_APP_SERVER_GUARDIAN_REVIEW_COMPLETED_METHOD,
          target: getApprovalRequestTarget(rawParams),
          trustedZoteroMcp: false,
        });
        return;
      }
      const event = buildGuardianAssessmentEvent(rawParams);
      ztoolkit.log(
        "Codex app-server native: approving trusted Zotero MCP guardian denial",
        event,
      );
      void params.proc
        .sendRequest("thread/approveGuardianDeniedAction", {
          threadId: params.threadId,
          event,
        })
        .catch((error) => {
          ztoolkit.log(
            "Codex app-server native: failed to approve trusted Zotero MCP guardian denial",
            error,
          );
        });
    },
  );
}

function extractCodexAppServerThreadSource(
  result: unknown,
): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const source = (result as { thread?: unknown }).thread || result;
  if (!source || typeof source !== "object") return undefined;
  const raw = (source as { source?: unknown }).source;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") return JSON.stringify(raw);
  return undefined;
}

function extractSystemText(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string" ? message.content.trim() : "",
    )
    .filter(Boolean)
    .join("\n\n");
}

function extractLatestUserText(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim();
    return message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text || "")
      .join("\n")
      .trim();
  }
  return "";
}

function formatScopeLine(label: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return `- ${label}: ${value}`;
}

function formatPaperContextLine(
  paperContext: PaperContextRef | undefined,
): string | null {
  if (!paperContext) return null;
  const pieces = [
    `itemId=${paperContext.itemId}`,
    `contextItemId=${paperContext.contextItemId}`,
  ];
  if (paperContext.title) pieces.push(`title="${paperContext.title}"`);
  if (paperContext.firstCreator)
    pieces.push(`firstCreator="${paperContext.firstCreator}"`);
  if (paperContext.year) pieces.push(`year="${paperContext.year}"`);
  if (paperContext.attachmentTitle) {
    pieces.push(`attachmentTitle="${paperContext.attachmentTitle}"`);
  }
  if (paperContext.mineruCacheDir) {
    pieces.push(`mineruCacheDir="${paperContext.mineruCacheDir}"`);
  }
  return `- Active paper context: ${pieces.join(", ")}`;
}

function formatPaperResourceLine(paper: PaperContextRef): string {
  const pieces = [
    `itemId=${paper.itemId}`,
    `contextItemId=${paper.contextItemId}`,
  ];
  if (paper.title) pieces.push(`title="${paper.title}"`);
  if (paper.citationKey) pieces.push(`citationKey="${paper.citationKey}"`);
  if (paper.mineruCacheDir) {
    pieces.push(`mineruCacheDir="${paper.mineruCacheDir}"`);
  }
  return `- ${pieces.join(", ")}`;
}

function buildSelectedTextResourceLine(params: {
  selectedTexts?: string[];
  selectedTextSources?: SelectedTextSource[];
}): string | null {
  const selectedTexts = Array.isArray(params.selectedTexts)
    ? params.selectedTexts
    : [];
  if (!selectedTexts.length) return null;
  const sources = normalizeSelectedTextSources(
    selectedTexts,
    params.selectedTextSources,
  ).filter((source) => source !== "model");
  if (!sources.length) return null;
  const counts = new Map<string, number>();
  for (const source of sources)
    counts.set(source, (counts.get(source) || 0) + 1);
  const sourceLabel = Array.from(counts.entries())
    .map(([source, count]) => `${source}:${count}`)
    .join(", ");
  return `- Selected non-model text contexts: ${sources.length} (${sourceLabel})`;
}

function buildCodexNativeResourceContextBlock(
  skillContext: CodexNativeSkillContext | undefined,
): string {
  if (!skillContext) return "";
  const lines: string[] = [];
  const selectedPapers = skillContext.selectedPaperContexts || [];
  if (selectedPapers.length) {
    lines.push(
      "Selected Zotero paper resources available this turn:",
      ...selectedPapers.map(formatPaperResourceLine),
    );
  }
  const fullTextPapers = skillContext.fullTextPaperContexts || [];
  if (fullTextPapers.length) {
    lines.push(
      "User-marked full-text paper resources available this turn:",
      ...fullTextPapers.map(formatPaperResourceLine),
    );
  }
  const collections = skillContext.selectedCollectionContexts || [];
  if (collections.length) {
    lines.push(
      "Selected Zotero collection resources available this turn:",
      ...collections.map((collection) =>
        [
          `- collectionId=${collection.collectionId}`,
          `libraryID=${collection.libraryID}`,
          collection.name ? `name="${collection.name}"` : "",
        ]
          .filter(Boolean)
          .join(", "),
      ),
    );
  }
  const selectedTextLine = buildSelectedTextResourceLine({
    selectedTexts: skillContext.selectedTexts,
    selectedTextSources: skillContext.selectedTextSources,
  });
  if (selectedTextLine) {
    lines.push(
      "Selected text resources available this turn:",
      selectedTextLine,
    );
  }
  if (skillContext.screenshots?.length) {
    lines.push(`- Screenshots attached: ${skillContext.screenshots.length}`);
  }
  if (skillContext.attachments?.length) {
    lines.push(
      "File resources attached this turn:",
      ...skillContext.attachments.map((attachment) =>
        [
          `- name="${attachment.name}"`,
          `category=${attachment.category}`,
          attachment.mimeType ? `mimeType=${attachment.mimeType}` : "",
          attachment.sizeBytes ? `sizeBytes=${attachment.sizeBytes}` : "",
        ]
          .filter(Boolean)
          .join(", "),
      ),
    );
  }
  return lines.length
    ? ["Additional Zotero/user resources for this turn:", ...lines].join("\n")
    : "";
}

function appendBoundedResourceDeltaSection(params: {
  lines: string[];
  title: string;
  records: CodexNativeResourceRecord[];
  remainingLines: number;
}): number {
  if (!params.records.length || params.remainingLines <= 0) {
    return params.remainingLines;
  }
  params.lines.push(params.title);
  const visible = params.records.slice(0, params.remainingLines);
  params.lines.push(...visible.map((record) => record.line));
  const hidden = params.records.length - visible.length;
  if (hidden > 0) params.lines.push(`- ${hidden} more not listed`);
  return params.remainingLines - visible.length;
}

function buildCodexNativeResourceDeltaBlock(params: {
  delta: CodexNativeResourceDelta;
  mcpEnabled: boolean;
}): string {
  const counts = getCodexNativeResourceDeltaCounts(params.delta);
  if (!counts) return "";
  const lines = [
    "Zotero resource update for this continued native thread:",
    `Summary: added=${counts.added}, removed=${counts.removed}, changed=${counts.changed}, stillAvailable=${params.delta.unchanged}`,
    params.mcpEnabled
      ? "Zotero MCP tools remain available; inspect added or changed resources only when the user request needs evidence, exact quotes/pages/figures, comparisons, or Zotero note/library changes."
      : "Zotero MCP tools are disabled for this turn; answer from existing thread context and the user message unless another available tool source is sufficient.",
    "This is a resource inventory update, not a request to eagerly read every resource.",
  ];
  let remainingLines = CODEX_NATIVE_RESOURCE_DELTA_MAX_LINES;
  remainingLines = appendBoundedResourceDeltaSection({
    lines,
    title: "Added resources:",
    records: params.delta.added,
    remainingLines,
  });
  remainingLines = appendBoundedResourceDeltaSection({
    lines,
    title: "Changed resources:",
    records: params.delta.changed,
    remainingLines,
  });
  appendBoundedResourceDeltaSection({
    lines,
    title: "Removed resources:",
    records: params.delta.removed,
    remainingLines,
  });
  return lines.join("\n");
}

export function buildZoteroEnvironmentManifest(params: {
  scope: CodexNativeConversationScope;
  mcpEnabled: boolean;
  mcpReady: boolean;
  mcpWarning?: string;
  skillInstructionBlock?: string;
  priorReadContextBlock?: string;
  resourceContextBlock?: string;
}): string {
  const { scope } = params;
  const notesDirectoryConfig = buildNotesDirectoryConfigSection();
  const lines = [
    "Zotero environment for this turn:",
    formatScopeLine(
      "Chat scope",
      scope.kind === "paper" ? "paper chat" : "library chat",
    ),
    formatScopeLine(
      "Active library",
      scope.libraryName
        ? `${scope.libraryID} (${scope.libraryName})`
        : scope.libraryID,
    ),
  ].filter((line): line is string => Boolean(line));

  if (scope.kind === "paper") {
    lines.push(
      ...[
        formatScopeLine("Active paper item ID", scope.paperItemID),
        formatScopeLine("Active item ID", scope.activeItemId),
        formatScopeLine("Active context item ID", scope.activeContextItemId),
        formatScopeLine("Active paper title", scope.paperTitle),
        formatPaperContextLine(scope.paperContext),
      ].filter((line): line is string => Boolean(line)),
    );
  }

  if (scope.activeNoteId) {
    lines.push(
      ...[
        formatScopeLine("Active note ID", scope.activeNoteId),
        formatScopeLine("Active note title", scope.activeNoteTitle),
        formatScopeLine("Active note kind", scope.activeNoteKind),
        formatScopeLine(
          "Active note parent item ID",
          scope.activeNoteParentItemId,
        ),
      ].filter((line): line is string => Boolean(line)),
    );
  }

  if (!params.mcpEnabled) {
    lines.push(
      "- Zotero MCP tools: disabled for this turn. Do not claim access to Zotero library or PDF tools unless another tool source is available.",
    );
    return [
      lines.join("\n"),
      notesDirectoryConfig,
      params.skillInstructionBlock || "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (!params.mcpReady) {
    lines.push(
      `- Zotero MCP tools: unavailable for this turn.${params.mcpWarning ? ` ${params.mcpWarning}` : ""}`,
    );
    return [
      lines.join("\n"),
      notesDirectoryConfig,
      params.skillInstructionBlock || "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  lines.push(
    "- You are Codex. Zotero resources and MCP tools are available when useful; they are not mandatory for every response.",
    "- Use tools only when they materially improve the answer or are required to inspect/update Zotero. If available context is enough, answer directly.",
    "- For Zotero library, profile, item, PDF, and note facts not shown in context, use Zotero MCP tools instead of local Zotero database/filesystem copies.",
    "- Paper content: use paper_read overview for broad summaries, targeted for specific sections/results/methods, and visual/capture only for figures, layout, pages, or current reader capture.",
    "- Citations: use the provided sourceLabel for paper-grounded claims. When paper_read provides quote anchors like [[quote:Q_x7a2]], use those anchor tokens for direct quotes instead of manually copying quote/citation text. If no quote anchor is provided for a direct quote, put the sourceLabel on the next non-empty line after the blockquote. Do not call tools solely to discover quotes or page numbers; the UI citation binder may resolve page links after rendering.",
    "- External lookup is allowed when the user asks for current web information, or when paper_read shows local paper content is unavailable and Zotero metadata/abstract is insufficient. Label external sources separately.",
    "- Write/update requests should use semantic Zotero MCP write tools. Review cards or direct tool results are the deliverable for tool-backed writes.",
    "- Advanced tools run_command, file_io, and zotero_script are escape hatches for explicit shell/file/script tasks or unsupported formats, not ordinary paper/library reading.",
  );
  if (scope.kind === "paper") {
    lines.push(
      "- Active paper resources are listed above. Use their IDs directly when a paper_read call is useful.",
    );
  } else {
    lines.push(
      "- Library resources are listed above. Use library_search/library_read when the answer needs library data that is not already visible.",
    );
  }
  return [
    lines.join("\n"),
    notesDirectoryConfig,
    params.resourceContextBlock || "",
    params.priorReadContextBlock || "",
    params.skillInstructionBlock || "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function prefixUserContentWithContext(
  content: MessageContent,
  context: string,
): MessageContent {
  const prefix = context.trim();
  if (!prefix) return content;
  const textPrefix = `Zotero context for this turn:\n${prefix}\n\nUser request:\n`;
  if (typeof content === "string") {
    return `${textPrefix}${content}`;
  }
  let didPrefix = false;
  const nextParts = content.map((part) => {
    if (didPrefix || part.type !== "text") return part;
    didPrefix = true;
    return {
      ...part,
      text: `${textPrefix}${part.text || ""}`,
    } satisfies TextContent;
  });
  if (didPrefix) return nextParts;
  return [{ type: "text", text: prefix }, ...content];
}

function buildNativeMessages(params: {
  messages: ChatMessage[];
  includeVisibleHistory: boolean;
  zoteroEnvironmentText?: string;
  prefixLatestUserWithContext?: boolean;
}): ChatMessage[] {
  const systemText = [
    extractSystemText(params.messages),
    params.zoteroEnvironmentText || "",
  ]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n\n");
  const visibleMessages = params.messages.filter(
    (message) => message.role !== "system",
  );
  let latestUserIndex = -1;
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    if (visibleMessages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return [
      {
        role: "user",
        content: systemText || "",
      },
    ];
  }

  const history = params.includeVisibleHistory
    ? visibleMessages.slice(0, latestUserIndex)
    : [];
  const latestUser = visibleMessages[latestUserIndex]!;
  if (!params.prefixLatestUserWithContext) {
    return [
      ...(systemText ? [{ role: "system" as const, content: systemText }] : []),
      ...history,
      latestUser,
    ];
  }
  return [
    ...history,
    {
      ...latestUser,
      content: prefixUserContentWithContext(latestUser.content, systemText),
    },
  ];
}

function buildThinVisibleFallbackContext(params: {
  mcpEnabled: boolean;
}): string {
  if (!params.mcpEnabled) {
    return [
      "This is a continued Codex native Zotero thread.",
      "Zotero MCP tools are disabled for this turn; answer from existing thread context unless another available tool source is sufficient.",
    ].join("\n");
  }
  return [
    "This is a continued Codex native Zotero thread with the same Zotero resources as before.",
    "Zotero MCP tools remain available if needed for new evidence, exact quotes/pages/figures, or Zotero note/library changes.",
    "For Zotero note or library changes, use the appropriate Zotero MCP write tool instead of returning note-ready text as a substitute.",
  ].join("\n");
}

async function loadStoredProviderSessionId(params: {
  conversationKey: number;
  hooks?: CodexNativeStoreHooks;
}): Promise<string> {
  if (params.hooks?.loadProviderSessionId) {
    return normalizeNonEmptyString(await params.hooks.loadProviderSessionId());
  }
  const summary = await getCodexConversationSummary(params.conversationKey);
  return normalizeNonEmptyString(summary?.providerSessionId);
}

async function persistProviderSessionId(params: {
  scope: CodexNativeConversationScope;
  threadId: string;
  model: string;
  effort?: string;
  hooks?: CodexNativeStoreHooks;
}): Promise<void> {
  await params.hooks?.persistProviderSessionId?.(params.threadId);
  if (params.hooks?.persistProviderSessionId) return;
  await upsertCodexConversationSummary({
    conversationKey: params.scope.conversationKey,
    libraryID: params.scope.libraryID,
    kind: params.scope.kind,
    paperItemID: params.scope.paperItemID,
    title: params.scope.title,
    providerSessionId: params.threadId,
    model: params.model,
    effort: params.effort,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function startNativeThread(params: {
  proc: CodexAppServerProcess;
  model: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
}): Promise<{
  threadId: string;
  developerInstructionsAccepted: boolean;
  threadSource?: string;
}> {
  const threadStartParams: Record<string, unknown> = {
    model: params.model,
    ephemeral: false,
    persistExtendedHistory: true,
    ...CODEX_APP_SERVER_NATIVE_APPROVAL_PARAMS,
    serviceName: CODEX_APP_SERVER_SERVICE_NAME,
    ...(params.config ? { config: params.config } : {}),
    ...(params.developerInstructions
      ? { developerInstructions: params.developerInstructions }
      : {}),
  };
  let developerInstructionsAccepted = true;
  let threadResult: unknown;
  try {
    threadResult = await params.proc.sendRequest(
      "thread/start",
      threadStartParams,
    );
  } catch (error) {
    if (
      !params.developerInstructions ||
      !isCodexAppServerThreadStartInstructionsUnsupportedError(error)
    ) {
      throw error;
    }
    const fallbackParams = { ...threadStartParams };
    delete fallbackParams.developerInstructions;
    developerInstructionsAccepted = false;
    ztoolkit.log(
      "Codex app-server native: thread/start developerInstructions unsupported; using visible context fallback",
    );
    threadResult = await params.proc.sendRequest(
      "thread/start",
      fallbackParams,
    );
  }
  const threadId = extractCodexAppServerThreadId(threadResult);
  if (!threadId) {
    throw new Error("Codex app-server did not return a thread ID");
  }
  return {
    threadId,
    developerInstructionsAccepted,
    threadSource: extractCodexAppServerThreadSource(threadResult),
  };
}

async function resumeNativeThread(params: {
  proc: CodexAppServerProcess;
  threadId: string;
  model: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
}): Promise<{
  threadId: string;
  developerInstructionsAccepted: boolean;
  threadSource?: string;
}> {
  const threadResumeParams: Record<string, unknown> = {
    threadId: params.threadId,
    model: params.model,
    persistExtendedHistory: true,
    ...CODEX_APP_SERVER_NATIVE_APPROVAL_PARAMS,
    ...(params.config ? { config: params.config } : {}),
    ...(params.developerInstructions
      ? { developerInstructions: params.developerInstructions }
      : {}),
  };
  let developerInstructionsAccepted = true;
  let threadResult: unknown;
  try {
    threadResult = await params.proc.sendRequest(
      "thread/resume",
      threadResumeParams,
    );
  } catch (error) {
    if (
      !params.developerInstructions ||
      !isCodexAppServerThreadStartInstructionsUnsupportedError(error)
    ) {
      throw error;
    }
    const fallbackParams = { ...threadResumeParams };
    delete fallbackParams.developerInstructions;
    developerInstructionsAccepted = false;
    ztoolkit.log(
      "Codex app-server native: thread/resume developerInstructions unsupported; using visible context fallback",
    );
    threadResult = await params.proc.sendRequest(
      "thread/resume",
      fallbackParams,
    );
  }
  const threadId = extractCodexAppServerThreadId(threadResult);
  if (!threadId) {
    throw new Error("Codex app-server did not return a thread ID");
  }
  return {
    threadId,
    developerInstructionsAccepted,
    threadSource: extractCodexAppServerThreadSource(threadResult),
  };
}

async function resolveNativeThread(params: {
  proc: CodexAppServerProcess;
  scope: CodexNativeConversationScope;
  model: string;
  effort?: string;
  developerInstructions?: string;
  newThreadDeveloperInstructions?: string;
  config?: Record<string, unknown>;
  hooks?: CodexNativeStoreHooks;
  storedThreadId?: string | null;
}): Promise<NativeThreadResolution> {
  const storedThreadId =
    params.storedThreadId !== undefined
      ? normalizeNonEmptyString(params.storedThreadId)
      : await loadStoredProviderSessionId({
          conversationKey: params.scope.conversationKey,
          hooks: params.hooks,
        });
  if (storedThreadId) {
    try {
      const resumedThread = await resumeNativeThread({
        proc: params.proc,
        threadId: storedThreadId,
        model: params.model,
        developerInstructions: params.developerInstructions,
        config: params.config,
      });
      if (resumedThread.threadId !== storedThreadId) {
        await persistProviderSessionId({
          scope: params.scope,
          threadId: resumedThread.threadId,
          model: params.model,
          effort: params.effort,
          hooks: params.hooks,
        });
      }
      return { ...resumedThread, resumed: true };
    } catch (error) {
      ztoolkit.log(
        "Codex app-server native: thread/resume failed; starting a new persistent thread",
        error,
      );
    }
  }

  const thread = await startNativeThread({
    proc: params.proc,
    model: params.model,
    developerInstructions:
      params.newThreadDeveloperInstructions ?? params.developerInstructions,
    config: params.config,
  });
  await persistProviderSessionId({
    scope: params.scope,
    threadId: thread.threadId,
    model: params.model,
    effort: params.effort,
    hooks: params.hooks,
  });
  return { ...thread, resumed: false };
}

async function setNativeThreadName(params: {
  proc: CodexAppServerProcess;
  threadId: string;
  name?: string;
}): Promise<void> {
  const name = normalizeNonEmptyString(params.name).slice(0, 120);
  if (!name) return;
  try {
    await params.proc.sendRequest("thread/name/set", {
      threadId: params.threadId,
      name,
    });
  } catch (error) {
    ztoolkit.log("Codex app-server native: failed to sync thread title", error);
  }
}

function registerNativeApprovalRequestHandlers(params: {
  proc: CodexAppServerProcess;
  onApprovalRequest?: (
    request: CodexNativeApprovalRequest,
  ) => unknown | Promise<unknown>;
}): () => void {
  const disposers = CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS.map((method) =>
    params.proc.onRequest(method, async (rawParams) => {
      if (params.onApprovalRequest) {
        const response = await params.onApprovalRequest({
          method,
          params: rawParams,
        });
        logCodexNativeApprovalDecision({
          method,
          requestParams: rawParams,
          decision: {
            approved: Boolean(
              response &&
              typeof response === "object" &&
              ((response as Record<string, unknown>).approved === true ||
                (response as Record<string, unknown>).decision === "accept" ||
                (response as Record<string, unknown>).action === "accept" ||
                (response as Record<string, unknown>).answers),
            ),
            response,
            reason: "custom_handler",
            target: getApprovalRequestTarget(rawParams),
          },
        });
        return response;
      }
      const decision = resolveCodexNativeApprovalRequest({
        method,
        params: rawParams,
      });
      logCodexNativeApprovalDecision({
        method,
        requestParams: rawParams,
        decision,
      });
      return decision.response;
    }),
  );
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export async function listCodexAppServerModels(
  params: {
    codexPath?: string;
    includeHidden?: boolean;
    processKey?: string;
  } = {},
): Promise<unknown> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  return proc.sendRequest("model/list", {
    includeHidden: params.includeHidden === true,
  });
}

export async function forkCodexAppServerThread(params: {
  threadId: string;
  codexPath?: string;
  processKey?: string;
}): Promise<string> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  const result = await proc.sendRequest("thread/fork", {
    threadId: params.threadId,
  });
  const threadId = extractCodexAppServerThreadId(result);
  if (!threadId) throw new Error("Codex app-server did not return a thread ID");
  return threadId;
}

export async function archiveCodexAppServerThread(params: {
  threadId: string;
  codexPath?: string;
  processKey?: string;
}): Promise<void> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  await proc.sendRequest("thread/archive", { threadId: params.threadId });
}

export async function setCodexAppServerThreadName(params: {
  threadId: string;
  name: string;
  codexPath?: string;
  processKey?: string;
}): Promise<void> {
  const name = params.name.trim();
  if (!name) return;
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  await proc.sendRequest("thread/name/set", {
    threadId: params.threadId,
    name: name.slice(0, 120),
  });
}

export async function compactCodexAppServerThread(params: {
  threadId: string;
  codexPath?: string;
  processKey?: string;
}): Promise<void> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  await proc.sendRequest("thread/compact/start", {
    threadId: params.threadId,
  });
}

async function verifyCodexAppServerThreadHistory(params: {
  proc: CodexAppServerProcess;
  threadId: string;
}): Promise<boolean> {
  try {
    await params.proc.sendRequest("thread/read", {
      threadId: params.threadId,
      includeTurns: true,
    });
    return true;
  } catch (error) {
    ztoolkit.log(
      "Codex app-server native: thread/read verification failed",
      error,
    );
    return false;
  }
}

async function verifyCodexAppServerThreadHistoryIfDue(params: {
  proc: CodexAppServerProcess;
  threadId: string;
}): Promise<boolean | undefined> {
  const threadId = normalizeNonEmptyString(params.threadId);
  if (!threadId) return undefined;
  const now = Date.now();
  const lastVerifiedAt = nativeHistoryVerificationState.get(threadId);
  if (
    lastVerifiedAt !== undefined &&
    now - lastVerifiedAt < CODEX_NATIVE_HISTORY_VERIFICATION_TTL_MS
  ) {
    return undefined;
  }
  const verified = await verifyCodexAppServerThreadHistory({
    proc: params.proc,
    threadId,
  });
  nativeHistoryVerificationState.set(threadId, now);
  return verified;
}

function buildNativeDiagnostics(params: {
  thread: NativeThreadResolution;
  profileSignature: string;
  scope: CodexNativeConversationScope;
  mcpServerName?: string;
  mcpReady: boolean;
  mcpStatus?: CodexNativeMcpSetupStatus;
  skillIds?: string[];
  lifecycleState?: CodexNativeLifecycleState;
  contextInjection?: CodexNativeContextInjection;
  resourceDelta?: CodexNativeResourceDeltaCounts;
  historyVerified?: boolean;
}): CodexNativeDiagnostics {
  return {
    threadId: params.thread.threadId,
    threadSource: params.thread.threadSource,
    profileSignature: params.profileSignature,
    libraryID: params.scope.libraryID,
    libraryName: params.scope.libraryName,
    mcpServerName: params.mcpServerName,
    mcpReady: params.mcpReady,
    mcpToolNames: params.mcpStatus?.toolNames || [],
    skillIds: params.skillIds || [],
    lifecycleState: params.lifecycleState,
    contextInjection: params.contextInjection,
    resourceDelta: params.resourceDelta,
    historyVerified: params.historyVerified,
  };
}

export async function runCodexAppServerNativeTurn(params: {
  scope: CodexNativeConversationScope;
  model: string;
  messages: ChatMessage[];
  reasoning?: ReasoningConfig;
  signal?: AbortSignal;
  codexPath?: string;
  processKey?: string;
  hooks?: CodexNativeStoreHooks;
  onDelta?: (delta: string) => void;
  onAgentMessageDelta?: (event: CodexAppServerAgentMessageDeltaEvent) => void;
  onReasoning?: (event: ReasoningEvent) => void;
  onUsage?: (usage: UsageStats) => void;
  onItemStarted?: (event: CodexAppServerItemEvent) => void;
  onItemCompleted?: (event: CodexAppServerItemEvent) => void;
  onMcpToolActivity?: (event: ZoteroMcpToolActivityEvent) => void;
  onMcpConfirmationRequest?: (
    request: ZoteroMcpConfirmationRequest,
  ) => AgentConfirmationResolution | Promise<AgentConfirmationResolution>;
  onTurnCompleted?: (event: { turnId: string; status?: string }) => void;
  onMcpSetupWarning?: (message: string) => void;
  onDiagnostics?: (diagnostics: CodexNativeDiagnostics) => void;
  onSkillActivated?: (skillId: string) => void;
  skillContext?: CodexNativeSkillContext;
  onApprovalRequest?: (
    request: CodexNativeApprovalRequest,
  ) => unknown | Promise<unknown>;
}): Promise<CodexNativeTurnResult> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const processKey = params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY;
  const proc = await getOrCreateCodexAppServerProcess(processKey, {
    codexPath,
  });
  return proc.runTurnExclusive(async () => {
    const unregisterApprovalHandlers = registerNativeApprovalRequestHandlers({
      proc,
      onApprovalRequest: params.onApprovalRequest,
    });
    const mcpEnabled = isCodexZoteroMcpToolsEnabled();
    const profileSignature =
      normalizeNonEmptyString(params.scope.profileSignature) ||
      getCodexProfileSignature();
    const latestUserText = extractLatestUserText(params.messages);
    const storedThreadId = await loadStoredProviderSessionId({
      conversationKey: params.scope.conversationKey,
      hooks: params.hooks,
    });
    const scopeWithProfile = { ...params.scope, profileSignature };
    const resourceSnapshot = buildCodexNativeResourceSnapshot({
      scope: scopeWithProfile,
      profileSignature,
      skillContext: params.skillContext,
    });
    const resourceSignature =
      buildCodexNativeResourceSignatureFromSnapshot(resourceSnapshot);
    const lifecycleEntry = getLifecycleEntry({
      profileSignature,
      conversationKey: params.scope.conversationKey,
      threadId: storedThreadId,
    });
    let lifecycleState = resolveCodexNativeLifecycleState({
      storedThreadId,
      lifecycleEntry,
      resourceSignature,
      resourceSnapshot,
      forcedSkillIds: params.skillContext?.forcedSkillIds,
    });
    const scopedMcp = mcpEnabled
      ? registerScopedZoteroMcpScope({
          ...scopeWithProfile,
          userText: latestUserText,
        })
      : null;
    const mcpThreadConfig = scopedMcp
      ? buildCodexZoteroMcpThreadConfig({
          profileSignature,
          scopeToken: scopedMcp.token,
          required: true,
        })
      : null;
    const threadConfig = mcpThreadConfig?.config || {
      features: {
        shell_tool: false,
      },
    };
    let mcpReady = !mcpEnabled;
    let mcpWarning = "";
    let mcpStatus: CodexNativeMcpSetupStatus | undefined;
    const clearMcpScope = mcpEnabled
      ? setActiveZoteroMcpScope({
          ...params.scope,
          profileSignature,
          userText: latestUserText,
        })
      : () => undefined;
    const clearMcpConfirmationHandler =
      mcpEnabled && params.onMcpConfirmationRequest
        ? addZoteroMcpConfirmationHandler(
            {
              ...params.scope,
              profileSignature,
              userText: latestUserText,
            },
            params.onMcpConfirmationRequest,
          )
        : () => undefined;
    let unregisterGuardianReviews: () => void = () => undefined;
    try {
      const reasoningParams = resolveCodexAppServerReasoningParams(
        params.reasoning,
        params.model,
      );
      let setupStoredThreadId = storedThreadId;
      const executePreparedThread = async (args: {
        thread: NativeThreadResolution;
        input: unknown;
        skillIds: string[];
        lifecycleState: CodexNativeLifecycleState;
        contextInjection: CodexNativeContextInjection;
        resourceDelta?: CodexNativeResourceDeltaCounts;
      }): Promise<CodexNativeTurnResult> => {
        unregisterGuardianReviews = registerNativeGuardianReviewHandlers({
          proc,
          threadId: args.thread.threadId,
        });
        params.onDiagnostics?.(
          buildNativeDiagnostics({
            thread: args.thread,
            profileSignature,
            scope: params.scope,
            mcpServerName: mcpThreadConfig?.serverName,
            mcpReady,
            mcpStatus,
            skillIds: args.skillIds,
            lifecycleState: args.lifecycleState,
            contextInjection: args.contextInjection,
            resourceDelta: args.resourceDelta,
          }),
        );
        const unregisterMcpToolActivity = addZoteroMcpToolActivityObserver(
          (event) => {
            const sameConversation =
              !event.conversationKey ||
              !params.scope.conversationKey ||
              event.conversationKey === params.scope.conversationKey;
            const sameProfile =
              !event.profileSignature ||
              !profileSignature ||
              event.profileSignature === profileSignature;
            if (!sameConversation || !sameProfile) return;
            recordCodexNativeReadActivity({
              threadId: args.thread.threadId,
              scope: scopeWithProfile,
              event,
            });
            params.onMcpToolActivity?.(event);
          },
        );
        let text = "";
        try {
          const turnResult = await proc.sendRequest("turn/start", {
            threadId: args.thread.threadId,
            input: args.input,
            model: params.model,
            ...CODEX_APP_SERVER_NATIVE_APPROVAL_PARAMS,
            ...reasoningParams,
          });
          const turnId = extractCodexAppServerTurnId(turnResult);
          if (!turnId) {
            throw new Error("Codex app-server did not return a turn ID");
          }
          text = await waitForCodexAppServerTurnCompletion({
            proc,
            threadId: args.thread.threadId,
            turnId,
            onTextDelta: params.onDelta,
            onAgentMessageDelta: params.onAgentMessageDelta,
            onReasoning: params.onReasoning,
            onUsage: params.onUsage,
            onItemStarted: params.onItemStarted,
            onItemCompleted: params.onItemCompleted,
            onTurnCompleted: params.onTurnCompleted,
            signal: params.signal,
            interruptOnAbort: true,
            cacheKey: processKey,
            processOptions: { codexPath },
          });
        } finally {
          unregisterMcpToolActivity();
        }
        const historyVerified = await verifyCodexAppServerThreadHistoryIfDue({
          proc,
          threadId: args.thread.threadId,
        });
        const diagnostics = buildNativeDiagnostics({
          thread: args.thread,
          profileSignature,
          scope: params.scope,
          mcpServerName: mcpThreadConfig?.serverName,
          mcpReady,
          mcpStatus,
          skillIds: args.skillIds,
          lifecycleState: args.lifecycleState,
          contextInjection: args.contextInjection,
          resourceDelta: args.resourceDelta,
          historyVerified,
        });
        params.onDiagnostics?.(diagnostics);
        return {
          text,
          threadId: args.thread.threadId,
          resumed: args.thread.resumed,
          diagnostics,
        };
      };

      if (lifecycleState === "thin-followup" && storedThreadId) {
        mcpStatus = lifecycleEntry?.mcpStatus;
        mcpReady = !mcpEnabled || Boolean(lifecycleEntry);
        const contextInjection: CodexNativeContextInjection =
          lifecycleEntry?.developerInstructionsAccepted === false
            ? "thin-visible-fallback"
            : "thin";
        try {
          const resumedThread = await resumeNativeThread({
            proc,
            threadId: storedThreadId,
            model: params.model,
            config: threadConfig,
          });
          if (resumedThread.threadId !== storedThreadId) {
            setupStoredThreadId = resumedThread.threadId;
            await persistProviderSessionId({
              scope: scopeWithProfile,
              threadId: resumedThread.threadId,
              model: params.model,
              effort: reasoningParams.effort,
              hooks: params.hooks,
            });
            throw new Error("Codex app-server returned a different thread ID");
          }
          const thread: NativeThreadResolution = {
            ...resumedThread,
            resumed: true,
            developerInstructionsAccepted:
              lifecycleEntry?.developerInstructionsAccepted ??
              resumedThread.developerInstructionsAccepted,
          };
          const thinNativeMessages = buildNativeMessages({
            messages: params.messages,
            includeVisibleHistory: false,
            zoteroEnvironmentText:
              contextInjection === "thin-visible-fallback"
                ? buildThinVisibleFallbackContext({ mcpEnabled })
                : "",
            prefixLatestUserWithContext:
              contextInjection === "thin-visible-fallback",
          });
          const preparedTurn =
            await prepareCodexAppServerChatTurn(thinNativeMessages);
          const input = await resolveCodexAppServerTurnInputWithFallback({
            proc,
            threadId: thread.threadId,
            historyItemsToInject: [],
            turnInput: preparedTurn.turnInput,
            legacyInputFactory: () =>
              buildLegacyCodexAppServerChatInput(thinNativeMessages),
            logContext: "native",
          });
          return await executePreparedThread({
            thread,
            input,
            skillIds: [],
            lifecycleState,
            contextInjection,
          });
        } catch (error) {
          ztoolkit.log(
            "Codex app-server native: thin resume failed; refreshing native setup",
            error,
          );
          lifecycleState = "setup-required";
        }
      }

      if (
        lifecycleState === "resources-delta" &&
        storedThreadId &&
        lifecycleEntry
      ) {
        mcpStatus = lifecycleEntry.mcpStatus;
        mcpReady = !mcpEnabled || Boolean(lifecycleEntry);
        const resourceDelta = diffCodexNativeResourceSnapshots({
          previous: lifecycleEntry.resourceSnapshot,
          current: resourceSnapshot,
        });
        const resourceDeltaCounts =
          getCodexNativeResourceDeltaCounts(resourceDelta);
        const deltaContextBlock = buildCodexNativeResourceDeltaBlock({
          delta: resourceDelta,
          mcpEnabled,
        });
        try {
          const deltaDeveloperInstructions =
            lifecycleEntry.developerInstructionsAccepted === false
              ? undefined
              : (
                  await prepareCodexAppServerChatTurn(
                    buildNativeMessages({
                      messages: params.messages,
                      includeVisibleHistory: false,
                      zoteroEnvironmentText: deltaContextBlock,
                    }),
                  )
                ).developerInstructions;
          const resumedThread = await resumeNativeThread({
            proc,
            threadId: storedThreadId,
            model: params.model,
            developerInstructions: deltaDeveloperInstructions,
            config: threadConfig,
          });
          if (resumedThread.threadId !== storedThreadId) {
            setupStoredThreadId = resumedThread.threadId;
            await persistProviderSessionId({
              scope: scopeWithProfile,
              threadId: resumedThread.threadId,
              model: params.model,
              effort: reasoningParams.effort,
              hooks: params.hooks,
            });
            throw new Error("Codex app-server returned a different thread ID");
          }
          const developerInstructionsAccepted =
            lifecycleEntry.developerInstructionsAccepted === false
              ? false
              : resumedThread.developerInstructionsAccepted;
          const contextInjection: CodexNativeContextInjection =
            developerInstructionsAccepted ? "delta" : "delta-visible-fallback";
          const thread: NativeThreadResolution = {
            ...resumedThread,
            resumed: true,
            developerInstructionsAccepted,
          };
          recordCodexNativeLifecycleSetup({
            profileSignature,
            conversationKey: params.scope.conversationKey,
            threadId: thread.threadId,
            resourceSignature,
            resourceSnapshot,
            developerInstructionsAccepted: thread.developerInstructionsAccepted,
            mcpStatus,
          });
          const deltaTurnMessages = buildNativeMessages({
            messages: params.messages,
            includeVisibleHistory: false,
            zoteroEnvironmentText:
              contextInjection === "delta-visible-fallback"
                ? deltaContextBlock
                : "",
            prefixLatestUserWithContext:
              contextInjection === "delta-visible-fallback",
          });
          const preparedTurn =
            await prepareCodexAppServerChatTurn(deltaTurnMessages);
          const input = await resolveCodexAppServerTurnInputWithFallback({
            proc,
            threadId: thread.threadId,
            historyItemsToInject: [],
            turnInput: preparedTurn.turnInput,
            legacyInputFactory: () =>
              buildLegacyCodexAppServerChatInput(deltaTurnMessages),
            logContext: "native",
          });
          return await executePreparedThread({
            thread,
            input,
            skillIds: [],
            lifecycleState,
            contextInjection,
            resourceDelta: resourceDeltaCounts,
          });
        } catch (error) {
          ztoolkit.log(
            "Codex app-server native: resource delta resume failed; refreshing native setup",
            error,
          );
          lifecycleState = "setup-required";
        }
      }

      const priorReadContextBlock = buildCodexNativePriorReadContextBlock({
        profileSignature,
        conversationKey: params.scope.conversationKey,
        threadId: setupStoredThreadId,
      });
      const resolvedSkills = await resolveCodexNativeSkills({
        scope: scopeWithProfile,
        userText: latestUserText,
        model: params.model,
        apiBase: params.codexPath,
        signal: params.signal,
        skillContext: params.skillContext,
      });
      for (const skillId of resolvedSkills.matchedSkillIds) {
        params.onSkillActivated?.(skillId);
      }
      const resourceContextBlock = buildCodexNativeResourceContextBlock(
        params.skillContext,
      );
      const optimisticMcpReady = mcpEnabled;
      const plainNativeMessages = buildNativeMessages({
        messages: params.messages,
        includeVisibleHistory: true,
        zoteroEnvironmentText: buildZoteroEnvironmentManifest({
          scope: scopeWithProfile,
          mcpEnabled,
          mcpReady: optimisticMcpReady,
          mcpWarning,
          skillInstructionBlock: resolvedSkills.instructionBlock,
          priorReadContextBlock,
          resourceContextBlock,
        }),
      });
      const plainPreparedTurn =
        await prepareCodexAppServerChatTurn(plainNativeMessages);
      const newThreadNativeMessages = priorReadContextBlock
        ? buildNativeMessages({
            messages: params.messages,
            includeVisibleHistory: true,
            zoteroEnvironmentText: buildZoteroEnvironmentManifest({
              scope: scopeWithProfile,
              mcpEnabled,
              mcpReady: optimisticMcpReady,
              mcpWarning,
              skillInstructionBlock: resolvedSkills.instructionBlock,
              resourceContextBlock,
            }),
          })
        : plainNativeMessages;
      const newThreadPreparedTurn =
        newThreadNativeMessages === plainNativeMessages
          ? plainPreparedTurn
          : await prepareCodexAppServerChatTurn(newThreadNativeMessages);
      if (mcpEnabled && mcpThreadConfig && scopedMcp) {
        try {
          mcpStatus = await preflightCodexZoteroMcpServer({
            serverName: mcpThreadConfig.serverName,
            scopeToken: scopedMcp.token,
            required: true,
          });
          assertRequiredCodexZoteroMcpToolsReady(mcpStatus);
          mcpReady = true;
        } catch (error) {
          mcpReady = false;
          mcpWarning = `Zotero MCP setup failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          params.onMcpSetupWarning?.(mcpWarning);
          ztoolkit.log(
            "Codex app-server native: Zotero MCP preflight failed",
            error,
          );
          throw new Error(mcpWarning);
        }
      }
      const thread = await resolveNativeThread({
        proc,
        scope: scopeWithProfile,
        model: params.model,
        effort: reasoningParams.effort,
        developerInstructions: plainPreparedTurn.developerInstructions,
        newThreadDeveloperInstructions:
          newThreadPreparedTurn.developerInstructions,
        config: threadConfig,
        hooks: params.hooks,
        storedThreadId: setupStoredThreadId || null,
      });
      const effectiveLifecycleState: CodexNativeLifecycleState = thread.resumed
        ? lifecycleState
        : "setup-required";
      if (!thread.resumed) {
        await setNativeThreadName({
          proc,
          threadId: thread.threadId,
          name: params.scope.title,
        });
      }
      recordCodexNativeLifecycleSetup({
        profileSignature,
        conversationKey: params.scope.conversationKey,
        threadId: thread.threadId,
        resourceSignature,
        resourceSnapshot,
        developerInstructionsAccepted: thread.developerInstructionsAccepted,
        mcpStatus,
      });
      const nativeMessagesWithPriorContext = buildNativeMessages({
        messages: params.messages,
        includeVisibleHistory: true,
        zoteroEnvironmentText: buildZoteroEnvironmentManifest({
          scope: scopeWithProfile,
          mcpEnabled,
          mcpReady,
          mcpWarning,
          skillInstructionBlock: resolvedSkills.instructionBlock,
          priorReadContextBlock,
          resourceContextBlock,
        }),
        prefixLatestUserWithContext: !thread.developerInstructionsAccepted,
      });
      const nativeMessages =
        !thread.resumed && priorReadContextBlock
          ? buildNativeMessages({
              messages: params.messages,
              includeVisibleHistory: true,
              zoteroEnvironmentText: buildZoteroEnvironmentManifest({
                scope: scopeWithProfile,
                mcpEnabled,
                mcpReady,
                mcpWarning,
                skillInstructionBlock: resolvedSkills.instructionBlock,
                resourceContextBlock,
              }),
              prefixLatestUserWithContext:
                !thread.developerInstructionsAccepted,
            })
          : nativeMessagesWithPriorContext;
      const preparedTurn = thread.developerInstructionsAccepted
        ? thread.resumed || !priorReadContextBlock
          ? plainPreparedTurn
          : newThreadPreparedTurn
        : await prepareCodexAppServerChatTurn(nativeMessages);
      const input = await resolveCodexAppServerTurnInputWithFallback({
        proc,
        threadId: thread.threadId,
        historyItemsToInject: thread.resumed
          ? []
          : preparedTurn.historyItemsToInject,
        turnInput: preparedTurn.turnInput,
        legacyInputFactory: () =>
          buildLegacyCodexAppServerChatInput(nativeMessages),
        logContext: "native",
      });
      return await executePreparedThread({
        thread,
        input,
        skillIds: resolvedSkills.matchedSkillIds,
        lifecycleState: effectiveLifecycleState,
        contextInjection: "full",
      });
    } finally {
      unregisterGuardianReviews();
      scopedMcp?.clear();
      clearMcpConfirmationHandler();
      clearMcpScope();
      unregisterApprovalHandlers();
    }
  });
}
