import type {
  AgentModelContentPart,
  AgentModelMessage,
  AgentToolMessage,
} from "../types";
import {
  estimateContextMessagesTokens,
  estimateTextTokens,
  resolveContextWindowTokens,
} from "../../utils/modelInputCap";

const AGENT_PROMPT_SOFT_LIMIT_RATIO = 0.9;
const HISTORY_CHECKPOINT_MAX_TOKENS = 1_200;
const TOOL_HANDLE_MAX_TOKENS = 768;
const MIN_CATALOG_TOOL_TOKENS = 1_024;
const MIN_EVIDENCE_TOOL_TOKENS = 2_048;
const MIN_GENERIC_TOOL_TOKENS = 768;

export class AgentPromptBudgetError extends Error {
  constructor(
    message: string,
    readonly details: {
      estimatedTokens: number;
      softLimitTokens: number;
      contextWindow: number;
    },
  ) {
    super(message);
    this.name = "AgentPromptBudgetError";
  }
}

export type AgentPromptBudgetLimits = {
  contextWindow: number;
  softLimitTokens: number;
};

export type AgentPromptReductionKind =
  | "history_checkpoint"
  | "tool_result_cleared"
  | "catalog_compacted"
  | "evidence_compacted"
  | "generic_compacted";

export type AgentPromptReduction = {
  kind: AgentPromptReductionKind;
  count: number;
};

export type AgentPromptBudgetResult = {
  messages: AgentModelMessage[];
  changed: boolean;
  contextWindow: number;
  softLimitTokens: number;
  estimatedBeforeTokens: number;
  estimatedAfterTokens: number;
  reductions: AgentPromptReduction[];
};

export function resolveAgentPromptBudgetLimits(params: {
  model?: string;
  inputTokenCap?: number;
}): AgentPromptBudgetLimits {
  const contextWindow = resolveContextWindowTokens(
    params.model || "",
    params.inputTokenCap,
  );
  return {
    contextWindow,
    softLimitTokens: Math.max(
      1,
      Math.floor(contextWindow * AGENT_PROMPT_SOFT_LIMIT_RATIO),
    ),
  };
}

function cloneContentPart(part: AgentModelContentPart): AgentModelContentPart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image_url") {
    return {
      type: "image_url",
      image_url: {
        url: part.image_url.url,
        detail: part.image_url.detail,
      },
    };
  }
  return {
    type: "file_ref",
    file_ref: {
      name: part.file_ref.name,
      mimeType: part.file_ref.mimeType,
      storedPath: part.file_ref.storedPath,
      contentHash: part.file_ref.contentHash,
    },
  };
}

function cloneMessage(message: AgentModelMessage): AgentModelMessage {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content.map((part) => cloneContentPart(part));
  if (message.role === "assistant") {
    return {
      ...message,
      content,
      tool_calls: Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          }))
        : message.tool_calls,
    };
  }
  return {
    ...message,
    content,
  } as AgentModelMessage;
}

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_err) {
    return String(value);
  }
}

function estimateMessageTokens(message: AgentModelMessage): number {
  return estimateContextMessagesTokens([message]);
}

function truncateStringToTokenBudget(value: string, maxTokens: number): string {
  const maxChars = Math.max(64, Math.floor(maxTokens * 4));
  if (estimateTextTokens(value) <= maxTokens) return value;
  const notice = "\n\n[Content truncated to fit the model context budget.]";
  const bodyChars = Math.max(0, maxChars - notice.length);
  return `${value.slice(0, bodyChars).trimEnd()}${notice}`;
}

