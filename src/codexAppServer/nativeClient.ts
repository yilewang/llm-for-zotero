import type {
  ChatMessage,
  MessageContent,
  ReasoningConfig,
  ReasoningEvent,
  TextContent,
  UsageStats,
} from "../shared/llm";
import type {
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentPendingField,
} from "../agent/types";
import type { CodexConversationKind, PaperContextRef } from "../shared/types";
import { BALANCED_EVIDENCE_GUIDANCE } from "../shared/quoteGuidance";
import {
  addZoteroMcpToolActivityObserver,
  addZoteroMcpConfirmationHandler,
  ZOTERO_MCP_SERVER_NAME,
  ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
  ZOTERO_MCP_WRITE_TOOL_NAMES,
  registerScopedZoteroMcpScope,
  setActiveZoteroMcpScope,
  type ZoteroMcpActiveScope,
  type ZoteroMcpConfirmationRequest,
  type ZoteroMcpToolActivityEvent,
} from "../agent/mcp/server";
import {
  buildLegacyCodexAppServerChatInput,
  prepareCodexAppServerChatTurn,
  type CodexAppServerUserInput,
} from "../utils/codexAppServerInput";
import {
  extractCodexAppServerThreadId,
  extractCodexAppServerTurnId,
  getOrCreateCodexAppServerProcess,
  isCodexAppServerThreadStartInstructionsUnsupportedError,
  resolveCodexAppServerBinaryPath,
  resolveCodexAppServerReasoningParams,
  resolveCodexAppServerTurnInputWithFallback,
  waitForCodexAppServerThreadCompacted,
  waitForCodexAppServerTurnCompletion,
  type CodexAppServerAgentMessageDeltaEvent,
  type CodexAppServerItemEvent,
  type CodexAppServerProcess,
} from "../utils/codexAppServerProcess";
import {
  getCodexConversationSummary,
  upsertCodexConversationSummary,
} from "./store";
import {
  getCodexAppServerApprovalsReviewerPref,
  getCodexNativeSkillModePref,
  isCodexZoteroMcpToolsEnabled,
  type CodexAppServerApprovalsReviewer,
} from "./prefs";
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
import { buildVisibleTurnContextBlock } from "../agent/context/turnContextEnvelope";
import { getUserSkillsRuntimeRootDir } from "../agent/skills/userSkills";

export const CODEX_APP_SERVER_NATIVE_PROCESS_KEY = "codex_app_server_native";
const CODEX_APP_SERVER_SERVICE_NAME = "llm_for_zotero";
export const NO_CODEX_APP_SERVER_THREAD_TO_COMPACT_MESSAGE =
  "No Codex context to compact yet. Send a message first.";

function resolveCodexNativeRuntimeCwd(): string | undefined {
  try {
    return getUserSkillsRuntimeRootDir();
  } catch {
    return undefined;
  }
}

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

type NativeContextPlacement =
  | "developer-instructions"
  | "latest-user-prefix"
  | "both-for-legacy-fallback";

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
  historyVerified?: boolean;
};

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
const DISALLOWED_ZOTERO_MCP_AUTO_APPROVAL_TOOLS = new Set([
  "run_command",
  "file_io",
  "zotero_script",
  ...DISALLOWED_ZOTERO_MCP_APPROVAL_MARKERS,
]);
const LEGACY_ZOTERO_MCP_AUTO_APPROVAL_TOOL_NAMES = [
  "query_library",
  "read_paper",
  "search_paper",
  "view_pdf_pages",
  "search_literature_online",
  "edit_current_note",
  "import_identifiers",
  "update_metadata",
] as const;
const TRUSTED_ZOTERO_MCP_AUTO_APPROVAL_TOOL_NAMES = new Set<string>(
  [
    ...ZOTERO_MCP_SAFE_READ_TOOL_NAMES,
    ...ZOTERO_MCP_WRITE_TOOL_NAMES,
    ...LEGACY_ZOTERO_MCP_AUTO_APPROVAL_TOOL_NAMES,
  ].filter((name) => !DISALLOWED_ZOTERO_MCP_AUTO_APPROVAL_TOOLS.has(name)),
);
const TRUSTED_ZOTERO_MCP_APPROVAL_METHODS = new Set([
  "item/tool/requestUserInput",
  "tool/requestUserInput",
  "approval/request",
  "approval/requested",
  "turn/approval/request",
]);
const CODEX_APP_SERVER_BUILT_IN_APPROVAL_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
];
const CODEX_APP_SERVER_NATIVE_APPROVAL_POLICY = "on-request";

