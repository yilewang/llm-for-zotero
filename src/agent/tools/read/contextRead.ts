import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { estimateTextTokens } from "../../../utils/modelInputCap";
import { getAgentToolResultHandle } from "../../store/toolResultHandles";
import { readAgentConversationMessages } from "../../store/transcriptStore";
import { fail, ok } from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { readTextChunk } from "./textChunk";
import { skillGuidance } from "../guidance";
import { PAPER_DIGEST_HANDLE_TOOL } from "../../digests/digestJobHost";
import { withoutDigestQuoteCitations } from "../../digests/paperDigestWorker";
import { extractQuoteCitationsFromToolContent } from "../../../services/quotes/quoteCitations";

/**
 * context_read: exact stored context the prompt no longer carries in full.
 *
 * `source:'tool_result'` pages a stored tool result by its trh_ handle;
 * `source:'conversation'` lists this conversation's messages or reads one
 * exactly. Each source keeps its own input vocabulary and validation.
 */

type ToolResultSourceInput = {
  source: "tool_result";
  handle: string;
  path?: string;
  offset: number;
  textOffset: number;
  limit: number;
  maxTokens: number;
  allowStale: boolean;
};

type ConversationSourceInput = {
  source: "conversation";
  messageId?: string;
  offset: number;
  textOffset: number;
  maxTokens: number;
};

type ContextReadInput = ToolResultSourceInput | ConversationSourceInput;

const CONTEXT_SOURCES = ["tool_result", "conversation"] as const;
/** Inputs that only one source reads; naming one under the other is a mistake. */
const TOOL_RESULT_ONLY_KEYS = ["handle", "path", "limit", "allowStale"];
const CONVERSATION_ONLY_KEYS = ["messageId"];
const CONVERSATION_DEFAULT_MAX_TOKENS = 6_000;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_MAX_TOKENS = 6_000;
const MAX_RESULT_TOKENS = 24_000;

function normalizePositiveInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalizePath(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (!path || path.length > 120) return undefined;
  if (!/^[a-zA-Z0-9_.-]+$/.test(path)) return undefined;
  return path;
}

function validateToolResultSource(
  record: Record<string, unknown>,
): AgentToolInputValidation<ContextReadInput> {
  const handle = typeof record.handle === "string" ? record.handle.trim() : "";
  if (!/^trh_[a-z0-9]+$/i.test(handle)) {
    return fail(
      "source:'tool_result' requires a valid trh_... handle from a compacted tool message or checkpoint",
    );
  }
  const path = normalizePath(record.path);
  if (record.path !== undefined && !path) {
    return fail(
      "path must be a simple top-level key such as results or snippets",
    );
  }
  return ok({
    source: "tool_result",
    handle,
    path,
    offset: normalizePositiveInt(record.offset, 0, Number.MAX_SAFE_INTEGER),
    textOffset: normalizePositiveInt(
      record.textOffset,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    limit: Math.max(
      1,
      normalizePositiveInt(record.limit, DEFAULT_LIMIT, MAX_LIMIT),
    ),
    maxTokens: Math.max(
      512,
      normalizePositiveInt(
        record.maxTokens,
        DEFAULT_MAX_TOKENS,
        MAX_RESULT_TOKENS,
      ),
    ),
    allowStale: record.allowStale === true,
  });
}

function validateConversationSource(
  record: Record<string, unknown>,
): AgentToolInputValidation<ContextReadInput> {
  for (const key of ["offset", "textOffset", "maxTokens"])
    if (
      record[key] !== undefined &&
      (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0)
    )
      return fail(`${key} must be a nonnegative integer`);
  if (
    record.messageId !== undefined &&
    (typeof record.messageId !== "string" || !record.messageId.trim())
  )
    return fail("messageId must be a nonempty string");
  return ok({
    source: "conversation",
    messageId: record.messageId as string | undefined,
    offset: Number(record.offset || 0),
    textOffset: Number(record.textOffset || 0),
    maxTokens: Math.max(
      512,
      Math.min(
        MAX_RESULT_TOKENS,
        Number(record.maxTokens || CONVERSATION_DEFAULT_MAX_TOKENS),
      ),
    ),
  });
}

function validateContextReadInput(
  args: unknown,
): AgentToolInputValidation<ContextReadInput> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return fail("context_read expects an object input");
  }
  const record = args as Record<string, unknown>;
  const source = record.source;
  if (source !== "tool_result" && source !== "conversation") {
    return fail(
      `source must be one of ${CONTEXT_SOURCES.map((entry) => `'${entry}'`).join(" or ")}`,
    );
  }
  const foreign = (
    source === "tool_result" ? CONVERSATION_ONLY_KEYS : TOOL_RESULT_ONLY_KEYS
  ).filter((key) => record[key] !== undefined);
  if (foreign.length) {
    return fail(
      `${foreign.join(", ")} ${foreign.length === 1 ? "does" : "do"} not apply to source:'${source}'`,
    );
  }
  return source === "tool_result"
    ? validateToolResultSource(record)
    : validateConversationSource(record);
}

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function availablePaths(content: unknown): string[] {
  const record = contentRecord(content);
  return Object.keys(record).filter((key) => record[key] !== undefined);
}

