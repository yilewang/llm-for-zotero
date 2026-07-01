import type { AgentRunEventRecord } from "../../../agent/types";
import { sanitizeText } from "../textUtils";

type CodexToolActivityPayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "codex_tool_activity" }
>;

export const TOOL_ACTIVITY_VISIBLE_DEDUPE_WINDOW_MS = 8000;
const ZOTERO_MCP_TRACE_TOOL_NAMES = new Set([
  "query_library",
  "read_paper",
  "search_paper",
  "view_pdf_pages",
  "search_literature_online",
  "edit_current_note",
  "import_identifiers",
  "update_metadata",
  "library_search",
  "library_read",
  "library_retrieve",
  "paper_read",
  "literature_search",
  "library_update",
  "collection_update",
  "note_write",
  "library_import",
  "library_delete",
  "attachment_update",
  "undo_last_action",
]);
const ZOTERO_MCP_TRACE_SERVER_NAMES = new Set([
  "llm_for_zotero",
  "llm-for-zotero",
  "llm for zotero",
  "claude_zotero",
  "claude-zotero",
  "claude zotero",
]);

function normalizeCodexServerIdentityTextForDedupe(value: string): string {
  return sanitizeText(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeZoteroMcpServerAliasForDedupe(value: string): string {
  const normalized = normalizeCodexServerIdentityTextForDedupe(value);
  if (!normalized) return "";
  if (
    normalized === "llm_for_zotero" ||
    normalized === "claude_zotero" ||
    normalized.startsWith("llm_for_zotero_") ||
    normalized.startsWith("claude_zotero_")
  ) {
    return "llm_for_zotero";
  }
  return normalized;
}

export type CodexToolActivityDedupeInput = Pick<
  CodexToolActivityPayload,
  | "phase"
  | "itemId"
  | "serverName"
  | "toolName"
  | "toolLabel"
  | "args"
  | "text"
  | "codeBlock"
>;

function normalizeDedupeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDedupeValue(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((normalized, key) => {
        const entry = record[key];
        if (entry !== undefined) {
          normalized[key] = normalizeDedupeValue(entry);
        }
        return normalized;
      }, {});
  }
  return value;
}

function stableDedupeJson(value: unknown): string {
  return JSON.stringify(normalizeDedupeValue(value));
}

function normalizeCodexToolNameForDedupe(name: string | undefined): string {
  const clean = sanitizeText(name || "").trim();
  const mcpMatch = clean.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  return mcpMatch?.[1] || clean;
}

function normalizeCodexServerNameForDedupe(
  serverName: string | undefined,
  toolName: string | undefined,
): string {
  const explicit = normalizeZoteroMcpServerAliasForDedupe(serverName || "");
  if (explicit) return explicit;
  const cleanToolName = sanitizeText(toolName || "").trim();
  const mcpMatch = cleanToolName.match(/^mcp__(.+)__(.+)$/);
  if (mcpMatch?.[1]) {
    const serverAlias = normalizeZoteroMcpServerAliasForDedupe(mcpMatch[1]);
    if (ZOTERO_MCP_TRACE_SERVER_NAMES.has(mcpMatch[1].toLowerCase())) {
      return "llm_for_zotero";
    }
    return serverAlias;
  }
  const normalizedToolName = normalizeCodexToolNameForDedupe(cleanToolName);
  return ZOTERO_MCP_TRACE_TOOL_NAMES.has(normalizedToolName)
    ? "llm_for_zotero"
    : "";
}

function normalizeCodexToolIdentityTextForDedupe(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function normalizeCodexToolIdentityForDedupe(
  toolName: string | undefined,
  toolLabel: string | undefined,
): string {
  const canonicalName = normalizeCodexToolNameForDedupe(toolName);
  if (canonicalName) {
    return normalizeCodexToolIdentityTextForDedupe(canonicalName);
  }
  return normalizeCodexToolIdentityTextForDedupe(
    sanitizeText(toolLabel || "").trim(),
  );
}

function normalizeCodexToolActivityArgsForDedupe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const clean = sanitizeText(value).trim();
  if (!/^[{\[]/.test(clean)) return value;
  try {
    return JSON.parse(clean);
  } catch {
    return value;
  }
}

export function getToolActivityVisibleDedupeKey(
  payload: CodexToolActivityDedupeInput,
): string {
  const explicitText = sanitizeText(payload.text || "").trim();
  const toolIdentity = normalizeCodexToolIdentityForDedupe(
    payload.toolName,
    payload.toolLabel,
  );
  return stableDedupeJson({
    phase: payload.phase,
    serverIdentity: normalizeCodexServerNameForDedupe(
      payload.serverName,
      payload.toolName,
    ),
    toolIdentity,
    itemId: toolIdentity ? "" : sanitizeText(String(payload.itemId || "")),
    args: normalizeCodexToolActivityArgsForDedupe(payload.args),
    text: explicitText,
    codeBlock: payload.codeBlock || "",
  });
}

export function hasSameToolActivityVisibleIdentity(
  left: CodexToolActivityDedupeInput,
  right: CodexToolActivityDedupeInput,
): boolean {
  return (
    getToolActivityVisibleDedupeKey(left) ===
    getToolActivityVisibleDedupeKey(right)
  );
}

export function isWithinToolActivityDedupeWindow(
  createdAt: number,
  previousCreatedAt: number,
): boolean {
  return (
    Math.abs(createdAt - previousCreatedAt) <=
    TOOL_ACTIVITY_VISIBLE_DEDUPE_WINDOW_MS
  );
}

export function mergeToolActivityPayload(
  previousPayload: CodexToolActivityPayload,
  nextPayload: CodexToolActivityPayload,
): CodexToolActivityPayload {
  return {
    ...previousPayload,
    ...nextPayload,
    toolName: nextPayload.toolName || previousPayload.toolName,
    toolLabel: nextPayload.toolLabel || previousPayload.toolLabel,
    serverName: nextPayload.serverName || previousPayload.serverName,
    args:
      nextPayload.args !== undefined ? nextPayload.args : previousPayload.args,
    codeBlock: nextPayload.codeBlock || previousPayload.codeBlock,
  };
}