function buildCodexAppServerNativeApprovalParams(): {
  approvalPolicy: typeof CODEX_APP_SERVER_NATIVE_APPROVAL_POLICY;
  approvalsReviewer: CodexAppServerApprovalsReviewer;
} {
  return {
    approvalPolicy: CODEX_APP_SERVER_NATIVE_APPROVAL_POLICY,
    approvalsReviewer: getCodexAppServerApprovalsReviewerPref(),
  };
}

const CODEX_NATIVE_HISTORY_VERIFICATION_TTL_MS = 5 * 60 * 1000;
const CODEX_APP_SERVER_GUARDIAN_REVIEW_COMPLETED_METHOD =
  "item/autoApprovalReview/completed";
const nativeHistoryVerificationState = new Map<string, number>();

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function createNativeClientAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export function clearCodexNativeHistoryVerificationState(): void {
  nativeHistoryVerificationState.clear();
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || "");
  }
}

function firstNonEmptyString(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string {
  for (const key of keys) {
    const value = normalizeNonEmptyString(record[key]);
    if (value) return value;
  }
  return "";
}

function collectNestedRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const visit = (entry: unknown): void => {
    const record = normalizeRecord(entry);
    if (!Object.keys(record).length) return;
    records.push(record);
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") visit(nested);
    }
  };
  visit(value);
  return records;
}

function findNestedString(value: unknown, keys: ReadonlyArray<string>): string {
  for (const record of collectNestedRecords(value)) {
    const candidate = firstNonEmptyString(record, keys);
    if (candidate) return candidate;
  }
  return "";
}

function findCommandPreview(params: unknown): string {
  const command = findNestedString(params, [
    "command",
    "cmd",
    "argv",
    "fullCommand",
    "full_command",
  ]);
  if (command) return command;
  for (const record of collectNestedRecords(params)) {
    const argv = record.argv || record.args;
    if (Array.isArray(argv)) {
      const pieces = argv
        .map((entry) => normalizeNonEmptyString(entry))
        .filter(Boolean);
      if (pieces.length) return pieces.join(" ");
    }
  }
  return "";
}

function findPathSummary(params: unknown): string {
  return findNestedString(params, [
    "path",
    "filePath",
    "file_path",
    "targetPath",
    "target_path",
    "cwd",
  ]);
}

function appendTextField(
  fields: AgentPendingField[],
  id: string,
  label: string,
  value: string,
): void {
  if (!value) return;
  fields.push({ type: "text", id, label, value });
}

function buildCodexNativeApprovalSummary(
  request: CodexNativeApprovalRequest,
): string {
  if (request.method === "item/commandExecution/requestApproval") {
    const command = findCommandPreview(request.params);
    return command ? `Command: ${command}` : "Command execution approval";
  }
  if (request.method === "item/fileChange/requestApproval") {
    const path = findPathSummary(request.params);
    return path ? `File change: ${path}` : "File-change approval";
  }
  if (request.method === "item/permissions/requestApproval") {
    const permissions = normalizeRecord(
      normalizeRecord(request.params).permissions,
    );
    const fileSystem = normalizeRecord(permissions.fileSystem);
    const network = normalizeRecord(permissions.network);
    const pieces = [
      fileSystem.read ? "filesystem read" : "",
      fileSystem.write ? "filesystem write" : "",
      network.enabled !== undefined ? "network" : "",
    ].filter(Boolean);
    return pieces.length
      ? `Permissions: ${pieces.join(", ")}`
      : "Permission request";
  }
  if (request.method === "execCommandApproval") {
    const command = findCommandPreview(request.params);
    return command ? `Legacy command: ${command}` : "Legacy command approval";
  }
  if (request.method === "applyPatchApproval") {
    return "Legacy patch approval";
  }
  return "Codex native approval";
}

export function isCodexNativeBuiltInApprovalRequest(
  request: CodexNativeApprovalRequest,
): boolean {
  return (
    CODEX_APP_SERVER_BUILT_IN_APPROVAL_REQUEST_METHODS as readonly string[]
  ).includes(request.method);
}

