import type { AgentRunEventRecord } from "../../../agent/types";
import { sanitizeText } from "../../../utils/textSanitization";

type CodexToolActivityPayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "codex_tool_activity" }
>;

export const TOOL_ACTIVITY_VISIBLE_DEDUPE_WINDOW_MS = 8000;
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
  | "artifacts"
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

/**
 * Which server a relayed activity row came from.
 *
 * Both bridges stamp `serverName` on every activity event they emit, so the
 * answer is the event's own; a tool identifier that spells the server into
 * itself (`mcp__<server>__<tool>`) is the one other place the fact is
 * recorded, and reading it back out is parsing, not inference.
 */
function normalizeCodexServerNameForDedupe(
  serverName: string | undefined,
  toolName: string | undefined,
): string {
  const explicit = normalizeZoteroMcpServerAliasForDedupe(serverName || "");
  if (explicit) return explicit;
  const cleanToolName = sanitizeText(toolName || "").trim();
  const mcpMatch = cleanToolName.match(/^mcp__(.+)__(.+)$/);
  return mcpMatch?.[1]
    ? normalizeZoteroMcpServerAliasForDedupe(mcpMatch[1])
    : "";
}

/**
 * Whether a tool identifier names a tool on the plugin's own Zotero MCP
 * server (`mcp__llm_for_zotero__paper_read` and its per-profile spellings).
 *
 * A connected client's call to such a tool is reported twice: once by the
 * client as a bare call, and once by the Zotero server itself as a relayed
 * activity row that carries the tool's words, category and receipts. The
 * trace shows the server's row, so the client's bare call is the duplicate.
 */
export function isZoteroMcpServerToolName(toolName: string): boolean {
  return (
    /^mcp__.+__.+$/.test(sanitizeText(toolName || "").trim()) &&
    normalizeCodexServerNameForDedupe(undefined, toolName) === "llm_for_zotero"
  );
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
  if (!clean.startsWith("{") && !clean.startsWith("[")) return value;
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

/**
 * The receipts of both merged rows, never only the later row's.
 *
 * A merge is a presentation decision: two rows read as one activity. The
 * evidence is not presentation, so it accumulates instead of being replaced —
 * otherwise merging two effects would silently discard one effect's proof and
 * the surviving chip would speak for work it never covered. A receipt that
 * arrives twice (a started/completed pair for one call) is kept once, by id.
 */
function mergeToolActivityReceipts(
  previousPayload: CodexToolActivityPayload,
  nextPayload: CodexToolActivityPayload,
): CodexToolActivityPayload["actionReceipts"] {
  const merged = [
    ...(previousPayload.actionReceipts || []),
    ...(nextPayload.actionReceipts || []),
  ];
  if (!merged.length) return previousPayload.actionReceipts;
  const seen = new Set<string>();
  return merged.filter((receipt) => {
    const id = receipt?.id;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function mergeToolActivityPayload(
  previousPayload: CodexToolActivityPayload,
  nextPayload: CodexToolActivityPayload,
): CodexToolActivityPayload {
  return {
    ...previousPayload,
    ...nextPayload,
    actionReceipts: mergeToolActivityReceipts(previousPayload, nextPayload),
    toolName: nextPayload.toolName || previousPayload.toolName,
    toolLabel: nextPayload.toolLabel || previousPayload.toolLabel,
    serverName: nextPayload.serverName || previousPayload.serverName,
    args:
      nextPayload.args !== undefined ? nextPayload.args : previousPayload.args,
    codeBlock: nextPayload.codeBlock || previousPayload.codeBlock,
    artifacts:
      nextPayload.artifacts !== undefined
        ? nextPayload.artifacts
        : previousPayload.artifacts,
  };
}