function compactScalar(value: unknown, maxChars = 240): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maxChars
      ? `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
      : normalized;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  return undefined;
}

function compactMetadataValue(value: unknown, depth = 0): unknown {
  const scalar = compactScalar(value);
  if (scalar !== undefined || value === null) return scalar;
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => compactMetadataValue(entry, depth + 1))
      .filter((entry) => entry !== undefined)
      .slice(0, 20);
  }
  if (value && typeof value === "object") {
    const compact: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const compacted = compactMetadataValue(entry, depth + 1);
      if (compacted !== undefined && compacted !== "") {
        compact[key] = compacted;
      }
    }
    return Object.keys(compact).length ? compact : undefined;
  }
  return undefined;
}

function parseToolContent(message: AgentToolMessage): unknown {
  try {
    return JSON.parse(message.content);
  } catch (_err) {
    return message.content;
  }
}

function isLibrarySearchTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "query_library" || normalized === "library_search";
}

function isEvidenceTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return (
    normalized === "library_retrieve" ||
    normalized === "paper_read" ||
    normalized === "read_paper" ||
    normalized === "search_paper" ||
    normalized === "read_attachment" ||
    normalized === "view_pdf_pages"
  );
}

function simpleDigest(value: unknown): string {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function buildToolCallArgumentDigestById(
  messages: AgentModelMessage[],
): Map<string, string> {
  const digests = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls) {
      digests.set(call.id, simpleDigest(call.arguments ?? {}));
    }
  }
  return digests;
}

function compactLibraryRecord(record: unknown): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    return { value: compactScalar(record) };
  }
  const source = record as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of [
    "itemId",
    "contextItemId",
    "parentItemId",
    "parentItemTitle",
    "collectionId",
    "libraryID",
    "itemType",
    "name",
    "path",
    "title",
    "firstCreator",
    "year",
    "noteKind",
    "paperCount",
    "itemCount",
    "score",
    "matchReason",
    "whyMatched",
  ]) {
    const value = compactScalar(source[key]);
    if (value !== undefined && value !== "") compact[key] = value;
  }
  if (Array.isArray(source.tags)) {
    compact.tags = source.tags
      .map((tag) => compactScalar(tag))
      .filter((tag) => tag !== undefined)
      .slice(0, 12);
  }
  if (Array.isArray(source.collectionIds)) {
    compact.collectionIds = source.collectionIds
      .filter((id) => typeof id === "number" || typeof id === "string")
      .slice(0, 20);
  }
  if (Array.isArray(source.attachments)) {
    compact.attachmentCount = source.attachments.length;
  }
  if (Array.isArray(source.children)) {
    compact.childCollectionCount = source.children.length;
  }
  if (Array.isArray(source.papers)) {
    compact.paperCount = source.papers.length;
    compact.papers = source.papers.slice(0, 8).map(compactLibraryRecord);
  }
  return compact;
}

function compactPaperContext(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of ["itemId", "contextItemId", "attachmentItemId", "title"]) {
    const scalar = compactScalar(source[key]);
    if (scalar !== undefined && scalar !== "") compact[key] = scalar;
  }
  return Object.keys(compact).length ? compact : undefined;
}

function compactEvidenceSnippet(record: unknown): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    return { text: compactScalar(record, 900) };
  }
  const source = record as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of [
    "text",
    "sourceLabel",
    "citationLabel",
    "sectionLabel",
    "pageLabel",
    "chunkKind",
    "chunkIndex",
    "score",
    "quoteCitationId",
    "sourceKind",
    "matchStatus",
  ]) {
    const value = compactScalar(source[key], key === "text" ? 1_200 : 240);
    if (value !== undefined && value !== "") compact[key] = value;
  }
  const paperContext = compactPaperContext(source.paperContext);
  if (paperContext) compact.paperContext = paperContext;
  if (Array.isArray(source.passages)) {
    compact.passageCount = source.passages.length;
    compact.passages = source.passages.slice(0, 4).map(compactEvidenceSnippet);
  }
  return compact;
}

function compactPaperMatch(record: unknown): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    return { value: compactScalar(record) };
  }
  const source = record as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of [
    "itemId",
    "contextItemId",
    "title",
    "firstCreator",
    "year",
    "matchStatus",
    "score",
    "sourceKind",
    "evidenceCount",
    "whyMatched",
  ]) {
    const value = compactScalar(source[key]);
    if (value !== undefined && value !== "") compact[key] = value;
  }
  const paperContext = compactPaperContext(source.paperContext);
  if (paperContext) compact.paperContext = paperContext;
  return compact;
}

function buildGenericCompactToolResult(params: {
  toolName: string;
  content: unknown;
  maxTokens: number;
}): unknown {
  const fullText = stableStringify(params.content);
  return {
    modelContextCompacted: true,
    compactionReason:
      "The complete provider-bound prompt exceeded the active context budget.",
    notice: `${params.toolName} returned a large result. This is a reduced model-facing view produced only because the full prompt did not fit.`,
    excerpt: truncateStringToTokenBudget(fullText, params.maxTokens),
  };
}

function buildLibraryCompactToolResult(params: {
  toolName: string;
  content: unknown;
  maxTokens: number;
}): unknown {
  if (!params.content || typeof params.content !== "object") {
    return buildGenericCompactToolResult(params);
  }
  const source = params.content as Record<string, unknown>;
  const resultKey = Array.isArray(source.results)
    ? "results"
    : Array.isArray(source.collections)
      ? "collections"
      : "results";
  const sourceResults = Array.isArray(source[resultKey])
    ? source[resultKey]
    : [];
  const totalCount =
    typeof source.totalCount === "number" ? source.totalCount : undefined;
  const returnedCount =
    typeof source.returnedCount === "number"
      ? source.returnedCount
      : sourceResults.length;
  const compactBase: Record<string, unknown> = {
    entity: compactScalar(source.entity),
    mode: compactScalar(source.mode),
    view: compactScalar(source.view),
    referenceItemId: compactScalar(source.referenceItemId),
    referenceTitle: compactScalar(source.referenceTitle),
    totalCount,
    returnedCount,
    limited: source.limited === true || totalCount !== returnedCount,
    warnings: Array.isArray(source.warnings)
      ? source.warnings.map((entry) => compactScalar(entry)).slice(0, 8)
      : undefined,
  };
  for (const key of [
    "text",
    "query",
    "filters",
    "scope",
    "limit",
    "include",
    "libraryID",
    "libraryName",
    "unfiled",
    "totalGroups",
  ]) {
    const value = compactMetadataValue(source[key]);
    if (value !== undefined && value !== "") compactBase[key] = value;
  }
  for (const key of Object.keys(compactBase)) {
    if (compactBase[key] === undefined || compactBase[key] === "") {
      delete compactBase[key];
    }
  }
  const compactRecords: Record<string, unknown>[] = [];
  for (const record of sourceResults) {
    compactRecords.push(compactLibraryRecord(record));
    const candidate = {
      ...compactBase,
      [resultKey]: compactRecords,
      modelContextCompacted: true,
      compactionReason:
        "The complete provider-bound prompt exceeded the active context budget.",
      modelContextOmittedCount: Math.max(
        0,
        sourceResults.length - compactRecords.length,
      ),
      notice: `${params.toolName} was reduced under context pressure. Catalog rows were bounded, but counts, filters/scope, and item identifiers were preserved.`,
    };
    if (estimateTextTokens(stableStringify(candidate)) > params.maxTokens) {
      compactRecords.pop();
      break;
    }
  }
  return {
    ...compactBase,
    [resultKey]: compactRecords,
    modelContextCompacted: true,
    compactionReason:
      "The complete provider-bound prompt exceeded the active context budget.",
    modelContextOmittedCount: Math.max(
      0,
      sourceResults.length - compactRecords.length,
    ),
    notice: `${params.toolName} was reduced under context pressure. Catalog rows were bounded, but counts, filters/scope, and item identifiers were preserved.`,
  };
}

function buildEvidenceCompactToolResult(params: {
  toolName: string;
  content: unknown;
  maxTokens: number;
}): unknown {
  if (!params.content || typeof params.content !== "object") {
    return buildGenericCompactToolResult(params);
  }
  const source = params.content as Record<string, unknown>;
  const base: Record<string, unknown> = {
    mode: compactScalar(source.mode),
    intent: compactScalar(source.intent),
    depth: compactScalar(source.depth),
    methodsUsed: compactMetadataValue(source.methodsUsed),
    resourcePool: compactMetadataValue(source.resourcePool),
    answerContract: compactMetadataValue(source.answerContract),
    warnings: compactMetadataValue(source.warnings),
    quoteCitations: compactMetadataValue(source.quoteCitations),
    modelContextCompacted: true,
    compactionReason:
      "The complete provider-bound prompt exceeded the active context budget.",
    notice: `${params.toolName} evidence was reduced only after lower-value context could not fit. Paper IDs, source anchors, snippets, and coverage metadata are prioritized.`,
  };
  for (const key of Object.keys(base)) {
    if (base[key] === undefined || base[key] === "") delete base[key];
  }

  const paperMatches = Array.isArray(source.paperMatches)
    ? source.paperMatches
    : [];
  const snippets = Array.isArray(source.snippets) ? source.snippets : [];
  const results = Array.isArray(source.results) ? source.results : [];
  const papers = Array.isArray(source.papers) ? source.papers : [];
  const next: Record<string, unknown> = {
    ...base,
    paperMatches: [],
    snippets: [],
    results: [],
    papers: [],
    modelContextOmitted: {
      paperMatches: paperMatches.length,
      snippets: snippets.length,
      results: results.length,
      papers: papers.length,
    },
  };

  const tryPush = (
    key: "paperMatches" | "snippets" | "results" | "papers",
    value: Record<string, unknown>,
  ): boolean => {
    (next[key] as Record<string, unknown>[]).push(value);
    (next.modelContextOmitted as Record<string, number>)[key] = Math.max(
      0,
      (next.modelContextOmitted as Record<string, number>)[key] - 1,
    );
    if (estimateTextTokens(stableStringify(next)) <= params.maxTokens) {
      return true;
    }
    (next[key] as Record<string, unknown>[]).pop();
    (next.modelContextOmitted as Record<string, number>)[key] += 1;
    return false;
  };

  for (const match of paperMatches) {
    if (!tryPush("paperMatches", compactPaperMatch(match))) break;
  }
  for (const snippet of snippets) {
    if (!tryPush("snippets", compactEvidenceSnippet(snippet))) break;
  }
  for (const result of results) {
    if (!tryPush("results", compactEvidenceSnippet(result))) break;
  }
  for (const paper of papers) {
    if (!tryPush("papers", compactEvidenceSnippet(paper))) break;
  }
  for (const key of [
    "paperMatches",
    "snippets",
    "results",
    "papers",
  ] as const) {
    if (!(next[key] as unknown[]).length) delete next[key];
  }
  return next;
}

function compactToolContent(params: {
  toolName: string;
  content: unknown;
  maxTokens: number;
}): unknown {
  if (isLibrarySearchTool(params.toolName)) {
    return buildLibraryCompactToolResult(params);
  }
  if (isEvidenceTool(params.toolName)) {
    return buildEvidenceCompactToolResult(params);
  }
  return buildGenericCompactToolResult(params);
}

function buildToolResultHandle(params: {
  message: AgentToolMessage;
  content: unknown;
  argumentDigest?: string;
}): unknown {
  const content =
    params.content && typeof params.content === "object"
      ? (params.content as Record<string, unknown>)
      : {};
  const results = Array.isArray(content.results) ? content.results : undefined;
  const snippets = Array.isArray(content.snippets)
    ? content.snippets
    : undefined;
  const paperMatches = Array.isArray(content.paperMatches)
    ? content.paperMatches
    : undefined;
  return {
    modelContextCleared: true,
    toolName: params.message.name,
    toolCallId: params.message.tool_call_id,
    argumentDigest: params.argumentDigest,
    totalCount:
      typeof content.totalCount === "number" ? content.totalCount : undefined,
    returnedCount:
      typeof content.returnedCount === "number"
        ? content.returnedCount
        : results?.length,
    resultCount: results?.length,
    snippetCount: snippets?.length,
    paperMatchCount: paperMatches?.length,
    resourcePool: compactMetadataValue(content.resourcePool),
    coverage:
      compactMetadataValue(content.coverage) ||
      compactMetadataValue(
        (content.resourcePool as Record<string, unknown> | undefined)
          ?.queryCoverage,
      ),
    warnings: compactMetadataValue(content.warnings),
    notice:
      "Older tool output was cleared under context pressure. The full result remains in the trace/internal records; call the tool again or retrieve the cited source if exact details are needed.",
  };
}

function contentStringForMessage(
  content: AgentModelMessage["content"],
): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return "[image]";
      return `[file:${part.file_ref.name || "attached"}]`;
    })
    .join("\n");
}

function buildHistoryCheckpoint(
  messages: AgentModelMessage[],
): AgentModelMessage {
  const userLines: string[] = [];
  const assistantLines: string[] = [];
  const toolLines: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      toolLines.push(
        `- ${message.name} (${message.tool_call_id}, ${estimateMessageTokens(
          message,
        )} estimated tokens cleared from raw history)`,
      );
      continue;
    }
    const content = contentStringForMessage(message.content)
      .replace(/\s+/g, " ")
      .trim();
    if (!content) continue;
    if (message.role === "user" && userLines.length < 6) {
      userLines.push(`- ${content.slice(0, 240)}`);
    } else if (message.role === "assistant" && assistantLines.length < 6) {
      assistantLines.push(`- ${content.slice(0, 260)}`);
    }
  }
  const sections = [
    "Agent context checkpoint:",
    "Older raw conversation turns were reduced only because the complete provider-bound prompt exceeded the active context budget. Preserve source evidence from current tool results and prior coverage/evidence ledgers over this checkpoint when exact paper details matter.",
    userLines.length ? `Earlier user requests:\n${userLines.join("\n")}` : "",
    assistantLines.length
      ? `Earlier assistant state:\n${assistantLines.join("\n")}`
      : "",
    toolLines.length
      ? `Cleared older tool results:\n${toolLines.join("\n")}`
      : "",
  ].filter(Boolean);
  return {
    role: "user",
    content: truncateStringToTokenBudget(
      sections.join("\n\n"),
      HISTORY_CHECKPOINT_MAX_TOKENS,
    ),
  };
}

function findLatestRootUserIndex(messages: AgentModelMessage[]): number {
  let fallbackUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    if (fallbackUserIndex < 0) fallbackUserIndex = index;
    let previousIndex = index - 1;
    while (previousIndex >= 0 && messages[previousIndex].role === "system") {
      previousIndex -= 1;
    }
    if (previousIndex < 0 || messages[previousIndex].role !== "tool") {
      return index;
    }
  }
  return fallbackUserIndex;
}

function compactOlderHistory(messages: AgentModelMessage[]): {
  messages: AgentModelMessage[];
  changed: boolean;
} {
  const latestUserIndex = findLatestRootUserIndex(messages);
  if (latestUserIndex <= 0) return { messages, changed: false };
  const systemMessages = messages
    .slice(0, latestUserIndex)
    .filter((message) => message.role === "system");
  const older = messages
    .slice(0, latestUserIndex)
    .filter((message) => message.role !== "system");
  const tail = messages
    .slice(latestUserIndex)
    .filter((message) => message.role !== "system");
  if (!older.length) return { messages, changed: false };
  return {
    messages: [...systemMessages, buildHistoryCheckpoint(older), ...tail],
    changed: true,
  };
}

function protectedLatestToolCallIds(
  messages: AgentModelMessage[],
): Set<string> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    return new Set(message.tool_calls.map((call) => call.id));
  }
  return new Set();
}

function compactToolMessageToTokens(params: {
  message: AgentToolMessage;
  maxTokens: number;
  argumentsDigestById: Map<string, string>;
  clearToHandle?: boolean;
}): AgentToolMessage | null {
  const beforeTokens = estimateMessageTokens(params.message);
  if (beforeTokens <= params.maxTokens && !params.clearToHandle) return null;
  const parsed = parseToolContent(params.message);
  const content = params.clearToHandle
    ? buildToolResultHandle({
        message: params.message,
        content: parsed,
        argumentDigest: params.argumentsDigestById.get(
          params.message.tool_call_id,
        ),
      })
    : compactToolContent({
        toolName: params.message.name,
        content: parsed,
        maxTokens: params.maxTokens,
      });
  const next: AgentToolMessage = {
    ...params.message,
    content: stableStringify(content),
  };
  return estimateMessageTokens(next) < beforeTokens ? next : null;
}

function addReduction(
  reductions: AgentPromptReduction[],
  kind: AgentPromptReductionKind,
): void {
  const existing = reductions.find((entry) => entry.kind === kind);
  if (existing) {
    existing.count += 1;
    return;
  }
  reductions.push({ kind, count: 1 });
}

function reduceToolMessages(params: {
  messages: AgentModelMessage[];
  softLimitTokens: number;
  reductions: AgentPromptReduction[];
  predicate: (message: AgentToolMessage, index: number) => boolean;
  kind: AgentPromptReductionKind;
  minTokens: number;
  clearToHandle?: boolean;
}): { messages: AgentModelMessage[]; changed: boolean } {
  let messages = params.messages;
  let changed = false;
  const argumentsDigestById = buildToolCallArgumentDigestById(messages);
  for (let index = 0; index < messages.length; index += 1) {
    if (estimateContextMessagesTokens(messages) <= params.softLimitTokens) {
      break;
    }
    const message = messages[index];
    if (message.role !== "tool" || !params.predicate(message, index)) {
      continue;
    }
    const messageTokens = estimateMessageTokens(message);
    const deficit =
      estimateContextMessagesTokens(messages) - params.softLimitTokens;
    const targetTokens = params.clearToHandle
      ? TOOL_HANDLE_MAX_TOKENS
      : Math.max(params.minTokens, messageTokens - deficit - 256);
    const next = compactToolMessageToTokens({
      message,
      maxTokens: targetTokens,
      argumentsDigestById,
      clearToHandle: params.clearToHandle,
    });
    if (!next) continue;
    messages = messages.map((entry, entryIndex) =>
      entryIndex === index ? next : entry,
    );
    changed = true;
    addReduction(params.reductions, params.kind);
  }
  return { messages, changed };
}

function buildGracefulOverBudgetMessage(params: {
  estimatedTokens: number;
  softLimitTokens: number;
  contextWindow: number;
}): string {
  return (
    `I could not safely continue because the current protected context is still above the active input budget ` +
    `(${params.estimatedTokens} estimated tokens > ${params.softLimitTokens} send budget; context window ${params.contextWindow}). ` +
    "I did not send an oversized provider request, and retrieved tool/source records remain preserved in the trace and internal ledgers. " +
    "To continue, raise the Input cap or switch to a larger-context model, narrow the question/scope, or ask me to answer from a smaller evidence subset with explicit coverage limits."
  );
}

export function enforceAgentPromptBudget(params: {
  messages: AgentModelMessage[];
  model?: string;
  inputTokenCap?: number;
}): AgentPromptBudgetResult {
  const limits = resolveAgentPromptBudgetLimits({
    model: params.model,
    inputTokenCap: params.inputTokenCap,
  });
  let messages = params.messages.map((message) => cloneMessage(message));
  const reductions: AgentPromptReduction[] = [];
  const estimatedBeforeTokens = estimateContextMessagesTokens(messages);
  let changed = false;
  if (estimatedBeforeTokens <= limits.softLimitTokens) {
    return {
      messages,
      changed,
      contextWindow: limits.contextWindow,
      softLimitTokens: limits.softLimitTokens,
      estimatedBeforeTokens,
      estimatedAfterTokens: estimatedBeforeTokens,
      reductions,
    };
  }

  const historyCompaction = compactOlderHistory(messages);
  if (historyCompaction.changed) {
    messages = historyCompaction.messages;
    changed = true;
    addReduction(reductions, "history_checkpoint");
  }

  const protectedToolIds = protectedLatestToolCallIds(messages);
  const stages = [
    {
      kind: "tool_result_cleared" as const,
      minTokens: TOOL_HANDLE_MAX_TOKENS,
      clearToHandle: true,
      predicate: (message: AgentToolMessage) =>
        !protectedToolIds.has(message.tool_call_id) &&
        !isLibrarySearchTool(message.name) &&
        !isEvidenceTool(message.name),
    },
    {
      kind: "catalog_compacted" as const,
      minTokens: MIN_CATALOG_TOOL_TOKENS,
      predicate: (message: AgentToolMessage) =>
        isLibrarySearchTool(message.name),
    },
    {
      kind: "evidence_compacted" as const,
      minTokens: MIN_EVIDENCE_TOOL_TOKENS,
      predicate: (message: AgentToolMessage) =>
        isEvidenceTool(message.name) &&
        !protectedToolIds.has(message.tool_call_id),
    },
    {
      kind: "evidence_compacted" as const,
      minTokens: MIN_EVIDENCE_TOOL_TOKENS,
      predicate: (message: AgentToolMessage) =>
        isEvidenceTool(message.name) &&
        protectedToolIds.has(message.tool_call_id),
    },
    {
      kind: "generic_compacted" as const,
      minTokens: MIN_GENERIC_TOOL_TOKENS,
      predicate: (message: AgentToolMessage) =>
        !isLibrarySearchTool(message.name) && !isEvidenceTool(message.name),
    },
  ];

  for (const stage of stages) {
    if (estimateContextMessagesTokens(messages) <= limits.softLimitTokens) {
      break;
    }
    const reduced = reduceToolMessages({
      messages,
      softLimitTokens: limits.softLimitTokens,
      reductions,
      predicate: stage.predicate,
      kind: stage.kind,
      minTokens: stage.minTokens,
      clearToHandle: "clearToHandle" in stage ? stage.clearToHandle : false,
    });
    messages = reduced.messages;
    changed = changed || reduced.changed;
  }

  const estimatedAfterTokens = estimateContextMessagesTokens(messages);
  if (estimatedAfterTokens > limits.softLimitTokens) {
    throw new AgentPromptBudgetError(
      buildGracefulOverBudgetMessage({
        estimatedTokens: estimatedAfterTokens,
        softLimitTokens: limits.softLimitTokens,
        contextWindow: limits.contextWindow,
      }),
      {
        estimatedTokens: estimatedAfterTokens,
        softLimitTokens: limits.softLimitTokens,
        contextWindow: limits.contextWindow,
      },
    );
  }

  return {
    messages,
    changed,
    contextWindow: limits.contextWindow,
    softLimitTokens: limits.softLimitTokens,
    estimatedBeforeTokens,
    estimatedAfterTokens,
    reductions,
  };
}