export function buildCodexNativeApprovalPendingAction(
  request: CodexNativeApprovalRequest,
): AgentPendingAction {
  const params = normalizeRecord(request.params);
  const fields: AgentPendingField[] = [
    {
      type: "text",
      id: "method",
      label: "Method",
      value: request.method,
    },
  ];
  const cwd = findNestedString(request.params, ["cwd", "workingDirectory"]);
  const command = findCommandPreview(request.params);
  const path = findPathSummary(request.params);
  const reason = firstNonEmptyString(params, [
    "reason",
    "justification",
    "description",
  ]);
  appendTextField(fields, "cwd", "Working directory", cwd);
  appendTextField(fields, "path", "Path", path && path !== cwd ? path : "");
  appendTextField(fields, "reason", "Reason", reason);
  if (command) {
    fields.push({
      type: "code_preview",
      id: "command",
      label: "Command",
      value: command,
      language: "bash",
    });
  }
  if (request.method === "item/permissions/requestApproval") {
    fields.push({
      type: "textarea",
      id: "permissions",
      label: "Requested permissions",
      value: prettyJson(params.permissions || {}),
      editorMode: "json",
      spellcheck: false,
    });
  }
  fields.push({
    type: "textarea",
    id: "payload",
    label: "Request payload",
    value: prettyJson(request.params),
    editorMode: "json",
    spellcheck: false,
  });

  return {
    toolName: "codex_native_approval",
    title:
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "execCommandApproval"
        ? "Review Codex command approval"
        : request.method === "item/fileChange/requestApproval" ||
            request.method === "applyPatchApproval"
          ? "Review Codex file-change approval"
          : request.method === "item/permissions/requestApproval"
            ? "Review Codex permission request"
            : "Review Codex native approval",
    mode: "approval",
    confirmLabel: "Approve once",
    cancelLabel: "Deny",
    description: buildCodexNativeApprovalSummary(request),
    fields,
    defaultActionId: "approve",
    cancelActionId: "deny",
  };
}

function buildApprovedPermissionsResponse(params: unknown): {
  permissions: Record<string, unknown>;
  scope: "turn";
} {
  const requestParams = normalizeRecord(params);
  const requestedPermissions = normalizeRecord(requestParams.permissions);
  const permissions: Record<string, unknown> = {};
  if (
    requestedPermissions.fileSystem &&
    typeof requestedPermissions.fileSystem === "object" &&
    !Array.isArray(requestedPermissions.fileSystem)
  ) {
    permissions.fileSystem = requestedPermissions.fileSystem;
  }
  if (
    requestedPermissions.network &&
    typeof requestedPermissions.network === "object" &&
    !Array.isArray(requestedPermissions.network)
  ) {
    permissions.network = requestedPermissions.network;
  }
  return { permissions, scope: "turn" };
}

export function buildCodexNativeApprovalResponseFromResolution(
  request: CodexNativeApprovalRequest,
  resolution: AgentConfirmationResolution,
): unknown {
  if (!resolution.approved) {
    return resolveCodexNativeApprovalRequest(request).response;
  }
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "accept" };
    case "item/permissions/requestApproval":
      return buildApprovedPermissionsResponse(request.params);
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "approved" };
    default:
      return resolveCodexNativeApprovalRequest(request).response;
  }
}

type CodexNativeSkillInput = Extract<
  CodexAppServerUserInput,
  { type: "skill" }
>;

type CodexNativeSkillInputResolution = {
  skillInputs: CodexNativeSkillInput[];
  fallbackSkillIds: string[];
};

function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean);
}

function nativeSkillMetadataMatchesId(
  metadata: CodexNativeSkillInput,
  skillId: string,
): boolean {
  if (metadata.name === skillId) return true;
  const segments = pathSegments(metadata.path);
  const filename = segments[segments.length - 1] || "";
  const parent = segments[segments.length - 2] || "";
  if (/^SKILL\.md$/i.test(filename) && parent === skillId) return true;
  return segments.includes(skillId);
}