function summarizeRoot(content: unknown): Record<string, unknown> {
  const record = contentRecord(content);
  const summary: Record<string, unknown> = {
    availablePaths: availablePaths(content),
  };
  for (const key of [
    "totalCount",
    "returnedCount",
    "limited",
    "entity",
    "mode",
    "intent",
    "depth",
    "resourcePool",
    "coverage",
    "warnings",
  ]) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  for (const key of ["results", "paperMatches", "snippets", "papers"]) {
    if (Array.isArray(record[key])) {
      summary[`${key}Count`] = (record[key] as unknown[]).length;
    }
  }
  return summary;
}

function buildArraySlice(params: {
  base: Record<string, unknown>;
  items: unknown[];
  offset: number;
  textOffset: number;
  limit: number;
  maxTokens: number;
}): Record<string, unknown> {
  const offset = Math.min(params.offset, params.items.length);
  const next: Record<string, unknown> = {
    ...params.base,
    offset,
    requestedLimit: params.limit,
    totalCount: params.items.length,
    items: [],
  };
  for (
    let index = offset;
    index < params.items.length &&
    (next.items as unknown[]).length < params.limit;
    index += 1
  ) {
    (next.items as unknown[]).push(params.items[index]);
    if (estimateTextTokens(stableStringify(next)) > params.maxTokens) {
      (next.items as unknown[]).pop();
      break;
    }
  }
  const returnedCount = (next.items as unknown[]).length;
  if (!returnedCount && offset < params.items.length) {
    const itemChunk = {
      format: typeof params.items[offset] === "string" ? "text" : "json",
      ...readTextChunk(
        stableStringify(params.items[offset]),
        params.textOffset,
        Math.max(
          64,
          params.maxTokens - estimateTextTokens(stableStringify(next)) - 120,
        ),
      ),
    };
    const nextOffset =
      itemChunk.nextTextOffset === undefined ? offset + 1 : offset;
    return {
      ...next,
      returnedCount: 0,
      itemChunk,
      omittedCount: params.items.length - nextOffset,
      ...(nextOffset < params.items.length ? { nextOffset } : {}),
    };
  }
  const nextOffset = offset + returnedCount;
  next.returnedCount = returnedCount;
  next.omittedCount = Math.max(0, params.items.length - nextOffset);
  if (nextOffset < params.items.length) next.nextOffset = nextOffset;
  return next;
}

/**
 * The stored results that hold digests: the digest cache's records, and a
 * paper_digest or task_update result the trace kept whole.
 */
const DIGEST_RESULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  PAPER_DIGEST_HANDLE_TOOL,
  "task_update",
]);

function isDigestResultRead(result: unknown): boolean {
  const toolName = contentRecord(result).toolName;
  return typeof toolName === "string" && DIGEST_RESULT_TOOL_NAMES.has(toolName);
}

