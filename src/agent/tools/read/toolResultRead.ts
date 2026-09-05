import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import {
  estimateTextTokens,
  sliceTextToTokenBudget,
} from "../../../utils/modelInputCap";
import { getAgentToolResultHandle } from "../../store/toolResultHandles";
import { fail, ok } from "../shared";

type ToolResultReadInput = {
  handle: string;
  path?: string;
  offset: number;
  limit: number;
  maxTokens: number;
  allowStale: boolean;
};

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

function validateToolResultReadInput(
  args: unknown,
): AgentToolInputValidation<ToolResultReadInput> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return fail("tool_result_read expects an object input");
  }
  const record = args as Record<string, unknown>;
  const handle = typeof record.handle === "string" ? record.handle.trim() : "";
  if (!/^trh_[a-z0-9]+$/i.test(handle)) {
    return fail("tool_result_read requires a valid handle");
  }
  const path = normalizePath(record.path);
  if (record.path !== undefined && !path) {
    return fail(
      "path must be a simple top-level key such as results or snippets",
    );
  }
  return ok({
    handle,
    path,
    offset: normalizePositiveInt(record.offset, 0, Number.MAX_SAFE_INTEGER),
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

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function truncateToTokenBudget(
  value: unknown,
  maxTokens: number,
): {
  value?: unknown;
  excerpt?: string;
  truncated?: boolean;
} {
  const text = stableStringify(value);
  if (estimateTextTokens(text) <= maxTokens) {
    return { value };
  }
  const excerptBody = sliceTextToTokenBudget(text, Math.max(64, maxTokens));
  return {
    excerpt: `${excerptBody.trimEnd()}\n\n[Section truncated to fit maxTokens.]`,
    truncated: true,
  };
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
  const nextOffset = offset + returnedCount;
  next.returnedCount = returnedCount;
  next.omittedCount = Math.max(0, params.items.length - nextOffset);
  if (nextOffset < params.items.length) next.nextOffset = nextOffset;
  return next;
}

async function executeToolResultRead(
  input: ToolResultReadInput,
  context: AgentToolContext,
): Promise<unknown> {
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
  if (!input.path) {
    return {
      ...base,
      ...summarizeRoot(record.content),
    };
  }
  const root = contentRecord(record.content);
  if (!Object.prototype.hasOwnProperty.call(root, input.path)) {
    return {
      ...base,
      path: input.path,
      availablePaths: availablePaths(record.content),
      error: `Stored tool result has no top-level path '${input.path}'.`,
    };
  }
  const section = root[input.path];
  if (Array.isArray(section)) {
    return buildArraySlice({
      base: {
        ...base,
        path: input.path,
      },
      items: section,
      offset: input.offset,
      limit: input.limit,
      maxTokens: input.maxTokens,
    });
  }
  return {
    ...base,
    path: input.path,
    ...truncateToTokenBudget(section, input.maxTokens),
  };
}

export function createToolResultReadTool(): AgentToolDefinition<
  ToolResultReadInput,
  unknown
> {
  return {
    spec: {
      name: "tool_result_read",
      description:
        "Read a bounded section from a prior Agent tool result preserved behind a handle. Use when a semantic/context checkpoint provides handle=trh_... or a compacted tool message provides toolResultHandle, and omitted rows or snippets are needed for the current answer.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          handle: {
            type: "string",
            description:
              "The trh_... handle from a semantic/context checkpoint or compacted tool message.",
          },
          path: {
            type: "string",
            description:
              "Optional top-level section to read, such as results, paperMatches, snippets, papers, coverage, resourcePool, or warnings. Omit to list available sections and metadata.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Zero-based offset for array sections.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT,
            description: "Maximum rows to return for array sections.",
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
              "Set true only when stale results are acceptable after the Zotero resource scope changed.",
          },
        },
        required: ["handle"],
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    isAvailable: (request) =>
      request.metadata?.agentToolResultReadAvailable === true,
    validate: validateToolResultReadInput,
    execute: executeToolResultRead,
    presentation: {
      label: "Read Stored Tool Result",
      summaries: {
        onCall: ({ args }) => {
          const record =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          return `Reading compacted tool-result handle ${String(
            record.handle || "",
          )}`;
        },
        onSuccess: ({ content }) => {
          const record =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          return typeof record.path === "string"
            ? `Read stored ${record.path} section`
            : "Read stored tool-result metadata";
        },
      },
    },
  };
}
