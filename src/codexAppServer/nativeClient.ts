import type {
  ChatMessage,
  MessageContent,
  ReasoningConfig,
  ReasoningEvent,
  TextContent,
  UsageStats,
} from "../shared/llm";
import type { AgentConfirmationResolution } from "../agent/types";
import type { CodexConversationKind, PaperContextRef } from "../shared/types";
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
const CODEX_APP_SERVER_NATIVE_APPROVAL_PARAMS = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
};
const CODEX_APP_SERVER_GUARDIAN_REVIEW_COMPLETED_METHOD =
  "item/autoApprovalReview/completed";

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
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

function buildZoteroEnvironmentManifest(params: {
  scope: CodexNativeConversationScope;
  mcpEnabled: boolean;
  mcpReady: boolean;
  mcpWarning?: string;
  skillInstructionBlock?: string;
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
    "- Zotero MCP tools: available. Use them to inspect and update Zotero data instead of assuming library or paper content is preloaded.",
    "- Critical: use only Zotero MCP tools for Zotero library, profile, item, PDF, and note data. If Zotero MCP tools are unavailable or fail, report the setup error. Do not inspect local Zotero profile folders, zotero.sqlite, WAL files, backups, or other filesystem copies to answer Zotero-library questions.",
    "- Codex built-in shell access is disabled. Use Zotero MCP tools such as run_command, file_io, and zotero_script only when needed.",
    "- Write workflow: use focused Zotero MCP write tools for requested changes. For Zotero note creation or editing, call edit_current_note; do not output note-ready text in chat as a substitute.",
    "- Note workflow: for note creation, saving, editing, appending, updating, or rewriting requests in any language, use edit_current_note. Do not rediscover the active note before editing it, and do not dump note-ready text in chat instead of applying the requested note change.",
    "- Active-note workflow: when an active note ID is listed, edit_current_note can edit that note directly. Use the listed active note ID/scope as the target unless the user explicitly names a different note.",
    "- Review workflow: most write tools return only after the user approves or denies the Zotero review card. zotero_script runs directly; write scripts must use env.snapshot(item) or env.addUndoStep(fn) so undo_last_action can revert them.",
  );
  if (scope.kind === "paper") {
    lines.push(
      "- Paper workflow: if the active or selected paper context lists mineruCacheDir, read MinerU manifest.json/full.md with file_io before using raw PDF tools. Use read_paper/search_paper only when MinerU is unavailable or after MinerU lacks the needed evidence; use view_pdf_pages only for visual page inspection.",
    );
  } else {
    lines.push(
      "- Library workflow: use query_library to discover/search/list items in the active library, then read_library and paper tools on selected item IDs before answering. Do not ask the user to paste the whole library.",
    );
  }
  return [
    lines.join("\n"),
    notesDirectoryConfig,
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
  config?: Record<string, unknown>;
  hooks?: CodexNativeStoreHooks;
}): Promise<NativeThreadResolution> {
  const storedThreadId = await loadStoredProviderSessionId({
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
    developerInstructions: params.developerInstructions,
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
    const resolvedSkills = await resolveCodexNativeSkills({
      scope: { ...params.scope, profileSignature },
      userText: latestUserText,
      model: params.model,
      apiBase: params.codexPath,
      signal: params.signal,
      skillContext: params.skillContext,
    });
    for (const skillId of resolvedSkills.matchedSkillIds) {
      params.onSkillActivated?.(skillId);
    }
    const scopedMcp = mcpEnabled
      ? registerScopedZoteroMcpScope({
          ...params.scope,
          profileSignature,
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
      const optimisticMcpReady = mcpEnabled;
      const plainNativeMessages = buildNativeMessages({
        messages: params.messages,
        includeVisibleHistory: true,
        zoteroEnvironmentText: buildZoteroEnvironmentManifest({
          scope: { ...params.scope, profileSignature },
          mcpEnabled,
          mcpReady: optimisticMcpReady,
          mcpWarning,
          skillInstructionBlock: resolvedSkills.instructionBlock,
        }),
      });
      const plainPreparedTurn =
        await prepareCodexAppServerChatTurn(plainNativeMessages);
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
        scope: { ...params.scope, profileSignature },
        model: params.model,
        effort: reasoningParams.effort,
        developerInstructions: plainPreparedTurn.developerInstructions,
        config: threadConfig,
        hooks: params.hooks,
      });
      if (!thread.resumed) {
        await setNativeThreadName({
          proc,
          threadId: thread.threadId,
          name: params.scope.title,
        });
      }
      unregisterGuardianReviews = registerNativeGuardianReviewHandlers({
        proc,
        threadId: thread.threadId,
      });
      params.onDiagnostics?.(
        buildNativeDiagnostics({
          thread,
          profileSignature,
          scope: params.scope,
          mcpServerName: mcpThreadConfig?.serverName,
          mcpReady,
          mcpStatus,
          skillIds: resolvedSkills.matchedSkillIds,
        }),
      );
      const nativeMessages = buildNativeMessages({
        messages: params.messages,
        includeVisibleHistory: true,
        zoteroEnvironmentText: buildZoteroEnvironmentManifest({
          scope: { ...params.scope, profileSignature },
          mcpEnabled,
          mcpReady,
          mcpWarning,
          skillInstructionBlock: resolvedSkills.instructionBlock,
        }),
        prefixLatestUserWithContext: !thread.developerInstructionsAccepted,
      });
      const preparedTurn = thread.developerInstructionsAccepted
        ? plainPreparedTurn
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
      const unregisterMcpToolActivity = params.onMcpToolActivity
        ? addZoteroMcpToolActivityObserver((event) => {
            const sameConversation =
              !event.conversationKey ||
              !params.scope.conversationKey ||
              event.conversationKey === params.scope.conversationKey;
            const sameProfile =
              !event.profileSignature ||
              !profileSignature ||
              event.profileSignature === profileSignature;
            if (!sameConversation || !sameProfile) return;
            params.onMcpToolActivity?.(event);
          })
        : () => undefined;
      let text = "";
      try {
        const turnResult = await proc.sendRequest("turn/start", {
          threadId: thread.threadId,
          input,
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
          threadId: thread.threadId,
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
      const historyVerified = await verifyCodexAppServerThreadHistory({
        proc,
        threadId: thread.threadId,
      });
      const diagnostics = buildNativeDiagnostics({
        thread,
        profileSignature,
        scope: params.scope,
        mcpServerName: mcpThreadConfig?.serverName,
        mcpReady,
        mcpStatus,
        skillIds: resolvedSkills.matchedSkillIds,
        historyVerified,
      });
      params.onDiagnostics?.(diagnostics);
      return {
        text,
        threadId: thread.threadId,
        resumed: thread.resumed,
        diagnostics,
      };
    } finally {
      unregisterGuardianReviews();
      scopedMcp?.clear();
      clearMcpConfirmationHandler();
      clearMcpScope();
      unregisterApprovalHandlers();
    }
  });
}