async function readToolResult(
  input: ToolResultSourceInput,
  context: AgentToolContext,
): Promise<unknown> {
  // The runtime marks the request once this conversation holds a stored
  // result. The tool stays listed for conversation reads, so an early handle
  // read answers here instead of the tool being hidden.
  if (context.request.metadata?.agentToolResultReadAvailable !== true) {
    return {
      ok: false,
      handle: input.handle,
      error:
        "No stored tool results are available in this conversation yet. source:'tool_result' reads a trh_... handle that a compacted tool message or checkpoint gave you.",
    };
  }
  const record = await getAgentToolResultHandle({
    conversationKey: context.request.conversationKey,
    handle: input.handle,
  });
  if (!record) {
    return {
      ok: false,
      handle: input.handle,
      error:
        "No stored tool result exists for this handle in the current conversation.",
    };
  }
  const warnings: string[] = [];
  const currentSignature = context.resourceSignature;
  const isStaleScope = Boolean(
    record.resourceSignature &&
    currentSignature &&
    record.resourceSignature !== currentSignature,
  );
  if (isStaleScope) {
    warnings.push(
      input.allowStale
        ? "The Zotero resource scope has changed since this result was stored; returning stale result content because allowStale is true."
        : "The Zotero resource scope has changed since this result was stored. Re-run the source tool for current-scope evidence.",
    );
  }
  const base: Record<string, unknown> = {
    ok: true,
    handle: record.handle,
    toolName: record.toolName,
    toolCallId: record.toolCallId,
    inputDigest: record.inputDigest,
    resourceSignature: record.resourceSignature,
    ...(isStaleScope
      ? { currentResourceSignature: currentSignature, stale: true }
      : {}),
    createdAt: record.createdAt,
    warnings,
  };
  if (isStaleScope && !input.allowStale) {
    return {
      ...base,
      ok: false,
      error:
        "Stored tool result belongs to a previous Zotero resource scope. Re-run the source tool for current-scope evidence, or set allowStale true only if stale result content is explicitly acceptable.",
    };
  }
  // A digest is paged as the model reads it when it returns: each Evidence
  // quote with its id, and no citation record. The records ride on the
  // result's top level, which the run's collector and the panel read and
  // the model does not (`modelContent`).
  const digestResult = DIGEST_RESULT_TOOL_NAMES.has(record.toolName);
  const content = digestResult
    ? withoutDigestQuoteCitations(record.content)
    : record.content;
  if (!input.path) {
    return {
      ...base,
      ...summarizeRoot(content),
    };
  }
  const root = contentRecord(content);
  if (!Object.prototype.hasOwnProperty.call(root, input.path)) {
    return {
      ...base,
      path: input.path,
      availablePaths: availablePaths(content),
      error: `Stored tool result has no top-level path '${input.path}'.`,
    };
  }
  const section = root[input.path];
  const read = Array.isArray(section)
    ? buildArraySlice({
        base: {
          ...base,
          path: input.path,
        },
        items: section,
        offset: input.offset,
        textOffset: input.textOffset,
        limit: input.limit,
        maxTokens: input.maxTokens,
      })
    : {
        ...base,
        path: input.path,
        ...(input.textOffset ||
        estimateTextTokens(stableStringify(section)) > input.maxTokens - 256
          ? {
              format: typeof section === "string" ? "text" : "json",
              ...readTextChunk(
                stableStringify(section),
                input.textOffset,
                input.maxTokens - 256,
              ),
            }
          : { value: section }),
      };
  // Added after the page is sized: the model never reads them.
  const quoteCitations = digestResult
    ? extractQuoteCitationsFromToolContent(record.content)
    : [];
  return quoteCitations.length ? { ...read, quoteCitations } : read;
}