function collectNativeSkillMetadata(
  value: unknown,
  entries: CodexNativeSkillInput[] = [],
  seen = new Set<string>(),
): CodexNativeSkillInput[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectNativeSkillMetadata(entry, entries, seen);
    return entries;
  }
  const record = normalizeRecord(value);
  if (!Object.keys(record).length) return entries;

  const name = normalizeNonEmptyString(record.name);
  const path = normalizeNonEmptyString(record.path);
  if (name && path && record.enabled !== false) {
    const key = `${name}\n${path}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({ type: "skill", name, path });
    }
  }

  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") {
      collectNativeSkillMetadata(nested, entries, seen);
    }
  }
  return entries;
}

async function resolveCodexNativeSkillInputItems(params: {
  proc: CodexAppServerProcess;
  cwd?: string;
  skillIds: ReadonlyArray<string>;
}): Promise<CodexNativeSkillInputResolution> {
  const skillIds = Array.from(new Set(params.skillIds.filter(Boolean)));
  if (!skillIds.length) return { skillInputs: [], fallbackSkillIds: [] };

  try {
    const result = await params.proc.sendRequest("skills/list", {
      cwds: params.cwd ? [params.cwd] : [],
    });
    const metadata = collectNativeSkillMetadata(result);
    const used = new Set<number>();
    const skillInputs: CodexNativeSkillInput[] = [];
    const fallbackSkillIds: string[] = [];

    for (const skillId of skillIds) {
      const index = metadata.findIndex(
        (entry, candidateIndex) =>
          !used.has(candidateIndex) &&
          nativeSkillMetadataMatchesId(entry, skillId),
      );
      if (index < 0) {
        fallbackSkillIds.push(skillId);
        continue;
      }
      used.add(index);
      skillInputs.push(metadata[index]);
    }

    return { skillInputs, fallbackSkillIds };
  } catch (error) {
    ztoolkit.log(
      "Codex app-server native: failed to resolve structured skill inputs",
      error,
    );
    return { skillInputs: [], fallbackSkillIds: skillIds };
  }
}

function stripLeadingCodexNativeSkillMentions(
  text: string,
  skillIds: ReadonlyArray<string>,
): string {
  const activeIds = new Set(skillIds);
  if (!activeIds.size) return text;
  let next = text;
  for (;;) {
    const match = next.match(/^\s*\$([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+|$)/);
    if (!match || !activeIds.has(match[1])) return next;
    next = next.slice(match[0].length).trimStart();
  }
}

function stripLatestUserNativeSkillMentions(
  messages: ChatMessage[],
  skillIds: ReadonlyArray<string>,
): ChatMessage[] {
  if (!skillIds.length) return messages;
  let stripped = false;
  const nextMessages = messages.slice();
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") {
      const nextContent = stripLeadingCodexNativeSkillMentions(
        message.content,
        skillIds,
      );
      if (nextContent !== message.content) {
        nextMessages[index] = { ...message, content: nextContent };
      }
      return nextMessages;
    }
    const parts = message.content.slice();
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      if (part.type !== "text") continue;
      const nextText = stripLeadingCodexNativeSkillMentions(
        part.text || "",
        skillIds,
      );
      if (nextText !== part.text) {
        parts[partIndex] = { ...part, text: nextText };
        stripped = true;
      }
      break;
    }
    if (stripped) nextMessages[index] = { ...message, content: parts };
    return nextMessages;
  }
  return messages;
}

function prefixFallbackSkillMentions(
  input: CodexAppServerUserInput[],
  skillIds: ReadonlyArray<string>,
): CodexAppServerUserInput[] {
  const fallbackSkillIds = Array.from(new Set(skillIds.filter(Boolean)));
  if (!fallbackSkillIds.length) return input;
  const prefix = fallbackSkillIds.map((skillId) => `$${skillId}`).join("\n");
  const nextInput = input.slice();
  const textIndex = nextInput.findIndex((entry) => entry.type === "text");
  if (textIndex < 0) {
    return [{ type: "text", text: prefix }, ...nextInput];
  }
  const textInput = nextInput[textIndex] as Extract<
    CodexAppServerUserInput,
    { type: "text" }
  >;
  nextInput[textIndex] = {
    ...textInput,
    text: textInput.text.trim() ? `${prefix}\n\n${textInput.text}` : prefix,
  };
  return nextInput;
}

function applyNativeSkillInputs(params: {
  input: CodexAppServerUserInput[];
  resolution: CodexNativeSkillInputResolution;
}): CodexAppServerUserInput[] {
  const withFallback = prefixFallbackSkillMentions(
    params.input,
    params.resolution.fallbackSkillIds,
  );
  return [...params.resolution.skillInputs, ...withFallback];
}

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function isCodexAppServerApprovalRequestMethod(method: string): boolean {
  return (
    CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS as readonly string[]
  ).includes(method);
}

type TrustedZoteroMcpApprovalPayload = {
  serverName: string;
  toolName: string;
  scopeToken?: string;
  approvalId?: string;
};

function isTrustedZoteroMcpServerName(value: string): boolean {
  return (
    value === ZOTERO_MCP_SERVER_NAME ||
    value.startsWith(`${ZOTERO_MCP_SERVER_NAME}_`)
  );
}

function findStructuredApprovalString(
  value: unknown,
  keys: ReadonlyArray<string>,
): string {
  for (const record of collectNestedRecords(value)) {
    const candidate = firstNonEmptyString(record, keys);
    if (candidate) return candidate;
  }
  return "";
}

function extractTrustedZoteroMcpApprovalPayload(
  params: unknown,
): TrustedZoteroMcpApprovalPayload | null {
  const serverName = findStructuredApprovalString(params, [
    "serverName",
    "server_name",
    "server",
  ]);
  if (!serverName || !isTrustedZoteroMcpServerName(serverName)) return null;

  const toolName = findStructuredApprovalString(params, [
    "toolName",
    "tool_name",
    "tool",
  ]).toLowerCase();
  if (!toolName || !TRUSTED_ZOTERO_MCP_AUTO_APPROVAL_TOOL_NAMES.has(toolName)) {
    return null;
  }

  return {
    serverName,
    toolName,
    scopeToken: findStructuredApprovalString(params, [
      "scopeToken",
      "scope_token",
      "x-llm-for-zotero-scope",
    ]),
    approvalId: findStructuredApprovalString(params, [
      "approvalId",
      "approval_id",
      "requestId",
      "request_id",
    ]),
  };
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

function chooseToolUserInputAnswer(question: unknown): string[] | null {
  if (!question || typeof question !== "object") return null;
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
  if (!choices.length) return null;
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
    )?.answer;
  if (!preferred) return null;
  return [preferred];
}

function buildToolRequestUserInputResponse(params: unknown): {
  answers: Record<string, { answers: string[] }>;
} | null {
  const answers: Record<string, { answers: string[] }> = {};
  if (!params || typeof params !== "object") return null;
  const questions = Array.isArray((params as Record<string, unknown>).questions)
    ? ((params as Record<string, unknown>).questions as unknown[])
    : [];
  if (!questions.length) return null;
  for (const [index, question] of questions.entries()) {
    const id =
      question && typeof question === "object"
        ? normalizeNonEmptyString((question as Record<string, unknown>).id)
        : "";
    if (!id) return null;
    const questionAnswers = chooseToolUserInputAnswer(question);
    if (!questionAnswers) return null;
    answers[id || `q${index + 1}`] = {
      answers: questionAnswers,
    };
  }
  return { answers };
}

function buildTrustedZoteroMcpApprovalResponse(
  request: CodexNativeApprovalRequest,
): unknown | null {
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
  if (!TRUSTED_ZOTERO_MCP_APPROVAL_METHODS.has(request.method)) return null;
  const trustedPayload = extractTrustedZoteroMcpApprovalPayload(request.params);
  if (!trustedPayload) return null;
  const response = buildTrustedZoteroMcpApprovalResponse(request);
  if (!response) return null;

  return {
    approved: true,
    response,
    reason: "trusted_zotero_mcp",
    target: `${trustedPayload.serverName}/${trustedPayload.toolName}`,
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
  return Boolean(extractTrustedZoteroMcpApprovalPayload(action));
}

export const isDeniedTrustedZoteroMcpGuardianReviewForTests =
  isDeniedTrustedZoteroMcpGuardianReview;

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

function buildCodexNativeVisibleTurnContextBlock(params: {
  scope: CodexNativeConversationScope;
  skillContext?: CodexNativeSkillContext;
}): string {
  const { scope, skillContext } = params;
  return buildVisibleTurnContextBlock({
    conversationKind: scope.kind === "paper" ? "paper" : "global",
    libraryID: scope.libraryID,
    libraryName: scope.libraryName,
    activeItemId: scope.activeItemId,
    activePaperTitle: scope.paperTitle,
    activePaperContext: scope.paperContext,
    selectedPaperContexts: skillContext?.selectedPaperContexts,
    fullTextPaperContexts: skillContext?.fullTextPaperContexts,
    pinnedPaperContexts: skillContext?.pinnedPaperContexts,
    selectedCollectionContexts: skillContext?.selectedCollectionContexts,
    selectedTagContexts: skillContext?.selectedTagContexts,
    selectedTexts: skillContext?.selectedTexts,
    selectedTextSources: skillContext?.selectedTextSources,
    selectedTextPaperContexts: skillContext?.selectedTextPaperContexts,
    screenshots: skillContext?.screenshots,
    attachments: skillContext?.attachments,
    activeNoteContext: scope.activeNoteId
      ? {
          noteId: scope.activeNoteId,
          title: scope.activeNoteTitle || "Active note",
          noteKind:
            scope.activeNoteKind === "standalone" ? "standalone" : "item",
          parentItemId: scope.activeNoteParentItemId,
          noteText: "",
        }
      : undefined,
  });
}

export function buildCodexNativeVisibleTurnContextBlockForTests(params: {
  scope: CodexNativeConversationScope;
  skillContext?: CodexNativeSkillContext;
}): string {
  return buildCodexNativeVisibleTurnContextBlock(params);
}

function buildCodexNativeScopedMcpScope(params: {
  scope: CodexNativeConversationScope;
  profileSignature: string;
  userText: string;
  skillContext?: CodexNativeSkillContext;
}): ZoteroMcpActiveScope {
  return {
    ...params.scope,
    profileSignature: params.profileSignature,
    userText: params.userText,
    selectedPaperContexts: params.skillContext?.selectedPaperContexts,
    fullTextPaperContexts: params.skillContext?.fullTextPaperContexts,
    pinnedPaperContexts: params.skillContext?.pinnedPaperContexts,
    selectedCollectionContexts: params.skillContext?.selectedCollectionContexts,
    selectedTagContexts: params.skillContext?.selectedTagContexts,
  };
}

export function buildCodexNativeScopedMcpScopeForTests(params: {
  scope: CodexNativeConversationScope;
  profileSignature: string;
  userText: string;
  skillContext?: CodexNativeSkillContext;
}): ZoteroMcpActiveScope {
  return buildCodexNativeScopedMcpScope(params);
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
      params.resourceContextBlock || "",
      params.priorReadContextBlock || "",
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
      params.resourceContextBlock || "",
      params.priorReadContextBlock || "",
      params.skillInstructionBlock || "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  lines.push(
    "- You are Codex. Zotero resources and MCP tools are available when useful; they are not mandatory for every response.",
    "- Use tools only when they materially improve the answer or are required to inspect/update Zotero. If available context is enough, answer directly.",
    "- For Zotero library, profile, item, PDF, and note facts not shown in context, use Zotero MCP tools instead of local Zotero database/filesystem copies.",
    "- Paper content: use paper_read overview for broad single-paper summaries, targeted for specific sections/results/methods, and visual/capture only for figures, layout, pages, or current reader capture. For bounded selected multi-paper synthesis, comparison, commonality, or theme questions, overview is the answer style, not the read depth; use library_retrieve or the supplied evidence ledger for body-evidence coverage before answering.",
    `- ${BALANCED_EVIDENCE_GUIDANCE}`,
    "- Citations: use the provided sourceLabel for paper-grounded claims. When paper_read provides verified quote anchors like [[quote:Q_x7a2]], use those anchor tokens only when exact wording is useful instead of manually copying the quote or sourceLabel. Use `>` blockquotes only for direct original source text. Direct quote text must be copied verbatim in the original source language; never translate quote text to match the user's language. If a translation, interpretation, emphasis, example, or opinion is useful, write it outside the blockquote as explanation or in a fenced `text` block, not as the quoted source passage. If no quote anchor is provided for a direct quote, put the sourceLabel on the next non-empty line after the blockquote. Copy the Source label string exactly. Do not invent author/year/page/section labels. Do not write [[source=...]], section=..., or chunk=... metadata in the final answer. Do not call tools solely to discover quotes or page numbers; the UI citation binder may resolve page links after rendering.",
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
  const contextBlock = /^Zotero context for this turn:/i.test(prefix)
    ? prefix
    : `Zotero context for this turn:\n${prefix}`;
  const textPrefix = `${contextBlock}\n\nUser request:\n`;
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
  latestUserContextText?: string;
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
  const latestUserContextText = (params.latestUserContextText || "").trim();
  return [
    ...(systemText ? [{ role: "system" as const, content: systemText }] : []),
    ...history,
    {
      ...latestUser,
      content: prefixUserContentWithContext(
        latestUser.content,
        latestUserContextText,
      ),
    },
  ];
}

function resolveNativeContextPlacement(
  thread: NativeThreadResolution,
): NativeContextPlacement {
  return thread.developerInstructionsAccepted
    ? "developer-instructions"
    : "latest-user-prefix";
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
  cwd?: string;
}): Promise<{
  threadId: string;
  developerInstructionsAccepted: boolean;
  threadSource?: string;
}> {
  const threadStartParams: Record<string, unknown> = {
    model: params.model,
    ephemeral: false,
    persistExtendedHistory: true,
    ...buildCodexAppServerNativeApprovalParams(),
    serviceName: CODEX_APP_SERVER_SERVICE_NAME,
    ...(params.cwd ? { cwd: params.cwd } : {}),
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
  cwd?: string;
}): Promise<{
  threadId: string;
  developerInstructionsAccepted: boolean;
  threadSource?: string;
}> {
  const threadResumeParams: Record<string, unknown> = {
    threadId: params.threadId,
    model: params.model,
    persistExtendedHistory: true,
    ...buildCodexAppServerNativeApprovalParams(),
    ...(params.cwd ? { cwd: params.cwd } : {}),
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
  cwd?: string;
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
        cwd: params.cwd,
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
    cwd: params.cwd,
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
                (response as Record<string, unknown>).answers ||
                ((response as Record<string, unknown>).scope === "turn" &&
                  Boolean((response as Record<string, unknown>).permissions))),
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
    cursor?: string;
    limit?: number;
    processKey?: string;
  } = {},
): Promise<unknown> {
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  const requestParams: Record<string, unknown> = {
    includeHidden: params.includeHidden === true,
  };
  if (params.cursor) requestParams.cursor = params.cursor;
  const limit = params.limit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    requestParams.limit = Math.floor(limit);
  }
  return proc.sendRequest("model/list", requestParams);
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
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  if (params.signal?.aborted) {
    throw createNativeClientAbortError();
  }
  const codexPath = resolveCodexAppServerBinaryPath(params.codexPath);
  const proc = await getOrCreateCodexAppServerProcess(
    params.processKey || CODEX_APP_SERVER_NATIVE_PROCESS_KEY,
    { codexPath },
  );
  if (params.signal?.aborted) {
    throw createNativeClientAbortError();
  }
  const localAbort = new AbortController();
  const abortLocal = () => localAbort.abort();
  params.signal?.addEventListener("abort", abortLocal, { once: true });
  const compacted = waitForCodexAppServerThreadCompacted({
    proc,
    threadId: params.threadId,
    signal: localAbort.signal,
    timeoutMs: params.timeoutMs,
  });
  try {
    await proc.sendRequest("thread/compact/start", {
      threadId: params.threadId,
    });
    await compacted;
  } catch (error) {
    localAbort.abort();
    await compacted.catch(() => undefined);
    throw error;
  } finally {
    params.signal?.removeEventListener("abort", abortLocal);
  }
}

export async function compactCodexAppServerConversation(params: {
  conversationKey: number;
  codexPath?: string;
  processKey?: string;
  hooks?: CodexNativeStoreHooks;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const threadId = await loadStoredProviderSessionId({
    conversationKey: params.conversationKey,
    hooks: params.hooks,
  });
  if (!threadId) {
    throw new Error(NO_CODEX_APP_SERVER_THREAD_TO_COMPACT_MESSAGE);
  }
  await compactCodexAppServerThread({
    threadId,
    codexPath: params.codexPath,
    processKey: params.processKey,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
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
    const scopedMcpScope = buildCodexNativeScopedMcpScope({
      scope: scopeWithProfile,
      profileSignature,
      userText: latestUserText,
      skillContext: params.skillContext,
    });
    const scopedMcp = mcpEnabled
      ? registerScopedZoteroMcpScope(scopedMcpScope)
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
    const codexNativeSkillMode = getCodexNativeSkillModePref();
    const codexNativeRuntimeCwd =
      codexNativeSkillMode === "native"
        ? resolveCodexNativeRuntimeCwd()
        : undefined;
    let mcpReady = !mcpEnabled;
    let mcpWarning = "";
    let mcpStatus: CodexNativeMcpSetupStatus | undefined;
    const clearMcpScope = mcpEnabled
      ? setActiveZoteroMcpScope(scopedMcpScope)
      : () => undefined;
    const clearMcpConfirmationHandler =
      mcpEnabled && params.onMcpConfirmationRequest
        ? addZoteroMcpConfirmationHandler(
            scopedMcpScope,
            params.onMcpConfirmationRequest,
          )
        : () => undefined;
    let unregisterGuardianReviews: () => void = () => undefined;
    try {
      const reasoningParams = resolveCodexAppServerReasoningParams(
        params.reasoning,
        params.model,
      );
      const executePreparedThread = async (args: {
        thread: NativeThreadResolution;
        input: unknown;
        skillIds: string[];
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
            ...(codexNativeRuntimeCwd ? { cwd: codexNativeRuntimeCwd } : {}),
            ...buildCodexAppServerNativeApprovalParams(),
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

      const priorReadContextBlock = buildCodexNativePriorReadContextBlock({
        profileSignature,
        conversationKey: params.scope.conversationKey,
        threadId: storedThreadId,
      });
      const resolvedSkills =
        codexNativeSkillMode !== "off"
          ? await resolveCodexNativeSkills({
              scope: scopeWithProfile,
              userText: latestUserText,
              model: params.model,
              apiBase: params.codexPath,
              signal: params.signal,
              skillContext: params.skillContext,
            })
          : { matchedSkillIds: [], instructionBlock: "" };
      const nativeSkillInputResolution =
        codexNativeSkillMode === "native"
          ? await resolveCodexNativeSkillInputItems({
              proc,
              cwd: codexNativeRuntimeCwd,
              skillIds: resolvedSkills.matchedSkillIds,
            })
          : { skillInputs: [], fallbackSkillIds: [] };
      const skillInstructionBlock =
        codexNativeSkillMode === "legacy"
          ? resolvedSkills.instructionBlock
          : "";
      const messagesForNativeTurn =
        codexNativeSkillMode === "native"
          ? stripLatestUserNativeSkillMentions(
              params.messages,
              resolvedSkills.matchedSkillIds,
            )
          : params.messages;
      for (const skillId of resolvedSkills.matchedSkillIds) {
        params.onSkillActivated?.(skillId);
      }
      const visibleTurnContextBlock = buildCodexNativeVisibleTurnContextBlock({
        scope: scopeWithProfile,
        skillContext: params.skillContext,
      });
      const optimisticMcpReady = mcpEnabled;
      const developerEnvironmentText = buildZoteroEnvironmentManifest({
        scope: scopeWithProfile,
        mcpEnabled,
        mcpReady: optimisticMcpReady,
        mcpWarning,
        skillInstructionBlock,
        priorReadContextBlock,
        resourceContextBlock: visibleTurnContextBlock,
      });
      const developerInstructionMessages = buildNativeMessages({
        messages: messagesForNativeTurn,
        includeVisibleHistory: true,
        zoteroEnvironmentText: developerEnvironmentText,
      });
      const developerPreparedTurn = await prepareCodexAppServerChatTurn(
        developerInstructionMessages,
      );
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
        developerInstructions: developerPreparedTurn.developerInstructions,
        config: threadConfig,
        cwd: codexNativeRuntimeCwd,
        hooks: params.hooks,
        storedThreadId: storedThreadId || null,
      });
      if (!thread.resumed) {
        await setNativeThreadName({
          proc,
          threadId: thread.threadId,
          name: params.scope.title,
        });
      }
      const contextPlacement = resolveNativeContextPlacement(thread);
      const latestUserFallbackContextText = [
        visibleTurnContextBlock,
        buildZoteroEnvironmentManifest({
          scope: scopeWithProfile,
          mcpEnabled,
          mcpReady,
          mcpWarning,
          skillInstructionBlock,
          priorReadContextBlock,
          resourceContextBlock: "",
        }),
      ]
        .filter(Boolean)
        .join("\n\n");
      const nativeMessages = buildNativeMessages({
        messages: messagesForNativeTurn,
        includeVisibleHistory: true,
        zoteroEnvironmentText: buildZoteroEnvironmentManifest({
          scope: scopeWithProfile,
          mcpEnabled,
          mcpReady,
          mcpWarning,
          skillInstructionBlock: "",
          priorReadContextBlock: "",
          resourceContextBlock: "",
        }),
        prefixLatestUserWithContext: contextPlacement === "latest-user-prefix",
        latestUserContextText: latestUserFallbackContextText,
      });
      const preparedTurn = await prepareCodexAppServerChatTurn(nativeMessages);
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
      const nativeInput =
        codexNativeSkillMode === "native"
          ? applyNativeSkillInputs({
              input: input as CodexAppServerUserInput[],
              resolution: nativeSkillInputResolution,
            })
          : input;
      return await executePreparedThread({
        thread,
        input: nativeInput,
        skillIds: resolvedSkills.matchedSkillIds,
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