async function readConversation(
  input: ConversationSourceInput,
  context: AgentToolContext,
): Promise<unknown> {
  const messages = (
    await readAgentConversationMessages(context.request.conversationKey)
  )
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        message.messageId,
    )
    .reverse();
  const contentText = (content: (typeof messages)[number]["content"]) =>
    typeof content === "string"
      ? content
      : content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n");
  if (input.messageId) {
    const message = messages.find(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        message.messageId === input.messageId,
    );
    if (!message)
      return {
        ok: false,
        error: "Message not found in this conversation.",
      };
    return {
      ok: true,
      messageId: input.messageId,
      role: message.role,
      ...readTextChunk(
        contentText(message.content),
        input.textOffset,
        input.maxTokens - 128,
      ),
    };
  }
  const selected = messages.slice(input.offset, input.offset + 5);
  const nextOffset = input.offset + selected.length;
  return {
    ok: true,
    totalCount: messages.length,
    messages: selected.map((message) => ({
      messageId: (message as { messageId?: string }).messageId,
      role: message.role,
      totalChars: contentText(message.content).length,
      preview: contentText(message.content).slice(0, 160),
    })),
    ...(nextOffset < messages.length ? { nextOffset } : {}),
  };
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * The skills' context_read steps. context_read reads in-plugin state an
 * external runtime does not share, so MCP hides it and the skill bodies do
 * not name it (#541); each item reaches the plugin's Agent with its skill.
 */
export const LITERATURE_REVIEW_DIGEST_HANDLE_GUIDANCE = skillGuidance(
  "literature-review",
  "Literature review digest results: when you need a paper's full record, read it with `context_read` `source:'tool_result'` and the handle its digest result carries.",
);

export const WRITE_NOTE_SOURCE_GUIDANCE = skillGuidance(
  "write-note",
  'To save an existing answer unchanged, use `context_read` with `source: "conversation"` only to recover the source identity or exact text; do not regenerate or reformat it.',
);

export const LIBRARY_ANALYSIS_PAGING_GUIDANCE = skillGuidance(
  "library-analysis",
  "Library results: `omitted` counts what a result left out, and `context_read` with its `toolResultHandle` pages the rest when the answer needs it.",
);

export function createContextReadTool(): AgentToolDefinition<
  ContextReadInput,
  unknown
> {
  return {
    spec: {
      name: "context_read",
      description:
        "Read exact stored context that the prompt carries only in part. source:'conversation' reads chat history: omit messageId to list messages (newest first, offset); provide messageId to read its text, following nextTextOffset with textOffset for long messages. To save an unchanged assistant answer, pass its messageId directly to note_write as sourceMessageId; no body transcription is needed. source:'tool_result' reads a stored tool result by handle: omit path for metadata; set path (e.g. results) for content. Follow nextOffset for rows. Oversized rows return itemChunk: keep offset and pass its nextTextOffset as textOffset until complete. Text sections also use nextTextOffset. Chunks concatenate exactly, including JSON source anchors.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: {
            type: "string",
            enum: [...CONTEXT_SOURCES],
            description:
              "conversation for chat messages; tool_result for a stored tool result handle.",
          },
          handle: {
            type: "string",
            description:
              "source:'tool_result' only. The trh_... handle from a semantic/context checkpoint or compacted tool message.",
          },
          messageId: {
            type: "string",
            description:
              "source:'conversation' only. Omit to list messages; set to read one message.",
          },
          path: {
            type: "string",
            description:
              "source:'tool_result' only. Optional top-level section to read, such as results, paperMatches, snippets, papers, coverage, resourcePool, or warnings. Omit to list available sections and metadata.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description:
              "Zero-based offset for array sections (tool_result) or the message list (conversation).",
          },
          textOffset: { type: "integer", minimum: 0 },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT,
            description:
              "source:'tool_result' only. Maximum rows to return for array sections.",
          },
          maxTokens: {
            type: "integer",
            minimum: 512,
            maximum: MAX_RESULT_TOKENS,
            description: "Approximate maximum tokens to return.",
          },
          allowStale: {
            type: "boolean",
            description:
              "source:'tool_result' only. Set true only when stale results are acceptable after the Zotero resource scope changed.",
          },
        },
        required: ["source"],
      },
      executionClass: "read",
      workCategory: "retrieval",
    },
    guidance: [
      LITERATURE_REVIEW_DIGEST_HANDLE_GUIDANCE,
      WRITE_NOTE_SOURCE_GUIDANCE,
      LIBRARY_ANALYSIS_PAGING_GUIDANCE,
    ],
    validate: validateContextReadInput,
    modelContent: (result) =>
      isDigestResultRead(result) ? withoutDigestQuoteCitations(result) : result,
    planInvocation: (input) =>
      readOnlyInvocationPlan({
        domains: [],
        effects: ["read"],
        reason:
          input.source === "tool_result"
            ? "Rehydrating a stored tool result reads turn-local host state only."
            : "Read stored content in this conversation.",
      }),
    execute: (input, context) =>
      input.source === "tool_result"
        ? readToolResult(input, context)
        : readConversation(input, context),
    presentation: {
      label: "Read Context",
      summaries: {
        onCall: ({ args }) => {
          const record = argsRecord(args);
          return record.source === "tool_result"
            ? `Reading compacted tool-result handle ${String(
                record.handle || "",
              )}`
            : record.messageId
              ? "Reading an earlier message"
              : "Listing conversation messages";
        },
        onSuccess: ({ args, content }) => {
          const record = argsRecord(content);
          if (argsRecord(args).source !== "tool_result") {
            return record.messageId
              ? "Read an earlier message"
              : "Listed conversation messages";
          }
          return typeof record.path === "string"
            ? `Read stored ${record.path} section`
            : "Read stored tool-result metadata";
        },
      },
    },
  };
}
